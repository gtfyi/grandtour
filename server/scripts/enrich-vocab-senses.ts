/**
 * Migrate vocab payloads to the multi-sense shape and enrich them from
 * WordNet 3.1 (the corpus's cited source).
 *
 *   bun run scripts/enrich-vocab-senses.ts [--dry-run]
 *
 * For every vocab fill-in item:
 *   1. Old flat payloads ({definition, exampleSentence, partOfSpeech}) are
 *      wrapped as senses[0]. The curated sense always stays first.
 *   2. WordNet's first sense of each other part of speech is appended when
 *      its definition is genuinely different — first-of-POS keeps it to
 *      meanings worth knowing, not the long tail. Example sentences come
 *      from the gloss's quoted examples when present. Cap: 3 senses total.
 *
 * Idempotent: already-migrated payloads keep their curated sense and are
 * re-enriched only if they still lack WordNet senses. Run
 * prepare-fillins.ts --rebuild afterwards to regenerate documents.
 *
 * WordNet dict files are downloaded to scripts/data/wordnet/ (gitignored)
 * on first run.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { VocabPayload, type VocabSense } from "@grandtour/shared";
import { sql } from "../src/db";

const DRY = process.argv.includes("--dry-run");
const WN_DIR = new URL("./data/wordnet/dict", import.meta.url).pathname;
const WN_URL = "https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz";
const MAX_SENSES = 3;

// ─── WordNet ────────────────────────────────────────────────────────────────

const POS_FILES = [
  ["noun", "n"],
  ["verb", "v"],
  ["adj", "a"],
  ["adv", "r"],
] as const;

const POS_NAME: Record<string, string> = {
  n: "noun",
  v: "verb",
  a: "adjective",
  s: "adjective",
  r: "adverb",
};

async function ensureWordNet(): Promise<void> {
  if (await Bun.file(join(WN_DIR, "index.noun")).exists()) return;
  console.log(`downloading WordNet 3.1 dict → ${WN_DIR}`);
  const parent = join(WN_DIR, "..");
  await mkdir(parent, { recursive: true });
  const res = await fetch(WN_URL);
  if (!res.ok) throw new Error(`WordNet download failed: ${res.status}`);
  const tar = join(parent, "wn3.1.dict.tar.gz");
  await Bun.write(tar, await res.arrayBuffer());
  const untar = Bun.spawnSync(["tar", "xzf", tar, "-C", parent]);
  if (untar.exitCode !== 0) throw new Error("untar failed");
}

interface WnSense {
  pos: string; // human name
  definition: string;
  exampleSentence?: string;
}

/** lemma → first sense per part of speech, in noun/verb/adj/adv order. */
async function loadWordNet(): Promise<Map<string, WnSense[]>> {
  const byLemma = new Map<string, WnSense[]>();
  for (const [file, posCode] of POS_FILES) {
    const data = await Bun.file(join(WN_DIR, `data.${file}`)).text();
    const glossByOffset = new Map<string, string>();
    for (const line of data.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const bar = line.indexOf("| ");
      if (bar < 0) continue;
      glossByOffset.set(line.slice(0, 8), line.slice(bar + 2).trim());
    }
    const index = await Bun.file(join(WN_DIR, `index.${file}`)).text();
    for (const line of index.split("\n")) {
      if (!line || line.startsWith(" ")) continue;
      const parts = line.split(" ").filter(Boolean);
      const lemma = parts[0]!;
      // First listed offset is WordNet's most frequent sense for this POS.
      const firstOffset = parts.at(-Number(parts[2]))!;
      const gloss = glossByOffset.get(firstOffset);
      if (!gloss) continue;
      const sense = parseGloss(gloss, POS_NAME[posCode]!);
      const list = byLemma.get(lemma) ?? [];
      list.push(sense);
      byLemma.set(lemma, list);
    }
  }
  return byLemma;
}

/** WordNet gloss: `definition; "example"; "example 2"` (examples optional). */
function parseGloss(gloss: string, pos: string): WnSense {
  const parts = gloss.split(";").map((s) => s.trim());
  const definition = parts[0]!;
  const quoted = parts.slice(1).find((p) => /^".*"$/.test(p));
  const sense: WnSense = { pos, definition };
  if (quoted) {
    // Gloss examples are lowercase fragments; sentence-case for narration.
    const ex = quoted.slice(1, -1);
    sense.exampleSentence = ex.charAt(0).toUpperCase() + ex.slice(1);
  }
  return sense;
}

// ─── Enrichment ─────────────────────────────────────────────────────────────

/** Word-overlap similarity — filters WordNet senses that restate the curated one. */
function similar(a: string, b: string): boolean {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const ta = tok(a);
  const tb = tok(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.5;
}

interface OldPayload {
  word: string;
  pronunciation?: string;
  partOfSpeech?: string;
  definition: string;
  exampleSentence: string;
  source: { title: string; url: string };
}

const wn = await (async () => {
  await ensureWordNet();
  return loadWordNet();
})();
console.log(`WordNet lemmas loaded: ${wn.size}`);

const rows = await sql<{ id: string; payload: unknown }[]>`
  SELECT id, payload FROM fillin_items WHERE module_type = 'vocab'
`;
console.log(`vocab items: ${rows.length}`);

let migrated = 0;
let enriched = 0;
for (const row of rows) {
  const p = row.payload as Record<string, unknown>;
  // Normalize to the senses shape (migrating old flat payloads in passing).
  const curated: VocabSense[] = Array.isArray(p.senses)
    ? (p.senses as VocabSense[])
    : [
        {
          ...((p as unknown as OldPayload).partOfSpeech
            ? { partOfSpeech: (p as unknown as OldPayload).partOfSpeech }
            : {}),
          definition: (p as unknown as OldPayload).definition,
          exampleSentence: (p as unknown as OldPayload).exampleSentence,
        },
      ];
  const wasFlat = !Array.isArray(p.senses);

  const word = String(p.word);
  const lemma = word.toLowerCase().replace(/ /g, "_");
  const candidates = wn.get(lemma) ?? [];
  const senses: VocabSense[] = [...curated];
  for (const c of candidates) {
    if (senses.length >= MAX_SENSES) break;
    if (senses.some((s) => similar(s.definition, c.definition))) continue;
    senses.push({
      partOfSpeech: c.pos,
      definition: c.definition,
      ...(c.exampleSentence ? { exampleSentence: c.exampleSentence } : {}),
    });
  }

  const grew = senses.length > curated.length;
  if (!wasFlat && !grew) continue;

  const next = VocabPayload.parse({
    word,
    ...(p.pronunciation ? { pronunciation: p.pronunciation } : {}),
    senses,
    source: p.source,
  });
  if (wasFlat) migrated++;
  if (grew) enriched++;
  if (!DRY) {
    await sql`
      UPDATE fillin_items
      SET payload = ${sql.json(next)}, updated_at = now()
      WHERE id = ${row.id}
    `;
  }
}

console.log(
  `${DRY ? "[dry-run] " : ""}migrated ${migrated} flat payloads, enriched ${enriched} with extra senses`,
);
await sql.end();
