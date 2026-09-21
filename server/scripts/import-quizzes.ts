/**
 * Import quiz fill-in items from a quiz-list JSON into a fill-in track.
 *
 *   bun run scripts/import-quizzes.ts [path]
 *
 * Defaults to scripts/data/geography.quizzes.json (built by
 * build-geoquiz.ts). Creates the fill-in track if it doesn't exist yet.
 * Idempotent by question: an item whose payload question already exists in
 * the track is skipped, so the list can be re-built and re-run. Follow with
 * prepare-fillins.ts to give the new items text-only documents and publish
 * them.
 */
import { z } from "zod";
import { isQuizPayload } from "@grandtour/shared";
import { sql } from "../src/db";
import { createFillInItem, createTrack, listFillInItems, listTracks } from "../src/content/repo";

const QuizList = z.object({
  track: z.string().regex(/^[a-z0-9-]+$/),
  trackName: z.string().min(1),
  category: z.string().min(1),
  source: z.object({ title: z.string(), url: z.string().url() }),
  quizzes: z
    .array(
      z.object({
        question: z.string().min(1),
        answers: z.array(z.string().min(1)).min(1).max(10),
        note: z.string().optional(),
      }),
    )
    .min(1),
});

const path =
  process.argv[2] ?? new URL("./data/geography.quizzes.json", import.meta.url).pathname;
const parsed = QuizList.safeParse(await Bun.file(path).json());
if (!parsed.success) {
  console.error("Quiz list failed validation:", parsed.error.message);
  process.exit(1);
}
const list = parsed.data;

let track = (await listTracks(sql)).find((t) => t.slug === list.track && t.kind === "fillin");
if (!track) {
  track = await createTrack(sql, {
    slug: list.track,
    name: list.trackName,
    description: `${list.category} quizzes for quiet stretches — questions built from ${list.source.title}.`,
    kind: "fillin",
    icon: "globe.americas.fill",
    official: true,
  });
  console.log(`created fill-in track "${track.slug}"`);
}

const existing = new Set(
  (await listFillInItems(sql, track.id))
    .map((i) => i.payload)
    .filter(isQuizPayload)
    .map((p) => p.question.toLowerCase()),
);
let created = 0;
let skipped = 0;
for (const [i, q] of list.quizzes.entries()) {
  if (existing.has(q.question.toLowerCase())) {
    skipped++;
    continue;
  }
  await createFillInItem(sql, {
    trackId: track.id,
    moduleType: "quiz",
    payload: {
      category: list.category,
      question: q.question,
      answers: q.answers,
      ...(q.note ? { note: q.note } : {}),
      source: list.source,
    },
    order: i,
  });
  created++;
}
console.log(`done: ${created} created, ${skipped} already existed`);
await sql.end();
