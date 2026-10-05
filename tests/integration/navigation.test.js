'use strict';

/**
 * Every link in the navigation and the footer is opened.
 *
 * WHY THIS TEST EXISTS. A walkthrough of the reference site against this one found
 * sixteen paths that answered 404, and the reason a dead link survives in a chrome partial
 * is that nobody who works on the site ever clicks it — you navigate by typing the URL you
 * already know. The visitor does the opposite: the menu is the first thing they try, and a
 * 404 from it teaches them the navigation is decoration.
 *
 * It reads the two partials as TEXT rather than rendering them, which is the point: the
 * signed-in half of each menu never renders for a logged-out visitor, so a test that
 * walked the rendered page would check about half of the links and report success. The
 * source carries both branches.
 *
 * A redirect counts as alive, and its destination is opened too — an alias pointing at a
 * 404 is the same failure one hop further along.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PARTIALS = ['navigation.ejs', 'footer.ejs'];

/**
 * Pull the static internal links out of a partial.
 *
 * Anything interpolated is skipped rather than guessed at: a URL built from a row's id
 * cannot be opened without that row, and a test that invented one would be asserting
 * against a fixture rather than against the menu.
 */
function linksIn(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'partials', file), 'utf8');
  const found = new Set();
  const re = /href="([^"]+)"/g;
  let match = re.exec(source);
  while (match) {
    const href = match[1];
    if (href.startsWith('/') && !href.includes('<%')) {
      found.add(href.replace(/&amp;/g, '&'));
    }
    match = re.exec(source);
  }
  return [...found];
}

const ALL_LINKS = PARTIALS.flatMap((file) => linksIn(file).map((href) => [file, href]));

let app;

/*
 * NO POOL TEARDOWN HERE. `tests/setup.js` registers a global afterAll that closes the pool
 * and the session store, and a hook registered there runs BEFORE a top-level hook in this
 * file — so a top-level afterAll that queries anything gets "Pool is closed", which Jest
 * reports as the whole suite failing while every test in it passed. Fixtures are therefore
 * cleared on the way IN, which also makes a run independent of how the last one ended.
 */
maybe()('Navigation and footer links', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  it('finds links to check in both partials', () => {
    // A regex that silently matched nothing would make every case below vacuously true.
    PARTIALS.forEach((file) => {
      expect(linksIn(file).length).toBeGreaterThan(3);
    });
  });

  it.each(ALL_LINKS)('%s: %s is not a dead link', async (_file, href) => {
    const res = await request(app).get(href);

    // A plain Node client sends no Sec-Fetch-Dest, so middleware/auth.js treats it as a
    // navigation: a gated page answers 302 to the login form, never 401. See CLAUDE.md.
    expect([200, 301, 302]).toContain(res.status);

    if (res.status === 301 || res.status === 302) {
      const target = res.headers.location;
      expect(target).toBeTruthy();
      // Only internal hops are worth following, and only one: these are aliases, not chains.
      if (target.startsWith('/')) {
        const hop = await request(app).get(target);
        expect([200, 302]).toContain(hop.status);
      }
    }
  });
});

/**
 * The aliases exist for paths people type and other sites link to, so none of them appears
 * in the menu — which means the walk above cannot see them, and a rename would break them
 * silently.
 */
maybe()('Short aliases', () => {
  beforeAll(() => {
    app = require('../../server');
  });

  it.each([
    ['/privacy', '/legal/privacy', 301],
    ['/terms', '/legal/terms', 301],
    ['/forum', '/community', 302],
    ['/forum/category/s4hana-finance', '/community/category/s4hana-finance', 302],
    ['/companies/talent', '/consultants', 302]
  ])('%s redirects to %s', async (from, to, status) => {
    const res = await request(app).get(from);
    expect(res.status).toBe(status);
    expect(res.headers.location).toBe(to);
  });

  it('carries the filters across /companies/talent, or the shared link loses them', async () => {
    const res = await request(app).get('/companies/talent?modules=mm&min_years=5');
    expect(res.headers.location).toBe('/consultants?modules=mm&min_years=5');
  });

  it('does not let the alias shadow a company whose slug begins with those letters', async () => {
    // `/talent` is declared before `/:slug`, so the ordering is what makes this true.
    const res = await request(app).get('/companies/talented-people-ltd');
    expect([200, 404]).toContain(res.status);
    expect(res.headers.location).toBeUndefined();
  });
});
