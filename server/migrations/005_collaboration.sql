CREATE TABLE document_collaboration (
  user_id    uuid NOT NULL,
  document_id text NOT NULL,
  state      bytea NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id),
  FOREIGN KEY (user_id, document_id) REFERENCES notes (user_id, id) ON DELETE CASCADE
);

CREATE TABLE document_versions (
  user_id     uuid NOT NULL,
  document_id text NOT NULL,
  version     integer NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id, version),
  FOREIGN KEY (user_id, document_id) REFERENCES notes (user_id, id) ON DELETE CASCADE
);

CREATE INDEX document_versions_recent_idx
  ON document_versions (user_id, document_id, version DESC);
