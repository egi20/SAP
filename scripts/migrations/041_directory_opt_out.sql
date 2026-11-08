-- 041 The talent directory lists a consultant by default; the member opts OUT (2026-11-08).
--
-- Owner's decision: Browse Talent works as it does on dynamicshub.net. A consultant with an
-- active account is listed as soon as the profile exists, and `is_public` becomes the
-- member's "hide me" switch rather than a "publish me" button behind a completeness floor.
-- The directory is still anonymous to a visitor without an account (name and photograph
-- are redacted), and an administrator's takedown (`admin_hidden_at`, 025) still wins.
--
-- THE BACKFILL CANNOT TELL EVERY CASE APART, and it errs towards keeping people hidden.
-- Under the old rule `is_public = 0` meant one of three things:
--   * the profile never reached the 60% floor, so the member COULD NOT publish it;
--   * it was published and dropped below the floor, and the model unlisted it;
--   * it was complete and the member left the switch off, or turned it off.
-- The first two are not a choice anybody made, so those rows (completeness < 60) are
-- listed. The third mixes "never pressed Publish" with "pressed Hide", and nothing records
-- which: a consultant who deliberately unlisted themselves must not reappear in a public
-- directory because the rules changed under them, so those rows stay hidden. Each one can
-- list themselves with one switch.
ALTER TABLE consultant_profiles
  MODIFY is_public TINYINT(1) NOT NULL DEFAULT 1;

UPDATE consultant_profiles
   SET is_public = 1
 WHERE is_public = 0
   AND completeness < 60
   AND admin_hidden_at IS NULL;
