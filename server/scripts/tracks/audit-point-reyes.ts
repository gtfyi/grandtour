import { sql } from '../../src/db';
import {listTracks,listSpots,listContentForSpot} from '../../src/content/repo';
const slug='fairfax-point-reyes-archive-drive';
const t=(await listTracks(sql)).find(t=>t.slug===slug)!;
const ss=await listSpots(sql,{trackId:t.id,limit:1000});
let duration=0,ready=0,missing:string[]=[],bad:string[]=[];
const records=[];
for(const s of ss){
 const c=(await listContentForSpot(sql,s.id)).find(c=>c.variant==='default'&&c.locale==='en');
 if(c?.audioUrl&&c.status==='published'&&s.status==='published') {ready++;duration+=c.durationMs??0;}else missing.push(s.title);
 if(c?.audioUrl && c.provenance?.ttsProvider!=='elevenlabs')bad.push(s.title+' wrong TTS');
 if(c?.audioUrl && !['CwhRBWXzGAHq8TQ4Fs17','XrExE9yKIg1WjnnlVkGX','pqHfZKP75CvOlQylNhV4','EXAVITQu4vr4xnSDxMaL'].includes(c.provenance?.voiceId??''))bad.push(s.title+' wrong voice');
 records.push({title:s.title,slug:s.slug,published:s.status==='published'&&c?.status==='published',durationMs:c?.durationMs,voice:c?.provenance?.voiceId,url:c?.audioUrl});
}
const geometry=await sql`SELECT title,ST_IsValid(region::geometry) AS valid FROM spots WHERE track_id=${t.id} AND region IS NOT NULL AND NOT ST_IsValid(region::geometry)`;
const report={slug,trackId:t.id,total:ss.length,ready,spokenMinutes:duration/60000,missing,bad,invalidGeometry:geometry,records};
await Bun.write('/tmp/point-reyes-research/audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,records:undefined,missing:missing.length}));
await sql.end();
