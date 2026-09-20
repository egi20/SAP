-- 005 Notifications and operational tables.

CREATE TABLE notifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  type       VARCHAR(64)  NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       VARCHAR(500) NULL DEFAULT NULL,
  link       VARCHAR(255) NULL DEFAULT NULL,

  -- Stable per-event key. Toggling something off and on again must not produce a
  -- second notification, so every emitter derives a deterministic key and this unique
  -- index makes the insert idempotent.
  dedupe_key VARCHAR(190) NOT NULL,

  read_at    DATETIME     NULL DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_dedupe (user_id, dedupe_key),
  KEY idx_notifications_unread (user_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE error_logs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  message     VARCHAR(500) NOT NULL,
  stack       TEXT         NULL,
  method      VARCHAR(10)  NULL DEFAULT NULL,
  path        VARCHAR(255) NULL DEFAULT NULL,
  status_code SMALLINT UNSIGNED NULL DEFAULT NULL,
  user_id     INT UNSIGNED NULL DEFAULT NULL,
  user_agent  VARCHAR(255) NULL DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_error_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_settings (
  setting_key   VARCHAR(120) NOT NULL,
  setting_value TEXT         NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PII-free daily visitor geography: a country code and a count, nothing else.
CREATE TABLE visit_geo_daily (
  day        DATE   NOT NULL,
  country    CHAR(2) NOT NULL,
  visits     INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, country)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
