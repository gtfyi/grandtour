-- Fill-in content (plans/014-fillin-content.md): non-location-anchored items
-- the app plays during gaps in narration.
--
-- A track's `kind` says what it contains: 'tour' (spots with geo triggers,
-- the default) or 'fillin' (fillin_items, no geometry). Fill-in tracks never
-- appear in /nearby or /route-nearby.

ALTER TABLE tracks ADD COLUMN kind TEXT NOT NULL DEFAULT 'tour';

-- Fill-in items embed their content columns (document/audio/provenance)
-- instead of referencing content_pieces: that table's spot_id is NOT NULL and
-- its unique key is spot-shaped, and a fill-in item needs exactly one piece.
-- The DTO layer still surfaces these columns as a ContentPiece.
CREATE TABLE IF NOT EXISTS fillin_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  track_id    UUID NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  module_type TEXT NOT NULL,             -- vocab | (future: trivia, quotes…)
  payload     JSONB NOT NULL,            -- module-specific (VocabPayload)
  sort_order  INTEGER,                   -- authoring order; NULL = unordered
  document    JSONB,                     -- filo doc (clean display text)
  audio_url   TEXT,
  duration_ms INTEGER,
  source      TEXT NOT NULL DEFAULT 'human',  -- human | ai | imported
  provenance  JSONB,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fillin_items_track_idx  ON fillin_items (track_id);
CREATE INDEX IF NOT EXISTS fillin_items_status_idx ON fillin_items (status);
