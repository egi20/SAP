-- 018 Enquiries: the contact form and the issue reporter, in ONE table and ONE queue.
--
-- WHY THERE WAS NO FORM UNTIL NOW. /contact shipped as an address and a note saying why:
-- "a contact form needs somewhere to put what it collects, a spam defence and somebody
-- watching a queue; until all three exist, a mailto is the honest version — it cannot
-- silently drop a message the way an unwatched form can." This migration is the first of
-- the three. The other two arrive with it, or the comment was right and the form is worse
-- than what it replaced.
--
-- WHY ONE TABLE AND NOT TWO. A contact message and a reported issue are the same thing —
-- a person writing in and expecting an answer — differing only in which fields the form
-- asked for. Two tables means two admin screens, and the second one is the one nobody
-- opens. The rule this file exists to serve is "somebody is watching", and one queue is
-- easier to watch than two.
--
-- NO IP ADDRESS COLUMN, DELIBERATELY. It would help with abuse, and it is personal data
-- this application has not told anybody it collects on a public form. The spam defence is
-- a rate limit, a honeypot and a length floor, none of which has to be stored. A column
-- added later is a migration; a column added now is a commitment made quietly.

CREATE TABLE enquiries (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Which form produced it. Mirrored by Enquiry.KINDS, which a unit test compares against
  -- this ENUM — the same arrangement as Job.STATUSES and Moderation.SUBJECT_TYPES, and for
  -- the same reason: a value added to a dropdown and silently rejected behind it.
  kind            ENUM('contact', 'issue') NOT NULL,

  -- Who wrote. The account is recorded when there was one, and the typed name and email
  -- are kept either way: an enquiry is a snapshot of what was said, like an invoice, and
  -- re-reading the user row later would rewrite the message's own header.
  user_id         INT UNSIGNED NULL,
  name            VARCHAR(120)  NOT NULL,
  email           VARCHAR(190)  NOT NULL,

  subject         VARCHAR(200)  NOT NULL,
  body            TEXT          NOT NULL,

  -- Issue-only, and NULL for a contact message rather than defaulted: "not asked" and
  -- "answered with the first option" are different facts about the same column.
  issue_type      ENUM('bug', 'question', 'account', 'billing', 'abuse', 'other') NULL,
  severity        ENUM('low', 'normal', 'high') NULL,
  page_url        VARCHAR(500)  NULL,

  -- The queue. `new` is what arrives; a person moves it.
  status          ENUM('new', 'open', 'closed') NOT NULL DEFAULT 'new',
  handled_by      INT UNSIGNED NULL,
  handled_at      DATETIME     NULL,

  -- An administrator's own note, never shown to the person who wrote in.
  admin_note      TEXT         NULL,

  -- DATETIME with an explicit default, like every timestamp here: with
  -- explicit_defaults_for_timestamp disabled, MySQL gives the first TIMESTAMP column of a
  -- table an implicit ON UPDATE CURRENT_TIMESTAMP, which would re-date this row every time
  -- an administrator touched its status.
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_enquiries_queue (status, created_at),
  KEY idx_enquiries_kind (kind, status),
  CONSTRAINT fk_enquiries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_enquiries_handler FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL,

  -- An issue carries its issue fields and a contact message does not. Enforced here as
  -- well as in the model, because a rule held only by the handler that happens to be
  -- correct today is the shape this codebase keeps warning about.
  CONSTRAINT chk_enquiry_shape CHECK (
    (kind = 'issue' AND issue_type IS NOT NULL AND severity IS NOT NULL)
    OR (kind = 'contact' AND issue_type IS NULL AND severity IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
