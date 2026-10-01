// Supabase Edge Function: stream-dl
// Purpose: Cloudflare Stream MP4 downloads must be ENABLED per video before the
//   /downloads/default.mp4 URL exists — until then it's a real 404 (the bug).
//   This enables the download (idempotent), waits until it's ready, and returns
//   the direct MP4 URL for the browser to download.
//
// One-time setup (Supabase → Edge Functions):
//   1. Create a function named exactly:  stream-dl
//   2. Paste this file as its code and Deploy.
//   3. Set "Verify JWT" = OFF (same as your dynamic-processor function).
//   4. Add two secrets (Project Settings → Edge Functions → Secrets):
//        CF_ACCOUNT_ID   = your Cloudflare account ID
//        CF_STREAM_TOKEN = a Cloudflare API token with  Stream : Edit
//        (Cloudflare dash → My Profile → API Tokens → Create → Stream:Edit,
//         or an account-scoped token that includes Stream Edit.)
//
// After that, every current AND future video download works with no per-video steps.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { uid } = await req.json().catch(() => ({}));
    if (!uid || typeof uid !== "string") return json({ error: "missing uid" }, 400);

    const acct = Deno.env.get("CF_ACCOUNT_ID");
    const tok = Deno.env.get("CF_STREAM_TOKEN");
    if (!acct || !tok) return json({ error: "server not configured (CF_ACCOUNT_ID / CF_STREAM_TOKEN)" }, 500);

    const base = `https://api.cloudflare.com/client/v4/accounts/${acct}/stream/${uid}/downloads`;
    const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

    // Create the download. Idempotent: if it already exists CF returns the existing one.
    let r = await fetch(base, { method: "POST", headers });
    let d = await r.json().catch(() => ({} as any));

    // Poll until the MP4 is rendered.
    for (let i = 0; i < 8; i++) {
      const def = d?.result?.default;
      const url = def?.url;
      const status = def?.status;
      const pct = def?.percentComplete;
      if (url && (status === "ready" || pct === 100)) return json({ url });
      await new Promise((res) => setTimeout(res, 1500));
      r = await fetch(base, { method: "GET", headers });
      d = await r.json().catch(() => ({} as any));
    }

    const url = d?.result?.default?.url;
    if (url) return json({ url, notReady: true }); // still rendering; URL will resolve shortly
    return json({ error: "download is still being prepared — try again in a minute" }, 202);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
