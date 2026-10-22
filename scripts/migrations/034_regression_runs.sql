-- 034 Runs of the in-app regression suite, Admin › Automated Tests (config/regressionTests.js).
--
-- The CASES are not stored: the library is code, so a corrected case is corrected
-- everywhere at once. What is stored is what a person decided and what happened:
--
--   regression_case_switches  a case an administrator switched off, keyed on its name. A
--                             name that leaves the library leaves an orphan row, which
--                             matches nothing and costs nothing.
--   regression_runs           one row per press of a Run button, with its tally.
--   regression_results        one row per case per run. No response body: a page rendered
--                             for a QA account is still a page, and a body copied into a
--                             table is a second place it lives. The reason a case failed
--                             is enough to go and look.
CREATE TABLE regression_case_switches (
  case_name        VARCHAR(191) NOT NULL,
  enabled          TINYINT(1)   NOT NULL DEFAULT 1,
  updated_by       INT UNSIGNED NULL DEFAULT NULL,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (case_name),
  CONSTRAINT fk_regression_switch_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE regression_runs (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope            VARCHAR(120) NOT NULL,
  started_by       INT UNSIGNED NULL DEFAULT NULL,
  started_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at      DATETIME     NULL DEFAULT NULL,
  total            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  passed           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  failed           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  skipped          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms      INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_regression_runs_started (started_at),
  CONSTRAINT fk_regression_run_user FOREIGN KEY (started_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE regression_results (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id           INT UNSIGNED NOT NULL,
  case_name        VARCHAR(191) NOT NULL,
  category         VARCHAR(80)  NOT NULL,
  path             VARCHAR(255) NOT NULL,
  role             VARCHAR(20)  NULL DEFAULT NULL,
  outcome          ENUM('passed', 'failed', 'skipped') NOT NULL,
  status_code      SMALLINT UNSIGNED NULL DEFAULT NULL,
  duration_ms      INT UNSIGNED NOT NULL DEFAULT 0,
  message          VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_regression_results_run (run_id, outcome),
  CONSTRAINT fk_regression_result_run FOREIGN KEY (run_id) REFERENCES regression_runs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
