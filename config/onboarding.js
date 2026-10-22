'use strict';

/**
 * The first-login welcome tour, as on dynamicshub.net (owner's request, 2026-10-22).
 *
 * ONE catalogue of steps per audience; the partial renders from it and
 * `tests/integration/onboarding.test.js` opens every href, for the reason the dashboard's
 * tiles are opened: a tour whose first button lands on a 404 is the first thing a new
 * member sees go wrong.
 *
 * The steps are the same destinations as the dashboard's primary tiles, written as a tour
 * rather than a grid. They say what each page is FOR, and none of them carries a number
 * that moves — same rule as the landing pages.
 */

const AUDIENCES = Object.freeze({
  consultant: Object.freeze([
    { icon: 'bi-person-vcard', tone: 'icon-navyblue', title: 'Build your profile', body: 'Your modules, delivery history and day rate are what hirers search. The delivered modules are the part a CV cannot show.', href: '/profile/consultant', cta: 'Build my profile' },
    { icon: 'bi-briefcase', tone: 'icon-navy', title: 'Find SAP work', body: 'Open roles, ranked against the modules you have actually delivered. Applying is free.', href: '/jobs', cta: 'Browse jobs' },
    { icon: 'bi-file-earmark-richtext', tone: 'icon-violet', title: 'A CV from your profile', body: 'A Word CV built from what you entered, ordered for a specific advert. It writes nothing you did not.', href: '/cv-generator', cta: 'Open the CV generator' },
    { icon: 'bi-cash-coin', tone: 'icon-success', title: 'What your role is worth', body: 'Benchmark a day rate factor by factor, beside what other consultants have contributed.', href: '/rates', cta: 'Open the rate index' }
  ]),
  company: Object.freeze([
    { icon: 'bi-plus-square', tone: 'icon-navyblue', title: 'Post a role', body: 'Advertise to consultants who have delivered its modules. Posting and hiring cost nothing.', href: '/jobs/new', cta: 'Post a role' },
    { icon: 'bi-people', tone: 'icon-navy', title: 'Find consultants', body: 'Filter the directory by module, certification and availability. Names are shown to signed-in members.', href: '/consultants', cta: 'Browse talent' },
    { icon: 'bi-calculator', tone: 'icon-violet', title: 'Estimate a programme', body: 'Effort, SAP Activate phases and budget for an SAP scope, with a Word, Excel and PowerPoint pack.', href: '/quotes/new', cta: 'Open the estimator' },
    { icon: 'bi-funnel', tone: 'icon-success', title: 'Track candidates', body: 'Every application across your roles, by stage, in one pipeline.', href: '/applications', cta: 'Open the pipeline' }
  ]),
  other: Object.freeze([
    { icon: 'bi-house-door', tone: 'icon-navyblue', title: 'The home feed', body: 'New roles, questions and articles from the SAP community, in one stream.', href: '/', cta: 'Open the feed' },
    { icon: 'bi-gear', tone: 'icon-navy', title: 'Your account', body: 'Add the consultant or company role whenever you need it, from your settings.', href: '/profile/settings', cta: 'Open settings' }
  ])
});

/** A dual-role account gets the general tour, as on the reference: neither half is "the" one. */
function audienceFor(user) {
  if (!user) return 'other';
  if (user.isConsultant && !user.isCompany) return 'consultant';
  if (user.isCompany && !user.isConsultant) return 'company';
  return 'other';
}

function stepsFor(user) {
  return AUDIENCES[audienceFor(user)];
}

function assertOnboardingIntegrity() {
  Object.entries(AUDIENCES).forEach(([audience, steps]) => {
    if (!steps.length) throw new Error(`Onboarding: "${audience}" has no steps`);
    steps.forEach((s) => {
      ['icon', 'tone', 'title', 'body', 'href', 'cta'].forEach((field) => {
        if (typeof s[field] !== 'string' || !s[field]) throw new Error(`Onboarding step "${s.title}" (${audience}) has no ${field}`);
      });
      if (!s.href.startsWith('/') || s.href.startsWith('//')) throw new Error(`Onboarding step "${s.title}" must link inside the site`);
    });
  });
  return true;
}

module.exports = { AUDIENCES, audienceFor, stepsFor, assertOnboardingIntegrity };
