-- 023 Closing an account.
--
-- A closed account is DEACTIVATED AND ERASED, never deleted. A DELETE of the user row
-- would cascade into the points ledger that is append-only so totals can be audited, the
-- commission ledger that records money somebody is owed, invoices that must not rewrite
-- themselves, one half of conversations the other party wrote, and the pipeline rows an
-- employer is working from.
--
-- `is_active = 0` already existed and already signs the account out on its next request.
-- These two columns record that the zero was a CLOSURE rather than an administrator's
-- suspension — two very different facts that the one flag cannot tell apart, and the
-- difference is what somebody writing in to ask "what happened to my account" needs.
--
-- `closed_reason` holds a short, optional line the member typed on the way out. It is not
-- a free-text survey anybody reads in bulk; it is there because the one question worth
-- asking at this moment is why, and throwing the answer away means asking it for nothing.

ALTER TABLE users
  ADD COLUMN closed_at     DATETIME     NULL DEFAULT NULL AFTER last_login_at,
  ADD COLUMN closed_reason VARCHAR(200) NULL DEFAULT NULL AFTER closed_at;
