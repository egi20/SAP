-- 017 Daily challenge attempts.
--
-- ONE table, and the unique key on it is the entire anti-cheat design.
--
-- The reference implementation's `game_scores` is written straight from the request body:
-- `routes/games.js:41` reads `{ score, gameDate }` out of `req.body` and inserts them.
-- The score is whatever the browser said, and `game_date` is whichever day the browser
-- named — so one fetch call posts a perfect score on any date, as many times as you like.
-- That output then feeds the points summary, which in this codebase is an append-only
-- ledger whose whole value is that a total can be explained.
--
-- Here the row is written by the server after grading answers against a bank the browser
-- never sees, `challenge_date` comes from the server clock, and
-- UNIQUE (user_id, challenge_date) means a person gets ONE attempt per day. A second
-- submission is a duplicate-key no-op, not a better score — which also makes the endpoint
-- safe to retry, the same way every fulfilment table here is.

CREATE TABLE challenge_attempts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED NOT NULL,

  -- The SERVER's day, in UTC. Never the request's. One leaderboard needs one definition
  -- of "today", or somebody in Auckland plays tomorrow's challenge first.
  challenge_date DATE         NOT NULL,

  -- Both written by the grader, never submitted.
  score          TINYINT UNSIGNED NOT NULL,
  total          TINYINT UNSIGNED NOT NULL,

  -- Which question ids were asked and what was chosen, as JSON, so a disputed score can
  -- be reconstructed: the daily set is derived deterministically from the date, so the
  -- questions can be regenerated and checked against this.
  answers        JSON         NULL DEFAULT NULL,

  -- Milliseconds the attempt took, reported by the client and stored ONLY for display.
  -- It is not ranked on and never will be: a client-reported duration is exactly the
  -- number the reference let decide its leaderboards.
  duration_ms    INT UNSIGNED NULL DEFAULT NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_challenge_attempt_day (user_id, challenge_date),
  KEY idx_challenge_attempts_date (challenge_date, score),
  KEY idx_challenge_attempts_user (user_id, challenge_date),
  CONSTRAINT fk_challenge_attempts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
