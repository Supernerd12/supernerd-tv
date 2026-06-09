# Supernerd.tv — Self-serve content (Sveltia CMS)

You can now add and edit Work projects yourself — no code, no Claude. You fill a form,
hit save, and the site rebuilds itself. This is a one-time setup; after that it's just "log in and edit."

---

## What changed in the repo
- `src/content/work/*.json` — every project is now its own data file (the CMS edits these).
- `src/content/config.ts` — defines the project fields.
- `src/pages/index.astro` — the Work grid now builds itself from those data files.
- `public/admin/index.html` + `public/admin/config.yml` — the admin app + its form definition.
- `public/work/uploads/` — where header & storyboard images you upload will land.

Upload all of these to GitHub the usual way. Once Cloudflare finishes building, your admin lives at:

> **https://supernerd.tv/admin**

---

## One-time login setup (browser only)

### Quickest path — Personal Access Token (no extra services)
1. On GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.**
2. **Repository access:** only `Supernerd12/supernerd-tv`.
3. **Permissions:** under *Repository permissions*, set **Contents → Read and write** (Metadata stays Read). Generate, then copy the token.
4. Open **https://supernerd.tv/admin**, choose **Sign in with GitHub → use a personal access token**, paste it. Done — it remembers you on that device.

### Nicer path (optional) — "Login with GitHub" button
If you'd rather click a button than paste a token, deploy the small auth helper once:
1. In the **Cloudflare dashboard → Workers & Pages → Create → import the repo** `sveltia/sveltia-cms-auth` (or deploy it from its GitHub page — no command line needed).
2. Create a **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps). Callback URL = your Worker URL + `/callback`. Put the Client ID/Secret into the Worker's variables.
3. In `public/admin/config.yml`, uncomment the `base_url:` line and set it to your Worker URL, then push.
4. Now `/admin` shows a normal **Login with GitHub** button.

(Either way works — the token route is fine to start.)

---

## Adding or editing work
1. Go to **/admin** and open **Work — Projects.**
2. **New Project**, or click an existing one (e.g. *Hollywood Unlocked*) to edit.
3. Fill in:
   - **Project name** — the card title.
   - **Sort order** — lower numbers show first (10, 20, 30…). Leave gaps so you can slot things between later.
   - **Categories** — pick any that apply. (You can tag *Art Direction*; it just won't appear as a filter chip since everything has it.)
   - **Header image** — optional; the still shown when its clip plays.
   - **Clips** — add one row per piece. Each has a **label**, an optional **video link**, and an optional **poster**.
   - **Storyboards / stills** — optional; upload as many as you like, they show as a strip in the pop-up.
4. **Save.** It commits to GitHub and Cloudflare rebuilds — live in ~1–2 minutes (not instant, since the site is static).

## Where video comes from
Videos do **not** go in the repo (keeps it small/fast). Put them in **Cloudflare Stream**:
1. Cloudflare dashboard → **Stream** → upload the video.
2. Copy its **HLS manifest URL** (ends in `…/manifest/video.m3u8`).
3. Paste that into the clip's **Video link** field.

Leave Video link blank and the clip just plays the default reel for now — so nothing breaks before you've uploaded.

## Images
Header and storyboard images upload straight through the CMS (no Cloudflare step). They save into
`/work/uploads` and commit with the entry. Export them web-sized (long edge ~2000px, compressed) to keep the repo light.

---

## Good to know
- The CMS only edits **content** (projects, clips, images, links). Design/layout changes still come through the normal build.
- If your Cloudflare production branch isn't `main`, change `branch:` in `public/admin/config.yml`.
- The admin page is set to `noindex`, so it won't show up in Google.
