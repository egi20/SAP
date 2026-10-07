-- 024 Tax optimisation applications: what /tax/apply collects.
--
-- The calculator on /tax arrived by the owner's decision on 2026-10-07, reversing the
-- standing refusal in docs/PORT-PLAN.md; see config/taxProgram.js. This is where the
-- application form behind it puts what it collects, and /admin/tax-applications is the
-- queue somebody watches — the same three-part rule the contact form waited on.
--
-- It holds a person's salary, take-home pay and tax rate beside their name and phone
-- number, which is the most sensitive row in this database. So:
--   * NO IP address column, for the same reason enquiries has none;
--   * the estimate is computed by the SERVER from the gross and net posted, never read
--     from a hidden field the browser filled in;
--   * the row is deleted when its account is closed (models/AccountClosure.js), because
--     it is only about that person;
--   * the queue is superadmin-only, like /admin/rates.

CREATE TABLE tax_applications (
  id                          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id                     INT UNSIGNED NULL,

  full_name                   VARCHAR(200)  NOT NULL,
  email                       VARCHAR(190)  NOT NULL,
  phone                       VARCHAR(50)   NOT NULL,
  linkedin_url                VARCHAR(500)  NULL,
  city                        VARCHAR(120)  NULL,
  timezone                    VARCHAR(80)   NULL,

  current_country             VARCHAR(80)   NOT NULL,
  employment_type             VARCHAR(80)   NOT NULL,
  current_employer            VARCHAR(200)  NULL,
  notice_period               VARCHAR(40)   NULL,
  contract_end_date           DATE          NULL,
  availability_date           DATE          NULL,

  -- Whole euros. The form asks for monthly figures in euros and nobody types cents.
  current_gross_monthly       INT UNSIGNED  NOT NULL,
  current_net_monthly         INT UNSIGNED  NOT NULL,
  current_daily_rate          INT UNSIGNED  NULL,
  desired_daily_rate          INT UNSIGNED  NULL,
  current_tax_rate_percent    DECIMAL(5,2)  NULL,
  billing_currency            CHAR(3)       NOT NULL DEFAULT 'EUR',
  has_vat_number              TINYINT(1)    NOT NULL DEFAULT 0,

  job_title                   VARCHAR(200)  NOT NULL,
  years_experience            VARCHAR(20)   NULL,
  primary_skills              VARCHAR(1000) NOT NULL,
  certifications              VARCHAR(1000) NULL,
  languages                   VARCHAR(500)  NULL,
  client_industries           VARCHAR(500)  NULL,

  remote_preference           VARCHAR(40)   NULL,
  availability_hours_per_week VARCHAR(40)   NULL,
  has_existing_clients        TINYINT(1)    NOT NULL DEFAULT 0,
  open_to_travel              TINYINT(1)    NOT NULL DEFAULT 0,

  how_heard_about_us          VARCHAR(80)   NULL,
  referral_code               VARCHAR(40)   NULL,
  additional_notes            TEXT          NULL,
  specific_questions          TEXT          NULL,

  -- Computed by config/taxProgram.js `estimate()` at submission, from the figures above.
  -- Signed: a structure that would LOWER somebody's take-home is a real answer.
  estimated_monthly_savings   INT           NULL,
  estimated_annual_savings    INT           NULL,

  -- When the person ticked the consent box. Required by the form; stored so the row
  -- carries its own proof that contacting them was agreed.
  consented_at                DATETIME      NOT NULL,

  status                      ENUM('new', 'open', 'closed') NOT NULL DEFAULT 'new',
  handled_by                  INT UNSIGNED  NULL,
  handled_at                  DATETIME      NULL,
  admin_note                  TEXT          NULL,

  -- DATETIME with an explicit default, like every timestamp here. See CLAUDE.md.
  created_at                  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_tax_applications_queue (status, created_at),
  KEY idx_tax_applications_user (user_id),
  CONSTRAINT fk_tax_applications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_tax_applications_handler FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
