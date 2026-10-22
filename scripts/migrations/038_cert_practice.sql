-- 038 Certification practice (owner, 2026-10-22, as dynamicshub.net's): one row per
-- practice session a member finished, so /consultants/certifications can show attempts, best
-- and last score per exam. `cert_code` is the catalogue stem from config/certifications.js,
-- never a year-suffixed code. Practice pays no points and ranks nobody — it can be repeated
-- as often as somebody likes, which is the point of practice — so this table feeds nothing
-- but the member's own progress.
CREATE TABLE cert_practice_attempts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  cert_code   VARCHAR(16)  NOT NULL,
  score       TINYINT UNSIGNED NOT NULL,
  total       TINYINT UNSIGNED NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cert_practice_user (user_id, cert_code),
  CONSTRAINT fk_cert_practice_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
