/** Assemble researched scripts and Census town fences. No generated factual prose. */
import { join } from 'node:path';
const dir=join(import.meta.dir,'../data');
const towns:Record<string,any>=(await Bun.file(`${dir}/point-reyes-drive.boundaries.json`).json()).towns;
const box=(south:number,west:number,north:number,east:number)=>({kind:'area',region:[{lat:south,lng:west},{lat:north,lng:west},{lat:north,lng:east},{lat:south,lng:east}]});
// These are listening envelopes along the route, not legal park boundaries.
const zones:Record<string,any>={...towns,
 bothin:box(37.991,-122.612,38.007,-122.597),
 whitehill:box(38.001,-122.647,38.025,-122.605),
 valley:box(38.003,-122.713,38.024,-122.637),
 'taylor-east':box(38.001,-122.725,38.018,-122.703),
 taylor:box(38.008,-122.750,38.041,-122.709),
 ridge:box(38.031,-122.783,38.055,-122.737),
 olema:box(38.030,-122.797,38.052,-122.778),
 bearvalley:box(38.032,-122.817,38.061,-122.795),
 limantour:box(38.035,-122.883,38.067,-122.812),
 hostel:box(38.039,-122.869,38.049,-122.854),
 coast:box(38.007,-122.917,38.049,-122.842),
 northbeach:box(38.051,-122.978,38.097,-122.942),
};
const inputs=['history-verified','news','parks','archive','archive-news'];
const spots:any[]=[];
for(const input of inputs) {
 const f=Bun.file(`${dir}/point-reyes-drive.${input}.json`);if(!await f.exists())continue;
 for(const s of await f.json()){
  // Sheriff recordings live in point-reyes-light-sheriff-calls.spots.json.
  // Keep historical research inputs, but never re-import calls into this drive.
  if (s.reportEntries || s.title.startsWith('Sheriff’s Calls:')) continue;
  const trigger=s.trigger??zones[s.zone];if(!trigger)throw Error(`Unknown zone ${s.zone}: ${s.title}`);
  const sources=s.sources??[s.url];
  if(!sources.length||sources.some((u:any)=>typeof u!=='string'||!u.startsWith('https://')))throw Error(`Bad sources ${s.title}`);
  spots.push({slug:s.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),title:s.title,subtitle:s.date?`Point Reyes Light · ${s.date}`:input==='history-verified'?'Historical writing · 1880':'Parks, trails and local history',trigger,modes:[],locating:{mode:'none'},narration:s.narration,sources,zone:s.zone,sourceNotes:s.sourceNotes??null});
 }
}
const titles=spots.map(s=>s.title);if(new Set(titles).size!==titles.length)throw Error('Duplicate titles');
for(const s of spots) if(!s.narration||s.narration.includes('undefined'))throw Error(`Bad narration ${s.title}`);
const track={slug:'fairfax-point-reyes-archive-drive',name:'Fairfax to Point Reyes: Trails, History & the Light',description:'A dense listening network from Bothin Road over White Hill, through San Geronimo Valley and Samuel P. Taylor to Olema, Bear Valley, Limantour Lodge and Coast Trail. Long public-domain historical readings, park stories, dated Point Reyes Light reporting; optional branches into neighboring towns. Town stories use Census town/CDP boundaries; park stories use route listening envelopes. American ElevenLabs narrators. Inter-story pauses are an app setting, default 15 seconds. Researched September 7, 2026.',kind:'tour',lifecycle:'series',icon:'leaf',color:'#35634E',official:false};
await Bun.write(`${dir}/point-reyes-drive.spots.json`,JSON.stringify({track,spots},null,2)+'\n');
const words=spots.reduce((n,s)=>n+s.narration.split(/\s+/).length,0);
console.log(JSON.stringify({spots:spots.length,words,estimatedMinutesAt150WPM:words/150,byZone:Object.fromEntries(Object.keys(zones).map(z=>[z,spots.filter(s=>s.zone===z).length]).filter(([,n])=>n))},null,2));
