-- 031 What happens after a report is sent, and ideas others can vote on.
--
-- `env_info` holds the browser and device line a reporter chose to include with the
-- optional checkbox on /report-issue: the user-agent string and the screen and window
-- sizes, nothing else. NULL when the box was left unticked, which is the default — "not
-- given" and "given as nothing" are different facts, as for the issue fields in 018.
--
-- A SHARED IDEA BECOMES PUBLIC ONLY WITH TWO SWITCHES: the person who sent it ticked
-- `publish_consent` on the form, AND an administrator published it (`published_at`). The
-- first is the sender's say over their own words; the second is a person reading it before
-- strangers do, because an idea box is a free-text field and the queue is where it is read.
-- Neither alone puts anything on /ideas. The sender's name is never shown there.
ALTER TABLE enquiries
  ADD COLUMN env_info          VARCHAR(400) NULL DEFAULT NULL AFTER content_url,
  ADD COLUMN publish_consent   TINYINT(1)   NOT NULL DEFAULT 0 AFTER env_info,
  ADD COLUMN published_at      DATETIME     NULL DEFAULT NULL AFTER publish_consent,
  ADD COLUMN published_by      INT UNSIGNED NULL DEFAULT NULL AFTER published_at,
  ADD CONSTRAINT fk_enquiries_published_by
    FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE SET NULL,
  ADD KEY idx_enquiries_published (published_at);

-- One vote per member per idea, held by the key rather than by a check in the handler.
-- Votes are counted, never shown with names, and go with the idea if it is ever deleted.
CREATE TABLE idea_votes (
  enquiry_id INT UNSIGNED NOT NULL,
  user_id    INT UNSIGNED NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (enquiry_id, user_id),
  KEY idx_idea_votes_user (user_id),
  CONSTRAINT fk_idea_votes_enquiry FOREIGN KEY (enquiry_id) REFERENCES enquiries (id) ON DELETE CASCADE,
  CONSTRAINT fk_idea_votes_user    FOREIGN KEY (user_id)    REFERENCES users (id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
