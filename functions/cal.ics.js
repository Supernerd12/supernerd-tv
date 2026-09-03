// Calendar subscription feed. Calendar clients can't send bearer headers, so the token
// rides in the query string: https://supernerd.tv/cal.ics?k=YOUR_FIT_TOKEN
// Subscribe once in Apple Calendar; it re-fetches on its own and the alarms fire as alerts.

import { icsFeed } from './_lib.js';

export async function onRequestGet({ request, env }) {
  const k = new URL(request.url).searchParams.get('k');
  if (!env.FIT_TOKEN || k !== env.FIT_TOKEN) return new Response('unauthorized', { status: 401 });
  if (!env.FIT_DB) return new Response('no database', { status: 500 });

  return new Response(await icsFeed(env), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="fitness.ics"',
      'cache-control': 'no-cache'
    }
  });
}
