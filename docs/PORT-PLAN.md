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
| Scope estimator & quotes | 10 | ~8 | after the core |
| Documents: SOW, WBS, deck | — | — | after the core |
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
