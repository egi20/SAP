-- 045 Sales agent TAX link opens, one row per counted open, with its time (2026-11-12).
--
-- The owner asked, for all three hubs, that every sales agent also has a personal link to
-- the tax optimisation page — the SAME code as the sign-up link, `/t/<code>` instead of
-- `/s/<code>` — and that the agents' tab says how many opened it, in total and in the last
-- 24 hours, beside the sign-up figures.
--
-- Unlike the sign-up link there is no lifetime counter to keep alongside: this table starts
-- the day the link exists, so it IS the count (COUNT(*) for the total, a window for 24h).
-- Same discipline as 040: the agent and the time, nothing else — no IP, no session id, no
-- user agent. What is counted is decided in utils/agentOpens.js, once per session per
-- agent, separately from the sign-up link so opening one never uses up the other.
CREATE TABLE sales_agent_tax_opens (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  agent_user_id  INT UNSIGNED    NOT NULL,
  opened_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agent_tax_opens_time (agent_user_id, opened_at),
  CONSTRAINT fk_agent_tax_open_agent FOREIGN KEY (agent_user_id) REFERENCES sales_agents (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
