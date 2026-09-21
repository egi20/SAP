-- 010 Payments.
--
-- Two products today (featured job placements and quote deposits), but the shape is
-- deliberately generic: a payment names a PRODUCT and a SUBJECT, and fulfilment for each
-- product lives in its own table. Adding a third product adds a resolver in
-- config/payments.js and a fulfilment table here — it does not touch this one.
--
-- The idempotency story is in the SCHEMA, not in a code path:
--
--   * `stripe_session_id` is UNIQUE, so a redelivered webhook cannot create a second
--     payment for the same checkout.
--   * every fulfilment table has a UNIQUE key on `payment_id`, so fulfilling twice for
--     one payment is a duplicate-key error rather than a double credit.
--   * a fulfilment table for an EXCLUSIVE product also carries a unique key on its
--     subject (`quote_deposits.quote_id`), which is the guard the per-payment key cannot
--     give: two checkout sessions opened against one quote produce two DIFFERENT
--     payments, and only one of them may settle it.
--
-- Nothing here relies on "check, then insert". The database decides the winner.

CREATE TABLE payments (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Quotable on an invoice and in a support conversation. Same alphabet as quote
  -- references: no I, L, O or U, because those are what people mistype off a document.
  reference     CHAR(14)     NOT NULL,

  user_id       INT UNSIGNED NOT NULL,

  -- Catalogue key from config/payments.js. Not an ENUM: adding a product should not
  -- require an ALTER on a table holding financial history.
  product       VARCHAR(40)  NOT NULL,
  subject_type  VARCHAR(32)  NOT NULL,
  subject_id    INT UNSIGNED NULL DEFAULT NULL,

  -- MINOR UNITS, integer. Every amount in this schema is cents, so a total always equals
  -- the sum of its parts exactly. A DECIMAL would be defensible; a FLOAT never is.
  amount_minor  INT UNSIGNED NOT NULL,
  currency      CHAR(3)      NOT NULL DEFAULT 'EUR',

  -- What the price was derived FROM, captured at checkout: the percentage, the quote
  -- total it was taken of, the clamps in force. An invoice must be explicable years
  -- later without re-deriving anything from a catalogue that has since moved.
  price_basis   JSON         NULL,

  description   VARCHAR(255) NOT NULL,

  status        ENUM('pending','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'pending',

  stripe_session_id        VARCHAR(255) NULL DEFAULT NULL,
  stripe_payment_intent_id VARCHAR(255) NULL DEFAULT NULL,

  -- Set when money arrived but the subject was already settled by a different payment
  -- (two checkout tabs, one quote). The loser is never auto-refunded: a refund is a
  -- decision with a human on the other end of it, so this flags the row for the admin
  -- queue and nothing more.
  needs_refund  TINYINT(1)   NOT NULL DEFAULT 0,

  paid_at       DATETIME     NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_reference (reference),
  UNIQUE KEY uq_payments_session (stripe_session_id),
  KEY idx_payments_user (user_id, created_at),
  KEY idx_payments_subject (product, subject_id),
  KEY idx_payments_status (status, created_at),
  KEY idx_payments_refund (needs_refund, created_at),
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, for the same reason applications and quotes have one, only more so:
-- "when did this become paid, and what did Stripe tell us" must always have an answer,
-- including for the events that changed nothing (a redelivered webhook, a losing
-- session). Rows are never updated and never deleted.
CREATE TABLE payment_events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id  INT UNSIGNED NULL DEFAULT NULL,
  event_type  VARCHAR(64)  NOT NULL,

  -- Stripe's own event id where there is one. UNIQUE, so recording a redelivery is an
  -- INSERT IGNORE no-op rather than a duplicated line of history.
  stripe_event_id VARCHAR(255) NULL DEFAULT NULL,

  detail      VARCHAR(500) NULL DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_events_stripe (stripe_event_id, event_type),
  KEY idx_payment_events_payment (payment_id, created_at),
  CONSTRAINT fk_payment_events_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One invoice per settled payment. The unique key on payment_id is the whole
-- idempotency guarantee for billing: a duplicate webhook cannot bill twice.
--
-- The buyer's details are SNAPSHOT here rather than joined from the profile. An invoice
-- states who was billed on a date; a profile edit two years later must not rewrite it.
CREATE TABLE invoices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  number         VARCHAR(24)  NOT NULL,
  payment_id     INT UNSIGNED NOT NULL,
  user_id        INT UNSIGNED NOT NULL,

  bill_to_name    VARCHAR(200) NOT NULL,
  bill_to_email   VARCHAR(255) NOT NULL,
  bill_to_company VARCHAR(200) NULL DEFAULT NULL,

  description    VARCHAR(255) NOT NULL,

  subtotal_minor INT UNSIGNED NOT NULL,
  tax_minor      INT UNSIGNED NOT NULL DEFAULT 0,
  total_minor    INT UNSIGNED NOT NULL,
  currency       CHAR(3)      NOT NULL DEFAULT 'EUR',

  issued_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_number (number),
  UNIQUE KEY uq_invoices_payment (payment_id),
  KEY idx_invoices_user (user_id, issued_at),
  CONSTRAINT fk_invoices_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE,
  CONSTRAINT fk_invoices_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fulfilment: a featured window on a job.
--
-- NO unique key on job_id, and that is the design: buying a second window while one is
-- running EXTENDS the job's featured period rather than colliding with it. The browse
-- query asks "is there a row whose window contains now", so overlapping rows are
-- harmless and a renewal needs no special case.
CREATE TABLE job_features (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id     INT UNSIGNED NOT NULL,
  payment_id INT UNSIGNED NOT NULL,
  starts_at  DATETIME     NOT NULL,
  ends_at    DATETIME     NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_features_payment (payment_id),
  KEY idx_job_features_window (job_id, ends_at),
  KEY idx_job_features_active (ends_at, starts_at),
  CONSTRAINT fk_job_features_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_features_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fulfilment: the deposit taken against a quote.
--
-- UNIQUE on quote_id as well as on payment_id. The second key is what stops two checkout
-- sessions, opened against one quote in two tabs, from both settling it: they are two
-- different payments, so the per-payment key cannot see the collision — this one can.
-- The losing INSERT fails, and its payment is flagged `needs_refund` rather than being
-- silently swallowed or automatically reversed.
CREATE TABLE quote_deposits (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  quote_id      INT UNSIGNED NOT NULL,
  payment_id    INT UNSIGNED NOT NULL,

  -- Snapshot of what the deposit was a percentage OF, at the moment it was taken.
  amount_minor  INT UNSIGNED NOT NULL,
  percent       DECIMAL(5,2) NOT NULL,
  quote_total   DECIMAL(12,2) NOT NULL,
  currency      CHAR(3)      NOT NULL DEFAULT 'EUR',

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quote_deposits_quote (quote_id),
  UNIQUE KEY uq_quote_deposits_payment (payment_id),
  CONSTRAINT fk_quote_deposits_quote FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE,
  CONSTRAINT fk_quote_deposits_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
