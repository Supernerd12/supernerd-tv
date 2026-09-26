// Link-preview image for /reel/ (1200x630 JPEG) built from the reel poster.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export async function GET() {
  const src = await readFile(new URL('../../../public/work/reel-poster.webp', import.meta.url));
  const jpg = await sharp(src)
    .resize(1200, 630, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return new Response(jpg, { headers: { 'Content-Type': 'image/jpeg' } });
}
