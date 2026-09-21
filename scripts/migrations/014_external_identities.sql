-- 014 Verified external identities.
--
-- One row per (provider, account) that a member has proved they control.
--
-- WHAT THIS TABLE DOES NOT HOLD, and the omissions are the design:
--
--   * NO ACCESS TOKEN. This application reads the member's name once, at the moment they
--     authorise, and then has no further use for LinkedIn. Keeping a token so that
--     "posting on their behalf" is possible later means holding a credential that can act
--     as them, on a machine that has no reason to. The reference stores them; we discard
--     them the moment userinfo returns.
--   * NO PROFILE BLOB. The reference keeps the whole userinfo payload as JSON "for later".
--     Personal data retained without a purpose is personal data to explain in a breach.
--   * NO EMAIL FROM THE PROVIDER. The Hub already knows the member's email and has
--     verified it itself; storing LinkedIn's copy creates a second one to keep in step.
--
-- What it does hold is the minimum that makes the claim checkable later: the opaque stable
-- subject, the display name as it stood, and when.

CREATE TABLE external_identities (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- 'linkedin' today. A column rather than a table name so a second provider does not
  -- need a near-identical table and a second set of every query.
  provider       VARCHAR(32)  NOT NULL,

  user_id        INT UNSIGNED NOT NULL,

  -- The provider's opaque, stable identifier for the account (OIDC `sub`). Never a URL,
  -- never an email: both change, and a URL in particular is chosen by the member.
  subject        VARCHAR(191) NOT NULL,

  -- The display name the provider returned, snapshot at verification. Shown next to the
  -- badge so a reader can see WHAT was confirmed rather than trusting the badge.
  display_name   VARCHAR(200) NULL DEFAULT NULL,

  -- Whether that name agreed with the Hub profile at the time. Recorded, not enforced:
  -- people legitimately differ between the two, and a name comparison cannot catch the
  -- case it would be rejecting real people to try to catch.
  name_matched   TINYINT(1)   NOT NULL DEFAULT 0,

  verified_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One provider account verifies ONE Hub account. Without this, one LinkedIn profile
  -- could badge any number of accounts, which is the whole value of the badge gone.
  UNIQUE KEY uq_identity_subject (provider, subject),
  -- And one Hub account holds one identity per provider, so "verified" is unambiguous.
  UNIQUE KEY uq_identity_user (provider, user_id),

  CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- When the verification happened, mirrored onto the profile.
--
-- `linkedin_verified` already exists in migration 002 and has never had a writer — the
-- directory's ranking expression scores it, the consultant card and the profile page each
-- render a badge from it, and Application.js selects it, so five readers have been
-- competing for a flag nothing could set. It stays a column rather than becoming an EXISTS
-- subquery on every row of every consultant listing. That is the same denormalisation this codebase refuses for
-- a featured-job window — and the difference is the reason it is safe here: a featured
-- window EXPIRES, so a cached boolean needs something to come round and unset it, whereas
-- a verification does not expire and only ever changes when the member acts. `LinkedIn`
-- is the single writer, and it moves both rows in one transaction.
ALTER TABLE consultant_profiles
  ADD COLUMN linkedin_verified_at DATETIME NULL DEFAULT NULL AFTER linkedin_verified;
