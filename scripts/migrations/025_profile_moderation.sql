-- 025 An administrator can take a consultant profile out of the directory.
--
-- Until now the only way to remove an inappropriate profile from a public listing was to
-- deactivate the whole account, which also ends their applications, their messages and
-- their community standing. That is a sledgehammer for a headline somebody should not have
-- written, and an administrator faced with only that choice makes the wrong one or none.
--
-- SEPARATE FROM `is_public`, and that separation is the whole point. `is_public` is the
-- member's own switch: they publish, they unpublish, and `recomputeCompleteness` lowers it
-- when their profile falls under the floor. If an administrator wrote to that same column
-- the member could undo the decision from their own settings page by pressing Publish
-- again — which is not a moderation action, it is a suggestion. Same shape as `hidden_at`
-- on `posts`: the member owns one column and a moderator owns another, and the directory
-- requires both to be clear.
--
-- Hidden, never deleted. The row, the delivery history and the engagements all stay, so a
-- decision can be undone and so the account's own owner still sees what they wrote.

ALTER TABLE consultant_profiles
  ADD COLUMN admin_hidden_at         DATETIME     NULL DEFAULT NULL AFTER is_public,
  ADD COLUMN admin_hidden_reason     VARCHAR(200) NULL DEFAULT NULL AFTER admin_hidden_at,
  ADD COLUMN admin_hidden_by_user_id INT UNSIGNED NULL DEFAULT NULL AFTER admin_hidden_reason,
  ADD CONSTRAINT fk_consultant_profiles_hidden_by
    FOREIGN KEY (admin_hidden_by_user_id) REFERENCES users (id) ON DELETE SET NULL;

-- And the moderation log learns a fourth subject, so this decision lands in the same place
-- as every other one. `Moderation.SUBJECT_TYPES` mirrors this ENUM and a unit test compares
-- the two — a vocabulary the schema owns gets exactly one copy in the code.
ALTER TABLE moderation_events
  MODIFY COLUMN subject_type ENUM('post', 'reply', 'rate_submission', 'consultant_profile') NOT NULL;
