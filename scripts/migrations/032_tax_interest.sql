-- 032 Who opens the tax optimisation page, and how far they get.
--
-- Three named steps of ONE funnel: the page (`landing`), a calculation that produced a
-- result (`calculator`) and the application form (`apply`). Not a page-view tracker — a
-- page is added here only by deciding it is worth naming people against.
--
-- One row per day, step and visitor. A signed-in member is named by `user_id`; everybody
-- signed out shares ONE row per day and step, keyed `user_key = 0`. That is why there are
-- two identity columns: a UNIQUE key never collides on NULL, so keying on the nullable
-- `user_id` would insert a fresh row for every anonymous hit. `user_key` is the user id or
-- 0, and `user_id` stays NULL for the anonymous row so the foreign key and the join work.
--
-- No IP address, no session id, no path: an anonymous view is counted, never identified.
-- Closing an account deletes the member's rows (models/AccountClosure.js), as it deletes
-- their tax applications.
CREATE TABLE tax_interest_views (
  day        DATE         NOT NULL,
  step       ENUM('landing', 'calculator', 'apply') NOT NULL,
  user_key   INT UNSIGNED NOT NULL DEFAULT 0,
  user_id    INT UNSIGNED NULL DEFAULT NULL,
  views      INT UNSIGNED NOT NULL DEFAULT 1,
  first_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, step, user_key),
  KEY idx_tax_interest_user (user_id),
  CONSTRAINT fk_tax_interest_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
