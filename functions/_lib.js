// Fitness Hub — shared library (Cloudflare Pages Functions)
// Underscore prefix = not routed, importable only.

export const VERSION = 'v7';
export const TZ = 'America/New_York';

export const dayStr = (offset = 0) =>
  new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });

export const nowStr = () =>
  new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T');

export const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export const txt = (t, s = 200) =>
  new Response(t, {
    status: s,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });

const r1 = (n) => Math.round(n * 10) / 10;
const enc = new TextEncoder();

/* ---------------- auth ---------------- */

async function sign(v, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export async function newCookie(env) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 120; // 120 days
  const base = `s.${exp}`;
  return `${base}.${await sign(base, env.FIT_TOKEN)}`;
}

// Accepts either a bearer token (for Claude / ChatGPT / Shortcuts) or a signed browser cookie.
export async function authed(request, env) {
  if (!env.FIT_TOKEN) return false;
  const h = request.headers.get('authorization') || '';
  if (h.startsWith('Bearer ') && safeEq(h.slice(7).trim(), env.FIT_TOKEN)) return true;

  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)fitsess=([^;]+)/);
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return false;
  const [p, exp, sig] = parts;
  if (!Number(exp) || Number(exp) < Date.now()) return false;
  return safeEq(sig, await sign(`${p}.${exp}`, env.FIT_TOKEN));
}

/* ---------------- db ---------------- */

const stmt = (env, sql, b = []) => env.FIT_DB.prepare(sql).bind(...b);
export const all = async (env, sql, b = []) => (await stmt(env, sql, b).all()).results || [];
export const one = (env, sql, b = []) => stmt(env, sql, b).first();
export const run = (env, sql, b = []) => stmt(env, sql, b).run();

export async function profile(env) {
  const rows = await all(env, 'SELECT k,v FROM profile');
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}

export async function currentTarget(env) {
  const t = await one(env, 'SELECT * FROM targets ORDER BY d DESC LIMIT 1');
  return t || { kcal_low: 1650, kcal_high: 1750, protein: 120, steps: 8500, d: dayStr() };
}

/* ---------------- trends ---------------- */

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

export async function trends(env) {
  const w = await all(env, 'SELECT d,lb,waist FROM weights WHERE lb IS NOT NULL ORDER BY d DESC LIMIT 90');
  const lbs = w.map((r) => r.lb);
  const avg7 = mean(lbs.slice(0, 7));
  const avgPrev7 = lbs.length >= 10 ? mean(lbs.slice(7, 14)) : null;

  // Weekly rate: negative = losing. Uses the gap between the two rolling windows.
  let rate = null;
  if (avg7 != null && avgPrev7 != null && w.length >= 10) {
    const d1 = new Date(w[0].d), d2 = new Date(w[Math.min(w.length - 1, 13)].d);
    const spanDays = Math.max(7, Math.round((d1 - d2) / 86400000));
    rate = ((avg7 - avgPrev7) / spanDays) * 7 * 2; // windows are ~half a span apart
    rate = r1(rate);
  }

  const waists = w.filter((r) => r.waist != null);
  const waistNow = waists[0]?.waist ?? null;
  const waistPrev = waists.find((r) => new Date(waists[0].d) - new Date(r.d) >= 12 * 86400000)?.waist ?? null;

  const act = await all(env, 'SELECT d,steps,walk_min FROM activity WHERE steps IS NOT NULL ORDER BY d DESC LIMIT 30');
  const steps7 = mean(act.slice(0, 7).map((r) => r.steps));
  const steps30 = mean(act.map((r) => r.steps));

  const since = dayStr(-14);
  const intake = await all(
    env,
    'SELECT d, SUM(kcal) k, SUM(protein) p, SUM(fiber) f FROM food_log WHERE d >= ?1 AND d < ?2 GROUP BY d',
    [since, dayStr()]
  );
  const strength = await all(env, 'SELECT d, COUNT(*) n FROM workout_log WHERE d >= ?1 GROUP BY d', [dayStr(-14)]);

  const startW = Number((await profile(env)).start_weight_lb || 0);

  return {
    latest_weight: lbs[0] ?? null,
    latest_weight_date: w[0]?.d ?? null,
    avg7: avg7 == null ? null : r1(avg7),
    avg7_prev: avgPrev7 == null ? null : r1(avgPrev7),
    rate_lb_per_week: rate,
    total_change_lb: lbs[0] && startW ? r1(lbs[0] - startW) : null,
    logged_weigh_ins: w.length,
    waist_in: waistNow,
    waist_change_in: waistNow != null && waistPrev != null ? r1(waistNow - waistPrev) : null,
    steps_7day_avg: steps7 == null ? null : Math.round(steps7),
    steps_30day_avg: steps30 == null ? null : Math.round(steps30),
    avg_kcal_14day: intake.length ? Math.round(mean(intake.map((r) => r.k))) : null,
    avg_protein_14day: intake.length ? Math.round(mean(intake.map((r) => r.p))) : null,
    avg_fiber_14day: intake.length ? Math.round(mean(intake.map((r) => r.f))) : null,
    days_logged_14: intake.length,
    strength_sessions_14: strength.length
  };
}

/* ---------------- today ---------------- */

export async function today(env, d = dayStr()) {
  const f = await one(
    env,
    'SELECT COALESCE(SUM(kcal),0) kcal, COALESCE(SUM(protein),0) protein, COALESCE(SUM(carbs),0) carbs, COALESCE(SUM(fat),0) fat, COALESCE(SUM(fiber),0) fiber, COUNT(*) n FROM food_log WHERE d=?1',
    [d]
  );
  const items = await all(env, 'SELECT id,ts,item,kcal,protein,carbs,fat,fiber,src FROM food_log WHERE d=?1 ORDER BY id', [d]);
  const w = await all(env, 'SELECT * FROM workout_log WHERE d=?1 ORDER BY id', [d]);
  const a = await one(env, 'SELECT * FROM activity WHERE d=?1', [d]);
  const wt = await one(env, 'SELECT * FROM weights WHERE d=?1', [d]);
  const wa = await one(env, 'SELECT COALESCE(SUM(oz),0) oz FROM water_log WHERE d=?1', [d]);
  const ph = await one(env, 'SELECT d,okey FROM photos WHERE d=?1', [d]);
  const t = await currentTarget(env);
  const p = await profile(env);
  const waterTarget = Number(p.water_oz_target || 80);

  return {
    date: d,
    kcal: Math.round(f.kcal), protein: Math.round(f.protein), carbs: Math.round(f.carbs),
    fat: Math.round(f.fat), fiber: Math.round(f.fiber),
    kcal_remaining: Math.round(t.kcal_high - f.kcal),
    protein_remaining: Math.round(t.protein - f.protein),
    steps: a?.steps ?? null, walk_min: a?.walk_min ?? null, active_kcal: a?.active_kcal ?? null,
    sleep_min: a?.sleep_min ?? null, resting_hr: a?.resting_hr ?? null,
    weight_lb: wt?.lb ?? null, waist_in: wt?.waist ?? null,
    water_oz: Math.round(wa.oz), water_target: waterTarget,
    has_photo: !!ph,
    target: t, food_items: items, workouts: w,
    alerts: buildAlerts({ d, wt, ph, wa, a, t, kcal: f.kcal, protein: f.protein, waterTarget })
  };
}

// What the hub nags about. Only things that are actually missing, and only for today.
function buildAlerts({ d, wt, ph, wa, a, t, kcal, protein, waterTarget }) {
  if (d !== dayStr()) return [];
  const out = [];
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  if (!wt?.lb) out.push({ k: 'weight', level: 'do', text: 'No weigh-in yet today', go: 'hub' });
  if (!wt?.waist && new Date(d).getUTCDay() === 0) out.push({ k: 'waist', level: 'do', text: 'Sunday — measure your waist', go: 'hub' });
  if (!ph && hour < 20) out.push({ k: 'photo', level: 'do', text: 'No progress photo today', go: 'photos' });
  if (wa.oz < waterTarget * 0.5 && hour >= 14) out.push({ k: 'water', level: 'nudge', text: `Water is at ${Math.round(wa.oz)} of ${waterTarget} oz`, go: 'food' });
  if (kcal === 0 && hour >= 13) out.push({ k: 'food', level: 'nudge', text: 'Nothing logged today yet', go: 'food' });
  if (kcal > 0 && hour >= 20 && protein < t.protein * 0.75)
    out.push({ k: 'protein', level: 'nudge', text: `Protein at ${Math.round(protein)}g — a shake or yogurt closes the gap`, go: 'food' });
  if (a?.steps != null && a.steps < t.steps * 0.6 && hour >= 18)
    out.push({ k: 'steps', level: 'nudge', text: `${a.steps.toLocaleString()} steps — a 15 minute walk still fits`, go: 'hub' });
  return out;
}

/* ---------------- adaptive engine (brief §11) ---------------- */
// Conservative by design: holds unless there is real evidence, never drops below the floor,
// never cuts calories while waist or strength are improving, needs 14 days before moving.

export function decide(tr, target, floor = 1450, flags = {}) {
  const hold = (why) => ({ action: 'hold', headline: 'No changes — keep doing exactly what you\'re doing.', why, target });
  const days = tr.days_logged_14 || 0;
  const rate = tr.rate_lb_per_week;

  if (tr.logged_weigh_ins < 8 || days < 8)
    return hold('Not enough data yet. Two full weeks of weigh-ins and food logs before anything moves.');

  if (rate == null) return hold('Not enough weigh-ins to compute a reliable weekly rate.');

  const waistImproving = tr.waist_change_in != null && tr.waist_change_in <= -0.25;
  const strengthOK = (tr.strength_sessions_14 || 0) >= 4;

  if (rate <= -0.45 && rate >= -1.05)
    return hold(`Losing ${Math.abs(rate)} lb/week — dead centre of the 0.5–1 lb target range.`);

  if (rate < -1.25) {
    const bump = Math.min(150, Math.round((target.kcal_high * 0.08) / 25) * 25);
    return {
      action: 'increase',
      headline: `Add about ${bump} kcal/day.`,
      why: `Dropping ${Math.abs(rate)} lb/week is faster than intended. Faster loss at this size costs muscle and recovery.`,
      target: { ...target, kcal_low: target.kcal_low + bump, kcal_high: target.kcal_high + bump }
    };
  }

  if (rate > -0.2) {
    if (waistImproving || strengthOK)
      return hold(
        `Scale is flat but ${waistImproving ? `waist is down ${Math.abs(tr.waist_change_in)}"` : 'strength work is consistent'}. That is recomposition. Cutting calories here would be the wrong move.`
      );

    if (tr.avg_kcal_14day && tr.avg_kcal_14day > target.kcal_high + 75)
      return hold(
        `Averaging ${tr.avg_kcal_14day} kcal against a ${target.kcal_high} target. The plan hasn't actually been tested yet — hit the existing number for two weeks first.`
      );

    if ((tr.steps_7day_avg || 0) < (target.steps || 8500) * 0.8)
      return {
        action: 'activity',
        headline: `Add steps before cutting food.`,
        why: `Steps are averaging ${tr.steps_7day_avg}/day against a ${target.steps} target. Movement is the cheaper lever.`,
        target
      };

    const cut = 125;
    const proposed = Math.max(floor, target.kcal_high - cut);
    if (proposed >= target.kcal_high)
      return hold(`Already at the ${floor} kcal floor. Cutting further isn't on the table — adjust activity instead.`);
    return {
      action: 'decrease',
      headline: `Trim about ${target.kcal_high - proposed} kcal/day.`,
      why: `Genuinely stagnant over 14 days with intake on target, waist flat and steps on target. Small trim, not a crash.`,
      target: { ...target, kcal_low: Math.max(floor - 100, target.kcal_low - cut), kcal_high: proposed }
    };
  }

  return hold(`Losing ${Math.abs(rate)} lb/week — slower than target but moving in the right direction. Give it another week.`);
}

/* ---------------- meal suggestion (brief §18) ---------------- */

export async function suggestMeal(env, opts = {}) {
  const t = await today(env);
  const stock = await all(env, 'SELECT * FROM foods WHERE in_stock=1');
  let remK = opts.kcal ?? t.kcal_remaining;
  let remP = opts.protein ?? t.protein_remaining;

  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  const lastMealOfDay = hour >= 16;
  const dessertBudget = lastMealOfDay && remK > 550 ? 200 : 0;
  const budget = remK - dessertBudget;

  if (budget < 150)
    return {
      remaining: { kcal: remK, protein: remP },
      suggestion: null,
      note: remK < 0
        ? `Over by ${Math.abs(remK)} kcal today. One day doesn't matter — the 7-day average does. Nothing to fix.`
        : `Only ${remK} kcal left. Greek yogurt or a protein shake covers protein without much room needed.`
    };

  const by = (k) => stock.filter((f) => f.kind === k);
  const combos = [];
  const anchors = [...by('protein'), ...by('meal')];

  for (const a of anchors) {
    for (const v of [null, ...by('veg')]) {
      for (const c of [null, ...by('carb')]) {
        const parts = [a, v, c].filter(Boolean);
        if (a.kind === 'meal' && (v || c)) if (parts.length > 2) continue;
        const kcal = parts.reduce((s, p) => s + p.kcal, 0);
        const prot = parts.reduce((s, p) => s + p.protein, 0);
        const fib = parts.reduce((s, p) => s + p.fiber, 0);
        if (kcal > budget || kcal < budget * 0.45) continue;
        // Favour protein density, then fibre, then filling the budget without overshooting.
        const score = prot * 3 + fib * 1.5 - Math.abs(budget - kcal) * 0.05 + (prot >= remP * 0.5 ? 12 : 0);
        combos.push({ parts, kcal, protein: prot, fiber: fib, score });
      }
    }
  }

  combos.sort((x, y) => y.score - x.score);
  const pick = combos[0];
  if (!pick)
    return {
      remaining: { kcal: remK, protein: remP },
      suggestion: null,
      note: 'Nothing in inventory fits the remaining room. Mark more items in stock, or a protein shake covers it.'
    };

  const dessert = dessertBudget ? by('treat').filter((f) => f.kcal <= dessertBudget)[0] : null;

  return {
    remaining: { kcal: remK, protein: remP },
    suggestion: {
      items: pick.parts.map((p) => `${p.name} (${p.serving})`),
      kcal: Math.round(pick.kcal),
      protein: Math.round(pick.protein),
      fiber: Math.round(pick.fiber),
      method: pick.parts.some((p) => ['veg', 'carb'].includes(p.kind)) ? 'Ninja Crispi' : 'no-cook',
      dessert: dessert ? `${dessert.name}, ${dessert.serving} — ${dessert.kcal} kcal (portion it, don't eat from the pint)` : null
    },
    alternates: combos.slice(1, 4).map((c) => ({
      items: c.parts.map((p) => p.name),
      kcal: Math.round(c.kcal),
      protein: Math.round(c.protein)
    }))
  };
}

/* ---------------- natural-language parsing ---------------- */

async function callAI(env, system, user) {
  // Free-tier first: Cloudflare Workers AI binding, then Groq, then keyword fallback.
  try {
    if (env.AI) {
      const r = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 700
      });
      return r.response || '';
    }
  } catch (e) { /* fall through */ }
  try {
    if (env.GROQ_KEY) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: 700, temperature: 0.1
        })
      });
      const j = await r.json();
      return j.choices?.[0]?.message?.content || '';
    }
  } catch (e) { /* fall through */ }
  return '';
}

const grabJSON = (s) => {
  if (!s) return null;
  const m = s.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

// Pull macros the user stated outright. If he says "at 240 calories", that IS the number —
// no estimate, no library lookup, no multiplication. Stated beats guessed, always.
export function statedMacros(text) {
  const t = ' ' + String(text).toLowerCase() + ' ';
  const grab = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };
  return {
    kcal: grab(/(\d+(?:\.\d+)?)\s*(?:k?cals?\b|calories?\b|kcal\b)/),
    protein: grab(/(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:of\s+)?protein/),
    carbs: grab(/(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:of\s+)?(?:carbs?|carbohydrates?)/),
    fat: grab(/(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:of\s+)?fat\b/),
    fiber: grab(/(\d+(?:\.\d+)?)\s*(?:g|grams?)?\s*(?:of\s+)?fib(?:re|er)/)
  };
}

// Strip the macro clauses back out so the item is named for the food, not the numbers.
function cleanName(text) {
  return String(text)
    .replace(/\b(?:at|with|which is|that'?s|about|approx\.?|roughly)?\s*\d+(?:\.\d+)?\s*(?:k?cals?|calories?|kcal)\b/gi, '')
    .replace(/\b(?:and|with)?\s*\d+(?:\.\d+)?\s*(?:g|grams?)?\s*(?:of\s+)?(?:protein|carbs?|carbohydrates?|fat|fib(?:re|er))\b/gi, '')
    .replace(/\s*,\s*$/, '').replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
}

// Only treat a number as a quantity when it is clearly a count, never when it belongs to a macro.
function quantityOf(chunk, food) {
  const t = chunk.toLowerCase();
  const explicit = t.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*x(?:\s|$)/) || t.match(/(?:^|\s)x\s*(\d+(?:\.\d+)?)(?:\s|$)/);
  if (explicit) return Math.min(20, Math.max(0.25, parseFloat(explicit[1])));

  const words = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5 };
  const w = t.match(/(?:^|\s)(one|two|three|four|five|six|half)\s/);
  if (w) return words[w[1]];

  // A bare number counts only if it is not part of a macro phrase.
  const bare = t.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+(?!k?cals?|calories?|kcal|g\b|grams?|of\b)/);
  if (!bare) return 1;
  const n = parseFloat(bare[1]);

  // "15 fries" against a serving of "12 fries" means 1.25 servings, not 15 of them.
  const perServing = food?.serving ? parseFloat(food.serving) : NaN;
  if (perServing > 1 && n > perServing) return Math.min(20, n / perServing);
  return n > 20 ? 1 : Math.max(0.25, n);
}

export async function parseFood(env, input) {
  const known = await all(env, 'SELECT name,kcal,protein,carbs,fat,fiber,serving FROM foods LIMIT 120');
  const stated = statedMacros(input);

  // Anything he spelled out is authoritative. Log it exactly and stop.
  if (stated.kcal != null) {
    return [{
      item: cleanName(input).slice(0, 120) || input.slice(0, 120),
      kcal: stated.kcal, protein: stated.protein ?? 0, carbs: stated.carbs ?? 0,
      fat: stated.fat ?? 0, fiber: stated.fiber ?? 0, src: 'stated'
    }];
  }

  const sys =
    'You convert a spoken food log into JSON. Return ONLY a JSON array, no prose, no markdown. ' +
    'Each element: {"item":string,"kcal":number,"protein":number,"carbs":number,"fat":number,"fiber":number}. ' +
    'If the user states a calorie or macro number, use that number exactly. Otherwise estimate from the quantity described. ' +
    'Never invent large multiples — a single named product is one serving unless a count is given.\n' +
    known.map((f) => `${f.name} | ${f.serving} | ${f.kcal}kcal ${f.protein}p ${f.carbs}c ${f.fat}f ${f.fiber}fib`).join('\n');

  const parsed = grabJSON(await callAI(env, sys, input));
  if (Array.isArray(parsed) && parsed.length) {
    return parsed.map((p) => ({
      item: String(p.item || input).slice(0, 120),
      kcal: +p.kcal || 0, protein: +p.protein || 0, carbs: +p.carbs || 0,
      fat: +p.fat || 0, fiber: +p.fiber || 0, src: 'ai'
    }));
  }

  // No AI available: match against the food table, conservatively.
  const out = [];
  for (const chunk of input.split(/,| and | plus |\+/i)) {
    const c = chunk.trim();
    if (!c) continue;
    const lc = c.toLowerCase();
    const hit = known.find((f) => lc.includes(f.name.toLowerCase().split(/[,+]/)[0].trim()))
      || known.find((f) => f.name.toLowerCase().split(/[\s,]+/).some((w) => w.length > 4 && lc.includes(w)));
    if (!hit) continue;
    const q = quantityOf(c, hit);
    const r = (v) => Math.round(v * q * 10) / 10;
    out.push({
      item: `${hit.name}${q !== 1 ? ` ×${Math.round(q * 100) / 100}` : ''}`,
      kcal: r(hit.kcal), protein: r(hit.protein), carbs: r(hit.carbs),
      fat: r(hit.fat), fiber: r(hit.fiber), src: 'match'
    });
  }
  if (out.length) return out;

  // Nothing recognised. Log it at zero and flag it rather than inventing a number.
  return [{ item: input.slice(0, 120), kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, src: 'unparsed' }];
}

export async function parseWorkout(env, input) {
  const sys =
    'Convert a spoken workout log into JSON. Return ONLY a JSON array, no prose. ' +
    'Each element: {"exercise":string,"sets":number|null,"reps":number|null,"weight":number|null,"minutes":number|null,"distance":number|null,"rpe":number|null}. ' +
    'weight is pounds. distance is miles. ' +
    'Walking or a walk counts as an exercise with minutes. "200 jumping jacks in 2 sets of 100" is sets 2, reps 100.';
  const parsed = grabJSON(await callAI(env, sys, input));
  let items;
  if (Array.isArray(parsed) && parsed.length) {
    items = parsed.map((p) => ({
      exercise: String(p.exercise || 'exercise').slice(0, 80),
      sets: p.sets ?? null, reps: p.reps ?? null,
      weight: p.weight ?? null, minutes: p.minutes ?? null,
      distance: p.distance ?? null, rpe: p.rpe ?? null
    }));
  } else {
    items = null;
  }
  if (items) return await attachExercises(env, items);
  const out = [];
  for (const chunk of input.split(/,| and |\+/i)) {
    const c = chunk.trim();
    if (!c) continue;
    const n = c.match(/(\d+)/);
    const min = c.match(/(\d+)\s*(?:min|minute)/i);
    out.push({
      exercise: c.replace(/\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'exercise',
      sets: null, reps: min ? null : n ? +n[1] : null,
      weight: null, minutes: min ? +min[1] : null, distance: null, rpe: null
    });
  }
  return await attachExercises(env, out.length ? out : [{ exercise: input.slice(0, 80), sets: null, reps: null, minutes: null }]);
}

async function attachExercises(env, items) {
  const out = [];
  for (const i of items) {
    const ex = await ensureExercise(env, i.exercise);
    out.push({ ...i, exercise: ex?.name || i.exercise, exercise_id: ex?.id ?? null,
      discipline: ex?.discipline ?? null, muscle: ex?.muscle ?? null });
  }
  return out;
}

/* ---------------- the context block Claude / ChatGPT reads ---------------- */

export async function contextDoc(env) {
  const [p, t, tr, td] = await Promise.all([profile(env), currentTarget(env), trends(env), today(env)]);
  const d = decide(tr, t, Number(p.kcal_floor || 1450));
  const recent = await all(env, 'SELECT d,lb,waist FROM weights ORDER BY d DESC LIMIT 10');
  const w14 = await all(
    env,
    'SELECT d, GROUP_CONCAT(exercise) ex FROM workout_log WHERE d >= ?1 GROUP BY d ORDER BY d DESC',
    [dayStr(-14)]
  );

  return `# ${p.name}'s health context — generated ${nowStr()} (${TZ})

## Who / what this is
${p.sex}, age ${p.age}, ${p.height_cm} cm. Goal: ${p.goal}
Started ${p.start_date} at ${p.start_weight_lb} lb. Soft milestone ${p.milestone_lb} lb — not a hard endpoint. Appearance, waist and strength outrank the number.
Constraints: ${p.constraints}
Food philosophy: ${p.philosophy}

## Where things stand right now
Latest weight: ${tr.latest_weight ?? '—'} lb (${tr.latest_weight_date ?? 'no weigh-in yet'})
7-day average: ${tr.avg7 ?? '—'} lb | prior 7-day: ${tr.avg7_prev ?? '—'} lb
Weekly rate: ${tr.rate_lb_per_week ?? '—'} lb/week (negative = losing) | Total change: ${tr.total_change_lb ?? '—'} lb
Waist: ${tr.waist_in ?? 'not measured'}${tr.waist_change_in != null ? ` (${tr.waist_change_in} in over ~2 weeks)` : ''}
Steps: ${tr.steps_7day_avg ?? '—'}/day over 7 days, ${tr.steps_30day_avg ?? '—'}/day over 30
Intake last 14 days: ${tr.avg_kcal_14day ?? '—'} kcal, ${tr.avg_protein_14day ?? '—'} g protein, ${tr.avg_fiber_14day ?? '—'} g fibre across ${tr.days_logged_14} logged days
Strength sessions last 14 days: ${tr.strength_sessions_14}

## Today (${td.date})
${td.kcal} / ${t.kcal_high} kcal — ${td.kcal_remaining} left
${td.protein} / ${t.protein} g protein — ${td.protein_remaining} left
Fibre ${td.fiber} g | Steps ${td.steps ?? 'not synced'} | Workouts logged: ${td.workouts.length}
Eaten: ${td.food_items.map((i) => i.item).join('; ') || 'nothing logged yet'}

## Current plan
Calories ${t.kcal_low}–${t.kcal_high}/day. Protein ~${t.protein} g. Steps ~${t.steps}/day.
Hard floor: never go below ${p.kcal_floor} kcal/day.
Engine's read: **${d.headline}** ${d.why}

## Recent weigh-ins
${recent.map((r) => `${r.d}: ${r.lb} lb${r.waist ? `, waist ${r.waist}"` : ''}`).join('\n') || 'none'}

## Recent training
${w14.map((r) => `${r.d}: ${r.ex}`).join('\n') || 'none logged'}

## How to talk to him about this
Direct, no hype, no lecturing. Don't recommend a change unless the data supports one — "keep doing exactly what you're doing" is a real answer. Don't moralise about food. Don't push harder training if Achilles/ankle/knee/shin pain shows up; step jacks replace jumping jacks. Progress is waist down, fat down, strength up, muscle held — not just the scale.`;
}

/* ---------------- weekly check-in (brief §23) ---------------- */

export async function checkin(env) {
  const [p, t, tr] = await Promise.all([profile(env), currentTarget(env), trends(env)]);
  const d = decide(tr, t, Number(p.kcal_floor || 1450));
  const body = `Weekly check-in — ${dayStr()}

Weight now ......... ${tr.latest_weight ?? '—'} lb
7-day average ...... ${tr.avg7 ?? '—'} lb (prior week ${tr.avg7_prev ?? '—'})
Weekly rate ........ ${tr.rate_lb_per_week ?? '—'} lb/week
Since ${p.start_date} ... ${tr.total_change_lb ?? '—'} lb
Waist .............. ${tr.waist_in ?? 'not measured'}${tr.waist_change_in != null ? ` (${tr.waist_change_in} in)` : ''}
Calories ........... ${tr.avg_kcal_14day ?? '—'}/day avg vs ${t.kcal_low}–${t.kcal_high} target
Protein ............ ${tr.avg_protein_14day ?? '—'} g/day vs ${t.protein} g target
Fibre .............. ${tr.avg_fiber_14day ?? '—'} g/day
Steps .............. ${tr.steps_7day_avg ?? '—'}/day vs ${t.steps} target
Strength ........... ${tr.strength_sessions_14} sessions in 14 days

Recommendation: ${d.headline}
${d.why}`;

  await run(env, 'INSERT OR REPLACE INTO checkins (d,body) VALUES (?1,?2)', [dayStr(), body]);
  return { date: dayStr(), decision: d, trends: tr, body };
}


/* ---------------- v2: day rollup for the calendar ---------------- */

export async function dayRange(env, from, to) {
  const [w, act, food, work, wat, ph] = await Promise.all([
    all(env, 'SELECT d,lb,waist FROM weights WHERE d BETWEEN ?1 AND ?2', [from, to]),
    all(env, 'SELECT d,steps,walk_min,active_kcal,sleep_min FROM activity WHERE d BETWEEN ?1 AND ?2', [from, to]),
    all(env, 'SELECT d, ROUND(SUM(kcal)) kcal, ROUND(SUM(protein)) protein, ROUND(SUM(fiber)) fiber FROM food_log WHERE d BETWEEN ?1 AND ?2 GROUP BY d', [from, to]),
    all(env, 'SELECT d, COUNT(*) n, GROUP_CONCAT(exercise) ex FROM workout_log WHERE d BETWEEN ?1 AND ?2 GROUP BY d', [from, to]),
    all(env, 'SELECT d, ROUND(SUM(oz)) oz FROM water_log WHERE d BETWEEN ?1 AND ?2 GROUP BY d', [from, to]),
    all(env, 'SELECT d FROM photos WHERE d BETWEEN ?1 AND ?2', [from, to])
  ]);
  const days = {};
  const put = (d, patch) => { days[d] = { d, ...(days[d] || {}), ...patch }; };
  for (const r of w) put(r.d, { lb: r.lb, waist: r.waist });
  for (const r of act) put(r.d, { steps: r.steps, walk_min: r.walk_min, active_kcal: r.active_kcal, sleep_min: r.sleep_min });
  for (const r of food) put(r.d, { kcal: r.kcal, protein: r.protein, fiber: r.fiber });
  for (const r of work) put(r.d, { workouts: r.n, exercises: r.ex });
  for (const r of wat) put(r.d, { water_oz: r.oz });
  for (const r of ph) put(r.d, { photo: true });
  return Object.values(days).sort((a, b) => (a.d < b.d ? 1 : -1));
}

/* ---------------- v2: grocery list from the plan ---------------- */

export async function grocery(env) {
  const missing = await all(env,
    "SELECT name,kind FROM foods WHERE in_stock=0 AND kind IN ('protein','veg','carb') ORDER BY kind,name");
  const manual = await all(env, "SELECT id,text,done FROM todos WHERE kind='grocery' ORDER BY done,id");
  return { suggested: missing, list: manual };
}

/* ---------------- v2: calendar feed (.ics) ---------------- */
// Apple Calendar and Google Calendar can subscribe to this URL and refresh on their own.
// Reminders with alarms show up as timed events with alerts.

const icsTime = (dateStr, hhmm) => `${dateStr.replace(/-/g, '')}T${(hhmm || '09:00').replace(':', '')}00`;
const fold = (l) => (l.length <= 74 ? l : l.match(/.{1,74}/g).join('\r\n '));
const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

export async function icsFeed(env) {
  const items = await all(env, "SELECT * FROM todos WHERE done=0 AND kind IN ('reminder','todo')");
  const start = dayStr();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//supernerd//fitness-hub//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Fitness', 'X-WR-TIMEZONE:' + TZ,
    'REFRESH-INTERVAL;VALUE=DURATION:PT2H', 'X-PUBLISHED-TTL:PT2H'
  ];

  for (const t of items) {
    const day = t.due || start;
    const dt = icsTime(day, t.at);
    L.push('BEGIN:VEVENT');
    L.push(`UID:fit-${t.id}@supernerd.tv`);
    L.push(`DTSTAMP:${stamp}`);
    L.push(`DTSTART;TZID=${TZ}:${dt}`);
    L.push(`DURATION:PT15M`);
    L.push(fold(`SUMMARY:${esc(t.text)}`));
    if (t.repeat === 'daily') L.push('RRULE:FREQ=DAILY');
    else if (t.repeat === 'weekdays') L.push('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    else if (t.repeat === 'weekly') L.push('RRULE:FREQ=WEEKLY');
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(t.text)}`),
      `TRIGGER:-PT${Number(t.alarm || 0)}M`, 'END:VALARM');
    L.push('END:VEVENT');
  }

  const g = await all(env, "SELECT text FROM todos WHERE kind='grocery' AND done=0");
  if (g.length) {
    L.push('BEGIN:VEVENT', `UID:fit-grocery@supernerd.tv`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dayStr(1).replace(/-/g, '')}`,
      fold(`SUMMARY:Groceries (${g.length} items)`),
      fold(`DESCRIPTION:${esc(g.map((x) => x.text).join('\n'))}`),
      'END:VEVENT');
  }

  L.push('END:VCALENDAR');
  return L.join('\r\n');
}

/* ---------------- v3: the coach line on the hub ---------------- */
// Deterministic, not generated — it says what the data says, in his voice, and it
// stays quiet when there is nothing worth saying.

export async function coachBrief(env) {
  const [p, t, tr, td] = await Promise.all([profile(env), currentTarget(env), trends(env), today(env)]);
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }));
  const dow = new Date(td.date + 'T12:00').getDay();
  const greet = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';

  // 1 — where the body is
  let progress;
  if (tr.total_change_lb != null && Math.abs(tr.total_change_lb) >= 0.4) {
    const dir = tr.total_change_lb < 0 ? 'down' : 'up';
    const since = new Date(p.start_date + 'T12:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    progress = `You're ${dir} ${Math.abs(tr.total_change_lb)} lb since ${since}`;
    if (tr.waist_change_in != null && tr.waist_change_in <= -0.25)
      progress += `, and the waist is down ${Math.abs(tr.waist_change_in)}"`;
    else if (tr.rate_lb_per_week != null)
      progress += `, running ${Math.abs(tr.rate_lb_per_week)} lb a week`;
    progress += '.';
  } else if (tr.logged_weigh_ins < 4) {
    progress = `Day ${Math.max(1, Math.round((new Date(td.date) - new Date(p.start_date)) / 86400000) + 1)}. Still building the baseline — weigh in and the numbers start meaning something.`;
  } else {
    progress = `Scale is holding around ${tr.avg7 ?? tr.latest_weight} lb. That's not a problem yet — two weeks is the read, not two days.`;
  }

  // 2 — what today's training is
  const [sessions7, lastByMuscle] = await Promise.all([
    all(env, "SELECT DISTINCT d FROM workout_log WHERE d >= ?1 AND discipline!='running'", [dayStr(-6)]),
    all(env, 'SELECT muscle, MAX(d) last FROM workout_log WHERE muscle IS NOT NULL GROUP BY muscle')
  ]);
  const seen = Object.fromEntries(lastByMuscle.map((r) => [r.muscle, r.last]));
  const staleness = (m) => (seen[m] ? Math.round((new Date(td.date) - new Date(seen[m])) / 86400000) : 99);
  const pool = ['legs', 'glutes', 'chest', 'back', 'core'];
  const oldest = pool.sort((a, b) => staleness(b) - staleness(a))[0];
  const trainedToday = td.workouts.length > 0;

  let plan;
  if (trainedToday) {
    plan = `Today's already logged — ${td.workouts.map((w) => w.exercise).slice(0, 3).join(', ')}. Walk if you've got it in you, otherwise that's the day.`;
  } else if (sessions7.length >= 3) {
    plan = `Three strength sessions in already this week. Today can be a walk and nothing else — recovery is where the muscle actually shows up.`;
  } else if (dow === 0) {
    plan = `Sunday. Waist measurement, a photo, and an easy walk. No strength needed.`;
  } else {
    plan = `Today: ${oldest === 'core' ? 'core and a walk' : oldest + ' work'} — it's been ${staleness(oldest) > 30 ? 'a while' : staleness(oldest) + ' days'}. Two sets, add the third only if the second felt easy.`;
  }

  // 3 — what to eat, based on what is actually left
  let food;
  const remK = td.kcal_remaining, remP = td.protein_remaining;
  if (td.kcal === 0) {
    food = `Nothing logged yet. Front-load the protein — ${t.protein} g is a lot to catch up on after 6pm.`;
  } else if (remP > 55 && hour >= 15) {
    food = `You're ${Math.round(remP)} g of protein short with ${Math.round(remK)} kcal left. Lean protein and a vegetable, skip the extra carbs tonight.`;
  } else if (remK < 0) {
    food = `Over by ${Math.abs(Math.round(remK))} kcal. Nothing to fix — the week is what counts, not the day.`;
  } else if (remK < 300 && remP <= 20) {
    food = `Nearly closed out — ${Math.round(remK)} kcal left. Greek yogurt or a shake finishes it clean.`;
  } else {
    food = `${Math.round(remK)} kcal and ${Math.round(remP)} g of protein still to go. There's room for dessert if the protein lands first.`;
  }

  // 4 — one thing that still needs doing, at most
  const chase = td.alerts.find((a) => a.level === 'do') || td.alerts[0];

  return {
    greeting: `${greet}, ${p.name}.`,
    progress, plan, food,
    chase: chase ? chase.text : null,
    chase_go: chase ? chase.go : null
  };
}

/* ---------------- v3: exercise stats and history ---------------- */

const RANGES = { day: 0, week: 6, month: 29, ytd: null, all: null };

export function rangeStart(range) {
  if (range === 'ytd') return new Date().getFullYear() + '-01-01';
  if (range === 'all') return '2000-01-01';
  return dayStr(-(RANGES[range] ?? 29));
}

export async function exerciseStats(env, exerciseId, range = 'month') {
  const from = rangeStart(range);
  const ex = await one(env, 'SELECT * FROM exercises WHERE id=?1', [exerciseId]);
  if (!ex) return null;

  const rows = await all(env,
    `SELECT d, SUM(COALESCE(sets,1)*COALESCE(reps,0)) reps,
            SUM(COALESCE(sets,1)*COALESCE(reps,0)*COALESCE(weight,0)) volume,
            SUM(COALESCE(minutes,0)) minutes, SUM(COALESCE(distance,0)) distance,
            MAX(COALESCE(weight,0)) top_weight, MAX(COALESCE(reps,0)) top_reps,
            COUNT(*) entries
       FROM workout_log WHERE exercise_id=?1 AND d>=?2 GROUP BY d ORDER BY d`,
    [exerciseId, from]);

  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const prev = await all(env,
    `SELECT SUM(COALESCE(sets,1)*COALESCE(reps,0)) reps,
            SUM(COALESCE(sets,1)*COALESCE(reps,0)*COALESCE(weight,0)) volume
       FROM workout_log WHERE exercise_id=?1 AND d < ?2 AND d >= ?3`,
    [exerciseId, from, dayStr(-((RANGES[range] ?? 29) * 2 + 2))]);

  const totalReps = sum('reps');
  const prevReps = prev[0]?.reps || 0;

  return {
    exercise: ex, range, from,
    sessions: rows.length,
    total_reps: Math.round(totalReps),
    total_volume: Math.round(sum('volume')),
    total_minutes: Math.round(sum('minutes')),
    total_distance: Math.round(sum('distance') * 100) / 100,
    best_weight: Math.max(0, ...rows.map((r) => r.top_weight || 0)),
    best_reps: Math.max(0, ...rows.map((r) => r.top_reps || 0)),
    change_vs_prev: prevReps ? Math.round(((totalReps - prevReps) / prevReps) * 100) : null,
    series: rows.map((r) => ({
      d: r.d,
      value: ex.unit === 'distance' ? r.distance : ex.unit === 'time' ? r.minutes : (r.volume || r.reps),
      reps: r.reps, volume: r.volume, minutes: r.minutes, distance: r.distance
    }))
  };
}

export async function trainingOverview(env, range = 'month') {
  const from = rangeStart(range);
  const byDiscipline = await all(env,
    `SELECT discipline, COUNT(DISTINCT d) days, COUNT(*) entries,
            SUM(COALESCE(sets,1)*COALESCE(reps,0)) reps,
            SUM(COALESCE(sets,1)*COALESCE(reps,0)*COALESCE(weight,0)) volume,
            SUM(COALESCE(distance,0)) distance, SUM(COALESCE(minutes,0)) minutes
       FROM workout_log WHERE d>=?1 AND discipline IS NOT NULL GROUP BY discipline`, [from]);
  const byMuscle = await all(env,
    `SELECT muscle, COUNT(DISTINCT d) days, SUM(COALESCE(sets,1)*COALESCE(reps,0)) reps,
            MAX(d) last
       FROM workout_log WHERE d>=?1 AND muscle IS NOT NULL GROUP BY muscle ORDER BY reps DESC`, [from]);
  const top = await all(env,
    `SELECT w.exercise_id id, e.name, e.muscle, e.discipline, e.unit,
            COUNT(DISTINCT w.d) days, SUM(COALESCE(w.sets,1)*COALESCE(w.reps,0)) reps,
            SUM(COALESCE(w.sets,1)*COALESCE(w.reps,0)*COALESCE(w.weight,0)) volume, MAX(w.d) last
       FROM workout_log w JOIN exercises e ON e.id=w.exercise_id
      WHERE w.d>=?1 GROUP BY w.exercise_id ORDER BY days DESC, reps DESC LIMIT 40`, [from]);
  return { range, from, by_discipline: byDiscipline, by_muscle: byMuscle, exercises: top };
}
