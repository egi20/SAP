-- 007 Download log for quote deliverables.
--
-- Answers "which documents were produced from this quote, when, and by whom". Generation
-- is on demand rather than stored, so without this there is no record at all that a
-- particular version of a document ever left the system.

CREATE TABLE quote_downloads (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  quote_id      INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  kind          ENUM('sow','wbs','deck','package') NOT NULL,

  -- The catalogue the quote was priced under, copied at download time. A document handed
  -- to a client is only meaningful alongside the basis it was calculated on.
  catalogue_version VARCHAR(32) NOT NULL,
  byte_size     INT UNSIGNED NOT NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_quote_downloads_quote (quote_id, created_at),
  CONSTRAINT fk_quote_downloads_quote FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE,
  CONSTRAINT fk_quote_downloads_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
