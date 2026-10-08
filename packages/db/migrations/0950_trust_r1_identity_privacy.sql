-- 0950 trust hardening r1 (CORE-01 / CORE-02).
--
-- 1) Auth secrets were delivered as in-app notifications: the email-verify code, the login OTP and the password
--    reset token sat in plaintext in notifications.body (and in the rendered EMAIL/PUSH deliveries), readable by
--    any session of the account. Codes are now delivered out-of-band only; purge every stored copy.
DELETE FROM notification_deliveries
 WHERE notification_id IN (SELECT id FROM notifications WHERE template_key IN ('auth.email_otp', 'auth.password_reset', 'auth.email_verify'));
DELETE FROM notifications WHERE template_key IN ('auth.email_otp', 'auth.password_reset', 'auth.email_verify');

-- 2) display_name used to default to the email local-part and is public (profiles, reviews, host pages).
--    Replace those derived names with a neutral handle; host profiles seeded from them follow.
UPDATE users
   SET display_name = 'Traveler ' || upper(substr(md5(id::text || clock_timestamp()::text), 1, 4))
 WHERE email IS NOT NULL AND display_name IS NOT NULL
   AND lower(display_name) = lower(split_part(email::text, '@', 1));
UPDATE host_profiles h
   SET display_name = u.display_name
  FROM users u
 WHERE u.id = h.user_id AND u.email IS NOT NULL AND h.display_name IS NOT NULL
   AND lower(h.display_name) = lower(split_part(u.email::text, '@', 1));
