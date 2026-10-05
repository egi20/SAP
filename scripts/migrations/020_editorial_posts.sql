-- 020 The blog, as a FLAG on an article rather than a second content store.
--
-- WHY THERE IS NO blog_posts TABLE. This application already has three places text lives:
-- community posts, success stories and site reviews. A fourth would overlap both of the
-- first two — an editorial piece is an article, and a case study is already a story — and
-- it would need its own editor, its own moderation, its own slug rules and its own idea of
-- what "hidden" means. Every one of those is already written, tested and argued about once.
--
-- So an official post IS a community article, written from a Hub account and marked. It
-- inherits replies, votes, categories, the points ledger and the moderation flag for
-- nothing, and /blog is a VIEW over Post.browse rather than a system.
--
-- The consequence worth stating: a blog post can be replied to. That is deliberate. An
-- announcement nobody can answer in public is an announcement that gets answered in
-- somebody's inbox instead, where nobody else can read the answer.
--
-- The flag is set only through the composer by an administrator, and `Post.buildFilter`
-- is still the only builder — `editorial` joins the filters it already takes.

ALTER TABLE posts
  ADD COLUMN is_editorial TINYINT(1) NOT NULL DEFAULT 0 AFTER is_pinned;

-- The blog lists editorial articles newest first, and nothing else reads this column, so
-- one composite index serves the whole feature.
CREATE INDEX idx_posts_editorial ON posts (is_editorial, created_at);
