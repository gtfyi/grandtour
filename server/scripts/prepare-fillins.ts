/**
 * Make every fill-in item playable and published.
 *
 *   bun run scripts/prepare-fillins.ts [--draft] [--rebuild]
 *
 * Items without narration get a text-only filo document built from the same
 * deterministic module script the TTS route uses (buildVocabScript /
 * buildQuizScript) — the
 * on-device voice speaks it until audio is generated in the admin panel.
 * Items that already have content are left alone; everything is then set to
 * published (or draft with --draft) so the public /fillin-items list serves
 * more than one word.
 *
 * --rebuild regenerates the text-only document for every item WITHOUT
 * recorded audio (after a payload or script-builder change). Items with
 * audio keep their document so the transcript matches the recording;
 * regenerate their audio in the admin to pick up the new script.
 */
import { FiloDocument, annotateSentences, annotateWords } from "filo";
import { TIER, fillInItemTitle, isQuizPayload, type FiloDocumentJson } from "@grandtour/shared";
import { sql } from "../src/db";
import { listFillInItems, listTracks, setFillInItemContent, setFillInItemStatus } from "../src/content/repo";
import { buildVocabScript, DEFAULT_PAUSE_SECONDS } from "../src/ai/fillin/vocab";
import { buildQuizScript, DEFAULT_QUIZ_PAUSE_SECONDS } from "../src/ai/fillin/quiz";

const status = process.argv.includes("--draft") ? "draft" : "published";
const rebuild = process.argv.includes("--rebuild");

const tracks = (await listTracks(sql)).filter((t) => t.kind === "fillin");
if (tracks.length === 0) {
  console.log("no fill-in tracks");
  await sql.end();
  process.exit(0);
}

let documented = 0;
let statusChanged = 0;

for (const track of tracks) {
  const items = await listFillInItems(sql, track.id);
  console.log(`track "${track.slug}": ${items.length} items`);
  for (const item of items) {
    const needsDoc = !item.content?.document && !item.content?.audioUrl;
    const staleDoc = rebuild && !item.content?.audioUrl;
    if (needsDoc || staleDoc) {
      // Text-only script; the audible pause is baked in at TTS time, so the
      // display text's "…" is the best a spoken-text rendering can do.
      const script = isQuizPayload(item.payload)
        ? buildQuizScript(item.payload, DEFAULT_QUIZ_PAUSE_SECONDS)
        : buildVocabScript(item.payload, DEFAULT_PAUSE_SECONDS);
      const doc = FiloDocument.fromText(script.displayText, { metadata: { locale: "en" } });
      annotateWords(doc, { tierId: TIER.words, language: "en" });
      annotateSentences(doc, { tierId: TIER.sentences, language: "en" });
      await setFillInItemContent(sql, item.id, {
        document: doc.toJSON() as FiloDocumentJson,
        audioUrl: null,
        durationMs: null,
        source: "human",
        provenance: null,
      });
      documented++;
      console.log(`  + document for "${fillInItemTitle(item.payload)}"`);
    }
    if (item.status !== status) {
      await setFillInItemStatus(sql, item.id, status);
      statusChanged++;
      console.log(`  ~ "${fillInItemTitle(item.payload)}" → ${status}`);
    }
  }
}

console.log(`done: ${documented} documents written, ${statusChanged} status changes`);
await sql.end();
