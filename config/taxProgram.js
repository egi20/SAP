'use strict';

/**
 * The tax optimisation programme: what /tax says, what its calculator charges and what the
 * application form at /tax/apply offers.
 *
 * THIS REVERSES A STANDING REFUSAL, BY THE OWNER'S DECISION (2026-10-07). Until then /tax
 * introduced a specialist and computed nothing, and docs/PORT-PLAN.md listed "the tax
 * savings calculator" among the refusals that must not quietly arrive. It arrives here
 * openly: the page now matches dynamicshub.net/tax-optimization, including the calculator.
 *
 * What the calculator does NOT do, and the page says so under every result: it does not
 * compute the personal income tax somebody may owe where they are tax resident. The
 * reference's formula (cost = fixed fee + a share of gross) treats that as zero, and the
 * country field moves nothing. So every figure it prints is labelled indicative — a
 * saving shown without that line is advice the page cannot stand behind.
 *
 * Every number the calculator uses lives HERE and reaches the browser through data
 * attributes on the form, so the page, the stored estimate on an application and the
 * tests cannot disagree about the formula.
 *
 * The factual claims (the entity, the accountants, how many consultants use it, the
 * average saving) are the owner's statements about SAP Hub and are kept here, in one
 * place, so they are changed in one place when they change.
 */

const TAX_PROGRAM = Object.freeze({
  entityName: 'SAP Hub',
  stats: Object.freeze([
    Object.freeze({ value: '€20K+', label: 'Avg. Annual Savings' }),
    Object.freeze({ value: '40+', label: 'Tax Treaties' }),
    Object.freeze({ value: '2-4', label: 'Weeks Onboarding' })
  ]),
  // Euros a month, plus a share of gross. Same as the reference.
  fixedMonthlyFee: 150,
  costRate: 0.1,
  minEligibleGross: 4000
});

/*
 * Only REAL stories, with the person's permission. Empty means the section is not
 * rendered. The reference's four are Dynamics 365 consultants; republished here as SAP
 * consultants they would be invented testimonials.
 *
 * { initial: 'X', name: 'Name S.', role: 'SAP FICO Consultant', country: 'Italy',
 *   beforeGross: 12000, beforeNet: 6800, afterGross: 12000, afterNet: 10440, quote: '...' }
 */
const TAX_SUCCESS_STORIES = Object.freeze([]);

const COUNTRIES = Object.freeze(['Albania', 'Andorra', 'Argentina', 'Australia', 'Austria', 'Bahrain',
  'Belgium', 'Bosnia and Herzegovina', 'Brazil', 'Bulgaria', 'Canada', 'Chile', 'China', 'Croatia',
  'Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece',
  'Hong Kong', 'Hungary', 'Iceland', 'India', 'Ireland', 'Israel', 'Italy', 'Japan', 'Kosovo',
  'Kuwait', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Mexico', 'Montenegro',
  'Netherlands', 'New Zealand', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Qatar',
  'Romania', 'San Marino', 'Saudi Arabia', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia',
  'South Africa', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Turkey',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Other']);

// The shorter list the reference's application form offers.
const APPLY_COUNTRIES = Object.freeze(['Albania', 'Australia', 'Austria', 'Belgium', 'Canada',
  'Czech Republic', 'Denmark', 'Finland', 'France', 'Germany', 'Hungary', 'Ireland', 'Italy',
  'Kosovo', 'Netherlands', 'Norway', 'Poland', 'Portugal', 'Romania', 'Serbia', 'Spain', 'Sweden',
  'Switzerland', 'United Kingdom', 'United States', 'Other']);

/*
 * The application form's closed lists. The server accepts a value only if it is on its
 * list — a select is a suggestion to the browser, not a constraint on the request.
 */
const APPLY_OPTIONS = Object.freeze({
  timezone: ['London (GMT/BST)', 'Paris/Berlin/Amsterdam (CET)', 'Helsinki/Bucharest (EET)',
    'New York (EST)', 'Los Angeles (PST)', 'Dubai (GST)', 'Other'],
  employmentType: ['Permanently Employed', 'Freelancer / Self-Employed', 'Independent Contractor',
    'Business Owner (Ltd/GmbH/BV)'],
  noticePeriod: ['Immediately available', '2 weeks', '1 month', '2 months', '3 months', '6 months', 'Other'],
  billingCurrency: ['EUR', 'USD', 'GBP', 'CHF'],
  yearsExperience: ['1-2 years', '3-5 years', '6-10 years', '10-15 years', '15+ years'],
  remotePreference: ['100% Remote', 'Hybrid (some office time)', 'Flexible', 'On-site preferred'],
  availabilityHoursPerWeek: ['Full-time (40 hours)', '32 hours (4 days)', 'Part-time (24 hours)',
    'Part-time (20 hours)'],
  howHeardAboutUs: ['LinkedIn', 'Google Search', 'Referral from a friend/colleague', 'Job Board',
    'Social Media', 'Conference/Event', 'Blog/Article', 'Other']
});

const FAQ = Object.freeze([
  {
    q: 'Is this legal? Will I have problems with tax authorities?',
    a: [
      'Our Albanian entity is fully compliant with Albanian law. You will be a legitimate employee with a proper employment contract, social security contributions, and tax filings in Albania. Albania maintains double tax treaties with over 40 countries, which may help reduce withholding taxes.',
      'Important: Your personal tax obligations depend on where you are tax resident (typically where you live). Working through an Albanian entity does not exempt you from taxes in your home country. Albanian taxes paid may be claimable as foreign tax credits depending on your local laws.',
      'We strongly recommend consulting with a tax advisor in your home country before joining to understand your specific obligations and any reporting requirements.'
    ]
  },
  {
    q: 'Do I need to move to Albania?',
    a: [
      "No, you don't need to relocate. You can continue living and working from your current location. Albanian employment law allows remote workers to be employed without requiring physical presence in Albania.",
      "You can work from anywhere in the world. Your work arrangement with clients doesn't change at all."
    ]
  },
  {
    q: 'What about my existing clients? Do I need to tell them?',
    a: [
      'Your client relationships remain unchanged. You continue working on the same projects with the same people. The only administrative difference is that invoices come from SAP Hub instead of your personal entity.',
      "Some consultants inform their clients about the change, others don't. It's a personal choice. From the client's perspective, they're working with the same consultant, just through a different legal entity."
    ]
  },
  {
    q: 'How does payment work? When do I get paid?',
    a: [
      'We handle all invoicing to your clients. When clients pay the invoice, we process your salary monthly with minimal deductions for social security and administrative costs.',
      'Your salary is paid by bank transfer around the 25th of each month. You receive detailed payslips showing all deductions and contributions.'
    ]
  },
  {
    q: 'What about health insurance and pension?',
    a: ['The social security contribution covers:'],
    list: [
      'Basic health insurance in Albania (you may want to maintain private insurance in your home country)',
      'Pension contributions',
      'Social security benefits'
    ]
  },
  {
    q: 'Can I switch back to my own company later?',
    a: [
      'Yes, absolutely. Our employment contracts have a standard notice period (typically 1-3 months depending on your specific agreement). You can terminate the employment relationship at any time with proper notice.',
      "There's no long-term lock-in. Many consultants try this for a year to see the savings before deciding to continue."
    ]
  },
  {
    q: 'Are there any hidden costs or additional fees?',
    a: [
      'No hidden fees. The total costs shown in the calculator include everything: social security contributions, administrative fees, and all other operational costs.',
      'There are no setup fees, no onboarding costs, no minimum contract value, and no percentage-based commissions. What you see in the calculator is what you get.'
    ]
  },
  {
    q: 'How long does the onboarding process take?',
    a: ['Typical timeline:'],
    list: ['Application review: 48 hours', 'Contract preparation: 3-5 business days', 'Registration & setup: 1-2 weeks'],
    after: 'Most consultants are fully onboarded and ready to invoice clients within 2-4 weeks from initial application.'
  }
]);

/**
 * The calculator, as a pure function. The browser runs the same arithmetic from the same
 * two constants (public/js/tax.js, fed by data attributes), and the application route runs
 * THIS on the figures posted, so a stored estimate is never a number the browser chose.
 */
function estimate(gross, net, program = TAX_PROGRAM) {
  const g = Number(gross);
  const n = Number(net);
  if (!(g > 0) || !(n > 0)) return null;
  const cost = program.fixedMonthlyFee + program.costRate * g;
  const newNet = g - cost;
  const monthly = newNet - n;
  return {
    cost: Math.round(cost),
    newNet: Math.round(newNet),
    monthly: Math.round(monthly),
    annual: Math.round(monthly * 12),
    percent: Number(((monthly / n) * 100).toFixed(1))
  };
}

function assertTaxProgramIntegrity() {
  const problems = [];
  const p = TAX_PROGRAM;
  if (!Number.isFinite(p.fixedMonthlyFee) || p.fixedMonthlyFee < 0) problems.push('fixedMonthlyFee must be a non-negative number');
  // A rate of zero or above one makes every result nonsense rather than an error.
  if (!(p.costRate > 0 && p.costRate < 1)) problems.push('costRate must be between 0 and 1');
  if (!(p.minEligibleGross > 0)) problems.push('minEligibleGross must be positive');
  if (!p.entityName) problems.push('entityName is empty');
  if (!p.stats.length) problems.push('stats is empty');
  FAQ.forEach((f, i) => {
    if (!f.q || !Array.isArray(f.a) || !f.a.length) problems.push(`FAQ ${i} needs a question and an answer`);
  });
  TAX_SUCCESS_STORIES.forEach((s, i) => {
    ['name', 'role', 'country', 'quote'].forEach((k) => { if (!s[k]) problems.push(`story ${i} has no ${k}`); });
    ['beforeGross', 'beforeNet', 'afterGross', 'afterNet'].forEach((k) => {
      if (!(Number(s[k]) > 0)) problems.push(`story ${i} has no ${k}`);
    });
  });
  APPLY_COUNTRIES.forEach((c) => { if (!COUNTRIES.includes(c)) problems.push(`apply country ${c} is not in COUNTRIES`); });
  if (problems.length) throw new Error(`config/taxProgram.js: ${problems.join('; ')}`);
}

module.exports = {
  TAX_PROGRAM,
  TAX_SUCCESS_STORIES,
  COUNTRIES,
  APPLY_COUNTRIES,
  APPLY_OPTIONS,
  FAQ,
  estimate,
  assertTaxProgramIntegrity
};
