/**
 * The recordings about to play, fetched ahead of time so a start — a tap on
 * Next, the car reaching a stop — is instant. A recording the server lets
 * this origin read (the data bucket does) is kept as a blob and played from
 * memory; one it does not (a third party's file) is fetched opaquely, which
 * still leaves it in the browser's cache. The phone's `TourCache` does the
 * same on disk.
 */
export class AudioPrefetch {
  /** Recording URL → its object URL, or null when it could only be warmed. */
  private readonly ready = new Map<string, string | null>();
  private readonly pending = new Set<string>();
  private readonly order: string[] = [];
  /** Origins that refused a readable fetch once: asked opaquely from then on, one console error per host, not per file. */
  private readonly opaqueOrigins = new Set<string>();

  constructor(
    private readonly limit = 6,
    private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {}

  /** Fetch what is not already here. Nulls and repeats are ignored. */
  warm(urls: Array<string | null | undefined>): void {
    for (const url of urls) {
      if (!url || this.ready.has(url) || this.pending.has(url)) continue;
      this.pending.add(url);
      void this.load(url);
    }
  }

  private async load(url: string): Promise<void> {
    let object: string | null = null;
    const origin = originOf(url);
    try {
      if (origin && this.opaqueOrigins.has(origin)) throw new Error("opaque origin");
      const res = await this.fetcher(url);
      if (res.ok && res.type !== "opaque") object = URL.createObjectURL(await res.blob());
    } catch {
      // Not readable from this origin: an opaque fetch still fills the HTTP cache.
      if (origin) this.opaqueOrigins.add(origin);
      try { await this.fetcher(url, { mode: "no-cors" }); } catch { /* unreachable: nothing to keep */ }
    }
    this.pending.delete(url);
    this.ready.set(url, object);
    this.order.push(url);
    while (this.order.length > this.limit) {
      const old = this.order.shift()!;
      const stale = this.ready.get(old);
      if (stale) URL.revokeObjectURL(stale);
      this.ready.delete(old);
    }
  }

  /** The warmed copy of a recording when it is ready, else the recording itself. */
  resolve(url: string): string {
    return this.ready.get(url) ?? url;
  }

  has(url: string): boolean {
    return this.ready.has(url);
  }
}

function originOf(url: string): string | null {
  try { return new URL(url, "http://localhost").origin; } catch { return null; }
}
