'use strict';

const Job = require('../models/Job');
const Post = require('../models/Post');

/**
 * The home feed: community posts and job adverts in one chronological list.
 *
 * THE RULE THIS FILE FOLLOWS IS THE ONE `services/search.js` FOLLOWS, for the same reason.
 * It adds no filter of its own. Both sources go through the same `browse` their own list
 * pages call, with the same defaults, so a row invisible on /jobs or /community is
 * invisible here without anything in this file knowing why — not `status = 'open'`, not
 * `is_public = 1`, not `hidden_at IS NULL`. A feed that assembled its own WHERE clause
 * would be a second place that has to remember all of them, and the first one to forget is
 * the one that leaks a draft advert onto the front page.
 *
 * ORDER IS STRICTLY BY DATE, and there is no cross-type score. A job advert and a
 * five-hundred-word article have nothing comparable to rank against each other, and a
 * blended ordering would be a number invented to look authoritative. This is a feed, so
 * recency is the ordering it is allowed to claim.
 *
 * THE TOTAL IS A SUM AND IS NOT DEDUPLICATED, exactly as in search: a job and a post about
 * that job are two things somebody might want to see.
 */

/** The feed's own type vocabulary: the post kinds, plus jobs. */
const JOB_KIND = 'job';

/**
 * A community filter has no meaning for a job advert — a category belongs to the community
 * tree and `unanswered` to a question. Rather than inventing a mapping from one vocabulary
 * to another, the feed narrows to posts whenever one is active, and the page says so.
 */
function communityOnly(filters) {
  return Boolean(filters.category_slug || filters.unanswered);
}

function entryFromPost(post) {
  return { type: 'post', at: new Date(post.created_at), post };
}

function entryFromJob(job) {
  return { type: 'job', at: new Date(job.published_at || job.created_at), job };
}

/**
 * @param {object} filters  `kind`, `category_slug`, `unanswered` — the community's own.
 * @param {object} page     `{ limit, offset }` from `paginationFrom`.
 * @param {number|null} viewerUserId  Passed to `Post.browse` for the viewer's own votes.
 */
async function homeFeed(filters, { limit, offset }, viewerUserId = null) {
  const postFilters = {
    kind: filters.kind === JOB_KIND ? '' : filters.kind,
    category_slug: filters.category_slug,
    unanswered: filters.unanswered
  };

  if (filters.kind === JOB_KIND) {
    const { rows, total } = await Job.browse({}, { limit, offset, sort: 'newest' });
    return { entries: rows.map(entryFromJob), total, postsOnly: false };
  }

  if (filters.kind || communityOnly(filters)) {
    const { rows, total } = await Post.browse(postFilters, { limit, offset, sort: 'recent', viewerUserId });
    return { entries: rows.map(entryFromPost), total, postsOnly: communityOnly(filters) };
  }

  /*
   * The mixed page. Each source is asked for everything up to the end of the page being
   * shown and the merge is sliced — the only way two independently paginated sources can
   * be interleaved correctly, because neither knows how many of the other's rows fall
   * above it. It costs offset+limit rows per source, which is why the feed pages in
   * fifteens and does not offer a jump to page four hundred.
   */
  const reach = limit + offset;
  const [posts, jobs] = await Promise.all([
    Post.browse(postFilters, { limit: reach, offset: 0, sort: 'recent', viewerUserId }),
    Job.browse({}, { limit: reach, offset: 0, sort: 'newest' })
  ]);

  const merged = [...posts.rows.map(entryFromPost), ...jobs.rows.map(entryFromJob)]
    .sort((a, b) => b.at - a.at)
    .slice(offset, offset + limit);

  return { entries: merged, total: posts.total + jobs.total, postsOnly: false };
}

/**
 * Counts for the filter pills, from the same sources the list reads. A pill must never
 * promise rows the list will not show.
 */
async function feedCounts(filters) {
  // No viewer argument: a count of posts by kind is the same number for everybody, and
  // `countsByKind` never took one. Passing it was noise that read like a feature.
  const postCounts = await Post.countsByKind({
    kind: '',
    category_slug: filters.category_slug,
    unanswered: filters.unanswered
  });

  if (communityOnly(filters)) return { ...postCounts, [JOB_KIND]: 0 };

  const { total } = await Job.browse({}, { limit: 1, sort: 'newest' });
  return { ...postCounts, [JOB_KIND]: total };
}

module.exports = { homeFeed, feedCounts, JOB_KIND, communityOnly };
