-- Locating instructions per spot: the "where to look" part, separate from the
-- narration. JSONB shape matches the shared `Locating` schema:
--   { mode: auto|custom|none, template?, clips: { left?, right?, fixed? } }

ALTER TABLE spots ADD COLUMN locating JSONB NOT NULL DEFAULT '{"mode":"auto","clips":{}}';
