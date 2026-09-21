import { Hono } from "hono";
import { env } from "../env";
import { sql } from "../db";

/**
 * The maintainer's release console — what GrandTour publishes, as opposed
 * to the generic admin, which is authoring for any server. Mounted at
 * `/release` only when `RELEASE_CONSOLE=true`, so the open-source admin
 * stays generic and this page exists only on the publisher's server.
 *
 * One screen: every track with what would ship (published, voiced spots),
 * its release gate (`tracks.visibility` + `hold_reason`), and the hold /
 * release action, which is the existing `PATCH /api/admin/tracks/:id/visibility`.
 * The gate is the only thing it changes; editorial status stays in the
 * admin. The page needs the admin token for its calls (kept in this
 * origin's localStorage). Export, publish and deploy remain the commands
 * shown at the bottom — they touch repositories and the bucket, and a
 * button should not.
 */
export const releaseRouter = new Hono();

function authorized(header: string | undefined): boolean {
  const token = env.adminToken();
  return !!token && header === `Bearer ${token}`;
}

releaseRouter.get("/tracks", async (c) => {
  if (!authorized(c.req.header("Authorization"))) return c.json({ error: "unauthorized" }, 401);
  const rows = await sql`
    SELECT t.id, t.slug, t.name, t.kind, t.lifecycle, t.visibility, t.hold_reason, t.held_at,
      count(s.id) FILTER (WHERE s.status = 'published') AS published,
      count(s.id) FILTER (WHERE s.status <> 'published') AS drafts,
      count(s.id) FILTER (WHERE s.status = 'published' AND EXISTS (
        SELECT 1 FROM content_pieces c WHERE c.spot_id = s.id AND c.status = 'published' AND c.audio_url IS NOT NULL)) AS voiced,
      coalesce(sum((SELECT max(c.duration_ms) FROM content_pieces c
        WHERE c.spot_id = s.id AND c.status = 'published' AND c.audio_url IS NOT NULL)) FILTER (WHERE s.status = 'published'), 0) AS duration_ms,
      (SELECT count(*) FROM fillin_items f WHERE f.track_id = t.id AND f.status = 'published') AS items
    FROM tracks t LEFT JOIN spots s ON s.track_id = t.id
    GROUP BY t.id
    ORDER BY t.visibility, t.kind, t.name
  `;
  return c.json({
    tracks: rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, kind: r.kind, lifecycle: r.lifecycle,
      visibility: r.visibility, holdReason: r.hold_reason ?? null, heldAt: r.held_at ?? null,
      published: Number(r.published), drafts: Number(r.drafts), voiced: Number(r.voiced),
      minutes: Math.round(Number(r.duration_ms) / 60000), items: Number(r.items),
    })),
  });
});

releaseRouter.get("/", (c) => c.html(PAGE));

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrandTour · Release</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
  body { margin: 0; padding: 24px; max-width: 1100px; margin-inline: auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 28px 0 8px; }
  .muted { opacity: .65; } .warn { color: #b3261e; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
  th { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; }
  .public { background: #d8f0dd; color: #14532d; } .private { background: #fde2e1; color: #7f1d1d; } .none { background: #e5e7eb; color: #374151; }
  button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, currentColor 30%, transparent); background: transparent; cursor: pointer; }
  button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  input { font: inherit; padding: 4px 8px; width: 28em; }
  pre { background: color-mix(in srgb, currentColor 6%, transparent); padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  .reason { display: block; font-size: 12px; opacity: .75; max-width: 42em; }
</style>
<h1>Release</h1>
<p class="muted">What GrandTour publishes. A track ships when it is <b>public</b> and has voiced, published spots; holding it withholds the whole track from every public surface without touching its spots. Editorial work stays in the admin.</p>
<p><label>Admin token <input id="token" type="password" placeholder="ADMIN_TOKEN"></label> <button id="load">Load</button> <span id="status" class="muted"></span></p>
<table id="tracks" hidden>
  <thead><tr><th>Track</th><th>Kind</th><th class="num">Published</th><th class="num">Voiced</th><th class="num">Drafts</th><th class="num">Minutes</th><th>Gate</th><th></th></tr></thead>
  <tbody></tbody>
</table>
<h2>Then</h2>
<pre>cd server
bun run content:export --out ../../content-private --extra scripts/data/going-to-the-sun-road.grandtour.json --prune --stamp
cd ../../content-private && git add -A && git commit -m "Export" && git push
cd ../grandtour/server
bun run content:publish --from ../../content-private --to ../../content --site ../site/static --upload
cd ../../content && git add -A && git commit -m "Publish" && git push
cd ../grandtour && bun run site:deploy</pre>
<p class="muted">Export writes every track to the private repository (held ones marked private). Publish copies only public tracks to the public repository and the site, and uploads their recordings. Live preview of what a server would serve right now: <a href="/grandtour.json">/grandtour.json</a>.</p>
<script>
const $ = (s) => document.querySelector(s);
const tokenInput = $("#token"); const statusEl = $("#status"); const table = $("#tracks"); const tbody = table.querySelector("tbody");
try { tokenInput.value = localStorage.getItem("grandtour_release_token") || ""; } catch {}
const headers = () => ({ "Authorization": "Bearer " + tokenInput.value.trim(), "Content-Type": "application/json" });
async function load() {
  try { localStorage.setItem("grandtour_release_token", tokenInput.value.trim()); } catch {}
  statusEl.textContent = "Loading…"; statusEl.className = "muted";
  const res = await fetch("/release/tracks", { headers: headers() });
  if (!res.ok) { statusEl.textContent = res.status === 401 ? "Wrong token." : "Failed: " + res.status; statusEl.className = "warn"; table.hidden = true; return; }
  const { tracks } = await res.json();
  render(tracks);
  const shipping = tracks.filter((t) => t.visibility === "public" && t.kind === "tour" && t.voiced > 0);
  statusEl.textContent = shipping.length + " of " + tracks.length + " tracks ship: " + shipping.reduce((n, t) => n + t.voiced, 0) + " voiced spots, " + shipping.reduce((n, t) => n + t.minutes, 0) + " minutes.";
}
function render(tracks) {
  tbody.replaceChildren(...tracks.map((t) => {
    const tr = document.createElement("tr");
    const ships = t.visibility === "public" && t.kind === "tour" && t.voiced > 0;
    const gate = t.visibility === "public" ? (ships ? '<span class="pill public">public · ships</span>' : '<span class="pill none">public · nothing to ship</span>')
      : '<span class="pill private">held</span><span class="reason">' + escape(t.holdReason || "") + '</span>';
    const unvoiced = t.published - t.voiced;
    tr.innerHTML = "<td><b>" + escape(t.name) + "</b><br><span class=muted>" + escape(t.slug) + "</span></td>"
      + "<td>" + t.kind + "<br><span class=muted>" + t.lifecycle + "</span></td>"
      + "<td class=num>" + (t.kind === "fillin" ? t.items + " items" : t.published) + "</td>"
      + "<td class=num>" + (t.kind === "fillin" ? "" : t.voiced + (unvoiced > 0 ? ' <span class=warn title="published spots without a recording; they never ship">(' + unvoiced + ' silent)</span>' : "")) + "</td>"
      + "<td class=num>" + t.drafts + "</td><td class=num>" + t.minutes + "</td><td>" + gate + "</td><td></td>";
    const cell = tr.lastElementChild; const btn = document.createElement("button");
    btn.textContent = t.visibility === "public" ? "Hold…" : "Release";
    btn.onclick = () => toggle(t);
    cell.append(btn);
    return tr;
  }));
  table.hidden = false;
}
async function toggle(t) {
  let body;
  if (t.visibility === "public") {
    const reason = prompt("Hold \\"" + t.name + "\\" — why? (recorded on the track, required)");
    if (!reason || !reason.trim()) return;
    body = { visibility: "private", holdReason: reason.trim() };
  } else {
    if (!confirm("Release \\"" + t.name + "\\"? It joins the public index at the next export.")) return;
    body = { visibility: "public" };
  }
  const res = await fetch("/api/admin/tracks/" + t.id + "/visibility", { method: "PATCH", headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) { const err = await res.json().catch(() => ({})); alert("Failed: " + (err.detail || err.error || res.status)); return; }
  load();
}
function escape(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
$("#load").onclick = load; tokenInput.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
if (tokenInput.value) load();
</script>
`;
