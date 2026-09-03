// Remote MCP server (Streamable HTTP, JSON responses).
// Add to Claude:  Settings > Connectors > Add custom connector > https://supernerd.tv/mcp
// Add to ChatGPT: Settings > Connectors > MCP server, same URL. Both use the bearer token.

import {
  json, authed, dayStr, nowStr, run, all,
  today, trends, contextDoc, checkin, suggestMeal, parseFood, parseWorkout, dayRange,
  coachBrief, exerciseStats, trainingOverview, matchExercise
} from './_lib.js';

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

const TOOLS = [
  {
    name: 'get_health_context',
    description:
      "Read Shaun's full fitness and nutrition context: goal, constraints, current plan, today's intake, weight and waist trends, training, and the engine's current recommendation. Call this before answering anything about his health, diet, training or progress.",
    inputSchema: S({})
  },
  {
    name: 'get_today',
    description: 'Calories, protein, fibre, steps, workouts and remaining room for a given day. Defaults to today.',
    inputSchema: S({ date: str('YYYY-MM-DD, optional') })
  },
  {
    name: 'log_food',
    description: 'Log food from plain language, e.g. "the short rib meal and about 15 fries". Returns updated day totals.',
    inputSchema: S({ text: str('What was eaten, in plain language'), date: str('YYYY-MM-DD, optional') }, ['text'])
  },
  {
    name: 'log_workout',
    description: 'Log training from plain language, e.g. "200 jumping jacks in 2 sets of 100, 20 squats, walked 18 minutes".',
    inputSchema: S({ text: str('What was done, in plain language'), date: str('YYYY-MM-DD, optional') }, ['text'])
  },
  {
    name: 'log_weight',
    description: 'Record morning weight in pounds and/or waist in inches.',
    inputSchema: S({ lb: num('Weight in pounds'), waist: num('Waist in inches'), date: str('YYYY-MM-DD, optional') })
  },
  {
    name: 'suggest_meal',
    description: 'Suggest a meal from what is actually in the kitchen that fits the calories and protein left today. Ninja Crispi friendly, low prep.',
    inputSchema: S({})
  },
  {
    name: 'weekly_checkin',
    description:
      'Run the weekly review: weight change, 7-day average, waist, average calories and protein, steps, strength sessions, plus a recommendation. The recommendation is often "no changes" and that is a valid result.',
    inputSchema: S({})
  },
  {
    name: 'get_exercise_stats',
    description:
      'Stats for one exercise over a window: sessions, total reps, total volume, best set, and the change against the previous window. Ranges: day, week, month, ytd, all.',
    inputSchema: S({ exercise: str('Exercise name, e.g. "goblet squat"'), range: str('day | week | month | ytd | all') }, ['exercise'])
  },
  {
    name: 'get_training_overview',
    description: 'Training rollup over a window — split by discipline (resistance, calisthenics, running), by muscle group, and the most-trained exercises.',
    inputSchema: S({ range: str('day | week | month | ytd | all') })
  },
  {
    name: 'log_water',
    description: 'Log water intake in fluid ounces.',
    inputSchema: S({ oz: num('Fluid ounces, e.g. 16'), date: str('YYYY-MM-DD, optional') }, ['oz'])
  },
  {
    name: 'add_reminder',
    description:
      'Add a reminder or a to-do that syncs to his subscribed Apple Calendar feed — water breaks, walks, weigh-ins, grocery items. Use kind "grocery" for shopping items.',
    inputSchema: S({
      text: str('What the reminder says'),
      kind: str('reminder, todo or grocery — defaults to reminder'),
      at: str('Time as HH:MM, 24 hour'),
      repeat: str('daily, weekdays, weekly, or leave empty for one time')
    }, ['text'])
  },
  {
    name: 'get_days',
    description: 'Day-by-day rollup over a date range: weight, waist, calories, protein, water, steps, training, whether a progress photo exists.',
    inputSchema: S({ from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD') })
  },
  {
    name: 'get_history',
    description: 'Raw daily history of weight, activity and intake for charting or analysis.',
    inputSchema: S({ days: num('How many days back, default 60') })
  }
];

const ok = (id, result) => json({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => json({ jsonrpc: '2.0', id, error: { code, message } });
const out = (text) => ({ content: [{ type: 'text', text }] });

export async function onRequest({ request, env }) {
  if (request.method === 'GET')
    return json({ name: 'fitness-hub', transport: 'streamable-http', hint: 'POST JSON-RPC here' });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await authed(request, env)))
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }
    });

  const body = await request.json().catch(() => null);
  if (!body) return err(null, -32700, 'parse error');
  const { id = null, method, params = {} } = body;

  if (method === 'initialize')
    return ok(id, {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fitness-hub', version: '1.0.0' }
    });

  if (method?.startsWith('notifications/')) return new Response(null, { status: 202 });
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  if (method !== 'tools/call') return err(id, -32601, `unknown method: ${method}`);

  const a = params.arguments || {};
  const d = a.date || dayStr();

  try {
    switch (params.name) {
      case 'get_health_context': {
        const b = await coachBrief(env);
        return ok(id, out(`${b.greeting} ${b.progress} ${b.plan} ${b.food}\n\n${await contextDoc(env)}`));
      }

      case 'get_today':
        return ok(id, out(JSON.stringify(await today(env, d), null, 1)));

      case 'log_food': {
        const items = await parseFood(env, String(a.text || ''));
        for (const i of items)
          await run(env,
            'INSERT INTO food_log (d,ts,item,kcal,protein,carbs,fat,fiber,src) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
            [d, nowStr(), i.item, i.kcal, i.protein, i.carbs, i.fat, i.fiber, 'mcp']);
        const t = await today(env, d);
        return ok(id, out(
          `Logged: ${items.map((i) => `${i.item} (${Math.round(i.kcal)} kcal, ${Math.round(i.protein)}g protein)`).join('; ')}\n\n` +
          `Today: ${t.kcal}/${t.target.kcal_high} kcal, ${t.protein}/${t.target.protein}g protein, ${t.fiber}g fibre. ` +
          `${t.kcal_remaining} kcal and ${t.protein_remaining}g protein left.`
        ));
      }

      case 'log_workout': {
        const items = await parseWorkout(env, String(a.text || ''));
        for (const i of items)
          await run(env,
            'INSERT INTO workout_log (d,ts,exercise,sets,reps,resistance,minutes,rpe,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',
            [d, nowStr(), i.exercise, i.sets, i.reps, i.resistance, i.minutes, i.rpe, 'mcp']);
        return ok(id, out(`Logged ${items.length} item(s): ${items.map((i) => i.exercise).join(', ')}`));
      }

      case 'log_weight': {
        if (a.lb == null && a.waist == null) return ok(id, out('Need a weight or a waist measurement.'));
        await run(env,
          `INSERT INTO weights (d,lb,waist) VALUES (?1,?2,?3)
           ON CONFLICT(d) DO UPDATE SET lb=COALESCE(excluded.lb,lb), waist=COALESCE(excluded.waist,waist)`,
          [d, a.lb ?? null, a.waist ?? null]);
        const tr = await trends(env);
        return ok(id, out(
          `Recorded${a.lb ? ` ${a.lb} lb` : ''}${a.waist ? ` waist ${a.waist}"` : ''} for ${d}.\n` +
          `7-day average ${tr.avg7 ?? '—'} lb, rate ${tr.rate_lb_per_week ?? '—'} lb/week. ` +
          `One reading doesn't mean anything on its own.`
        ));
      }

      case 'suggest_meal': {
        const s = await suggestMeal(env);
        if (!s.suggestion) return ok(id, out(s.note));
        const g = s.suggestion;
        return ok(id, out(
          `${g.items.join(' + ')} — about ${g.kcal} kcal, ${g.protein}g protein, ${g.fiber}g fibre (${g.method}).\n` +
          (g.dessert ? `Room after that for ${g.dessert}\n` : '') +
          `Leaves ${s.remaining.kcal - g.kcal} kcal and ${s.remaining.protein - g.protein}g protein for the rest of the day.\n\n` +
          `Other options: ${s.alternates.map((x) => `${x.items.join(' + ')} (${x.kcal} kcal, ${x.protein}g)`).join(' | ') || 'none'}`
        ));
      }

      case 'log_water': {
        await run(env, 'INSERT INTO water_log (d,ts,oz) VALUES (?1,?2,?3)', [d, nowStr(), Number(a.oz) || 8]);
        const t = await today(env, d);
        return ok(id, out(`Water at ${t.water_oz} of ${t.water_target} oz for ${d}.`));
      }

      case 'add_reminder': {
        await run(env,
          'INSERT INTO todos (kind,text,at,repeat,done,created) VALUES (?1,?2,?3,?4,0,?5)',
          [a.kind || 'reminder', String(a.text).slice(0, 160), a.at || null, a.repeat || null, dayStr()]);
        return ok(id, out(`Added: ${a.text}${a.at ? ` at ${a.at}` : ''}${a.repeat ? `, ${a.repeat}` : ''}. It appears in his calendar on the next refresh.`));
      }

      case 'get_days':
        return ok(id, out(JSON.stringify(await dayRange(env, a.from || dayStr(-30), a.to || dayStr()), null, 1)));

      case 'get_exercise_stats': {
        const ex = await matchExercise(env, a.exercise);
        if (!ex) return ok(id, out(`No exercise matching "${a.exercise}" has been logged yet.`));
        const st = await exerciseStats(env, ex.id, a.range || 'month');
        return ok(id, out(
          `${st.exercise.name} — ${st.range}\n` +
          `${st.sessions} sessions, ${st.total_reps} total reps` +
          (st.total_volume ? `, ${st.total_volume.toLocaleString()} lb of volume` : '') +
          (st.total_distance ? `, ${st.total_distance} mi` : '') +
          (st.best_weight ? `\nBest set: ${st.best_reps} reps at ${st.best_weight} lb` : st.best_reps ? `\nBest set: ${st.best_reps} reps` : '') +
          (st.change_vs_prev != null ? `\nReps ${st.change_vs_prev >= 0 ? 'up' : 'down'} ${Math.abs(st.change_vs_prev)}% against the previous ${st.range}` : '') +
          `\n\n${JSON.stringify(st.series)}`
        ));
      }

      case 'get_training_overview':
        return ok(id, out(JSON.stringify(await trainingOverview(env, a.range || 'month'), null, 1)));

      case 'weekly_checkin':
        return ok(id, out((await checkin(env)).body));

      case 'get_history': {
        const n = Math.min(180, Number(a.days || 60));
        const data = {
          weights: await all(env, 'SELECT d,lb,waist FROM weights ORDER BY d DESC LIMIT ?1', [n]),
          activity: await all(env, 'SELECT d,steps,walk_min FROM activity ORDER BY d DESC LIMIT ?1', [n]),
          intake: await all(env,
            'SELECT d, ROUND(SUM(kcal)) kcal, ROUND(SUM(protein)) protein FROM food_log GROUP BY d ORDER BY d DESC LIMIT ?1', [n])
        };
        return ok(id, out(JSON.stringify(data, null, 1)));
      }
    }
  } catch (e) {
    return ok(id, { ...out(`Tool failed: ${e.message || e}`), isError: true });
  }

  return err(id, -32602, `unknown tool: ${params.name}`);
}
