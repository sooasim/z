-- 0102 CORE-01: remember when the last failed login was, so a quiet streak stops counting. Forward-only.
--
-- `failed_login_attempts` only ever reset on a successful sign-in or a password reset, so five mistypes
-- spread over a month still added up to the next lockout, and the one after that doubled. With a timestamp
-- the service can treat failures older than FAILED_LOGIN_WINDOW_SEC as a streak that has ended, which is
-- what lets someone come back later and simply sign in.
--
-- Existing rows get NULL, which reads as "no live streak": an account that has been sitting with an old
-- failure count starts clean rather than inheriting a lockout nobody can explain.
ALTER TABLE users ADD COLUMN last_failed_login_at timestamptz;

COMMENT ON COLUMN users.last_failed_login_at IS 'When failed_login_attempts last grew (CORE-01). NULL = no live streak; older than the window = streak ended.';
