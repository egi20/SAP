-- 013 Referrals and commissions.
--
-- Three tables, and the shape of them is the whole design:
--
--   referrers            who can earn, and at what rate
--   referral_attributions who introduced whom, once and permanently
--   commission_ledger    APPEND-ONLY, signed, in minor units
--
-- THE DECISION THAT SHAPES EVERYTHING: there is no balance column anywhere. A balance is
-- `SELECT SUM(amount_minor)` over the ledger, exactly as a points total is a SUM over
-- `points_ledger`. The reference implementation kept `pending_earnings`, `total_earnings`
-- and `paid_earnings` on the referrer row and maintained them alongside the rows they
-- counted; the moment those two disagree — a crash between two statements, a path that
-- updates one and not the other — nobody can say which is right, and this is real money
-- somebody is owed. A SUM cannot drift from itself.
--
-- Every amount is MINOR UNITS as a signed integer, for the same reason payments are. The
-- reference stored DECIMAL percentages and reconciled payouts with `parseFloat` plus a
-- `+ 0.001` tolerance in every comparison. That tolerance is the bug made visible.
--
-- Taken from the reference almost unchanged, and that is the finding rather than an
-- omission: this is the one area where the design arrived correct. What is new here is
-- the reversal path — see models/Referral.js — because a commission paid on money that
-- was later given back is a liability nothing in the reference could clear.

CREATE TABLE referrers (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,

  -- Shareable and read aloud, so the alphabet excludes I, L, O and U (config/referrals.js).
  code            CHAR(8)      NOT NULL,

  -- BASIS POINTS, integer. 1000 = 10.00%. `amount_minor * rate_bps / 10000` on integers
  -- is exact; a DECIMAL percentage through floating point is not.
  rate_bps        SMALLINT UNSIGNED NOT NULL,

  is_active       TINYINT(1)   NOT NULL DEFAULT 1,

  -- How they are actually paid. Free text for the reference (an IBAN, a PayPal address)
  -- because the shape differs per method and this application never transmits it anywhere
  -- — an administrator reads it and makes the transfer by hand.
  payout_method   VARCHAR(32)  NULL DEFAULT NULL,
  payout_reference VARCHAR(255) NULL DEFAULT NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One referrer profile per account, and one account per code.
  UNIQUE KEY uq_referrers_user (user_id),
  UNIQUE KEY uq_referrers_code (code),
  KEY idx_referrers_active (is_active),
  CONSTRAINT fk_referrers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who introduced whom.
--
-- UNIQUE on `referred_user_id`: an account is attributed ONCE, to whoever got there first,
-- and never re-attributed. Last-touch attribution would let anyone claim someone else's
-- introduction by getting a link in front of them the day before they pay, and a scheme
-- whose attribution can be stolen is a scheme with a fight in it.
--
-- `earns_until` is stamped at attribution rather than computed on read, so extending the
-- window in config never retroactively creates a liability on an introduction made years
-- ago under different terms.
CREATE TABLE referral_attributions (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id      INT UNSIGNED NOT NULL,
  referred_user_id INT UNSIGNED NOT NULL,

  -- Snapshot of the code and rate in force when the introduction happened. A referrer
  -- whose rate is renegotiated later does not have old introductions repriced.
  code             CHAR(8)      NOT NULL,
  rate_bps         SMALLINT UNSIGNED NOT NULL,

  earns_until      DATETIME     NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_attribution_referred (referred_user_id),
  KEY idx_attribution_referrer (referrer_id, created_at),
  CONSTRAINT fk_attribution_referrer FOREIGN KEY (referrer_id) REFERENCES referrers (id) ON DELETE CASCADE,
  CONSTRAINT fk_attribution_referred FOREIGN KEY (referred_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The money. Append-only: rows are never updated and never deleted.
--
-- `amount_minor` is SIGNED — an earning is positive, a payout is negative, a correction is
-- a compensating entry rather than an edit. A balance is the SUM, an unpaid balance is the
-- SUM of rows with no payout attached, and neither can disagree with the history because
-- they ARE the history.
--
-- `dedupe_key` is unique, so a redelivered Stripe webhook, a success-page race and a
-- retried request all produce exactly one entry. Same mechanism as `points_ledger`, and
-- here it is the difference between paying a commission once and paying it three times.
CREATE TABLE commission_ledger (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id     INT UNSIGNED NOT NULL,

  entry_type      ENUM('earned','paid','adjustment') NOT NULL,

  -- Signed minor units. Positive credits the referrer, negative debits them.
  amount_minor    INT          NOT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',

  -- What it came from, where there is one. NULL for a manual adjustment.
  payment_id      INT UNSIGNED NULL DEFAULT NULL,
  referred_user_id INT UNSIGNED NULL DEFAULT NULL,

  -- Which payout settled this entry. NULL means unpaid; set on the `earned` rows covered
  -- by a payout, in the same transaction that writes the payout's own negative entry.
  -- This is the ONE column on this table that is ever updated, and only from NULL.
  payout_id       INT UNSIGNED NULL DEFAULT NULL,

  -- Recorded even when the amount is zero: "your introduction bought something and it
  -- earned nothing, because that product does not pay commission" is information the
  -- referrer is owed, and dropping it leaves a gap they will ask about.
  note            VARCHAR(255) NULL DEFAULT NULL,

  dedupe_key      VARCHAR(190) NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_commission_dedupe (dedupe_key),
  KEY idx_commission_referrer (referrer_id, created_at),
  -- The query behind every balance: unpaid earnings for one referrer.
  KEY idx_commission_unpaid (referrer_id, payout_id),
  KEY idx_commission_payment (payment_id),
  CONSTRAINT fk_commission_referrer FOREIGN KEY (referrer_id) REFERENCES referrers (id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a payment must not erase the record of a commission
  -- that was already paid out on it.
  CONSTRAINT fk_commission_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_commission_referred FOREIGN KEY (referred_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A payout an administrator actually made, by hand, outside this system.
--
-- This table records that money LEFT — it does not move any. There is no automated
-- transfer here and there should not be: the Stripe integration collects, a person pays
-- out, and the gap between them is deliberate.
CREATE TABLE commission_payouts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  referrer_id     INT UNSIGNED NOT NULL,

  amount_minor    INT UNSIGNED NOT NULL,
  currency        CHAR(3)      NOT NULL DEFAULT 'EUR',

  method          VARCHAR(32)  NOT NULL,
  -- The bank or PayPal reference, so a query from the referrer can be traced to a transfer.
  reference       VARCHAR(255) NULL DEFAULT NULL,
  note            VARCHAR(255) NULL DEFAULT NULL,

  paid_by_user_id INT UNSIGNED NULL DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_payouts_referrer (referrer_id, created_at),
  CONSTRAINT fk_payouts_referrer FOREIGN KEY (referrer_id) REFERENCES referrers (id) ON DELETE CASCADE,
  CONSTRAINT fk_payouts_actor FOREIGN KEY (paid_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The ledger's payout pointer, added after the table it points at exists.
ALTER TABLE commission_ledger
  ADD CONSTRAINT fk_commission_payout FOREIGN KEY (payout_id) REFERENCES commission_payouts (id) ON DELETE SET NULL;
