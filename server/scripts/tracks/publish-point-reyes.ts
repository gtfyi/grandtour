/** Publish the complete authored tour without replacing texts or existing aligned audio. */
import {sql} from '../../src/db';
const slug='fairfax-point-reyes-archive-drive';
const result=await sql.begin(async tx=>{
 const [t]=await tx`SELECT id FROM tracks WHERE slug=${slug}`;
 if(!t)throw Error('Track not found');
 const counts=await tx`SELECT count(*)::int AS spots FROM spots WHERE track_id=${t.id}`;
 if(counts[0]?.spots!==107)throw Error('Unexpected spot count; inspect before publishing');
 const missing=await tx`SELECT s.title FROM spots s WHERE s.track_id=${t.id} AND NOT EXISTS(SELECT 1 FROM content_pieces c WHERE c.spot_id=s.id AND c.locale='en' AND c.variant='default' AND length(c.document->>'text')>0)`;
 if(missing.length)throw Error('Missing scripts');
 await tx`UPDATE content_pieces SET status='published',updated_at=now() WHERE spot_id IN (SELECT id FROM spots WHERE track_id=${t.id}) AND locale='en' AND variant='default' AND status<>'published'`;
 await tx`UPDATE spots SET status='published',updated_at=now() WHERE track_id=${t.id} AND status<>'published'`;
 return await tx`SELECT count(*)::int AS published, count(c.audio_url)::int AS recordings FROM spots s JOIN content_pieces c ON c.spot_id=s.id WHERE s.track_id=${t.id} AND s.status='published' AND c.status='published' AND c.locale='en' AND c.variant='default'`;
});
console.log(JSON.stringify([...result]));await sql.end();
