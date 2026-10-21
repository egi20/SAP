-- 030 The issue reporter learns three things: ideas, a "critical" level, and screenshots.
--
-- IDEAS ARE ISSUE TYPES, NOT A FOURTH KIND. "Share an idea" on /report-issue is the same
-- object as a problem report — a person writing in and expecting somebody to read it — so it
-- lives in the same queue under the same CHECK (kind = 'issue' needs a type and a severity).
-- The idea_* prefix is what tells the two modes apart, and Enquiry.PROBLEM_TYPES /
-- Enquiry.IDEA_TYPES are the two halves of this one ENUM.
--
-- For an idea, `severity` holds its PRIORITY: low = "Nice to have", normal = "Important",
-- high = "Essential". The words differ by mode; the column answers the same question —
-- how much does this matter to the person who sent it — so it is not a second column.
-- `critical` (the system is down, or data is being lost) is offered for problems only.
ALTER TABLE enquiries
  MODIFY COLUMN issue_type ENUM('bug', 'question', 'account', 'billing', 'abuse', 'other',
                                'idea_feature', 'idea_improvement', 'idea_integration', 'idea_other') NULL,
  MODIFY COLUMN severity   ENUM('low', 'normal', 'high', 'critical') NULL;

-- The content somebody is reporting under "Someone's behaviour or content". Separate from
-- `page_url` (where the reporter was) because the two are different facts, and the
-- moderator needs the second one to act. Both are http(s) only, checked in the model.
ALTER TABLE enquiries
  ADD COLUMN content_url VARCHAR(500) NULL DEFAULT NULL AFTER page_url;

-- Screenshots attached to a report. IMAGES ONLY, re-encoded by sharp before they are
-- stored — the re-encode is the sanitiser, exactly as for profile photographs, and what an
-- administrator later opens is what sharp produced rather than whatever a stranger
-- uploaded. In the database rather than on disk because the host's disk is ephemeral.
-- Deleted with their enquiry, and on their own a stated time after it is closed (see the
-- Privacy policy and Enquiry.purgeExpiredAttachments).
CREATE TABLE enquiry_attachments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  enquiry_id   INT UNSIGNED NOT NULL,
  content_type VARCHAR(40)  NOT NULL,
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  width        INT UNSIGNED NULL DEFAULT NULL,
  height       INT UNSIGNED NULL DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_enquiry_attachments_enquiry (enquiry_id),
  CONSTRAINT fk_enquiry_attachments_enquiry
    FOREIGN KEY (enquiry_id) REFERENCES enquiries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
