/**
 * One-command dev runner: `bun run dev`
 *
 * Brings up the whole stack and keeps it hot-reloading:
 *   1. PostGIS (docker compose) — started if not already running, waited until healthy
 *   2. migrations applied
 *   3. API server   (bun --hot, reloads on server/ changes)   → :8787
 *   4. Admin web    (vite,      reloads on admin/ changes)     → :5180
 *   5. Web app      (vite,      the phone app in a browser)   → :5190
 *
 * Output from each process is prefixed and color-coded. Ctrl-C stops the
 * watchers (the DB container is left running so the next start is instant).
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  db: "\x1b[35m", // magenta
  server: "\x1b[36m", // cyan
  admin: "\x1b[32m", // green
  viewer: "\x1b[34m", // blue
  err: "\x1b[31m",
};

function log(label: keyof typeof C, msg: string) {
  const tag = `${C[label]}[${label}]${C.reset}`;
  for (const line of msg.split("\n")) console.log(`${tag} ${line}`);
}

function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

// ── 1. Database ──────────────────────────────────────────────────────────────

function dbRunning(): boolean {
  const r = sh("docker", ["inspect", "--format", "{{.State.Health.Status}}", "grandtour-db-1"]);
  return r.code === 0 && r.out.trim() === "healthy";
}

async function ensureDatabase() {
  if (dbRunning()) {
    log("db", "already healthy");
    return;
  }
  log("db", "starting PostGIS via docker compose…");
  const up = sh("docker", ["compose", "up", "-d", "db"]);
  if (up.code !== 0) {
    log("err", "failed to start the database. Is Docker/OrbStack running?");
    log("err", up.out.trim());
    process.exit(1);
  }
  // Wait for healthy.
  for (let i = 0; i < 40; i++) {
    if (dbRunning()) {
      log("db", "healthy");
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  log("err", "database did not become healthy in time");
  process.exit(1);
}

function migrate() {
  log("db", "applying migrations…");
  const r = sh("bun", ["--env-file=.env", "run", "server/db/migrate.ts"]);
  // Surface only the meaningful lines (skip the verbose NOTICE objects).
  const lines = r.out.split("\n").filter((l) => /apply|skip|up to date|error/i.test(l));
  for (const l of lines) log("db", l.trim());
  if (r.code !== 0) {
    log("err", "migrations failed");
    process.exit(1);
  }
}

// ── 2. Watchers ──────────────────────────────────────────────────────────────

function startWatcher(label: "server" | "admin" | "viewer", cmd: string, args: string[], cwd: string) {
  const child = spawn(cmd, args, { cwd, env: process.env });
  const pipe = (data: Buffer) => {
    const text = data.toString().trimEnd();
    if (text) log(label, text);
  };
  child.stdout.on("data", pipe);
  child.stderr.on("data", pipe);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      log("err", `${label} exited (code ${code}). Stopping.`);
      shutdown(1);
    }
  });
  return child;
}

let shuttingDown = false;
let children: ReturnType<typeof spawn>[] = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("db", `${C.dim}stopping watchers (DB container left running)${C.reset}`);
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── main ─────────────────────────────────────────────────────────────────────

await ensureDatabase();
migrate();

log("server", "starting on http://localhost:8787 (hot reload)");
children.push(
  startWatcher(
    "server",
    "bun",
    ["--env-file=../.env", "--hot", "src/index.ts"],
    resolve(ROOT, "server"),
  ),
);

log("admin", "starting on http://localhost:5180 (hot reload)");
children.push(
  startWatcher("admin", "bun", ["run", "dev"], resolve(ROOT, "admin")),
);

log("viewer", "starting on http://localhost:5190 (hot reload)");
children.push(
  startWatcher("viewer", "bun", ["run", "dev"], resolve(ROOT, "packages/tour-viewer")),
);

log("db", `${C.dim}stack up — press Ctrl-C to stop${C.reset}`);
