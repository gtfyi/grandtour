-- GrandTour initial schema.
-- Requires PostGIS (GEOGRAPHY + GiST spatial index) for radius/polygon triggers.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ─── Layers ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS layers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  color       TEXT,
  official    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Guides (human-guide-first) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS guides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  booking_url   TEXT,
  contact_email TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Spots ───────────────────────────────────────────────────────────────────
-- A spot's trigger geometry:
--   center      GEOGRAPHY(Point)   — always present; used for distance sort.
--   radius_m    meters             — radius trigger.
--   region      GEOGRAPHY(Polygon) — optional precise boundary.

CREATE TABLE IF NOT EXISTS spots (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id   UUID NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  subtitle   TEXT NOT NULL DEFAULT '',
  center     GEOGRAPHY(Point, 4326) NOT NULL,
  radius_m   DOUBLE PRECISION NOT NULL DEFAULT 80,
  region     GEOGRAPHY(Polygon, 4326),
  modes      TEXT[] NOT NULL DEFAULT '{}',
  guide_id   UUID REFERENCES guides(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The core spatial indexes: radius search hits `center`, polygon containment hits `region`.
CREATE INDEX IF NOT EXISTS spots_center_gix ON spots USING GIST (center);
CREATE INDEX IF NOT EXISTS spots_region_gix ON spots USING GIST (region);
CREATE INDEX IF NOT EXISTS spots_layer_idx  ON spots (layer_id);
CREATE INDEX IF NOT EXISTS spots_status_idx ON spots (status);

-- ─── Content pieces (text + aligned audio) ───────────────────────────────────
-- `document` is a filo FiloDocumentJson: base text + tiers (words, sentences,
-- audio). The audio tier aligns segment timing to text byte ranges.

CREATE TABLE IF NOT EXISTS content_pieces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id     UUID NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  locale      TEXT NOT NULL DEFAULT 'en',
  variant     TEXT NOT NULL DEFAULT 'default',
  document    JSONB,
  audio_url   TEXT,
  duration_ms INTEGER,
  source      TEXT NOT NULL,             -- human | ai | imported
  provenance  JSONB,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spot_id, locale, variant)
);

CREATE INDEX IF NOT EXISTS content_spot_idx   ON content_pieces (spot_id);
CREATE INDEX IF NOT EXISTS content_status_idx ON content_pieces (status);
