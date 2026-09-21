/** Build route listening envelopes with PostGIS; assemble independently researched stories. */
import {sql} from '../../src/db';
import {join} from 'node:path';
import {GeoTrigger} from '@grandtour/shared';
const dir=join(import.meta.dir,'../data/bothin-muir-research');
const route=await Bun.file(join(dir,'route.geojson')).json();
const candidates=await Bun.file(join(dir,'candidates.json')).json();
// Fractions refer to the verified OSRM road line. Envelopes are listening areas,
// not property, town, or national-park boundaries. 300 m overlap avoids gaps.
const bounds:Record<string,[number,number]>={
 bothin:[0,1.7/28],fairfax:[1.4/28,3.4/28],sananselmo:[3.1/28,5.3/28],
 sanrafaelwest:[5.1/28,7.3/28],sanrafaeldowntown:[7.0/28,9.2/28],
 '101north':[9/28,13.1/28],cortemadera:[12.8/28,15.5/28],
 '101south':[15.2/28,19.1/28],tamjunction:[18.8/28,21.4/28],
 shorelineclimb:[21.1/28,23.2/28],shorelineridge:[22.9/28,25.1/28],
 redwoodapproach:[24.5/28,26.6/28],lowerredwood:[26.2/28,27.8/28],muirbeach:[27.4/28,1],
};
const zones:Record<string,any>={};
for(const [key,[start,end]] of Object.entries(bounds)){
 const [row]=await sql`WITH r AS(SELECT ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(route.geometry)}),4326) g), b AS(SELECT ST_Buffer(ST_Transform(ST_LineSubstring(g,${start},${end}),32610),300) g FROM r) SELECT ST_AsGeoJSON(ST_Transform(ST_ExteriorRing(ST_MakePolygon(ST_ExteriorRing(ST_SimplifyPreserveTopology(g,8)))),4326))::json ring FROM b`;
 zones[key]={kind:'area',region:row.ring.coordinates.map(([lng,lat]:number[])=>({lat,lng}))};
 zones[key]=GeoTrigger.parse(zones[key]);
}
await Bun.write(join(dir,'zones.json'),JSON.stringify(zones,null,2)+'\n');
const stories=[];
for(const c of candidates){const file=Bun.file(join(dir,`${String(c.id).padStart(3,'0')}.json`));if(!await file.exists())continue;const s=await file.json();if(s.id!==c.id||s.zone!==c.zone)throw Error(`Identity mismatch ${c.id}`);if(!s.sources?.length||!s.narration)throw Error(`Missing sources/text ${c.id}`);stories.push(s);}
const spots=stories.map((s:any)=>({id:s.id,slug:`muir-${String(s.id).padStart(3,'0')}`,title:s.title,subtitle:s.kind==='news'?`News archive · ${s.date??'dated report'}`:s.kind==='national-park'?'National park history and nature':s.kind==='nature'?'Landscape and wildlife':'Local history',trigger:zones[s.zone],modes:[],locating:{mode:'none'},narration:s.narration,sources:s.sources,zone:s.zone,sourceNotes:s.sourceNotes,kind:s.kind,date:s.date}));
if(new Set(spots.map((s:any)=>s.title)).size!==spots.length)throw Error('Duplicate titles');
const track={slug:'bothin-to-muir-beach-101',name:'Bothin to Muir Beach: 101, History & the Light',description:'100 researched audio stories for the drive from Bothin Road in Fairfax through San Anselmo and San Rafael, south on US 101, then along Shoreline Highway through Tam Junction to Muir Beach. Local history, Point Reyes Light reporting, and national park nature and history. Overlapping route listening areas provide alternatives for traffic and return journeys; nearby and off-route subjects are identified in their scripts. American ElevenLabs recordings. Researched September 13, 2026.',kind:'tour',lifecycle:'series',icon:'car.fill',color:'#28645C',official:false};
await Bun.write(join(import.meta.dir,'../data/bothin-to-muir-beach.spots.json'),JSON.stringify({track,researchedAt:'2026-09-13',route:route.properties,spots},null,2)+'\n');
console.log(JSON.stringify({stories:spots.length,zones:Object.keys(zones).length,words:spots.reduce((n:number,s:any)=>n+s.narration.trim().split(/\s+/).length,0)}));
await sql.end();
