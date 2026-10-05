-- 019 "How did you hear about us?", answered once at registration.
--
-- WHY A COLUMN AND NOT A FREE-TEXT FIELD. A closed list of eight is answered honestly and
-- can be counted; a text box produces "google", "Google", "a friend", "googled it" and
-- "Google search" and then nobody can say what it means. The same argument as the agency
-- specialisms: eight tick boxes get filled in, fifty-seven do not.
--
-- WHY IT IS NOT referral_attributions. That table records a link somebody FOLLOWED and
-- pays a commission on it — it is money, first-touch, unique per account, and stamped with
-- the terms of the day. This is a self-reported sentence about where somebody thinks they
-- heard of us. Putting an unverifiable answer in the table that decides who gets paid is
-- how a commission scheme becomes a dropdown.
--
-- NULLABLE, and the question is optional. An answer nobody can skip is an answer nobody
-- means, and every account created before this migration honestly does not have one.

ALTER TABLE users
  ADD COLUMN heard_about ENUM(
    'search',
    'linkedin',
    'social',
    'colleague',
    'event',
    'sap_community',
    'press',
    'other'
  ) NULL DEFAULT NULL AFTER signup_country;
