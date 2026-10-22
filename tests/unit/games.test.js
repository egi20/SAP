'use strict';

const fs = require('fs');
const path = require('path');

const games = require('../../config/games');
const { POINT_AWARDS } = require('../../config/community');

const DATE = '2026-10-21';

function codeOf(modulePath) {
  return fs.readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the SAP games catalogue', () => {
  test('passes its boot assertion', () => {
    expect(games.assertGamesIntegrity()).toBe(true);
  });

  test('the scored games match the EFFECTIVE game ENUM, across every migration', () => {
    // 033 created it, 037 widened it; the last definition wins, as when the runner applies them.
    const dir = path.join(__dirname, '../../scripts/migrations');
    let values = null;
    fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().forEach((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\s*--.*$/gm, '');
      const found = sql.match(/\bgame\s+ENUM\(([^)]*)\)/);
      if (found) values = found[1].split(',').map((v) => v.trim().replace(/'/g, ''));
    });
    expect(values.slice().sort()).toEqual(games.SCORED_KEYS.slice().sort());
  });

  test('every Sapphire answer says where it was reported, and only after grading', () => {
    games.banks.sapphire.forEach((item) => expect(item.source).toMatch(/^https:\/\//));
    const set = games.dailySetFor('sapphire', DATE);
    expect(JSON.stringify(games.publicFormOf('sapphire', set))).not.toContain('"source"');
    const graded = games.grade('sapphire', set, {});
    graded.results.forEach((r) => expect(r.source).toMatch(/^https:\/\//));
  });

  test('a game pays at most what its ledger award declares', () => {
    for (let total = 1; total <= 8; total += 1) {
      for (let score = 0; score <= total; score += 1) {
        expect(games.pointsFor(score, total)).toBeLessThanOrEqual(POINT_AWARDS.game_completed.points);
      }
    }
    expect(games.pointsFor(6, 6)).toBe(2);
    expect(games.pointsFor(3, 6)).toBe(1);
    expect(games.pointsFor(2, 6)).toBe(0);
  });
});

describe.each(games.SCORED_KEYS)('%s', (key) => {
  test('is the same set for everybody on one date, and differs the next day', () => {
    expect(games.dailySetFor(key, DATE)).toEqual(games.dailySetFor(key, DATE));
    const ids = (d) => games.dailySetFor(key, d).items.map((i) => i.id);
    expect(ids('2026-10-22')).not.toEqual(ids(DATE));
  });

  test('the public form carries no answer, meaning, word or explanation', () => {
    const json = JSON.stringify(games.publicFormOf(key, games.dailySetFor(key, DATE)));
    expect(json).not.toMatch(/"(answer|explain|meaning|word|source)"/);
  });

  test('the correct answers score full marks, garbage scores zero and does not throw', () => {
    const set = games.dailySetFor(key, DATE);
    const right = {};
    set.items.forEach((i) => { right[i.id] = key === 'wordsearch' ? i.word.toLowerCase() : i.answer; });
    const full = games.grade(key, set, right);
    expect(full.score).toBe(full.total);
    expect(full.points).toBe(2);

    const junk = {};
    set.items.forEach((i) => { junk[i.id] = { $gt: 1 }; });
    expect(games.grade(key, set, junk).score).toBe(0);
    expect(games.grade(key, set, 'nonsense').score).toBe(0);
    expect(games.grade(key, set, null).score).toBe(0);
  });

  test('a stored record regrades to the same score', () => {
    const set = games.dailySetFor(key, DATE);
    const first = set.items[0];
    const partial = { [first.id]: key === 'wordsearch' ? first.word : first.answer };
    const graded = games.grade(key, set, partial);
    const again = games.grade(key, set, games.submissionFromRecord(key, set, games.recordOf(graded)));
    expect(again.score).toBe(graded.score);
  });
});

describe('the word search grid', () => {
  test('every word of the day can actually be found in it', () => {
    for (let d = 1; d <= 28; d += 1) {
      const date = `2026-11-${String(d).padStart(2, '0')}`;
      const { grid, items } = games.dailySetFor('wordsearch', date);
      const lines = [];
      const n = grid.length;
      const at = (r, c) => grid[r][c];
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [-1, 1]]) {
        for (let r = 0; r < n; r += 1) {
          for (let c = 0; c < n; c += 1) {
            let s = '';
            for (let k = 0; r + dr * k >= 0 && r + dr * k < n && c + dc * k < n; k += 1) s += at(r + dr * k, c + dc * k);
            lines.push(s);
          }
        }
      }
      items.forEach((item) => expect(lines.some((l) => l.startsWith(item.word))).toBe(true));
    }
  });

  test('typed answers ignore case, spaces and punctuation', () => {
    expect(games.normaliseWord(' fi-ori ')).toBe('FIORI');
    expect(games.normaliseWord(42)).toBe('');
  });
});

describe('the routes', () => {
  test('never read a score or a date from the request', () => {
    const code = codeOf('../../routes/games.js');
    expect(code).not.toMatch(/req\.body\.(score|date|gameDate|points)/);
  });

  test('render a set only through publicFormOf before grading', () => {
    const code = codeOf('../../routes/games.js');
    expect(code).toMatch(/set: graded \? null : games\.publicFormOf/);
  });

  test('typing practice sends nothing anywhere', () => {
    const code = codeOf('../../public/js/games.js');
    expect(code).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
  });
});
