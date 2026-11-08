-- 042 List the profiles 041 left hidden (owner's decision, 2026-11-08).
--
-- 041 kept hidden every profile at 60% or more that was not listed, because "never pressed
-- Publish" and "pressed Hide" were stored the same way. The owner chose to list them too:
-- the directory is anonymous to visitors, and every consultant can hide themselves again
-- with the switch on their profile. A moderator's takedown is untouched.
UPDATE consultant_profiles
   SET is_public = 1
 WHERE is_public = 0
   AND admin_hidden_at IS NULL;
