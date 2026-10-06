-- 026 An administrator can take a job advert down.
--
-- The same gap migration 025 closed for consultant profiles, on the other side of the
-- marketplace: there was no way at all to remove an advert that breaks the rules short of
-- deactivating the company account, which also ends their other adverts, their pipeline
-- and the threads anchored to them.
--
-- SEPARATE FROM `status`, for the reason `admin_hidden_at` is separate from `is_public`.
-- `status` is the advertiser's own lifecycle — draft, open, paused, filled, closed — and
-- they move it freely. If a moderator wrote `closed` there the advertiser would reopen it
-- from their own page and the decision would be a suggestion. Two columns, and the board
-- requires both to be clear.
--
-- The advert is HIDDEN, never deleted: the applications made to it, their audit events and
-- the conversations anchored to it all belong to other people, and they stay.
ALTER TABLE jobs
  ADD COLUMN admin_hidden_at         DATETIME     NULL DEFAULT NULL AFTER status,
  ADD COLUMN admin_hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER admin_hidden_at,
  ADD COLUMN admin_hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER admin_hidden_reason,
  ADD CONSTRAINT fk_jobs_hidden_by
    FOREIGN KEY (admin_hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE moderation_events
  MODIFY COLUMN subject_type ENUM('post', 'reply', 'rate_submission', 'consultant_profile', 'job') NOT NULL;
