-- Seeds synthetic users, sessions and notes for load testing, entirely in SQL.
--   psql -v users=500 -v notes_per_user=20 -f seed.sql
-- Accounts are loadtest-<n>@example.invalid and cannot sign in (password hash never verifies);
-- each gets a session whose token is derived from its number, so k6 can send the cookie
-- directly. Notes are ids ln-<user>-<note> with ~3 KB of text each.
-- Re-running is safe: existing rows are left alone. Remove everything with cleanup.sql.

\set ON_ERROR_STOP on

INSERT INTO users (email, password_hash)
SELECT format('loadtest-%s@example.invalid', n), '!'
FROM generate_series(0, :users - 1) AS n
ON CONFLICT (email) DO NOTHING;

-- Token for user n is: loadtest-token-<n padded to 6>-0123456789abcdef  (see k6.js)
INSERT INTO sessions (token_hash, user_id, expires_at)
SELECT encode(sha256(convert_to(format('loadtest-token-%s-0123456789abcdef', lpad(n::text, 6, '0')), 'UTF8')), 'hex'),
       u.id,
       now() + interval '7 days'
FROM generate_series(0, :users - 1) AS n
JOIN users u ON u.email = format('loadtest-%s@example.invalid', n)
ON CONFLICT (token_hash) DO NOTHING;

INSERT INTO notes (user_id, id, title, content, created_at, updated_at)
SELECT u.id,
       format('ln-%s-%s', n, m),
       format('Load note %s-%s', n, m),
       repeat(md5(random()::text) || ' lorem ipsum dolor sit amet, consectetur adipiscing elit. ', 40),
       now() - (random() * interval '30 days'),
       now() - (random() * interval '30 days')
FROM generate_series(0, :users - 1) AS n
CROSS JOIN generate_series(0, :notes_per_user - 1) AS m
JOIN users u ON u.email = format('loadtest-%s@example.invalid', n)
ON CONFLICT (user_id, id) DO NOTHING;

ANALYZE notes;
SELECT (SELECT count(*) FROM users WHERE email LIKE 'loadtest-%') AS users,
       (SELECT count(*) FROM notes n JOIN users u ON u.id = n.user_id WHERE u.email LIKE 'loadtest-%') AS notes,
       (SELECT pg_size_pretty(pg_total_relation_size('notes'))) AS notes_table_size;
