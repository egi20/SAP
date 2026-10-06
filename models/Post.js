'use strict';

const { promisePool, withTransaction } = require('../config/database');
const { containsPattern } = require('../utils/likePattern');
const { uniqueSlug } = require('../utils/slug');
const { isPostKind, POST_KIND_VALUES, POINT_AWARDS } = require('../config/community');
const Points = require('./Points');

/**
 * Community posts: articles, questions, discussions and wins.
 *
 * The counters on `posts` (`reply_count`, `vote_score`, `last_activity_at`) are maintained
 * in the SAME transaction as the row they count. That is what lets the feed render without
 * aggregating, and it is why every write here goes through `withTransaction` rather than
 * firing two independent statements that can drift apart.
 */

/**
 * THE single filter builder for post browsing.
 *
 * Same rule as jobs and consultants: the list, its count, the feed and any bulk action all
 * come through here, so they provably see the same rows.
 */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  /*
   * Hidden posts are excluded by DEFAULT, and the opt-in is explicit.
   *
   * This lives inside the one builder rather than being bolted onto each query, for the
   * same reason the builder exists at all: a list view and a count that disagree about
   * whether removed content is in scope is how a moderated post keeps appearing in a
   * total nobody can explain. Only the moderation screens pass `include_hidden`.
   */
  if (!filters.include_hidden) {
    where.push('p.hidden_at IS NULL');
  }

  if (filters.kind && isPostKind(filters.kind)) {
    where.push('p.kind = ?');
    params.push(filters.kind);
  }
  if (filters.category_slug) {
    where.push('c.slug = ?');
    params.push(filters.category_slug);
  }
  /*
   * The blog is this filter and nothing else. `editorial` is '1' for the Hub's own posts
   * and '0' to exclude them; absent means both, because the community feed shows an
   * official article beside everybody else's and should.
   */
  if (filters.editorial === '1') {
    where.push('p.is_editorial = 1');
  } else if (filters.editorial === '0') {
    where.push('p.is_editorial = 0');
  }
  if (filters.author_user_id) {
    where.push('p.author_user_id = ?');
    params.push(filters.author_user_id);
  }
  if (filters.unanswered === '1') {
    where.push("p.kind = 'question' AND p.is_solved = 0 AND p.reply_count = 0");
  }
  if (filters.solved === '1') {
    where.push('p.is_solved = 1');
  }
  if (filters.q) {
    // LIKE rather than MATCH: the FULLTEXT index exists, but boolean mode on a corpus of
    // short, jargon-heavy titles returns worse results than a plain substring match.
    where.push('(p.title LIKE ? OR p.body LIKE ?)');
    const like = containsPattern(filters.q);
    params.push(like, like);
  }

  return { clause: where.length ? where.join(' AND ') : '1 = 1', params };
}

/**
 * How the replies under a post may be ordered. A fixed table, so a sort value out of a
 * query string can never reach the statement — the key is looked up, never interpolated.
 */
const REPLY_SORTS = {
  top: 'r.vote_score DESC, r.created_at ASC',
  oldest: 'r.created_at ASC',
  newest: 'r.created_at DESC'
};

const SORTS = {
  recent: 'p.is_pinned DESC, p.last_activity_at DESC',
  newest: 'p.is_pinned DESC, p.created_at DESC',
  top: 'p.is_pinned DESC, p.vote_score DESC, p.last_activity_at DESC',
  busiest: 'p.is_pinned DESC, p.reply_count DESC, p.last_activity_at DESC'
};

const AUTHOR_SELECT = `
  u.name AS author_name,
  COALESCE(cp.profile_picture, comp.logo) AS author_avatar,
  cp.primary_role AS author_role,
  (SELECT COALESCE(SUM(pl.points), 0) FROM points_ledger pl WHERE pl.user_id = p.author_user_id) AS author_points`;

const AUTHOR_JOINS = `
  JOIN users u ON u.id = p.author_user_id
  LEFT JOIN consultant_profiles cp ON cp.user_id = p.author_user_id
  LEFT JOIN company_profiles comp ON comp.user_id = p.author_user_id`;

class Post {
  static buildFilter = buildFilter;

  static get KINDS() {
    return POST_KIND_VALUES;
  }

  static async slugTaken(slug) {
    const [rows] = await promisePool.query('SELECT 1 FROM posts WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  static async create(authorUserId, { categoryId, kind, title, body, isEditorial = false }) {
    const slug = await uniqueSlug(title, Post.slugTaken);

    return withTransaction(async (conn) => {
      const [result] = await conn.query(
        'INSERT INTO posts (category_id, author_user_id, kind, title, slug, body, is_editorial) VALUES (?, ?, ?, ?, ?, ?, ?)',
        // Only an article can be editorial. A "win" or a question flying the Hub's own
        // colours would be the site congratulating itself, or asking itself something.
        [categoryId, authorUserId, kind, title, slug, body, isEditorial && kind === 'article' ? 1 : 0]
      );

      /*
       * Settled, not awarded, even though a post is created exactly once.
       *
       * The subject has to be settle-able because moderation can later take the post down
       * and put it back, and `Points.settleTo` only reconciles rows written under its own
       * `subject#n` key scheme — a plain `award` here writes `post:12`, which a later
       * settle over `post:12#%` does not see, so hiding the post would take nothing away
       * and the author would keep the points for content nobody can read.
       */
      await Points.settleTo(
        authorUserId,
        'post_created',
        `post:${result.insertId}`,
        POINT_AWARDS.post_created.points,
        { connection: conn }
      );
      return { id: result.insertId, slug };
    });
  }

  static async findBySlug(slug, viewerUserId = null) {
    const [rows] = await promisePool.query(
      `SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
              ${AUTHOR_SELECT},
              ${viewerUserId ? '(SELECT v.value FROM post_votes v WHERE v.user_id = ? AND v.target_type = \'post\' AND v.target_id = p.id)' : 'NULL'} AS my_vote
         FROM posts p
         JOIN post_categories c ON c.id = p.category_id
         ${AUTHOR_JOINS}
        WHERE p.slug = ? LIMIT 1`,
      viewerUserId ? [viewerUserId, slug] : [slug]
    );
    // Returned INCLUDING a hidden post: the route decides what a given viewer may see, so
    // that a moderator can open the thing they just removed. A model that silently
    // returned null here would make the moderation screens unable to link anywhere.
    return rows[0] || null;
  }

  /**
   * @param {number|null} viewerUserId  Their own vote on each row, so a card can show the
   *   button already pressed. `services/feed.js` was passing this in and `browse` was not
   *   taking it — the argument went nowhere and every card rendered unvoted however many
   *   times its reader had voted.
   */
  static async browse(filters = {}, { limit = 20, offset = 0, sort = 'recent', viewerUserId = null } = {}) {
    const { clause, params } = buildFilter(filters);
    const orderBy = SORTS[sort] || SORTS.recent;

    const [rows] = await promisePool.query(
      `SELECT p.id, p.kind, p.title, p.slug, p.body, p.vote_score, p.reply_count, p.view_count,
              p.is_solved, p.is_pinned, p.created_at, p.last_activity_at,
              -- The author's id, because the card links to their page. AUTHOR_SELECT below
              -- carries the NAME and not the id, so a card rendered from this query linked
              -- to "/community/author/" with nothing after it — a 404 on every card on the
              -- front page, from one column missing out of an explicit list.
              p.author_user_id,
              -- Selected for the ONE caller that passes include_hidden. Without it the
              -- opt-in returns hidden and visible rows that look identical, so the
              -- moderation list offers "Hide" on a post that is already hidden and the
              -- action reports back that there was nothing to do. Always NULL everywhere
              -- else, because every other caller filters it out in the builder.
              p.hidden_at,
              c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
              ${viewerUserId ? "(SELECT v.value FROM post_votes v WHERE v.user_id = ? AND v.target_type = 'post' AND v.target_id = p.id)" : 'NULL'} AS my_vote,
              ${AUTHOR_SELECT}
         FROM posts p
         JOIN post_categories c ON c.id = p.category_id
         ${AUTHOR_JOINS}
        WHERE ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      // The viewer's id binds FIRST: the subquery above sits ahead of the WHERE clause,
      // and mysql2 fills `?` in the order they appear in the statement, not by name.
      viewerUserId ? [viewerUserId, ...params, limit, offset] : [...params, limit, offset]
    );

    const [[{ total }]] = await promisePool.query(
      `SELECT COUNT(*) AS total FROM posts p JOIN post_categories c ON c.id = p.category_id WHERE ${clause}`,
      params
    );

    return { rows, total };
  }

  /** Counts per kind for the feed's filter pills, using the same filter minus `kind`. */
  static async countsByKind(filters = {}) {
    const { clause, params } = buildFilter({ ...filters, kind: undefined });
    const [rows] = await promisePool.query(
      `SELECT p.kind, COUNT(*) AS count
         FROM posts p JOIN post_categories c ON c.id = p.category_id
        WHERE ${clause} GROUP BY p.kind`,
      params
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.count]));
  }

  /**
   * The people who have written something matching this filter, for the author picker.
   *
   * It goes through `buildFilter` like every other query here, so a hidden post does not
   * put its author in the list and a name cannot appear beside a count of rows the list
   * will not show. `u.is_active = 1` is in the JOIN rather than the filter because an
   * author list is a list of PEOPLE, and a deactivated account is not one of them any
   * more — their posts stay, under the name, and this is only the picker.
   */
  static async authorsIn(filters = {}) {
    const { clause, params } = buildFilter(filters);
    const [rows] = await promisePool.query(
      `SELECT u.id, u.name, COUNT(*) AS count
         FROM posts p
         JOIN post_categories c ON c.id = p.category_id
         JOIN users u ON u.id = p.author_user_id AND u.is_active = 1
        WHERE ${clause}
        GROUP BY u.id, u.name
        ORDER BY count DESC, u.name ASC
        LIMIT 100`,
      params
    );
    return rows;
  }

  /**
   * A public author, for the community profile page. Returns null for an account that is
   * inactive or does not exist — never a stub, because a page that renders for an id
   * nobody holds is a page that confirms which ids exist.
   */
  static async publicAuthor(userId) {
    const [rows] = await promisePool.query(
      `SELECT u.id, u.name, u.created_at,
              COALESCE(cp.profile_picture, comp.logo) AS avatar,
              cp.primary_role AS primary_role,
              u.is_consultant, u.is_company, u.is_recruiter,
              (SELECT COALESCE(SUM(pl.points), 0) FROM points_ledger pl WHERE pl.user_id = u.id) AS points
         FROM users u
         LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
         LEFT JOIN company_profiles comp ON comp.user_id = u.id
        WHERE u.id = ? AND u.is_active = 1`,
      [userId]
    );
    return rows[0] || null;
  }

  static async incrementViews(postId) {
    try {
      await promisePool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [postId]);
    } catch (err) {
      console.error(`View increment failed for post ${postId}: ${err.message}`);
    }
  }

  /**
   * The replies on a thread, hidden ones included as TOMBSTONES.
   *
   * A hidden reply keeps its place and loses its body — the text never leaves the
   * database. Dropping the row entirely would orphan any reply written underneath it and
   * would silently disagree with `posts.reply_count`; showing "removed" is both honest and
   * the only version a threaded conversation still reads correctly.
   */
  /**
   * @param {string} sort  'top' (default), 'oldest' or 'newest'.
   *
   * THE SOLUTION IS FIRST IN ALL THREE. A thread whose accepted answer sorts to the bottom
   * under "Newest" is a thread hiding the one reply somebody came for — and the sort
   * control is a reading preference, not permission to bury the answer. Everything below
   * the solution is ordered as asked.
   */
  static async replies(postId, viewerUserId = null, { sort = 'top' } = {}) {
    const [rows] = await promisePool.query(
      `SELECT r.id, r.post_id, r.author_user_id, r.parent_reply_id, r.vote_score,
              r.is_solution, r.created_at, r.updated_at, r.hidden_at,
              CASE WHEN r.hidden_at IS NULL THEN r.body ELSE NULL END AS body,
              u.name AS author_name,
              COALESCE(cp.profile_picture, comp.logo) AS author_avatar,
              (SELECT COALESCE(SUM(pl.points), 0) FROM points_ledger pl WHERE pl.user_id = r.author_user_id) AS author_points,
              ${viewerUserId ? '(SELECT v.value FROM post_votes v WHERE v.user_id = ? AND v.target_type = \'reply\' AND v.target_id = r.id)' : 'NULL'} AS my_vote
         FROM post_replies r
         JOIN users u ON u.id = r.author_user_id
         LEFT JOIN consultant_profiles cp ON cp.user_id = r.author_user_id
         LEFT JOIN company_profiles comp ON comp.user_id = r.author_user_id
        WHERE r.post_id = ?
        ORDER BY r.is_solution DESC, ${REPLY_SORTS[sort] || REPLY_SORTS.top}`,
      viewerUserId ? [viewerUserId, postId] : [postId]
    );
    return rows;
  }

  /**
   * Post a reply.
   *
   * The counter and `last_activity_at` move in the same transaction as the insert, so a
   * list view can never show a reply count that disagrees with the thread.
   */
  static async reply(postId, authorUserId, body, { parentReplyId = null } = {}) {
    return withTransaction(async (conn) => {
      const [[post]] = await conn.query('SELECT id, is_locked, author_user_id, title, slug FROM posts WHERE id = ? FOR UPDATE', [postId]);
      if (!post) {
        const err = new Error('That post no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (post.is_locked) {
        const err = new Error('That thread is locked.');
        err.code = 'LOCKED';
        throw err;
      }

      // One level of nesting: a reply to a reply attaches to the top-level parent.
      let parent = null;
      if (parentReplyId) {
        const [[found]] = await conn.query('SELECT id, parent_reply_id FROM post_replies WHERE id = ? AND post_id = ?', [parentReplyId, postId]);
        if (found) parent = found.parent_reply_id || found.id;
      }

      const [result] = await conn.query(
        'INSERT INTO post_replies (post_id, author_user_id, parent_reply_id, body) VALUES (?, ?, ?, ?)',
        [postId, authorUserId, parent, body]
      );
      await conn.query('UPDATE posts SET reply_count = reply_count + 1, last_activity_at = NOW() WHERE id = ?', [postId]);

      // Settled for the same reason as a post: a reply can be hidden and restored, and
      // only a settled subject reconciles. See Post.create.
      await Points.settleTo(
        authorUserId,
        'reply_created',
        `reply:${result.insertId}`,
        POINT_AWARDS.reply_created.points,
        { connection: conn }
      );

      return { replyId: result.insertId, post };
    });
  }

  /**
   * Cast, change or clear a vote.
   *
   * The score is recomputed from the votes table inside the transaction rather than
   * incremented, because an increment is wrong the moment a vote is CHANGED rather than
   * added — the delta is 2, not 1, and getting that wrong drifts silently forever.
   *
   * @param {number} value 1, -1, or 0 to clear
   */
  static async vote(targetType, targetId, userId, value) {
    if (!['post', 'reply'].includes(targetType)) throw new Error(`Unknown vote target: ${targetType}`);
    const normalised = value > 0 ? 1 : value < 0 ? -1 : 0;
    const table = targetType === 'post' ? 'posts' : 'post_replies';

    return withTransaction(async (conn) => {
      const [[target]] = await conn.query(`SELECT id, author_user_id FROM ${table} WHERE id = ? FOR UPDATE`, [targetId]);
      if (!target) {
        const err = new Error('That no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (target.author_user_id === userId) {
        const err = new Error('You cannot vote on your own post.');
        err.code = 'SELF_VOTE';
        throw err;
      }

      if (normalised === 0) {
        await conn.query('DELETE FROM post_votes WHERE user_id = ? AND target_type = ? AND target_id = ?', [userId, targetType, targetId]);
      } else {
        await conn.query(
          `INSERT INTO post_votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value)`,
          [userId, targetType, targetId, normalised]
        );
      }

      const [[{ score }]] = await conn.query(
        'SELECT COALESCE(SUM(value), 0) AS score FROM post_votes WHERE target_type = ? AND target_id = ?',
        [targetType, targetId]
      );
      await conn.query(`UPDATE ${table} SET vote_score = ? WHERE id = ?`, [score, targetId]);

      /*
       * The author is paid while the upvote STANDS, and the ledger is settled to that
       * state rather than driven by the event.
       *
       * Award-on-up plus reverse-on-down looks equivalent and is not: an upvote withdrawn
       * and then given again is ignored the second time, because the award's dedupe key
       * already exists — so the author keeps the reversal and ends on -2 while the score
       * reads +1. See Points.settleTo.
       */
      const reason = targetType === 'post' ? 'post_upvoted' : 'reply_upvoted';
      await Points.settleTo(
        target.author_user_id,
        reason,
        `${reason}:${targetId}:${userId}`,
        normalised === 1 ? POINT_AWARDS[reason].points : 0,
        { connection: conn }
      );

      return { score: Number(score), myVote: normalised };
    });
  }

  /**
   * Accept a reply as the solution to a question.
   *
   * Only the asker may accept, only a question can be solved, and accepting a second reply
   * moves the mark rather than adding one — the previous solution is cleared in the same
   * transaction.
   */
  static async acceptSolution(postId, replyId, actorUserId) {
    return withTransaction(async (conn) => {
      const [[post]] = await conn.query('SELECT id, kind, author_user_id, solution_reply_id FROM posts WHERE id = ? FOR UPDATE', [postId]);
      if (!post) {
        const err = new Error('That post no longer exists.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (post.kind !== 'question') {
        const err = new Error('Only a question can have an accepted answer.');
        err.code = 'NOT_A_QUESTION';
        throw err;
      }
      if (post.author_user_id !== actorUserId) {
        const err = new Error('Only the person who asked can accept an answer.');
        err.code = 'FORBIDDEN';
        throw err;
      }

      const [[reply]] = await conn.query('SELECT id, author_user_id FROM post_replies WHERE id = ? AND post_id = ?', [replyId, postId]);
      if (!reply) {
        const err = new Error('That reply is not on this question.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      // Accepting the same reply twice changes nothing and must not pay twice. The
      // dedupe key would catch it, but returning early keeps the ledger free of a
      // meaningless reversal-then-reaward pair.
      if (post.solution_reply_id === replyId) {
        return { replyId, answererUserId: reply.author_user_id, changed: false };
      }

      /*
       * REPLACING AN ACCEPTED ANSWER REVERSES THE FIRST AWARD.
       *
       * The reference clears `is_solution` on the previous reply and stops there, so both
       * answerers keep their 25 points and the question has paid for two solutions while
       * displaying one.
       *
       * Settled inside the same transaction as the swap, so the ledger can never show one
       * without the other.
       */
      if (post.solution_reply_id) {
        const [[previous]] = await conn.query('SELECT author_user_id FROM post_replies WHERE id = ?', [
          post.solution_reply_id
        ]);
        await conn.query('UPDATE post_replies SET is_solution = 0 WHERE id = ?', [post.solution_reply_id]);
        if (previous) {
          await Points.settleTo(previous.author_user_id, 'reply_accepted', `accepted:${post.solution_reply_id}`, 0, {
            connection: conn
          });
        }
      }

      await conn.query('UPDATE post_replies SET is_solution = 1 WHERE id = ?', [replyId]);
      await conn.query('UPDATE posts SET is_solved = 1, solution_reply_id = ?, last_activity_at = NOW() WHERE id = ?', [replyId, postId]);

      /*
       * Accepting your OWN answer does not pay.
       *
       * Self-answering is legitimate and common — somebody works out their own problem and
       * writes it up — so the reply stays marked as the solution. What it must not do is
       * pay 25 points, which is the largest award on the list and would make "ask a
       * question, answer it yourself" the cheapest way to a standing. The reference has no
       * such guard, and its own rule is that a scheme which pays for volume gets volume.
       */
      const selfAnswered = reply.author_user_id === post.author_user_id;
      // Settled, not awarded: an answer accepted, moved away and accepted again would
      // otherwise be ignored the second time and leave its author on the reversal.
      await Points.settleTo(
        reply.author_user_id,
        'reply_accepted',
        `accepted:${replyId}`,
        selfAnswered ? 0 : POINT_AWARDS.reply_accepted.points,
        { connection: conn }
      );

      return { replyId, answererUserId: reply.author_user_id, changed: true, selfAnswered };
    });
  }

  static async listCategories() {
    const [rows] = await promisePool.query(
      `SELECT c.*, COUNT(p.id) AS post_count
         FROM post_categories c
         LEFT JOIN posts p ON p.category_id = c.id
        WHERE c.is_active = 1
        GROUP BY c.id
        ORDER BY c.sort_order, c.name`
    );
    return rows;
  }

  static async findCategoryBySlug(slug) {
    const [rows] = await promisePool.query('SELECT * FROM post_categories WHERE slug = ? AND is_active = 1 LIMIT 1', [slug]);
    return rows[0] || null;
  }

  static async remove(postId, actorUserId, { isAdmin = false } = {}) {
    const [result] = await promisePool.query(
      isAdmin ? 'DELETE FROM posts WHERE id = ?' : 'DELETE FROM posts WHERE id = ? AND author_user_id = ?',
      isAdmin ? [postId] : [postId, actorUserId]
    );
    return result.affectedRows === 1;
  }
}

Post.REPLY_SORTS = Object.freeze(Object.keys(REPLY_SORTS));

module.exports = Post;
