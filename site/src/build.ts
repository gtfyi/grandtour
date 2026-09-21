/**
 * grandtour.fyi — a static site that is also a GrandTour server.
 *
 * The build is a function of three inputs:
 *
 *   content/<lang>.md            the page copy, one file per language
 *   packages/tour-viewer/dist    the web app, placed at /app/ — the page's phone frame embeds it too
 *   SITE_CONTENT_DIR             a checkout of the published content — gtfyi/content by default —
 *                                whose grandtour.json and tours/ are copied through `publicIndex`
 *   SITE_BUNDLE_BASE_URL         when set, the index names each bundle at <base>/<file> instead of
 *                                copying it: the deploy points at the data bucket, where
 *                                content:publish --upload put them, because Workers static assets
 *                                stop at 25 MiB per file and a topic track's bundle is past that
 *
 * and writes dist/, which `wrangler deploy` ships as Workers static assets.
 * No audio lives here: bundles name their recordings by absolute URL, so the
 * same files serve from localhost, a tailnet host and grandtour.fyi.
 *
 *   bun run build                                          dist/ (builds the web app first)
 *   bun run dev                                            build, serve on :5181 (PORT), rebuild on change
 *   SITE_CONTENT_DIR=../../content-private bun run build   preview from the private repo (held tracks still dropped)
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { INDEX_FILE, Index, TOURS_DIR, buildIndex, publicIndex, type IndexTrack } from "@grandtour/shared";

const ROOT = join(import.meta.dir, "..");
const CONTENT_DIR = join(ROOT, "content");
const PUBLIC_DIR = join(ROOT, "public");
const DIST_DIR = join(ROOT, "dist");
const VIEWER_DIR = join(ROOT, "..", "packages", "tour-viewer");
const VIEWER_DIST = join(VIEWER_DIR, "dist");
const VIEWER_APP_STATIC = join(VIEWER_DIR, "public", "app");
const CONTENT_SRC = resolve(ROOT, process.env.SITE_CONTENT_DIR ?? "../../content");
const BUNDLE_BASE = (process.env.SITE_BUNDLE_BASE_URL ?? "").replace(/\/+$/, "");
const BASE_URL = "https://grandtour.fyi";
const DEFAULT_LOCALE = "en";
const SECTION_ORDER = ["hero", "demo", "what", "create", "opensource"];
const args = process.argv.slice(2);

// ─── Page copy ───────────────────────────────────────────────────────────────

interface LocaleContent {
  locale: string;
  name: string;
  dir: "ltr" | "rtl";
  /** The track the phone frame drives as a simulated trip, by slug. */
  demoTrack: string | null;
  sections: Record<string, string>;
  strings: Record<string, string>;
}

function flatten(obj: unknown, prefix: string, out: Record<string, string>) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = String(obj);
  }
}

/** `## <id>` headings split the body into sections rendered as-is. */
function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(/^## ([a-z0-9-]+)\s*$/m);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i]!] = marked.parse(parts[i + 1]!.trim(), { async: false });
  return sections;
}

async function loadLocales(): Promise<LocaleContent[]> {
  const files = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith(".md")).sort();
  const locales: LocaleContent[] = [];
  for (const file of files) {
    const { data, content } = matter(await Bun.file(join(CONTENT_DIR, file)).text());
    if (!data.locale || !data.name) throw new Error(`${file}: frontmatter needs at least "locale" and "name"`);
    const strings: Record<string, string> = {};
    flatten({ meta: data.meta, strings: data.strings }, "", strings);
    locales.push({
      locale: data.locale,
      name: data.name,
      dir: data.dir === "rtl" ? "rtl" : "ltr",
      demoTrack: typeof data.demo_track === "string" ? data.demo_track : null,
      sections: splitSections(content),
      strings,
    });
  }
  locales.sort((a, b) => (a.locale === DEFAULT_LOCALE ? -1 : b.locale === DEFAULT_LOCALE ? 1 : 0));
  if (locales[0]?.locale !== DEFAULT_LOCALE) throw new Error(`content/${DEFAULT_LOCALE}.md is required (it is the fallback)`);
  return locales;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const localePath = (locale: string) => (locale === DEFAULT_LOCALE ? "/" : `/${locale}/`);

// ─── The player and the content ──────────────────────────────────────────────

/** The web app at /app/: the package's build with its assets under /app/assets/, plus the manifest and icons. */
async function copyApp(dist: string) {
  const index = Bun.file(join(VIEWER_DIST, "index.html"));
  if (!(await index.exists())) throw new Error(`no web app build at ${VIEWER_DIST} — run \`bun run build\` in packages/tour-viewer`);
  await mkdir(join(dist, "app"), { recursive: true });
  await cp(join(VIEWER_DIST, "assets"), join(dist, "app", "assets"), { recursive: true });
  await Bun.write(join(dist, "app", "index.html"), (await index.text()).replaceAll('="/assets/', '="/app/assets/'));
  for (const name of await readdir(VIEWER_APP_STATIC)) await cp(join(VIEWER_APP_STATIC, name), join(dist, "app", name));
}

/** The published tracks: the content checkout's index through `publicIndex`, and every bundle it names. */
async function copyContent(dist: string): Promise<IndexTrack[]> {
  const source = Bun.file(join(CONTENT_SRC, INDEX_FILE));
  await mkdir(join(dist, TOURS_DIR), { recursive: true });
  if (!(await source.exists())) {
    console.warn(`[content] no ${INDEX_FILE} in ${CONTENT_SRC}; the site ships an empty track list (set SITE_CONTENT_DIR)`);
    await Bun.write(join(dist, INDEX_FILE), `${JSON.stringify(buildIndex([], { name: "GrandTour" }), null, 2)}\n`);
    return [];
  }
  const index = publicIndex(Index.parse(await source.json()));
  for (const track of index.tracks) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(track.url)) continue; // hosted elsewhere: the app resolves it
    if (BUNDLE_BASE) {
      // The file must exist in the checkout (publish uploaded that same file); the site only names it.
      if (!(await Bun.file(join(CONTENT_SRC, track.url)).exists())) throw new Error(`[content] ${track.slug}: ${track.url} is missing from ${CONTENT_SRC}`);
      track.url = `${BUNDLE_BASE}/${track.url.split("/").pop()}`;
      continue;
    }
    const from = join(CONTENT_SRC, track.url);
    if (!(await Bun.file(from).exists())) throw new Error(`[content] ${track.slug}: ${track.url} is missing from ${CONTENT_SRC}`);
    await mkdir(join(dist, track.url, ".."), { recursive: true });
    await cp(from, join(dist, track.url));
  }
  await Bun.write(join(dist, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
  console.log(BUNDLE_BASE ? `[content] bundles named at ${BUNDLE_BASE}/` : `[content] bundles copied into dist/${TOURS_DIR}/`);
  return index.tracks;
}

/** Any origin may read the index and the bundles: that is what makes the site a server. */
async function writeHeaders(dist: string) {
  await Bun.write(join(dist, "_headers"), [
    `/${INDEX_FILE}`, "  Access-Control-Allow-Origin: *", "  Cache-Control: public, max-age=300",
    `/${TOURS_DIR}/*`, "  Access-Control-Allow-Origin: *", "  Cache-Control: public, max-age=300",
    "",
  ].join("\n"));
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function renderPage(loc: LocaleContent, all: LocaleContent[], demo: IndexTrack | null): string {
  const en = all[0]!;
  const t = (key: string) => loc.strings[key] ?? en.strings[key] ?? key;
  const sections = { ...en.sections, ...loc.sections };
  const alternates = all.map((l) => `<link rel="alternate" hreflang="${l.locale}" href="${BASE_URL}${localePath(l.locale)}">`).join("\n  ");
  const picker = all.length > 1
    ? `<label class="lang"><select id="lang-picker" aria-label="Language" onchange="location.href=this.value">${
      all.map((l) => `<option value="${localePath(l.locale)}"${l.locale === loc.locale ? " selected" : ""}>${esc(l.name)}</option>`).join("")
    }</select></label>`
    : "";
  // The phone frame is the app itself; with a demo track it drives that track's route as a simulated trip.
  // The same address is the page's Open App link, and `{{frame}}` in the copy.
  const frameSrc = `/app/${demo ? `?simulate=${encodeURIComponent(demo.slug)}` : ""}`;
  const frame = `<iframe title="${esc(demo?.name ?? t("meta.title"))}" src="${frameSrc}" allow="autoplay; geolocation"></iframe>`;
  const main = SECTION_ORDER.filter((id) => sections[id]).map((id) => `<section id="${id}">${sections[id]}</section>`).join("\n")
    .replaceAll("{{frame}}", frameSrc).replaceAll("%7B%7Bframe%7D%7D", frameSrc);

  return `<!doctype html>
<html lang="${loc.locale}" dir="${loc.dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t("meta.title"))}</title>
  <meta name="description" content="${esc(t("meta.description"))}">
  <link rel="canonical" href="${BASE_URL}${localePath(loc.locale)}">
  ${alternates}
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='none' stroke='black' stroke-width='2' stroke-dasharray='4 3'/%3E%3Ccircle cx='16' cy='16' r='5' fill='black'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <span class="wordmark">${esc(t("meta.title"))}</span>
    <nav>
      <a class="app-link" href="${frameSrc}">${esc(t("strings.nav.app"))}</a>
      <a href="https://github.com/gtfyi/grandtour">${esc(t("strings.nav.source"))}</a>
      ${picker}
    </nav>
  </header>
  <main class="landing-layout">
    <div class="copy-column">
${main}
    </div>
    <aside class="viewer-column" aria-label="${esc(t("meta.title"))}">
      <div class="phone-frame">${frame}</div>
    </aside>
  </main>
  <footer>
    <p>${esc(t("strings.footer.copyright"))}</p>
  </footer>
</body>
</html>
`;
}

// ─── Build ───────────────────────────────────────────────────────────────────

function buildViewer() {
  if (args.includes("--no-viewer")) return;
  const r = Bun.spawnSync(["bun", "run", "build"], { cwd: VIEWER_DIR, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`web app build failed:\n${r.stderr.toString()}`);
}

async function build() {
  const locales = await loadLocales();
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await cp(PUBLIC_DIR, DIST_DIR, { recursive: true });
  await copyApp(DIST_DIR);
  const tracks = await copyContent(DIST_DIR);
  await writeHeaders(DIST_DIR);
  for (const loc of locales) {
    const demo = loc.demoTrack ? tracks.find((t) => t.slug === loc.demoTrack) ?? null : null;
    if (loc.demoTrack && !demo) console.warn(`[demo] ${loc.locale}: track "${loc.demoTrack}" is not in the published content; the frame shows the app with no trip to drive`);
    const outDir = loc.locale === DEFAULT_LOCALE ? DIST_DIR : join(DIST_DIR, loc.locale);
    await mkdir(outDir, { recursive: true });
    await Bun.write(join(outDir, "index.html"), renderPage(loc, locales, demo));
  }
  const title = locales[0]!.strings["meta.title"] ?? "GrandTour";
  await Bun.write(join(DIST_DIR, "404.html"),
    `<!doctype html><html lang="${DEFAULT_LOCALE}"><head><meta charset="utf-8"><title>404 · ${esc(title)}</title><link rel="stylesheet" href="/style.css"></head><body><main><section><h1>404</h1><p><a href="/">${esc(title)}</a></p></section></main></body></html>`);
  console.log(`built ${locales.map((l) => l.locale).join(", ")} → dist/: ${tracks.length} track(s) from ${CONTENT_SRC}`);
}

buildViewer();
await build();

// ─── Serve (development) ─────────────────────────────────────────────────────

if (args.includes("--serve")) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const rebuild = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => build().catch((e) => console.error("[rebuild failed]", e instanceof Error ? e.message : e)), 150);
  };
  for (const dir of [CONTENT_DIR, PUBLIC_DIR, join(ROOT, "src")]) watch(dir, { recursive: true }, rebuild);
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", json: "application/json",
    webmanifest: "application/manifest+json", png: "image/png", svg: "image/svg+xml", map: "application/json",
  };
  const port = Number(process.env.PORT || 5181);
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith("/")) path += "index.html";
      const headers: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
      for (const candidate of [join(DIST_DIR, path), join(DIST_DIR, path, "index.html")]) {
        try {
          if ((await stat(candidate)).isFile()) {
            const ext = candidate.split(".").pop() ?? "";
            return new Response(Bun.file(candidate), { headers: { ...headers, "Content-Type": types[ext] ?? "application/octet-stream" } });
          }
        } catch { /* try the next candidate */ }
      }
      return new Response(Bun.file(join(DIST_DIR, "404.html")), { status: 404, headers });
    },
  });
  console.log(`serving dist/ at http://localhost:${port}`);
}
