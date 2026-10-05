#!/usr/bin/env node
'use strict';

/**
 * DEVELOPMENT DATA. Never production.
 *
 * WHY THIS EXISTS, GIVEN THAT create-admin.js EXPLAINS WHY IT DOES NOT.
 *
 * That refusal stands and is about a REAL SITE: two dozen invented day rates publish a
 * benchmark nobody contributed to, and invented consultant profiles are a public directory
 * of people who do not exist. Both are harms to a visitor, and neither has anything to do
 * with somebody walking their own laptop through the navigation with an empty database —
 * which is impossible, because every list page, every filter and every aggregate is a
 * page about rows.
 *
 * So the refusal is kept where it bites, by MAKING IT HARD TO RUN THIS ANYWHERE REAL:
 *
 *   - it refuses when NODE_ENV is production;
 *   - it refuses when APP_BASE_URL is not localhost, which a real deployment always has
 *     set, and --force is the only way past that;
 *   - every account it creates ends in @seed.saphub.test, so seeded rows are identifiable
 *     by eye, in a query, and in the admin screens;
 *   - `npm run seed:dev -- --remove` takes all of it out again.
 *
 * It writes through the MODELS and not through SQL, so seeding exercises the same
 * validation, the same completeness scoring and the same points ledger a real sign-up
 * does. A seed that inserted rows directly would cheerfully create a profile the
 * application itself would have refused to publish.
 */

/*
 * Sequential on purpose, so `no-await-in-loop` is off for this file. Seeding writes rows
 * that depend on rows written a moment earlier — a profile needs its user, a reply needs
 * its post, a published profile needs its completeness recomputed — and running them in
 * parallel would turn a readable script into a dependency graph for no gain on a dataset
 * this size.
 */
/* eslint-disable no-await-in-loop */

const config = require('../config/config');
const { promisePool } = require('../config/database');

const User = require('../models/User');
const ConsultantProfile = require('../models/ConsultantProfile');
const CompanyProfile = require('../models/CompanyProfile');
const RecruiterProfile = require('../models/RecruiterProfile');
const Job = require('../models/Job');
const Skill = require('../models/Skill');
const Post = require('../models/Post');
const RateSubmission = require('../models/RateSubmission');
const SuccessStory = require('../models/SuccessStory');
const SiteReview = require('../models/SiteReview');
const Moderation = require('../models/Moderation');
const Enquiry = require('../models/Enquiry');

const DOMAIN = 'seed.saphub.test';
const PASSWORD = 'Seed-Password-1';

const args = process.argv.slice(2);
const REMOVE = args.includes('--remove');
const FORCE = args.includes('--force');
/*
 * Enough rows to make the pager appear. Both lists page in twenties, so the
 * hand-written set — ten adverts and six people, each written to say something — can
 * never show a second page. The filler says nothing and is not meant to: it exists so
 * that "page 2" and "Showing 21-40" can be clicked.
 */
const VOLUME = args.includes('--volume');

function refuse(message) {
  console.error(`\n  Refusing to run: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Two guards, because one of them is weak on its own. NODE_ENV is easy to leave unset on a
 * server; a base URL is not — a real deployment has to set it for its own links to work.
 */
function environmentLooksLocal() {
  if (config.isProduction) {
    refuse('NODE_ENV is production. This script writes invented people and invented day rates.');
    return false;
  }
  const host = (() => {
    try {
      return new URL(config.app.baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  const local = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host);
  if (!local && !FORCE) {
    refuse(`APP_BASE_URL points at ${host || 'nowhere'}, which is not a local address. Pass --force if you are certain.`);
    return false;
  }
  return true;
}

const email = (local) => `${local}@${DOMAIN}`;

async function makeUser(local, name, roles) {
  const existing = await User.findByEmail(email(local));
  if (existing) return existing;
  // No consent object: an account made from a shell agreed to nothing. Same rule as
  // create-admin.js and create-user.js.
  const user = await User.create({ email: email(local), password: PASSWORD, name, roles });
  await User.setEmailVerified(user.id);
  return user;
}

/* ------------------------------------------------------------------ removal */

async function removeEverything() {
  const like = `%@${DOMAIN}`;

  // Stories carry no FK to a seeded user that would cascade, so they go by their own mark.
  const [[{ stories }]] = await promisePool.query(
    "SELECT COUNT(*) AS stories FROM success_stories WHERE title LIKE 'Seed:%'"
  );
  await promisePool.query("DELETE FROM success_stories WHERE title LIKE 'Seed:%'");
  await promisePool.query('DELETE FROM enquiries WHERE email LIKE ?', [like]);

  const [result] = await promisePool.query('DELETE FROM users WHERE email LIKE ?', [like]);

  console.log(`\n  Removed ${result.affectedRows} seeded account(s) and ${stories} seeded story/stories.`);
  console.log('  Everything they owned went with them — jobs, profiles, posts, rates, replies.\n');
}

/* -------------------------------------------------------------------- people */

const CONSULTANTS = [
  {
    local: 'ana.fi', name: 'Ana Pjetri',
    profile: {
      headline: 'S/4HANA FI/CO consultant, 12 years, remote across the EU',
      bio: 'Finance core on S/4HANA: new GL, parallel ledgers, and the cutovers nobody enjoys. Four full lifecycles, three of them brownfield.',
      primary_role: 's4-fi', seniority: 'lead', country: 'DE', city: 'Munich',
      years_experience: 12, full_lifecycles: 4, day_rate: 1100, currency: 'EUR',
      availability: 'two_weeks', work_mode: 'remote', willing_to_travel: 1
    },
    skills: ['New GL', 'Parallel ledgers', 'FI-AA', 'SAP Activate', 'Data migration'],
    certs: [{ code: 'C_TS4FI' }],
    projects: [
      { name: 'Brownfield conversion for a pharma group', client: 'Confidential', productLine: 's4hana-finance',
        role: 'FI lead', activatePhase: 'realize', isFullLifecycle: true, modules: ['fi-gl', 'fi-aa', 'co-pca'],
        startedOn: '2024-01-15', endedOn: '2025-02-28',
        description: 'ECC 6.0 to S/4HANA 2023, 14 country rollouts, parallel ledger for IFRS and local GAAP.' },
      { name: 'Group reporting implementation', client: 'Confidential', productLine: 's4hana-finance',
        role: 'Solution architect', activatePhase: 'deploy', isFullLifecycle: false, modules: ['fi-gl'],
        startedOn: '2023-03-01', endedOn: '2023-11-30', description: 'Consolidation for a 40-entity group.' }
    ],
    experience: { company: 'Independent', title: 'Freelance SAP FI/CO consultant', startedOn: '2018-04-01', isCurrent: true }
  },
  {
    local: 'ben.ewm', name: 'Ben Karlsson',
    profile: {
      headline: 'EWM and TM consultant — warehouse go-lives that do not slip',
      bio: 'Extended Warehouse Management, embedded and decentralised. Nine years, mostly automotive and retail distribution.',
      primary_role: 's4-ewm', seniority: 'senior', country: 'SE', city: 'Gothenburg',
      years_experience: 9, full_lifecycles: 3, day_rate: 980, currency: 'EUR',
      availability: 'immediate', work_mode: 'hybrid', willing_to_travel: 1
    },
    skills: ['EWM', 'RF framework', 'Wave management', 'MFS', 'ABAP debugging'],
    certs: [{ code: 'C_S4EWM' }],
    projects: [
      { name: 'Decentralised EWM for three DCs', client: 'Confidential', productLine: 's4hana-supply-chain',
        role: 'EWM lead', activatePhase: 'deploy', isFullLifecycle: true, modules: ['ewm', 'mm-im'],
        startedOn: '2024-05-01', endedOn: '2025-06-30', description: 'Wave planning, MFS to two conveyor systems.' }
    ],
    experience: { company: 'Nordic Logistics Partners', title: 'Principal consultant', startedOn: '2019-09-01', isCurrent: true }
  },
  {
    local: 'carla.mm', name: 'Carla Rossi',
    profile: {
      headline: 'MM/SD consultant, procurement and order-to-cash',
      bio: 'Sourcing and procurement with Ariba integration, plus the SD side when the two meet.',
      primary_role: 's4-mm', seniority: 'senior', country: 'IT', city: 'Milan',
      years_experience: 8, full_lifecycles: 2, day_rate: 820, currency: 'EUR',
      availability: 'one_month', work_mode: 'onsite', willing_to_travel: 1
    },
    skills: ['MM', 'SD', 'Ariba integration', 'Pricing procedures'],
    certs: [],
    projects: [
      { name: 'Procurement harmonisation across eight plants', client: 'Confidential', productLine: 's4hana-supply-chain',
        role: 'MM consultant', activatePhase: 'realize', isFullLifecycle: true, modules: ['mm-pur', 'sd-sls'],
        startedOn: '2023-06-01', endedOn: '2024-09-30', description: 'One source list, eight ways of doing it.' }
    ],
    experience: { company: 'Independent', title: 'Freelance SAP MM consultant', startedOn: '2020-01-01', isCurrent: true }
  },
  {
    local: 'dan.abap', name: 'Dan Whitfield',
    profile: {
      headline: 'ABAP and BTP developer — clean core, CDS, RAP',
      bio: 'Extensions that survive the next upgrade. CDS views, RAP, and side-by-side on BTP.',
      primary_role: 'abap-developer', seniority: 'senior', country: 'GB', city: 'Manchester',
      years_experience: 11, full_lifecycles: 2, day_rate: 900, currency: 'EUR',
      availability: 'two_weeks', work_mode: 'remote', willing_to_travel: 0
    },
    skills: ['ABAP', 'CDS views', 'RAP', 'SAP BTP', 'Fiori elements', 'CAP'],
    certs: [{ code: 'C_ABAPD' }],
    projects: [
      { name: 'Clean core extension programme', client: 'Confidential', productLine: 'btp',
        role: 'Lead developer', activatePhase: 'realize', isFullLifecycle: false, modules: ['btp-abap'],
        startedOn: '2024-02-01', endedOn: null, description: 'Moving 180 classic enhancements off the core.' }
    ],
    experience: { company: 'Independent', title: 'Contract SAP developer', startedOn: '2016-06-01', isCurrent: true }
  },
  {
    local: 'eva.sf', name: 'Eva Novak',
    profile: {
      headline: 'SuccessFactors Employee Central and Payroll',
      bio: 'EC, EC Payroll and the integrations between them and everything else.',
      primary_role: 'sf-employee-central', seniority: 'mid', country: 'CZ', city: 'Brno',
      years_experience: 5, full_lifecycles: 1, day_rate: 620, currency: 'EUR',
      availability: 'immediate', work_mode: 'remote', willing_to_travel: 1
    },
    skills: ['Employee Central', 'EC Payroll', 'Integration Center', 'Role-based permissions'],
    certs: [{ code: 'C_THR81' }],
    projects: [
      { name: 'EC rollout for 6,000 employees', client: 'Confidential', productLine: 'successfactors',
        role: 'EC consultant', activatePhase: 'deploy', isFullLifecycle: true, modules: ['sf-ec'],
        startedOn: '2024-09-01', endedOn: '2025-08-31', description: 'Eleven countries, one position model.' }
    ],
    experience: { company: 'CEE People Systems', title: 'HR systems consultant', startedOn: '2021-02-01', isCurrent: true }
  },
  {
    local: 'farid.pm', name: 'Farid Haidari',
    profile: {
      headline: 'SAP programme manager — S/4HANA transformations',
      bio: 'Programme and delivery management across finance and supply chain transformations. Activate, every phase, several times.',
      primary_role: 'programme-manager', seniority: 'lead', country: 'NL', city: 'Utrecht',
      years_experience: 16, full_lifecycles: 5, day_rate: 1250, currency: 'EUR',
      availability: 'one_month', work_mode: 'hybrid', willing_to_travel: 1
    },
    skills: ['SAP Activate', 'Programme governance', 'Cutover planning', 'Vendor management'],
    certs: [],
    projects: [
      { name: 'Global template and five-wave rollout', client: 'Confidential', productLine: 's4hana-finance',
        role: 'Programme manager', activatePhase: 'run', isFullLifecycle: true, modules: ['fi-gl', 'mm-pur', 'sd-sls'],
        startedOn: '2022-01-10', endedOn: '2025-03-31', description: 'Template build plus five country waves.' }
    ],
    experience: { company: 'Independent', title: 'Interim programme manager', startedOn: '2014-01-01', isCurrent: true }
  }
];

const JOBS = [
  { title: 'S/4HANA FI Consultant — brownfield conversion', role: 's4-fi', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'DE', city: 'Munich',
    rate_min: 850, rate_max: 1050, activate_phase: 'realize', status: 'open',
    modules: ['fi-gl', 'fi-aa'], skills: ['New GL', 'FI-AA'],
    description: 'Twelve-month conversion programme. You will own the FI stream through Realize and Deploy, working alongside an existing CO lead.' },
  { title: 'EWM Lead — three distribution centres', role: 's4-ewm', seniority: 'lead',
    engagement_type: 'contract', work_mode: 'hybrid', country: 'SE', city: 'Gothenburg',
    rate_min: 950, rate_max: 1150, activate_phase: 'explore', status: 'open',
    modules: ['ewm'], skills: ['EWM', 'MFS'],
    description: 'Decentralised EWM across three sites, with material flow to two conveyor systems. Explore starts in six weeks.' },
  { title: 'MM/Ariba Consultant', role: 's4-mm', seniority: 'mid',
    engagement_type: 'contract', work_mode: 'onsite', country: 'IT', city: 'Milan',
    rate_min: 650, rate_max: 800, activate_phase: 'realize', status: 'open',
    modules: ['mm-pur', 'ariba-sourcing'], skills: ['MM', 'Ariba integration'],
    description: 'Procurement harmonisation with Ariba Sourcing integration. Italian is useful, not required.' },
  { title: 'ABAP Developer — clean core extensions', role: 'abap-developer', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'GB', city: 'London',
    rate_min: 750, rate_max: 950, activate_phase: 'realize', status: 'open',
    modules: ['btp-abap'], skills: ['ABAP', 'CDS views', 'RAP'],
    description: 'Moving classic enhancements to the extensibility model. CDS and RAP throughout; no modifications to the core.' },
  { title: 'SuccessFactors EC Consultant', role: 'sf-employee-central', seniority: 'mid',
    engagement_type: 'permanent', work_mode: 'hybrid', country: 'CZ', city: 'Prague',
    rate_min: 55000, rate_max: 72000, activate_phase: 'deploy', status: 'open',
    modules: ['sf-ec'], skills: ['Employee Central'],
    description: 'Permanent role in a growing HR systems team. Eleven countries live, three more next year.' },
  { title: 'SAP Programme Manager — S/4HANA transformation', role: 'programme-manager', seniority: 'lead',
    engagement_type: 'contract', work_mode: 'hybrid', country: 'NL', city: 'Amsterdam',
    rate_min: 1100, rate_max: 1400, activate_phase: 'prepare', status: 'open',
    modules: ['fi-gl', 'mm-pur'], skills: ['SAP Activate', 'Cutover planning'],
    description: 'Prepare phase for a five-wave rollout. You will inherit a template and a steering committee with opinions.' },
  { title: 'CO Consultant — product costing', role: 's4-co', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'AT', city: 'Vienna',
    rate_min: 800, rate_max: 980, activate_phase: 'realize', status: 'open',
    modules: ['co-pc', 'co-pca'], skills: ['Product costing', 'Margin analysis'],
    description: 'Product costing and margin analysis for a manufacturing group mid-conversion.' },
  { title: 'SD Consultant — order to cash', role: 's4-sd', seniority: 'mid',
    engagement_type: 'contract', work_mode: 'remote', country: 'ES', city: 'Barcelona',
    rate_min: 600, rate_max: 780, activate_phase: 'explore', status: 'open',
    modules: ['sd-sls'], skills: ['SD', 'Pricing procedures'],
    description: 'Order to cash redesign ahead of a conversion. Pricing is the interesting part.' },
  { title: 'Ariba Consultant — guided buying', role: 'ariba', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'remote', country: 'FR', city: 'Paris',
    rate_min: 800, rate_max: 1000, activate_phase: 'deploy', status: 'open',
    modules: ['ariba-buying'], skills: ['Ariba integration'],
    description: 'Guided buying rollout across four European entities.' },
  { title: 'BTP Integration Developer', role: 'integration-consultant', seniority: 'mid',
    engagement_type: 'contract', work_mode: 'remote', country: 'PL', city: 'Kraków',
    rate_min: 520, rate_max: 680, activate_phase: 'realize', status: 'open',
    modules: ['btp-integration'], skills: ['SAP BTP', 'Integration Suite'],
    description: 'Integration Suite work connecting S/4HANA to three satellite systems.' },
  // Deliberately not open: a draft must be invisible everywhere a visitor can reach, and a
  // closed advert must drop out of the list while staying in the company's dashboard.
  { title: 'DRAFT — QM Consultant, not yet published', role: 's4-qm', seniority: 'mid',
    engagement_type: 'contract', work_mode: 'remote', country: 'DE', city: 'Hamburg',
    rate_min: 700, rate_max: 850, activate_phase: 'explore', status: 'draft',
    modules: ['qm'], skills: ['QM'],
    description: 'This advert is a draft. If you can see it on /jobs or on the home feed, something is wrong.' },
  { title: 'PP Consultant — filled, closed advert', role: 's4-pp', seniority: 'senior',
    engagement_type: 'contract', work_mode: 'hybrid', country: 'DE', city: 'Stuttgart',
    rate_min: 800, rate_max: 950, activate_phase: 'realize', status: 'closed',
    modules: ['pp'], skills: ['PP'],
    description: 'Closed: the role was filled. Kept so the dashboard has a closed advert in it.' }
];

const POSTS = [
  { author: 'ana.fi', kind: 'question', category: 'transitions',
    title: 'Brownfield or greenfield when the chart of accounts is already a mess?',
    body: 'We are 14 countries on ECC with three charts of accounts and a lot of local reporting. The integrator says greenfield. Finance says brownfield because the history matters. What actually decides it in your experience?',
    replies: [
      { author: 'farid.pm', body: 'The question is usually not technical. If the process changes are the point of the programme, greenfield gives you permission to make them. If the point is the platform, brownfield is cheaper and the chart can be cleaned in a separate project.', accept: true },
      { author: 'carla.mm', body: 'Agreed, and watch out for the third option nobody names: selective data transition. Expensive, but it exists.' }
    ] },
  { author: 'ben.ewm', kind: 'discussion', category: 'transitions',
    title: 'Embedded EWM is the default now — is anybody still choosing decentralised?',
    body: 'Embedded keeps winning on paper. In practice I still end up decentralised whenever the warehouse cannot take the core downtime. Curious what others see.',
    replies: [
      { author: 'ben.ewm', body: 'To answer my own question six months on: downtime windows decided three of my last four.' }
    ] },
  { author: 'dan.abap', kind: 'article', category: 'clean-core',
    title: 'Six classic enhancements and what each one becomes under clean core',
    body: 'A worked list rather than a principle. User exits, BAdIs, implicit enhancements, field extensions, custom tables and the reports nobody owns — what each turns into with CDS, RAP and side-by-side, and the one that is usually not worth moving at all.',
    replies: [] },
  { author: 'eva.sf', kind: 'win', category: 'certification',
    title: 'Passed C_THR81 on the second attempt',
    body: 'First attempt I over-studied the config and under-studied permissions. Role-based permissions are most of the exam and most of the job.',
    replies: [] },
  { author: 'carla.mm', kind: 'question', category: 'day-rates',
    title: 'Is an onsite premium still a real thing in southern Europe?',
    body: 'Every advert says hybrid and every client then asks for four days onsite. Is anybody actually charging the difference?',
    replies: [] },
  { author: 'farid.pm', kind: 'discussion', category: 'careers',
    title: 'The hardest part of a cutover is the week after',
    body: 'Hypercare gets planned as a staffing line and not as a phase with its own risks. Everybody is tired, the integrator is rotating people off, and the first month-end is where the programme is actually judged.',
    replies: [
      { author: 'ana.fi', body: 'The first month-end close is the real go-live. I now plan it as a milestone with its own rehearsal.' }
    ] },
  // Hidden, so the moderation screen has something in it and the public lists can be
  // checked for the absence.
  { author: 'carla.mm', kind: 'discussion', category: 'careers',
    title: 'HIDDEN — moderated example post',
    body: 'This post is hidden by the seed so the moderation screen is not empty. It must not appear on the community, the feed, the author page or search.',
    hide: true, replies: [] }
];

/* --------------------------------------------------------------------- seed */

async function seed() {
  console.log('\n  Seeding development data…\n');

  /* People ------------------------------------------------------------- */
  const employer = await makeUser('hiring.co', 'Nordwind Manufacturing', ['company']);
  await CompanyProfile.ensureExists(employer.id, 'Nordwind Manufacturing');
  await CompanyProfile.update(employer.id, {
    company_type: 'end_customer', country: 'DE', city: 'Munich', website: 'https://example.test',
    description: 'A manufacturing group mid-way through an S/4HANA conversion. Hiring contract and permanent across finance and supply chain.',
    size_band: '1000-4999'
  });

  const partner = await makeUser('partner.co', 'Meridian SAP Partners', ['company']);
  await CompanyProfile.ensureExists(partner.id, 'Meridian SAP Partners');
  await CompanyProfile.update(partner.id, {
    company_type: 'consulting_partner', country: 'NL', city: 'Utrecht', website: 'https://example.test',
    description: 'Implementation partner working across S/4HANA finance and supply chain.',
    size_band: '200-999'
  });

  const agency = await makeUser('agency', 'Hanseatic SAP Recruitment', ['recruiter']);
  await RecruiterProfile.save(agency.id, {
    agency_name: 'Hanseatic SAP Recruitment',
    website: 'https://example.test',
    country: 'DE',
    city: 'Hamburg',
    about: 'A small SAP-only agency placing contract consultants across the DACH region and the Nordics. We place people we have placed before.',
    specialisms: ['s4hana-finance', 's4hana-supply-chain', 'successfactors'],
    contact_email: email('agency'),
    team_size: 12,
    founded_year: 2016
  });
  await RecruiterProfile.setPublic(agency.id, true);
  console.log('  companies and one agency');

  const consultants = {};
  for (const spec of CONSULTANTS) {
    const user = await makeUser(spec.local, spec.name, ['consultant']);
    consultants[spec.local] = user;

    await ConsultantProfile.ensureExists(user.id);
    await ConsultantProfile.update(user.id, spec.profile);

    const skills = await Skill.findOrCreateMany(spec.skills);
    await Skill.setForConsultant(user.id, skills.map((s) => s.id));

    for (const cert of spec.certs) {
      await ConsultantProfile.addCertification(user.id, cert).catch((err) => {
        console.log(`    (skipped certification ${cert.code}: ${err.message})`);
      });
    }
    for (const project of spec.projects) await ConsultantProfile.addProject(user.id, project);
    await ConsultantProfile.addExperience(user.id, spec.experience);

    // Publishing is gated on a completeness floor and can refuse. Saying so beats a
    // directory that is quietly empty after a seed that reported success.
    const published = await ConsultantProfile.setPublic(user.id, true);
    if (!published.published) {
      console.log(`    ${spec.name}: only ${published.completeness}% complete, not listed`);
    }
  }
  console.log(`  ${CONSULTANTS.length} consultant profiles`);

  /* Jobs --------------------------------------------------------------- */
  let jobCount = 0;
  for (const spec of JOBS) {
    const owner = spec.title.includes('Programme Manager') ? partner.id : employer.id;
    const job = await Job.create(owner, {
      ...spec,
      rate_visible: 1,
      currency: 'EUR',
      duration_months: spec.engagement_type === 'contract' ? 12 : null
    });
    await Job.setModules(job.id, spec.modules);
    const skills = await Skill.findOrCreateMany(spec.skills);
    await Skill.setForJob(job.id, skills.map((s) => s.id));
    jobCount += 1;
  }
  console.log(`  ${jobCount} job adverts (one draft, one closed, on purpose)`);

  /* Community ---------------------------------------------------------- */
  const [categories] = await promisePool.query('SELECT id, slug FROM post_categories WHERE is_active = 1');
  const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
  const fallbackCategory = categories[0] && categories[0].id;

  let postCount = 0;
  for (const spec of POSTS) {
    const author = consultants[spec.author];
    const categoryId = categoryBySlug[spec.category] || fallbackCategory;
    if (!author || !categoryId) continue;

    const post = await Post.create(author.id, {
      categoryId, kind: spec.kind, title: spec.title, body: spec.body
    });
    postCount += 1;

    for (const reply of spec.replies) {
      const replier = consultants[reply.author];
      if (!replier) continue;
      // `Post.reply` answers { replyId, post } — not a row with an `id`.
      const { replyId } = await Post.reply(post.id, replier.id, reply.body);
      if (reply.accept) await Post.acceptSolution(post.id, replyId, author.id);
    }

    if (spec.hide) {
      const admin = await firstAdmin();
      await Moderation.setPostHidden(post.id, true, {
        actorUserId: admin ? admin.id : author.id,
        reason: 'Seeded example of hidden content.'
      });
    }
  }

  // One Hub article, so /blog is not empty. Written from an admin account, which is the
  // only way the flag can be set.
  const admin = await firstAdmin();
  if (admin && fallbackCategory) {
    await Post.create(admin.id, {
      categoryId: categoryBySlug['clean-core'] || fallbackCategory,
      kind: 'article',
      title: 'Why the rate index withholds a bucket until three people have filled it',
      body: 'A benchmark built from one person is that person\'s pay, published. The floor counts people and not submissions, a suppressed period is shown as a gap rather than a zero, and the editorial model is kept beside the contributed figure rather than blended into it — so you can always tell which part of a number came from evidence.',
      isEditorial: true
    });
    postCount += 1;
  }
  console.log(`  ${postCount} community posts (one hidden, one on the blog)`);

  /* Rates -------------------------------------------------------------- */
  /*
   * Two buckets on purpose: one with enough contributors to publish, one deliberately
   * short of the floor. An index that only ever shows published figures hides the
   * behaviour that makes it trustworthy.
   */
  const publishable = [
    ['ana.fi', 's4-fi', 'lead', 'DE', 1100],
    ['farid.pm', 's4-fi', 'lead', 'DE', 1150],
    ['dan.abap', 's4-fi', 'lead', 'DE', 1050],
    ['carla.mm', 's4-fi', 'lead', 'DE', 1000]
  ];
  const belowFloor = [
    ['ben.ewm', 's4-ewm', 'senior', 'SE', 980],
    ['eva.sf', 's4-ewm', 'senior', 'SE', 920]
  ];

  for (const [local, role, seniority, country, amount] of [...publishable, ...belowFloor]) {
    const user = consultants[local];
    if (!user) continue;
    await RateSubmission.submit(user.id, {
      role, seniority, engagementType: 'contract', workMode: 'remote', country, amount, currency: 'EUR'
    });
  }
  console.log(`  ${publishable.length + belowFloor.length} rate contributions (one bucket publishes, one stays below the floor)`);

  /* Stories and reviews ------------------------------------------------ */
  if (admin) {
    const live = await SuccessStory.create({
      title: 'Seed: fourteen countries converted in eleven months',
      subject_name: 'Nordwind Manufacturing',
      subject_role: 'Head of Finance Systems',
      summary: 'A brownfield conversion with parallel ledgers, delivered across fourteen countries without a month-end being missed.',
      body: 'The programme ran in five waves. The thing that made it work was rehearsing the first month-end close as a milestone in its own right, rather than treating hypercare as a staffing line.',
      quote: 'The first close after go-live is the real go-live. Planning it as a rehearsal changed the whole programme.',
      quote_author: 'Head of Finance Systems, Nordwind Manufacturing',
      family: 's4hana-finance'
    }, { actorUserId: admin.id });
    await SuccessStory.setPublished(live.id, true);

    // Left unpublished, so the difference between "not finished" and "was live and should
    // not be" is visible on the admin screen.
    await SuccessStory.create({
      title: 'Seed: draft story, not published',
      subject_name: 'Meridian SAP Partners',
      subject_role: 'Delivery Director',
      summary: 'An unfinished story, kept as a draft so the two switches can be told apart.',
      body: 'Unpublished means not finished. Hidden means it was live and should not be. Collapsing them loses the retraction.',
      family: 's4hana-supply-chain'
    }, { actorUserId: admin.id });
    console.log('  2 success stories (one published, one draft)');
  }

  const reviewer = consultants['ana.fi'];
  const pendingReviewer = consultants['eva.sf'];
  if (reviewer) {
    await SiteReview.submit(reviewer.id, {
      rating: 5,
      body: 'The module filter reads delivery history rather than a skills list, which is the only reason the directory is worth searching. Finding four EWM people who had actually shipped EWM took a minute.'
    }, { isConsultant: true });
    const [[row]] = await promisePool.query('SELECT id FROM site_reviews WHERE user_id = ?', [reviewer.id]);
    if (row && admin) await SiteReview.setApproved(row.id, true, { actorUserId: admin.id });
  }
  if (pendingReviewer) {
    await SiteReview.submit(pendingReviewer.id, {
      rating: 4,
      body: 'Useful, and the rate index is honest about what it does not know. I would like more SuccessFactors roles, but that is a market problem rather than a site problem.'
    }, { isConsultant: true });
    console.log('  2 reviews (one approved, one waiting)');
  }

  /* The enquiry queue -------------------------------------------------- */
  await Enquiry.create({
    kind: 'contact', userId: null,
    name: 'Seed Visitor', email: email('visitor'),
    subject: 'Seed: question about featuring a job advert',
    body: 'We would like to feature two adverts for a month. Is the price per advert or per window, and can we be invoiced rather than paying by card?'
  });
  await Enquiry.create({
    kind: 'issue', userId: null,
    name: 'Seed Reporter', email: email('reporter'),
    subject: 'Seed: the rate filter keeps my country after I clear it',
    body: 'On /rates I pick Germany, then click Clear, and the country stays selected while the other filters reset. Firefox, latest.',
    issueType: 'bug', severity: 'normal', pageUrl: `${config.app.baseUrl}/rates?country=DE`
  });
  console.log('  2 enquiries waiting in the admin queue');

  if (VOLUME) await seedVolume(employer.id);
}

/* ------------------------------------------------------------------- volume */

const FILLER_ROLES = [
  's4-fi', 's4-co', 's4-mm', 's4-sd', 's4-pp', 's4-ewm', 's4-qm', 's4-tm',
  'sf-employee-central', 'sf-recruiting', 'ariba', 'concur', 'ibp',
  'abap-developer', 'integration-consultant', 'basis-administrator',
  'solution-architect', 'programme-manager', 'data-migration', 'testing-lead'
];
const FILLER_COUNTRIES = ['DE', 'NL', 'SE', 'GB', 'FR', 'ES', 'IT', 'PL', 'CZ', 'AT'];
const FILLER_CITIES = ['Munich', 'Utrecht', 'Gothenburg', 'Manchester', 'Lyon', 'Valencia', 'Bologna', 'Wrocław', 'Brno', 'Graz'];
const FILLER_PHASES = ['prepare', 'explore', 'realize', 'deploy', 'run'];
const FILLER_SENIORITY = ['mid', 'senior', 'lead'];
const FILLER_MODES = ['remote', 'hybrid', 'onsite'];

const { roleLabel: labelForRole } = require('../config/roleTaxonomy');
const { PRODUCT_LINES } = require('../config/sapProducts');

/*
 * Read from the catalogue rather than written out: a module slug typed here would be a
 * second copy of a vocabulary config already owns, and the failure would be a filler row
 * whose module filter matches nothing.
 */
const ALL_FILLER_MODULES = PRODUCT_LINES.flatMap((line) => line.modules.map((m) => m.value));

/**
 * Filler, and it is labelled as filler.
 *
 * Every row says "Seed filler" in a place a reader will see it, because the one thing
 * worse than an empty directory is a full one somebody mistakes for real. The interesting
 * rows are the hand-written ones above; these exist to make a second page exist.
 */
async function seedVolume(employerId) {
  const extraJobs = 26;
  for (let i = 0; i < extraJobs; i += 1) {
    const role = FILLER_ROLES[i % FILLER_ROLES.length];
    const n = String(i + 1).padStart(2, '0');
    const job = await Job.create(employerId, {
      title: `Seed filler ${n} — ${labelForRole(role)}`,
      description: 'Seed filler. This advert exists so the job list has more than one page; it describes no real engagement.',
      role,
      seniority: FILLER_SENIORITY[i % FILLER_SENIORITY.length],
      engagement_type: i % 5 === 0 ? 'permanent' : 'contract',
      work_mode: FILLER_MODES[i % FILLER_MODES.length],
      country: FILLER_COUNTRIES[i % FILLER_COUNTRIES.length],
      city: FILLER_CITIES[i % FILLER_CITIES.length],
      rate_min: 500 + (i % 8) * 50,
      rate_max: 700 + (i % 8) * 60,
      rate_visible: 1,
      currency: 'EUR',
      duration_months: 6 + (i % 7),
      activate_phase: FILLER_PHASES[i % FILLER_PHASES.length],
      status: 'open'
    });
    await Job.setModules(job.id, [ALL_FILLER_MODULES[i % ALL_FILLER_MODULES.length]]);
  }

  const extraConsultants = 22;
  for (let i = 0; i < extraConsultants; i += 1) {
    const role = FILLER_ROLES[i % FILLER_ROLES.length];
    const n = String(i + 1).padStart(2, '0');
    const user = await makeUser(`filler${n}`, `Seed Filler ${n}`, ['consultant']);

    await ConsultantProfile.ensureExists(user.id);
    await ConsultantProfile.update(user.id, {
      headline: `Seed filler ${n} — ${labelForRole(role)}`,
      bio: 'Seed filler. This profile exists so the talent directory has more than one page; it describes no real person.',
      primary_role: role,
      seniority: FILLER_SENIORITY[i % FILLER_SENIORITY.length],
      country: FILLER_COUNTRIES[i % FILLER_COUNTRIES.length],
      city: FILLER_CITIES[i % FILLER_CITIES.length],
      years_experience: 3 + (i % 15),
      full_lifecycles: i % 4,
      day_rate: 550 + (i % 10) * 55,
      currency: 'EUR',
      availability: ['immediate', 'two_weeks', 'one_month'][i % 3],
      work_mode: FILLER_MODES[i % FILLER_MODES.length],
      willing_to_travel: i % 2
    });

    const skills = await Skill.findOrCreateMany([labelForRole(role), 'SAP Activate']);
    await Skill.setForConsultant(user.id, skills.map((sk) => sk.id));

    // A profile needs a project and an engagement to clear the publishing floor; without
    // them the seed would report success and leave the directory the size it was.
    await ConsultantProfile.addProject(user.id, {
      name: `Seed filler engagement ${n}`,
      client: 'Confidential',
      role: labelForRole(role),
      activatePhase: FILLER_PHASES[i % FILLER_PHASES.length],
      isFullLifecycle: i % 3 === 0,
      modules: [ALL_FILLER_MODULES[i % ALL_FILLER_MODULES.length]],
      startedOn: '2023-01-09',
      endedOn: '2024-06-28',
      description: 'Seed filler.'
    });
    await ConsultantProfile.addExperience(user.id, {
      company: 'Independent', title: 'Seed filler', startedOn: '2019-01-07', isCurrent: true
    });

    const published = await ConsultantProfile.setPublic(user.id, true);
    if (!published.published && i === 0) {
      console.log(`    filler profiles reach only ${published.completeness}% and will not list`);
    }
  }

  console.log(`  + ${extraJobs} filler adverts and ${extraConsultants} filler profiles, so both lists page`);
}

async function firstAdmin() {
  const [rows] = await promisePool.query(
    "SELECT id FROM users WHERE user_type = 'admin' AND is_active = 1 ORDER BY id ASC LIMIT 1"
  );
  return rows[0] || null;
}

/* --------------------------------------------------------------------- main */

(async () => {
  try {
    if (!environmentLooksLocal()) return;

    if (REMOVE) {
      await removeEverything();
      return;
    }

    const admin = await firstAdmin();
    if (!admin) {
      console.log('\n  No administrator exists yet, so the blog article, the stories and the');
      console.log('  approved review will be skipped. Run npm run create-admin first if you');
      console.log('  want those too.\n');
    }

    await seed();

    console.log('\n  Done. Every seeded account signs in with:\n');
    console.log(`    password  ${PASSWORD}\n`);
    console.log('    consultant   ana.fi@seed.saphub.test   (also: ben.ewm, carla.mm, dan.abap, eva.sf, farid.pm)');
    console.log('    company      hiring.co@seed.saphub.test, partner.co@seed.saphub.test');
    console.log('    agency       agency@seed.saphub.test');
    if (!VOLUME) {
    console.log('\n  Both lists page in twenties, so this set shows one page. Add --volume');
    console.log('  for filler rows that make a second one exist.');
  }
  console.log('\n  Remove it all again with:  npm run seed:dev -- --remove\n');
  } catch (err) {
    console.error(`\n  Seeding failed: ${err.message}\n`);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await promisePool.end().catch(() => {});
  }
})();
