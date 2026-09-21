'use strict';

const { PRODUCT_LINES } = require('./sapProducts');

/**
 * Post kinds.
 *
 * These differ in how they are presented and in what they afford — only a question can be
 * solved, only a win is celebrated — not in what they store. One table with a
 * discriminator; see the comment on `posts` in migration 009.
 */
const POST_KINDS = [
  {
    value: 'question',
    label: 'Question',
    verb: 'Ask a question',
    icon: 'bi-patch-question',
    tone: 'icon-info',
    hint: 'Something you need an answer to. Mark a reply as the solution when you get one.',
    solvable: true
  },
  {
    value: 'discussion',
    label: 'Discussion',
    verb: 'Start a discussion',
    icon: 'bi-chat-square-text',
    tone: 'icon-blue',
    hint: 'An opinion, a trade-off, a question with no single right answer.',
    solvable: false
  },
  {
    value: 'article',
    label: 'Article',
    verb: 'Write an article',
    icon: 'bi-file-earmark-text',
    tone: 'icon-navyblue',
    hint: 'Something you worked out and want to write up properly.',
    solvable: false
  },
  {
    value: 'win',
    label: 'Win',
    verb: 'Share a win',
    icon: 'bi-trophy',
    tone: 'icon-amber',
    hint: 'A go-live, a certification, a contract. Small ones count.',
    solvable: false
  }
];

const POST_KIND_VALUES = POST_KINDS.map((k) => k.value);
const POST_KIND_MAP = new Map(POST_KINDS.map((k) => [k.value, k]));

function isPostKind(value) {
  return POST_KIND_MAP.has(value);
}

function postKind(value) {
  return POST_KIND_MAP.get(value) || POST_KINDS[1];
}

/**
 * The seeded category tree.
 *
 * One category per product line, so the community speaks the same vocabulary as the job
 * board and the estimator, plus the cross-cutting ones that belong to no line. Derived from
 * `PRODUCT_LINES` rather than typed out again — a line added there appears here
 * automatically, which is the rule the whole taxonomy follows.
 *
 * `transitions` has no counterpart in either reference and is the busiest category in any
 * real SAP forum: greenfield versus brownfield, conversion readiness, simplification items,
 * upgrade pain. It is the same question the estimator asks first.
 *
 * `clean-core` likewise: "can I do this in standard" is the recurring SAP argument, and it
 * is not the same conversation as architecture.
 */
const CROSS_CUTTING_CATEGORIES = [
  {
    slug: 'careers',
    name: 'Careers & rates',
    description: 'Contracting, day rates, interviews, moving between roles.',
    icon: 'bi-graph-up-arrow',
    sortOrder: 10
  },
  {
    slug: 'certification',
    name: 'Certification',
    description: 'Exams, study routes, what a credential is actually worth.',
    icon: 'bi-patch-check',
    sortOrder: 20
  },
  {
    slug: 'transitions',
    name: 'Transitions & upgrades',
    description: 'Greenfield, brownfield, selective. Readiness checks, simplification items, cutover.',
    icon: 'bi-arrow-left-right',
    sortOrder: 30
  },
  {
    slug: 'clean-core',
    name: 'Clean core & extensibility',
    description: 'Key-user extensions, side-by-side on BTP, released APIs, and when to break the rule.',
    icon: 'bi-shield-check',
    sortOrder: 40
  },
  {
    slug: 'architecture',
    name: 'Architecture & governance',
    description: 'Landscape strategy, authorisations, technical debt, multi-system estates.',
    icon: 'bi-diagram-3',
    sortOrder: 50
  },
  {
    slug: 'basis-release',
    name: 'Basis & release',
    description: 'Transports, systems, Cloud ALM, deployment pain.',
    icon: 'bi-arrow-repeat',
    sortOrder: 60
  },
  {
    slug: 'general',
    name: 'Everything else',
    description: 'Anything that does not fit above.',
    icon: 'bi-three-dots',
    sortOrder: 900
  }
];

function seedCategories() {
  const fromLines = PRODUCT_LINES.map((line, index) => ({
    slug: line.value,
    name: line.label,
    description: `${line.modules.length} modules — implementation, design and gotchas.`,
    familySlug: line.value,
    icon: 'bi-box-seam',
    sortOrder: 100 + index
  }));

  return [...CROSS_CUTTING_CATEGORIES.map((c) => ({ ...c, familySlug: null })), ...fromLines];
}

/**
 * Points.
 *
 * Deliberately small numbers, and deliberately weighted towards being USEFUL rather than
 * being loud: an accepted answer is the largest single award on the list, worth what five
 * posts are worth. A scheme that pays for volume gets volume.
 *
 * (The reference's comment says "more than five posts" while its numbers make it exactly
 * five. The numbers are the ones that matter, so the sentence was corrected rather than
 * the award nudged to make an inherited sentence true.)
 *
 * `dedupeKey` is derived per award so the same event can never pay twice.
 *
 * The reference also pays for a correct answer in its daily challenge. That feature does
 * not exist here yet, and an award nothing can earn is a row in a table that reads like a
 * feature. It arrives with the challenge or not at all.
 */
const POINT_AWARDS = {
  post_created: { points: 5, label: 'Posted' },
  reply_created: { points: 2, label: 'Replied' },
  reply_accepted: { points: 25, label: 'Answer accepted' },
  post_upvoted: { points: 2, label: 'Post upvoted' },
  reply_upvoted: { points: 1, label: 'Reply upvoted' },
  profile_completed: { points: 20, label: 'Profile completed' },
  rate_contributed: { points: 10, label: 'Contributed a rate' }
};

/**
 * Levels.
 *
 * Thresholds grow roughly quadratically, so early progress is quick and later levels mean
 * something. `levelFor` is pure and exhaustive: any total, including a negative one from a
 * reversal, resolves to a level.
 */
const LEVELS = [
  { level: 1, from: 0, title: 'Newcomer' },
  { level: 2, from: 50, title: 'Contributor' },
  { level: 3, from: 150, title: 'Regular' },
  { level: 4, from: 350, title: 'Trusted' },
  { level: 5, from: 700, title: 'Expert' },
  { level: 6, from: 1200, title: 'Authority' },
  { level: 7, from: 2000, title: 'Luminary' }
];

function levelFor(totalPoints) {
  const points = Number.isFinite(totalPoints) ? totalPoints : 0;
  let current = LEVELS[0];
  for (const level of LEVELS) {
    if (points >= level.from) current = level;
  }
  /*
   * The next level is the one above the CURRENT band, not the first threshold above the
   * point total. Those differ when the total is negative: with -100 points you are still
   * level 1, but "the first threshold above -100" is level 1's own floor, so the sidebar
   * would read "100 points to level 1" at someone who is already there.
   */
  const next = LEVELS.find((l) => l.from > current.from) || null;

  return {
    ...current,
    points,
    nextLevel: next ? next.level : null,
    nextTitle: next ? next.title : null,
    pointsToNext: next ? next.from - points : 0,
    /*
     * Progress through the CURRENT band, so the bar restarts at each level rather than
     * creeping asymptotically towards the last one.
     *
     * Clamped, because a total can go NEGATIVE: reversing an award (an upvote withdrawn, an
     * accepted answer replaced) writes a compensating entry, and an account whose only
     * ledger rows are reversals sums below zero. Unclamped that rendered as a bar of -200%,
     * which CSS draws as an empty bar and a nonsense label.
     */
    progressPercent: next
      ? Math.max(0, Math.min(100, Math.round(((points - current.from) / (next.from - current.from)) * 100)))
      : 100
  };
}

function communityProblems() {
  const problems = [];
  const seen = new Set();

  for (const category of seedCategories()) {
    if (seen.has(category.slug)) problems.push(`duplicate category slug: ${category.slug}`);
    seen.add(category.slug);
    if (!/^[a-z0-9-]+$/.test(category.slug)) problems.push(`category slug is not url-safe: ${category.slug}`);
  }
  for (const [reason, award] of Object.entries(POINT_AWARDS)) {
    if (!Number.isInteger(award.points)) problems.push(`award "${reason}" has a non-integer value`);
    if (award.points <= 0) problems.push(`award "${reason}" is not positive — a reversal is a settle to a lower figure, never a negative award`);
  }
  for (let i = 1; i < LEVELS.length; i += 1) {
    if (LEVELS[i].from <= LEVELS[i - 1].from) {
      problems.push(`level ${LEVELS[i].level} does not start above level ${LEVELS[i - 1].level}`);
    }
  }
  if (LEVELS[0].from !== 0) problems.push('the first level must start at 0, or a new account has no level');

  return problems;
}

function assertCommunityIntegrity() {
  const problems = communityProblems();
  if (problems.length) throw new Error(`Community configuration is inconsistent:\n  - ${problems.join('\n  - ')}`);
  return true;
}

module.exports = {
  POST_KINDS,
  POST_KIND_VALUES,
  isPostKind,
  postKind,
  seedCategories,
  POINT_AWARDS,
  LEVELS,
  levelFor,
  communityProblems,
  assertCommunityIntegrity
};
