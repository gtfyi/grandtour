-- Development seed data: a couple of layers and a few published spots in
-- lower Manhattan, each with a tiny piece of published content. Idempotent.

INSERT INTO layers (slug, name, description, icon, color, official)
VALUES
  ('history',      'History',      'Stories of what happened here.', 'building.columns', '#8B5E3C', TRUE),
  ('architecture', 'Architecture', 'The buildings and how they came to be.', 'building.2', '#3C6E8B', TRUE),
  ('nature',       'Nature',       'Trees, parks, water, and wildlife.', 'leaf', '#3C8B5E', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Brooklyn Bridge (History) — point + radius, plus a small region polygon.
WITH l AS (SELECT id FROM layers WHERE slug = 'history')
INSERT INTO spots (layer_id, title, subtitle, center, radius_m, region, modes, status)
SELECT l.id,
       'Brooklyn Bridge',
       'The span that stitched two cities together',
       'SRID=4326;POINT(-73.99653 40.70611)'::geography,
       250,
       'SRID=4326;POLYGON((-73.9990 40.7045, -73.9940 40.7045, -73.9940 40.7078, -73.9990 40.7078, -73.9990 40.7045))'::geography,
       ARRAY['walking','cycling']::text[],
       'published'
FROM l
WHERE NOT EXISTS (SELECT 1 FROM spots WHERE title = 'Brooklyn Bridge');

-- Woolworth Building (Architecture) — point + radius.
WITH l AS (SELECT id FROM layers WHERE slug = 'architecture')
INSERT INTO spots (layer_id, title, subtitle, center, radius_m, modes, status)
SELECT l.id,
       'Woolworth Building',
       'The Cathedral of Commerce',
       'SRID=4326;POINT(-74.00831 40.71237)'::geography,
       120,
       ARRAY['walking']::text[],
       'published'
FROM l
WHERE NOT EXISTS (SELECT 1 FROM spots WHERE title = 'Woolworth Building');

-- City Hall Park (Nature).
WITH l AS (SELECT id FROM layers WHERE slug = 'nature')
INSERT INTO spots (layer_id, title, subtitle, center, radius_m, modes, status)
SELECT l.id,
       'City Hall Park',
       'A green wedge in the city''s oldest civic heart',
       'SRID=4326;POINT(-74.00601 40.71273)'::geography,
       150,
       ARRAY['walking']::text[],
       'published'
FROM l
WHERE NOT EXISTS (SELECT 1 FROM spots WHERE title = 'City Hall Park');

-- A minimal published content piece for the Brooklyn Bridge (text only, no audio).
INSERT INTO content_pieces (spot_id, locale, variant, document, source, status)
SELECT s.id, 'en', 'default',
  jsonb_build_object(
    'id', 'doc_seed_bb',
    'text', 'You are standing at the Brooklyn Bridge. When it opened in 1883 it was the longest suspension bridge in the world.',
    'byteLength', 113,
    'metadata', jsonb_build_object('locale','en'),
    'tiers', '[]'::jsonb
  ),
  'human', 'published'
FROM spots s
WHERE s.title = 'Brooklyn Bridge'
  AND NOT EXISTS (SELECT 1 FROM content_pieces WHERE spot_id = s.id);
