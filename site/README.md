# grandtour.fyi

The landing site — and a GrandTour server: it serves the published
`grandtour.json` and `tours/*.grandtour.json` next to the web player, so
`grandtour.fyi` is the address every app reads by default.

- `content/en.md` — all the copy (frontmatter strings, `## <section>` bodies,
  `demo_track`: the slug the phone frame drives as a simulated trip).
- `public/` — stylesheet.
- `src/build.ts` — the whole build: page → `dist/index.html`; the web app
  build → `dist/app/` (the phone frame embeds `/app/?simulate=<demo_track>`);
  the content checkout named by
  `SITE_CONTENT_DIR` (default `../../content`, the public repository) →
  `dist/grandtour.json` + `dist/tours/` through `publicIndex`, so held tracks
  never ship even when previewing from `../../content-private`.

From the repo root: `bun run dev:site` (:5181, rebuilds on edit),
`bun run site:build`, `bun run site:deploy` (wrangler, reading the root
`.env`). No audio lives here; bundles name their recordings by absolute URL.

GitHub Actions (`.github/workflows/deploy.yml`) builds and tests the site on
pull requests and pushes to `main`. Every merge or push to `main` in
`gtfyi/grandtour` then deploys to `grandtour.fyi` and `www.grandtour.fyi`.
The workflow checks out the public `gtfyi/content` repository, requires its
index to exist, and points bundles at `https://data.grandtour.fyi/tours`.
Track and audio publishing remains the separate `content:publish` command.

Deployment uses the repository's GitHub Actions secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; no `.env` file is needed
in CI. Pull requests only build and test. To redeploy `main` manually, run
the **Deploy site** workflow from GitHub's Actions tab. Deployments run one
at a time so an older upload cannot finish after a newer one.
