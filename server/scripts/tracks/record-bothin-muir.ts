/** Resumable import/record/publish of reviewed Bothin–Muir scripts. No existing content replaced blindly. */
import {sql} from '../../src/db';
import {env} from '../../src/env';
import {join} from 'node:path';
import {generateVoiceover} from '../../src/ai/voiceover';
import {getAudio} from '../../src/ai/storage';
import {createTrack,createSpot,listTracks,listSpots,listContentForSpot,upsertContent,updateSpot} from '../../src/content/repo';
const slate=await Bun.file(join(import.meta.dir,'../data/bothin-to-muir-beach.spots.json')).json();
const ids=process.argv[2]?.split(',').map(Number);if(!ids?.length)throw Error('Pass reviewed story IDs, comma separated');
const selected=slate.spots.filter((s:any)=>ids.includes(s.id));
if(selected.length!==ids.length)throw Error('Unknown/duplicate ID');
const voices=['CwhRBWXzGAHq8TQ4Fs17','XrExE9yKIg1WjnnlVkGX','pqHfZKP75CvOlQylNhV4','EXAVITQu4vr4xnSDxMaL'];
const response=await fetch('https://api.elevenlabs.io/v1/voices',{headers:{'xi-api-key':env.requireElevenLabsKey()}});
if(!response.ok)throw Error(`Voice verification failed: ${response.status}`);
const catalog=await response.json() as any;
for(const id of voices)if(!catalog.voices.some((v:any)=>v.voice_id===id&&v.labels?.accent?.toLowerCase()==='american'))throw Error(`Unverified voice ${id}`);
const track=(await listTracks(sql)).find(t=>t.slug===slate.track.slug)??await createTrack(sql,slate.track);
const existing=await listSpots(sql,{trackId:track.id,limit:1000});
let cursor=0,failures=0,quotaExhausted=false;
async function worker(){while(!quotaExhausted&&cursor<selected.length){const s=selected[cursor++]!;
 try{
  let spot=existing.find(p=>p.title===s.title);
  if(spot){const prior=(await listContentForSpot(sql,spot.id)).find(c=>c.locale==='en'&&c.variant==='default');
   if(prior?.audioUrl&&prior.document?.text===s.narration&&prior.provenance?.ttsProvider==='elevenlabs'&&prior.status==='published'&&spot.status==='published'){console.log(`SKIP ${s.id} ${s.title}`);continue;}
   if(prior?.audioUrl&&prior.document?.text!==s.narration)throw Error(`Text changed for recorded story ${s.id}; review before replacing`);
  }else spot=await createSpot(sql,{trackId:track.id,title:s.title,subtitle:s.subtitle,trigger:s.trigger,modes:[],locating:{mode:'none',clips:{}},status:'draft'});
  console.log(`RECORD ${s.id} ${s.title}`);
  const out=await generateVoiceover({spotId:spot.id,locale:'en',variant:'default',segments:[{text:s.narration,speaker:null}],narratorVoiceId:voices[(s.id-1)%voices.length]});
  if(out.document.text!==s.narration)throw Error(`Transcript mismatch ${s.id}`);
  // Complete decode before publication, not merely an MP3 header check.
  const obj=await getAudio(decodeURIComponent(new URL(out.audioUrl).pathname.split('/').at(-1)!));
  if(!obj)throw Error('Generated audio missing');
  const proc=Bun.spawn(['ffmpeg','-v','error','-i','pipe:0','-f','null','-'],{stdin:'pipe',stdout:'ignore',stderr:'pipe'});
  proc.stdin.write(await obj.bytes());proc.stdin.end();const err=await new Response(proc.stderr).text();if(await proc.exited!==0)throw Error(`Audio decode failed: ${err}`);
  await upsertContent(sql,{spotId:spot.id,locale:'en',variant:'default',document:out.document,audioUrl:out.audioUrl,durationMs:out.durationMs,source:'ai',status:'published',provenance:{...out.provenance,sources:s.sources.map((url:string)=>({title:new URL(url).hostname,url})),prompt:`Independently researched original route story ${s.id}; sources checked 2026-09-13; American narrator; clean narration; app-controlled gap. ${s.sourceNotes}`,warnings:[]}});
  await updateSpot(sql,spot.id,{...spot,status:'published'});
  console.log(`PUBLISHED ${s.id} ${(out.durationMs/1000).toFixed(1)}s ${s.title}`);
 }catch(e){failures++;if(String(e).includes('quota_exceeded'))quotaExhausted=true;console.error(`FAILED ${s.id}: ${e instanceof Error?e.message:String(e)}`);}
}}
await Promise.all(Array.from({length:Math.min(3,selected.length)},worker));
console.log(JSON.stringify({selected:ids.length,failures,quotaExhausted,unstarted:selected.length-cursor}));await sql.end();if(failures||quotaExhausted)process.exitCode=1;
