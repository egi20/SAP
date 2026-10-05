'use strict';

const config = require('./config');

/**
 * Per-page canonical URL + meta description, plus a JobPosting JSON-LD builder.
 *
 * Rule carried over from both references: the sitemap and the canonical set must never
 * advertise a URL that robots.txt disallows. `PUBLIC_PATHS` is the allowlist both consult.
 *
 * A page gets an entry here when it EXISTS. The reference's copy lists pages for every
 * feature it has; pages listed before they are built put 404s in the sitemap, which is a
 * slow and self-inflicted way to lose crawl budget.
 */
const PAGE_META = {
  '/': {
    title: 'SAP Hub — jobs, talent and day rates for the SAP ecosystem',
    description:
      'Find SAP contract and permanent roles, hire experienced consultants, and see real day-rate benchmarks across S/4HANA, SuccessFactors, Ariba, BTP and Analytics.'
  },
  '/jobs': {
    title: 'SAP jobs and contracts',
    description:
      'Browse SAP jobs by module, role, seniority, country and day rate. FI, CO, MM, SD, PP, EWM, SuccessFactors, Ariba, BTP and more.'
  },
  '/consultants': {
    title: 'Hire SAP consultants',
    description:
      'Search SAP consultants by the modules they have delivered, certification, full lifecycles, availability and day rate.'
  },
  '/companies': {
    title: 'Companies hiring on SAP Hub',
    description: 'Partners, ISVs and end customers hiring SAP talent.'
  },
  '/recruiters': {
    title: 'SAP recruitment agencies',
    description: 'Agencies and headhunters placing SAP people, by product line and country.'
  },
  '/contact': {
    title: 'Contact SAP Hub',
    description: 'How to reach a person about an account, a payment, a quote or a job.'
  },
  '/success-stories': {
    title: 'SAP success stories',
    description: 'Case studies from real SAP engagements, and what members say about the Hub.'
  },
  '/rates': {
    title: 'SAP day rate index',
    description:
      'Aggregated day rates for SAP roles, contributed anonymously by the community. Aggregates below three contributors are suppressed.'
  },
  '/community': {
    title: 'The SAP community',
    description:
      'Questions, discussions, articles and wins from SAP consultants and the companies hiring them. '
      + 'Transitions, clean core, certification, day rates and every product line.'
  },
  '/rates/calculator': {
    title: 'Benchmark your SAP day rate',
    description:
      'What an SAP role is worth: a published day-rate model by role, experience, region, certifications and contract type — with the arithmetic shown.'
  },
  '/about': {
    title: 'About SAP Hub',
    description: 'What SAP Hub is, who it is for, and what it deliberately does not do.'
  },
  '/faq': {
    title: 'SAP Hub — frequently asked questions',
    description:
      'How the day-rate index is built, what the scope estimator produces, what the LinkedIn badge means, and what anything costs.'
  },
  '/consultant-hub': {
    title: 'SAP Hub for consultants',
    description:
      'Find SAP contract and permanent work, benchmark your day rate, and build a profile companies filter by what you have actually delivered.'
  },
  '/company-hub': {
    title: 'SAP Hub for companies',
    description:
      'Hire SAP consultants by delivered modules, size a programme into consultant-days and a budget, and see what the market pays.'
  },
  '/report-issue': {
    title: 'Report a problem',
    description: 'Tell us about something broken, confusing or behaving differently from what the page said.'
  },
  '/auth/login': { title: 'Sign in', description: 'Sign in to SAP Hub.' },
  '/auth/register': { title: 'Create an account', description: 'Join SAP Hub as a consultant or a hiring company.' }
};

/** Paths that may appear in the sitemap and carry a canonical URL. */
const PUBLIC_PATHS = ['/', '/jobs', '/consultants', '/companies', '/recruiters', '/rates',
  '/rates/calculator', '/community', '/community/articles', '/success-stories',
  '/consultant-hub', '/company-hub', '/about', '/faq', '/contact', '/report-issue',
  '/legal/privacy', '/legal/terms'];

function canonicalUrl(path) {
  const clean = String(path || '/').split('?')[0];
  return `${config.app.baseUrl}${clean === '/' ? '' : clean}`;
}

/**
 * Express middleware: expose `seo` on res.locals for every render.
 */
function seoLocals(req, res, next) {
  const meta = PAGE_META[req.path] || {};
  res.locals.seo = {
    title: meta.title || config.app.name,
    description: meta.description || PAGE_META['/'].description,
    canonical: canonicalUrl(req.path),
    ogImage: `${config.app.baseUrl}/images/og-default.svg`,
    indexable: PUBLIC_PATHS.includes(req.path)
  };
  next();
}

/**
 * schema.org JobPosting. Returns null when the job lacks the fields Google requires,
 * so we never emit structured data that fails validation.
 */
function jobPostingJsonLd(job) {
  if (!job || !job.title || !job.created_at) return null;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.title,
    description: job.description || '',
    datePosted: new Date(job.created_at).toISOString(),
    employmentType: job.engagement_type === 'permanent' ? 'FULL_TIME' : 'CONTRACTOR',
    hiringOrganization: {
      '@type': 'Organization',
      name: job.company_name || 'Confidential',
      sameAs: job.company_website || undefined
    },
    jobLocationType: job.work_mode === 'remote' ? 'TELECOMMUTE' : undefined,
    jobLocation: job.country
      ? { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: job.country } }
      : undefined
  };

  if (job.expires_at) ld.validThrough = new Date(job.expires_at).toISOString();

  if (job.rate_min && job.rate_max) {
    ld.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: job.currency || 'EUR',
      value: {
        '@type': 'QuantitativeValue',
        minValue: Number(job.rate_min),
        maxValue: Number(job.rate_max),
        unitText: job.engagement_type === 'permanent' ? 'YEAR' : 'DAY'
      }
    };
  }

  return ld;
}

module.exports = { PAGE_META, PUBLIC_PATHS, canonicalUrl, seoLocals, jobPostingJsonLd };
