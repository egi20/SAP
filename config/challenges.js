'use strict';

const crypto = require('crypto');

const { seedCategories } = require('./community');

/**
 * The daily challenge: questions, and the rule that the browser never sees an answer.
 *
 * THE FINDING THAT DECIDES THE WHOLE DESIGN. DynamicsHub's game system is
 * client-authoritative from end to end:
 *
 *   routes/games.js:41   const { score, gameDate } = req.body;
 *
 * The browser tells the server what it scored, and the server writes that number to a
 * leaderboard. `gameDate` comes from the request too, so any date can be backfilled. And
 * it does not matter anyway, because all 2467 lines of `views/partials/games-section.ejs`
 * ship every question TOGETHER WITH the index of its correct answer:
 *
 *   { q: "What does D365 F&O stand for?", options: [...], correct: 0 }
 *
 * Anyone signed in can post `{score: 999999, gameDate: '2020-01-01'}` with one fetch, and
 * anyone curious can read the answers in view-source. That output then feeds
 * `getUserPointsSummary` — so a browser can mint points. In this codebase the points
 * ledger is append-only and auditable precisely so that a total can always be explained;
 * a client-authored score destroys that property for every total on the site, not just
 * the cheater's.
 *
 * So: the answers live here and never leave the process. The page is sent questions with
 * the `answer` field stripped, the browser posts the OPTIONS IT CHOSE, and
 * `gradeAnswers()` — a pure function — decides the score. The date comes from the server
 * clock. One attempt per person per day is enforced by a unique key in the schema.
 *
 * ONE game, done properly, rather than the reference's nine. The other eight (match,
 * flashcard, typing, word search, bug hunter, scenario, code quiz, streak check-in) are
 * the same client-authoritative shape wearing different UI; porting them would be porting
 * the bug eight more times. The streak is kept, but DERIVED from attempt dates rather than
 * posted by a `POST /streak/checkin` the browser can call as often as it likes.
 */

/**
 * The question bank.
 *
 * `answer` is an index into `options` and is NEVER serialised to a client — `publicFormOf`
 * is the only thing a route may render, and a test asserts the route module cannot reach
 * the raw bank. `explain` is shown AFTER grading, which is the part that makes this worth
 * playing rather than a slot machine.
 *
 * `topic` ties a question to a COMMUNITY CATEGORY slug — a product line or one of the
 * cross-cutting ones — so a result can say which area somebody is weak on instead of a
 * number out of five, and so "go and read about clean core" lands on a category that
 * actually exists. The boot assertion checks every topic against `seedCategories()`,
 * because a question tagged with a slug nothing else knows is a dead end for a reader.
 */
/**
 * The topics a question may carry: every community category slug, which is the eight
 * product lines plus the cross-cutting ones. Derived, so adding a product line adds a
 * topic with no edit here.
 */
const TOPIC_SLUGS = new Set(seedCategories().map((category) => category.slug));

const QUESTIONS = Object.freeze([
  {
    id: 'activate-phase-order',
    topic: 'transitions',
    prompt: 'In SAP Activate, which phase comes immediately after Explore?',
    options: ['Prepare', 'Realize', 'Deploy', 'Run'],
    answer: 1,
    explain:
      'Discover, Prepare, Explore, Realize, Deploy, Run. Explore is where fit-to-standard '
      + 'happens and the backlog is agreed; Realize is where it is configured and built.'
  },
  {
    id: 'activate-fit-to-standard',
    topic: 'transitions',
    prompt: 'What is a fit-to-standard workshop for?',
    options: [
      'Gathering requirements from a blank page',
      'Showing the standard process and recording where it does not fit',
      'Writing the technical specification',
      'Signing off the cutover plan'
    ],
    answer: 1,
    explain:
      'Activate starts from the delivered process and records the deltas. That is the '
      + 'difference from ASAP-era blueprinting, where requirements were collected first '
      + 'and the standard was discovered afterwards — usually too late to use it.'
  },
  {
    id: 'transition-brownfield',
    topic: 'transitions',
    prompt: 'What does a brownfield S/4HANA project do?',
    options: [
      'Converts the existing ERP system in place',
      'Implements on a new, empty system',
      'Moves selected company codes onto a new system',
      'Upgrades only the database'
    ],
    answer: 0,
    explain:
      'Brownfield is a system conversion: same system, same history, converted. Greenfield '
      + 'is a new implementation, and selective data transition moves chosen entities or '
      + 'company codes across. The estimator prices all three differently for this reason.'
  },
  {
    id: 'transition-readiness-check',
    topic: 'transitions',
    prompt: 'What does the SAP Readiness Check produce for a conversion?',
    options: [
      'A licence quotation',
      'An analysis of simplification items, custom code and add-on compatibility',
      'A finished cutover plan',
      'A set of test scripts'
    ],
    answer: 1,
    explain:
      'It is an assessment, not a plan: relevant simplification items, custom code that '
      + 'will not survive, incompatible add-ons and sizing. Everything it finds still has '
      + 'to be estimated and scheduled by a person.'
  },
  {
    id: 'finance-universal-journal',
    topic: 's4hana-finance',
    prompt: 'Which table is the Universal Journal in S/4HANA?',
    options: ['BSEG', 'BKPF', 'ACDOCA', 'FAGLFLEXA'],
    answer: 2,
    explain:
      'ACDOCA holds FI and CO line items in one table, which is what removes the old '
      + 'reconciliation between them. BKPF and BSEG still exist for the document itself; '
      + 'FAGLFLEXA is the classic New G/L totals table that ACDOCA supersedes.'
  },
  {
    id: 'finance-business-partner',
    topic: 's4hana-finance',
    prompt: 'In S/4HANA, what replaced separate customer and vendor master records?',
    options: ['Central Finance', 'The Business Partner', 'Master Data Governance', 'The Universal Journal'],
    answer: 1,
    explain:
      'Business Partner is mandatory: customer and vendor are roles on one partner. '
      + 'Customer-vendor integration is the conversion step that most often holds a '
      + 'brownfield project up, because the legacy data has to be clean before it runs.'
  },
  {
    id: 'finance-central-finance',
    topic: 's4hana-finance',
    prompt: 'What is Central Finance?',
    options: [
      'An S/4HANA system that replicates postings from existing source systems',
      'A cloud-only general ledger',
      'The consolidation module',
      'A migration tool for master data'
    ],
    answer: 0,
    explain:
      'It gives one reporting layer across several ERPs by replicating documents into an '
      + 'S/4HANA system, without converting the sources. It is a way to start without a '
      + 'conversion, not a way to avoid one forever.'
  },
  {
    id: 'sc-material-number-length',
    topic: 's4hana-supply-chain',
    prompt: 'What is the maximum material number length available in S/4HANA?',
    options: ['18 characters', '24 characters', '40 characters', '30 characters'],
    answer: 2,
    explain:
      'Extended to 40. It is off by default and switching it on cannot be undone, so it '
      + 'is a decision taken once with the interfaces in mind, never a setting to try.'
  },
  {
    id: 'sc-account-determination',
    topic: 's4hana-supply-chain',
    prompt: 'What decides the G/L account a goods receipt posts to?',
    options: [
      'The vendor master',
      'The material type on its own',
      'Automatic account determination, configured in OBYC',
      'The purchase order header'
    ],
    answer: 2,
    explain:
      'Valuation class, movement type and transaction key come together in OBYC. This is '
      + 'the classic MM-FI boundary, and it is exactly the kind of integration the '
      + 'estimator charges once per module pair rather than twice.'
  },
  {
    id: 'sc-embedded-ewm',
    topic: 's4hana-supply-chain',
    prompt: 'What is embedded EWM?',
    options: [
      'EWM running inside the S/4HANA system itself',
      'EWM on a separate SCM system',
      'The old WM module under a new name',
      'A cloud-only warehouse application'
    ],
    answer: 0,
    explain:
      'Embedded runs in the same stack, which removes the interface. Decentralised EWM '
      + 'runs on its own system and is chosen for very high throughput, or when the '
      + 'warehouse needs a release cycle independent of the ERP.'
  },
  {
    id: 'clean-core-side-by-side',
    topic: 'clean-core',
    prompt: 'Which extension approach fits clean core by design?',
    options: [
      'Modifying SAP standard code',
      'Implicit enhancement points inside standard programs',
      'A side-by-side extension on BTP consuming released APIs',
      'Writing directly to standard tables'
    ],
    answer: 2,
    explain:
      'Side-by-side keeps the extension outside the upgrade path entirely. Key-user '
      + 'extensibility and released in-app extensions are also clean; modifications and '
      + 'implicit enhancements are the two that make every future upgrade a project.'
  },
  {
    id: 'clean-core-released-api',
    topic: 'clean-core',
    prompt: 'What does it mean that an ABAP object is "released" for cloud development?',
    options: [
      'SAP commits to its interface as a stable contract',
      'It is open source',
      'It has been deprecated',
      'It runs only in the public cloud'
    ],
    answer: 0,
    explain:
      'A released object has a documented contract SAP undertakes not to break. An '
      + 'unreleased one may change in any upgrade, which is why an extension built on it '
      + 'is a bill that arrives later rather than a saving now.'
  },
  {
    id: 'clean-core-key-user',
    topic: 'clean-core',
    prompt: 'Which of these is key-user extensibility?',
    options: [
      'The ABAP Workbench (SE80)',
      'The Custom Fields and Logic Fiori app',
      'The modification assistant',
      'The classic enhancement framework'
    ],
    answer: 1,
    explain:
      'Key-user tools run in the Fiori app, are upgrade-safe, and need no transport of '
      + 'source. They cover a genuinely useful slice — fields, logic at released '
      + 'extension points, forms — and knowing where that slice ends is the skill.'
  },
  {
    id: 'arch-cds-view',
    topic: 'architecture',
    prompt: 'What is a CDS view?',
    options: [
      'A Fiori screen layout',
      'A transport request type',
      'A data model defined in ABAP and pushed down to the database',
      'A BW extractor'
    ],
    answer: 2,
    explain:
      'Core data services move the model to where the data is, so HANA does the '
      + 'calculation instead of ABAP looping over the result. That code-to-data shift is '
      + 'most of why a rewrite performs differently from the report it replaced.'
  },
  {
    id: 'arch-fiori-elements',
    topic: 'architecture',
    prompt: 'What determines the layout of a Fiori Elements application?',
    options: [
      'Annotations on the OData service',
      'Hand-written JavaScript views',
      'The chosen theme',
      'The transport it ships in'
    ],
    answer: 0,
    explain:
      'Fiori Elements renders a floorplan from annotations, so the UI follows the service '
      + 'rather than being built beside it. It is less flexible than freestyle UI5, and '
      + 'that is the point: the constraint is what keeps it upgrade-safe.'
  },
  {
    id: 'basis-spau-spdd',
    topic: 'basis-release',
    prompt: 'During an upgrade, what does transaction SPAU handle?',
    options: [
      'Adjusting modified repository objects',
      'Adjusting modified dictionary objects',
      'Scheduling background jobs',
      'Maintaining transport routes'
    ],
    answer: 0,
    explain:
      'SPAU is for modified repository objects and runs after the upgrade; SPDD is for '
      + 'dictionary objects and runs during it, because the data has to survive first. '
      + 'The size of both queues is a direct measure of how much was modified.'
  },
  {
    id: 'sf-employee-central',
    topic: 'successfactors',
    prompt: 'Which SuccessFactors module holds the core employee record the others read?',
    options: ['Recruiting', 'Learning', 'Employee Central', 'Performance & Goals'],
    answer: 2,
    explain:
      'Employee Central is the system of record for the person, the position and the '
      + 'organisational structure. Implementing another module first is possible and '
      + 'usually means integrating to whatever holds that record instead.'
  },
  {
    id: 'spend-ariba-network',
    topic: 'spend-management',
    prompt: 'What does the Ariba Network principally connect?',
    options: [
      'Warehouses and carriers',
      'Buyers and suppliers, for transacting documents',
      'Employees and their expense claims',
      'Developers and APIs'
    ],
    answer: 1,
    explain:
      'Orders, confirmations and invoices flow between trading partners over it. Supplier '
      + 'enablement — getting real suppliers actually transacting — is normally the long '
      + 'pole of an Ariba programme, not the configuration.'
  },
  {
    id: 'btp-subaccount',
    topic: 'btp',
    prompt: 'On SAP BTP, what is a subaccount for?',
    options: [
      'Billing only',
      'Storing source code',
      'Isolating an environment with its own region, entitlements and trust',
      'Holding a single database schema'
    ],
    answer: 2,
    explain:
      'A subaccount is the unit of isolation: region, entitlements, identity provider and '
      + 'destinations. Development, test and production are separate subaccounts for the '
      + 'same reason they are separate ABAP systems.'
  },
  {
    id: 'planning-ibp',
    topic: 'supply-chain-planning',
    prompt: 'What does IBP stand for in SAP IBP?',
    options: [
      'Integrated Business Planning',
      'Intelligent Business Process',
      'Inventory Balance Planning',
      'Integrated Batch Processing'
    ],
    answer: 0,
    explain:
      'Integrated Business Planning: demand, supply, response, inventory and S&OP on one '
      + 'planning model. It is the successor to APO, and the modules are licensed and '
      + 'implemented separately.'
  },
  {
    id: 'cx-commerce-cloud',
    topic: 'customer-experience',
    prompt: 'Which SAP product is the e-commerce storefront platform?',
    options: ['SAP Sales Cloud', 'SAP Service Cloud', 'SAP Emarsys', 'SAP Commerce Cloud'],
    answer: 3,
    explain:
      'SAP Commerce Cloud, formerly Hybris. Sales and Service Cloud are the CRM front '
      + 'office, and Emarsys is marketing — four different products people routinely '
      + 'describe as "SAP CX" in one breath.'
  },
  {
    id: 'analytics-sac',
    topic: 'analytics',
    prompt: 'What does SAP Analytics Cloud combine in one product?',
    options: [
      'Dashboards only',
      'Business intelligence, planning and predictive',
      'ETL only',
      'Data warehousing only'
    ],
    answer: 1,
    explain:
      'BI, planning and predictive in one SaaS tool. The planning half is what makes it '
      + 'more than a reporting front end, and it is the half that usually needs a real '
      + 'implementation rather than a rollout.'
  },
  {
    id: 'cert-year-suffix',
    topic: 'certification',
    prompt: 'SAP re-versions its certification exams. What happens to the code?',
    options: [
      'A new year-suffixed version is published and older ones are eventually retired',
      'The code never changes',
      'The credential is revoked',
      'Only the exam name changes'
    ],
    answer: 0,
    explain:
      'C_TS4FI_2023 becomes C_TS4FI_2025 and so on. It is why this Hub stores the stem '
      + 'and never the suffix: a year-suffixed code on a profile is stale within twelve '
      + 'months and reads as a lapsed credential when nothing has lapsed.'
  },
  {
    /*
     * Retired: a question about THIS SITE in a quiz about SAP. It is kept in the bank, not
     * deleted, so a day it was played on still replays exactly — see `activeOn`.
     */
    id: 'rates-privacy-floor',
    retired: '2026-10-08',
    topic: 'careers',
    prompt: 'On this Hub, when does a day-rate bucket get published?',
    options: [
      'As soon as one person contributes to it',
      'Once at least three different people have contributed to it',
      'After an administrator approves it',
      'Never — only a single overall average is shown'
    ],
    answer: 1,
    explain:
      'Three different PEOPLE, not three submissions: one person submitting five times is '
      + 'still a sample of one. Below the floor the count is still shown and the figures '
      + 'are withheld, so a thin bucket reads as thin rather than as missing.'
  },
  /*
   * Added 2026-10-08. `since` keeps them out of every day before that, so the days already
   * played are drawn from exactly the bank they were played with — see `activeOn`.
   */
  {
    id: 'basis-stms',
    since: '2026-10-08',
    topic: 'technology',
    prompt: 'Which transaction manages transport routes and import queues in the Transport Management System?',
    options: ['STMS', 'SE80', 'SM37', 'SPRO'],
    answer: 0,
    explain:
      'STMS is the Transport Management System: the landscape, the routes between systems '
      + 'and the import queue of each. SE80 is the development workbench, SM37 the job '
      + 'overview and SPRO the configuration guide.'
  },
  {
    id: 'security-su53',
    since: '2026-10-08',
    topic: 'technology',
    prompt: 'What does transaction SU53 show?',
    options: [
      'The last failed authorisation check for the user',
      'Every role assigned to the user',
      'The change history of a role',
      'All locked users in the client'
    ],
    answer: 0,
    explain:
      'SU53 displays the most recent authorisation check that failed for the user, which is '
      + 'usually the first thing a security consultant asks for when somebody reports '
      + '"I am not authorised". A system trace (ST01 / STAUTHTRACE) is the next step when '
      + 'one check is not enough.'
  },
  {
    id: 'grc-access-risk',
    since: '2026-10-08',
    topic: 'technology',
    prompt: 'What is Access Risk Analysis in SAP GRC Access Control mainly used for?',
    options: [
      'Finding segregation-of-duties conflicts in users\' and roles\' authorisations',
      'Monitoring CPU usage on application servers',
      'Scanning custom ABAP code for syntax errors',
      'Encrypting the database at rest'
    ],
    answer: 0,
    explain:
      'It checks authorisations against a rule set of conflicting functions — creating a '
      + 'vendor and paying it, for instance — so a conflict is caught before access is '
      + 'granted rather than found by the auditor afterwards.'
  },
  {
    id: 'calm-successor',
    since: '2026-10-08',
    topic: 'technology',
    prompt: 'Which tool does SAP position as the successor to Solution Manager for application lifecycle management?',
    options: ['SAP Cloud ALM', 'SAP Signavio', 'SAP LeanIX', 'SAP Build Work Zone'],
    answer: 0,
    explain:
      'Cloud ALM covers implementation and operations for cloud-centric landscapes, and '
      + 'mainstream maintenance for Solution Manager 7.2 ends in 2027. Signavio is process '
      + 'transformation and LeanIX enterprise architecture — related, but not ALM.'
  },
  {
    id: 'transition-dmo',
    since: '2026-10-08',
    topic: 'transitions',
    prompt: 'What does the Database Migration Option (DMO) of the Software Update Manager combine?',
    options: [
      'The conversion or upgrade and the move to the SAP HANA database, in one procedure',
      'Two client copies into one',
      'Data archiving and table partitioning',
      'The fit-to-standard and the cutover rehearsal'
    ],
    answer: 0,
    explain:
      'DMO runs the software update and the database migration together, which is why it '
      + 'is the usual route for a brownfield conversion from a non-HANA database: one '
      + 'downtime instead of two.'
  },
  {
    id: 'deployment-private-vs-public',
    since: '2026-10-08',
    topic: 'transitions',
    prompt: 'Compared with S/4HANA Cloud Public Edition, what does Private Edition allow?',
    options: [
      'A single-tenant system with the full S/4HANA scope, broader configuration and on-stack custom ABAP',
      'Nothing — the two are the same product with different names',
      'Running without any SAP-managed infrastructure',
      'Skipping SAP Activate entirely'
    ],
    answer: 0,
    explain:
      'Public Edition is multi-tenant, quarterly-upgraded and limited to released '
      + 'extensibility. Private Edition is a dedicated system run by SAP or a hyperscaler, '
      + 'closer to on-premise in what can be configured and built — which is why the '
      + 'deployment is the first thing an SAP advert should state.'
  },
  {
    id: 'finance-mdg',
    since: '2026-10-08',
    topic: 's4hana-finance',
    prompt: 'What does SAP Master Data Governance add over maintaining master data directly?',
    options: [
      'Change requests with workflow, validation and approval before the data becomes active',
      'Faster database reads on master data tables',
      'Automatic translation of material descriptions',
      'A replacement for the business partner model'
    ],
    answer: 0,
    explain:
      'MDG puts a governed process in front of the record: the change is staged, checked '
      + 'against rules, approved and only then activated. The data model underneath is '
      + 'still the standard one — business partner, material, G/L account.'
  },
  {
    id: 'finance-fica',
    since: '2026-10-08',
    topic: 's4hana-finance',
    prompt: 'What is Contract Accounting (FI-CA) designed for?',
    options: [
      'Very high volumes of open items per business partner, as in utilities, telecoms and insurance',
      'Consolidating group subsidiaries',
      'Fixed-asset depreciation',
      'Travel expense reimbursement'
    ],
    answer: 0,
    explain:
      'FI-CA is a subledger built for mass processing: millions of customers, each with '
      + 'many small items. It sits under IS-U, telecoms billing (BRIM) and insurance '
      + 'collections, where the classic FI-AR design does not scale.'
  },
  {
    id: 'sc-aatp',
    since: '2026-10-08',
    topic: 's4hana-supply-chain',
    prompt: 'Which S/4HANA capability is the successor to the APO-based global ATP check for order promising?',
    options: ['Advanced Available-to-Promise (aATP)', 'Material Requirements Planning', 'Batch Management', 'Credit Management'],
    answer: 0,
    explain:
      'aATP brings product allocation, backorder processing and alternative-plant checks '
      + 'into S/4HANA itself, where APO gATP needed a separate system and a CIF interface.'
  },
  {
    id: 'sc-classic-wm',
    since: '2026-10-08',
    topic: 's4hana-supply-chain',
    prompt: 'What is the position of classic Warehouse Management (LE-WM) in S/4HANA?',
    options: [
      'It is a compatibility-scope item, and EWM is the intended successor',
      'It is the strategic warehouse solution and EWM is deprecated',
      'It was rewritten as a Fiori app with the same name',
      'It is only available in Public Edition'
    ],
    answer: 0,
    explain:
      'Classic WM survives in S/4HANA under the compatibility pack, with limited usage '
      + 'rights, so a conversion that keeps it is postponing a decision. EWM, embedded or '
      + 'decentralised, is where SAP invests.'
  },
  {
    id: 'hcm-infotype-0001',
    since: '2026-10-08',
    topic: 'successfactors',
    prompt: 'In on-premise SAP HCM, which infotype holds an employee\'s organisational assignment?',
    options: ['0001', '0002', '0008', '0014'],
    answer: 0,
    explain:
      'Infotype 0001 is Organizational Assignment — company code, personnel area, '
      + 'position, cost centre. 0002 is personal data, 0008 basic pay and 0014 recurring '
      + 'payments and deductions.'
  },
  {
    id: 'sf-ecp',
    since: '2026-10-08',
    topic: 'successfactors',
    prompt: 'What is Employee Central Payroll?',
    options: [
      'SAP\'s payroll engine run by SAP in the cloud and integrated with Employee Central',
      'A reporting dashboard over a third-party payroll',
      'A timesheet app for contractors',
      'The bank-transfer module of Concur'
    ],
    answer: 0,
    explain:
      'ECP is the proven SAP payroll — the same schemas and rules a PY consultant knows — '
      + 'hosted by SAP and fed by Employee Central. That is why on-premise payroll skills '
      + 'carry straight across to it.'
  },
  {
    id: 'industry-isu-meter-to-cash',
    since: '2026-10-08',
    topic: 'industry-solutions',
    prompt: 'In SAP IS-U, what is the end-to-end process from reading a meter to collecting payment usually called?',
    options: ['Meter-to-cash', 'Order-to-cash', 'Procure-to-pay', 'Record-to-report'],
    answer: 0,
    explain:
      'Meter-to-cash runs from device management and meter reading through billing and '
      + 'invoicing to FI-CA collections. It is why an IS-U advert is unreadable to somebody '
      + 'who has only done SD order-to-cash.'
  },
  {
    id: 'industry-psm-fm',
    since: '2026-10-08',
    topic: 'industry-solutions',
    prompt: 'What does Funds Management (PSM-FM) do in a public sector SAP system?',
    options: [
      'Checks commitments and spending against an approved budget (availability control)',
      'Manages investment portfolios for pension funds',
      'Calculates payroll for civil servants',
      'Publishes procurement tenders'
    ],
    answer: 0,
    explain:
      'FM records the budget by funds centre and commitment item and stops — or warns '
      + 'on — a posting that would exceed it. Public bodies are held to the budget they '
      + 'were granted, which is the requirement commercial controlling does not have.'
  },
  {
    id: 'spend-fieldglass',
    since: '2026-10-08',
    topic: 'spend-management',
    prompt: 'What does SAP Fieldglass manage?',
    options: [
      'External workforce: contingent workers and services procurement',
      'Employee travel bookings',
      'Supplier invoices for direct materials',
      'Payroll for permanent staff'
    ],
    answer: 0,
    explain:
      'Fieldglass is a vendor management system for the people a company buys rather '
      + 'than employs — contractors and statement-of-work services — from requisition to '
      + 'timesheet to invoice.'
  },
  {
    id: 'cx-customer-data-cloud',
    since: '2026-10-08',
    topic: 'customer-experience',
    prompt: 'What does SAP Customer Data Cloud (formerly Gigya) mainly handle?',
    options: [
      'Customer identity, login, consent and profile management',
      'Warehouse slotting',
      'Sales order pricing',
      'Shop-floor machine data'
    ],
    answer: 0,
    explain:
      'It is the customer identity and consent layer — registration, social login, '
      + 'preferences and the consent records privacy law asks for — in front of commerce, '
      + 'marketing and service.'
  }
]);

/** How many questions a daily challenge holds. */
const QUESTIONS_PER_DAY = 5;

/**
 * What a correct answer is worth, and the ceiling on a day.
 *
 * Deliberately modest next to `reply_accepted` (25 points in `config/community.js`). The
 * scheme there already states the principle: a scheme that pays for volume gets volume,
 * and a quiz is the easiest volume on the site. Answering questions should nudge a
 * standing, never build one.
 */
const POINTS_PER_CORRECT = 1;

/** A streak survives a missed day this many times before it resets. It does not. */
const STREAK_GRACE_DAYS = 0;

/**
 * Deterministic daily selection.
 *
 * Seeded by the DATE, so everybody playing on the same day gets the same five questions
 * in the same order — which is what makes a daily leaderboard mean anything — and so a
 * past day can be reconstructed exactly when somebody disputes a score. A random shuffle
 * would make both impossible.
 *
 * The option order is shuffled too, from the same seed, so the correct answer is not
 * always in the position the bank happens to list it in.
 */
function seedFor(dateIso, salt) {
  return crypto.createHash('sha256').update(`${dateIso}|${salt}`).digest();
}

/** A tiny deterministic PRNG over a hash digest. Not cryptographic — it does not need to be. */
function rngFrom(digest) {
  let i = 0;
  return () => {
    const value = digest.readUInt32BE((i * 4) % (digest.length - 4));
    i += 1;
    return value / 0xffffffff;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The five questions for a date, with their options shuffled.
 *
 * Returns the FULL question, answer included. Only `publicFormOf` may reach a template.
 */
/**
 * The bank as it stood on a date.
 *
 * The daily set is drawn from the bank by a seeded shuffle, so ANY change to the bank
 * reshuffles every day — including days already played, whose stored scores
 * `Challenge.replay` re-grades. Editing the bank would then rewrite history: a closed
 * attempt would be replayed against questions its player never saw, and the mismatch
 * logged as though the score were wrong.
 *
 * So the bank only ever grows forward. A question added later carries `since` and does
 * not exist on earlier days; a question taken out carries `retired` and stays in the list
 * for the days before it. A day's set is therefore a function of the date alone, forever.
 */
function activeOn(dateIso) {
  return QUESTIONS.filter((q) => (!q.since || q.since <= dateIso) && (!q.retired || dateIso < q.retired));
}

function dailySetFor(dateIso, { size = QUESTIONS_PER_DAY } = {}) {
  const picked = shuffled(activeOn(dateIso), rngFrom(seedFor(dateIso, 'pick'))).slice(0, size);

  return picked.map((question) => {
    const order = shuffled(
      question.options.map((label, index) => ({ label, index })),
      rngFrom(seedFor(dateIso, `opts:${question.id}`))
    );
    return {
      id: question.id,
      topic: question.topic,
      prompt: question.prompt,
      explain: question.explain,
      options: order.map((o) => o.label),
      // Where the correct option ended up after shuffling.
      answer: order.findIndex((o) => o.index === question.answer)
    };
  });
}

/**
 * The shape a browser is allowed to receive. The `answer` and nothing else is removed,
 * and `explain` goes with it — handing over the explanation before grading would name the
 * right option in prose.
 */
function publicFormOf(question) {
  return {
    id: question.id,
    topic: question.topic,
    prompt: question.prompt,
    options: question.options.slice()
  };
}

/**
 * Grade a submission. Pure, so the rule is testable without a database or a request.
 *
 * `submitted` is whatever arrived in the body — an array of chosen option indices,
 * possibly the wrong length, possibly holding strings, objects or nothing. Every entry is
 * coerced and range-checked; anything that is not a valid index for its question counts as
 * unanswered rather than throwing, because a malformed body is a client bug or a probe,
 * not a reason to 500.
 */
function gradeAnswers(questions, submitted) {
  // Keyed by QUESTION ID first, position second.
  //
  // The form posts `answers[<question id>]`, not `answers[0]`, and that is deliberate:
  // `qs` (the parser behind `extended: true`) COMPACTS a sparse numeric object, so a body
  // carrying answers for questions 1, 3 and 5 arrives as a three-element array and every
  // answer after the first gap is graded against the wrong question. Keying on the id
  // removes the ordering dependency entirely. The positional fallback is kept so the
  // function stays usable from a test with a plain array.
  const given = submitted && typeof submitted === 'object' ? submitted : {};

  const results = questions.map((question, position) => {
    const raw = Object.prototype.hasOwnProperty.call(given, question.id) ? given[question.id] : given[position];
    // An integer, or a string that is ENTIRELY digits. Deliberately not `parseInt`:
    // `parseInt(2.5)` is 2 and `parseInt('3abc')` is 3, so a malformed value would be
    // quietly rounded into a valid choice instead of counting as unanswered.
    const chosen = Number.isInteger(raw) ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;
    const valid = Number.isInteger(chosen) && chosen >= 0 && chosen < question.options.length;

    return {
      id: question.id,
      topic: question.topic,
      prompt: question.prompt,
      options: question.options.slice(),
      chosen: valid ? chosen : null,
      answer: question.answer,
      correct: valid && chosen === question.answer,
      explain: question.explain
    };
  });

  const score = results.filter((r) => r.correct).length;
  return { results, score, total: questions.length, points: score * POINTS_PER_CORRECT };
}

/**
 * Today, as the SERVER sees it, in UTC.
 *
 * The reference takes `gameDate` from the request body. That is not a convenience — it is
 * the leaderboard's primary key handed to the client. UTC rather than a local zone so that
 * "today" is one thing for everyone on one leaderboard; a per-visitor local day would let
 * somebody in Auckland play tomorrow's challenge before somebody in Lisbon has finished
 * today's.
 */
function serverDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Asserted at boot beside the role taxonomy: a malformed bank is a quiz nobody can win. */
function assertChallengeIntegrity() {
  const seen = new Set();
  for (const question of QUESTIONS) {
    if (!question.id || seen.has(question.id)) throw new Error(`duplicate or missing question id: ${question.id}`);
    seen.add(question.id);
    if (!question.prompt || !question.explain) throw new Error(`question ${question.id} is missing prompt or explanation`);
    if (!Array.isArray(question.options) || question.options.length < 2) {
      throw new Error(`question ${question.id} needs at least two options`);
    }
    if (new Set(question.options).size !== question.options.length) {
      throw new Error(`question ${question.id} has duplicate options`);
    }
    if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= question.options.length) {
      throw new Error(`question ${question.id} has an answer outside its options`);
    }
    // One vocabulary. A topic nothing else on the site knows is a dead end for a reader
    // told to go and read about it.
    for (const key of ['since', 'retired']) {
      if (question[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(question[key])) {
        throw new Error(`question ${question.id} has a ${key} that is not a YYYY-MM-DD date`);
      }
    }
    if (!TOPIC_SLUGS.has(question.topic)) {
      throw new Error(`question ${question.id} has topic "${question.topic}", which is not a community category`);
    }
  }
  if (activeOn(serverDate()).length < QUESTIONS_PER_DAY) {
    throw new Error(`the bank holds ${activeOn(serverDate()).length} live questions but a day needs ${QUESTIONS_PER_DAY}`);
  }
  if (!Number.isInteger(POINTS_PER_CORRECT) || POINTS_PER_CORRECT < 0) {
    throw new Error('points per correct answer must be a non-negative integer');
  }
  return true;
}

module.exports = {
  QUESTIONS_PER_DAY,
  POINTS_PER_CORRECT,
  STREAK_GRACE_DAYS,
  bankSize: () => activeOn(serverDate()).length,
  activeOn,
  dailySetFor,
  publicFormOf,
  gradeAnswers,
  serverDate,
  assertChallengeIntegrity
};
