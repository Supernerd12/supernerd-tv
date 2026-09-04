import {
  VERSION, dayStr, nowStr, json, txt, authed, newCookie,
  all, one, run, profile, currentTarget, trends, today, decide,
  suggestMeal, parseFood, parseWorkout, contextDoc, checkin,
  dayRange, grocery, icsFeed, coachBrief, exerciseStats, trainingOverview, ensureExercise, matchExercise,
  rangeStart, parseTrace, estimateBurn, bodyWeightLb
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
            'INSERT INTO food_log (d,ts,item,kcal,protein,carbs,fat,fiber,src,parts) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
            [d, nowStr(), i.item, i.kcal, i.protein, i.carbs, i.fat, i.fiber, i.src,
             i.parts ? JSON.stringify(i.parts) : null]);
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
        const mode = url.searchParams.get('mode') || 'mine';   // mine | library
        const where = ['e.archived=0'], bind = [];
        if (disc) { where.push(`e.discipline=?${bind.length + 1}`); bind.push(disc); }
        if (muscle) { where.push(`e.muscle=?${bind.length + 1}`); bind.push(muscle); }
        if (mode === 'mine')
          where.push('(e.active=1 OR EXISTS (SELECT 1 FROM workout_log w WHERE w.exercise_id=e.id))');
        else
          where.push('e.active=0');
        const list = await all(env,
          `SELECT e.*, (SELECT MAX(d) FROM workout_log w WHERE w.exercise_id=e.id) last,
                  (SELECT COUNT(DISTINCT d) FROM workout_log w WHERE w.exercise_id=e.id) days
             FROM exercises e WHERE ${where.join(' AND ')} ORDER BY last DESC, name`, bind);
        return json(list);
      }

      case 'POST exercise/active': {
        await run(env, 'UPDATE exercises SET active=?1 WHERE id=?2', [body.active ? 1 : 0, body.id]);
        return json({ ok: true });
      }

      /* Walking and cardio read straight out of Apple Health. Nothing to log by hand. */
      case 'GET cardio': {
        const range = url.searchParams.get('range') || 'week';

        // Day means the last 24 hours from right now, in hourly buckets — not the calendar date.
        if (range === 'day') {
          const now = new Date();
          const keys = [];
          for (let i = 23; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 3600000);
            const local = d.toLocaleString('sv-SE', { timeZone: TZ });
            keys.push({ t: local.slice(0, 13).replace(' ', 'T'), hour: Number(local.slice(11, 13)) });
          }
          const have = await all(env,
            'SELECT t, steps, distance FROM activity_hours WHERE t >= ?1 ORDER BY t',
            [keys[0].t]);
          const byT = Object.fromEntries(have.map((r) => [r.t, r]));
          const series = keys.map((k) => ({
            d: k.t,
            label: (k.hour % 12 === 0 ? 12 : k.hour % 12) + (k.hour < 12 ? 'a' : 'p'),
            value: byT[k.t]?.steps || 0,
            distance: byT[k.t]?.distance || 0
          }));
          const t2 = await currentTarget(env);
          let totalSteps = series.reduce((a, r) => a + r.value, 0);
          let totalDist = series.reduce((a, r) => a + (r.distance || 0), 0);

          // No hourly data yet? Show today's daily total rather than a misleading zero.
          const dayRow = await one(env, 'SELECT steps, distance, walk_min, active_kcal FROM activity WHERE d=?1', [dayStr()]);
          const hourly = series.some((r) => r.value > 0);
          if (!hourly && dayRow?.steps) {
            totalSteps = dayRow.steps;
            totalDist = dayRow.distance || 0;
          }
          const busiest = series.reduce((a, b) => (b.value > a.value ? b : a), series[0]);
          return json({
            range, rolling: true, target_steps: t2.steps,
            today: { steps: Math.round(totalSteps), distance: Math.round(totalDist * 100) / 100,
                     walk_min: dayRow?.walk_min ?? null, active_kcal: dayRow?.active_kcal ?? null },
            hourly_available: hourly,
            total_steps: Math.round(totalSteps),
            total_distance: Math.round(totalDist * 100) / 100,
            busiest_hour: busiest && busiest.value ? busiest.label : null,
            hours_with_data: series.filter((r) => r.value > 0).length,
            series, sessions: []
          });
        }

        const from = rangeStart(range);
        const days = await all(env,
          `SELECT d, COALESCE(steps,0) steps, COALESCE(walk_min,0) walk_min,
                  COALESCE(distance,0) distance, COALESCE(active_kcal,0) active_kcal
             FROM activity WHERE d>=?1 ORDER BY d`, [from]);
        const logged = await all(env,
          `SELECT d, SUM(COALESCE(minutes,0)) minutes, SUM(COALESCE(distance,0)) distance, GROUP_CONCAT(exercise) ex
             FROM workout_log WHERE discipline='cardio' AND d>=?1 GROUP BY d`, [from]);
        const t = await currentTarget(env);
        const sum = (k) => days.reduce((a, r) => a + (r[k] || 0), 0);
        const withSteps = days.filter((r) => r.steps > 0);
        return json({
          range, from, target_steps: t.steps,
          today: days.find((r) => r.d === dayStr()) || null,
          total_steps: sum('steps'),
          avg_steps: withSteps.length ? Math.round(sum('steps') / withSteps.length) : null,
          best_day: withSteps.length ? withSteps.reduce((a, b) => (b.steps > a.steps ? b : a)) : null,
          days_at_target: withSteps.filter((r) => r.steps >= (t.steps || 8500)).length,
          days_counted: withSteps.length,
          total_distance: Math.round(sum('distance') * 10) / 10,
          total_walk_min: Math.round(sum('walk_min')),
          series: days, sessions: logged
        });
      }

      /* In-app coach. Reads the same context the connectors get. */
      case 'POST chat': {
        const msg = String(body.message || '').slice(0, 2000);
        if (!msg) return json({ error: 'no message' }, 400);
        const ctx = await contextDoc(env);
        const history = (body.history || []).slice(-8).map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 1500)
        }));
        const sys =
          `You are Shaun's fitness coach inside his own tracking app. Everything below is his real, current data.\n\n${ctx}\n\n` +
          `Answer from this data, not generic advice. Be direct and brief — a few sentences unless he asks for more. ` +
          `No hype, no lecturing, no moralising about food. "Keep doing what you're doing" is a real answer when the numbers say so. ` +
          `If he mentions Achilles, ankle, knee or shin pain, tell him to swap to step jacks and back off, every time. ` +
          `If he describes something he ate, did, drank or weighed, end your reply with a line starting LOG: followed by ` +
          `a JSON object like {"kind":"food","text":"..."} — kinds are food, workout, water (with "oz"), weight (with "lb" and/or "waist"). ` +
          `Only add a LOG line when he is actually reporting something he did.`;

        let reply = '';
        try {
          if (env.OPENAI_KEY) {
            const r = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_KEY}` },
              body: JSON.stringify({ model: body.model || 'gpt-4o-mini', max_tokens: 600,
                messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: msg }] })
            });
            reply = (await r.json()).choices?.[0]?.message?.content || '';
          } else if (env.AI) {
            const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
              messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: msg }],
              max_tokens: 600
            });
            reply = r.response || '';
          }
        } catch (e) { reply = ''; }
        if (!reply) return json({ reply: 'The coach is not wired up yet — add a Workers AI binding named AI, or an OPENAI_KEY secret, in Cloudflare.' });

        // Pull out an action if the model asked for one, run it, strip it from the text.
        let action = null;
        const m = reply.match(/LOG:\s*(\{[\s\S]*?\})/);
        if (m) {
          reply = reply.slice(0, m.index).trim();
          try { action = JSON.parse(m[1]); } catch { action = null; }
        }
        if (action) {
          const dd = dayStr();
          if (action.kind === 'food' && action.text) {
            const items = await parseFood(env, action.text);
            for (const i of items)
              await run(env, 'INSERT INTO food_log (d,ts,item,kcal,protein,carbs,fat,fiber,src,parts) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
                [dd, nowStr(), i.item, i.kcal, i.protein, i.carbs, i.fat, i.fiber, 'chat',
                 i.parts ? JSON.stringify(i.parts) : null]);
          } else if (action.kind === 'workout' && action.text) {
            const items = await parseWorkout(env, action.text);
            for (const i of items) await insertSet(env, dd, i, 'chat');
          } else if (action.kind === 'water' && action.oz) {
            await run(env, 'INSERT INTO water_log (d,ts,oz) VALUES (?1,?2,?3)', [dd, nowStr(), Number(action.oz)]);
          } else if (action.kind === 'weight' && (action.lb || action.waist)) {
            await run(env, `INSERT INTO weights (d,lb,waist) VALUES (?1,?2,?3)
              ON CONFLICT(d) DO UPDATE SET lb=COALESCE(excluded.lb,lb), waist=COALESCE(excluded.waist,waist)`,
              [dd, action.lb ?? null, action.waist ?? null]);
          } else action = null;
        }
        return json({ reply, action });
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

      /* ---- editing and deleting anything already logged ---- */

      case 'POST food/edit': {
        const f = ['item','kcal','protein','carbs','fat','fiber'].filter(k => body[k] !== undefined);
        if (!body.id || !f.length) return json({ error: 'nothing to change' }, 400);
        await run(env, `UPDATE food_log SET ${f.map((k,i)=>`${k}=?${i+2}`).join(', ')}, src='edited' WHERE id=?1`,
          [body.id, ...f.map(k => body[k])]);
        // Optionally remember it, so the same thing matches correctly next time.
        if (body.save_as_food && body.item)
          await run(env,
            `INSERT INTO foods (name,kcal,protein,carbs,fat,fiber,serving,kind,in_stock)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(name) DO UPDATE SET kcal=excluded.kcal, protein=excluded.protein,
               carbs=excluded.carbs, fat=excluded.fat, fiber=excluded.fiber`,
            [String(body.item).slice(0,80), body.kcal||0, body.protein||0, body.carbs||0,
             body.fat||0, body.fiber||0, body.serving||'1 serving', body.kind||'other', body.in_stock?1:0]);
        return json({ ok: true, today: await today(env, d) });
      }

      case 'POST food/delete': {
        await run(env, 'DELETE FROM food_log WHERE id=?1', [body.id]);
        return json({ ok: true, today: await today(env, d) });
      }

      case 'POST workout/edit': {
        const f = ['exercise','sets','reps','weight','minutes','distance'].filter(k => body[k] !== undefined);
        if (!body.id || !f.length) return json({ error: 'nothing to change' }, 400);
        await run(env, `UPDATE workout_log SET ${f.map((k,i)=>`${k}=?${i+2}`).join(', ')} WHERE id=?1`,
          [body.id, ...f.map(k => body[k])]);
        return json({ ok: true, today: await today(env, d) });
      }

      case 'POST workout/delete': {
        await run(env, 'DELETE FROM workout_log WHERE id=?1', [body.id]);
        return json({ ok: true, today: await today(env, d) });
      }

      case 'POST weight/delete': {
        await run(env, 'DELETE FROM weights WHERE d=?1', [body.date || d]);
        return json({ ok: true });
      }

      /* Tells the app which optional bindings are actually wired up. */
      case 'POST parse-test':
        return json(await parseTrace(env, String(body.text || 'two eggs and a banana')));

      case 'GET diagnostics': {
        const counts = await one(env,
          `SELECT (SELECT COUNT(*) FROM foods) foods, (SELECT COUNT(*) FROM exercises) exercises,
                  (SELECT COUNT(*) FROM food_log) food_log, (SELECT COUNT(*) FROM workout_log) workout_log,
                  (SELECT COUNT(*) FROM weights) weights, (SELECT COUNT(*) FROM activity) activity,
                  (SELECT COUNT(*) FROM activity_hours) activity_hours, (SELECT COUNT(*) FROM photos) photos`);
        return json({
          version: VERSION, database: true,
          natural_language: !!env.AI ? 'workers-ai' : env.OPENAI_KEY ? 'openai' : env.GROQ_KEY ? 'groq' : 'none',
          photos_storage: !!env.FIT_R2, coach_chat: !!(env.AI || env.OPENAI_KEY),
          counts
        });
      }

      case 'GET inventory':
        return json(await all(env, 'SELECT id,name,kcal,protein,fiber,serving,kind,in_stock FROM foods ORDER BY kind,name'));

      case 'POST inventory': {
        if (Array.isArray(body.delete_ids) && body.delete_ids.length) {
          const ids = body.delete_ids.map(Number).filter(Number.isFinite).slice(0, 200);
          if (ids.length)
            await run(env, `DELETE FROM foods WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(',')})`, ids);
          return json({ ok: true, removed: ids.length });
        }
        if (body.delete != null) {
          await run(env, 'DELETE FROM foods WHERE id=?1', [body.delete]);
          return json({ ok: true, removed: 1 });
        }
        if (body.id != null && body.edit) {
          const f = ['name','kcal','protein','carbs','fat','fiber','serving','kind'].filter(k => body[k] !== undefined);
          if (f.length)
            await run(env, `UPDATE foods SET ${f.map((k,i)=>`${k}=?${i+2}`).join(', ')} WHERE id=?1`,
              [body.id, ...f.map(k => body[k])]);
          return json({ ok: true });
        }
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
        const bodyRows = normalizeBody(body);
        for (const r of rows)
          await run(env,
            `INSERT INTO activity (d,steps,walk_min,active_kcal,resting_hr,exercise_hr,sleep_min,distance,src)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?9,?8)
             ON CONFLICT(d) DO UPDATE SET
               steps=COALESCE(excluded.steps,steps), walk_min=COALESCE(excluded.walk_min,walk_min),
               active_kcal=COALESCE(excluded.active_kcal,active_kcal),
               resting_hr=COALESCE(excluded.resting_hr,resting_hr),
               exercise_hr=COALESCE(excluded.exercise_hr,exercise_hr),
               sleep_min=COALESCE(excluded.sleep_min,sleep_min),
               distance=COALESCE(excluded.distance,distance), src=excluded.src`,
            [r.d, r.steps, r.walk_min, r.active_kcal, r.resting_hr, r.exercise_hr, r.sleep_min, r.src, r.distance]);

        // Hourly buckets, so the Day view can be a rolling 24 hours instead of a calendar date.
        // Shortcuts sends these as a plain array from Find Health Samples grouped by hour.
        for (const [arr, day, field] of [
          [body.hourly_steps, body.date || dayStr(), 'steps'],
          [body.hourly_distance, body.date || dayStr(), 'distance'],
          [body.hourly_steps_prev, body.date_prev || dayStr(-1), 'steps'],
          [body.hourly_distance_prev, body.date_prev || dayStr(-1), 'distance']
        ]) {
          if (!Array.isArray(arr)) continue;
          const d = String(day).slice(0, 10);
          for (let h = 0; h < Math.min(24, arr.length); h++) {
            const v = Number(arr[h]);
            if (!isFinite(v)) continue;
            const t = `${d}T${String(h).padStart(2, '0')}`;
            await run(env,
              `INSERT INTO activity_hours (t,${field},src) VALUES (?1,?2,'apple-health')
               ON CONFLICT(t) DO UPDATE SET ${field}=excluded.${field}`, [t, v]);
          }
        }

        for (const b of bodyRows)
          await run(env,
            `INSERT INTO weights (d,lb,bodyfat,muscle,visceral) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(d) DO UPDATE SET
               lb=COALESCE(excluded.lb,lb), bodyfat=COALESCE(excluded.bodyfat,bodyfat),
               muscle=COALESCE(excluded.muscle,muscle), visceral=COALESCE(excluded.visceral,visceral)`,
            [b.d, b.lb, b.bodyfat, b.muscle, b.visceral]);

        const hourCount = await one(env, 'SELECT COUNT(*) n FROM activity_hours');
        const got = Object.fromEntries(Object.entries(body)
          .filter(([k]) => !['metrics','data'].includes(k))
          .map(([k, v]) => [k, Array.isArray(v) ? `array(${v.length})` : v]));
        return json({
          ok: true, days: rows.length, body_days: bodyRows.length, hours_stored: hourCount?.n ?? 0,
          received: got,
          warning: rows.length === 0 && bodyRows.length === 0
            ? 'Nothing usable arrived. Every value was empty, zero or not a number — check the Get Value actions in your shortcut.'
            : undefined
        });
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
  const ex = i.exercise_id
    ? await one(env, 'SELECT met, unit FROM exercises WHERE id=?1', [i.exercise_id]) : null;
  const kcal = estimateBurn({
    met: ex?.met, unit: ex?.unit, minutes: i.minutes, sets: i.sets, reps: i.reps,
    weightLb: await bodyWeightLb(env)
  });
  await run(env,
    `INSERT INTO workout_log (d,ts,exercise_id,exercise,discipline,muscle,sets,reps,weight,minutes,distance,rpe,note,kcal)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
    [d, nowStr(), i.exercise_id ?? null, i.exercise, i.discipline ?? null, i.muscle ?? null,
     i.sets ?? null, i.reps ?? null, i.weight ?? null, i.minutes ?? null, i.distance ?? null,
     i.rpe ?? null, note || null, kcal]);
  i.kcal = kcal;
  return kcal;
}

/* Health Auto Export sends {data:{metrics:[{name,units,data:[{date,qty}]}]}}.
   Shortcuts can send a flat object. Both land here. */
function normalizeHealth(body) {
  const map = {
    step_count: 'steps', apple_exercise_time: 'walk_min', active_energy: 'active_kcal',
    resting_heart_rate: 'resting_hr', walking_heart_rate_average: 'exercise_hr', sleep_analysis: 'sleep_min',
    walking_running_distance: 'distance', distance_walking_running: 'distance'
  };
  const byDay = {};
  // A zero from a misconfigured shortcut must never overwrite a real reading.
  // Genuine rest days are indistinguishable from a broken automation here, and
  // silently wiping a good number is far worse than missing one.
  const put = (d, k, v) => {
    if (v == null || isNaN(v) || v === 0) return;
    byDay[d] = byDay[d] || { d, steps: null, walk_min: null, active_kcal: null, resting_hr: null, exercise_hr: null, sleep_min: null, distance: null, src: 'apple-health' };
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
    put(day, 'distance', Number(body.distance ?? body.walk_distance));
    if (byDay[day]) byDay[day].src = body.source || 'shortcut';
  }
  return Object.values(byDay);
}

/* Body composition, from a smart scale that syncs into Apple Health.
   Handles Health Auto Export's metrics array and a flat Shortcuts payload.
   Weight arrives in kg or lb depending on the exporter's units — we convert when told. */
function normalizeBody(body) {
  const out = {};
  const put = (d, k, v) => {
    if (v == null || isNaN(v)) return;
    out[d] = out[d] || { d, lb: null, bodyfat: null, muscle: null, visceral: null };
    out[d][k] = Math.round(v * 10) / 10;
  };
  const map = {
    weight_body_mass: 'lb', body_mass: 'lb', weight: 'lb',
    body_fat_percentage: 'bodyfat', body_fat: 'bodyfat',
    lean_body_mass: 'muscle'
  };

  const metrics = body?.data?.metrics || body?.metrics;
  if (Array.isArray(metrics)) {
    for (const m of metrics) {
      const key = map[m.name];
      if (!key) continue;
      const kg = /kg/i.test(m.units || '');
      for (const pt of m.data || []) {
        let v = Number(pt.qty ?? pt.value);
        if ((key === 'lb' || key === 'muscle') && kg) v *= 2.20462;
        if (key === 'bodyfat' && v > 0 && v < 1) v *= 100; // some exporters send a fraction
        put(String(pt.date || '').slice(0, 10), key, v);
      }
    }
  }

  const d = String(body.date || dayStr()).slice(0, 10);
  if (body.weight_kg) put(d, 'lb', Number(body.weight_kg) * 2.20462);
  if (body.weight_lb) put(d, 'lb', Number(body.weight_lb));
  if (body.body_fat) put(d, 'bodyfat', Number(body.body_fat));
  if (body.muscle_pct || body.muscle) put(d, 'muscle', Number(body.muscle_pct ?? body.muscle));
  if (body.visceral) put(d, 'visceral', Number(body.visceral));

  return Object.values(out);
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
