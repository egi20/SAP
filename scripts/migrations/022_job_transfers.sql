-- 022 Handing an advert over to a colleague.
--
-- An offer, not a move. The sender addresses an EMAIL; nothing happens until the holder of
-- that address signs in and accepts. There is no claim token and no link that grants
-- anything, because an advert carries other people's data and a link in an inbox is an
-- access grant to whoever that inbox forwards to.
--
-- `to_user_id` IS NULL UNTIL ACCEPTANCE, DELIBERATELY. Resolving the address to an account
-- at creation would let any company account ask this table whether a given email has an
-- account here, one offer at a time. The recipient finds their own offers by matching their
-- own signed-in address, and the sender is told what the mechanism is ("it expires if
-- nobody at that address accepts") rather than the answer for this address.
--
-- ONE PENDING OFFER PER ADVERT, held by the schema rather than by an `if` in a handler.
-- `pending_marker` is 1 while the offer is pending and NULL once it is settled, and the
-- UNIQUE key spans (job_id, pending_marker). In SQL a NULL never equals another NULL, so
-- any number of settled offers coexist while a second live one collides on (job_id, 1) and
-- is refused by the key. Same technique as `cert_key` in migration 002, and for the same
-- reason: a check in the handler is a check with a gap in front of it.
--
-- THE MARKER IS DERIVED FROM `status` ALONE, AND `job_id` SITS IN THE KEY RATHER THAN IN
-- THE EXPRESSION. The obvious spelling — `pending_job_id AS (IF(status = 'pending', job_id,
-- NULL)) STORED` under a single-column UNIQUE key — is the same guarantee and MySQL 8
-- refuses to create the table at all: a foreign key on the BASE COLUMN of a stored
-- generated column may not carry CASCADE, SET NULL or SET DEFAULT, and `job_id` carries
-- ON DELETE CASCADE. MariaDB does not enforce that restriction, so it applied cleanly here
-- and failed with a bare "Cannot add foreign key constraint" on the first MySQL 8 it met —
-- errno 1215, which names neither the column nor the rule. Keeping `job_id` out of the
-- expression keeps the cascade AND the guarantee on both engines.
--
-- Nothing here is ever deleted. The row IS the audit trail for an advert changing hands,
-- and "who gave this to whom, and when" is the question asked afterwards.

CREATE TABLE job_transfers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id         INT UNSIGNED NOT NULL,
  from_user_id   INT UNSIGNED NOT NULL,

  -- The address as it was addressed, normalised the same way users.email is.
  to_email       VARCHAR(255) NOT NULL,

  -- Written at acceptance and never before: this is the account that took the advert.
  to_user_id     INT UNSIGNED NULL DEFAULT NULL,

  status         ENUM('pending','accepted','declined','cancelled','expired')
                   NOT NULL DEFAULT 'pending',

  -- A note from the sender. Optional, bounded, plain text.
  message        VARCHAR(500) NULL DEFAULT NULL,

  -- An offer that never expires is a standing grant on somebody else's advert. Past this
  -- moment it cannot be accepted; the row is only marked `expired` when somebody acts on
  -- the advert again, so no scheduled job is needed for the rule to hold.
  expires_at     DATETIME     NOT NULL,
  responded_at   DATETIME     NULL DEFAULT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  pending_marker TINYINT UNSIGNED AS (IF(status = 'pending', 1, NULL)) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_job_transfer_pending (job_id, pending_marker),
  KEY idx_job_transfer_job (job_id, status),
  KEY idx_job_transfer_from (from_user_id, status),
  KEY idx_job_transfer_to (to_email, status),

  CONSTRAINT fk_job_transfer_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_transfer_from FOREIGN KEY (from_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_job_transfer_to FOREIGN KEY (to_user_id) REFERENCES users (id) ON DELETE SET NULL,

  -- "You cannot accept your own offer" is NOT here, and that is a limitation rather than a
  -- choice: MariaDB refuses a CHECK over a column carrying an ON DELETE SET NULL foreign
  -- key. It is held instead inside `JobTransfer.accept`, with both rows locked, which is
  -- the same transaction that moves the advert — so there is no window between the check
  -- and the write even though there is no constraint behind it.
  -- A settled offer has a date; a pending one does not.
  CONSTRAINT ck_job_transfer_responded CHECK (
    (status = 'pending' AND responded_at IS NULL) OR (status <> 'pending' AND responded_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
