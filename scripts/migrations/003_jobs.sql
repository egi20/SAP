-- 003 Job board and hiring pipeline.

CREATE TABLE jobs (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_user_id INT UNSIGNED NOT NULL,
  title           VARCHAR(200) NOT NULL,
  slug            VARCHAR(240) NOT NULL,
  description     MEDIUMTEXT   NOT NULL,

  -- Taxonomy slug from config/roleTaxonomy.js.
  role            VARCHAR(64)  NOT NULL,
  seniority       ENUM('junior','mid','senior','lead') NOT NULL DEFAULT 'senior',
  engagement_type ENUM('contract','permanent') NOT NULL DEFAULT 'contract',
  work_mode       ENUM('remote','hybrid','onsite') NOT NULL DEFAULT 'remote',

  country         CHAR(2)      NULL DEFAULT NULL,
  city            VARCHAR(120) NULL DEFAULT NULL,

  -- For contracts these are day rates; for permanent roles, annual salary.
  rate_min        DECIMAL(10,2) NULL DEFAULT NULL,
  rate_max        DECIMAL(10,2) NULL DEFAULT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',
  rate_visible    TINYINT(1)   NOT NULL DEFAULT 1,

  duration_months TINYINT UNSIGNED NULL DEFAULT NULL,
  starts_on       DATE         NULL DEFAULT NULL,

  -- The SAP Activate phase this role is scoped to, when it is scoped to one. An advert
  -- for a realize-phase FI consultant and one for a run-phase FI consultant are
  -- different jobs asking for different people, and this ecosystem says which. NULL
  -- means the role spans phases, which is the honest answer for a permanent hire.
  activate_phase  ENUM('discover','prepare','explore','realize','deploy','run') NULL DEFAULT NULL,

  status          ENUM('draft','open','paused','filled','closed') NOT NULL DEFAULT 'draft',
  published_at    DATETIME     NULL DEFAULT NULL,
  expires_at      DATETIME     NULL DEFAULT NULL,

  view_count      INT UNSIGNED NOT NULL DEFAULT 0,
  application_count INT UNSIGNED NOT NULL DEFAULT 0,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_jobs_slug (slug),
  KEY idx_jobs_browse (status, published_at),
  KEY idx_jobs_role (role, status),
  KEY idx_jobs_company (company_user_id, status),
  KEY idx_jobs_country (country, status),
  KEY idx_jobs_phase (activate_phase, status),
  FULLTEXT KEY ft_jobs_search (title, description),
  CONSTRAINT fk_jobs_company FOREIGN KEY (company_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE job_skills (
  job_id   INT UNSIGNED NOT NULL,
  skill_id INT UNSIGNED NOT NULL,
  required TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (job_id, skill_id),
  KEY idx_job_skills_skill (skill_id),
  CONSTRAINT fk_job_skills_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_skills_skill FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which SAP modules the engagement touches (config/sapProducts.js).
CREATE TABLE job_modules (
  job_id      INT UNSIGNED NOT NULL,
  module_slug VARCHAR(64)  NOT NULL,
  PRIMARY KEY (job_id, module_slug),
  CONSTRAINT fk_job_modules_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applications (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id          INT UNSIGNED NOT NULL,
  consultant_user_id INT UNSIGNED NOT NULL,
  cover_letter    TEXT         NULL,
  day_rate        DECIMAL(10,2) NULL DEFAULT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',
  available_from  DATE         NULL DEFAULT NULL,
  status          ENUM('submitted','reviewing','shortlisted','interviewing','offered','hired','rejected','withdrawn')
                  NOT NULL DEFAULT 'submitted',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One live application per consultant per job. Re-applying reopens the same row.
  UNIQUE KEY uq_application (job_id, consultant_user_id),
  KEY idx_applications_consultant (consultant_user_id, status),
  KEY idx_applications_job_status (job_id, status),
  CONSTRAINT fk_applications_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_applications_consultant FOREIGN KEY (consultant_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit of every status transition. Never updated, never deleted except
-- by cascade, so "who moved this candidate and when" always has an answer.
CREATE TABLE application_events (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id INT UNSIGNED NOT NULL,
  actor_user_id  INT UNSIGNED NULL DEFAULT NULL,
  from_status    VARCHAR(32)  NULL DEFAULT NULL,
  to_status      VARCHAR(32)  NOT NULL,
  note           VARCHAR(500) NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_application_events_app (application_id, created_at),
  CONSTRAINT fk_application_events_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_application_events_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE saved_jobs (
  user_id    INT UNSIGNED NOT NULL,
  job_id     INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, job_id),
  KEY idx_saved_jobs_job (job_id),
  CONSTRAINT fk_saved_jobs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_saved_jobs_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
