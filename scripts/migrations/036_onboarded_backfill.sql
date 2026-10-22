-- 036 The welcome tour opens on an account's FIRST sign-in and never again (owner,
-- 2026-10-22). `users.onboarded_at` existed from 001 but nothing wrote it until the tour
-- arrived, so every account that has already signed in still reads as never having done
-- so — and would be shown a "first sign-in" tour on its hundredth.
--
-- An account with a `last_login_at` HAS signed in, so it is dated to that sign-in. An
-- account that registered and never signed in keeps NULL and gets the tour when it does.
-- Nothing else is touched.
UPDATE users
   SET onboarded_at = last_login_at
 WHERE onboarded_at IS NULL
   AND last_login_at IS NOT NULL;
