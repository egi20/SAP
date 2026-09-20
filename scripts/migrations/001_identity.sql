-- 001 Identity and access.
--
-- NOTE ON created_at: with `explicit_defaults_for_timestamp` disabled, MySQL gives the
-- FIRST TIMESTAMP column of a table an implicit `DEFAULT CURRENT_TIMESTAMP ON UPDATE
-- CURRENT_TIMESTAMP`. `users.created_at` is the registration date and is part of the
-- consent audit trail, so it must never be re-dated by an UPDATE. Every timestamp in
-- this schema is therefore declared DATETIME with an explicit default, which has no
-- such auto-initialisation behaviour at all.

CREATE TABLE users (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email                  VARCHAR(255) NOT NULL,
  password_hash          VARCHAR(255) NOT NULL,
  name                   VARCHAR(200) NOT NULL,

  -- Primary role. Public registration may only ever produce 'consultant' or 'company';
  -- every other value is admin-onboarded. See models/User.js.
  user_type              ENUM('consultant','company','recruiter','partner','admin') NOT NULL DEFAULT 'consultant',

  -- Independent role flags: one account can hold several roles at once.
  is_consultant          TINYINT(1) NOT NULL DEFAULT 0,
  is_company             TINYINT(1) NOT NULL DEFAULT 0,
  is_recruiter           TINYINT(1) NOT NULL DEFAULT 0,
  is_partner             TINYINT(1) NOT NULL DEFAULT 0,
  is_superadmin          TINYINT(1) NOT NULL DEFAULT 0,

  is_active              TINYINT(1) NOT NULL DEFAULT 1,
  email_verified         TINYINT(1) NOT NULL DEFAULT 0,

  -- Consent audit. Stamped ONLY by the public registration route, never by admin
  -- creation, seeds or tests: consent is never fabricated on someone's behalf.
  terms_accepted_at      DATETIME     NULL DEFAULT NULL,
  terms_version          VARCHAR(32)  NULL DEFAULT NULL,
  privacy_policy_version VARCHAR(32)  NULL DEFAULT NULL,

  -- Voluntary, aggregate-analytics only. NULL means "prefer not to say".
  gender                 ENUM('male','female','non_binary','other') NULL DEFAULT NULL,
  date_of_birth          DATE         NULL DEFAULT NULL,

  signup_ip              VARBINARY(16) NULL DEFAULT NULL,
  signup_country         CHAR(2)      NULL DEFAULT NULL,

  onboarded_at           DATETIME     NULL DEFAULT NULL,
  last_login_at          DATETIME     NULL DEFAULT NULL,

  created_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_type_active (user_type, is_active),
  KEY idx_users_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- express-mysql-session store. Created here rather than by the store itself
-- (`createDatabaseTable: false`) so the schema stays entirely under migration control.
CREATE TABLE sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires    INT UNSIGNED NOT NULL,
  data       MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id),
  KEY idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Only the SHA-256 of a token is stored, so a database read cannot be replayed as a
-- verification link.
CREATE TABLE email_verifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash CHAR(64)     NOT NULL,
  expires_at DATETIME     NOT NULL,
  consumed_at DATETIME    NULL DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_verifications_token (token_hash),
  KEY idx_email_verifications_user (user_id),
  CONSTRAINT fk_email_verifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE password_reset_tokens (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64)     NOT NULL,
  expires_at  DATETIME     NOT NULL,
  consumed_at DATETIME     NULL DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_reset_token (token_hash),
  KEY idx_password_reset_user (user_id),
  CONSTRAINT fk_password_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
