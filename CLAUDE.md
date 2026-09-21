# Working on this codebase

Operational notes for anyone — human or agent — changing this project. These are the
things that are not obvious from reading the code, and each one is here because getting it
wrong produced a real bug, in this repository or in one of the two it was ported from.

## Ground rules

- **The schema is migrations.** Never add `CREATE TABLE` or `ALTER TABLE` to a model. Add a
  numbered file under `scripts/migrations/`. An applied migration is immutable — the runner
  compares checksums and refuses to start if one changed. Correct a mistake with a new file.
- **All SQL is parameterised.** Filter clauses are assembled from fixed fragments plus a
  `params[]` array. No value is ever interpolated into a query string.
- **Never add a second filter builder.** `Job.buildFilter` and
  `ConsultantProfile.buildFilter` are the only ones. A list view and a bulk mutation must
  provably target the same rows.
- **Every LIKE goes through `utils/likePattern.js`.** Not "most". The reference added that
  module, fixed four builders with it, and left `User.list` interpolating `%${search}%` —
  so the admin user search still answered a different question than the one typed. Nothing
  was injectable; a search for `%` was still a full table scan.
- **Validate `:id` params with `requireIdParam`.** `parseInt('44.map')` is `44`.
- **A vocabulary the schema owns gets exactly one copy in the code.** `Job.STATUSES` and
  `Moderation.SUBJECT_TYPES` mirror ENUMs, and a unit test compares each against its own
  migration file. The job statuses were written out by hand in three places before that —
  the employer's form, the route validating what it posts, and the admin filter — which is
  how a status gets added to a dropdown and silently rejected behind it.
- **SAP Hub owns its database.** It does not share a schema with any other application.
  `scripts/migrate.js` refuses to run when the target database already has tables but no
  migration history, because that means DB_NAME points somewhere else — and the bare
  "Table 'users' already exists" it would otherwise produce reads like a bug in the
  migration rather than a misconfigured connection.
- **The error handler must never respond twice.** `middleware/errorHandler.js` checks
  `res.headersSent` and delegates to Express when the response has already started.
  Writing a second status line throws ERR_HTTP_HEADERS_SENT and buries the original error.
- **Run `npm run validate-boot` before pushing.** It loads every module, compiles every
  template and measures the palette, without needing a database.

## The catalogues, and why they are asserted at boot

`config/roleTaxonomy.js`, `config/sapProducts.js`, `config/certifications.js` and
`config/settings.js` each assert their own integrity, and `server.js` calls all four before
it listens. Every failure they catch produces WRONG OUTPUT rather than an error:

- a role with no base day rate flattens a whole rate bucket to a silent default;
- a module whose `crossModule` names a module that does not exist drops effort out of an
  estimate;
- an alias claimed by two roles turns a match score into noise;
- a certification code carrying SAP's year suffix is stale within twelve months.

None of them crashes anything. All of them are cheap to check at the one moment somebody
is watching the log. **A new catalogue gets an assertion before it gets a consumer.**

## What is SAP-shaped here, and must stay that way

1. **Module codes are two letters.** `utils/jobMatcher.js` matches aliases on word
   boundaries, not substrings, and the boundary is applied per edge. `includes('mm')`
   matches "committed"; `includes('fi')` matches "specific". Every SAP advert contains
   those words. A substring match would have given every consultant a partial role match
   against every job. There is a test; do not weaken it to make a match "work".
2. **Modules filter ANY-of; skills filter ALL-of.** An advert names four modules because
   the programme touches four, and somebody browsing wants "anything involving MM or EWM".
   Requiring all of them returns an empty list from a control that looks like it widens the
   search. A skill filter is a competence claim, so narrowing is what it is for.
3. **A delivered module is not a claimed skill.** The module term in the match score and
   the module filter in the talent directory both read `consultant_project_modules` — the
   delivery history. Anybody can tick EWM on a skills list.
4. **`full_lifecycles = 0` is a real answer.** It is falsy, so `optional({ checkFalsy: true })`
   in a validator and `profile.full_lifecycles || ''` in a view both silently drop it —
   and the field appears not to save for exactly the people being honest about it. Use
   `??`, and score zero as filled.
5. **Effort baselines are SAP-sized.** An S/4HANA finance core is 60 consultant-days of
   foundation, not the reference's 12. A test pins the floor.

## The estimator

`utils/sapEstimation.js` is pure — no database, no clock beyond one timestamp — so its
invariants are testable, and they are the whole point:

1. Phase days sum EXACTLY to the total. Resource days sum EXACTLY to the same total. Both
   come from `apportionDays` (largest remainder). Never replace it with
   `Math.round(total * pct / 100)`: each call rounds in isolation and the parts drift away
   from the headline figure.
2. Every cost is `days × rate` on integers, so the budget reconciles line by line.
3. Calendar duration is the SUM of sequential phase durations. Do not "simplify" it to
   `totalDays / teamSize / 5` — that treats the whole programme as one parallel bucket.
4. **Nothing is counted twice.** The reference carries a hypercare phase inside the total
   AND adds a separate hypercare budget on top of it. Here `run` is a phase, its cost is
   inside `implementationBudget`, and `totalBudget` equals it. `reconciliationProblems()`
   asserts that equality, so the bug cannot return quietly.

`reconciliationProblems(estimate)` re-checks all of it. `routes/quotes.js` calls it before
an estimate is shown or stored and throws a 500 on failure, because that combination can
only mean a bug in the engine.

The module catalogue lives in `config/sapProducts.js` and nowhere else. Multipliers,
phases, resources and add-ons live in `config/estimation.js`. Both are asserted at boot.

`catalogueVersion()` is a hash of every number that can move an estimate. It is stored with
each quote, and a quote priced under an older catalogue is FLAGGED, never re-priced: the
stored breakdown is what was said to a client on a date, and recomputing it would change
history the moment somebody edits a base effort.

**Phases are SAP Activate's, from `config/activatePhases.js`, and that is the only copy.**
The job board stores one on every advert, the delivery history stores one on every
engagement, and the estimator distributes effort across all six. A second list would drift,
and drift here means a quote and a CV using the same word for different things. The boot
assertion checks the estimator's phase table matches it exactly, in order. Changing a name
is a migration (ENUMs in 002 and 003), not an edit.

**Training is a workstream, not a phase.** Excluding it removes a role from the resource
allocation and redistributes its days; it must not shorten the timeline, because enablement
was never a block of calendar of its own.

**Cross-module boundaries are charged once per unordered pair.** A module in scope whose
`crossModule` partner is not costs a share of the partner's own baseline — the boundary has
to be built either way. Counting it from both sides doubles it invisibly.

## Documents

`utils/documents/` renders `quote.estimate` and computes NOTHING. Every figure was produced
by the estimator and has already passed `reconciliationProblems()`. A formatter that
re-derives a percentage or re-rounds a cost is how a document ends up contradicting the web
page it came from. Where a total is printed it is a summation of the very rows above it —
and in the workbook it is a real Excel `SUM`, not the stored figure typed in again.

**Never serve a document nobody has opened.** DOCX, XLSX and PPTX are zip containers of XML
parts, and a generator that produces one subtly broken part yields a file that downloads
fine and then fails to open — which the recipient experiences as "you sent me a corrupt
file". `utils/documents/validate.js` opens the package and parses every part; a presence
check does not catch this. Each generator calls it before returning.

**pptxgenjs does not escape document properties.** It escapes slide text, then writes
`author`, `company`, `title` and `subject` straight into `docProps/`. A client called
"Smith & Jones Ltd" produces a raw `&` and a deck that will not open. `summaryPptx.js`
escapes all four; there is a test that pins both the escaping and the validator that would
otherwise have refused the file.

**Documents are generated on demand and never stored.** Storing them would mean two sources
of truth for the same figures. `quote_downloads` records that one was produced, with the
catalogue it was priced under, because a document only means anything alongside its basis.

**Filenames go through `slugify`.** They land in a `Content-Disposition` header, so a
project called `Müller & Co / "phase" 2` must not be able to put a quote, a slash or a
newline there.

Branding colours are contrast-checked in `utils/documents/brand.js` and fall back to the
Hub's own when they fail. Only the two accents are brandable: a company choosing its own
heading colour is branding, a company choosing its own body-text colour is a company
shipping an unreadable document to a client under its own name.

## The community and the points ledger

`points_ledger` is APPEND-ONLY. A `points` column on the user row would be unauditable —
nobody could answer "where did these come from", and a double award could never be found,
let alone undone. The total is a `SUM` over the ledger.

**Pay by settling to the state, not by reacting to the event.** `Points.settleTo(user,
reason, subject, intendedPoints)` reads what a subject has paid so far and appends the
difference. The obvious alternative — award on upvote, reverse on un-upvote, both keyed on
the event — is not reversible twice: the second upvote is ignored because the award's
dedupe key already exists, so the author keeps the reversal and ends BELOW where they
started while the score reads +1. The same shape hits an accepted answer moved away and
moved back. Settling is idempotent (a repeat computes a difference of zero), append-only,
and not farmable — the net is pinned to the intended amount however many times somebody
flips, so each swing costs a ledger row and never a point.

**`settleTo` is the only writer.** There was an `award`/`reverse` pair beside it for
one-shot events, and two writers with two key schemes in one ledger is a trap rather than a
convenience: an award writes `post:12`, a settle reconciles over `post:12#%`, and the settle
cannot see the award. The community paid for a post and the moderation screen took nothing
back when it was hidden — each half correct on its own. Everything that can be paid can also
be taken back by a moderator, so everything settles.

**Accepting your own answer marks the reply and pays nothing.** Self-answering is
legitimate and useful, so the reply is still the solution; paying 25 points for it — the
largest award on the list — would make "ask a question, answer it yourself" the cheapest
route to a standing.

**A post is hidden, never deleted**, and `hidden_at`/`hidden_by_user_id`/`hidden_reason`
exist from migration 009 even though the moderation screen is a later area. `Post.buildFilter`
already filters on `hidden_at IS NULL`; the reference adds the columns three migrations
later, so its community worked only because nothing had been hidden yet. Same argument as
`voided_at` on `rate_submissions`.

**`levelFor` must survive a negative total.** Reversals can take an account below zero, and
the next level is the one above the CURRENT band — not the first threshold above the point
total, which at -100 is level 1's own floor and renders as "100 points to level 1" at
somebody already in it. The progress bar is clamped for the same reason.

**The category tree is derived from `PRODUCT_LINES`**, so the community, the job board and
the estimator speak one vocabulary. `npm run sync:catalogues` is a deploy step that
deactivates a category that leaves the config rather than deleting it — posts point at it.

**`AppSetting.setMany` writes EVERY declared key**, because it reads an admin form where an
unticked checkbox posts nothing and absence has to mean false. A caller changing one switch
must hand back the others, or it silently closes registration.

## Messaging

**Every conversation is anchored to a subject** — an application, or an enquiry about a
specific job. There is no open direct-message inbox, because an unanchored DM channel on a
marketplace is a recruiting-spam vector and because anchoring gives every thread a subject
line that is true by construction.

That rule is held in three places on purpose, and the reference holds it in one. The route
requires a job, `Conversation.dedupeKeyFor` throws without one — the reference defaults it
to `0` and builds `enquiry:0:12:34`, which IS an unanchored DM — and the CHECK in migration
008 refuses the row. A rule enforced only by the handler that happens to be correct today is
the shape this file warns about everywhere else.

**Membership is a row, and it is a JOIN condition on every query.** There is no method on
`Conversation` that returns a thread without also proving the caller is in it, and
`postMessage` takes the membership lock inside the same transaction as the insert, so there
is no window between "are you a member?" and the write.

**The inbox is two queries, not one.** Joining `conversation_participants` a second time to
find "the other party" yields one row PER other participant, so a three-person thread
appears in the inbox twice with a different name each time — which contradicts the same
table's per-participant read state, and that read state exists precisely because a thread
can have more than two people in it. Fetch the threads, then their participants in one
batched query.

**A message body is plain text.** It is rendered with `<%= %>` and stored verbatim; the
model never strips markup, because then two places would decide what a message says. The
CSS keeps the author's newlines with `white-space: pre-wrap` and breaks long tokens with
`overflow-wrap: anywhere`, or a pasted URL widens the page on a phone.

`isNavigation` from `middleware/auth.js` decides JSON-versus-redirect here too. The
reference declares a private `wantsJson` in `routes/messages.js` that disagrees with the
auth guard about a request carrying no `Sec-Fetch-Dest`, so a plain Node client is
redirected by the guard and answered in JSON by the handler behind it.

## Payments

Two things are for sale — a featured job placement and a deposit against an accepted quote —
and `config/payments.js` is the only place that knows what either costs.

**A price is DERIVED, never accepted.** `resolveJobFeature` and `resolveQuoteDeposit` take a
subject id and the signed-in user, load the row, check ownership and eligibility, and return
an amount. Nothing reads an amount from the request body, and `Payment.create` throws on
anything that is not a positive integer of minor units, so a price cannot be smuggled in one
layer further down. There is a test that posts an `amount` and proves it never reaches the
payment.

**Idempotency lives in the schema.** `quote_deposits.quote_id` and
`job_feature_windows`' active window are unique keys, not `if (alreadyPaid) return` branches.
A redelivered webhook and a refreshed success page race each other on every real deployment;
`Payment.markPaid` updates conditionally and reports whether THIS call moved the row, so
exactly one of them fulfils. `payment_events.stripe_event_id` is unique for the same reason —
a retried delivery does not grow a second line of history.

**Fulfilment is not gated on the status column.** It is gated on the claim. Reading the
status and then acting on it is a check-then-act with a gap in the middle; `markPaid`
returning true IS the permission to fulfil, because the database decided it.

**Money we cannot fulfil is a queue, not an automatic refund.** Two people paying a deposit
on the same quote is rare and real. The second payment is flagged `needs_refund` and gets no
invoice. Reversing a charge from inside a webhook handler is an irreversible action taken on
a partial view of the world, so a person works the queue.

**The deposit states which rule produced it.** `depositForTotal` returns the amount and its
`basis` — `percent`, `floor` or `cap` — plus the share of the total it actually works out
at. This is not decoration: an SAP programme runs to seven figures, so ten per cent is far
above what a card will authorise and the CAP is the normal case, not the exception. A page
that says "10%" and charges €25,000 is a page that is wrong more often than it is right, so
the quote shows the amount, the rule, the real percentage and the balance left to invoice.

**The webhook is raw-bodied and CSRF-exempt, deliberately and narrowly.** `server.js` mounts
`express.raw` on `WEBHOOK_PATH` BEFORE the JSON parsers (a parsed body cannot be signature
checked), and the route is exempted through the `exempt` predicate rather than by being
mounted outside the middleware — see the CSRF section. Without `STRIPE_WEBHOOK_SECRET` the
handler refuses every delivery instead of trusting the body.

**Invoices snapshot the buyer.** Name, address and VAT number are copied onto the invoice
row at the moment it is issued. An invoice that re-reads the user table is an invoice that
rewrites itself when somebody moves office, which is the one thing a receipt must not do.
Same reasoning as a quote's stored breakdown.

## Admin and moderation

`routes/admin.js` applies `isAuthenticated, isAdmin` once, at the top, and the narrower
screens add `isSuperadmin` on top of that. Per-route guards on a surface this size is how
one route ends up without one.

**Superadmin is not decoration.** It gates the three things an ordinary admin account
should not be able to do alone: change anybody's roles or active state, read contributed
rates next to the people who gave them, and flip the switches that close registration or
freeze the community. `/admin/rates` carries the narrowest guard in the application because
everywhere else a rate is only ever seen inside an aggregate over at least three people,
and that screen deliberately sets it aside.

**The tab strip hides what the account cannot open.** A tab that answers 403 teaches people
to ignore the navigation.

**Neither the roles form nor the deactivate button will act on your own account.** An
administrator who removes their own last privileged role locks themselves out of the only
screen that could undo it.

**Content is HIDDEN, never deleted, and `models/Moderation.js` is the only module that
touches those columns.** Three things move with the flag on a reply — `posts.reply_count`,
the accepted-answer mark, and the points — so a bare UPDATE anywhere else would look like
it worked. Restoring gives back the writing points but NOT the solution mark: whether it is
still the best answer is the asker's call, not a side effect of an administrator undoing a
removal.

**Moderation settles points, it does not reverse them.** The reference keys each adjustment
on a fresh moderation event, which it has to, because with `award`/`reverse` a key derived
from the content is consumed after one cycle. It works, and it makes the balance a function
of the SEQUENCE of decisions rather than of the current state. Here hiding settles the
content's own subject to zero and restoring settles it back, so hide → restore → hide
leaves the author exactly one award down however many times the flag moved, and a reversal
of something that was never awarded cannot happen. A test drives three half-cycles.

**A rate submission is VOIDED, never hidden, and there is no "correct the value" path.**
The wording is the decision: hiding is about speech, voiding is about arithmetic. An
aggregate whose inputs an administrator can retype is an aggregate nobody should trust.
Re-submitting under a voided row is allowed by the unique key and the flash says so —
telling somebody their figure "counts towards this month" when it is excluded from every
published bucket is the one answer that path must not give.

**`POST /admin/payments/:id/refunded` records a refund; it does not issue one.** The refund
is made in Stripe by a person. A button here that moved money would make this a second
system of record, and when two systems of record disagree about a refund the one that is
wrong is never the payment processor.

**The error purge validates its window against a fixed set.** `INTERVAL ? DAY` with a zero
deletes everything, and it is the one action on the admin surface that cannot be undone.

**In `/admin/analytics`, GROUP BY the expression, not the alias.** `GROUP BY period` looks
equivalent and is not: MySQL resolves the name against the table's real columns first, and
`rate_submissions.period` exists — it holds the rate's own period. That one series would
group by the wrong column and then fail `only_full_group_by`.

## The assistant

A public endpoint that spends money per request, which is the only fact about it that
matters. Everything below follows from it.

**Three bounds, not one.** Per-IP rate limiting, a process-wide backstop, and a
month-to-date spend cap in `utils/aiBudget.js`. Only the third one bounds the invoice: rate
limiting bounds requests PER ADDRESS, and five hundred addresses each staying politely
under the limit still produce an unbounded bill. The per-IP limiter is keyed on the IP and
never on the session id — with `saveUninitialized: false` a cookie-less flood gets a fresh
session id every request, so a session-keyed counter never accumulates.

**The breaker fails OPEN and charges its own cache.** An unreadable ledger must not take
the feature down, so a failed lookup allows the call and logs loudly. The check runs before
the call and the cost is known only after it, so the cap is crossed by at most one
exchange — and `chargeToCache` adds each call's cost to the cached total, or a burst inside
one 45-second window would all read the same stale figure and sail past the cap together.
There is a test for that burst.

**Prices are part of the budget, so they are asserted at boot.** A token price of zero
makes every call free, the breaker never trips, and the first anybody hears of it is the
invoice. The model is an environment variable; the prices are two more, and changing the
first without the other two is the failure this assertion exists for. `/admin/ai` prints
all three together.

**The long half of the system prompt must be byte-identical on every request.** The cache
keys on an exact prefix, so the knowledge base is read once at module load and the
per-viewer context is a SEPARATE, uncached block appended after it. Interpolating anything
per-request into the prefix multiplies the input cost of the whole feature. A test asserts
the split and that only the first block is marked cacheable.

**What the site is ABOUT is generated, never typed.** The module catalogue, the role
taxonomy and the Activate phases come from `config/*.js` into the prompt. A hand-typed list
of SAP modules in a prompt is a second catalogue, and here the drift would be an assistant
confidently naming a module the filters do not have. Only `docs/assistant-knowledge.md`
describes how the site WORKS.

**Every path the knowledge base names is opened by a test.** The prompt tells the model
that this list is exhaustive and forbids inventing others, which makes a stale path worse
than a missing one: the assistant sends somebody to a 404 with complete confidence and has
no way of finding out it was wrong. That test found two on its first run.

**The visitor's history is untrusted input.** It lives in their own sessionStorage, is
posted back with every message, and is cut before it is walked, truncated per entry, and
stripped of any role that is not `user` or `assistant`. A `system` turn in a posted history
is not a typo to fix. Nothing is stored server-side: there are no conversation tables, for
a feature that answers questions about public pages.

**Only the account's SHAPE reaches the model** — signed in or not, and which marketplace
roles. No name, no email, no id. It is also the only part of the prompt a user could
influence, so keeping it to a closed set of booleans leaves nothing to inject into.

**Thinking tokens count against `max_tokens`.** The reference's 700-token ceiling was right
for a model that does not think; here it would spend the allowance reasoning and truncate
the visible answer. Brevity comes from the prompt and the low effort level. A
`stop_reason` of `max_tokens` is reported to the widget and labelled, never served as
though it were a finished answer.

**A 400 is logged as its own thing.** Every other failure here is transient and "try again
in a moment" is true; a 400 is the request shape being wrong, which fails identically
forever, and the generic message would otherwise be a lie sitting in the log for weeks.

## Auth and roles

`middleware/auth.js` answers a failed guard differently depending on the request:

- A top-level navigation (`Sec-Fetch-Dest: document`, or no such header) gets a flash
  message and a 302 to the login page.
- A background fetch gets `401 {success:false,error:...}`.

**Testing consequence:** a plain Node HTTP client sends no `Sec-Fetch-Dest`, so it is
treated as a navigation and sees **302**. A browser `fetch()` sends `Sec-Fetch-Dest: empty`
and sees **401**. Pick one deliberately in a test and say which.

`validateActiveAccount` runs on every request and rebuilds `req.session.user` from the
database, so a revoked role or a deactivated account takes effect on the next request. Do
not cache privilege flags anywhere else.

Role guards check the **flag**, not the primary `user_type`: an admin who is also a
consultant must not be refused a consultant feature. A guard lives in `middleware/auth.js`
and nowhere else — DynamicsHub wrote a private copy inside `routes/recruiters.js`, and it
redirected background fetches to a login page because a route-local guard does not know
about `Sec-Fetch-Dest`.

Role escalation is one-directional and this is a security boundary, not a UI nicety:

- Public registration filters submitted roles against `User.PUBLIC_ROLES`.
- `User.addSelfServiceRoles` unions and never removes; privileged flags pass through
  untouched.
- `User.adminSetRoles` is the only path that removes a role or grants a privileged one.

## CSRF

Every mutating form needs `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`.
Client-side fetches send `X-CSRF-Token`, which `public/js/main.js` attaches automatically
from the meta tag. A route that legitimately has no browser session (a signed webhook,
when payments land) goes through the `exempt` predicate, not by being mounted outside the
middleware.

## Never use `res.redirect('back')`

It reads `Referer`, and this app sends `Referrer-Policy: no-referrer`, so on a real browser
POST that header is empty and Express silently redirects to `/`. Use `returnTo(req,
fallback)` from `utils/returnTo.js`: it takes an explicit, allow-listed `redirectTo` field
the form carried, and otherwise the per-call-site fallback you pass.

## Consent and immutable dates

Only `POST /auth/register` passes a `consent` object to `User.create`. Admin creation and
tests pass nothing. Do not "helpfully" default it.

Every timestamp column is `DATETIME` with an explicit default. This is deliberate: with
`explicit_defaults_for_timestamp` disabled, MySQL gives the first `TIMESTAMP` column of a
table an implicit `ON UPDATE CURRENT_TIMESTAMP`, which would silently re-date
`users.created_at` on every unrelated `UPDATE`. `DATETIME` has no such behaviour.

## Certifications are coded

The stored value is the catalogue STEM (`C_TS4FI`), never a label and never a year-suffixed
code — SAP re-versions annually. `custom_name` carries text only for the reserved `OTHER`.
Migration 002 enforces it with a generated `cert_key` plus a CHECK, because a UNIQUE over a
nullable expression permits duplicates: in SQL a NULL never equals another NULL, so without
the CHECK two `OTHER` rows with no name would both be accepted.

## The rate index

Everything lives in `utils/rateAggregation.js` as pure functions over already-fetched rows.
Do not push aggregation into SQL: a `GROUP BY` will quietly bypass the floor.

1. Count **people**, not rows. One person with five submissions is a sample of one.
2. De-duplicate **after** filtering, never before.
3. Below the floor: keep the **count**, null the **values**.
4. A suppressed period is a **gap**. Not a zero, not an interpolation.

`RATE_MIN_SAMPLE` is configurable, but lowering it below 3 to make a sparse index look
fuller defeats the point of having it. It is an environment variable and not a setting,
precisely so that lowering it is a deployment decision with a diff behind it.

`voided_at IS NULL` is in every query in `models/RateSubmission.js` and there is no
`include_voided` option. One annual salary in a day-rate bucket moves a percentile for
everybody, silently. The columns exist from migration 004 even though the admin screen that
writes them is a later area — a guard that is only aspirational is not a guard.

## Settings are operational switches, never catalogue values

Only keys declared in `config/settings.js` can be written, and every value is coerced by
its declared type. The key check is `isValidKey`, not a truthiness test on the lookup:
`DEFINITIONS['__proto__']` is `Object.prototype`, which is perfectly truthy.

Roles, modules, effort baselines and day rates live in `config/*.js` under version control,
where a change has an author, a diff and a review.

## Tests

**Run `npm test`, not `npx jest`.** The script sets `NODE_OPTIONS=--experimental-vm-modules`,
and pptxgenjs lazily `import()`s node built-ins from inside a CJS bundle — without the flag
every deck test fails inside Jest while the same code works perfectly from the command line.

`npm test` runs both suites. The integration suite needs a real MySQL 8 and SKIPS itself
without one — the decision is made in `tests/globalSetup.js`, in the parent process, and
**not** in a `beforeAll`: Jest registers every `describe` while the file is being evaluated,
so a flag set in a hook is still false when the suite decides whether to skip. The first
version of that suite reported seven skipped tests against a database that was running,
which is the worst outcome available — a green run that tested nothing.

supertest parses a body whose type it recognises and hands back `{}` for one it does not,
so `res.body` is not a Buffer for a .pptx or a .zip. Download tests pass a binary parser
rather than weakening the assertion.

Run against a real database before believing anything about SQL. Salesforce Hub's port plan
ends with three bugs that were green under mocks: an alias colliding with a real column
under `only_full_group_by`, a test whose source was unmocked and unreachable, and a DATE
compared as a string because `mysql2` returns it as a JS `Date`.

## What is deliberately not here

See `docs/PORT-PLAN.md` for the full ledger. The refusals that must not quietly arrive
later: a tax savings calculator, browser-scored games, uploaded document templates, and any
path that sends a message to a sales lead without a person pressing send.
