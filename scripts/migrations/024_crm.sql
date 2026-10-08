-- 024 The internal sales CRM.
--
-- READ THIS BEFORE CHANGING ANYTHING HERE. Every other table in this schema holds data
-- somebody gave us. This one holds the names, addresses, phone numbers and job titles of
-- people who never asked to be contacted, so that somebody can contact them. That is a
-- different kind of object, and the structure below is what makes holding it defensible.

-- THE SUPPRESSION LIST, DECLARED FIRST, because it outranks everything under it.
--
-- Keyed on a SHA-256 of the lower-cased address and holding NO address, for one reason
-- worth stating plainly: a suppression list full of plaintext addresses is a mailing list
-- of people who specifically asked not to be mailed. Hashed, it answers the only question
-- it has to answer — "is this address on it?" — and answers nothing else.
--
-- NO foreign key to `crm_leads`, and that absence is the design. Deleting a lead is
-- exactly how an application loses the fact that its subject asked never to be contacted,
-- and the next quarterly import writes them straight back in. Nothing in this application
-- deletes from this table.
CREATE TABLE crm_suppressions (
  email_hash  CHAR(64)     NOT NULL,

  -- Why they are suppressed. Never who they are.
  reason      VARCHAR(32)  NOT NULL DEFAULT 'requested',
  note        VARCHAR(500) NULL DEFAULT NULL,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by  INT UNSIGNED NULL DEFAULT NULL,

  PRIMARY KEY (email_hash),
  CONSTRAINT fk_crm_suppressions_actor FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crm_leads (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- A company is an organisation, not a person, and it is the one field that survives an
  -- unsubscribe. "Somebody at this company asked not to be contacted" is a fact worth
  -- keeping; who they were is not.
  company        VARCHAR(200) NOT NULL,

  contact_name   VARCHAR(200) NULL DEFAULT NULL,
  contact_email  VARCHAR(190) NULL DEFAULT NULL,
  contact_phone  VARCHAR(40)  NULL DEFAULT NULL,
  job_title      VARCHAR(200) NULL DEFAULT NULL,

  country        CHAR(2)      NULL DEFAULT NULL,
  website        VARCHAR(500) NULL DEFAULT NULL,
  linkedin_url   VARCHAR(500) NULL DEFAULT NULL,

  -- Product lines from config/sapProducts.js, the same vocabulary the job board, the
  -- community tree and the estimator speak. Not free text and not a new taxonomy: a CRM
  -- with its own list of "what they run" is the fifth place SAP's product names would be
  -- written down, and the first to drift.
  product_lines  JSON         NULL DEFAULT NULL,

  -- NOT NULL, validated against config/crm.js, and FIRST-TOUCH: a re-import updates the
  -- contact details and never this. It is the lawful-basis record, and a record a later
  -- file can rewrite is not one — the same argument as `referral_attributions`.
  source         VARCHAR(32)  NOT NULL,
  source_detail  VARCHAR(300) NULL DEFAULT NULL,

  status         VARCHAR(32)  NOT NULL DEFAULT 'new',

  -- Denormalised from `crm_lead_activities` inside the transaction that writes one,
  -- exactly as `posts.reply_count` is: it is what lets the board sort without aggregating.
  last_activity_at DATETIME   NULL DEFAULT NULL,

  -- Set when an unsubscribe erased the contact details. The row that remains carries no
  -- personal data and exists so the company is not re-imported blind.
  erased_at      DATETIME     NULL DEFAULT NULL,

  owner_user_id  INT UNSIGNED NULL DEFAULT NULL,
  created_by     INT UNSIGNED NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One row per address, so an import that runs twice updates rather than duplicating —
  -- which is what stops one person being written to by two people who each thought the
  -- lead was theirs. A NULL never collides in SQL, so a lead with only a phone number is
  -- still allowed, and so is an erased row.
  UNIQUE KEY uq_crm_leads_email (contact_email),

  KEY idx_crm_leads_status (status, last_activity_at),
  KEY idx_crm_leads_company (company),
  KEY idx_crm_leads_owner (owner_user_id),
  KEY idx_crm_leads_stale (last_activity_at),

  CONSTRAINT fk_crm_leads_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_crm_leads_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, like every other event table here. No edit, no delete.
--
-- "Who contacted this person, when, through what, and what happened" is the record that
-- answers a complaint, and a record somebody can tidy up is not one. It deliberately
-- carries NO contact details of its own, so that erasing a lead's details leaves this log
-- intact and personal-data-free.
CREATE TABLE crm_lead_activities (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id       INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,

  channel       VARCHAR(32)   NULL DEFAULT NULL,
  outcome       VARCHAR(32)   NOT NULL,
  from_status   VARCHAR(32)   NULL DEFAULT NULL,
  to_status     VARCHAR(32)   NULL DEFAULT NULL,
  note          VARCHAR(2000) NULL DEFAULT NULL,

  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_crm_activities_lead (lead_id, created_at),
  KEY idx_crm_activities_outcome (lead_id, outcome),
  CONSTRAINT fk_crm_activities_lead FOREIGN KEY (lead_id) REFERENCES crm_leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_activities_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A drafted message. NOT a queue.
--
-- Nothing in this application sends: a person reads the draft, sends it from their own
-- mail client, and records that they did by writing an activity. `marked_sent_at` is
-- therefore a note somebody made and not a delivery receipt, and the column is named for
-- what it is so nobody later reads it as proof a message arrived.
--
-- `edited_body` keeps what a person actually sent while `body` keeps the draft it started
-- from. What goes out has to be what somebody put their name to, and that is only
-- checkable if both halves survive.
--
-- `model`, `input_tokens` and `output_tokens` are here from the start and are NULL for
-- every hand-written draft. Same reasoning as `hidden_at` landing in migration 009 before
-- the moderation screen existed: the column a later feature needs is cheaper now than the
-- migration that adds it under live rows, and its absence is what makes the later feature
-- quietly unaccountable.
CREATE TABLE crm_outreach_drafts (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lead_id       INT UNSIGNED NOT NULL,

  channel       VARCHAR(32)  NOT NULL DEFAULT 'email',
  body          TEXT         NOT NULL,
  edited_body   TEXT         NULL DEFAULT NULL,

  model         VARCHAR(64)  NULL DEFAULT NULL,
  input_tokens  INT UNSIGNED NULL DEFAULT NULL,
  output_tokens INT UNSIGNED NULL DEFAULT NULL,

  marked_sent_at DATETIME    NULL DEFAULT NULL,
  superseded_at  DATETIME    NULL DEFAULT NULL,

  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_crm_drafts_lead (lead_id, created_at),
  CONSTRAINT fk_crm_drafts_lead FOREIGN KEY (lead_id) REFERENCES crm_leads (id) ON DELETE CASCADE,
  CONSTRAINT fk_crm_drafts_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
