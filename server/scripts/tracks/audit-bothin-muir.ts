/** Verify published media and sampled route coverage for the Bothin–Muir drive. */
import {sql} from '../../src/db';
import {join} from 'node:path';
import {listTracks,listSpots,listContentForSpot} from '../../src/content/repo';
const dir=join(import.meta.dir,'../data/bothin-muir-research');
const slate=await Bun.file(join(import.meta.dir,'../data/bothin-to-muir-beach.spots.json')).json();
const route=await Bun.file(join(dir,'route.geojson')).json();
const t=(await listTracks(sql)).find(t=>t.slug===slate.track.slug);if(!t)throw Error('Track missing');
const ss=await listSpots(sql,{trackId:t.id,limit:1000});
const records=[];const errors:string[]=[];
for(const authored of slate.spots){
 const s=ss.find(s=>s.title===authored.title);if(!s){errors.push(`Missing spot ${authored.id}`);continue;}
 const c=(await listContentForSpot(sql,s.id)).find(c=>c.locale==='en'&&c.variant==='default');
 const ready=s.status==='published'&&c?.status==='published'&&!!c.audioUrl;
 if(!ready)errors.push(`Unpublished/unvoiced ${authored.id}`);
 if(c?.document?.text!==authored.narration)errors.push(`Text mismatch ${authored.id}`);
 if(c?.audioUrl&&c.provenance?.ttsProvider!=='elevenlabs')errors.push(`Wrong provider ${authored.id}`);
 if(c?.document){
  const doc=c.document as any;const bytes=new TextEncoder().encode(doc.text);const boundaries=new Set([0]);let offset=0;for(const char of doc.text){offset+=new TextEncoder().encode(char).length;boundaries.add(offset);}
  if(doc.byteLength!==bytes.length)errors.push(`Byte length ${authored.id}`);
  const annotations=doc.tiers.find((t:any)=>t.id==='audio')?.annotations??[];
  if(!annotations.length)errors.push(`Missing alignment ${authored.id}`);
  let byteEnd=0,timeEnd=0;
  for(const a of annotations){if(!boundaries.has(a.start)||!boundaries.has(a.end)||a.start<byteEnd||a.end<=a.start||a.payload.startMs<timeEnd||a.payload.endMs<a.payload.startMs||a.payload.endMs>(c.durationMs??0)+80)errors.push(`Alignment ${authored.id}`);byteEnd=a.end;timeEnd=a.payload.endMs;}
 }
 if(c?.audioUrl&&process.argv.includes('--http')){const res=await fetch(c.audioUrl,{headers:{Range:'bytes=0-31'}});const b=await res.arrayBuffer();if(res.status!==206||b.byteLength!==32)errors.push(`HTTP range ${authored.id}: ${res.status}/${b.byteLength}`);}

 records.push({id:authored.id,spotId:s.id,title:s.title,zone:authored.zone,kind:authored.kind,ready,durationMs:c?.durationMs,voiceId:c?.provenance?.voiceId,audioUrl:c?.audioUrl});
}
const [validity]=await sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE NOT ST_IsValid(region::geometry))::int invalid FROM spots WHERE track_id=${t.id}`;
// ~50 m spacing in projected coordinates. Count audible published options at each sample.
const samples=await sql`WITH r AS(SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(route.geometry)}),4326),32610) g), p AS(SELECT i,ST_Transform(ST_LineInterpolatePoint(g,i/600.0),4326)::geography g FROM r,generate_series(0,600) i) SELECT p.i,ST_AsGeoJSON(p.g::geometry)::json point,count(s.id)::int options FROM p LEFT JOIN spots s ON s.track_id=${t.id} AND s.status='published' AND ST_Covers(s.region,p.g) AND EXISTS(SELECT 1 FROM content_pieces c WHERE c.spot_id=s.id AND c.status='published' AND c.audio_url IS NOT NULL) GROUP BY p.i,p.g ORDER BY p.i`;
const report={researchedAt:'2026-09-13',trackId:t.id,slug:t.slug,expected:100,total:records.length,ready:records.filter(r=>r.ready).length,spokenMinutes:records.reduce((n,r)=>n+(r.durationMs??0),0)/60000,routeDistanceM:route.properties.distanceM,routeBaselineMinutes:route.properties.durationS/60,invalidGeometry:validity.invalid,routeSamples:samples.length,uncoveredSamples:samples.filter(s=>s.options===0).length,minOptions:Math.min(...samples.map(s=>s.options)),errors,records,samples};
await Bun.write(join(dir,'audit.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,records:undefined,samples:undefined}));await sql.end();if(errors.length||validity.invalid)process.exitCode=1;
