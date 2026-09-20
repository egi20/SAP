'use strict';

const {
  POST_KINDS,
  isPostKind,
  postKind,
  seedCategories,
  POINT_AWARDS,
  LEVELS,
  levelFor,
  assertCommunityIntegrity
} = require('../../config/community');
const { PRODUCT_LINES } = require('../../config/sapProducts');

describe('the configuration asserts itself', () => {
  test('integrity', () => expect(assertCommunityIntegrity()).toBe(true));

  test('every award is positive — reversals are written by Points.reverse', () => {
    for (const [reason, award] of Object.entries(POINT_AWARDS)) {
      expect({ reason, points: award.points }).toEqual({ reason, points: expect.any(Number) });
      expect(award.points).toBeGreaterThan(0);
    }
  });

  test('an accepted answer is the largest single award', () => {
    // The scheme's own rule: pay for being useful, not for being loud.
    const largest = Math.max(...Object.values(POINT_AWARDS).map((a) => a.points));
    expect(POINT_AWARDS.reply_accepted.points).toBe(largest);
    expect(POINT_AWARDS.reply_accepted.points).toBeGreaterThanOrEqual(POINT_AWARDS.post_created.points * 5);
  });

  test('there is no award for a feature that does not exist', () => {
    // The reference pays for a correct answer in its daily challenge. That is a later area,
    // and an award nothing can earn reads like a feature.
    expect(POINT_AWARDS.challenge_correct).toBeUndefined();
  });
});

describe('the category tree is derived, not typed out again', () => {
  const categories = seedCategories();

  test('every product line has a category', () => {
    const slugs = new Set(categories.map((c) => c.slug));
    for (const line of PRODUCT_LINES) {
      expect({ line: line.value, present: slugs.has(line.value) }).toEqual({ line: line.value, present: true });
    }
  });

  test('a line-derived category carries the line slug; a cross-cutting one does not', () => {
    const fromLine = categories.find((c) => c.slug === 's4hana-finance');
    const crossCutting = categories.find((c) => c.slug === 'careers');
    expect(fromLine.familySlug).toBe('s4hana-finance');
    expect(crossCutting.familySlug).toBeNull();
  });

  test('the SAP-specific categories are there', () => {
    // Neither reference has these two, and they are the busiest conversations in any real
    // SAP forum.
    const slugs = categories.map((c) => c.slug);
    expect(slugs).toContain('transitions');
    expect(slugs).toContain('clean-core');
  });

  test('every slug is unique and url-safe', () => {
    const slugs = categories.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('post kinds', () => {
  test('only a question is solvable', () => {
    expect(POST_KINDS.filter((k) => k.solvable).map((k) => k.value)).toEqual(['question']);
  });

  test('an unknown kind falls back rather than throwing', () => {
    expect(isPostKind('rant')).toBe(false);
    expect(postKind('rant').value).toBe('discussion');
  });
});

describe('levels', () => {
  test('a new account is level 1, not level 0 or undefined', () => {
    expect(levelFor(0).level).toBe(1);
    expect(LEVELS[0].from).toBe(0);
  });

  test('a total lands in the right band', () => {
    expect(levelFor(49).level).toBe(1);
    expect(levelFor(50).level).toBe(2);
    expect(levelFor(9999).level).toBe(LEVELS[LEVELS.length - 1].level);
  });

  test('progress is through the CURRENT band, so the bar restarts at each level', () => {
    // Level 2 runs 50..150, so 100 points is exactly half way.
    expect(levelFor(100).progressPercent).toBe(50);
    expect(levelFor(50).progressPercent).toBe(0);
  });

  test('the top level is complete rather than progressing towards nothing', () => {
    const top = levelFor(99999);
    expect(top.nextLevel).toBeNull();
    expect(top.progressPercent).toBe(100);
  });

  test('a NEGATIVE total still resolves, and does not claim you need points for a level you have', () => {
    /*
     * A total can go below zero: reversing an award writes a compensating entry, and an
     * account whose only rows are reversals sums negative. Unclamped this rendered as a bar
     * of -200%, and "the first threshold above -100" is level 1's own floor, so the sidebar
     * read "100 points to level 1" at somebody already in it.
     */
    const below = levelFor(-100);
    expect(below.level).toBe(1);
    expect(below.progressPercent).toBe(0);
    expect(below.nextLevel).toBe(2);
    expect(below.pointsToNext).toBe(150); // to level 2's floor of 50, from -100
  });

  test('a non-numeric total is treated as zero rather than producing NaN', () => {
    for (const bad of [undefined, null, NaN, 'lots']) {
      expect(levelFor(bad).level).toBe(1);
      expect(Number.isFinite(levelFor(bad).progressPercent)).toBe(true);
    }
  });
});
