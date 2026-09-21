-- A phone keeps these IDs across reconnects and app restarts. Commit the
-- receipt with the content so a lost HTTP response never duplicates a take.
CREATE TABLE creator_uploads (
  operation TEXT NOT NULL CHECK (operation IN ('track', 'spot')),
  client_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation, client_id)
);
