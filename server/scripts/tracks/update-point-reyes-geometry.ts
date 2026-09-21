import {GeoTrigger} from "@grandtour/shared";
import {sql} from '../../src/db';
import {listTracks,listSpots,updateSpot} from '../../src/content/repo';
const slate=await Bun.file(new URL('../data/point-reyes-drive.spots.json',import.meta.url)).json();
const track=(await listTracks(sql)).find(t=>t.slug===slate.track.slug)!;
const spots=await listSpots(sql,{trackId:track.id,limit:1000});
for(const a of slate.spots.filter((s:any)=>s.zone==='bearvalley'||s.title.startsWith('Muddy Hollow:'))){
 const s=spots.find(s=>s.title===a.title)!;
 await updateSpot(sql,s.id,{...s,trigger:GeoTrigger.parse(a.trigger)});
 console.log(`Updated listening geometry: ${s.title}`);
}
await sql.end();
