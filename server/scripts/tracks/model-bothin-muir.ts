/** Content-supply model on OSRM's per-step travel times; not a phone/car field test. */
import {sql} from '../../src/db';
import {join} from 'node:path';
const dir=join(import.meta.dir,'../data/bothin-muir-research');
const raw=await Bun.file(join(dir,'route-osrm.json')).json();
const route=raw.routes[0];
const steps=route.legs.flatMap((l:any)=>l.steps).filter((s:any)=>s.duration>0&&s.geometry.coordinates.length>1);
let elapsed=0;const trace:any[]=[];
for(const s of steps){
 const g=JSON.stringify(s.geometry);const rows=await sql`WITH r AS(SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${g}),4326),32610) g) SELECT i,ST_AsGeoJSON(ST_Transform(ST_LineInterpolatePoint(g,i/${Math.max(1,Math.ceil(s.duration))}::float),4326))::json p FROM r,generate_series(0,${Math.max(1,Math.ceil(s.duration))}) i`;
 for(const row of rows)trace.push({time:elapsed+row.i*s.duration/Math.ceil(s.duration),point:row.p});elapsed+=s.duration;
}
const [t]=await sql`SELECT id FROM tracks WHERE slug=${'bothin-to-muir-beach-101'}`;if(!t)throw Error('Track missing');
const records=await sql`SELECT s.id,s.title,ST_Area(s.region)::float area,c.duration_ms FROM spots s JOIN content_pieces c ON c.spot_id=s.id WHERE s.track_id=${t.id} AND s.status='published' AND c.status='published' AND c.audio_url IS NOT NULL ORDER BY ST_Area(s.region),s.title`;
// One query per trace point is intentional but bounded (~2,100 points).
const availability=[];
for(const p of trace){const opts=await sql`SELECT id FROM spots WHERE track_id=${t.id} AND status='published' AND ST_Covers(region,ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(p.point)}),4326)::geography)`;availability.push({time:p.time,ids:opts.map(o=>o.id)});}
const runs=[];
for(const factor of [1,1.5,2]){
 const heard=new Set<string>();const plays=[];let end=0,quietSince=0,supplyGap=0,maxSupplyGap=0,speech=0;
 for(const frame of availability){const now=frame.time*factor;if(now<end)continue;
  if(now<end+15)continue;
  const s=records.find(s=>frame.ids.includes(s.id)&&!heard.has(s.id));
  if(!s){if(!supplyGap)supplyGap=now;maxSupplyGap=Math.max(maxSupplyGap,now-supplyGap);continue;}
  supplyGap=0;const duration=s.duration_ms/1000;plays.push({title:s.title,startS:now,durationS:duration});heard.add(s.id);end=now+duration;speech+=Math.max(0,Math.min(duration,elapsed*factor-now));
 }
 runs.push({travelMinutes:elapsed*factor/60,timeMultiplier:factor,storiesStarted:plays.length,spokenMinutesDuringDrive:speech/60,coveragePercent:100*speech/(elapsed*factor),longestSupplyGapBeyondConfiguredPauseS:maxSupplyGap,plays});
}
await Bun.write(join(dir,'pacing-model.json'),JSON.stringify({assumptions:'Fresh play history; only this track enabled; 15-second gaps; perfect location/audio availability; OSRM per-step baseline timing multiplied uniformly. Uses matching area-selection priorities with title as a deterministic tie-break. Measures story supply, not actual iOS or car behavior.',runs},null,2)+'\n');
console.log(JSON.stringify(runs.map(({plays,...r})=>r)));await sql.end();
