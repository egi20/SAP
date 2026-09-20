# Port plan

Tracking the build of SAP Hub against its reference implementations. This file is the
honest ledger of what is done, what is next, and what is deliberately excluded.

## The two references, and which one is being read

- **DynamicsHub** — the original. A Microsoft Dynamics 365 marketplace, 551 route handlers.
- **Salesforce Hub** — a port of DynamicsHub onto the Salesforce ecosystem, 199 handlers.
  Same product, rebuilt rather than forked, with each of its departures from DynamicsHub
  written down and argued.

**Salesforce Hub is the reference being read here**, and that is the decision this file
opens with. DynamicsHub is the ancestor, but Salesforce Hub already did the work of
separating the marketplace from the Dynamics ecosystem and of refusing the parts of the
original that should not have been carried forward — the browser-scored games, the
placeholder tax-savings maths, the LinkedIn badge that verified nothing, the three
overlapping referral schemes. Reading the ancestor again would mean re-deriving those
refusals, or worse, missing them.

Counts are handlers, which is a rough proxy for size, not for value.

**This is not a fork, and not a copy.** No file is taken wholesale except where it is
named below as ported unchanged, with a reason. The method is DynamicsHub → Salesforce
Hub's method: read the reference, decide per area whether to take it, improve it or refuse
it, and record which.

## What is SAP-specific, and therefore not portable at all

Four things have to be built rather than adapted. They are the reason this is a port and
not a rename:

1. **The product catalogue.** `config/sapProducts.js` — 8 product lines, 57 modules. SAP
   projects are an order of magnitude larger than CRM projects: a Salesforce Sales Cloud
   foundation baselines at 12 consultant-days, an S/4HANA finance core at 60. Carrying the
   reference's numbers across would produce an estimator that quotes an ERP programme at a
   CRM price.
2. **`crossModule` dependencies.** Neither reference has them, because neither ecosystem
   needs them. SD without MM is not a smaller project, it is an integration problem, and
   the estimator has to charge for the boundary rather than pretend it is free.
3. **The role taxonomy.** `config/roleTaxonomy.js` — 53 roles, and the aliases carry the
   two-letter module codes (FI, CO, MM, SD, PP, EWM) plus the legacy names (WM, APO,
   Hybris). A catalogue for this ecosystem that cannot match the string "FI/CO" cannot read
   its own job board.
4. **The palette.** `#0070F2` is SAP's blue and it measures 4.57:1 on white — AA by seven
   hundredths. It is the accent; `#0064D9` at 5.49:1 is the interactive colour. Same kind
   of decision Salesforce Hub made about `#00A1E0`, reached by measuring rather than by
   inheriting its conclusion. See `DESIGN.md`.

One addition with no counterpart in either reference: a **Training & Enablement Lead**
role. SAP delivery has it — a cutover without end-user enablement is the standard way a
sound go-live fails — and it is a line item on real statements of work.

## Plan

| Area | Reference | Here | State |
|---|---|---|---|
| Role taxonomy, product catalogue, certifications | — | — | **done** |
| Design system & palette | — | — | **done** |
| Schema, migrations, migration runner | — | — | **done** (5 migrations, applied from empty) |
| Auth & identity: multi-role, verification, reset | 11 | 11 | **done** |
| Consultant & company profiles | 23 + 3 | 17 | **done** |
| Delivery history: modules, phase, full lifecycles | — | 2 | **done** — no counterpart in either reference |
| Job board: post, publish/pause/close, bulk interlock | 10 | 10 | **done** |
| Applications: state machine, audit trail | 3 | 3 | **done** |
| Match scoring, with the module term and the aliases | — | — | **done** |
| Day-rate index, n≥3 privacy floor | 4 | 3 | **done** — the calculator is later |
| Directories, dashboards, notifications | 10 | 10 | **done** |
| Scope estimator & quotes | 10 | 6 | **done** |
| Documents: SOW, WBS, deck | 17 | 1 | **done** — one handler, four kinds |
| Messaging | 5 | 5 | after the core |
| Community, feed, points | 9 | ~9 | after the core |
| Payments: featured placements, deposits, invoices | 7 | ~7 | after the core |
| In-site assistant | 1 | 1 | after the core |
| Admin: users, jobs, moderation, analytics, settings | 33 | ~18 | after the core |
| Referrals & commissions | 4 | 4 | after the core |
| LinkedIn confirmation | 3 | 3 | after the core |
| AI drafting, every draft verified | — | — | after the core |
| Search across everything | 1 | 1 | after the core |
| Recruiters, stories, reviews | 16 | ~16 | after the core |
| Sales CRM | 16 | ~16 | after the core |
| Finance: invoices, costs, P&L | 20 | ~15 | after the core |
| Tax advisory — the introduction only | 3 | 3 | after the core |
| Daily challenge, graded on the server | 3 | 3 | after the core |

## Excluded, at the owner's instruction — the same list as Salesforce Hub

- **Dedupe.** 65 handlers across 12 tables in DynamicsHub. A separate record-deduplication
  product that happens to be embedded in the ancestor, not part of a marketplace.
- **The tax savings calculator.** DynamicsHub computes a monthly saving from a hard-coded
  percentage that an admin can edit, and shows it to people who act on it. Salesforce Hub
  refused it and pinned the refusal with a test that scans the feature for anything
  saving-shaped. Same here: the tax pages introduce a specialist and compute nothing.
- **Anything that sends to a sales lead on its own.** The CRM drafts; a person sends. No
  scheduler, no bulk send, no outreach queue one cron away from becoming one.
- **Browser-scored games.** DynamicsHub's `routes/games.js` reads `score` out of
  `req.body` and ships the correct answers to the client. One challenge, graded on the
  server, or none.
- **Uploaded document templates.** A company configures colours, letterhead and its own
  clauses. Every file served is one we built and parsed.

## Standing constraints

Everything built here satisfies the rules in `CLAUDE.md`. The ones most often at risk:

- Schema changes are numbered migrations. Models never create or alter tables.
- All SQL is parameterised; one filter builder per browsable thing.
- Money paths are transactional and idempotent; a payout is never clawed back automatically.
- Consent is stamped only by the public registration route.
- Anything user-facing follows `DESIGN.md`, including the 4.5:1 contrast floor.
- The catalogues in `config/` are asserted at boot. A silently-degrading default — a role
  with no base rate, a module depending on one that does not exist — fails loudly at the
  one moment somebody is watching.

## The estimator, and what it does differently

Three inputs have no counterpart in either reference, and one output is a bug fix.

**`TRANSITION_APPROACHES` — greenfield, brownfield or selective.** The first question on
any real S/4HANA programme, and the biggest single lever on the number. A CRM estimator has
no equivalent because a CRM implementation has no existing ECC landscape to convert.
Brownfield reads as the cheap option and is not: the work moves from designing processes to
reconciling twenty years of configuration, custom code and data. The form states that next
to the radio button rather than hiding it in a tooltip.

**`CLEAN_CORE_LEVELS` replaces "customisation level".** The reference asks how much custom
code there is. This asks WHERE it lives, because that is what decides whether the next
upgrade is a weekend or a project — and it is the thing an estimate is most often quietly
optimistic about.

**Cross-module boundaries are charged.** `config/sapProducts.js` declared `crossModule` in
the first commit; `utils/sapEstimation.js` is where it finally costs something. SD without
MM is not a smaller project, it is an integration problem, and each boundary to a module
that is NOT in scope is charged at 20% of that module's own baseline — once per unordered
pair, because the boundary between MM and SD is one boundary and counting it from both
sides is the kind of doubling nobody notices in a total. The estimate lists them separately
instead of folding them into a subtotal.

**The phases are SAP Activate's, shared with the rest of the application.**
`config/activatePhases.js` is now the one list, read by the job board, the delivery history
and the estimator. It was declared inside `models/Job.js` while only the job board needed
it; a second copy would have been a list that drifts, and drift here means a quote and a CV
using the same word for different things. `assertEstimationIntegrity()` fails the boot if
the phase table stops matching it, in order.

One structural change follows: **training is a workstream, not a phase.** SAP Activate has
no training phase — enablement runs across explore, realize and deploy — so it lives in the
resource allocation. Excluding it removes a role and redistributes its days; the timeline
does not move, because enablement never was a block of calendar.

**And one thing the reference gets wrong.** It carries a `support` phase at 2% of the total
AND adds a separately computed hypercare budget on top of the implementation budget.
Hypercare is therefore in the number twice: once as days inside `totalManDays`, and again as
a figure added to the total. Nothing reconciles it, because the two live on different sides
of the addition. Here `run` is a phase like any other, `totalBudget` is the budget, and
`reconciliationProblems()` fails an estimate whose total differs from the sum of its
resource lines — so the bug cannot come back quietly.

## The documents

Three generators and a zip, rendered from a stored quote. The rule they all share: they
FORMAT `quote.estimate` and derive nothing, because a document that rounds differently from
the web page is the version a client quotes back at you in a meeting. Where a total is
printed it sums the rows above it, and in the workbook it is a real Excel `SUM` so a reader
who edits a cell sees the total move.

`utils/documents/validate.js` is ported unchanged and is the most valuable file of the
three areas: it opens every generated package and parses every XML part inside it before the
buffer is returned. A presence check for the expected parts does not catch a malformed one,
and a file that downloads fine and then will not open is the worst failure available for
something you are about to put in front of a client.

It earned its place immediately. `pptxgenjs` escapes slide text but writes `author`,
`company`, `title` and `subject` straight into `docProps/`, so a client company called
"Smith & Jones Ltd" — about as ordinary as a name gets — produces a raw ampersand in XML and
a deck that will not open. Confirmed against the installed version, in both directions: the
unescaped name is refused by the validator, the escaped one opens. The reference found the
same thing; here it is pinned by a test rather than only by a comment.

Two things the SAP versions say that the reference's cannot:

- **The boundaries get their own section in the SOW and their own slide in the deck.** They
  are the part of an SAP estimate a client most often challenges, and the answer is easier
  to give in writing than on a call: the work exists because the module on the other side is
  not in scope, and bringing it in would absorb it. Folded into a line called "integration",
  it becomes an argument later.
- **Hypercare is quoted as "of which", never as a line beneath the total.** The wording is
  the guard against the reference's double count returning through a formatter rather than
  through the engine, and there is a test on the phrase.

The workbook's Scope sheet says plainly that its column does not add up to the headline
figure, and where to find the multipliers that make up the difference — because a reader who
adds up a column and gets a different number will email about it, and they should not have
to.

## What the core build actually found

Four things, and they are the argument for doing this as a port rather than a copy.

1. **`User.list` never went through `utils/likePattern.js`.** Salesforce Hub wrote that
   module when one search box started asking four filter builders at once, fixed all four,
   and left the admin user search interpolating `%${search}%`. Nothing was injectable — the
   value was always bound — but a search for a literal `%` was still a full scan of `users`,
   and `a_b` still matched `axb`. Fixed here, and the reason is in the code.

2. **Substring alias matching does not survive this ecosystem.** The reference asks
   `haystack.includes(alias)`, which is safe when the shortest alias is "cpq". Every SAP
   module code is two letters: `includes('mm')` matches "committed", `includes('fi')`
   matches "specific", `includes('pm')` matches "employment". Every SAP advert contains
   those words, so every consultant would have scored a partial role match against every
   job. `utils/jobMatcher.js` matches on word boundaries, and a test pins it.

3. **A UNIQUE over a nullable expression is not unique.** Certifications are stored by
   catalogue code, with free text only for the reserved `OTHER`. Without the CHECK in
   migration 002, two `OTHER` rows with no name would both be accepted, because in SQL a
   NULL never equals another NULL. Verified against a real database: the duplicate is
   refused, the nameless OTHER is refused, and two different OTHERs are both allowed.

4. **A capability nothing reaches is not a feature.** `ConsultantProfile.buildFilter` could
   filter by delivered module from its first commit, and `routes/consultants.js` never
   passed it one — so `?modules=ewm` returned the entire directory. An integration test
   found it. This is the same shape as the reference's `consultant_projects` table, which
   sat in migration 002 with nothing reading or writing it while the CV's most useful
   section rendered empty.

And one the tests found in the tests: the integration suite decided whether to skip inside
`beforeAll`, which Jest runs *after* it has already registered every `describe`. It reported
seven skipped tests against a database that was running — a green run that tested nothing.
The decision now happens in `tests/globalSetup.js`, in the parent process.

## Known at the start, so nobody discovers it at the end

Salesforce Hub's own plan ends by noting that the real remaining work was never a feature:
it was that nothing was serving traffic. Three bugs there were findable only by running
against a real MySQL — an alias collision under `only_full_group_by`, a search test whose
source was unmocked and unreachable, and every recurring cost contributing zero to the P&L
because `mysql2` returns a DATE as a JS `Date`. All three were green under mocks.

So: this application runs against a real database, from empty, before it is called done.

**It does.** All five migrations apply to an empty schema, the generated column and CHECK on
`consultant_certifications` were exercised directly, and the whole marketplace flow —
register, post a role with modules and a phase, build a profile, enter an engagement, match,
filter both directories — runs end to end in `tests/integration/marketplace.test.js`. 55
tests pass, `npm run lint` is clean and `npm run validate-boot` passes.

One caveat stated rather than buried: the database exercised here was MariaDB 10.11, not
MySQL 8. It is close enough to catch every SQL error above, and it is not the same engine.
The `only_full_group_by` alias collision that Salesforce Hub hit is exactly the class of bug
that can differ between the two, so the first MySQL 8 run is still a real step and is not
yet taken.
