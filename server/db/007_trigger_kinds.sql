-- Trigger kinds, spot sequences, and track lifecycle.
--
-- trigger_kind: 'point' (arrive → play; the original and default semantics),
-- 'area' (playable anywhere inside the `region` fence, gap-scheduled), or
-- 'anywhere' (reserved; rejected at write time until something serves it).
-- For 'area' rows, `region` holds the fence and `center` a representative
-- point (fence centroid) for distance sort / map pins — never for triggering.
--
-- sequence_key/index: ordered-story membership. Parts sharing a key within a
-- track auto-play strictly in index order (eligibility is enforced client-side
-- against play history; uniqueness is enforced here).
--
-- tracks.lifecycle: 'evergreen' (replayable forever, may keep growing) or
-- 'series' (podcast model: heard-once units, auto-disable on completion).

ALTER TABLE spots
  ADD COLUMN IF NOT EXISTS trigger_kind   TEXT NOT NULL DEFAULT 'point',
  ADD COLUMN IF NOT EXISTS sequence_key   TEXT,
  ADD COLUMN IF NOT EXISTS sequence_index INTEGER;

ALTER TABLE spots
  ADD CONSTRAINT spots_trigger_kind_chk
    CHECK (trigger_kind IN ('point', 'area', 'anywhere')),
  ADD CONSTRAINT spots_area_region_chk
    CHECK (trigger_kind <> 'area' OR region IS NOT NULL),
  ADD CONSTRAINT spots_sequence_pair_chk
    CHECK ((sequence_key IS NULL) = (sequence_index IS NULL));

-- One spot per slot in a story.
CREATE UNIQUE INDEX IF NOT EXISTS spots_sequence_uq
  ON spots (track_id, sequence_key, sequence_index)
  WHERE sequence_key IS NOT NULL;

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'evergreen';

ALTER TABLE tracks
  ADD CONSTRAINT tracks_lifecycle_chk
    CHECK (lifecycle IN ('evergreen', 'series'));
