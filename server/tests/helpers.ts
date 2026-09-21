/**
 * Test-DB utilities. Requires `docker compose up -d db` and a migrated
 * `grandtour_test` database:
 *
 *   docker compose exec db psql -U postgres -c 'CREATE DATABASE grandtour_test'
 *   cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun run db/migrate.ts
 *
 * tests/preload.ts points the app's own pool at the same database.
 */
import postgres from "postgres";

export const TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/grandtour_test";

export const adminHeaders = {
  Authorization: "Bearer test-token",
  "content-type": "application/json",
};

/** Throws unless the URL's database name ends in `_test` (protects dev data). */
export function assertTestDb(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to touch non-test database "${dbName}"`);
  }
}

// Dedicated client for seeding/reset — hard-wired to the test database so it
// can never touch dev data regardless of env mishaps.
assertTestDb(TEST_DATABASE_URL);
export const testSql = postgres(TEST_DATABASE_URL, {
  max: 4,
  transform: { undefined: null },
});

export async function resetDb(): Promise<void> {
  assertTestDb(TEST_DATABASE_URL);
  await testSql`TRUNCATE creator_uploads, fillin_items, content_pieces, spots, guides, tracks CASCADE`;
}

let seq = 0;

export async function makeTrack(
  over: Partial<{
    slug: string;
    name: string;
    official: boolean;
    kind: string;
    lifecycle: string;
  }> = {},
): Promise<{ id: string; slug: string }> {
  const slug = over.slug ?? `track-${++seq}`;
  const [row] = await testSql`
    INSERT INTO tracks (slug, name, official, kind, lifecycle)
    VALUES (${slug}, ${over.name ?? `Track ${seq}`}, ${over.official ?? false},
            ${over.kind ?? "tour"}, ${over.lifecycle ?? "evergreen"})
    RETURNING id, slug
  `;
  return { id: row!.id, slug: row!.slug };
}

export async function makeFillInItem(
  trackId: string,
  over: Partial<{
    word: string;
    status: string;
    order: number | null;
    audioUrl: string | null;
  }> = {},
): Promise<{ id: string }> {
  const n = ++seq;
  const word = over.word ?? `word${n}`;
  const payload = {
    word,
    senses: [
      { definition: `definition of ${word}`, exampleSentence: `A sentence using ${word}.` },
    ],
    source: { title: "Test list", url: "https://example.com/vocab" },
  };
  const [row] = await testSql`
    INSERT INTO fillin_items (track_id, module_type, payload, sort_order, status, audio_url)
    VALUES (
      ${trackId}, 'vocab', ${testSql.json(payload as never)},
      ${over.order ?? null}, ${over.status ?? "published"}, ${over.audioUrl ?? null}
    )
    RETURNING id
  `;
  return { id: row!.id };
}

/** A `quiz`-module fill-in item (geography-style question/answers). */
export async function makeQuizFillInItem(
  trackId: string,
  over: Partial<{ question: string; status: string }> = {},
): Promise<{ id: string }> {
  const n = ++seq;
  const payload = {
    category: "Geography",
    question: over.question ?? `Quiz question ${n}`,
    answers: [`Answer ${n}A`, `Answer ${n}B`],
    source: { title: "Wikidata", url: "https://query.wikidata.org/" },
  };
  const [row] = await testSql`
    INSERT INTO fillin_items (track_id, module_type, payload, status)
    VALUES (${trackId}, 'quiz', ${testSql.json(payload as never)}, ${over.status ?? "published"})
    RETURNING id
  `;
  return { id: row!.id };
}

/** Default center is near the Brooklyn Bridge (matches the README curl). */
export async function makeSpot(
  trackId: string,
  over: Partial<{
    title: string;
    lat: number;
    lng: number;
    radiusM: number;
    regionWkt: string | null;
    triggerKind: string;
    sequence: { key: string; index: number } | null;
    modes: string[];
    locating: object;
    status: string;
  }> = {},
): Promise<{ id: string }> {
  const lat = over.lat ?? 40.70611;
  const lng = over.lng ?? -73.99653;
  const n = ++seq;
  const [row] = await testSql`
    INSERT INTO spots (track_id, slug, title, trigger_kind, center, radius_m, region,
                       sequence_key, sequence_index, modes, locating, status)
    VALUES (
      ${trackId}, ${`spot-${n}`}, ${over.title ?? `Spot ${n}`},
      ${over.triggerKind ?? "point"},
      ${`SRID=4326;POINT(${lng} ${lat})`}::geography,
      ${over.radiusM ?? 100},
      ${over.regionWkt ?? null}::geography,
      ${over.sequence?.key ?? null}, ${over.sequence?.index ?? null},
      ${over.modes ?? []},
      ${testSql.json((over.locating ?? { mode: "auto", clips: {} }) as never)},
      ${over.status ?? "published"}
    )
    RETURNING id
  `;
  return { id: row!.id };
}

export async function makeContent(
  spotId: string,
  over: Partial<{ locale: string; variant: string; status: string; audioUrl: string | null }> = {},
): Promise<{ id: string }> {
  const [row] = await testSql`
    INSERT INTO content_pieces (spot_id, locale, variant, source, status, audio_url)
    VALUES (
      ${spotId}, ${over.locale ?? "en"}, ${over.variant ?? "default"},
      'human', ${over.status ?? "published"}, ${over.audioUrl ?? null}
    )
    RETURNING id
  `;
  return { id: row!.id };
}
