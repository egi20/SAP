'use strict';

const Job = require('../models/Job');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const RecruiterProfile = require('../models/RecruiterProfile');
const Post = require('../models/Post');

/**
 * One box, five sources.
 *
 * THE RULE, and it is the security argument as much as a tidiness one: **search adds no
 * filter of its own.** Every source calls the same `browse` its own list view calls, with
 * the same defaults, so a row that is invisible on `/jobs` is invisible here without
 * anything in this file knowing why. A search page that assembled its own WHERE clause
 * would be a second place that has to remember `status = 'open'`, `is_public = 1`,
 * `u.is_active = 1` and `hidden_at IS NULL` — and the first one to forget is the one that
 * leaks. It is the same reason this codebase refuses a second filter builder anywhere
 * else.
 *
 * It also means the count beside "see all 43 jobs" is the count that page will show,
 * because it came from that page's own query.
 *
 * THE SECOND RULE: **no cross-type relevance score.** A match on a company name and a
 * match inside a five-thousand-word post are not comparable, and a blended ranking would
 * be a number invented to look authoritative. Results are grouped by type, ordered within
 * a type by the ordering that type already uses, and the reader decides.
 */

/**
 * Below this, a LIKE `%q%` is a table scan that matches most of the corpus and tells the
 * reader nothing. Refused rather than answered slowly.
 *
 * Two characters matters more here than in the reference: SAP module codes ARE two
 * letters — FI, CO, MM, SD, PP, QM — so "MM" is a real query somebody types, and a floor
 * of three would refuse the most obvious search on the site.
 */
const MIN_QUERY_LENGTH = 2;

/** Per type. The page is a set of previews with a link to the full, filtered list. */
const PREVIEW_LIMIT = 5;

/**
 * The sources, declared rather than written into the handler.
 *
 * `href` is where "see all" goes — the same filter, in that page's own query string — so
 * the number promised here is the number that page delivers. Adding a source when a later
 * area lands is a declaration, not a change to the search logic.
 */
const SOURCES = Object.freeze([
  {
    key: 'jobs',
    label: 'Jobs',
    icon: 'bi-briefcase',
    href: (q) => `/jobs?q=${encodeURIComponent(q)}`,
    empty: 'No open roles mention that.',
    async search(q, limit) {
      // Default filters: open only. Exactly what /jobs shows, because it is the same call.
      return Job.browse({ q }, { limit, offset: 0, sort: 'newest' });
    }
  },
  {
    key: 'consultants',
    label: 'Consultants',
    icon: 'bi-people',
    href: (q) => `/consultants?q=${encodeURIComponent(q)}`,
    empty: 'No public profiles mention that.',
    async search(q, limit) {
      // `ConsultantProfile.buildFilter` pins `is_public = 1` and `u.is_active = 1` as
      // fixed fragments rather than options, so a profile its owner has not published
      // cannot be reached from here whatever this file does.
      return ConsultantProfile.browse({ q }, { limit, offset: 0, sort: 'relevance' });
    }
  },
  {
    key: 'companies',
    label: 'Companies',
    icon: 'bi-buildings',
    href: (q) => `/companies?q=${encodeURIComponent(q)}`,
    empty: 'No companies mention that.',
    async search(q, limit) {
      return CompanyProfile.browse({ q }, { limit, offset: 0 });
    }
  },
  {
    key: 'recruiters',
    label: 'Agencies',
    icon: 'bi-person-rolodex',
    href: (q) => `/recruiters?q=${encodeURIComponent(q)}`,
    empty: 'No agencies mention that.',
    async search(q, limit) {
      // Same as every other source: `is_public = 1` and `u.is_active = 1` are fixed
      // fragments inside the browse, so an unpublished agency cannot be reached here.
      return RecruiterProfile.browse({ q }, { limit, offset: 0 });
    }
  },
  {
    key: 'community',
    label: 'Community',
    icon: 'bi-chat-square-text',
    href: (q) => `/community?q=${encodeURIComponent(q)}`,
    empty: 'Nothing in the community mentions that.',
    async search(q, limit) {
      // `Post.buildFilter` excludes hidden posts by default and only the moderation
      // screens pass the opt-in, so removed content cannot surface here.
      return Post.browse({ q }, { limit, offset: 0, sort: 'recent' });
    }
  }
]);

function normaliseQuery(raw) {
  // Collapse whitespace so "  s/4hana   finance  " and "s/4hana finance" are one query,
  // and bound the length: a LIKE pattern built from a kilobyte of text helps nobody.
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isUsableQuery(q) {
  return q.length >= MIN_QUERY_LENGTH;
}

/**
 * Search everything the visitor is allowed to see.
 *
 * Sources are queried in PARALLEL and each is allowed to fail on its own. One source
 * erroring is a missing section with a note, not a failed page: the other answers are
 * still worth having, and a search box that goes down entirely because one table is
 * locked is a worse outcome than an incomplete answer honestly labelled.
 *
 * @returns {Promise<{query:string, usable:boolean, groups:Array, total:number}>}
 */
async function searchEverything(rawQuery, { limit = PREVIEW_LIMIT } = {}) {
  const query = normaliseQuery(rawQuery);

  if (!isUsableQuery(query)) {
    return { query, usable: false, groups: [], total: 0, failures: 0, minLength: MIN_QUERY_LENGTH };
  }

  const groups = await Promise.all(
    SOURCES.map(async (source) => {
      const shell = {
        key: source.key,
        label: source.label,
        icon: source.icon,
        href: source.href(query),
        empty: source.empty
      };
      try {
        const { rows, total } = await source.search(query, limit);
        return { ...shell, rows: rows || [], total: Number(total) || 0, failed: false };
      } catch (err) {
        console.error(`Search source "${source.key}" failed: ${err.message}`);
        return { ...shell, rows: [], total: 0, failed: true };
      }
    })
  );

  return {
    query,
    usable: true,
    groups,
    /*
     * The sum of what each source reported. NOT a relevance figure, and NOT deduplicated
     * across types — a job and the company that posted it are two results, because they
     * are two different things a reader might have been looking for.
     */
    total: groups.reduce((sum, group) => sum + group.total, 0),
    // Counted so the page can say the answer is incomplete rather than imply it is empty.
    failures: groups.filter((group) => group.failed).length,
    minLength: MIN_QUERY_LENGTH
  };
}

module.exports = {
  SOURCES,
  MIN_QUERY_LENGTH,
  PREVIEW_LIMIT,
  normaliseQuery,
  isUsableQuery,
  searchEverything
};
