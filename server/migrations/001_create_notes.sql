CREATE TABLE notes (
  id         text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 100),
  title      text NOT NULL CHECK (char_length(title) <= 120),
  content    text NOT NULL DEFAULT '' CHECK (char_length(content) <= 500000),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  deleted_at timestamptz(3)
);

-- Keyset pagination for the note list; soft-deleted rows are excluded from the index.
CREATE INDEX notes_list_idx ON notes (updated_at DESC, id DESC) WHERE deleted_at IS NULL;
