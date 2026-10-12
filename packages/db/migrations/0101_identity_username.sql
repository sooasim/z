-- 0101 CORE-01: optional login handle, so the admin console can be entered with a short id
-- (`admin`) instead of an email address. Forward-only.
--
-- Members keep signing in with their email; `username` stays NULL for them. citext gives the same
-- case-insensitive uniqueness the email column already has.
ALTER TABLE users ADD COLUMN username citext UNIQUE;

ALTER TABLE users
  ADD CONSTRAINT users_username_format CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,39}$');

COMMENT ON COLUMN users.username IS 'Optional login handle for staff sign-in (CORE-01). NULL for accounts that sign in with email only.';
