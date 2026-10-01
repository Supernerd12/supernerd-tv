// portal-items — review deliverables managed from inside /r/studio/ (replaces Sveltia
// for reviewItems). Files go straight from the browser to Cloudflare R2 (presigned PUT)
// or Cloudflare Stream (direct upload); rows live in public.review_items.
//
// Who can do what (enforced HERE with the service role, not in the browser):
//   owner (hello@/shaun@)                 -> everything on every project
//   team member (invites.role = 'team')   -> upload to projects in their invite,
//                                            edit/move/delete ONLY rows they uploaded
//   clients                               -> nothing here (they read via RLS)
//
// Secrets: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (bucket supernerd-portal, Object R/W),
//          CF_ACCOUNT_ID, CF_STREAM_TOKEN (Stream:Edit). SUPABASE_* are automatic.
// Deploy:  supabase functions deploy portal-items --project-ref wvtokocjhtpjrkojxaia --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AwsClient } from 'https://esm.sh/aws4fetch@1.0.20';

const SLUG = 'studio';
const OWNER_EMAILS = ['hello@supernerd.tv', 'shaun@supernerd.tv'];
const BUCKET = 'supernerd-portal';
const PUBLIC_BASE = 'https://files.supernerd.tv';
const ALLOWED_ORIGINS = ['https://supernerd.tv', 'https://www.supernerd.tv', 'http://localhost:4321'];
const MAX_FILE = 5 * 1024 * 1024 * 1024;      // R2 single PUT limit
const MAX_STREAM_BASIC = 200 * 1024 * 1024;   // Stream basic direct-upload limit
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const ACCT = Deno.env.get('CF_ACCOUNT_ID')!;
const r2 = new AwsClient({
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID') || '',
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY') || '',
  service: 's3', region: 'auto',
});
const R2_BASE = `https://${ACCT}.r2.cloudflarestorage.com/${BUCKET}`;
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
const safeName = (s: string) => s.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-120) || 'file';
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14); // yyyymmddhhmmss, like Sveltia ids

function cors(origin: string | null) {
  const o = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Vary': 'Origin' };
}

type Who = { email: string; name: string; owner: boolean; projects: Set<string> };

async function whoAmI(req: Request): Promise<Who> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Sign in first.');
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, 'Session expired — sign in again.');
  const email = (data.user.email || '').toLowerCase();
  const owner = OWNER_EMAILS.includes(email);
  let name = '';
  if (owner) {
    const { data: rs } = await admin.from('review_settings').select('owner_name').eq('review_slug', SLUG).maybeSingle();
    name = rs?.owner_name || 'Supernerd';
  } else {
    const { data: pr } = await admin.from('profiles').select('full_name').eq('id', data.user.id).maybeSingle();
    name = pr?.full_name || '';
  }
  const projects = new Set<string>();
  if (!owner) {
    const { data: inv } = await admin.from('invites').select('project_keys, role, name').eq('review_slug', SLUG).ilike('email', email).maybeSingle();
    if (!inv || inv.role !== 'team') throw new HttpError(403, 'Only the studio team can upload.');
    (inv.project_keys || []).forEach((k: string) => projects.add(k));
    if (!name) name = inv.name || email.split('@')[0];
  }
  return { email, name, owner, projects };
}

function canProject(w: Who, project: string) {
  if (!w.owner && !w.projects.has(project)) throw new HttpError(403, "You don't have upload access to this project.");
}
async function ownRow(w: Who, id: string) {
  const { data: row } = await admin.from('review_items').select('*').eq('id', id).maybeSingle();
  if (!row) throw new HttpError(404, 'That item no longer exists.');
  canProject(w, row.project_key);
  if (!w.owner && (row.uploader_email || '').toLowerCase() !== w.email) throw new HttpError(403, 'You can only change items you uploaded.');
  return row;
}

async function presignPut(key: string, type: string) {
  const url = new URL(`${R2_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('X-Amz-Expires', '3600');
  const signed = await r2.sign(new Request(url, { method: 'PUT', headers: { 'content-type': type } }), { aws: { signQuery: true } });
  return signed.url;
}

async function streamDirectUpload(name: string) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/stream/direct_upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('CF_STREAM_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxDurationSeconds: 3600, meta: { name } }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d?.result?.uploadURL) throw new HttpError(502, 'Cloudflare Stream would not accept the upload: ' + (d?.errors?.[0]?.message || res.status));
  return { uploadURL: d.result.uploadURL as string, uid: d.result.uid as string };
}

async function r2Delete(key: string) {
  if (!key) return;
  try { await r2.fetch(`${R2_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); } catch (_) { /* best effort */ }
}
async function streamDelete(uid: string) {
  if (!uid) return;
  try { await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/stream/${uid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${Deno.env.get('CF_STREAM_TOKEN')}` } }); } catch (_) { /* best effort */ }
}

// Comments/approvals are keyed "project:section:itemId" — carry them along on a move.
async function moveFeedback(project: string, oldSec: string, newSec: string, id: string) {
  const from = `${project}:${oldSec}:${id}`, to = `${project}:${newSec}:${id}`;
  for (const t of ['comments', 'approvals']) {
    const { error } = await admin.from(t).update({ asset_id: to }).eq('review_slug', SLUG).eq('asset_id', from);
    if (error) console.error('moveFeedback', t, error.message);
  }
}

const KINDS = new Set(['image', 'video', 'audio', 'file']);
function kindFor(type: string, name: string) {
  const n = name.toLowerCase();
  if (type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/.test(n)) return 'video';
  if (type.startsWith('image/') && !/\.(psd|ai|tiff?|heic)$/.test(n)) return 'image';
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(n)) return 'audio';
  return 'file';
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get('Origin'));
  const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  try {
    const w = await whoAmI(req);
    const body = await req.json().catch(() => { throw new HttpError(400, 'Bad JSON'); });
    const action = str(body.action, 20);

    // 1) sign: get upload targets for files the browser is about to send
    if (action === 'sign') {
      const project = str(body.project, 40);
      if (!KEY_RE.test(project)) throw new HttpError(400, 'Bad project.');
      canProject(w, project);
      const files = Array.isArray(body.files) ? body.files.slice(0, 50) : [];
      const out = [];
      for (const f of files) {
        const name = str(f.name, 200), type = str(f.type, 100) || 'application/octet-stream', size = Number(f.size) || 0;
        const kind = kindFor(type, name);
        if (kind === 'video') {
          if (size > MAX_STREAM_BASIC) throw new HttpError(413, `"${name}" is over 200 MB. Export a smaller review copy for now.`);
          const s = await streamDirectUpload(name);
          out.push({ name, kind, stream_uid: s.uid, uploadURL: s.uploadURL, method: 'POST-FORM' });
        } else {
          if (size > MAX_FILE) throw new HttpError(413, `"${name}" is over 5 GB.`);
          const key = `${SLUG}/${project}/${stamp()}-${crypto.randomUUID().slice(0, 8)}/${safeName(name)}`;
          out.push({ name, kind, r2_key: key, uploadURL: await presignPut(key, type), method: 'PUT', publicURL: `${PUBLIC_BASE}/${key}` });
        }
      }
      return reply({ ok: true, targets: out });
    }

    // 2) create: record an uploaded file as a deliverable
    if (action === 'create') {
      const it = body.item || {};
      const project = str(it.project, 40), section = str(it.section, 80) || 'Other', title = str(it.title, 160);
      if (!KEY_RE.test(project)) throw new HttpError(400, 'Bad project.');
      canProject(w, project);
      if (!title) throw new HttpError(400, 'Give it a name.');
      const r2Key = str(it.r2_key, 400), uid = str(it.stream_uid, 64);
      if (!r2Key && !uid) throw new HttpError(400, 'Missing upload.');
      if (r2Key && !r2Key.startsWith(`${SLUG}/${project}/`)) throw new HttpError(400, 'Upload does not belong to this project.');
      const kind = KINDS.has(it.kind) ? it.kind : 'file';
      const row = {
        id: `${slugify(section)}-${stamp()}${Math.floor(Math.random() * 90 + 10)}`,
        review_slug: SLUG, project_key: project, section, title, version: str(it.version, 20), kind,
        stream_uid: uid || null, r2_key: r2Key || null, src_url: r2Key ? `${PUBLIC_BASE}/${r2Key}` : null,
        download_url: str(it.download_url, 500) || null, file_name: str(it.file_name, 200) || null,
        file_size: Number(it.file_size) || null, mime: str(it.mime, 100) || null,
        item_order: Number.isFinite(Number(it.order)) ? Math.round(Number(it.order)) : 100,
        uploader_email: w.email, uploader_name: w.name,
      };
      const { data, error } = await admin.from('review_items').insert(row).select().single();
      if (error) throw new HttpError(500, error.message);
      return reply({ ok: true, item: data });
    }

    // 3) update: rename / re-version / move to another folder / archive
    if (action === 'update') {
      const row = await ownRow(w, str(body.id, 80));
      const p = body.patch || {}, patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (p.title !== undefined) { const t = str(p.title, 160); if (!t) throw new HttpError(400, 'Name can’t be empty.'); patch.title = t; }
      if (p.version !== undefined) patch.version = str(p.version, 20);
      if (p.download_url !== undefined) patch.download_url = str(p.download_url, 500) || null;
      if (p.archived !== undefined) patch.archived = !!p.archived;
      if (p.order !== undefined && Number.isFinite(Number(p.order))) patch.item_order = Math.round(Number(p.order));
      if (p.section !== undefined) {
        const s = str(p.section, 80) || 'Other';
        if (s !== row.section) { patch.section = s; await moveFeedback(row.project_key, row.section, s, row.id); }
      }
      const { data, error } = await admin.from('review_items').update(patch).eq('id', row.id).select().single();
      if (error) throw new HttpError(500, error.message);
      return reply({ ok: true, item: data });
    }

    // 4) delete: remove the row and its file
    if (action === 'delete') {
      const row = await ownRow(w, str(body.id, 80));
      const { error } = await admin.from('review_items').delete().eq('id', row.id);
      if (error) throw new HttpError(500, error.message);
      if (!row.legacy) { await r2Delete(row.r2_key); await streamDelete(row.stream_uid); }
      return reply({ ok: true });
    }

    throw new HttpError(400, 'Unknown action.');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return reply({ error: e instanceof Error ? e.message : 'Unexpected error' }, status);
  }
});
