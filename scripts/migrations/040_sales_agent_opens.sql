-- 040 Sales agent link opens, one row per counted open, with its time (2026-10-28).
--
-- `sales_agents.link_opens` (035) is a lifetime counter: it cannot answer "how many opened
-- the link in the last 24 hours", because an increment carries no date. This table records
-- WHEN each counted open happened, and nothing else — no IP, no session id, no user agent:
-- the same "looks like a person, once per session" decision in routes/index.js still
-- decides what is counted, and the row only dates it.
--
-- History cannot be reconstructed: opens counted before this migration have no time, so
-- the 24-hour figure starts at zero on the day this is deployed. The lifetime counter stays
-- the source of the "Opens" column and is incremented alongside, so it is not reset.
CREATE TABLE sales_agent_link_opens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_user_id  INT UNSIGNED    NOT NULL,
  opened_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agent_opens_time (agent_user_id, opened_at),
  CONSTRAINT fk_agent_open_agent FOREIGN KEY (agent_user_id) REFERENCES sales_agents (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
