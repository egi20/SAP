-- 029 Per-account access to the Dedupe tool, set from /admin/users.
--
-- Dynamics Hub keeps the same switch on every account, defaulting to blocked, and the
-- admin users screen toggles it. Here it is STORED and shown, and /dedupe does not read it
-- yet: SAP Hub's /dedupe is the narrow paste-a-list tool, public, stateless and linked
-- from the Services menu for every visitor, and gating it on a flag that is off for every
-- account would turn that menu entry into a refusal for everybody overnight. The column
-- exists now so that the day a stored, account-bound dedupe arrives, the decisions an
-- administrator has already made are there for it — the same argument as `voided_at` in
-- 004 and `hidden_at` in 009.
--
-- `dedupe_access_changed_by` names who flipped it, because a switch that grants access to a
-- tool is one somebody will later ask about.
ALTER TABLE users
  ADD COLUMN dedupe_access            TINYINT(1)   NOT NULL DEFAULT 0 AFTER is_active,
  ADD COLUMN dedupe_access_changed_at DATETIME     NULL DEFAULT NULL AFTER dedupe_access,
  ADD COLUMN dedupe_access_changed_by INT UNSIGNED NULL DEFAULT NULL AFTER dedupe_access_changed_at,
  ADD CONSTRAINT fk_users_dedupe_changed_by
    FOREIGN KEY (dedupe_access_changed_by) REFERENCES users (id) ON DELETE SET NULL;
