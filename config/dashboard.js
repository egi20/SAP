'use strict';

/**
 * The dashboard's tabs and the action tiles on each — the screen somebody lands on after
 * signing in, laid out like dynamicshub.net's: a welcome banner, one tab per role the
 * account holds, and a row of "where next" tiles above that role's own figures.
 *
 * WHY A CATALOGUE. The tiles are links, and the dashboard is the one page every member
 * opens; a tile renamed in one place and not another, or pointing at a route that was
 * never built, is a dead button on the busiest screen. One list, asserted at boot, and an
 * integration test opens every href in it — the same reason the navigation's links are
 * opened by `tests/integration/navigation.test.js`.
 *
 * WHO SEES A TAB is the account's role FLAG, exactly as the route guards read it, so a tab
 * never offers a page its own guard would refuse. The Sales Agent tab is for everybody:
 * any account can join the referral scheme and /referrals shows the join page to somebody
 * who has not, which is the same reading the user menu makes.
 */

const TABS = Object.freeze([
  {
    key: 'consultant',
    label: 'Consultant',
    icon: 'bi-person-badge',
    visible: (user) => Boolean(user.isConsultant),
    tiles: [
      { icon: 'bi-briefcase', tone: 'icon-navyblue', title: 'Find Jobs', text: 'Open SAP roles, ranked against the modules you have delivered.', href: '/jobs', cta: 'Browse Jobs', primary: true },
      { icon: 'bi-person-vcard', tone: 'icon-navy', title: 'Build Profile', text: 'Your photo, modules, delivery history and rate — what hirers search.', href: '/profile/consultant', cta: 'Edit Profile' },
      { icon: 'bi-file-earmark-richtext', tone: 'icon-violet', title: 'CV Generator', text: 'A Word CV built from your profile, ordered for a specific advert.', href: '/cv-generator', cta: 'Generate' },
      { icon: 'bi-send', tone: 'icon-blue', title: 'My Applications', text: 'Where each application stands with the company.', href: '/dashboard/applications', cta: 'View Applications' },
      { icon: 'bi-cash-coin', tone: 'icon-success', title: 'Rate Benchmark', text: 'What your role is worth, factor by factor.', href: '/rates/calculator', cta: 'Benchmark' },
      { icon: 'bi-calculator', tone: 'icon-amber', title: 'Tax Optimization', text: 'An indicative view of a structure for contractors.', href: '/tax', cta: 'Calculate Savings' }
    ]
  },
  {
    key: 'company',
    label: 'Company',
    icon: 'bi-building',
    visible: (user) => Boolean(user.isCompany),
    tiles: [
      { icon: 'bi-plus-square', tone: 'icon-navyblue', title: 'Post a Role', text: 'Advertise a role to consultants who have delivered its modules.', href: '/jobs/new', cta: 'Post a Role', primary: true },
      { icon: 'bi-funnel', tone: 'icon-navy', title: 'Candidate Pipeline', text: 'Every application across your roles, by stage.', href: '/applications', cta: 'Open Pipeline' },
      { icon: 'bi-people', tone: 'icon-blue', title: 'Find Consultants', text: 'Filter the directory by module, certification and availability.', href: '/consultants', cta: 'Browse Talent' },
      { icon: 'bi-briefcase', tone: 'icon-violet', title: 'Your Roles', text: 'Open, paused and closed adverts.', href: '/dashboard/jobs', cta: 'Manage Roles' },
      { icon: 'bi-calculator', tone: 'icon-success', title: 'Scope Estimator', text: 'Effort, phases and budget for an SAP programme.', href: '/quotes/new', cta: 'Estimate' },
      { icon: 'bi-building-gear', tone: 'icon-amber', title: 'Company Profile', text: 'The "About the company" box on every advert.', href: '/profile/company', cta: 'Edit Profile' }
    ]
  },
  {
    key: 'agency',
    label: 'Agency',
    icon: 'bi-person-rolodex',
    visible: (user) => Boolean(user.isRecruiter),
    tiles: [
      { icon: 'bi-speedometer2', tone: 'icon-navyblue', title: 'Agency Dashboard', text: 'Your agency listing and what it needs before it is shown.', href: '/recruiters/dashboard', cta: 'Open', primary: true },
      { icon: 'bi-pencil-square', tone: 'icon-navy', title: 'Agency Profile', text: 'Specialisms, countries and how to reach you.', href: '/recruiters/profile', cta: 'Edit Profile' },
      { icon: 'bi-people', tone: 'icon-blue', title: 'Find Consultants', text: 'Filter the directory by module, certification and availability.', href: '/consultants', cta: 'Browse Talent' }
    ]
  },
  {
    key: 'agent',
    label: 'Sales Agent',
    icon: 'bi-person-badge',
    visible: () => true,
    tiles: [
      { icon: 'bi-speedometer2', tone: 'icon-success', title: 'Agent Dashboard', text: 'Your referral link, what it has earned and what is owed.', href: '/referrals', cta: 'Open Dashboard', primary: true },
      { icon: 'bi-person-lines-fill', tone: 'icon-navy', title: 'My Leads', text: 'The people who signed up through your link.', href: '/referrals#introductions', cta: 'View Leads' }
    ]
  }
]);

function tabsFor(user) {
  return TABS.filter((tab) => tab.visible(user));
}

function assertDashboardIntegrity() {
  const keys = new Set();
  TABS.forEach((tab) => {
    if (keys.has(tab.key)) throw new Error(`Dashboard tab "${tab.key}" is declared twice`);
    keys.add(tab.key);
    if (!tab.label || typeof tab.visible !== 'function') throw new Error(`Dashboard tab "${tab.key}" needs a label and a visibility rule`);
    if (!tab.tiles.length) throw new Error(`Dashboard tab "${tab.key}" has no tiles`);
    tab.tiles.forEach((tile) => {
      ['icon', 'tone', 'title', 'text', 'href', 'cta'].forEach((field) => {
        if (!tile[field]) throw new Error(`Dashboard tile "${tile.title || '?'}" in "${tab.key}" has no ${field}`);
      });
      if (!tile.href.startsWith('/') || tile.href.startsWith('//')) {
        throw new Error(`Dashboard tile "${tile.title}" must link inside the site, not to ${tile.href}`);
      }
    });
  });
}

module.exports = { TABS, tabsFor, assertDashboardIntegrity };
