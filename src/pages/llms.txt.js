// llms.txt — plain-language summary for AI answer engines, rebuilt from the CMS on every deploy.
import { getCollection } from 'astro:content';
import { workSlug } from '../components/workSlug.js';

export async function GET() {
  const site = 'https://supernerd.tv';
  const work = (await getCollection('work'))
    .filter((e) => e.data.published !== false)
    .sort((a, b) => (a.data.order - b.data.order) || a.data.title.localeCompare(b.data.title));
  const lines = [
    '# Supernerd',
    '',
    '> Supernerd is the New York design and production studio of art director and creative producer Shaun Harrison. For 16+ years it has created stage design, motion graphics, live experiences, tours and brand activations for entertainment icons and global brands.',
    '',
    "Supernerd works where art, culture, events and technology meet — the unseen architecture behind cultural moments. Shaun Harrison has art-directed and produced five consecutive Hollywood Unlocked Impact Awards, the World's Strongest Man competition, the Apollo Theater's Young Patrons Sessions, and McDonald's activation at Art Basel. He was an early mover in AR and has been featured in documentaries for his work in artificial intelligence.",
    '',
    '## Services',
    '',
    '- Art Direction: stage, set and visual systems',
    '- Creative Production: concept to call-sheet, show flow, vendors and the build',
    '- Live Experiences: tours, awards shows and events engineered end to end',
    '- Motion & Design: broadcast motion graphics, screens and identity',
    '- Brand Activations: culture-first activations',
    '- Emerging Tech: AR and AI',
    '',
    '## Selected work',
    '',
    ...work.map((e) => {
      const tags = (e.data.categories || []).filter((t) => t !== 'Art Direction');
      return `- [${e.data.title}](${site}/work/${workSlug(e.id.replace(/\.[^.]+$/, ''))}/)${tags.length ? ': ' + tags.join(', ') : ''}`;
    }),
    '',
    '## Contact',
    '',
    `- Site: ${site}/`,
    '- Email: shaun@supernerd.tv',
    '- Location: New York, NY',
    '- Instagram: https://www.instagram.com/supernerd_',
    '- LinkedIn: https://www.linkedin.com/in/shaunharrison/',
    '- X: https://x.com/shaun_harrison',
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
