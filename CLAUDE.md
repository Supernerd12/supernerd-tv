# supernerd.tv — project guide for Claude Code

This one repo hosts THREE separate products under the Supernerd umbrella. They
share a domain and a deploy, but they are independent. A change to one must never
alter or break the others. Read this before editing anything.

## Deploy
- Repo: Supernerd12/supernerd-tv, branch `main`. Host: Cloudflare Pages.
- Every push to `main` auto-deploys (~90s). There is no staging. main IS production.
- Build/test command: `npm install` once, then `npm run build`. A good build ends
  with "3 page(s) built". If it doesn't say that, DO NOT COMMIT.
- Cloudflare Pages limits: max ~20,000 files per deploy, 25 MiB per file.

## The three products (treat as separate entities)

### 1. Main portfolio site — supernerd.tv
- Pages: `src/pages/index.astro` and the rest of `src/pages/` (except `r/`).
- Content: `src/content/work/` (portfolio projects).
- Public assets and IMAGES: `public/` (images live in `public/work/uploads/`,
  `public/collab/`, etc.). This is the most fragile area — see the hard rule below.

### 2. Client review portal — supernerd.tv/r/studio/
- Single file: `src/pages/r/[slug].astro` (large, self-contained; ~v54).
- Data it reads: content collections `src/content/reviews/` (companies),
  `src/content/reviewProjects/` (projects), `src/content/reviewItems/`
  (deliverables). CMS at supernerd.tv/admin (Sveltia) writes these.
- Model: `/r/studio/` is the HUB. Every company shows there; admin sees all;
  a logged-in client sees only companies they've been granted (deny-by-default).
  Companies are NOT separate URLs. Do not reintroduce per-company /r/ pages.
- Backend: Supabase (comments, approvals, tasks, activity, access) + a
  `stream-dl` Edge Function for video downloads. Runtime is Supabase, not files.
- Onboarding (v55+): admin "Add company" / "Add project" in /r/studio/ calls the
  `portal-onboard` Edge Function (source: `supabase/functions/portal-onboard/`),
  which commits the same review JSON files Sveltia writes (+ logo in
  `public/work/uploads/`) straight to main. So the portal itself commits — always
  `git pull` first. Deploy the function with
  `supabase functions deploy portal-onboard --project-ref wvtokocjhtpjrkojxaia`.
- Standing rule: bump the footer version `const VERSION = 'vN'` on every change
  to this file, and say the new number.

### 3. Personal fitness app (private, hidden) — supernerd.tv/fit/
- Frontend: `public/fit/`. Backend: `functions/api/[[path]].js` (+ `functions/`),
  and `/mcp`. Data: Cloudflare D1. This is Shaun's private tool, not client-facing.
- `public/_headers` marks `/fit/*`, `/api/*`, `/mcp` as no-cache. Keep those rules.

## HARD RULES (a past incident deleted the whole site's images)
- NEVER replace a whole top-level folder (`public/` or `functions/`) wholesale.
  A "replace public/" once wiped the portfolio images, the admin CMS, and
  `_redirects`. Only ever add/edit the specific files or subfolder that change.
- A change scoped to one product must touch ONLY that product's paths above.
  Fitness work touches `public/fit/` and `functions/` only. Portal work touches
  `src/pages/r/[slug].astro`, `src/content/review*` and `supabase/functions/` only. Portfolio work
  touches `src/pages/`, `src/content/work/`, and specific files in `public/`.
- Never delete files outside the product you're working on. If a change seems to
  require touching another product's files, STOP and ask first.
- Before every commit: run `npm run build`, confirm "3 page(s) built", and review
  `git status` / `git diff --stat` to confirm only the intended product's files
  changed. If unrelated files show as modified or deleted, do not commit.

## Workflow
1. `git pull` first (the CMS and other sessions also commit).
2. Make the change in the correct product's paths only.
3. `npm run build` and verify.
4. `git add` only the intended files, commit with a clear message, `git push`.
5. State what changed and which product it touched.
