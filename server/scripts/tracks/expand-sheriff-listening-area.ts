/** Let the existing app hear regional sheriff's calls throughout this trip.
 * This is a listening area, not the incident location or a legal boundary.
 * Keep spot IDs, transcripts and recordings, including their history.
 */
import { sql } from "../../src/db";
import { listTracks, listSpots, updateSpot } from "../../src/content/repo";
import { GeoTrigger } from "@grandtour/shared";

const slatePath = new URL("../data/point-reyes-light-sheriff-calls.spots.json", import.meta.url);
const slate = await Bun.file(slatePath).json();
const track = (await listTracks(sql)).find(t => t.slug === slate.track.slug);
if (!track) throw new Error("Missing Point Reyes track");
const calls = (await listSpots(sql, {trackId: track.id, limit:1000}))
  .filter(s => s.title.startsWith("Sheriff’s Calls:"));
const region = [
  {lat:37.8,lng:-123.15}, {lat:37.8,lng:-122.35},
  {lat:38.4,lng:-122.35}, {lat:38.4,lng:-123.15}, {lat:37.8,lng:-123.15},
];
const trigger = GeoTrigger.parse({kind:"area",region});
const beforePath = new URL("../../docs/sheriff-listening-before-2026-09-12.json", import.meta.url);
if (!(await Bun.file(beforePath).exists())) await Bun.write(beforePath, JSON.stringify(calls,null,2)+"\n");
for (const s of calls) {
  await updateSpot(sql,s.id,{...s,trigger,locating:{mode:"none",clips:{}}});
  const authored = slate.spots.find((a:any) => a.title === s.title);
  if (authored) {
    authored.trigger = trigger;
    authored.incidentZone = authored.incidentZone ?? authored.zone;
    authored.zone = "West Marin listening area";
  }
}
await Bun.write(slatePath, JSON.stringify(slate,null,2)+"\n");
await Bun.write(new URL("../data/west-marin-listening-area.json", import.meta.url),JSON.stringify(trigger,null,2)+"\n");
console.log(JSON.stringify({expanded:calls.length,track:track.slug,recordings:"preserved"}));
await sql.end();
