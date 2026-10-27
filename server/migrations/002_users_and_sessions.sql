CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (char_length(email) <= 254),
  password_hash text NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (email);

-- Only a SHA-256 of the session token is stored, so a database leak cannot be replayed.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Notes now belong to a user. Pre-existing notes go to a placeholder account that
-- cannot log in (its hash never verifies); `npm run db:claim -- you@example.com`
-- moves them to a real account.
ALTER TABLE notes ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE;

INSERT INTO users (email, password_hash)
SELECT 'legacy@stillnote.local', '!' WHERE EXISTS (SELECT 1 FROM notes);

UPDATE notes SET user_id = (SELECT id FROM users WHERE email = 'legacy@stillnote.local');

ALTER TABLE notes ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE notes DROP CONSTRAINT notes_pkey;
ALTER TABLE notes ADD PRIMARY KEY (user_id, id);

DROP INDEX notes_list_idx;
CREATE INDEX notes_list_idx ON notes (user_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
