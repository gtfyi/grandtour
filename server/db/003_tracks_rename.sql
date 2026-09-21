-- Rename Layer → Track. A Track is a named set of Spots (a thematic channel);
-- users can enable multiple Tracks at once. Terminology decided 2026-07-05.

ALTER TABLE layers RENAME TO tracks;
ALTER TABLE tracks RENAME CONSTRAINT layers_pkey TO tracks_pkey;
ALTER TABLE tracks RENAME CONSTRAINT layers_slug_key TO tracks_slug_key;

ALTER TABLE spots RENAME COLUMN layer_id TO track_id;
ALTER TABLE spots RENAME CONSTRAINT spots_layer_id_fkey TO spots_track_id_fkey;
ALTER INDEX spots_layer_idx RENAME TO spots_track_idx;
