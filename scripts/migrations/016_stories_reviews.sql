-- 016 Success stories, site reviews, and the agency logo table.
--
-- Three things that all say "somebody got value out of this", plus the blob table that
-- finishes migration 019.
--
-- The two content tables share one rule, and it is the rule this codebase already applies
-- to every post and reply: CONTENT IS HIDDEN, NEVER DELETED. The reference implementation's
-- `SiteReview.delete` is a hard `DELETE FROM site_reviews WHERE id = ?`, reachable from a
-- bulk action on a list view. A moderator who cannot undo will not act, and there is then
-- no answer to "who removed that, and when".

-- Finishes 015: the agency logo, in the shared blob store rather than as bytes on the
-- profile row. `recruiter_profiles` gets `SELECT *`'d by the directory, and durable bytes
-- never live on the host disk.
CREATE TABLE recruiter_logos (
  user_id      INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_recruiter_logos_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Editorial case studies, written by an administrator about a real engagement.
--
-- WHAT IS NOT HERE: `gross_before`, `net_before`, `gross_after`, `net_after`. The
-- reference's success stories carry all four and its tax page renders the difference as a
-- monthly saving — which is the savings calculator this codebase refuses, wearing a
-- different hat. A testimonial saying "we shipped in nine weeks" is evidence; one saying
-- "I went from 3,400 to 5,700 a month" is a financial claim the Hub cannot stand behind.
-- The refusal is pinned by a test that scans this area for anything saving-shaped.
CREATE TABLE success_stories (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug          VARCHAR(220) NOT NULL,
  title         VARCHAR(200) NOT NULL,

  -- Who the story is about, as text. Deliberately NOT a foreign key to `users`: a story
  -- can be about a client who has no account, and a person who closes their account
  -- should not silently break a published page.
  subject_name  VARCHAR(200) NULL DEFAULT NULL,
  subject_role  VARCHAR(200) NULL DEFAULT NULL,

  summary       VARCHAR(500) NULL DEFAULT NULL,
  body          MEDIUMTEXT   NOT NULL,

  -- A pull quote and who said it. Separate columns rather than markup inside `body`,
  -- because bodies here are rendered through `sanitizeRichText` and a quote is layout.
  quote         VARCHAR(600) NULL DEFAULT NULL,
  quote_author  VARCHAR(200) NULL DEFAULT NULL,

  -- Which SAP product line it belongs to, from config/sapProducts.js, so the page groups
  -- by the same vocabulary the job board, the estimator and the agency directory use.
  family        VARCHAR(64)  NULL DEFAULT NULL,

  -- Stored raw as the administrator typed it. It is turned into an embed URL at RENDER
  -- time by an allowlist that recognises only YouTube and Vimeo — see utils/videoEmbed.js.
  -- Storing the derived embed URL instead would mean a stored value that looks trustworthy
  -- because of a check made once, in the past, by code that may since have changed.
  video_url     VARCHAR(500) NULL DEFAULT NULL,

  -- Pointer with a ?v= cache buster; the bytes live in `story_photos`.
  photo         VARCHAR(255) NULL DEFAULT NULL,

  published_at  DATETIME     NULL DEFAULT NULL,
  hidden_at     DATETIME     NULL DEFAULT NULL,

  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_success_stories_slug (slug),
  KEY idx_success_stories_live (hidden_at, published_at),
  CONSTRAINT fk_success_stories_author FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Story photos, keyed on the STORY rather than a user — see `models/ImageBlob.js`, which
-- now carries an owner-column per table instead of assuming `user_id` everywhere.
CREATE TABLE story_photos (
  story_id     INT UNSIGNED NOT NULL,
  content_type VARCHAR(64)  NOT NULL DEFAULT 'image/webp',
  bytes        MEDIUMBLOB   NOT NULL,
  byte_size    INT UNSIGNED NOT NULL,
  etag         CHAR(32)     NOT NULL,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (story_id),
  CONSTRAINT fk_story_photos_story FOREIGN KEY (story_id) REFERENCES success_stories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Testimonials about the Hub itself.
--
-- SIGNED IN ONLY, and that is a departure. The reference accepts a review from a guest
-- who types any name and any role, which is a testimonial farm with a text box: nothing
-- links the words to anyone who used the site, and there is no cost to posting a hundred
-- of them. Requiring an account gives the review a subject, gives moderation somebody to
-- act on, and makes UNIQUE (user_id) meaningful — one voice, one review.
CREATE TABLE site_reviews (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED NOT NULL,

  rating       TINYINT UNSIGNED NOT NULL,
  body         VARCHAR(1000) NOT NULL,

  -- What the author does, chosen from the roles they actually hold rather than typed.
  -- The reference stores a free-text `author_role`, so "SAP Mentor" is a claim the
  -- page then displays as fact.
  author_role  VARCHAR(32)  NULL DEFAULT NULL,

  -- Approval is explicit and reversible, and un-approving is not deletion.
  approved_at  DATETIME     NULL DEFAULT NULL,
  approved_by  INT UNSIGNED NULL DEFAULT NULL,
  hidden_at    DATETIME     NULL DEFAULT NULL,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One review per account. Editing replaces it, which also sends it back for approval:
  -- an approved review whose text can be swapped afterwards is an approval that means
  -- nothing.
  UNIQUE KEY uq_site_reviews_user (user_id),
  KEY idx_site_reviews_live (approved_at, hidden_at),
  CONSTRAINT fk_site_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_site_reviews_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
