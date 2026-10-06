'use strict';

/**
 * The chrome, and three links that went nowhere.
 *
 * A crawl of every internal link found two dead ones and a button nobody could see. All
 * three had been in place for weeks, because nobody who works on a site clicks its own
 * navigation — which is the argument `tests/integration/navigation.test.js` was written
 * on, and these are the places that test does not reach: a sidebar, a leaderboard and a
 * button's colour.
 */

const fs = require('fs');
const path = require('path');

/**
 * A template with its explanations removed.
 *
 * Every assertion below greps for a string that must not appear — and the comment saying
 * why it must not appear contains it. Without this the tempting fix is to delete the
 * sentence. Both EJS comment forms, and the JS block comments inside `<% %>`.
 */
function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
    .replace(/<%#[\s\S]*?%>/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('B8 — the sign-in button', () => {
  const nav = source('views/partials/navigation.ejs');

  it('is not white on a white header', () => {
    /*
     * `.navbar-hub` is rgba(255,255,255,0.82). `btn-outline-light` is #f8f9fa text in an
     * #f8f9fa border, so the only control a signed-out visitor could see was "Sign up".
     */
    expect(nav).not.toContain('btn-outline-light');
    expect(nav).toMatch(/href="\/auth\/login">Sign in<\/a>/);
  });
});

describe('M3 — the search box in the same bar', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it('is not white text on the white header either', () => {
    // Reported from a phone as "a large empty space" — which is what an invisible field
    // between two visible things looks like.
    const block = css.slice(css.indexOf('.nav-search'), css.indexOf('.nav-search') + 600);
    expect(block).not.toMatch(/color:\s*#fff/);
  });
});

describe('B6 — the community leaderboard', () => {
  const view = source('views/community/index.ejs');

  it('links to the page the points were earned on', () => {
    /*
     * It linked to `/consultants/:id`. The leaderboard is a SUM over `points_ledger`,
     * which a company or an administrator can top without ever having published a
     * consultant profile — so the link 404'd, with a real name on it.
     */
    expect(view).toContain('/community/author/<%= m.user_id %>');
    expect(view).not.toMatch(/href="\/consultants\/<%= m\.user_id %>"/);
  });
});

describe('B7 — the company profile', () => {
  const view = source('views/profile/company.ejs');
  const routes = fs.readdirSync(path.join(__dirname, '..', '..', 'routes'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', '..', 'routes', f), 'utf8'))
    .join('\n');

  it('does not offer a screen that was never built', () => {
    // `routes/quotes.js` passes `branding = null` with a comment saying so.
    expect(view).not.toContain('/profile/company/template');
    expect(routes).not.toContain("'/company/template'");
  });
});

describe('B9 — which menu a page belongs to', () => {
  const nav = source('views/partials/navigation.ejs');

  it('treats writing an advert as a company action', () => {
    // Reading one is a consultant action and writing one is not, and they share a prefix.
    expect(nav).toContain("path === '/jobs/new'");
    expect(nav).toContain('isJobAuthoring');
  });
});

describe('M4 — the superadmin mark', () => {
  const tabs = source('views/admin/_tabs.ejs');

  it('does not depend on a tooltip', () => {
    // A `title` does not exist on a touch screen, where it was an unexplained "S".
    expect(tabs).not.toMatch(/title="Superadmin only"/);
    expect(tabs).toContain('visually-hidden');
  });
});

describe('C6 — fields that had only a placeholder', () => {
  it('names the enquiry box on a job advert', () => {
    expect(source('views/jobs/show.ejs')).toContain('for="enquiry-body"');
  });

  it('names the void reason on /admin/rates', () => {
    // One per row, so the name is on aria-label: a hidden <label> would need a unique id
    // per row to be associated at all.
    expect(source('views/admin/rates.ejs')).toContain('aria-label="Reason for voiding this submission"');
  });

  it('names the experience fields on the consultant profile', () => {
    const view = source('views/profile/consultant.ejs');
    expect(view).toContain('for="experience-title"');
    expect(view).toContain('for="experience-company"');
  });

  it('opens the navigation menus with buttons rather than empty anchors', () => {
    const nav = source('views/partials/navigation.ejs');
    expect(nav).not.toContain('href="#"');
    expect((nav.match(/type="button" class="nav-link dropdown-toggle/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Home is the community, so there is no Community tab', () => {
  const nav = source('views/partials/navigation.ejs');
  const footer = source('views/partials/footer.ejs');
  const feed = source('views/feed/index.ejs');

  it('carries no Community dropdown', () => {
    /*
     * Everything it held existed somewhere else: its first three items are the kind
     * filters on the home feed, over the same `Post.browse`; "Write a post" and
     * "Payments and invoices" are in the account menu. A menu entry that re-asks the
     * question the page below it is already asking is a second front door.
     */
    expect(nav).not.toMatch(/bi-people"><\/i> Community/);
  });

  it('keeps every page that dropdown reached one click away', () => {
    // `/community` has categories, an author picker and a sort the feed does not, so it
    // stays reachable — from the feed's own heading and from the footer.
    expect(feed).toContain('href="/community"');
    ['/community', '/community/articles', '/challenges'].forEach((href) => {
      expect(footer).toContain(`href="${href}"`);
    });
    expect(nav).toContain('href="/community/new"');
    expect(nav).toContain('href="/payments/history"');
  });

  it('gives the daily challenge the one home it did not already have', () => {
    // A game is a tool, and Services is where the tools are.
    const services = nav.slice(nav.indexOf('bi-tools'), nav.indexOf('bi-tools') + 1200);
    expect(services).toContain('href="/challenges"');
  });
});

describe('C1 — confirming before something is destroyed', () => {
  it('goes through one attribute rather than one handler per button', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');
    expect(main).toContain('form[data-confirm]');
  });

  it('covers the two purges that cannot be undone', () => {
    expect(source('views/admin/errors.ejs')).toContain('data-confirm');
    expect(source('views/admin/enquiries.ejs')).toContain('data-confirm');
  });
});
