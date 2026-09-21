/**
 * Recordings this server stores locally are minted against `localhost` at
 * generation time (`putAudio`'s dev fallback). Serve them from whatever host
 * a request actually arrived at — a tailnet address, a LAN IP, a proxy — so
 * no client ever has to rewrite a URL. Any `audioUrl` whose path starts with
 * `/uploads/` is ours; every other URL (a bucket, a park service) is left
 * exactly as written.
 */
export function rehostRef(origin: string): (ref: string) => string {
  return (ref) => {
    try {
      const u = new URL(ref);
      if (u.pathname.startsWith("/uploads/")) return `${origin}${u.pathname}${u.search}`;
    } catch { /* not a URL: leave it */ }
    return ref;
  };
}

/** Deep form for the small API responses (nearby, fill-in items): every `audioUrl` anywhere in the value. */
export function rehostUploads<T>(value: T, origin: string): T {
  const one = rehostRef(origin);
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (key === "audioUrl" && typeof v === "string") return one(v);
    return v;
  };
  return walk(value) as T;
}

/** The origin a request arrived at, honouring the host it was addressed to. */
export function originOf(c: { req: { url: string } }): string {
  return new URL(c.req.url).origin;
}
