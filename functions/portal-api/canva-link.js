// Client portal (not the fitness app): turn a Canva short link (canva.link/xyz)
// into the full canva.com/design/... link so the deck can be embedded.
// Only canva.link is resolved, and only a canva.com/design URL is ever returned.
export async function onRequestGet({ request }) {
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  let src;
  try { src = new URL(new URL(request.url).searchParams.get('u') || ''); } catch (e) { return out({ error: 'bad url' }, 400); }
  if (src.protocol !== 'https:' || src.hostname.replace(/^www\./, '') !== 'canva.link') return out({ error: 'only canva.link links' }, 400);
  try {
    const r = await fetch(src.toString(), { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    const m = loc.match(/^https:\/\/www\.canva\.com\/design\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(view|edit|watch)/);
    if (!m) return out({ error: 'not a Canva design link' }, 404);
    return out({ url: 'https://www.canva.com/design/' + m[1] + '/' + m[2] + '/view' });
  } catch (e) { return out({ error: 'could not reach Canva' }, 502); }
}
