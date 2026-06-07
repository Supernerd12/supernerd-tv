# supernerd.tv

Astro site. The cinematic hero is ported in `src/components/Hero.astro`; assets live in `public/hero/`.

## Run it locally
1. Install Node.js 18+ (https://nodejs.org)
2. In this folder:
   ```
   npm install
   npm run dev
   ```
3. Open the printed localhost URL. Resize the window to see the fluid scaling; on a phone, tap to enter and tilt for parallax.

## Push to your GitHub
```
git init
git add .
git commit -m "Hero ported to Astro"
git branch -M main
git remote add origin https://github.com/<you>/supernerd-tv.git
git push -u origin main
```

## Whats next (later phases)
- Sanity Studio (visual admin) + a Project schema
- Branded projects grid + project detail pages reading from Sanity
- Cloudflare Stream for video, Cloudflare Pages for hosting, GoDaddy DNS -> live
