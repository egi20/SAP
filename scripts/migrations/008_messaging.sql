-- 008 Messaging.
--
-- Conversations are ANCHORED to a subject: an application, or an enquiry about a specific
-- job. There is deliberately no open direct-message inbox.
--
-- Two reasons. First, an unanchored DM channel on a marketplace is a recruiting-spam
-- vector: any account can reach any other with no context and no reason. Second, anchoring
-- gives every thread a subject line that is true by construction, so the recipient always
-- knows why they were contacted.
--
-- DynamicsHub keyed one conversation per PAIR of users, which merges every topic between
-- two people into a single thread — an employer discussing two different roles with the
-- same consultant ends up with one confusing conversation. Here the key is the subject.

CREATE TABLE conversations (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind               ENUM('application','enquiry') NOT NULL,

  -- Deterministic identity for the subject. Makes "open the thread about X" an idempotent
  -- upsert instead of a check-then-insert with a race, and stops a second thread being
  -- created for a subject that already has one.
  dedupe_key         VARCHAR(190) NOT NULL,

  job_id             INT UNSIGNED NULL DEFAULT NULL,
  application_id     INT UNSIGNED NULL DEFAULT NULL,
  created_by_user_id INT UNSIGNED NOT NULL,

  last_message_at    DATETIME     NULL DEFAULT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation_subject (dedupe_key),
  KEY idx_conversations_recent (last_message_at),

  /*
   * "Every thread has a subject" is the whole design, so it is a constraint rather than a
   * convention.
   *
   * The reference enforces it in `routes/messages.js` — which does the job today, and is
   * exactly the shape CLAUDE.md warns about: a rule that lives in one handler is a rule the
   * second handler forgets. Its `dedupeKeyFor` will happily build `enquiry:0:12:34` from a
   * null job, and that key IS an unanchored direct message between two accounts. Here the
   * database refuses the row, so the promise holds no matter who writes the next caller.
   */
  CONSTRAINT chk_conversation_anchored CHECK (
    (kind = 'application' AND application_id IS NOT NULL)
    OR (kind = 'enquiry' AND job_id IS NOT NULL)
  ),

  CONSTRAINT fk_conversations_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_conversations_application FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_conversations_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Membership is a row, so "is this thread mine?" is a JOIN condition on every query
-- rather than a separate check that a future query can forget to make.
CREATE TABLE conversation_participants (
  conversation_id INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,

  -- Read state is per participant. A single `is_read` on the message would be wrong the
  -- moment a thread has more than two people in it — and the inbox query in
  -- models/Conversation.js is written to survive that case, which the reference's is not.
  last_read_at    DATETIME     NULL DEFAULT NULL,
  joined_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (conversation_id, user_id),
  KEY idx_participants_user (user_id),
  CONSTRAINT fk_participants_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id INT UNSIGNED NOT NULL,
  sender_user_id  INT UNSIGNED NOT NULL,

  -- Plain text. Messages are rendered with `<%= %>`, never `<%- %>`: a chat body is the
  -- one place where accepting markup buys nothing and costs an XSS surface.
  body            TEXT         NOT NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_messages_thread (conversation_id, created_at),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
