/** Resumable ElevenLabs recordings with verified American voices.
 * Inter-story silence is controlled by the app, never added to these files.
 */
import { sql } from "../../src/db";
import { env } from "../../src/env";
import { generateVoiceover } from "../../src/ai/voiceover";
import { listTracks, listSpots, listContentForSpot, upsertContent, updateSpot } from "../../src/content/repo";

const slate = await Bun.file(process.argv[2]!).json();
for (const authored of slate.spots) {
  if (!authored.reportEntries) continue;
  const plainReport = authored.reportEntries.map((entry: {date: string; town: string; report: string}) =>
    `${entry.date}. ${entry.town}. ${entry.report}`,
  ).join(" ");
  if (authored.narration !== plainReport) throw new Error(`Sheriff's call must contain only date, town, report: ${authored.title}`);
}
const voices = ["CwhRBWXzGAHq8TQ4Fs17", "XrExE9yKIg1WjnnlVkGX", "pqHfZKP75CvOlQylNhV4", "EXAVITQu4vr4xnSDxMaL"];
const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": env.requireElevenLabsKey() } });
if (!res.ok) throw new Error(`Voice verification failed: ${res.status}`);
const catalog = (await res.json() as {voices: {voice_id:string;name:string;labels?:Record<string,string>}[]}).voices;
for (const id of voices) {
  const voice = catalog.find(v => v.voice_id === id);
  if (!voice || voice.labels?.accent?.toLowerCase() !== "american") throw new Error(`Voice ${id} is not verified American`);
  console.log(`Verified American voice: ${voice.name}`);
}
const track = (await listTracks(sql)).find(t => t.slug === slate.track.slug);
if (!track) throw new Error("Import drafts first");
const spots = await listSpots(sql, {trackId: track.id, limit:1000});
let failures = 0;
let quotaExhausted = false;
const selected = slate.spots.map((authored:any,i:number)=>({authored,i})).filter(({authored}:any)=>!process.env.ONLY_SLUG || authored.slug===process.env.ONLY_SLUG);
let cursor=0;
async function worker() {
while (!quotaExhausted && cursor < selected.length) {
const {authored,i}=selected[cursor++]!;
  const spot = spots.find(s => s.title === authored.title);
  if (!spot) throw new Error(`Missing spot ${authored.title}`);
  const prior = (await listContentForSpot(sql, spot.id)).find(c => c.locale === "en" && c.variant === "default");
  if (prior?.audioUrl && prior.document?.text === authored.narration && prior.provenance?.prompt?.includes("clean narration; app-controlled gap")) {
    console.log(`SKIP ${i+1}/${slate.spots.length} ${authored.title}`); continue;
  }
  try {
    console.log(`RECORD ${i+1}/${slate.spots.length} ${authored.title}`);
    // Keep all quotations in the same clearly synthetic narrator voice.
    // Split only long scripts, keeping the transcript exactly identical.
    const segments = authored.narration.split(/(?<=\.) (?=[^ ]{1,})/).reduce((out:string[], sentence:string) => {
      if (out.length && out[out.length-1]!.length + sentence.length < 7000) out[out.length-1] += " " + sentence;
      else out.push(sentence);
      return out;
    }, [] as string[]).map((text:string) => ({text, speaker:null}));
    const out = await generateVoiceover({spotId:spot.id, locale:"en", variant:"default", segments, narratorVoiceId:voices[i % voices.length]});
    if (out.document.text !== authored.narration) throw new Error("Transcript mismatch");
    const { document, audioUrl, durationMs } = out;
    await upsertContent(sql,{spotId:spot.id,locale:"en",variant:"default",document,audioUrl,durationMs,source:authored.reportEntries ? "imported" : "human",status:"published",provenance:{...out.provenance,sources:authored.sources.map((url:string)=>({title:url,url})),prompt:`Authored Point Reyes tour; American narrator ${voices[i % voices.length]}; clean narration; app-controlled gap; sources checked ${slate.researchedAt ?? "2026-09-07"}${authored.reportEntries ? "; sheriff calls: date, town, original report only; no added commentary" : ""}`,warnings:[]}});
    await updateSpot(sql,spot.id,{...spot,status:"published"});
    console.log(`PUBLISHED ${authored.slug}: ${(durationMs/60000).toFixed(2)} min; clean audio`);
  } catch(e) { failures++; if (String(e).includes("quota_exceeded")) quotaExhausted = true; console.error(`FAILED ${authored.slug}: ${e instanceof Error ? e.message : String(e)}`); }
}
}
await Promise.all(Array.from({length:Number(process.env.VOICE_CONCURRENCY || 3)},worker));
await sql.end();
console.log(`Finished; failures=${failures}; quotaExhausted=${quotaExhausted}; unstarted=${selected.length-cursor}`);
if (failures) process.exitCode=1;
