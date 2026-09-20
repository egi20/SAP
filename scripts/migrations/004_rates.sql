-- 004 Day rate index.
--
-- PRIVACY FLOOR (carried over verbatim): no aggregate derived from fewer than
-- config.rates.minSampleSize DISTINCT PEOPLE may ever be published. The count is of
-- people, not submissions, which is why `user_id` is stored on every row and why the
-- unique key below keeps one submission per person per role per period. Aggregation
-- keeps the count while nulling the values, so the UI can honestly say "not enough
-- data" instead of rendering a misleading point.

CREATE TABLE rate_submissions (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,

  role            VARCHAR(64)  NOT NULL,
  seniority       ENUM('junior','mid','senior','lead') NOT NULL,
  engagement_type ENUM('contract','permanent') NOT NULL DEFAULT 'contract',
  work_mode       ENUM('remote','hybrid','onsite') NOT NULL DEFAULT 'remote',
  country         CHAR(2)      NOT NULL,

  -- Day rate for contract, annual salary for permanent. Always normalised to
  -- `amount_eur` at submission time so aggregates never mix currencies.
  amount          DECIMAL(10,2) NOT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',
  amount_eur      DECIMAL(10,2) NOT NULL,

  -- YYYY-MM bucket the submission counts towards.
  period          CHAR(7)      NOT NULL,

  /*
   * A voided submission is excluded from every aggregate, and the column is HERE rather
   * than arriving with moderation.
   *
   * The reference adds it in its moderation migration, twelve files later, while the rate
   * model was already written to filter on it — so the index worked only because nothing
   * had voided anything yet. Voiding is a rate-index concept before it is a moderation
   * feature: an obviously wrong figure has to be removable from a published percentile,
   * and `voided_at IS NULL` is already in every query in models/RateSubmission.js and is
   * deliberately not a filter a caller can turn off. The admin screen that sets it is a
   * later area; the column it writes to is part of the index from the first migration, so
   * the guard is real rather than aspirational.
   */
  voided_at       DATETIME     NULL DEFAULT NULL,
  voided_by       INT UNSIGNED NULL DEFAULT NULL,
  void_reason     VARCHAR(255) NULL DEFAULT NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_rate_submission (user_id, role, seniority, engagement_type, period),
  KEY idx_rates_bucket (role, seniority, engagement_type, country, period),
  KEY idx_rates_period (period),
  KEY idx_rates_voided (voided_at),
  CONSTRAINT fk_rate_submissions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_rate_submissions_voided_by FOREIGN KEY (voided_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
