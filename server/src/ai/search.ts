import { env } from "../env";

/** A normalized source the narration script can draw on. */
export interface SourceDoc {
  title: string;
  url: string;
  text: string;
}

/** A human-readable place for a coordinate, used to anchor search + script. */
export interface PlaceContext {
  /** Best single-line label, e.g. "Blue Hill, Maine, United States". */
  label: string;
  /** Street-level address when the geocoder has one. */
  formattedAddress?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
}

/**
 * Reverse-geocode a coordinate to a place name via Geocodio. Returns null if
 * no key is configured or the lookup fails (callers fall back to coords only).
 *
 * https://www.geocod.io/docs/#reverse-geocoding
 */
export async function reverseGeocode(lat: number, lng: number): Promise<PlaceContext | null> {
  const key = env.geocodioKey();
  if (!key) return null;

  const url = new URL("https://api.geocod.io/v1.7/reverse");
  url.search = new URLSearchParams({ q: `${lat},${lng}`, api_key: key }).toString();

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{
        formatted_address?: string;
        address_components?: {
          city?: string;
          county?: string;
          state?: string;
          country?: string;
        };
      }>;
    };
    const top = data.results?.[0];
    if (!top) return null;
    const c = top.address_components ?? {};
    const label =
      [c.city, c.state, c.country].filter(Boolean).join(", ") ||
      top.formatted_address ||
      `${lat}, ${lng}`;
    return {
      label,
      formattedAddress: top.formatted_address,
      city: c.city,
      county: c.county,
      state: c.state,
      country: c.country,
    };
  } catch {
    return null;
  }
}

// ─── Identify: name the entity at a coordinate ───────────────────────────────

export interface PlaceCandidate {
  title: string;
  source: "wikipedia" | "geocodio";
  url?: string;
  distanceM?: number;
}

/**
 * Figure out what a freshly-dropped spot IS: reverse-geocode the address and
 * list named entities near the coordinate (Wikipedia GeoSearch), nearest
 * first. Used by the admin to auto-fill a new spot's title. Both channels are
 * best-effort — with no Geocodio key or no Wikipedia coverage you get less,
 * never an error.
 */
export async function identifyPlace(
  lat: number,
  lng: number,
  opts: { radiusM?: number; limit?: number } = {},
): Promise<{ address: string | null; candidates: PlaceCandidate[] }> {
  const radius = Math.min(opts.radiusM ?? 300, 10_000);
  const limit = Math.min(opts.limit ?? 6, 20);

  const geoUrl = new URL("https://en.wikipedia.org/w/api.php");
  geoUrl.search = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${lat}|${lng}`,
    gsradius: String(radius),
    gslimit: String(limit),
    format: "json",
    origin: "*",
  }).toString();

  const [place, geoRes] = await Promise.all([
    reverseGeocode(lat, lng),
    fetch(geoUrl, { headers: { "user-agent": "GrandTour/0.1" } }).catch(() => null),
  ]);

  const candidates: PlaceCandidate[] = [];
  if (geoRes?.ok) {
    const geo = (await geoRes.json()) as {
      query?: { geosearch?: Array<{ pageid: number; title: string; dist?: number }> };
    };
    for (const p of geo.query?.geosearch ?? []) {
      candidates.push({
        title: p.title,
        source: "wikipedia",
        url: `https://en.wikipedia.org/?curid=${p.pageid}`,
        distanceM: p.dist,
      });
    }
  }

  return { address: place?.formattedAddress ?? place?.label ?? null, candidates };
}

/**
 * exa.ai search — find pages about a place. We use exa's `/search` with
 * `contents` to get text in one round-trip. Bias the query toward the spot.
 *
 * https://docs.exa.ai/reference/search
 */
export async function exaSearch(
  query: string,
  opts: { numResults?: number } = {},
): Promise<SourceDoc[]> {
  const key = env.exaKey();
  if (!key) return [];

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: opts.numResults ?? 6,
      contents: { text: { maxCharacters: 2000 } },
    }),
  });
  if (!res.ok) {
    throw new Error(`exa search failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    results: Array<{ title?: string; url: string; text?: string }>;
  };
  return data.results.map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    text: r.text ?? "",
  }));
}

/**
 * Wikipedia: find the nearest article(s) to a coordinate via the GeoSearch API,
 * then fetch plain-text extracts. No API key required.
 */
export async function wikipediaNearby(
  lat: number,
  lng: number,
  opts: { limit?: number; radiusM?: number } = {},
): Promise<SourceDoc[]> {
  const limit = opts.limit ?? 3;
  const radius = Math.min(opts.radiusM ?? 1000, 10_000);

  const geoUrl = new URL("https://en.wikipedia.org/w/api.php");
  geoUrl.search = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${lat}|${lng}`,
    gsradius: String(radius),
    gslimit: String(limit),
    format: "json",
    origin: "*",
  }).toString();

  const geoRes = await fetch(geoUrl, { headers: { "user-agent": "GrandTour/0.1" } });
  if (!geoRes.ok) return [];
  const geo = (await geoRes.json()) as {
    query?: { geosearch?: Array<{ pageid: number; title: string }> };
  };
  const pages = geo.query?.geosearch ?? [];
  if (pages.length === 0) return [];

  const extractUrl = new URL("https://en.wikipedia.org/w/api.php");
  extractUrl.search = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    exintro: "1",
    pageids: pages.map((p) => p.pageid).join("|"),
    format: "json",
    origin: "*",
  }).toString();

  const exRes = await fetch(extractUrl, { headers: { "user-agent": "GrandTour/0.1" } });
  if (!exRes.ok) return [];
  const ex = (await exRes.json()) as {
    query?: { pages?: Record<string, { title: string; extract?: string }> };
  };
  const byId = ex.query?.pages ?? {};

  return pages.map((p) => ({
    title: p.title,
    url: `https://en.wikipedia.org/?curid=${p.pageid}`,
    text: byId[String(p.pageid)]?.extract ?? "",
  }));
}
