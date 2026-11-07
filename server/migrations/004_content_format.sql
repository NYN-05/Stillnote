-- Explicit content format and schema versioning. Existing rows are Markdown:
-- the legacy editor stored raw Markdown, so tagging it is factual, not a guess.
-- `version` is untouched here; the conversion script bumps it once per note.
ALTER TABLE notes
  ADD COLUMN content_format text NOT NULL DEFAULT 'markdown'
    CHECK (content_format IN ('markdown', 'html')),
  ADD COLUMN content_schema_version integer NOT NULL DEFAULT 1
    CHECK (content_schema_version >= 1),
  ADD COLUMN plain_text text NOT NULL DEFAULT '';

-- The conversion script scans only legacy rows.
CREATE INDEX notes_markdown_idx ON notes (id) WHERE content_format = 'markdown';
