'use strict';

/**
 * The development seed's guards.
 *
 * `scripts/create-admin.js` explains at length why this project has no seed: invented day
 * rates publish a benchmark nobody contributed to, and invented consultant profiles are a
 * public directory of people who do not exist. That refusal is about a REAL SITE, and the
 * way it is kept is by making the seed hard to run anywhere real. So the guards are the
 * part worth testing — the data itself is obvious the moment somebody opens the page.
 */

const fs = require('fs');
const path = require('path');

const SEED = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'seed-dev.js'), 'utf8');

describe('it refuses to run anywhere real', () => {
  it('stops on NODE_ENV=production', () => {
    expect(SEED).toContain('config.isProduction');
  });

  it('also stops on a base URL that is not local', () => {
    /*
     * NODE_ENV alone is weak: it is easy to leave unset on a server. A base URL is not —
     * a real deployment has to set it for its own links to work, so it is the better
     * signal of the two and --force is the only way past it.
     */
    expect(SEED).toContain('localhost');
    expect(SEED).toContain('--force');
  });

  it('marks every account it creates so seeded rows are identifiable', () => {
    expect(SEED).toContain("const DOMAIN = 'seed.saphub.test'");
  });

  it('can take all of it out again', () => {
    expect(SEED).toContain('--remove');
    expect(SEED).toMatch(/DELETE FROM users WHERE email LIKE \?/);
  });
});

describe('it writes through the models', () => {
  it('creates accounts with User.create rather than an INSERT', () => {
    // Seeding has to exercise the same validation, completeness scoring and points ledger
    // a real sign-up does, or it cheerfully creates a profile the application itself would
    // have refused to publish.
    expect(SEED).toContain('User.create');
    expect(SEED).not.toMatch(/INSERT INTO (users|jobs|posts|consultant_profiles)/);
  });

  it('stamps no consent, like every other shell-created account', () => {
    expect(SEED).not.toMatch(/consent:/);
  });

  it('seeds a bucket that publishes and one that does not', () => {
    // An index that only ever shows published figures hides the behaviour that makes it
    // trustworthy.
    expect(SEED).toContain('belowFloor');
    expect(SEED).toContain('publishable');
  });

  it('seeds content that must stay invisible, to prove it does', () => {
    expect(SEED).toMatch(/status: 'draft'/);
    expect(SEED).toContain('hide: true');
  });
});
