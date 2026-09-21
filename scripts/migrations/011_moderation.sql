-- 011 Moderation: the log of what was taken down, by whom, and why.
--
-- The columns being acted on already exist — `posts.hidden_at` and `post_replies.hidden_at`
-- from 009, `rate_submissions.voided_at` from 004 — because a guard that is only
-- aspirational is not a guard, and both models filtered on them from their first query.
-- What was missing is the record of WHO decided and WHY, which is the half that makes a
-- moderation decision reviewable rather than merely effective.

CREATE TABLE moderation_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What was acted on. Deliberately NOT a foreign key: the log has to outlive its subject,
  -- and a cascade from `posts` would delete the evidence along with the post. The three
  -- values are pinned by Moderation.SUBJECT_TYPES and by the ENUM here.
  subject_type    ENUM('post', 'reply', 'rate_submission') NOT NULL,
  subject_id      BIGINT UNSIGNED NOT NULL,

  -- `hide`/`restore` for content, `void`/`reinstate` for a rate submission. The wording is
  -- not cosmetic: hiding is about speech, voiding is about arithmetic, and a screen that
  -- called both "delete" would be inviting the wrong decision for one of them.
  action          ENUM('hide', 'restore', 'void', 'reinstate') NOT NULL,

  -- Who acted, and whose content it was. Both SET NULL rather than CASCADE: an account
  -- closing must not erase the fact that a decision was taken, and "an administrator who
  -- has since left" is still a truer record than no row at all.
  actor_user_id   INT UNSIGNED NULL DEFAULT NULL,
  subject_user_id INT UNSIGNED NULL DEFAULT NULL,

  reason          VARCHAR(200) NULL DEFAULT NULL,

  -- DATETIME, not TIMESTAMP. See CLAUDE.md: with explicit_defaults_for_timestamp off,
  -- MySQL gives the first TIMESTAMP column an implicit ON UPDATE CURRENT_TIMESTAMP, and a
  -- log entry that re-dates itself is not a log entry.
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_moderation_subject (subject_type, subject_id, id),
  KEY idx_moderation_member (subject_user_id, created_at),
  KEY idx_moderation_recent (created_at),

  CONSTRAINT fk_moderation_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_moderation_member FOREIGN KEY (subject_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
