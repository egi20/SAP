-- 015 Recruiter profiles.
--
-- The `is_recruiter` flag has existed on `users` since migration 001; this adds the
-- profile behind it. Shaped like `company_profiles` on purpose — an agency listing and a
-- company listing are the same kind of object, and two different shapes would mean two
-- directory queries that can disagree about who is visible.
--
-- What is NOT here, and why: the reference implementation's route comments promise
-- "Phase 2 adds candidate shortlists / ATS pipeline; Phase 3 adds placement & commission
-- tracking". Neither exists. An empty table for a phase nobody has designed is a table
-- somebody later writes a query against; when shortlists are real they get their own
-- migration, with the sharing question answered first — a shortlist holds other people's
-- profiles, and who may see that a consultant is on one is not obvious.

CREATE TABLE recruiter_profiles (
  user_id         INT UNSIGNED NOT NULL,

  agency_name     VARCHAR(200) NOT NULL,
  slug            VARCHAR(220) NOT NULL,
  contact_name    VARCHAR(200) NULL DEFAULT NULL,
  tagline         VARCHAR(255) NULL DEFAULT NULL,
  about           TEXT         NULL,

  phone           VARCHAR(40)  NULL DEFAULT NULL,
  website         VARCHAR(255) NULL DEFAULT NULL,
  linkedin_url    VARCHAR(255) NULL DEFAULT NULL,
  country         CHAR(2)      NULL DEFAULT NULL,
  city            VARCHAR(120) NULL DEFAULT NULL,
  logo            VARCHAR(255) NULL DEFAULT NULL,

  -- Which SAP product lines they actually recruit for, as a JSON array of line slugs from
  -- config/sapProducts.js. Stored rather than free text so the directory filters on the
  -- same vocabulary the job board, the estimator and the community categories use.
  specialisms     JSON         NULL DEFAULT NULL,

  -- Same opt-in as a consultant profile: hidden until its owner publishes it, and the
  -- model enforces a completeness floor before that is allowed. A directory of half-empty
  -- agency cards is worse than a short directory.
  is_public       TINYINT(1)   NOT NULL DEFAULT 0,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id),
  UNIQUE KEY uq_recruiter_slug (slug),
  KEY idx_recruiter_public (is_public),
  CONSTRAINT fk_recruiter_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
