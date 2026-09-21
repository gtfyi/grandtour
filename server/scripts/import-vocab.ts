/**
 * Import vocab fill-in items from a word-list JSON into a fill-in track.
 *
 *   bun run scripts/import-vocab.ts [path]
 *
 * Defaults to scripts/data/sat-vocabulary.words.json. Idempotent by word:
 * an item whose payload word already exists in the track is skipped, so the
 * list can be re-run after edits. Follow with prepare-fillins.ts to give the
 * new items text-only documents and publish them.
 */
import { z } from "zod";
import { isVocabPayload } from "@grandtour/shared";
import { sql } from "../src/db";
import { createFillInItem, listFillInItems, listTracks } from "../src/content/repo";

const WordList = z.object({
  track: z.string(),
  source: z.object({ title: z.string(), url: z.string().url() }),
  words: z.array(
    z.object({
      word: z.string().min(1),
      pronunciation: z.string().optional(),
      partOfSpeech: z.string().optional(),
      definition: z.string().min(1),
      exampleSentence: z.string().min(1),
    }),
  ),
});

const path =
  process.argv[2] ?? new URL("./data/sat-vocabulary.words.json", import.meta.url).pathname;
const parsed = WordList.safeParse(await Bun.file(path).json());
if (!parsed.success) {
  console.error("Word list failed validation:", parsed.error.message);
  process.exit(1);
}
const list = parsed.data;

const track = (await listTracks(sql)).find((t) => t.slug === list.track && t.kind === "fillin");
if (!track) {
  console.error(`No fill-in track with slug "${list.track}"`);
  process.exit(1);
}

const existing = new Set(
  (await listFillInItems(sql, track.id))
    .map((i) => i.payload)
    .filter(isVocabPayload)
    .map((p) => p.word.toLowerCase()),
);
let created = 0;
for (const [i, w] of list.words.entries()) {
  if (existing.has(w.word.toLowerCase())) {
    console.log(`  = "${w.word}" already exists, skipped`);
    continue;
  }
  await createFillInItem(sql, {
    trackId: track.id,
    moduleType: "vocab",
    payload: {
      word: w.word,
      ...(w.pronunciation ? { pronunciation: w.pronunciation } : {}),
      senses: [
        {
          ...(w.partOfSpeech ? { partOfSpeech: w.partOfSpeech } : {}),
          definition: w.definition,
          exampleSentence: w.exampleSentence,
        },
      ],
      source: list.source,
    },
    order: i,
  });
  created++;
  console.log(`  + "${w.word}"`);
}
console.log(`done: ${created} created`);
await sql.end();
