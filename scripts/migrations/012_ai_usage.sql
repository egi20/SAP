-- 012 The AI spend ledger.
--
-- The assistant is a PUBLIC endpoint that costs money per request, so the thing that
-- bounds the invoice is not a rate limiter — rate limiting bounds requests per address,
-- and five hundred addresses each staying politely under the limit still produce an
-- unbounded bill. This table is what the circuit-breaker reads.
--
-- It is a ledger for the same reason `points_ledger` is: a single "spent this month"
-- counter could not be audited, and a budget nobody can reconcile against an invoice is a
-- number rather than a control.

CREATE TABLE ai_usage (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Which feature spent it. One row per call, so a second AI feature later does not need
  -- its own table and the cap can be read per feature or across all of them.
  feature       VARCHAR(40)  NOT NULL,
  model         VARCHAR(80)  NOT NULL,

  -- NULL for an anonymous visitor, who faces only the global cap: there is nothing
  -- durable to key a per-person total on, which is exactly why the IP and process-wide
  -- rate limiters exist alongside it. ON DELETE SET NULL — a closed account must not
  -- erase what was spent, or the month-to-date total moves when somebody leaves.
  user_id       INT UNSIGNED NULL DEFAULT NULL,

  input_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,

  -- DECIMAL, not FLOAT. These are summed and compared against a cap, and binary floating
  -- point makes a total that disagrees with itself depending on the order of the rows.
  -- Six decimal places because one short answer costs a fraction of a cent.
  cost_usd      DECIMAL(12,6) NOT NULL DEFAULT 0,

  outcome       ENUM('ok','error') NOT NULL DEFAULT 'ok',

  -- DATETIME, not TIMESTAMP — see CLAUDE.md. A ledger row that re-dates itself on an
  -- unrelated UPDATE would move spend between months.
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The two queries the circuit-breaker makes, in the order it makes them.
  KEY idx_ai_usage_month (created_at),
  KEY idx_ai_usage_user_month (user_id, created_at),

  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
