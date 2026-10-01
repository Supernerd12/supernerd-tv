// Supabase Edge Function: send-email
// Sends transactional / newsletter email via Resend.
// The browser NEVER sees the Resend key — it lives in a function secret.
//
// Secrets this function needs (Dashboard → Edge Functions → Secrets):
//   RESEND_API_KEY = <your Resend key>            (keep it here, never in chat/repo)
//   FROM_EMAIL     = Supernerd Studio <studio@supernerd.tv>   (must be on your VERIFIED domain)
// SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Supernerd Studio <studio@supernerd.tv>";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const OWNER_EMAILS = ["hello@supernerd.tv", "shaun@supernerd.tv"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    // 1) Who is sending?
    //    - the scheduled-email dispatcher (pg_cron) proves itself with DISPATCH_SECRET
    //    - otherwise a signed-in portal member; non-owners may only email portal people
    const body = await req.json().catch(() => ({}));
    let to = body.to;
    if (typeof to === "string") to = [to];
    let bcc = body.bcc;
    if (typeof bcc === "string") bcc = [bcc];
    let cc = body.cc;
    if (typeof cc === "string") cc = [cc];

    const dispatchSecret = Deno.env.get("DISPATCH_SECRET") || "";
    const isDispatcher = !!dispatchSecret && req.headers.get("x-dispatch-secret") === dispatchSecret;
    let sentBy = "scheduler";
    if (!isDispatcher) {
      const authHeader = req.headers.get("Authorization") || "";
      if (!authHeader) return json({ error: "Not signed in" }, 401);
      const sb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data: { user }, error: uErr } = await sb.auth.getUser();
      if (uErr || !user) return json({ error: "Invalid session" }, 401);
      const me = (user.email || "").toLowerCase();
      sentBy = me;
      if (!OWNER_EMAILS.includes(me)) {
        const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
        const { data: inv } = await admin.from("invites").select("email").eq("review_slug", "studio");
        const allowed = new Set([...OWNER_EMAILS, ...((inv || []).map((r: { email: string }) => String(r.email || "").toLowerCase()))]);
        if (!allowed.has(me)) return json({ error: "Not a portal member" }, 403);
        const all = [...(Array.isArray(to) ? to : []), ...(Array.isArray(bcc) ? bcc : []), ...(Array.isArray(cc) ? cc : [])]
          .map((e) => String(e).toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1").trim()).filter(Boolean);
        const outsider = all.find((e) => !allowed.has(e));
        if (outsider) return json({ error: "Partners can only email people on the portal" }, 403);
      }
    }

    const subject = String(body.subject || "").slice(0, 250);
    const html = String(body.html || "");
    if (!subject || !html) return json({ error: "Missing subject or html" }, 400);

    // Newsletter mode: hide the recipient list — send to FROM, BCC everyone.
    const recipients = (Array.isArray(to) && to.length) ? to : [FROM_EMAIL];

    const payload: Record<string, unknown> = { from: FROM_EMAIL, to: recipients, subject, html };
    if (Array.isArray(bcc) && bcc.length) payload.bcc = bcc;
    if (Array.isArray(cc) && cc.length) payload.cc = cc;
    if (body.replyTo) payload.reply_to = body.replyTo;

    // 3) Send via Resend
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: out?.message || "Resend rejected the send", detail: out }, 502);
    return json({ ok: true, id: out?.id || null, sentBy });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
