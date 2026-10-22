'use strict';

/**
 * The regression cases Admin › Automated Tests runs against the live application, as
 * dynamicshub.net's Admin › Tests does (owner's request, 2026-10-22).
 *
 * WHY THE LIBRARY LIVES HERE AND NOT IN A TABLE. The reference seeds its cases into a
 * `test_cases` table and runs whatever is in the table — so a case corrected in the source
 * keeps failing against the stale copy until somebody remembers to press "Refresh Suite",
 * which its own notes record as a recurring trap. Here the code IS the library: a release
 * that changes a page changes its case in the same diff, and there is nothing to re-sync.
 * Only two things are stored: which cases an administrator switched off, and the runs.
 *
 * WHY GET ONLY. Every case reads a page and checks what came back. A POST against the live
 * database is a write somebody has to clean up, and the reference's POST cases mostly
 * assert a 302 that this application's CSRF check would answer first anyway — proving the
 * token check, not the guard they are named after. The guards are covered by GET cases
 * that do reach them.
 *
 * DERIVED CASES. The public pages, the rate role pages, the engagement models, the games
 * and the dashboard tiles are generated from the catalogues that build those pages, so a
 * page added to a catalogue is tested the day it ships and a renamed one cannot leave a
 * case behind pointing at a 404.
 *
 * A case:
 *   name        unique, shown on the screen and stored with each result
 *   category    a heading on the screen
 *   path        a site path, starting with a single '/'
 *   status      the status expected, or a list of acceptable ones
 *   redirect    optional: the Location must start with this (redirects are NOT followed)
 *   contains    optional: strings the body must contain
 *   notContains optional: strings it must not
 *   role        optional: 'consultant' or 'company' — run signed in as the QA account for
 *               that role. Only when QA_TEST_PASSWORD is set; otherwise the case is skipped
 *               and counted, never failed.
 */

const { PUBLIC_PATHS } = require('./seoMeta');
const { RATE_ROLE_SLUGS } = require('./roleTaxonomy');
const { ENGAGEMENT_MODELS } = require('./engagementModels');
const { GAMES } = require('./games');
const { TABS } = require('./dashboard');

/**
 * No administrator QA account, deliberately. The reference seeds `qa-admin@…` with a
 * password held in an environment variable, which is an administrator login that exists
 * only so a test can use it — on the production database, where every other admin account
 * belongs to a person. Admin screens are covered as GUARDS instead: a signed-out visitor
 * and a consultant must both be turned away.
 */
const QA_ROLES = Object.freeze(['consultant', 'company']);

const SERVER_ERROR = 'Something went wrong';

function page(category, path, extra = {}) {
  return { name: `${category}: ${path}`, category, path, status: 200, notContains: [SERVER_ERROR], ...extra };
}

const derived = [
  ...PUBLIC_PATHS.map((p) => page('Public pages', p)),
  ...RATE_ROLE_SLUGS.map((slug) => page('Rate role pages', `/rates/${slug}`)),
  ...ENGAGEMENT_MODELS.map((m) => page('Company hub', `/companies/${m.slug}`)),
  // The practice games are open to anybody; a scored game needs an account, because a
  // score is stored against one.
  ...GAMES.filter((g) => !g.scored).map((g) => page('Games', `/games/${g.key}`)),
  ...GAMES.filter((g) => g.scored).map((g) => ({
    name: `Games: ${g.key} needs an account`, category: 'Games', path: `/games/${g.key}`,
    status: 302, redirect: '/auth/login'
  })),
  ...GAMES.filter((g) => g.scored).map((g) => page('Games', `/games/${g.key}`, {
    name: `Games: ${g.key} as a consultant`, role: 'consultant'
  })),
  // Every tile on every dashboard tab a QA account of that role sees — including the
  // Sales Agent tab, which every account has. Visibility is asked of the catalogue's own
  // `visible`, the rule the dashboard renders with, so the cases follow the screen. A tile
  // pointing at a route that was never built is a dead button on the most-visited page a
  // member has.
  ...QA_ROLES.flatMap((role) => TABS
    .filter((t) => t.visible({ isConsultant: role === 'consultant', isCompany: role === 'company' }))
    // A tab every account sees is tested once, as the first QA role, not once per role.
    .filter((t) => role === QA_ROLES[0] || !t.visible({}))
    .flatMap((t) => t.tiles
      .filter((tile) => tile.href.startsWith('/') && !tile.href.startsWith('//'))
      .map((tile) => ({
        name: `Dashboard tile (${t.label}): ${tile.title}`, category: 'Dashboard tiles', path: tile.href.split('#')[0],
        status: [200, 302], notContains: [SERVER_ERROR], role
      }))))
];

const signedOutGuard = (path) => ({
  name: `Needs sign-in: ${path}`, category: 'Sign-in guards', path, status: 302, redirect: '/auth/login'
});

const handWritten = [
  // ------------------------------------------------------------- search engines
  { name: 'robots.txt keeps crawlers out of search results', category: 'SEO', path: '/robots.txt', status: 200, contains: ['Disallow: /search'] },
  { name: 'Sitemap is served', category: 'SEO', path: '/sitemap.xml', status: 200, contains: ['<urlset'] },
  // Success stories are written by administrators and shown inside another page; the
  // owner took the page out of the sitemap on 2026-10-22.
  { name: 'Sitemap leaves out success stories', category: 'SEO', path: '/sitemap.xml', status: 200, notContains: ['/success-stories</loc>'] },
  { name: 'Search results are noindex', category: 'SEO', path: '/search?q=FI', status: 200, contains: ['noindex'] },

  // ---------------------------------------------------------------- not found
  { name: 'Unknown page is a 404', category: 'Not found', path: '/no-such-page-regression', status: 404, contains: ['Page not found'] },
  { name: 'Unknown rate role is a 404, never a redirect', category: 'Not found', path: '/rates/not-a-role', status: 404 },
  { name: 'Unknown game is a 404', category: 'Not found', path: '/games/not-a-game', status: 404 },
  { name: 'Malformed advert id is refused', category: 'Not found', path: '/applications/44.map', status: [302, 404] },

  // ------------------------------------------------------------------ redirects
  { name: "An unknown sales agent link still reaches sign-up", category: 'Redirects', path: '/s/NOTACODE', status: 302, redirect: '/auth/register' },
  { name: 'Old talent URL goes to the directory', category: 'Redirects', path: '/companies/talent', status: [301, 302], redirect: '/consultants' },

  // ---------------------------------------------------------- signed-out guards
  ...['/dashboard', '/profile/consultant', '/profile/company', '/profile/settings', '/profile/documents',
    '/messages', '/applications', '/notifications', '/quotes', '/jobs/new',
    '/admin', '/admin/users', '/admin/tests', '/admin/rates', '/crm'].map(signedOutGuard),

  // ------------------------------------------------------- role guards, signed in
  // A consultant is turned away from the admin surface by the guard on that route, before
  // any handler runs — the Location proves it was the guard, not a page further on.
  ...['/admin', '/admin/users', '/admin/tests', '/admin/referrals', '/crm'].map((path) => ({
    name: `Consultant refused: ${path}`, category: 'Role guards', path, status: 302, redirect: '/', role: 'consultant'
  })),
  { name: 'Consultant is sent to add the company role for /jobs/new', category: 'Role guards', path: '/jobs/new', status: 302, redirect: '/profile/settings', role: 'consultant' },

  // ------------------------------------------------------------ signed-in pages
  page('Signed-in pages', '/dashboard', { name: 'Consultant dashboard', role: 'consultant', contains: ['Consultant'] }),
  page('Signed-in pages', '/profile/consultant', { name: 'Consultant profile form', role: 'consultant' }),
  page('Signed-in pages', '/profile/settings', { name: 'Consultant settings', role: 'consultant' }),
  page('Signed-in pages', '/messages', { name: 'Consultant inbox', role: 'consultant' }),
  // The Sales Agent tab is on every account's dashboard; it opens on its own ?tab= link.
  page('Signed-in pages', '/dashboard?tab=agent', { name: 'Sales Agent tab', role: 'consultant', contains: ['Agent Dashboard', 'My Leads'] }),
  page('Signed-in pages', '/referrals', { name: 'Sales Agent dashboard', role: 'consultant' }),
  page('Signed-in pages', '/dashboard', { name: 'Company dashboard', role: 'company', contains: ['Company'] }),
  page('Signed-in pages', '/jobs/new', { name: 'Company: post a job', role: 'company' }),
  page('Signed-in pages', '/applications', { name: 'Company pipeline', role: 'company' })
];

const CASES = Object.freeze([...derived, ...handWritten].map((c) => Object.freeze(c)));

function statusesOf(c) {
  return Array.isArray(c.status) ? c.status : [c.status];
}

/** Boot assertion: a broken case is a broken release gate, so it fails where it is seen. */
function assertRegressionIntegrity(cases = CASES) {
  const problems = [];
  const names = new Set();
  cases.forEach((c) => {
    if (!c.name || names.has(c.name)) problems.push(`duplicate or missing name: ${c.name}`);
    names.add(c.name);
    if (!c.category) problems.push(`${c.name}: no category`);
    if (typeof c.path !== 'string' || !c.path.startsWith('/') || c.path.startsWith('//')) problems.push(`${c.name}: path must be a site path`);
    if (!statusesOf(c).every((s) => Number.isInteger(s) && s >= 100 && s < 600)) problems.push(`${c.name}: bad status`);
    if (c.role && !QA_ROLES.includes(c.role)) problems.push(`${c.name}: unknown role ${c.role}`);
    ['contains', 'notContains'].forEach((k) => {
      if (c[k] !== undefined && !(Array.isArray(c[k]) && c[k].every((s) => typeof s === 'string' && s))) problems.push(`${c.name}: ${k} must be a list of strings`);
    });
    if (c.redirect !== undefined && !statusesOf(c).every((s) => s >= 300 && s < 400)) problems.push(`${c.name}: a redirect needs a 3xx status`);
  });
  if (problems.length) throw new Error(`config/regressionTests.js:\n  ${problems.join('\n  ')}`);
  return true;
}

function categoriesOf(cases = CASES) {
  return [...new Set(cases.map((c) => c.category))];
}

module.exports = { CASES, QA_ROLES, assertRegressionIntegrity, categoriesOf, statusesOf };
