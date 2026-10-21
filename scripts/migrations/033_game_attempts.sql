-- 033 Attempts at the scored SAP games (config/games.js).
--
-- The same design as challenge_attempts in 017, for the same reason: the row is written by
-- the server after grading choices against a set the browser never saw the key to, the
-- date is the server's, and UNIQUE (user_id, game, game_date) is one attempt per game per
-- day — a second submission is a duplicate-key no-op, not a better score.
--
-- `game` is a closed list that mirrors the scored games in config/games.js; a unit test
-- compares the two. Practice games (flashcards, typing) store nothing and are not in it.
CREATE TABLE game_attempts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  game        ENUM('match', 'scenario', 'codequiz', 'bughunter', 'wordsearch') NOT NULL,
  game_date   DATE         NOT NULL,
  score       TINYINT UNSIGNED NOT NULL,
  total       TINYINT UNSIGNED NOT NULL,
  -- What was chosen per item id, so a disputed day can be regraded from the date alone.
  answers     JSON         NULL DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_attempt_day (user_id, game, game_date),
  KEY idx_game_attempts_board (game, game_date, score),
  CONSTRAINT fk_game_attempts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
