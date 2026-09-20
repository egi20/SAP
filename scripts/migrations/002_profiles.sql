-- 002 Consultant and company profiles.
--
-- BLOB STORAGE RULE: the application host's filesystem is ephemeral (wiped on every
-- deploy), so durable bytes live in MySQL. They live in a SEPARATE side table keyed by
-- the owner, never as a column on the profile itself: profile and talent-list queries
-- select whole rows, and inlining image bytes would drag megabytes through every list
-- query. The owning row stores only a pointer URL with a cache-busting ?v=<ts>.

CREATE TABLE consultant_profiles (
  user_id            INT UNSIGNED NOT NULL,
  headline           VARCHAR(200) NULL DEFAULT NULL,
  bio                TEXT         NULL,

  -- Stored as the taxonomy SLUG (config/roleTaxonomy.js), never the display label.
  primary_role       VARCHAR(64)  NULL DEFAULT NULL,
  seniority          ENUM('junior','mid','senior','lead') NULL DEFAULT NULL,
  years_experience   TINYINT UNSIGNED NULL DEFAULT NULL,

  -- How many full-cycle SAP implementations this person has delivered end to end.
  -- Separate from years_experience, and this ecosystem's real currency: ten years of
  -- support work and ten years across six greenfield rollouts are not the same person,
  -- and every SAP CV states both. Neither reference has it because neither ecosystem
  -- prices it.
  full_lifecycles    TINYINT UNSIGNED NULL DEFAULT NULL,

  country            CHAR(2)      NULL DEFAULT NULL,
  city               VARCHAR(120) NULL DEFAULT NULL,
  timezone           VARCHAR(64)  NULL DEFAULT NULL,
  work_mode          ENUM('remote','hybrid','onsite') NOT NULL DEFAULT 'remote',
  willing_to_travel  TINYINT(1)   NOT NULL DEFAULT 0,

  day_rate           DECIMAL(10,2) NULL DEFAULT NULL,
  currency           CHAR(3)      NOT NULL DEFAULT 'EUR',
  availability       ENUM('immediate','two_weeks','one_month','not_available') NOT NULL DEFAULT 'not_available',
  available_from     DATE         NULL DEFAULT NULL,

  linkedin_url       VARCHAR(255) NULL DEFAULT NULL,
  linkedin_verified  TINYINT(1)   NOT NULL DEFAULT 0,
  website_url        VARCHAR(255) NULL DEFAULT NULL,
  -- The SAP equivalent of the reference's Trailblazer link: a people.sap.com or
  -- learning.sap.com profile. A member-supplied claim, never a verification.
  sap_community_url  VARCHAR(255) NULL DEFAULT NULL,

  profile_picture    VARCHAR(255) NULL DEFAULT NULL,

  -- A profile is only listed publicly once its owner opts in AND it has enough
  -- substance to be worth showing. Both conditions are enforced in the model.
  is_public          TINYINT(1)   NOT NULL DEFAULT 0,
  completeness       TINYINT UNSIGNED NOT NULL DEFAULT 0,

  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id),
  KEY idx_consultant_public_role (is_public, primary_role),
  KEY idx_consultant_country (country),
  KEY idx_consultant_availability (availability),
  CONSTRAINT fk_consultant_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_photos (
  user_id      INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_consultant_photos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE skills (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug       VARCHAR(80)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  category   VARCHAR(80)  NULL DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_skills_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_skills (
  user_id  INT UNSIGNED NOT NULL,
  skill_id INT UNSIGNED NOT NULL,
  level    ENUM('familiar','proficient','expert') NOT NULL DEFAULT 'proficient',
  PRIMARY KEY (user_id, skill_id),
  KEY idx_consultant_skills_skill (skill_id),
  CONSTRAINT fk_consultant_skills_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_consultant_skills_skill FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- CERTIFICATIONS ARE CODED, NOT TYPED.
--
-- Both reference implementations store a certification as one free-text `name`, which
-- makes "SAP Certified Associate - SAP S/4HANA Financial Accounting", "C_TS4FI" and
-- "S4 FI cert" three different credentials as far as any filter is concerned. Here the
-- catalogue stem from config/certifications.js is the stored value, and `custom_name`
-- carries the text only for the reserved OTHER code.
--
-- The code stem never includes SAP's year suffix, because SAP re-versions codes annually
-- and a stored `C_TS4FI_2023` is wrong within twelve months. `earned_on` is where the
-- year belongs.
--
-- `cert_key` is generated rather than written by the model, and the CHECK is what makes
-- it trustworthy: a UNIQUE over a nullable expression silently permits duplicates,
-- because in SQL a NULL never equals another NULL. Requiring `custom_name` on an OTHER
-- row keeps every key non-null, so the uniqueness actually holds.
CREATE TABLE consultant_certifications (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  code          VARCHAR(40)  NOT NULL,
  custom_name   VARCHAR(180) NULL DEFAULT NULL,
  tier          ENUM('Associate','Specialist','Professional') NULL DEFAULT NULL,
  credential_id VARCHAR(120) NULL DEFAULT NULL,
  earned_on     DATE         NULL DEFAULT NULL,
  expires_on    DATE         NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cert_key      VARCHAR(224) AS (IF(code = 'OTHER', CONCAT('OTHER:', custom_name), code)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_consultant_certification (user_id, cert_key),
  CONSTRAINT chk_certification_other CHECK (code <> 'OTHER' OR (custom_name IS NOT NULL AND custom_name <> '')),
  CONSTRAINT fk_consultant_certifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_work_experiences (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  company     VARCHAR(180) NOT NULL,
  title       VARCHAR(180) NOT NULL,
  started_on  DATE         NOT NULL,
  ended_on    DATE         NULL DEFAULT NULL,
  is_current  TINYINT(1)   NOT NULL DEFAULT 0,
  description TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_work_user (user_id, started_on),
  CONSTRAINT fk_work_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery history. The reference carries ONE `cloud` column per project, which is
-- adequate where an engagement is a Sales Cloud project or a Service Cloud project. An
-- SAP project is "FI, CO, MM and SD, with EWM in wave two" — a single column here would
-- force every consultant to pick one module and lose the rest, which is precisely the
-- part a hiring manager reads. So: a product line on the project, and the modules in a
-- side table.
CREATE TABLE consultant_projects (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  name          VARCHAR(200) NOT NULL,
  client        VARCHAR(180) NULL DEFAULT NULL,
  product_line  VARCHAR(64)  NULL DEFAULT NULL,
  role          VARCHAR(64)  NULL DEFAULT NULL,
  -- SAP Activate is the delivery method the whole ecosystem names its phases after, and
  -- contract roles are routinely scoped to one of them.
  activate_phase ENUM('discover','prepare','explore','realize','deploy','run') NULL DEFAULT NULL,
  is_full_lifecycle TINYINT(1) NOT NULL DEFAULT 0,
  started_on    DATE         NULL DEFAULT NULL,
  ended_on      DATE         NULL DEFAULT NULL,
  description   TEXT         NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_projects_user (user_id),
  CONSTRAINT fk_projects_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE consultant_project_modules (
  project_id  INT UNSIGNED NOT NULL,
  module_slug VARCHAR(64)  NOT NULL,
  PRIMARY KEY (project_id, module_slug),
  KEY idx_project_modules_slug (module_slug),
  CONSTRAINT fk_project_modules_project FOREIGN KEY (project_id) REFERENCES consultant_projects (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_profiles (
  user_id      INT UNSIGNED NOT NULL,
  company_name VARCHAR(200) NOT NULL,
  slug         VARCHAR(220) NOT NULL,
  tagline      VARCHAR(255) NULL DEFAULT NULL,
  about        TEXT         NULL,
  industry     VARCHAR(120) NULL DEFAULT NULL,
  company_size ENUM('1-10','11-50','51-200','201-1000','1000+') NULL DEFAULT NULL,
  company_type ENUM('end_customer','consulting_partner','isv','staffing') NOT NULL DEFAULT 'end_customer',
  website      VARCHAR(255) NULL DEFAULT NULL,
  linkedin_url VARCHAR(255) NULL DEFAULT NULL,
  country      CHAR(2)      NULL DEFAULT NULL,
  city         VARCHAR(120) NULL DEFAULT NULL,
  logo         VARCHAR(255) NULL DEFAULT NULL,
  is_public    TINYINT(1)   NOT NULL DEFAULT 1,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_company_slug (slug),
  KEY idx_company_public (is_public),
  CONSTRAINT fk_company_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_logos (
  user_id      INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_company_logos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
