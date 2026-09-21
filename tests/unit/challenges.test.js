'use strict';

const fs = require('fs');

const challenges = require('../../config/challenges');
const Challenge = require('../../models/Challenge');
const { POINT_AWARDS } = require('../../config/community');

function codeOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the question bank', () => {
  test('passes its boot assertion', () => {
    expect(challenges.assertChallengeIntegrity()).toBe(true);
  });

  test('holds enough questions that a day is not the same every day', () => {
    expect(challenges.bankSize()).toBeGreaterThan(challenges.QUESTIONS_PER_DAY * 3);
  });
});

describe('the daily set', () => {
  test('is the same five questions, in the same order, for one date', () => {
    // This is what makes a daily leaderboard mean anything: everybody answers the same
    // questions. A random shuffle per request would also make a disputed score
    // impossible to reconstruct later.
    const a = challenges.dailySetFor('2026-09-16');
    const b = challenges.dailySetFor('2026-09-16');
    expect(a).toEqual(b);
    expect(a).toHaveLength(challenges.QUESTIONS_PER_DAY);
  });

  test('differs between dates', () => {
    const a = challenges.dailySetFor('2026-09-16').map((q) => q.id);
    const b = challenges.dailySetFor('2026-09-17').map((q) => q.id);
    expect(a).not.toEqual(b);
  });

  test('never repeats a question within one day', () => {
    for (const date of ['2026-01-01', '2026-06-15', '2026-09-16', '2027-02-28']) {
      const ids = challenges.dailySetFor(date).map((q) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('shuffles the options, so the answer is not always where the bank listed it', () => {
    // Across a month of sets the correct option should land in more than one position.
    // Without this, "always pick the first option" would be a strategy.
    const positions = new Set();
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-04-${String(day).padStart(2, '0')}`;
      challenges.dailySetFor(date).forEach((q) => positions.add(q.answer));
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  test('the answer always indexes a real option', () => {
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-04-${String(day).padStart(2, '0')}`;
      for (const q of challenges.dailySetFor(date)) {
        expect(q.options[q.answer]).toBeDefined();
      }
    }
  });
});

/**
 * THE RULE, asserted rather than described.
 *
 * The reference implementation ships every question together with `correct: 0` inside a
 * 2467-line client partial, and then accepts whatever score the browser posts back. Both
 * halves have to be closed, and only the first one can be tested without a database.
 */
describe('an answer key never reaches a browser', () => {
  test('publicFormOf strips the answer AND the explanation', () => {
    const question = challenges.dailySetFor('2026-09-16')[0];
    const published = challenges.publicFormOf(question);

    expect(published).not.toHaveProperty('answer');
    // The explanation names the right option in prose, so it is as good as the answer.
    expect(published).not.toHaveProperty('explain');
    expect(Object.keys(published).sort()).toEqual(['id', 'options', 'prompt', 'topic']);
  });

  test('publicFormOf copies the options rather than aliasing them', () => {
    const question = challenges.dailySetFor('2026-09-16')[0];
    const published = challenges.publicFormOf(question);
    published.options[0] = 'tampered';
    expect(question.options[0]).not.toBe('tampered');
  });

  test('the template renders only the published form', () => {
    const view = fs.readFileSync(require.resolve('../../views/challenges/index.ejs'), 'utf8');
    // `q` is the loop variable over the unanswered question list. It may never be asked
    // for an answer or an explanation; `r`, the graded result, may.
    expect(view).not.toMatch(/\bq\.answer\b/);
    expect(view).not.toMatch(/\bq\.explain\b/);
  });

  test('the route hands the template a stripped set', () => {
    const code = codeOf('../../routes/challenges');
    // Every path that renders questions maps through publicFormOf. If this stops being
    // true the assertion above on the template is the only thing left.
    expect(code).toMatch(/dailySetFor\([^)]*\)\.map\(publicFormOf\)/);
    const rawRenders = code.match(/questions:\s*[^,\n]+/g) || [];
    for (const render of rawRenders) {
      expect(render).toMatch(/publicFormOf|\[\]/);
    }
  });

  test('neither the route nor the model reads a score or a date from the request', () => {
    // `routes/games.js:41` in the reference: const { score, gameDate } = req.body;
    for (const modulePath of ['../../routes/challenges', '../../models/Challenge']) {
      const code = codeOf(modulePath);
      expect(code).not.toMatch(/req\.body\.score|body\.gameDate|body\.game_date/);
      expect(code).not.toMatch(/\bgameDate\b/);
    }
  });
});

describe('grading', () => {
  const set = challenges.dailySetFor('2026-09-16');
  const byId = (pick) => Object.fromEntries(set.map((q, i) => [q.id, String(pick(q, i))]));

  test('a perfect submission scores full marks and earns points', () => {
    const graded = challenges.gradeAnswers(set, byId((q) => q.answer));
    expect(graded.score).toBe(set.length);
    expect(graded.points).toBe(set.length * challenges.POINTS_PER_CORRECT);
  });

  test('keys on the question id, so a partial submission is not misaligned', () => {
    // `qs` COMPACTS a sparse numeric object, so `answers[0]` and `answers[2]` arrive as a
    // two-element array. Positional grading would mark the answer to question 3 against
    // question 2. This is the bug the id keying exists to prevent.
    const partial = {
      [set[0].id]: String(set[0].answer),
      [set[2].id]: String(set[2].answer)
    };
    const graded = challenges.gradeAnswers(set, partial);
    expect(graded.score).toBe(2);
    expect(graded.results[0].correct).toBe(true);
    expect(graded.results[1].correct).toBe(false);
    expect(graded.results[2].correct).toBe(true);
  });

  test('an unanswered question is recorded as unanswered, not as wrong guess', () => {
    const graded = challenges.gradeAnswers(set, {});
    expect(graded.score).toBe(0);
    expect(graded.results.every((r) => r.chosen === null)).toBe(true);
  });

  test('refuses a float or a trailing-garbage index rather than rounding it into a choice', () => {
    // parseInt('2.9') is 2 and parseInt('3abc') is 3, so a coerced value could land on a
    // correct option the submitter never chose.
    expect(challenges.gradeAnswers(set, byId((q) => `${q.answer}.9`)).score).toBe(0);
    expect(challenges.gradeAnswers(set, byId((q) => `${q.answer}abc`)).score).toBe(0);
    expect(challenges.gradeAnswers(set, byId((q) => ` ${q.answer} `)).score).toBe(0);
  });

  test('survives a hostile body of any shape', () => {
    for (const body of [null, undefined, 'nope', 42, [], {}, { __proto__: { x: 1 } }, { answers: 'x' }]) {
      const graded = challenges.gradeAnswers(set, body);
      expect(graded.score).toBe(0);
      expect(graded.total).toBe(set.length);
    }
  });

  test('an out-of-range index cannot reach a question that was not asked', () => {
    expect(challenges.gradeAnswers(set, byId(() => 99)).score).toBe(0);
    expect(challenges.gradeAnswers(set, byId(() => -1)).score).toBe(0);
  });
});

describe('serverDate', () => {
  test('comes from the clock, in UTC', () => {
    expect(challenges.serverDate(new Date('2026-09-16T23:59:59Z'))).toBe('2026-09-16');
    expect(challenges.serverDate(new Date('2026-09-17T00:00:01Z'))).toBe('2026-09-17');
  });

  test('defaults to now, so a caller never has to supply a day', () => {
    // One leaderboard needs one "today". A per-visitor local day would let somebody in
    // Auckland play tomorrow's set before somebody in Lisbon finished today's — and a
    // request-supplied one is the reference's `gameDate`, asserted against above.
    expect(challenges.serverDate()).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('the streak', () => {
  const streak = (dates, today) => Challenge.streakFromDates(dates, today).days;

  test('counts consecutive days ending today', () => {
    expect(streak(['2026-09-16', '2026-09-15', '2026-09-14'], '2026-09-16')).toBe(3);
  });

  test('survives the day not yet played', () => {
    // Otherwise a streak dies at midnight for everybody who has not played yet.
    expect(streak(['2026-09-15', '2026-09-14'], '2026-09-16')).toBe(2);
    expect(Challenge.streakFromDates(['2026-09-15'], '2026-09-16').playedToday).toBe(false);
  });

  test('ends when both today and yesterday are missed', () => {
    expect(streak(['2026-09-14', '2026-09-13'], '2026-09-16')).toBe(0);
  });

  test('stops at the first gap rather than counting every attempt', () => {
    expect(streak(['2026-09-16', '2026-09-15', '2026-09-12', '2026-09-11'], '2026-09-16')).toBe(2);
  });

  test('crosses a month and a year boundary', () => {
    expect(streak(['2026-03-01', '2026-02-28', '2026-02-27'], '2026-03-01')).toBe(3);
    expect(streak(['2027-01-01', '2026-12-31', '2026-12-30'], '2027-01-01')).toBe(3);
  });

  test('handles a leap day', () => {
    expect(streak(['2028-03-01', '2028-02-29', '2028-02-28'], '2028-03-01')).toBe(3);
  });

  test('accepts Date objects as MySQL returns them', () => {
    expect(streak([new Date('2026-09-16T00:00:00Z'), new Date('2026-09-15T00:00:00Z')], '2026-09-16')).toBe(2);
  });

  test('is zero with no attempts', () => {
    expect(Challenge.streakFromDates([], '2026-09-16')).toEqual({ days: 0, playedToday: false });
  });
});

describe('what a challenge pays', () => {
  test('is the smallest award on the site', () => {
    // The scheme's own rule: one that pays for volume gets volume, and a daily quiz is
    // the cheapest volume here. It should nudge a standing, never build one.
    //
    // Tied with `reply_upvoted` rather than strictly below it, which is right: both are
    // the cheapest thing a member can do, and neither should outrank the other.
    const award = POINT_AWARDS.challenge_completed.points;
    const cheapest = Math.min(...Object.values(POINT_AWARDS).map((d) => d.points));
    expect(award).toBe(cheapest);
  });

  test('a perfect day is worth far less than one accepted answer', () => {
    const perfectDay = challenges.QUESTIONS_PER_DAY * POINT_AWARDS.challenge_completed.points;
    expect(perfectDay).toBeLessThan(POINT_AWARDS.reply_accepted.points);
  });
});

describe('the leaderboard queries', () => {
  test('never select an email address', () => {
    // A public-facing board showing `firstname.lastname` from an email local part is the
    // leak `models/Conversation.js` already documents.
    const code = codeOf('../../models/Challenge');
    expect(code).not.toMatch(/u\.email/);
  });

  test('rank on the stored score, never on the client-reported duration', () => {
    const code = codeOf('../../models/Challenge');
    expect(code).not.toMatch(/ORDER BY[^`]*duration_ms/i);
  });
});
