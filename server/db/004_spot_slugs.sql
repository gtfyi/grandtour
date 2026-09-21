-- Spots get URL slugs, unique within their track, so the admin can address
-- a spot as /:trackSlug/:spotSlug. Backfilled from titles; generated
-- server-side on create and kept stable across title edits (URLs don't rot).

ALTER TABLE spots ADD COLUMN slug TEXT;

UPDATE spots SET slug = trim(both '-' from regexp_replace(lower(title), '[^a-z0-9]+', '-', 'g'));

-- De-duplicate within each track by appending -2, -3, … (oldest keeps the base).
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY track_id, slug ORDER BY created_at) AS rn
  FROM spots
)
UPDATE spots SET slug = spots.slug || '-' || d.rn
FROM d WHERE spots.id = d.id AND d.rn > 1;

-- Titles that slugged to nothing fall back to an id fragment.
UPDATE spots SET slug = 'spot-' || left(id::text, 8) WHERE slug IS NULL OR slug = '';

ALTER TABLE spots ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX spots_track_slug_key ON spots (track_id, slug);
