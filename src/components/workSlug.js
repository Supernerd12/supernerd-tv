// Project id (CMS filename) -> URL slug for /work/<slug>/. Keep stable: shared links depend on it.
// FIXED maps ids whose filenames carry old typos to clean URLs.
const FIXED = { 'carol-s-daugher': 'carols-daughter', 'neilsen': 'nielsen' };
export const workSlug = (id) =>
  FIXED[id] || String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
