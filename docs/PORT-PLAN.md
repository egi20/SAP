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
| Messaging | 5 | 5 | **done** |
| Community, feed, points | 9 | 9 | **done** |
| Payments: featured placements, deposits, invoices | 7 | 7 | **done** |
| In-site assistant | 1 | 1 | **done** |
| Admin: users, jobs, moderation, analytics, settings | 33 | 18 | **done** — the other 15 belong to areas not built yet |
| Referrals & commissions | 4 | 4 | **done** |
| LinkedIn confirmation | 3 | 3 | **done** |
| AI drafting, every draft verified | — | — | after the core |
| Search across everything | 1 | 1 | **done** — four sources; agencies join with that area |
| Recruiters (agencies) | 6 | 6 | **done** |
| Success stories, reviews | 10 | 11 | **done** |
| Sales CRM | 16 | ~16 | after the core |
| Finance: invoices, costs, P&L | 20 | ~15 | after the core |
| Tax advisory — the introduction only | 3 | 3 | after the core |
| Daily challenge, graded on the server | 3 | 3 | **done** — one game, not nine |

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

## The community

Posts, replies, votes, accepted answers, the points ledger, levels, a 30-day leaderboard and
the signed-in feed. The category tree is derived from `PRODUCT_LINES`, so a post, a job
advert and an estimate all name the same thing — plus two cross-cutting categories neither
reference has and every real SAP forum needs: **Transitions & upgrades** (greenfield versus
brownfield, readiness, simplification items) and **Clean core & extensibility**, because "can
I do this in standard" is not the same conversation as architecture.

Three findings, and the third is the one worth the area.

**Accepting a different answer never reversed the first award.** The reference clears
`is_solution` on the previous reply and stops, so both answerers keep 25 points and one
question has paid for two solutions while displaying one. `Points.reverse` exists for
exactly this — its own comment says so — and nothing called it.

**Accepting your own answer paid the largest award on the list.** Self-answering is
legitimate, so the reply is still marked; paying for it makes "ask a question, answer it
yourself" the cheapest route to a standing, in a scheme whose own stated rule is that one
which pays for volume gets volume.

**And the ledger was not reversible twice.** This is the one a test found rather than a
reading. Award-on-upvote plus reverse-on-withdrawal are both keyed on the event, so:

    upvote      post_upvoted:12:34          +2
    withdraw    reverse:post_upvoted:12:34  -2
    upvote      post_upvoted:12:34          ignored — the key exists

The author ends on **-2** while the score reads **+1**, permanently, because one voter
changed their mind twice. The same shape hits an answer accepted, moved away and accepted
again. `Points.settleTo` replaces both paths: it reads what a subject has paid and appends
the difference, so the ledger states what is true now. Append-only, idempotent, and not
farmable — flipping costs a row, never a point.

Also closed here: the four things the earlier commits deferred with a note — the signed-in
feed branch in `routes/index.js`, the `community_read_only` switch, the `communityWritable`
gate it enforces, and the Community menu. And `hidden_at` moved into migration 009 for the
same reason `voided_at` sits in 004: `Post.buildFilter` already filters on it, so the
reference's community worked only because nothing had been hidden yet.

## Messaging

Ported close to unchanged, because the design is the good part: every thread is anchored to
a subject, membership is a row that every query joins on, and read state is per participant.
DynamicsHub keyed one conversation per PAIR of users, which merges every topic between two
people into one thread — an employer discussing two roles with the same consultant ends up
with a single confusing conversation. Salesforce Hub fixed that and this inherits the fix.

Two things did change, and both are the same shape: a rule stated in a comment that only one
caller actually enforces.

**"There is no unanchored inbox" was true of the route, not of the code.** The reference's
`dedupeKeyFor` builds `enquiry:${jobId || 0}:…`, and `enquiry:0:12:34` is a direct message
between two accounts with no subject at all. Its route always passes a job, so the hole is
unreachable there today. Here the model throws, and migration 008 carries a CHECK that
refuses the row, so the promise survives the next caller.

**The inbox duplicated a thread with more than two people in it.** The reference joins
`conversation_participants` a second time for "the other party", which produces one row per
other participant. The same table's read state is per participant *because* "a single
is_read would be wrong the moment a thread has more than two people in it" — so the schema
anticipates the case the inbox breaks on. Fetching the threads and then their participants
in one batched second query is shorter than any GROUP BY that would satisfy
`only_full_group_by`, and it cannot silently duplicate a row.

Also closed here: the three forms the core commit left as comments — asking the advertiser
about a role, approaching a listed consultant about one, and opening the thread for an
application. They were deliberately not stubbed, because a button posting to a route that
does not exist fails in the one place somebody is trying to reach a person.

## Payments

Seven handlers, the same seven as the reference: checkout for each of the two products, the
webhook, success and cancel, the buyer's history, and one invoice. What changed is where the
guarantees live.

**The price moved out of the request.** The reference's featured-placement checkout reads
`req.body.amount` and trusts it, which is the oldest hole in e-commerce; it is unexploited
there only because the template happens to post the right number. Here a checkout takes a
subject id, and `config/payments.js` derives the amount from the row after checking the
signed-in user owns it. An integration test posts a price and proves it never lands.

**The idempotency moved into the schema.** The reference fulfils inside
`if (payment.status !== 'paid')`, which is a check-then-act: Stripe redelivers, the success
page is refreshed, and two fulfilments run from one payment. `Payment.markPaid` updates
conditionally and returns whether this caller moved the row, so the database picks the
winner. A test drives the same payment through fulfilment twice and asserts one window and
one invoice come out.

**The cap turned out to be the normal case, not the edge.** A ten per cent deposit is
sensible against the reference's five-figure engagements. Against an SAP programme it is six
figures, well past what a card will authorise, so `DEPOSIT_MAX_MINOR` binds on almost every
quote this application prices. That is a copy problem before it is a code problem:
`depositForTotal` therefore returns the `basis` that produced the number, the quote shows the
rule and the balance left to invoice, and the pricing page leads with "10%, up to €25,000"
rather than burying the cap in a footnote. €2,237,250 of scope takes €25,000 — 1.1%, and the
page says so before anybody clicks.

**No automatic refund.** Two deposits against one quote flags the loser `needs_refund` and
issues it no invoice. The alternative is a webhook handler that reverses a charge on a
partial view of the world.

This area also closed three promises the earlier commits left open: the paid placement the
job board's `is_featured` ordering was written for but nothing could buy, the CSRF `exempt`
predicate that had no exempt route to justify it, and the Stripe block in `config/config.js`.

## Admin and moderation

Eighteen handlers of the reference's thirty-three. The missing fifteen are not missing: they
are the admin halves of referrals, tax advisory, stories, reviews and assistant usage, and
each will arrive with its own area rather than as an empty screen now.

**Moderation closes three promises earlier areas left open**, all of the same shape — a
guard whose columns existed but which nothing could operate. `posts.hidden_at` and
`post_replies.hidden_at` were filtered on by `Post.buildFilter` from its first query,
`rate_submissions.voided_at` by every query in `RateSubmission`, and `payments.needs_refund`
was set by the fulfilment path with no queue to work it. Migration 011 adds the one thing
that was actually absent: the record of who decided and why.

**Points are settled here, not reversed, and that is a real difference.** The reference has
only `award`/`reverse`, so a key derived from the content is consumed after one cycle and
hide → restore → hide would take the points away once and never give them back. It works
around that by keying each adjustment on a fresh moderation event — correct, but it makes an
author's balance a function of the SEQUENCE of decisions rather than of the current state,
so a reverse for content that was never awarded still deducts. `Points.settleTo` computes
the difference between what a subject has paid and what it should pay now, so the balance
follows the state. A test drives three half-cycles and checks the author is exactly one
award down.

That change then removed `award`/`reverse` entirely, which was the real find: two writers
with two key schemes in one ledger is a trap. An award writes `post:12`, a settle reconciles
over `post:12#%`, and the settle cannot see the award — so the community would pay for a
post and the moderation screen would take nothing back when it was hidden, each half
perfectly correct in isolation. One scheme now, and nothing that can pay outside it.

**Two awards had been declared with nothing paying them.** `rate_contributed` and
`profile_completed` sat in `config/community.js` unreachable — and `rate_contributed`
mattered, because the void path settles that subject back to nothing and a reversal of an
award that was never made takes points off somebody for a contribution they were never paid
for. Both are now settled at their one choke point: the rate submit route, and
`ConsultantProfile.recomputeCompleteness`, which every edit already goes through.

**Three more things the screens found, none of which a mocked test would have.**
`Post.browse` accepted `include_hidden` and did not SELECT `hidden_at`, so the moderation
list could not tell a hidden post from a visible one and offered "Hide" on both.
`Job.browse` does not select `created_at`, and `published_at` is NULL for a draft, so the
obvious `new Date(j.published_at || j.created_at)` rendered every unpublished advert as
01/01/1970 on the one tab where they all are. And the void columns are `voided_by`, not
`voided_by_user_id` — a 500 on one screen, found by opening it.

**`Job.STATUSES` now has one home.** The five-item list was written out by hand in the
employer's status form, in the route that validates what that form posts, and in the admin
filter, against an ENUM in migration 003 that is the actual authority. A unit test compares
it — and `Moderation.SUBJECT_TYPES` — against the migration file itself.

## The assistant

One handler, as in the reference, and the design is taken almost whole: three independent
bounds (per-IP, process-wide, month-to-date spend), a ledger the breaker reads, a system
prompt split into a cached half and a per-viewer half, and no conversation storage at all.
Four things changed.

**The model is `claude-opus-5`, and the cost of that is stated rather than hidden.** The
reference picked the cheap model on the grounds that site navigation help is lookup rather
than reasoning — a defensible argument, and the wrong one to make silently on somebody
else's behalf. An Opus answer costs roughly five times a Haiku one, so the same cap buys
about a fifth as many exchanges. The model is therefore the one knob a deployment is
expected to turn, `/admin/ai` prints which model is answering next to what it has spent,
and the prices it is billed at are asserted at boot beside it — because a model changed
through the environment without changing the two price variables makes the circuit-breaker
cut off early or late, and nothing else in the system knows what a call costs.

**Thinking tokens count against the output ceiling.** 700 tokens was right for a model that
does not think. Here it would spend most of the allowance reasoning and truncate the
visible answer mid-sentence, which reads as a broken feature rather than as a cap. The
ceiling is 2000, brevity comes from the prompt and from a low effort level, and
`stop_reason: max_tokens` is reported to the widget and labelled rather than served as a
finished answer.

**The breaker charges its own cache.** The month-to-date total is cached for 45 seconds, so
a burst inside one window would otherwise all read the same stale figure and pass the cap
together. Each call now adds its own cost to the cached total as well as to the ledger.
There is a test that drives two expensive calls with no cache clear between them and
asserts the second is refused.

**What the site is ABOUT is generated from the catalogues, not typed into the prompt.** The
product lines, their modules, the role taxonomy and the Activate phases are rendered into
the cached prefix from `config/*.js` — the same source the job board, the estimator and the
community read. A hand-typed list of SAP modules in a prompt is a second catalogue, and the
drift would be an assistant confidently naming a module the filters do not have.

**And the test that opens every path the assistant may link to found two on its first
run.** The prompt tells the model the knowledge base lists every path it may use and
forbids inventing others, which makes a stale one worse than a missing one. `/contact` did
not exist — and the pricing page has been linking to it since the payments area, so "ask us
and we will invoice you directly" was a link to a 404. `/legal/cookies` did not exist
either; that one was removed from the knowledge base rather than invented into being, since
there is no cookie policy to point at.

Open, and stated rather than glossed: the request shape has never been exercised against a
live key. A wrong shape is a 400 on every call, so the route logs that case as its own kind
of failure — "this will not recover on its own" — instead of hiding it behind the
transient-failure message, and `/admin/ai` shows the daily error count beside the spend.

## Referrals and commissions

The one area where the reference arrived correct, and saying so is the finding. Its schema
— no balance columns, a signed append-only ledger in minor units, basis points as
integers, first-touch attribution unique on the referred account, a rate and an earning
window stamped at attribution — is taken almost unchanged, because every one of those
choices is already the answer to a bug its own predecessor had.

Two things are new here.

**The commission cap stops being an edge case.** Against the reference's five-figure
engagements, an uncapped 10% of a deposit is a rare large liability. Here the deposit
itself caps at €25,000 and, on an SAP-sized programme, reaches that cap almost every time
— so the uncapped commission is not the exception, it is the normal case, created by one
click. `MAX_COMMISSION_MINOR` is the same €500 the reference set; what changed is that a
test now pins the interaction between the two caps, because the figures either side of it
came from a different-sized market.

**A refunded payment no longer owes a commission forever.** The reference credits on money
received and has no path that un-credits it; the only correction is a manual adjustment
nobody is prompted to make, retyped by hand into a ledger that holds exact integers.
`Referral.reverseForPayment` reverses from the stored entry, idempotently, and it runs
from the admin refund button — so the human decision has already been taken and this only
stops it leaving an untracked debt. The distinction the reference was protecting still
holds: nothing in a webhook debits anybody.

That change made `/admin/payments` honest as well. Recording a refund previously cleared
the queue flag and nothing else, so a payment that was refunded still read `paid`; it now
moves to `refunded`, and the button is offered on any settled payment rather than only on
the collision queue — which was the only case that could never have earned a commission in
the first place.

Also closed here: the two hooks earlier commits left as comments rather than stubs, in
`routes/auth.js` and `services/paymentFulfilment.js`. Both said where the call would go
and why it could not go anywhere else; both now have the call, at exactly that point.

## LinkedIn confirmation

Three handlers, and the design is the reference's — which had already thrown away most of
DynamicsHub's version and kept the part that was true. What it verifies, and what it is
therefore allowed to say, is the entire feature: LinkedIn's userinfo response has no vanity
URL, no headline and no employer under any scope an ordinary application can request, so a
badge next to a `linkedin.com/in/...` link cannot mean that link was checked. DynamicsHub
set `linkedin_verified` having compared nothing at all.

What this area actually closes here is a flag with five readers and no writer.
`consultant_profiles.linkedin_verified` has existed since migration 002: the talent
directory's ranking expression scores it three points, the consultant card renders a badge
from it, the profile page renders another, the settings page reserved a slot for it in
writing, and `Application.js` selects it. Nothing could set it. That is the same shape as
`voided_at` on rate submissions and `hidden_at` on posts, and the third time this port has
found it.

Two small things went with it. The consultant profile page now shows the name that was
actually confirmed when it differs from the name on the profile — without that, the
sentence the member is shown at verification ("people reading your profile will see both")
is simply untrue. And `sap_community_url` is now labelled "(link provided by the member)"
exactly as the LinkedIn URL already was: the two are the same kind of claim, and only one
of them said so.

Also found in passing: `routes/consultants.js` built its page title with the fallback
"Salesforce consultant".

## Search

One handler over four sources, and the design is taken whole because its central rule is
the one this codebase already argues for everywhere else: search declares no filter. Each
source is a call into a model's own `browse`, so visibility stays the property of the
builder that owns it. A unit test now reads each source's function body and fails if it
contains SQL — crude, and exactly the check that matters, because the pressure to write
"just one query here" arrives the first time somebody wants a result ranked better.

Three things differ from the reference.

**The minimum query length is two characters, and here that is not arbitrary.** SAP module
codes ARE two letters — FI, CO, MM, SD, PP, QM — so "MM" is among the most obvious searches
anybody types on this site. The reference's floor of two happened to be right; on a
Salesforce corpus a floor of three would have cost nothing, and here it would refuse the
common case. The test says why, so nobody raises it later to make the LIKE cheaper.

**The agencies source is absent rather than stubbed.** `RecruiterProfile` does not exist
yet, and a fifth source returning nothing — or a view branch for a group nothing produces —
is the shape this port keeps finding and removing. The sources are a declared list, so that
area adds one entry.

**Two things were already styled or accepted for a feature that did not exist.** The
stylesheet has carried a `.nav-search` rule since the design system landed, with no element
to apply it to, and all four list routes already accepted a `q` parameter — so "see all"
works because those pages were built to be linked to this way, not because anything was
changed to accommodate search.

## Agencies

Six handlers: a public directory, an agency's dashboard and profile form, the save, the
visibility switch, and one public page by slug. The reference had already fixed most of
what DynamicsHub got wrong here, and its two corrections are the ones worth restating —
the dashboard no longer self-heals with an INSERT on a GET, and the profile route's
validation is actually executed rather than declared and forgotten.

**Specialisms became product lines.** The reference filters agencies by Salesforce cloud
family; the SAP equivalent at module level is fifty-seven entries, which is a form nobody
completes honestly. Eight product lines from `config/sapProducts.js` is a set of tick boxes
somebody actually fills in, and it keeps the directory speaking the same vocabulary as the
job board, the estimator and the community categories.

**And the MySQL-8-versus-MariaDB caveat finally bit.** Every area so far has carried the
note that this application is written for MySQL 8 and tested against MariaDB 10.11 with no
divergence found. `CAST(? AS JSON)` is the first: MariaDB rejects it outright with a parse
error, because its `JSON` type is an alias for LONGTEXT with a `json_valid()` CHECK and
there is no JSON cast target to cast to. Binding the serialised string works on both. Found
by running the save against a real database — the query reads perfectly well.

Two more readers-without-writers closed with this area: `ImageBlob` has declared a
`recruiter_logos` bucket since the core build, and the `isRecruiter` guard has existed in
`middleware/auth.js` with nothing behind it. Search gained its fifth source, which the
sources list was written to take.

## Stories and reviews

Eleven handlers: the public list, one story, the story photo, the review list and the
submission, plus six in admin. The reference had already made the two decisions that
matter — reviews require an account and derive the author's role from the session, and
content is hidden rather than deleted — and both are restatements of rules this codebase
applies everywhere else, so they came across unchanged.

The area's own refusal came with it and is now pinned twice. DynamicsHub's success stories
carry `gross_before`, `net_before`, `gross_after` and `net_after`, and its tax page renders
the difference as a monthly saving: that is the savings calculator this port refuses,
wearing a different hat. The columns are absent, the normaliser drops them, and a test
scans both the migration file and the model output for anything saving-shaped.

**Two things the CSP and the blob store had been waiting for.** `server.js` has carried a
`frameSrc: ["'self'"]` with a written note saying the video allowlist would come from the
one module that can build an embed URL — it now does, shared as `EMBED_HOSTS`, and a test
pins the exact shape so the policy and the allowlist cannot drift. And `models/ImageBlob.js`
has declared a `story_photos` bucket since the core build with no table behind it.

**It also finishes the agency area.** `ImageBlob` declared a `recruiter_logos` bucket and
`RecruiterProfile.setLogo` existed with no table and no caller — the reference groups that
table into this migration, and the upload and serving handlers are added with it. That is
the fourth reader-without-writer this port has closed.

## The daily challenge

Three handlers, and the refusal recorded at the start of this port is the feature.
DynamicsHub ships nine browser-scored games: `routes/games.js` reads `{ score, gameDate }`
from the request body and writes both to a leaderboard, and 2,467 lines of
`views/partials/games-section.ejs` ship every question together with the index of its
correct answer. Anybody signed in can post a perfect score for any date; anybody curious
can read the answers in view-source. That output feeds a points summary, so a browser can
mint points — and in this codebase the ledger is append-only precisely so that a total can
always be explained.

So: one game, graded on the server. The answer key never leaves the process, the browser
posts the options it chose, the date comes from the server clock, and one attempt per
person per day is a unique key rather than a check. The streak is derived from attempt
dates instead of being posted by a check-in endpoint. The other eight games are the same
shape wearing different UI, and porting them would be porting the bug eight more times.

**The question bank is written from scratch**, which is the real SAP work here — the
reference's twenty questions are all Apex, SOQL and sharing rules. Twenty-four SAP
questions, each tagged with a community category slug so a weak area points at a category
that actually exists, and each carrying an explanation, which is the part that makes the
quiz worth playing rather than a slot machine.

**Two things changed from the reference.** Points are settled once per attempt rather than
awarded once per correct answer — `Points.award` no longer exists here, and the attempt is
the honest subject anyway. And a closed attempt is now re-graded on reload:
`Challenge.replay` rebuilds the result from the date and the stored choices, so a refresh
no longer throws away the explanations, and the recomputed score is compared with the
stored one so an edit to the bank under a played day is logged rather than silent. A test
found that gap by asserting the wrong thing and being right about the symptom.

**And the MariaDB divergence appeared a second time.** `CAST(? AS JSON)` again, in the
attempt insert. Found the same way as the first: by running it.

## What running it on Windows found

The project is developed in a Linux container and every check had passed there for sixteen
commits. The first clone onto a Windows machine failed on the first command that matters:

```
npm test
> NODE_OPTIONS=--experimental-vm-modules jest
'NODE_OPTIONS' is not recognized as an internal or external command
```

`VAR=value cmd` is POSIX shell syntax. Neither cmd nor PowerShell understands it, so the
test suite could not be run at all on Windows — not a wrong result, no result. Fixed with
`cross-env`, which is now also a ground rule in CLAUDE.md: an npm script here has to run on
Windows, because nothing in CI or on a developer's machine will catch it otherwise.

Worth recording beside the MySQL 8 caveat, because it is the same shape of gap — a claim
("the suite passes") that is true only on the one platform anybody has tried.

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

## The company role, compared against DynamicsHub

A page-by-page comparison of the hiring side produced twelve things DynamicsHub has and
this did not. Four were built, one was already here and unreachable, and seven are refused
or deferred with the reason stated — the ledger matters more than the count.

**Built.**

- **Talent Pipeline** → `/applications`. Every candidate for every one of the company's
  roles, one row each, with a name search, a stage filter, "Interviewed" and "Include
  withdrawn". DynamicsHub's "Interviewed only" filters the current status; this reads the
  event log, so somebody who interviewed and was turned down still matches.
- **Applications board** → `/applications?view=board`, the same route and the same filter
  builder, which is why the board cannot show a row the list hides. No drag-and-drop: see
  CLAUDE.md. Six live columns, capped, and it says when it has reached the cap.
- **The account overview** → `/profile`, which redirected to `/profile/settings`. "What can
  I change about my account" and "what IS my account" are different questions, and none of
  the facts people come here to check — which address this is, which roles the account
  holds, whether the address is confirmed, when they joined, when they were last in — is
  editable from a form, so none of them was on one.
- **The dashboard's stage tiles are links**, and the company block offers the pipeline, the
  board, the directory and the estimator. The numbers were already there with no way to
  open the rows behind them.

**Already here, and unreachable.** The approach form on a consultant profile has been
anchored to one of the reader's own open adverts since messaging landed, and a company with
no open advert saw nothing at all — so the feature read as missing. It now says why, and
links to the thing that would fix it. The public company page had the same shape: it has
existed since the advert gained its "About the company" box and nothing signed-in linked to
it, so the person who most needs to see it could not.

**Refused.**

- **An unanchored "Message Consultant" button.** The whole messaging design is that every
  thread has a subject that is true by construction; a button on a profile is the
  recruiting-spam channel the three enforcement points exist to refuse. The anchored
  version is one click further and is the same button for anybody who actually has a role.
- **Document templates with uploaded `.docx`** — already on the standing refusal list.
  A template upload is arbitrary user-supplied Open XML rendered into documents this site
  puts its name on, and `{company_name}`-style placeholders are a template language nobody
  owns.
- **A tax optimisation calculator with a savings figure** — the refusal this project has
  held from the first commit, and the second time it has arrived wearing a different hat.
- **A budget planner that prices roles per day, week, month and quarter.** The rate
  benchmark already answers it from the employer's side, prints its working, and is checked
  against its own anchor. A second figure for the same question with nothing reconciling
  the two is the thing `config/payments.js` exists to prevent.
- **An external application URL on an advert.** It sends the candidate off-site, so the
  pipeline, the application count, the withdrawn exclusion and the anchored thread all stop
  working at once — and the count on the page would read zero forever while people were
  applying.
- **A welcome tour.** A tour is a workaround for navigation that does not explain itself,
  and it is shown exactly once to the person who needs it least.
- **AI-written CVs and cover letters** — settled when the CV builder landed. The profile is
  the CV and it invents nothing.

**Both deferred items were then built, and both changed shape on the way.**

*The advert's sections* (migration 021) are three optional columns — and the argument for
them is not the form, it is that one list in `config/jobSections.js` feeds the form, the
page, the search clause and the match haystack. Three columns that only the form knew about
would have made matching quietly worse: an advert naming EWM under "Requirements" and
nowhere else would have scored zero against an EWM consultant.

*The transfer* (migration 022) is an offer addressed to an email, never a claim link, and it
is refused outright once an advert has applications or a thread. The reason is the thing
worth recording: this schema has no organisation, so two colleagues are two unrelated
company accounts, and nothing here can establish that the recipient works for the employer
those candidates applied to. What would unlock the richer version — transferring an advert
with its pipeline — is an organisation model where two accounts are provably the same
employer, not a bigger form. Until then a handover is for an advert nobody has applied to
yet, which is the common case it was asked for.

**The dashboard and settings, last.** DynamicsHub's dashboard is a grid of action cards;
ours showed the numbers and, on the consultant half, offered nowhere to go from them — the
pages existed and the one place somebody lands after signing in did not name them. Both
halves now carry the same row of ways on, and the hiring stage tiles are links to the rows
they count.

Settings gained the one thing it was genuinely missing: **Danger Zone → Delete Account**,
built as a closure rather than a delete. The reasoning is in CLAUDE.md; the short version is
that a hard delete here would cascade into two append-only ledgers, invoices, half of other
people's conversations and an employer's pipeline, so the account is erased and deactivated
and the page names every record that stays, with the reason, before the button. DynamicsHub's
"Company Details" block in settings was refused: it is a second form writing the columns the
company profile already owns, and settings now links there instead.

Everything else in the shape of DynamicsHub's version was refused for a stated reason: the
claim link (an access grant to whoever an inbox forwards to), resolving the address to an
account at creation (an account-existence oracle any company could query), and an external
application URL on the advert (it empties the pipeline and the public count at once).

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
