-- 035 Sales agents: the Hub's own people, each with a personal sign-up link, as on
-- dynamicshub.net's "Sales Agents" tab (owner's request, 2026-10-22).
--
-- A sales agent is NOT a referrer. A referrer is anybody who joined the commission scheme
-- and is paid from `commission_ledger`; an agent is a colleague the owner promoted, whose
-- link is MEASURED and pays nothing. Routing staff through the referral scheme would start
-- paying salaried people per sign-up, so the two have separate tables and separate links
-- (`/s/<code>` here, `?ref=<code>` there) and one account can be both.
--
-- `users.sales_agent_id` is FIRST-TOUCH and written once, at registration, by
-- `SalesAgent.attribute` with `WHERE sales_agent_id IS NULL`: a later link cannot take a
-- sign-up from the colleague who brought it in. It points at the agent's USER id, so an
-- agent removed from the list keeps the history of who they brought in.
--
-- `link_opens` is a counter of people, not requests — see `routes/index.js`.
CREATE TABLE sales_agents (
  user_id          INT UNSIGNED NOT NULL,
  code             CHAR(8)      NOT NULL,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  link_opens       INT UNSIGNED NOT NULL DEFAULT 0,
  added_by         INT UNSIGNED NULL DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_sales_agent_code (code),
  CONSTRAINT fk_sales_agent_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_agent_added_by FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN sales_agent_id INT UNSIGNED NULL DEFAULT NULL,
  ADD KEY idx_users_sales_agent (sales_agent_id),
  ADD CONSTRAINT fk_users_sales_agent FOREIGN KEY (sales_agent_id) REFERENCES users (id) ON DELETE SET NULL;
