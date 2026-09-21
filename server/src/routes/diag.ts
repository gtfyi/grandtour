import { Hono } from "hono";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Diagnostics sink for the iOS app.
 *
 * The tour runs in the field with the phone in a pocket — there is no console
 * to watch, and by the time a missed trigger is noticed the moment has passed.
 * The app batches structured events and POSTs them here; they land in
 * `diag/tour-<date>.jsonl` for `bun run diag` to replay.
 *
 * Deliberately unauthenticated and dev-only: it accepts anything, so it is
 * mounted only when DIAG_ENABLED=true (see index.ts) and must not be exposed
 * publicly. Events are treated as opaque data and never interpreted as
 * instructions.
 */
export const diagRouter = new Hono();

const DIAG_DIR = join(process.cwd(), "diag");
/** Reject absurd payloads rather than filling the disk. */
const MAX_EVENTS = 500;
const MAX_BYTES = 1_000_000;
/** Per-day ceiling across all requests, so a runaway client can't fill the disk. */
const MAX_BYTES_PER_DAY = 50_000_000;
let dayBytes = { day: "", bytes: 0 };

diagRouter.post("/logs", async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return c.json({ error: "no_events" }, 400);
  }
  if (events.length > MAX_EVENTS) {
    return c.json({ error: "too_many_events" }, 413);
  }

  const receivedAt = new Date().toISOString();
  const day = receivedAt.slice(0, 10);
  const lines = events
    .map((e) => JSON.stringify({ receivedAt, ...(e as object) }))
    .join("\n");

  if (dayBytes.day !== day) dayBytes = { day, bytes: 0 };
  if (dayBytes.bytes + lines.length > MAX_BYTES_PER_DAY) {
    return c.json({ error: "daily_quota_exceeded" }, 429);
  }
  dayBytes.bytes += lines.length;

  await mkdir(DIAG_DIR, { recursive: true });
  await appendFile(join(DIAG_DIR, `tour-${day}.jsonl`), lines + "\n", "utf8");

  console.log(`[diag] +${events.length} events`);
  return c.json({ ok: true, accepted: events.length });
});
