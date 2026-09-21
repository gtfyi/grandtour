import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./env";
import { getAudio } from "./ai/storage";
import { publicRouter } from "./routes/public";
import { adminRouter } from "./routes/admin";
import { creatorRouter } from "./routes/creator";
import { distributionRouter } from "./routes/distribution";
import { diagRouter } from "./routes/diag";
import { releaseRouter } from "./routes/release";

const app = new Hono();

app.use("*", logger());
// Browser access: the API is for our own admin/viewer origins; the
// distribution files and recordings are public reads that any client on any
// origin may fetch — that is what makes this a GrandTour server.
app.use("/api/*", cors({ origin: env.allowedOrigins() }));
app.use("/grandtour.json", cors({ origin: "*" }));
app.use("/tours/*", cors({ origin: "*" }));
app.use("/uploads/*", cors({ origin: "*" }));

app.get("/health", (c) => c.json({ ok: true, service: "grandtour" }));

// Public API consumed by the iOS app.
app.route("/api", publicRouter);

// The distribution protocol (grandtour.json + tours/*.grandtour.json): this
// server is a GrandTour server like any static host.
app.route("/", distributionRouter);

// Admin API consumed by the web admin. Bearer-token auth lives in the router.
app.route("/api/admin", adminRouter);

// Creator API: the phone's walk-and-record mode. Unauthenticated — the
// server is assumed private for now (see routes/creator.ts).
app.route("/api/creator", creatorRouter);

// The publisher's release console — what GrandTour publishes. Not part of
// the generic admin: it exists only where RELEASE_CONSOLE=true.
if (env.releaseConsole()) app.route("/release", releaseRouter);

// Field diagnostics from the iOS app. Unauthenticated, so it is mounted
// only when DIAG_ENABLED=true (a dev server you control); otherwise 404.
if (env.diagEnabled()) {
  app.route("/api/diag", diagRouter);
  console.log("[diag] /api/diag/logs enabled (DIAG_ENABLED=true)");
}

// Serve stored audio uploads with HTTP Range support (needed for iOS
// AVPlayer seeking and large files). Reads from the local ./uploads dir, or
// from S3/R2 when STORAGE_* is configured.
app.on(["GET", "HEAD"], "/uploads/*", async (c) => {
  let key: string;
  try {
    key = decodeURIComponent(c.req.path.slice("/uploads/".length));
  } catch {
    return c.notFound(); // malformed percent-encoding
  }
  // Keys are pipeline-generated: letters/digits and _ - . / only, no dot-dot.
  if (!key || key.includes("..") || !/^[\w\-./]+$/.test(key)) return c.notFound();

  const obj = await getAudio(key);
  if (!obj) return c.notFound();

  const baseHeaders: Record<string, string> = {
    "Content-Type": obj.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  const range = parseRange(c.req.header("Range"), obj.size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${obj.size}` },
    });
  }

  const isHead = c.req.method === "HEAD";

  if (range) {
    const length = range.end - range.start + 1;
    // For HEAD, send no body but advertise the slice length explicitly.
    const body = isHead ? null : ((await obj.bytes(range)) as BodyInit);
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${obj.size}`,
        "Content-Length": String(length),
      },
    });
  }

  const body = isHead ? null : ((await obj.bytes()) as BodyInit);
  return new Response(body, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(obj.size) },
  });
});

/**
 * Parse a single-range HTTP `Range` header against a known content size.
 * Returns the resolved inclusive byte range, null when there's no usable
 * range (serve the whole entity), or "unsatisfiable" for a 416.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // Multi-range / malformed: fall back to full body.

  const [, startStr, endStr] = match;
  let start: number;
  let end: number;

  if (startStr === "") {
    // Suffix range: last N bytes.
    if (endStr === "") return null;
    const suffix = Number(endStr);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  }

  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

const port = env.port();
console.log(`GrandTour server on http://localhost:${port}`);

// Start explicitly instead of exporting a server config. Bun 1.3.12 can
// attempt to bind an exported config twice when launched with `--hot`, which
// leaves the dev process alive but the API unavailable after a restart.
// A bundle for a large track can take a few seconds to assemble under
// concurrent first requests; Bun's default 10 s idle timeout would drop the
// connection mid-build with an empty response.
const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });

// Keep the Hono app as the default export for the in-process test suite. It
// has no `port` field, so Bun will not try to auto-start a second listener.
export default app;
