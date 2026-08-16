BEGIN;

CREATE TABLE preferences (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  profile_text TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO preferences (id, profile_text)
VALUES (1, '');

COMMIT;
