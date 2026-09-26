// Link-preview image per project: /og/<slug>.jpg (1200x630 JPEG), built from the project hero.
// Heroes are WebP, which LinkedIn and some other scrapers won't render, and some filenames
// have spaces. This gives every project a clean, universally supported preview image.
import { getCollection } from 'astro:content';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { workSlug } from '../../components/workSlug.js';

export async function getStaticPaths() {
  const entries = (await getCollection('work')).filter((e) => e.data.published !== false);
  return entries.map((e) => {
    const id = e.id.replace(/\.[^.]+$/, '');
    const pieces = (e.data.pieces || []).filter((pc) => pc.published !== false);
    const hero = e.data.hero || (pieces[0] && pieces[0].hero) || '';
    return { params: { slug: workSlug(id) }, props: { hero } };
  });
}

export async function GET({ props }) {
  let src;
  try {
    if (!props.hero || /^https?:/.test(props.hero)) throw new Error('no local hero');
    src = await readFile(new URL('../../../public/' + props.hero.replace(/^\/+/, ''), import.meta.url));
  } catch {
    src = await readFile(new URL('../../../public/og.jpg', import.meta.url));
  }
  const jpg = await sharp(src)
    .resize(1200, 630, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#000000' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return new Response(jpg, { headers: { 'Content-Type': 'image/jpeg' } });
}
