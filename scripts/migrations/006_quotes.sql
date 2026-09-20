-- 006 Scope estimates and quotes.
--
-- `estimate` holds the WHOLE computed breakdown as JSON, not just a headline figure.
-- That is deliberate: an estimate shown to a client is a statement, and re-deriving it
-- later from inputs plus today's catalogue would silently change it when a base effort or
-- a day rate is edited. The stored breakdown is what was said; `inputs` is what was asked;
-- `catalogue_version` records which catalogue produced it.

CREATE TABLE quotes (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference         CHAR(12)     NOT NULL,

  owner_user_id     INT UNSIGNED NOT NULL,

  -- Who it is for. Free text: the prospect is not necessarily a Hub account.
  client_name       VARCHAR(200) NOT NULL,
  client_company    VARCHAR(200) NOT NULL,
  client_email      VARCHAR(255) NULL DEFAULT NULL,
  client_industry   VARCHAR(120) NULL DEFAULT NULL,
  company_size      VARCHAR(60)  NULL DEFAULT NULL,

  project_name      VARCHAR(200) NOT NULL,
  project_summary   TEXT         NULL,

  /*
   * The transition approach, denormalised out of `inputs`.
   *
   * It is the first thing anybody filters or sorts a list of SAP quotes by — "show me the
   * brownfield ones" — and it is the single biggest lever on the number. A list view that
   * had to open a JSON column to answer that would either be slow or grow a second copy
   * of the field later.
   */
  transition_approach ENUM('greenfield','brownfield','selective') NOT NULL DEFAULT 'greenfield',

  -- The scope as chosen, and the full computed breakdown as presented.
  inputs            JSON         NOT NULL,
  estimate          JSON         NOT NULL,
  catalogue_version VARCHAR(32)  NOT NULL,

  -- Denormalised headline figures, so list views and filters never parse JSON.
  total_man_days    INT UNSIGNED NOT NULL,
  total_budget      DECIMAL(12,2) NOT NULL,
  currency          CHAR(3)      NOT NULL DEFAULT 'EUR',
  duration_weeks    SMALLINT UNSIGNED NOT NULL,

  status            ENUM('draft','sent','accepted','declined','expired') NOT NULL DEFAULT 'draft',
  sent_at           DATETIME     NULL DEFAULT NULL,
  decided_at        DATETIME     NULL DEFAULT NULL,

  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_quotes_reference (reference),
  KEY idx_quotes_owner (owner_user_id, status, created_at),
  KEY idx_quotes_approach (transition_approach, status),
  CONSTRAINT fk_quotes_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only history of status changes, for the same reason applications have one:
-- "when was this sent, and who decided it" must always have an answer.
CREATE TABLE quote_events (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  quote_id      INT UNSIGNED NOT NULL,
  actor_user_id INT UNSIGNED NULL DEFAULT NULL,
  from_status   VARCHAR(32)  NULL DEFAULT NULL,
  to_status     VARCHAR(32)  NOT NULL,
  note          VARCHAR(500) NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_quote_events_quote (quote_id, created_at),
  CONSTRAINT fk_quote_events_quote FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE,
  CONSTRAINT fk_quote_events_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The modules a quote covers, as rows rather than only inside the JSON.
--
-- The JSON is the record of what was SAID; this is what the scope IS, and the difference
-- matters the moment anybody asks a question across quotes — "how many of our quotes this
-- year included EWM" — which is a question the job board and the talent directory can both
-- already answer about themselves. A JSON_TABLE over a growing column is the version of
-- this that nobody can index.
CREATE TABLE quote_modules (
  quote_id    INT UNSIGNED NOT NULL,
  module_slug VARCHAR(64)  NOT NULL,
  PRIMARY KEY (quote_id, module_slug),
  KEY idx_quote_modules_slug (module_slug),
  CONSTRAINT fk_quote_modules_quote FOREIGN KEY (quote_id) REFERENCES quotes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
