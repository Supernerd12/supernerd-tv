import {
  VERSION, dayStr, nowStr, json, txt, authed, newCookie,
  all, one, run, profile, currentTarget, trends, today, decide,
  suggestMeal, parseFood, parseWorkout, contextDoc, checkin,
  dayRange, grocery, icsFeed, coachBrief, exerciseStats, trainingOverview, ensureExercise, matchExercise
} from '../_lib.js';

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = (ctx.params.path || []).join('/');
  const method = request.method;

  if (method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS'
      }
    });

  if (!env.FIT_DB) return json({ error: 'D1 binding FIT_DB is missing. Add it in Cloudflare > Pages > Settings > Bindings.' }, 500);

  // --- public ---
  if (path === 'openapi.json') return json(openapi(url.origin));

  if (path === 'login' && method === 'POST') {
    const { pass } = await request.json().catch(() => ({}));
    if (!env.FIT_PASS || pass !== env.FIT_PASS) {
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing
      return json({ ok: false }, 401);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        'content-type': 'application/json',
        'set-cookie': `fitsess=${await newCookie(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=10368000`
      }
    });
  }

  // --- everything below needs auth ---
  if (!(await authed(request, env))) return json({ error: 'unauthorized' }, 401);

  const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
  const d = body.date || url.searchParams.get('date') || dayStr();

  // /api/img/2026-09-02 -> the stored JPEG
  if (method === 'GET' && path.startsWith('img/')) {
    if (!env.FIT_R2) return json({ error: 'R2 binding FIT_R2 is missing.' }, 500);
    const obj = await env.FIT_R2.get(`progress/${path.slice(4)}.jpg`);
    if (!obj) return new Response('not found', { status: 404 });
    return new Response(obj.body, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000' }
    });
  }

  try {
    switch (`${method} ${path}`) {
      case 'GET status': {
        const [td, tr, p] = await Promise.all([today(env, d), trends(env), profile(env)]);
        return json({ version: VERSION, today: td, trends: tr, profile: p });
      }

      case 'GET context':
        return txt(await contextDoc(env));

      case 'GET brief':
        return json(await coachBrief(env));

      case 'POST food': {
        const items = await parseFood(env, String(body.text || ''));
        for (const i of items)
          await run(env,
            'INSERT INTO food_log (d,ts,item,kcal,protein,carbs,fat,fiber,src) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
            [d, nowStr(), i.item, i.kcal, i.protein, i.carbs, i.fat, i.fiber, i.src]);
        return json({ logged: items, today: await today(env, d) });
      }

      case 'POST workout': {
        const items = await parseWorkout(env, String(body.text || ''));
        for (const i of items) await insertSet(env, d, i, body.note);
        return json({ logged: items, today: await today(env, d) });
      }

      /* ---- structured logging from the rep counter and the muscle screens ---- */

      case 'POST set': {
        if (!body.exercise) return json({ error: 'need an exercise' }, 400);
        const ex = await ensureExercise(env, body.exercise, {
          discipline: body.discipline, muscle: body.muscle, unit: body.unit
        });
        const i = {
          exercise: ex.name, exercise_id: ex.id, discipline: ex.discipline, muscle: ex.muscle,
          sets: body.sets ?? 1, reps: body.reps ?? null, weight: body.weight ?? null,
          minutes: body.minutes ?? null, distance: body.distance ?? null, rpe: body.rpe ?? null
        };
        await insertSet(env, d, i, body.note);
        return json({ ok: true, logged: [i], today: await today(env, d) });
      }

      case 'GET exercises': {
        const disc = url.searchParams.get('discipline');
        const muscle = url.searchParams.get('muscle');
        const where = ['archived=0'], bind = [];
        if (disc) { where.push(`discipline=?${bind.length + 1}`); bind.push(disc); }
        if (muscle) { where.push(`muscle=?${bind.length + 1}`); bind.push(muscle); }
        const list = await all(env,
          `SELECT e.*, (SELECT MAX(d) FROM workout_log w WHERE w.exercise_id=e.id) last,
                  (SELECT COUNT(DISTINCT d) FROM workout_log w WHERE w.exercise_id=e.id) days
             FROM exercises e WHERE ${where.join(' AND ')} ORDER BY last DESC NULLS LAST, name`, bind);
        return json(list);
      }

      case 'GET training':
        return json(await trainingOverview(env, url.searchParams.get('range') || 'month'));

      case 'GET exercise': {
        const id = Number(url.searchParams.get('id'));
        const st = await exerciseStats(env, id, url.searchParams.get('range') || 'month');
        return st ? json(st) : json({ error: 'unknown exercise' }, 404);
      }

      case 'POST exercise': {
        const ex = await ensureExercise(env, body.name, body);
        return json({ ok: true, exercise: ex });
      }

      case 'POST weight': {
        if (body.lb == null && body.waist == null) return json({ error: 'need lb or waist' }, 400);
        await run(env,
          `INSERT INTO weights (d,lb,waist,bodyfat,muscle,visceral,note) VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(d) DO UPDATE SET
             lb=COALESCE(excluded.lb,lb), waist=COALESCE(excluded.waist,waist),
             bodyfat=COALESCE(excluded.bodyfat,bodyfat), muscle=COALESCE(excluded.muscle,muscle),
             visceral=COALESCE(excluded.visceral,visceral), note=COALESCE(excluded.note,note)`,
          [d, body.lb ?? null, body.waist ?? null, body.bodyfat ?? null, body.muscle ?? null, body.visceral ?? null, body.note ?? null]);
        return json({ ok: true, trends: await trends(env) });
      }

      case 'POST flags': {
        await run(env,
          'INSERT OR REPLACE INTO flags (d,hunger,fatigue,soreness,note) VALUES (?1,?2,?3,?4,?5)',
          [d, body.hunger ? 1 : 0, body.fatigue ? 1 : 0, body.soreness ? 1 : 0, body.note || null]);
        return json({ ok: true });
      }

      case 'GET suggest':
        return json(await suggestMeal(env));

      case 'GET checkin':
      case 'POST checkin':
        return json(await checkin(env));

      case 'GET inventory':
        return json(await all(env, 'SELECT id,name,kcal,protein,fiber,serving,kind,in_stock FROM foods ORDER BY kind,name'));

      case 'POST inventory': {
        if (body.id != null)
          await run(env, 'UPDATE foods SET in_stock=?1 WHERE id=?2', [body.in_stock ? 1 : 0, body.id]);
        else if (body.name)
          await run(env,
            `INSERT INTO foods (name,kcal,protein,carbs,fat,fiber,serving,kind,in_stock)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1)
             ON CONFLICT(name) DO UPDATE SET in_stock=1, kcal=excluded.kcal, protein=excluded.protein`,
            [body.name, body.kcal || 0, body.protein || 0, body.carbs || 0, body.fat || 0,
             body.fiber || 0, body.serving || '1 serving', body.kind || 'other']);
        return json({ ok: true });
      }

      case 'POST health': {
        // Accepts Health Auto Export (REST API) payloads and simple {steps, walk_min, ...} from Shortcuts.
        const rows = normalizeHealth(body);
        for (const r of rows)
          await run(env,
            `INSERT INTO activity (d,steps,walk_min,active_kcal,resting_hr,exercise_hr,sleep_min,src)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(d) DO UPDATE SET
               steps=COALESCE(excluded.steps,steps), walk_min=COALESCE(excluded.walk_min,walk_min),
               active_kcal=COALESCE(excluded.active_kcal,active_kcal),
               resting_hr=COALESCE(excluded.resting_hr,resting_hr),
               exercise_hr=COALESCE(excluded.exercise_hr,exercise_hr),
               sleep_min=COALESCE(excluded.sleep_min,sleep_min), src=excluded.src`,
            [r.d, r.steps, r.walk_min, r.active_kcal, r.resting_hr, r.exercise_hr, r.sleep_min, r.src]);

        if (body.weight_lb || body.body_fat)
          await run(env,
            `INSERT INTO weights (d,lb,bodyfat) VALUES (?1,?2,?3)
             ON CONFLICT(d) DO UPDATE SET lb=COALESCE(excluded.lb,lb), bodyfat=COALESCE(excluded.bodyfat,bodyfat)`,
            [dayStr(), body.weight_lb ?? null, body.body_fat ?? null]);

        return json({ ok: true, days: rows.length });
      }

      case 'DELETE food':
      case 'POST undo': {
        const table = body.type === 'workout' ? 'workout_log' : 'food_log';
        const last = await one(env, `SELECT id FROM ${table} WHERE d=?1 ORDER BY id DESC LIMIT 1`, [d]);
        if (last) await run(env, `DELETE FROM ${table} WHERE id=?1`, [last.id]);
        return json({ ok: !!last, today: await today(env, d) });
      }

      case 'POST target': {
        const t = await currentTarget(env);
        await run(env,
          'INSERT OR REPLACE INTO targets (d,kcal_low,kcal_high,protein,steps,reason) VALUES (?1,?2,?3,?4,?5,?6)',
          [dayStr(), body.kcal_low ?? t.kcal_low, body.kcal_high ?? t.kcal_high,
           body.protein ?? t.protein, body.steps ?? t.steps, body.reason || 'manual']);
        return json({ ok: true, target: await currentTarget(env) });
      }

      case 'POST accept': {
        // Apply whatever the weekly engine recommended.
        const [p, t, tr] = await Promise.all([profile(env), currentTarget(env), trends(env)]);
        const dec = decide(tr, t, Number(p.kcal_floor || 1450));
        if (dec.action === 'hold' || dec.action === 'activity') return json({ ok: false, decision: dec });
        await run(env,
          'INSERT OR REPLACE INTO targets (d,kcal_low,kcal_high,protein,steps,reason) VALUES (?1,?2,?3,?4,?5,?6)',
          [dayStr(), dec.target.kcal_low, dec.target.kcal_high, dec.target.protein, dec.target.steps, dec.headline]);
        return json({ ok: true, decision: dec, target: await currentTarget(env) });
      }

      case 'POST water': {
        const oz = Number(body.oz || 8);
        await run(env, 'INSERT INTO water_log (d,ts,oz) VALUES (?1,?2,?3)', [d, nowStr(), oz]);
        return json({ ok: true, today: await today(env, d) });
      }

      case 'POST water/undo': {
        const last = await one(env, 'SELECT id FROM water_log WHERE d=?1 ORDER BY id DESC LIMIT 1', [d]);
        if (last) await run(env, 'DELETE FROM water_log WHERE id=?1', [last.id]);
        return json({ ok: !!last, today: await today(env, d) });
      }

      case 'GET days': {
        const to = url.searchParams.get('to') || dayStr();
        const from = url.searchParams.get('from') || dayStr(-41);
        return json(await dayRange(env, from, to));
      }

      case 'GET day': {
        const [t, ph] = await Promise.all([today(env, d), one(env, 'SELECT * FROM photos WHERE d=?1', [d])]);
        return json({ ...t, photo: ph || null });
      }

      case 'GET todos':
        return json({
          reminders: await all(env, "SELECT * FROM todos WHERE kind='reminder' ORDER BY at"),
          todos: await all(env, "SELECT * FROM todos WHERE kind='todo' ORDER BY done, due, id"),
          ...(await grocery(env))
        });

      case 'POST todos': {
        if (body.delete) await run(env, 'DELETE FROM todos WHERE id=?1', [body.delete]);
        else if (body.toggle != null)
          await run(env, 'UPDATE todos SET done = 1 - done WHERE id=?1', [body.toggle]);
        else if (body.text)
          await run(env,
            'INSERT INTO todos (kind,text,due,at,repeat,alarm,done,created) VALUES (?1,?2,?3,?4,?5,?6,0,?7)',
            [body.kind || 'todo', String(body.text).slice(0, 160), body.due || null, body.at || null,
             body.repeat || null, body.alarm || 0, dayStr()]);
        return json({ ok: true });
      }

      /* ---- progress photos (R2) ---- */

      case 'POST photo': {
        if (!env.FIT_R2) return json({ error: 'R2 binding FIT_R2 is missing.' }, 500);
        const b64 = String(body.image || '').split(',').pop();
        if (!b64) return json({ error: 'no image' }, 400);
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const key = `progress/${d}.jpg`;
        await env.FIT_R2.put(key, bin, { httpMetadata: { contentType: 'image/jpeg' } });
        await run(env,
          `INSERT INTO photos (d,okey,w,h,ox,oy,scale,pose,ts) VALUES (?1,?2,?3,?4,0,0,1,?5,?6)
           ON CONFLICT(d) DO UPDATE SET okey=excluded.okey, w=excluded.w, h=excluded.h, ts=excluded.ts`,
          [d, key, body.w || null, body.h || null, body.pose || 'front', nowStr()]);
        return json({ ok: true, date: d });
      }

      case 'POST photo/align': {
        await run(env, 'UPDATE photos SET ox=?1, oy=?2, scale=?3 WHERE d=?4',
          [body.ox ?? 0, body.oy ?? 0, body.scale ?? 1, d]);
        return json({ ok: true });
      }

      case 'POST photo/delete': {
        const ph = await one(env, 'SELECT okey FROM photos WHERE d=?1', [d]);
        if (ph && env.FIT_R2) await env.FIT_R2.delete(ph.okey);
        await run(env, 'DELETE FROM photos WHERE d=?1', [d]);
        return json({ ok: true });
      }

      case 'GET photos':
        return json(await all(env, 'SELECT d,ox,oy,scale,pose,ts FROM photos ORDER BY d'));

      case 'GET history': {
        const n = Math.min(180, Number(url.searchParams.get('days') || 60));
        return json({
          weights: await all(env, 'SELECT * FROM weights ORDER BY d DESC LIMIT ?1', [n]),
          activity: await all(env, 'SELECT * FROM activity ORDER BY d DESC LIMIT ?1', [n]),
          intake: await all(env,
            'SELECT d, ROUND(SUM(kcal)) kcal, ROUND(SUM(protein)) protein, ROUND(SUM(fiber)) fiber FROM food_log GROUP BY d ORDER BY d DESC LIMIT ?1', [n])
        });
      }
    }
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }

  return json({ error: 'not found', path }, 404);
}

async function insertSet(env, d, i, note) {
  return run(env,
    `INSERT INTO workout_log (d,ts,exercise_id,exercise,discipline,muscle,sets,reps,weight,minutes,distance,rpe,note)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    [d, nowStr(), i.exercise_id ?? null, i.exercise, i.discipline ?? null, i.muscle ?? null,
     i.sets ?? null, i.reps ?? null, i.weight ?? null, i.minutes ?? null, i.distance ?? null,
     i.rpe ?? null, note || null]);
}

/* Health Auto Export sends {data:{metrics:[{name,units,data:[{date,qty}]}]}}.
   Shortcuts can send a flat object. Both land here. */
function normalizeHealth(body) {
  const map = {
    step_count: 'steps', apple_exercise_time: 'walk_min', active_energy: 'active_kcal',
    resting_heart_rate: 'resting_hr', walking_heart_rate_average: 'exercise_hr', sleep_analysis: 'sleep_min'
  };
  const byDay = {};
  const put = (d, k, v) => {
    if (v == null || isNaN(v)) return;
    byDay[d] = byDay[d] || { d, steps: null, walk_min: null, active_kcal: null, resting_hr: null, exercise_hr: null, sleep_min: null, src: 'apple-health' };
    byDay[d][k] = k === 'steps' ? Math.round(v) : Math.round(v * 10) / 10;
  };

  const metrics = body?.data?.metrics || body?.metrics;
  if (Array.isArray(metrics)) {
    for (const m of metrics) {
      const key = map[m.name];
      if (!key) continue;
      for (const pt of m.data || []) {
        const day = String(pt.date || '').slice(0, 10);
        let v = pt.qty ?? pt.value ?? pt.asleep ?? null;
        if (key === 'sleep_min' && v != null && v < 24) v = v * 60; // hours -> minutes
        put(day, key, Number(v));
      }
    }
  } else {
    const day = String(body.date || dayStr()).slice(0, 10);
    put(day, 'steps', Number(body.steps));
    put(day, 'walk_min', Number(body.walk_min ?? body.exercise_min));
    put(day, 'active_kcal', Number(body.active_kcal ?? body.active_energy));
    put(day, 'resting_hr', Number(body.resting_hr));
    put(day, 'exercise_hr', Number(body.exercise_hr));
    put(day, 'sleep_min', Number(body.sleep_min));
    if (byDay[day]) byDay[day].src = body.source || 'shortcut';
  }
  return Object.values(byDay);
}

function openapi(origin) {
  const P = (summary, extra = {}) => ({
    summary, security: [{ bearer: [] }],
    responses: { 200: { description: 'ok' } }, ...extra
  });
  const bodyOf = (props) => ({
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: props } } } }
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Fitness Hub', version: '1.0.0', description: 'Personal fitness and nutrition state.' },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/api/context': { get: P('Full plain-text snapshot of the health plan, current numbers and trends. Read this first.') },
      '/api/status': { get: P('Structured state: today totals, targets, trends.') },
      '/api/suggest': { get: P('Suggest a meal from inventory that fits remaining calories and protein.') },
      '/api/checkin': { get: P('Generate the weekly check-in report and recommendation.') },
      '/api/food': { post: P('Log food from natural language.', bodyOf({ text: { type: 'string' }, date: { type: 'string' } })) },
      '/api/workout': { post: P('Log a workout from natural language.', bodyOf({ text: { type: 'string' }, date: { type: 'string' } })) },
      '/api/weight': { post: P('Log weight and/or waist.', bodyOf({ lb: { type: 'number' }, waist: { type: 'number' }, date: { type: 'string' } })) },
      '/api/history': { get: P('Daily weight, activity and intake history.') }
    }
  };
}
