'use strict';

const { certByCode } = require('./certifications');

/**
 * Learning paths and certification practice — /consultants/learning and
 * /consultants/certifications, as on dynamicshub.net (owner, 2026-10-22).
 *
 * LINKS. Every learning path points at a page on learning.sap.com that was found by a
 * search and named in its result, not at a URL assembled from a pattern: SAP renames its
 * journeys, and a link that 404s on the first click teaches somebody to stop clicking. A
 * journey whose address could not be confirmed is not listed rather than guessed. The boot
 * assertion pins every link to https and to SAP's (or SAP Community's) hosts.
 *
 * PRACTICE QUESTIONS are ORIGINAL — written against the topic areas each exam publicly
 * covers, never copied from an exam. Real exam questions are SAP's and under the candidate
 * agreement; a practice bank that reproduced them would be a dump with this site's name on
 * it. The page says so, and a test keeps the sentence. Every question carries an
 * explanation, because the explanation is what somebody studying is here for. Grading is on
 * the server: the page is handed questions without their answers.
 *
 * A certification here is a CODE from config/certifications.js — the stem without the year,
 * for the reason that file gives — so the practice and the profile badge cannot disagree on
 * what the exam is called.
 */

const LEARNING_HOSTS = ['learning.sap.com', 'help.sap.com', 'community.sap.com', 'news.sap.com', 'api.sap.com', 'me.sap.com', 'fioriappslibrary.hana.ondemand.com'];

const LEARNING_PATHS = Object.freeze([
  {
    id: 'financials-overview', icon: 'bi-cash-stack', level: 'Foundation', area: 'Finance',
    title: 'Overview of Financials in SAP S/4HANA',
    description: 'Where Finance sits in S/4HANA — the Universal Journal, ledgers and the accounting components — before any configuration.',
    url: 'https://learning.sap.com/learning-journeys/overview-of-financials-in-sap-s-4hana'
  },
  {
    id: 'fi-private', icon: 'bi-journal-text', level: 'Consultant', area: 'Finance',
    title: 'Implementing Financial Accounting in SAP S/4HANA (Private Edition)',
    description: 'General ledger, accounts payable and receivable, asset accounting and closing — the journey behind the Financial Accounting certification.',
    url: 'https://learning.sap.com/learning-journeys/implementing-financial-accounting-in-sap-s-4hana'
  },
  {
    id: 'fi-public', icon: 'bi-cloud', level: 'Consultant', area: 'Finance',
    title: 'Implementing Financial Accounting in SAP S/4HANA Cloud (Public Edition)',
    description: 'The same ground for the public cloud edition: master data, the general ledger and period-end close.',
    url: 'https://learning.sap.com/learning-journeys/implementing-financial-accounting-in-sap-s4hana-cloud'
  },
  {
    id: 'mm-private', icon: 'bi-cart3', level: 'Consultant', area: 'Logistics',
    title: 'Implementing SAP S/4HANA Cloud Private Edition, Sourcing and Procurement',
    description: 'Purchasing, inventory and invoice verification as an S/4HANA consultant configures them.',
    url: 'https://learning.sap.com/learning-journeys/implementing-sap-s-4hana-cloud-private-edition-sourcing-and-procurement'
  },
  {
    id: 'mm-public', icon: 'bi-bag-check', level: 'Consultant', area: 'Logistics',
    title: 'Implementing SAP S/4HANA Cloud Public Edition, Sourcing and Procurement',
    description: 'Sourcing and procurement processes in the public cloud edition, for consultants.',
    url: 'https://learning.sap.com/learning-journeys/implement-sap-s-4hana-cloud-public-edition-for-sourcing-and-procurement'
  },
  {
    id: 'activate', icon: 'bi-signpost-split', level: 'All roles', area: 'Methodology',
    title: 'Discovering SAP Activate — Implementation Tools and Methodology',
    description: 'The six phases, fit-to-standard and the tools around them: the shared language of every SAP project.',
    url: 'https://learning.sap.com/learning-journeys/discovering-sap-activate-implementation-tools-and-methodology'
  },
  {
    id: 'btp', icon: 'bi-boxes', level: 'Foundation', area: 'Technology',
    title: 'Exploring SAP Business Technology Platform',
    description: 'BTP\'s strategy, architecture and services — the platform extensions, integration and AI are built on.',
    url: 'https://learning.sap.com/learning-journeys/exploring-sap-business-technology-platform'
  },
  {
    id: 'btp-procurement', icon: 'bi-diagram-3', level: 'Consultant', area: 'Technology',
    title: 'Mastering SAP BTP for Next-Generation Procurement Consultants',
    description: 'Navigating BTP and configuring the services procurement solutions rely on.',
    url: 'https://learning.sap.com/learning-journeys/mastering-sap-btp-for-next-generation-procurement-consultants'
  },
  {
    id: 'business-ai', icon: 'bi-robot', level: 'All roles', area: 'AI',
    title: 'SAP Business AI learning journey',
    description: 'SAP\'s announcement of its journey on identifying and designing Business AI use cases with customers — with the link to start it.',
    url: 'https://news.sap.com/2024/12/new-sap-business-ai-learning-journey-available/'
  }
]);

const RESOURCES = Object.freeze([
  { title: 'SAP Learning', url: 'https://learning.sap.com/', type: 'learning', icon: 'bi-mortarboard' },
  { title: 'SAP Help Portal', url: 'https://help.sap.com/', type: 'docs', icon: 'bi-book' },
  { title: 'SAP Community', url: 'https://community.sap.com/', type: 'community', icon: 'bi-people' },
  { title: 'SAP Fiori apps reference library', url: 'https://fioriappslibrary.hana.ondemand.com/', type: 'docs', icon: 'bi-grid-1x2' },
  { title: 'SAP Business Accelerator Hub (APIs)', url: 'https://api.sap.com/', type: 'docs', icon: 'bi-plug' },
  { title: 'SAP for Me', url: 'https://me.sap.com/', type: 'support', icon: 'bi-person-badge' }
]);

/* ------------------------------------------------------------------ certification practice */

const PRACTICE_SET_SIZE = 8;

const q = (id, prompt, options, explain) => ({ id, prompt, options, answer: 0, explain });

const PRACTICE = Object.freeze([
  {
    code: 'C_TS4FI', area: 'Finance', studyUrl: 'https://learning.sap.com/learning-journeys/implementing-financial-accounting-in-sap-s-4hana',
    topics: ['General ledger', 'Business partner', 'Accounts payable and receivable', 'Asset accounting', 'Closing'],
    questions: [
      q('fi1', 'Which table is the Universal Journal in SAP S/4HANA?', ['ACDOCA', 'BSEG only', 'GLT0', 'COEP'], 'ACDOCA holds one line per posting with the finance and controlling dimensions together; the old totals tables are no longer where the truth lives.'),
      q('fi2', 'How are customers and suppliers created in SAP S/4HANA?', ['As business partners, with transaction BP', 'With XD01 and XK01 only', 'Automatically from sales orders', 'In the general ledger'], 'The business partner is the single entry point; customer and supplier roles are added to it.'),
      q('fi3', 'In S/4HANA, where is a cost element maintained?', ['As a G/L account of type primary or secondary cost element', 'Only in KA01, separately from the G/L', 'In the controlling area settings', 'It no longer exists in any form'], 'Cost elements became G/L accounts with a cost element category, because finance and controlling now share one journal.'),
      q('fi4', 'What is ledger 0L by default?', ['The leading ledger', 'A statistical ledger', 'The asset ledger', 'A planning ledger'], 'The leading ledger carries the accounting principle used for consolidated reporting; non-leading ledgers carry parallel ones.'),
      q('fi5', 'What is document splitting for?', ['Producing balanced financial statements per characteristic such as segment or profit centre', 'Splitting a long document into pages', 'Dividing a payment between banks', 'Archiving old documents'], 'Splitting assigns every line, including balance-sheet lines, to the characteristic, so each segment balances on its own.'),
      q('fi6', 'Which asset accounting is used in SAP S/4HANA?', ['New Asset Accounting', 'Classic Asset Accounting', 'Either, chosen per company code', 'None — assets are in Controlling'], 'Classic Asset Accounting is not available in S/4HANA; new Asset Accounting posts each valuation in real time.'),
      q('fi7', 'Why is open item management switched on for a GR/IR clearing account?', ['So that postings to it can be cleared against each other', 'So that it cannot be posted to', 'To hide it from reports', 'To make it a reconciliation account'], 'Open item management lets an entry stay open until cleared — for GR/IR, a goods receipt against its invoice.'),
      q('fi8', 'Which transaction runs the automatic payment program?', ['F110', 'F150', 'FB50', 'FBL1N'], 'F110 proposes and executes payments; F150 is the dunning run, FB50 a G/L entry, FBL1N the supplier line items.'),
      q('fi9', 'Which transaction runs dunning?', ['F150', 'F110', 'FS00', 'OB52'], 'F150 is the dunning program. OB52 opens and closes posting periods; FS00 maintains G/L accounts.'),
      q('fi10', 'What is a reconciliation account?', ['A G/L account that a subledger posts to automatically and that cannot be posted to directly', 'A bank account', 'An account for manual adjustments', 'A statistical account'], 'It ties the subledger (customers, suppliers, assets) to the general ledger, which is why direct postings are blocked.'),
      q('fi11', 'What does a field status group control?', ['Which fields are required, optional or suppressed when posting to the account', 'Who may post to the account', 'The account\'s currency', 'The account\'s number range'], 'The field status group on the G/L account decides the entry screen\'s fields for that account.'),
      q('fi12', 'What does a fiscal year variant define?', ['The number of posting periods and special periods, and how they map to the calendar', 'The company\'s legal form', 'The chart of accounts', 'The tax procedure'], 'Up to 16 periods: normal periods plus special periods for closing adjustments.')
    ]
  },
  {
    code: 'C_TS4CO', area: 'Finance', studyUrl: 'https://learning.sap.com/learning-journeys/overview-of-financials-in-sap-s-4hana',
    topics: ['Organisational structure', 'Overhead accounting', 'Product costing', 'Profitability analysis'],
    questions: [
      q('co1', 'What must company codes share to be assigned to one controlling area?', ['The same operational chart of accounts and fiscal year variant', 'The same currency only', 'The same country', 'The same sales organisation'], 'Controlling across company codes needs one chart of accounts and one period structure.'),
      q('co2', 'Which secondary cost element category is used for internal activity allocation?', ['43', '42', '21', '1'], 'Category 43 is internal activity allocation; 42 is assessment; 21 internal settlement; 1 primary costs.'),
      q('co3', 'How does distribution differ from assessment?', ['Distribution keeps the original primary cost element; assessment uses a secondary one', 'They are the same', 'Assessment keeps the primary cost element', 'Distribution is only for revenue'], 'Distribution shows the receiver the original cost element; assessment summarises under an assessment cost element.'),
      q('co4', 'What is a statistical internal order?', ['An order that collects costs for reporting while the real posting goes to another object', 'An order that cannot be posted to', 'An order for planning only', 'An order for revenue'], 'The actual cost sits on the real object, usually a cost centre; the statistical order is an additional view.'),
      q('co5', 'Which transaction plans activity prices for cost centres?', ['KP26', 'KO88', 'CK11N', 'KSU5'], 'KP26 plans the price of an activity type per cost centre. KO88 settles an order, CK11N creates a cost estimate.'),
      q('co6', 'Where does profit centre accounting live in SAP S/4HANA?', ['In the Universal Journal, as a dimension of every line', 'In a separate ledger 8A', 'In a BW system only', 'In Asset Accounting'], 'Profit centres are a field of ACDOCA, so profit centre reporting reads the same journal as the general ledger.'),
      q('co7', 'Which profitability analysis is SAP\'s default in S/4HANA?', ['Margin analysis (account-based)', 'Costing-based only', 'None', 'Profit centre accounting'], 'Account-based margin analysis writes into the Universal Journal and reconciles with finance by design.'),
      q('co8', 'Which transaction settles an individual internal order?', ['KO88', 'KP26', 'F110', 'CK11N'], 'KO88 settles one order to its receivers according to the settlement rule.'),
      q('co9', 'Which hierarchy must every cost centre belong to?', ['The standard hierarchy', 'A profit centre group', 'An alternative hierarchy', 'None'], 'The standard hierarchy is mandatory and complete; alternative groups are optional views.'),
      q('co10', 'Which transaction creates a cost estimate with quantity structure for a material?', ['CK11N', 'KO88', 'MIGO', 'KP06'], 'CK11N costs the material from its BOM and routing; the result can be released as the standard price.'),
      q('co11', 'Which transaction calculates variances on an individual production order?', ['KKS2', 'KKS1', 'F110', 'KP26'], 'KKS2 is variance calculation for a single order; KKS1 runs it collectively.'),
      q('co12', 'What does a plan/actual comparison report for cost centres show?', ['Planned against actual costs per cost element, with the variance', 'Bank balances', 'Open sales orders', 'Stock levels'], 'It is the cost centre manager\'s standard question: what was planned, what happened, and the difference.')
    ]
  },
  {
    code: 'C_TS452', area: 'Logistics', studyUrl: 'https://learning.sap.com/learning-journeys/implementing-sap-s-4hana-cloud-private-edition-sourcing-and-procurement',
    topics: ['Procurement process', 'Master data', 'Inventory management', 'Invoice verification', 'MRP'],
    questions: [
      q('mm1', 'Which transaction creates a purchase order?', ['ME21N', 'VA01', 'MIGO', 'MIRO'], 'ME21N creates a purchase order. VA01 is a sales order, MIGO a goods movement, MIRO an invoice.'),
      q('mm2', 'Which movement type is a goods receipt for a purchase order?', ['101', '201', '261', '601'], '101 receives against a PO; 201 is issue to a cost centre, 261 to an order, 601 a goods issue for delivery.'),
      q('mm3', 'What does the three-way match compare?', ['Purchase order, goods receipt and invoice', 'Three suppliers\' quotations', 'Three plants\' stock', 'Three currencies'], 'Logistics invoice verification checks quantity and price against what was ordered and what arrived.'),
      q('mm4', 'What does a purchasing info record hold?', ['Supplier-specific data for a material, such as price and delivery time', 'The material\'s BOM', 'The supplier\'s bank details', 'The plant calendar'], 'The info record is the link between one supplier and one material, and it feeds proposals into the PO.'),
      q('mm5', 'What is a source list for?', ['Defining which sources of supply are allowed for a material in a plant and period', 'Listing all suppliers in the country', 'Listing open purchase orders', 'Listing storage locations'], 'A source list can fix or block sources, so requisitions are assigned to the right supplier.'),
      q('mm6', 'What does the valuation class on a material decide?', ['Which G/L accounts inventory postings go to, with automatic account determination', 'The purchasing group', 'The storage bin', 'The tax code'], 'Valuation class plus transaction key (OBYC) decides the stock and offsetting accounts.'),
      q('mm7', 'What does a material type control?', ['Which views can be maintained, the number range and whether quantity and value are updated', 'The sales price', 'The supplier', 'The shipping point'], 'Material type is the template: ROH, HALB, FERT and so on each come with these settings.'),
      q('mm8', 'What is the difference between price control S and V?', ['S values stock at a standard price; V at a moving average price', 'They are the same', 'S is for services, V for vendors', 'V is only for finished goods'], 'With S, differences post to a price difference account; with V, they adjust the moving average.'),
      q('mm9', 'What is a release strategy for purchase orders?', ['An approval procedure that blocks a PO until it is released by the right people', 'A delivery schedule', 'A payment term', 'A transport request'], 'Characteristics such as value or purchasing group decide which approvals the document needs.'),
      q('mm10', 'In consignment, who owns the stock until it is withdrawn?', ['The supplier', 'The buyer, from receipt', 'The carrier', 'The bank'], 'Consignment stock sits in the buyer\'s warehouse but stays the supplier\'s until it is consumed or transferred to own stock.'),
      q('mm11', 'Which transaction runs MRP Live in SAP S/4HANA?', ['MD01N', 'MD04', 'ME57', 'MB52'], 'MD01N runs MRP on HANA. MD04 shows the stock/requirements list for one material.'),
      q('mm12', 'Where are material documents stored in SAP S/4HANA?', ['In table MATDOC', 'Only in MKPF and MSEG', 'In ACDOCA only', 'In EKKO'], 'MATDOC replaced the header/item pair as the single store; MKPF and MSEG remain as compatibility views.')
    ]
  },
  {
    code: 'C_TS462', area: 'Logistics', studyUrl: 'https://learning.sap.com/',
    topics: ['Order to cash', 'Enterprise structure', 'Pricing', 'Delivery and billing', 'Credit management'],
    questions: [
      q('sd1', 'What is the order of the basic order-to-cash documents?', ['Sales order, delivery, goods issue, billing document', 'Billing, delivery, sales order', 'Delivery, sales order, billing', 'Quotation, billing, delivery'], 'VA01 creates the order, VL01N the delivery, posting goods issue reduces stock, and VF01 bills.'),
      q('sd2', 'What makes up a sales area?', ['Sales organisation, distribution channel and division', 'Plant and storage location', 'Company code and plant', 'Shipping point and route'], 'The sales area is the unit customer master data and pricing are maintained for.'),
      q('sd3', 'What determines the pricing procedure?', ['Sales area, document pricing procedure and customer pricing procedure', 'Material type only', 'The plant', 'The route'], 'The three together point to the procedure that lists the condition types in their sequence.'),
      q('sd4', 'In the condition technique, what does an access sequence do?', ['Searches condition tables in order to find a valid condition record', 'Sorts the sales orders', 'Assigns users to roles', 'Defines the delivery sequence'], 'A condition type uses its access sequence to look for the most specific record first.'),
      q('sd5', 'What determines the item category in a sales document?', ['Sales document type, item category group, usage and higher-level item category', 'The customer only', 'The plant', 'The billing type'], 'Item category determination is configured on those four inputs.'),
      q('sd6', 'Which movement type is the goods issue for a standard delivery?', ['601', '101', '261', '311'], '601 posts goods issue for a delivery; 101 is a goods receipt, 311 a transfer between storage locations.'),
      q('sd7', 'Which transaction configures copy control from delivery to billing?', ['VTFL', 'VTAA', 'VTLA', 'VOV8'], 'VTFL is delivery to billing; VTAA order to order; VTLA order to delivery; VOV8 defines sales document types.'),
      q('sd8', 'Which credit management is used in SAP S/4HANA?', ['SAP Credit Management (FIN-FSCM)', 'SD credit management only', 'None', 'Bank credit lines'], 'SD credit management was replaced by SAP Credit Management, with business partner credit segments.'),
      q('sd9', 'What does the incompletion log do?', ['Lists required data missing from a document and can block follow-on steps', 'Logs failed logins', 'Deletes incomplete orders', 'Prints the order'], 'An incomplete order can be saved, but the log can stop delivery or billing until it is completed.'),
      q('sd10', 'What does the availability check use to decide what to check?', ['The checking group on the material and the checking rule of the transaction', 'The customer\'s credit limit', 'The pricing procedure', 'The billing date'], 'Together they decide which stock and receipts or issues count towards ATP.'),
      q('sd11', 'How is output such as an order confirmation determined in SAP S/4HANA by default?', ['With S/4HANA output management, based on BRF+ rules', 'Only with NACE condition records', 'Manually for each order', 'By the printer'], 'New output management uses BRF+ determination; the NACE condition technique remains available for compatibility.'),
      q('sd12', 'What replaced SD rebate agreements in SAP S/4HANA?', ['Settlement management with condition contracts', 'Nothing — rebates were removed', 'Credit memos only', 'Free goods'], 'Condition contract settlement handles rebates in S/4HANA; classic SD rebate processing is no longer the way.')
    ]
  },
  {
    code: 'C_ACT', area: 'Methodology', studyUrl: 'https://learning.sap.com/learning-journeys/discovering-sap-activate-implementation-tools-and-methodology',
    topics: ['Phases', 'Fit-to-standard', 'Agile delivery', 'Quality gates', 'Cutover and hypercare'],
    questions: [
      q('ac1', 'What are the six phases of SAP Activate, in order?', ['Discover, Prepare, Explore, Realize, Deploy, Run', 'Plan, Build, Test, Run, Close, Support', 'Prepare, Blueprint, Realize, Final preparation, Go-live, Support', 'Explore, Prepare, Realize, Run, Deploy, Discover'], 'The third option is ASAP\'s older sequence; Activate renamed and reshaped it.'),
      q('ac2', 'In which phase are fit-to-standard workshops held?', ['Explore', 'Prepare', 'Realize', 'Deploy'], 'Explore walks through SAP\'s standard processes with the business and records the gaps.'),
      q('ac3', 'What happens at the end of each phase?', ['A quality gate checks the deliverables before moving on', 'The contract is renegotiated', 'The system is reinstalled', 'Nothing formal'], 'Quality gates make phase exits explicit and auditable.'),
      q('ac4', 'How is Realize delivered in SAP Activate?', ['In iterative sprints that build and test the backlog', 'In one waterfall build', 'Only by SAP', 'Without testing'], 'Agile sprints work through the prioritised backlog with regular reviews by the business.'),
      q('ac5', 'Where are SAP Activate\'s roadmaps, tasks and accelerators published?', ['In the SAP Activate Roadmap Viewer', 'In transaction SPRO', 'Only in printed manuals', 'In the customer\'s intranet'], 'The Roadmap Viewer lists phases, deliverables and tasks with their accelerators.'),
      q('ac6', 'What does fit-to-standard produce besides confirmed processes?', ['A backlog of delta requirements and gaps', 'A finished system', 'A cutover plan', 'The go-live date'], 'Every gap becomes a backlog item, prioritised for Realize.'),
      q('ac7', 'In which phase is cutover to production carried out?', ['Deploy', 'Explore', 'Prepare', 'Discover'], 'Deploy covers final preparation, cutover, go-live and hypercare.'),
      q('ac8', 'What are SAP Best Practices in an Activate project?', ['Preconfigured, documented business processes to start from', 'A code style guide', 'A pricing list', 'A support contract'], 'They are ready-to-run content, which is what makes fit-to-standard possible.'),
      q('ac9', 'When does hypercare happen?', ['After go-live, at the end of Deploy', 'Before Explore', 'During Prepare', 'Only if something fails'], 'Hypercare is the period of elevated support right after go-live, before handover to normal operations in Run.'),
      q('ac10', 'What does "clean core" mean?', ['Keeping custom extensions outside the core, built on released APIs', 'Deleting all custom code', 'Running only on-premise', 'Never upgrading'], 'A clean core keeps upgrades predictable: extensions use stable interfaces instead of modifying SAP\'s code.'),
      q('ac11', 'In Scrum, who prioritises the backlog?', ['The product owner', 'The Scrum master', 'The developers', 'SAP'], 'The product owner owns the backlog and its order; the Scrum master protects the process.'),
      q('ac12', 'Which phase sets up the project team, plan and governance?', ['Prepare', 'Run', 'Deploy', 'Realize'], 'Prepare starts the project formally: team, plan, standards and the system landscape.')
    ]
  },
  {
    code: 'C_ABAPD', area: 'Development', studyUrl: 'https://learning.sap.com/',
    topics: ['ABAP Cloud', 'Core Data Services', 'RAP', 'EML', 'Released APIs'],
    questions: [
      q('ab1', 'What does the ABAP Cloud language version restrict?', ['Code to released APIs and cloud-ready language constructs', 'Code to 1,000 lines', 'Code to SAP GUI screens', 'Nothing'], 'ABAP Cloud permits only released objects and a cloud-safe subset of the language, which is what keeps extensions upgrade-stable.'),
      q('ab2', 'Which statement defines a CDS view entity?', ['DEFINE VIEW ENTITY', 'CREATE VIEW', 'SELECT INTO VIEW', 'DEFINE TABLE'], 'View entities are the current CDS view type; DDIC-based CDS views are being replaced by them.'),
      q('ab3', 'What is EML used for?', ['Reading and changing RAP business objects from ABAP, e.g. MODIFY ENTITIES', 'Sending emails', 'Defining database tables', 'Writing Fiori UIs'], 'Entity Manipulation Language is how ABAP code calls a RAP business object\'s operations.'),
      q('ab4', 'Which tool do you develop ABAP Cloud in?', ['ABAP Development Tools in Eclipse', 'SE80 in SAP GUI', 'Notepad', 'The Fiori launchpad'], 'ABAP Cloud development happens in ADT; the SAP GUI editors are not available for it.'),
      q('ab5', 'In a managed RAP business object, who handles the standard create, update and delete?', ['The RAP framework', 'Your own save code', 'The database trigger', 'The Fiori app'], 'Managed means the framework implements the standard operations and persistence; unmanaged means you write them.'),
      q('ab6', 'What is the difference between a validation and a determination in RAP?', ['A validation checks data and can reject it; a determination calculates values', 'They are the same', 'A determination rejects data', 'A validation changes data'], 'Determinations derive values on trigger events; validations report messages and fail the save.'),
      q('ab7', 'What does a service binding do?', ['Publishes a service definition through a protocol such as OData V2 or V4', 'Binds a user to a role', 'Connects to a printer', 'Defines a table'], 'The service definition says what is exposed; the binding says how it is exposed.'),
      q('ab8', 'What is draft handling in RAP for?', ['Saving incomplete data while the user is still editing', 'Printing drafts', 'Deleting old data', 'Translating texts'], 'Draft keeps a working copy, so a user can leave and come back without losing input or locking the active data for long.'),
      q('ab9', 'What does release contract C1 on an object mean?', ['It is released for use in cloud development', 'It is obsolete', 'It is a customer object', 'It is a test object'], 'C1 marks an API as stable for use from ABAP Cloud code.'),
      q('ab10', 'What does DATA(lv_x) = 5. do?', ['Declares lv_x inline and assigns 5', 'Raises a syntax error', 'Declares a constant', 'Creates a table'], 'Inline declaration infers the type from the right-hand side.'),
      q('ab11', 'What does a behaviour definition describe?', ['The operations, validations, determinations and actions of a RAP business object', 'The database layout', 'The UI colours', 'The transport route'], 'The behaviour definition is the contract of the business object\'s transactional behaviour.'),
      q('ab12', 'Where should a new extension to S/4HANA be built, under the clean-core model?', ['On released APIs — on stack in ABAP Cloud or side by side on SAP BTP', 'By modifying SAP standard code', 'In user exits only', 'In the database directly'], 'Both on-stack ABAP Cloud and side-by-side BTP extensions keep the core clean and upgradable.')
    ]
  }
]);

/** The practice certifications, with their catalogue label and tier. */
function practiceCerts() {
  return PRACTICE.map((p) => {
    const cert = certByCode(p.code);
    return { code: p.code, label: cert.label, tier: cert.tier, area: p.area, studyUrl: p.studyUrl, topics: p.topics.slice(), questionCount: p.questions.length };
  });
}

function practiceFor(code) {
  return PRACTICE.find((p) => p.code === code) || null;
}

/** A session: random questions, options shuffled, answers and explanations removed. */
function practiceSetFor(code, random = Math.random) {
  const practice = practiceFor(code);
  if (!practice) return null;
  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return shuffle(practice.questions).slice(0, PRACTICE_SET_SIZE).map((item) => ({
    id: item.id,
    prompt: item.prompt,
    // The option TEXT is posted back, so a reshuffle cannot change what was chosen.
    options: shuffle(item.options)
  }));
}

/**
 * Grade what was posted: `answers[<id>] = <option text>`. Only ids from this certification's
 * bank are graded, at most one session's worth, so a post cannot probe another exam's bank or
 * inflate a total. Unanswered questions that were served are posted as empty and count wrong.
 */
function gradePractice(code, submitted) {
  const practice = practiceFor(code);
  if (!practice) return null;
  const given = submitted && typeof submitted === 'object' ? submitted : {};
  const results = practice.questions
    .filter((item) => Object.prototype.hasOwnProperty.call(given, item.id))
    .slice(0, PRACTICE_SET_SIZE)
    .map((item) => {
      const chosen = typeof given[item.id] === 'string' ? given[item.id] : '';
      const right = item.options[item.answer];
      return { id: item.id, prompt: item.prompt, chosen: chosen || null, answer: right, correct: chosen === right, explain: item.explain };
    });
  if (!results.length) return null;
  return { results, score: results.filter((r) => r.correct).length, total: results.length };
}

function isAllowedLearningUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && LEARNING_HOSTS.includes(url.hostname);
  } catch (err) {
    return false;
  }
}

function assertLearningIntegrity() {
  const ids = new Set();
  LEARNING_PATHS.forEach((p) => {
    ['id', 'icon', 'level', 'area', 'title', 'description', 'url'].forEach((f) => {
      if (typeof p[f] !== 'string' || !p[f]) throw new Error(`Learning path "${p.title}" has no ${f}`);
    });
    if (ids.has(p.id)) throw new Error(`Learning path ${p.id} is declared twice`);
    ids.add(p.id);
    if (!isAllowedLearningUrl(p.url)) throw new Error(`Learning path "${p.title}" must link to an SAP host over https`);
  });
  RESOURCES.forEach((r) => {
    if (!isAllowedLearningUrl(r.url)) throw new Error(`Resource "${r.title}" must link to an SAP host over https`);
  });
  const questionIds = new Set();
  PRACTICE.forEach((p) => {
    if (!certByCode(p.code)) throw new Error(`Practice for ${p.code}: not in config/certifications.js`);
    if (!isAllowedLearningUrl(p.studyUrl)) throw new Error(`Practice for ${p.code}: study link must be an SAP host over https`);
    if (p.questions.length < PRACTICE_SET_SIZE + 4) throw new Error(`Practice for ${p.code}: too few questions for varied sessions`);
    p.questions.forEach((item) => {
      if (questionIds.has(item.id)) throw new Error(`Practice question ${item.id} is declared twice`);
      questionIds.add(item.id);
      if (!item.prompt || !item.explain) throw new Error(`Practice question ${item.id} needs a prompt and an explanation`);
      if (new Set(item.options).size !== item.options.length || item.options.length < 3) throw new Error(`Practice question ${item.id} needs distinct options`);
    });
  });
  return true;
}

module.exports = {
  LEARNING_PATHS, RESOURCES, PRACTICE_SET_SIZE,
  practiceCerts, practiceFor, practiceSetFor, gradePractice, isAllowedLearningUrl, assertLearningIntegrity
};
