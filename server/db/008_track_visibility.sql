-- Track visibility: hold a finished track back from the public API without
-- unpublishing anything inside it.
--
-- Editorial readiness already has a home: spots.status and
-- content_pieces.status move draft → review → published → archived. Release
-- gating is a different axis, and overloading status for it loses
-- information. Withholding a complete track by flipping its 68 spots back to
-- 'draft' would say "unfinished" about work that is finished, and would
-- destroy the per-spot record of what had been published — so putting it back
-- later means guessing which rows to restore.
--
-- visibility is that second axis, one row per track:
--   'public'  — served normally, still subject to the usual status filters
--   'private' — never served by the public API, whatever its spots say
--
-- Spot and content statuses are untouched either way, so holding a track and
-- releasing it are each a single UPDATE, and nothing is lost in between.
-- hold_reason/held_at keep the record self-explaining: a year from now the
-- row itself says why it was withheld and when.
--
-- Admin surfaces ignore visibility — the point is that held tracks stay fully
-- visible and editable to their author.

ALTER TABLE tracks
  ADD COLUMN IF NOT EXISTS visibility  TEXT NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS hold_reason TEXT,
  ADD COLUMN IF NOT EXISTS held_at     TIMESTAMPTZ;

ALTER TABLE tracks
  ADD CONSTRAINT tracks_visibility_chk
    CHECK (visibility IN ('public', 'private'));

-- A held track must say why, and a released one must not keep a stale reason.
-- Forces the decision to be recorded at the moment it is made.
ALTER TABLE tracks
  ADD CONSTRAINT tracks_hold_chk
    CHECK (
      (visibility = 'private') = (hold_reason IS NOT NULL AND held_at IS NOT NULL)
    );

-- Every public read filters on this.
CREATE INDEX IF NOT EXISTS tracks_visibility_idx ON tracks (visibility);
