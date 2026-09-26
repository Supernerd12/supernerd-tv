// Generated at build: homepage + every published /work/<slug>/ page.
import { getCollection } from 'astro:content';
import { workSlug } from '../components/workSlug.js';

export async function GET() {
  const site = 'https://supernerd.tv';
  const today = new Date().toISOString().slice(0, 10);
  const work = (await getCollection('work')).filter((e) => e.data.published !== false);
  const urls = [site + '/', ...work.map((e) => `${site}/work/${workSlug(e.id.replace(/\.[^.]+$/, ''))}/`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n')}
</urlset>
`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
