-- Removes everything seed.sql created. Deleting a user cascades to their sessions and notes.
DELETE FROM users WHERE email LIKE 'loadtest-%@example.invalid';
