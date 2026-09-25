// portal-onboard — lets the portal owner add a company and/or project from
// /r/studio/ without opening Sveltia. Writes the same JSON files the CMS would
// (src/content/reviews/, src/content/reviewProjects/) plus an optional logo in
// public/work/uploads/, as ONE commit to main. Cloudflare Pages then rebuilds.
//
// Secrets (supabase secrets set ...):
//   GITHUB_TOKEN  fine-grained PAT, repo Supernerd12/supernerd-tv only, Contents: read & write
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy: supabase functions deploy portal-onboard --project-ref wvtokocjhtpjrkojxaia

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const REPO = 'Supernerd12/supernerd-tv';
const BRANCH = 'main';
const OWNER_EMAILS = ['hello@supernerd.tv', 'shaun@supernerd.tv'];
const ALLOWED_ORIGINS = ['https://supernerd.tv', 'https://www.supernerd.tv', 'http://localhost:4321'];
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['studio', 'admin', 'r', 'fit', 'api', 'mcp']);
const LOGO_TYPES: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', svg: 'svg' };
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

function cors(origin: string | null) {
  const o = origin && (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.supernerd-tv.pages.dev')) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

async function gh(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${Deno.env.get('GITHUB_TOKEN')}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'supernerd-portal-onboard',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new HttpError(502, `GitHub ${init.method || 'GET'} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

async function exists(path: string) {
  const res = await gh(`/contents/${encodeURI(path)}?ref=${BRANCH}`);
  return res.status !== 404;
}

async function commitFiles(files: { path: string; content: string; base64?: boolean }[], message: string) {
  const blobs = await Promise.all(files.map(async (f) => {
    const r = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.content, encoding: f.base64 ? 'base64' : 'utf-8' }) });
    return { path: f.path, mode: '100644', type: 'blob', sha: (await r.json()).sha };
  }));
  // Retry once if main moved underneath us (e.g. Sveltia committed at the same moment).
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await (await gh(`/git/ref/heads/${BRANCH}`)).json();
    const parent = ref.object.sha;
    const baseTree = (await (await gh(`/git/commits/${parent}`)).json()).tree.sha;
    const tree = await (await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree: blobs }) })).json();
    const commit = await (await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) })).json();
    const upd = await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${Deno.env.get('GITHUB_TOKEN')}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'supernerd-portal-onboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    if (upd.ok) return commit.sha as string;
    if (upd.status !== 422 || attempt === 1) throw new HttpError(502, `GitHub ref update failed (${upd.status})`);
  }
  throw new HttpError(502, 'GitHub commit failed');
}

async function requireOwner(req: Request) {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Sign in first.');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, 'Session expired — sign in again.');
  const email = (data.user.email || '').toLowerCase();
  if (OWNER_EMAILS.includes(email)) return email;
  const { data: prof } = await admin.from('profiles').select('owner').eq('id', data.user.id).maybeSingle();
  if (prof?.owner) return email;
  throw new HttpError(403, 'Only the studio owner can add companies.');
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('Origin'));
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  try {
    if (!Deno.env.get('GITHUB_TOKEN')) throw new HttpError(500, 'GITHUB_TOKEN secret is not set on this function.');
    const who = await requireOwner(req);
    const body = await req.json().catch(() => { throw new HttpError(400, 'Bad JSON'); });

    const files: { path: string; content: string; base64?: boolean }[] = [];
    let companyKey = str(body.project?.company_key, 40);
    let companyName = '';

    // ---- company (optional: omitted when adding a project to an existing company)
    if (body.company) {
      companyKey = str(body.company.key, 40);
      companyName = str(body.company.name, 120);
      if (!companyName) throw new HttpError(400, 'Company name is required.');
      if (!KEY_RE.test(companyKey) || RESERVED.has(companyKey)) throw new HttpError(400, `"${companyKey}" can't be used as a company id.`);
      const cPath = `src/content/reviews/${companyKey}.json`;
      if (await exists(cPath)) throw new HttpError(409, `A company with id "${companyKey}" already exists.`);

      let logo = '';
      if (body.logo?.base64) {
        const ext = LOGO_TYPES[String(body.logo.ext || '').toLowerCase()];
        if (!ext) throw new HttpError(400, 'Logo must be PNG, JPG, WEBP or SVG.');
        const b64 = String(body.logo.base64).replace(/^data:[^,]*,/, '');
        if (b64.length * 0.75 > MAX_LOGO_BYTES) throw new HttpError(413, 'Logo is over 4 MB.');
        const name = `${companyKey}-logo-${Date.now().toString(36)}.${ext}`;
        files.push({ path: `public/work/uploads/${name}`, content: b64, base64: true });
        logo = `/work/uploads/${name}`;
      }
      files.push({
        path: cPath,
        content: JSON.stringify({ name: companyName, key: companyKey, url_slug: companyKey, logo, published: true }, null, 2) + '\n',
      });
    } else {
      if (!KEY_RE.test(companyKey)) throw new HttpError(400, 'Missing company.');
      if (!(await exists(`src/content/reviews/${companyKey}.json`))) throw new HttpError(404, `Company "${companyKey}" not found.`);
    }

    // ---- project
    const p = body.project || {};
    const pKey = str(p.key, 40);
    const title = str(p.title, 120);
    if (!title) throw new HttpError(400, 'Project title is required.');
    if (!KEY_RE.test(pKey) || RESERVED.has(pKey)) throw new HttpError(400, `"${pKey}" can't be used as a project id.`);
    const pPath = `src/content/reviewProjects/${pKey}.json`;
    if (await exists(pPath)) throw new HttpError(409, `A project with id "${pKey}" already exists.`);
    const order = Number.isFinite(Number(p.order)) ? Math.round(Number(p.order)) : 100;
    files.push({
      path: pPath,
      content: JSON.stringify({ company_key: companyKey, title, key: pKey, tagline: str(p.tagline, 160), order, published: true }, null, 2) + '\n',
    });

    const msg = body.company
      ? `Portal: onboard company "${companyName}" + project "${title}"`
      : `Portal: add project "${title}" to ${companyKey}`;
    const sha = await commitFiles(files, `${msg}\n\nCreated from /r/studio/ by ${who}`);
    return reply({ ok: true, commit: sha, company_key: companyKey, project_key: pKey, files: files.map((f) => f.path) });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return reply({ error: e instanceof Error ? e.message : 'Unexpected error' }, status);
  }
});
