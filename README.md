# supernerd.tv

Cinematic single-page site for Supernerd / Shaun Harrison.
Built with Astro. Deployed on Cloudflare Pages.

## Structure
- `src/pages/index.astro` — the whole page: pinned "scene" (hero → bio that
  settles then releases), persistent top bar + slide-down menu, contact modal,
  full-bio modal, social icons, flask brand mark, and placeholder Work/Studio
  pages. All CSS + JS are inline in this file.
- `public/hero/` — image planes: smoke, flask, person, frontsmoke, wordcrop,
  flask_mark.
- `public/` — favicons (favicon.ico, favicon-32.png, favicon.png,
  apple-touch-icon.png).

## Develop
```
npm install
npm run dev      # http://localhost:4321
npm run build    # outputs to dist/
```

## Deploy (Cloudflare Pages)
Framework preset: **Astro** · Build command: `npm run build` · Output dir: `dist`
Pushing to GitHub auto-redeploys. 

