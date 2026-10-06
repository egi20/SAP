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
- **Every link in the navigation and the footer points at a route that exists**, and
  `tests/integration/navigation.test.js` reads both partials and opens each one. It reads
  them as TEXT, not rendered: the signed-in half of each menu never renders for a
  logged-out visitor, so walking the rendered page would check half the links and pass. A
  redirect counts as alive and its destination is opened too. A dead link survives in a
  chrome partial because nobody who works on the site ever clicks it — the menu is the
  first thing a visitor tries.
- **The Hub's own social accounts live in `config/social.js`**, one per environment
  variable, host-pinned and asserted at boot, and an account that is not configured is not
  rendered. The footer and the fixed rail read the same list, or the two drift the moment
  an account is added.
- **Run `npm run validate-boot` before pushing.** It loads every module, compiles every
  template and measures the palette, without needing a database.
- **An npm script must run on Windows too.** No `VAR=value cmd` prefix (POSIX only — use
  `cross-env`), no `&&` chains that assume a POSIX shell, no `rm`/`cp`. The whole project
  is developed on Linux, so nothing catches this except somebody on Windows failing to run
  it — which is exactly how the `NODE_OPTIONS` prefix in `npm test` was found.

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

**The CV has no wizard, because the profile IS the CV.** The reference asks people to
type their career into a form, which produces a second copy that starts drifting from the
profile the directory searches the moment either is edited. `utils/cvData.js` reads the
profile and nothing else — including the delivery history, which is the part a generic CV
builder cannot ask for because it does not know what a module is.

**It invents nothing.** No generated summary, no rewritten bullet, no inferred seniority:
every line is something the member typed or a label from a config catalogue. A document
that puts sentences in somebody's mouth is a document they send to an employer under their
own name, and the first they hear of a claim they cannot stand behind is in the interview.
There is no cover letter for the same reason — without their own words it is a form letter,
which tells the reader you did not write to them.

**Targeting REORDERS, it does not rewrite.** Given an advert, the engagements that touched
its modules come first and are marked; nothing is added, removed or reworded. A test asserts
every string on a targeted CV is also on the untargeted one. The advert is loaded only when
it is open, so the builder cannot be used to probe for drafts by watching whether the
ordering changed. The document SAYS which advert it was ordered against: a CV is forwarded,
and without that line "Relevant here" is a claim with no subject.

**The rate and the contact details are off by default, every time.** A CV travels further
than the person who wrote it expects, and a day rate on one that reaches a procurement team
is a negotiating position given away before the conversation starts. The preview renders
everything the file will contain — a preview that omits a field the download includes is a
preview that lies about the document, and the field it would omit is that one.

**ATS-friendly is a shape, not a claim.** The reference advertises it and lays its CV out
in a two-column table. An applicant-tracking system reads the document in linear order, so
columns interleave, text boxes are skipped and a page header repeats as though it were
content. `cvDocx.js` is a single column of headings, paragraphs and bullets with no table
anywhere, and a test opens the generated file and fails on `<w:tbl>`.

**The route takes no id.** It reads the signed-in member's own rows; a CV endpoint with an
id in the path is one somebody will enumerate.

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

**Articles have their own page, and the kind is fixed rather than filtered.** A question is
scanned and answered; an article is browsed and chosen. `/community/articles` sets `kind`
and offers no control that could clear it, because clearing it would move the reader off
the page they opened. It is the same `Post.browse` with no second builder and no SQL in the
route. **No tag cloud** — the reference has one, and tags would be a fourth vocabulary
beside the categories, the modules and the role taxonomy, with nothing asserting it and
nobody owning it.

**The author picker is built from the same filter, minus the author.** Otherwise it offers
only the person already selected, and — the part that matters — a member whose single post
is hidden would still be named in a dropdown beside a count of rows the list will not show.

**`/community/author/:id` publishes nothing the feed does not.** Every post has carried its
author's name in public since the community landed, so collecting one person's posts in one
place reveals nothing new. It is NOT the consultant profile: no rate, no availability, and
no message button — a button there would be the unanchored direct-message channel the
messaging rules exist to refuse. It shows a points TOTAL and never the ledger, because a
public breakdown of somebody's awards and reversals publishes a moderation history they did
not ask to have read out. An inactive or missing account is a 404, never an empty page: a
page that renders for any id confirms which ids exist.

**Downvoting takes no points away beyond removing the upvote's own award.**
`Points.settleTo` pays while an upvote STANDS and settles to zero otherwise; it never
settles negative. A community this size cannot afford a button that lets one reader cost
somebody their standing, and "this is wrong" is worth saying without it being worth money.
The score itself does go negative, which is the signal doing its job.

**The accepted answer is first under every reply sort.** `top`, `oldest` and `newest` order
everything BELOW the solution; the solution is pinned in all three. A thread whose answer
sorts to the bottom under "Newest" is hiding the one reply somebody came for — the sort is
a reading preference, not permission to bury it. The sort key is looked up in
`REPLY_SORTS`, never interpolated, so a query string cannot reach an ORDER BY.

**A vote returns to the sort the reader was in.** Without the query string, somebody who
chose "Oldest" is dropped back into "Top" by the act of voting, which reads as the page
losing their place.

**One vote widget for posts and replies.** `views/partials/vote-widget.ejs`. The pair was
written out twice with a dead `voteForm` helper above it that nothing called — the shape of
something somebody meant to factor out and did not. It renders a score and no buttons for
the author's own content, because `Post.vote` refuses a self-vote and offering the button
would be offering an error.

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

## The blog

**It is a VIEW, not a second content store.** An editorial post is a community article
written from a Hub account and marked with `posts.is_editorial` (migration 020). There is
no `blog_posts` table, because a fourth place for text would overlap community articles and
success stories, and would need its own editor, moderation, slug rules and idea of
"hidden" — all four already written, tested and argued about once. `/blog` is
`Post.browse({ kind: 'article', editorial: '1' })`, and a test fails if that route grows
any SQL.

**So a blog post can be replied to, and that is deliberate.** An announcement nobody can
answer in public is an announcement answered in somebody's inbox instead, where nobody else
can read the reply.

**There is no `/blog/:slug`.** The article already has a canonical URL under `/community`.
A second address for the same text is two pages competing in search, two reply counts to
reconcile, and two places to land on a post that has since been hidden.

**The mark is read from the form and checked against the SESSION.** `routes/community.js`
sets `isEditorial` only when the poster is an admin; the model cannot tell who sent the
request, and a posted `is_editorial=on` from an ordinary member is precisely the request
that has to be refused. Articles only — a "win" in the Hub's own colours would be the site
congratulating itself.

**No subscribe box.** A box collecting an address with nothing to send it, no record of
consent and no unsubscribe link is a promise made to somebody who cannot withdraw it. It
arrives with a newsletter, a stored consent and a working unsubscribe — all three, the same
rule the contact form waited on.

**The social rail renders only where a real account is configured.** `socialLinks()` always
appends the support address, so a rail built from it unconditionally is a permanent strip
holding one email icon — furniture, not a social rail. It reads the same list as the
footer, and it is hidden below `xl`, where a fixed column either overlaps the content or
steals a thumb's width of it.

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

**A company with no open role is told why, not shown nothing.** The approach form on a
consultant profile is anchored to one of the reader's own open adverts, so a company with
none had no way to get in touch and no explanation — which reads as a missing feature
rather than as the rule it is. It says which it is, and offers the thing that would fix it.
There is still no button that opens an unanchored thread, and there is no id-taking
endpoint that would.

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

## Enquiries

**A form needs three things, and it got all three at once.** `/contact` shipped as an
address with a note saying a form needs somewhere to put what it collects, a spam defence,
and somebody watching a queue — and that until all three exist, a form is the version that
can silently drop a message while both sides believe it was sent. Migration 018 is the
first, the limiter/honeypot/length floor is the second, `/admin/enquiries` is the third.
None of them is worth anything alone, which is why they are one change.

**ONE table and ONE queue for the contact form and the issue reporter.** They are the same
thing — a person writing in and expecting an answer — differing only in which fields the
form asked for. Two queues means a second one nobody opens, and "somebody is watching" is
the whole justification.

**The issue fields are NULL on a contact message, not defaulted.** "Not asked" and
"answered with the first option" are different facts about the same column. The CHECK in
018 holds it as well as the form and the model, because a rule enforced only by the handler
that happens to be correct today is the shape this file keeps warning about.

**No IP address column.** It would help with abuse and it is personal data this application
has not told anybody it collects on a public form. The spam defence stores nothing: a
per-IP rate limit, a honeypot and a length floor. A column added later is a migration; a
column added now is a commitment made quietly.

**A honeypot hit is accepted and discarded without saying so** — telling a bot it was
caught is telling whoever wrote it what to change. It is the one case where these forms
drop a message on purpose, which is why the field is hidden from sighted users by the
stylesheet, from screen readers by `aria-hidden`, from the keyboard by `tabindex="-1"`, and
from a helpful browser by `autocomplete="off"`. It is positioned off-screen rather than
`display:none`, which is what a bot checks for.

**Nothing is sent from the admin screen.** The reply is composed in the mailbox a person is
already reading. A reply form here would make the Hub a second place the conversation
partly lives, and the half that is missing is always the half somebody needs later. A test
reads the route and the template and fails if either grows one.

**An empty note box keeps the note that is there.** Same reason `AppSetting.setMany` writes
every declared key: a form that submits a subset must not be read as a form that cleared
the rest.

**Testing consequence:** the enquiry limiter counts every POST, including the ones that 422
or fail CSRF. A suite that exercises the limit spends the budget its other cases need, and
the next test to be reordered then fails as a validation error for a reason that has
nothing to do with validation. Assert the limiter's configuration from the source instead.

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

## The sales CRM

**Read this before changing anything in `models/Crm*.js`.** Every other table in this
schema holds something somebody gave us — an account they created, a profile they
published, a rate they contributed, an enquiry they sent. `crm_leads` holds the names,
addresses, phone numbers and job titles of people who have NOT asked to be contacted, so
that somebody can contact them. That is a different kind of object and every rule below
follows from it.

**SUPERADMIN ONLY**, the narrowest guard in the application alongside `/admin/rates`, and
for the same reason: moderating a forum is not a reason to read the contact details of
people who are not members. It is mounted at `/crm` rather than under `/admin` because it
is not an administration screen for this site's own members, and it appears in the admin
tab strip because a surface reachable only by typing its URL is one nobody audits.

**NOTHING HERE SENDS ANYTHING.** A draft is written, a person sends it from their own mail
client, and a person records that they did. There is no mail call, no queue and no
scheduler, and a test greps the route, the models and the views for one. `marked_sent_at`
is named for what it is — a note somebody made — so nobody later reads it as a delivery
receipt. This is the standing refusal the port plan opens with, and it is the reason this
area is a CRM rather than a sending tool.

**A lead cannot exist without a source.** `source` is NOT NULL, validated against
`config/crm.js`, and most values require a detail — "a public directory" means something
only with the directory named. "Where did you get this person's address" is the first
question anybody will ask and it cannot be reconstructed from memory a year later.

**The source is FIRST-TOUCH and permanent.** A re-import corrects a phone number and never
the provenance; where the two disagree the second answer is written to the activity log,
dated and visible, instead of silently replacing the first. Same argument as
`referral_attributions`: a record a later file can rewrite is not one. The reference
overwrites it on every import, so a lead acquired from an inbound enquiry quietly becomes
one scraped from a directory.

**Suppression outlives the row.** `crm_suppressions` is keyed on a SHA-256 of the
lower-cased address and holds no address, because a suppression list full of plaintext
addresses IS a mailing list of people who asked not to be mailed. It has NO foreign key to
`crm_leads` and nothing anywhere deletes from it: deleting a lead is exactly how an
application forgets its subject asked to be left alone, and the next quarterly import
writes them straight back in. The hash is unsalted on purpose — a salt would make the list
useless for its only job, checking an address somebody is about to import.

**The suppression check runs on every write path, not at send time.** By the time something
is about to go out the address is already in the database, already in an export, and
already in somebody's list. A suppressed address is REFUSED, never "imported and flagged":
a row that exists is a row somebody eventually writes to.

**Unsubscribing does three things in one transaction, and any two without the third is a
half-kept promise:** it writes the suppression, it ERASES the contact details from the lead
row, and it keeps the company and the activity log. Same shape as
`models/AccountClosure.js` — erase the identity, keep the record. The reference keeps the
row intact and relies on the status being read, which works exactly until somebody writes a
query that forgets to. `unsubscribed` is terminal and reachable from every live status in
ONE step, and the boot assertion checks both: somebody asking to be left alone must never
depend on the pipeline being in the right place first.

**A lead somebody has actually contacted is never bulk-deleted.** Its activity log is the
answer to a complaint about that contact and the log cascades with the row, so the bulk
action reports those rows back rather than skipping them silently. The way to remove one is
`unsubscribed`, which erases the person and keeps the record. The count interlock is
ported as-is from the reference, which got it right: the screen posts the number it showed
and the model aborts on a mismatch.

**`crm_lead_activities` carries no contact details of its own**, which is what makes
erasing a lead leave an intact, personal-data-free record behind. Append-only, no edit, no
delete.

**One filter builder**, used by the list, the count, the CSV export and both bulk actions —
the rule exists for exactly that last case: a bulk delete and the screen that showed what
it would delete must provably target the same rows.

**Product lines come from `config/sapProducts.js`**, not a new taxonomy. A CRM with its own
list of "what they run" is the fifth place SAP's product names would be written down and
the first to drift. Filtered with `JSON_CONTAINS` + `JSON_QUOTE` and the serialised string
bound directly, never `CAST(? AS JSON)` — the MariaDB lesson from the agency directory.

**The import is pasted, not uploaded, and previewed before it writes.** An upload path
would hand a file full of other people's contact details to middleware configured for
profile photographs and would put it somewhere for the length of a request; pasted text
lives in one request body and is written or discarded. Two posts of the same text — the
first shows what would happen, the second does it — so there is no server-side draft
holding contact details between requests. CSV only: the reference sniffs every sheet of an
.xlsx and guesses which tabs are leads, and guessing at the shape of a file full of other
people's details is the wrong place to be clever. One import is one provenance, so the
source describes the FILE and there is no per-row source column.

**A lead whose address already has an account here is flagged, never blocked.** A cold
approach to somebody who is already a member is the one message this site should not send,
and the person writing it needs to know before they write it.

**Testing consequence:** a suppression is permanent, so a suite that suppresses a FIXED
address passes once and fails on every run after. Use a fresh address per run — clearing
the table in `beforeAll` would "fix" it by deleting the one record this area exists to
keep.

## Referrals and commissions

**There is no balance column anywhere.** A balance is `SUM(amount_minor)` over
`commission_ledger`, exactly as a points total is a SUM over `points_ledger`. The
reference kept `pending_earnings`, `total_earnings` and `paid_earnings` on the referrer
row beside the rows they counted; the moment those disagree nobody can say which is right,
and this is real money somebody is owed.

**Everything is minor units and basis points, as integers.** `amount_minor * rate_bps /
10000` is exact. The reference stored a DECIMAL percentage and reconciled payouts with
`parseFloat` and a `+ 0.001` tolerance in every comparison — that tolerance IS the bug,
made visible.

**Attribution is first-touch, once, and permanent.** `referral_attributions` is UNIQUE on
the referred account, and `middleware/referral.js` never overwrites a code already in the
session. Last-touch would let anybody claim somebody else's introduction by getting a link
in front of them the day before they pay.

**The session is read before the posted field, and that ordering is the security of the
scheme.** The session value came from a link this visitor followed; `req.body.ref` is
whatever the browser sent and could name anybody.

**`rate_bps` and `earns_until` are stamped at attribution**, not recomputed on read.
Changing the rate or the window in config must never reprice or revive an introduction
made under different terms. A test pins it.

**A commission is earned when money is RECEIVED** — `Referral.credit` is called from
`services/paymentFulfilment.js` and nowhere else. Crediting at checkout creation or on a
quote's headline figure is how a scheme ends up owing a percentage of revenue that never
arrived. It is NOT gated on which racer claimed the payment: the dedupe key makes a second
call a no-op, and a commission that depends on who won the race goes missing the once the
webhook lost.

**A zero-value entry is still written.** "Your introduction bought something and it earned
nothing, because that product does not pay commission" is information the referrer is
owed; a gap is what produces the email asking where their money went.

**A payout settles the whole unpaid balance, never a typed amount.** The reference matched
a requested figure against unpaid rows FIFO and produced refusals like "requested €3 cannot
be matched exactly" — a problem created entirely by that design. It records that money
LEFT; nothing here moves any.

**Recording a refund reverses that payment's commission, and nothing else ever claws one
back automatically.** `Referral.reverseForPayment` runs from the admin refund button —
after a person has already decided to give the money back — and writes a compensating
entry computed from the stored earning, so it is exact where a retyped adjustment is not.
The reference has no reversal at all, which leaves a refunded payment owing commission
forever. A commission already paid out still reverses and the balance goes negative: the
next payout settles less, which is the correct answer and a visible one.

**Deactivating a referrer stops new introductions only.** It does not touch existing
attributions or anything already earned.

## Search

**Search adds no filter of its own, and that is the security argument as much as a tidiness
one.** Every source in `services/search.js` calls the same `browse` its list view calls,
with the same defaults, so a row invisible on `/jobs` is invisible here without anything in
that file knowing why. A search page that assembled its own WHERE clause would be a second
place that has to remember `status = 'open'`, `is_public = 1`, `u.is_active = 1` and
`hidden_at IS NULL` — and the first one to forget is the one that leaks. A unit test reads
each source's function body and fails if it contains SQL or passes `q` anywhere but the
filter argument.

**No cross-type relevance score.** A match on a company name and a match inside a
five-thousand-word post are not comparable, and a blended ranking would be a number
invented to look authoritative. Results are grouped by type, ordered within a type by that
type's own ordering. The total is a SUM and is NOT deduplicated: a job and the company that
posted it are two results, because they are two things somebody might have been looking
for.

**The minimum query is two characters because SAP module codes are two letters.** FI, CO,
MM, SD, PP, QM. A floor of three would refuse the most obvious search on the site.

**Each source may fail on its own.** They run in parallel, a failure is caught per source,
and the page shows that section as unavailable while the rest stands. A search box that
goes down entirely because one table is locked is worse than an incomplete answer that says
it is incomplete — and showing nothing silently is a different claim from showing nothing
with a reason.

**`/search` is both `noindex` and disallowed in robots.txt.** A results page is infinite
crawl space, every query string a distinct URL; a meta tag only stops it being indexed
after it has already been fetched.

## The home feed

**`/` is one page for everybody, and it is the feed.** It used to be two — a landing page
for a visitor, the feed for a member — and a comparison against the reference, done logged
out, is what retired that: a marketplace that shows a stranger a page of claims while
members see the activity hides the only evidence the claims are true, from exactly the
person who needs it. The landing material survives around the feed, above and below, and
renders for nobody who is signed in.

**`services/feed.js` adds no filter of its own, for the same reason `services/search.js`
does not.** Both sources go through the same `browse` their own list pages call, so a draft
advert and a hidden post are invisible on the front page without anything in the feed
knowing why. A feed with its own WHERE clause would be a second place that has to remember
`status = 'open'` and `hidden_at IS NULL`, and the front page is the worst place to forget.
Tests create a draft job and a hidden post and assert the stranger's feed shows neither.

**Order is strictly by date and there is no cross-type score.** A job advert and a
five-hundred-word article have nothing comparable to rank against each other. The total is
a SUM over both sources and is not deduplicated — same argument as search.

**The mixed page asks each source for `offset + limit` and slices the merge.** It is the
only way two independently paginated sources interleave correctly, since neither knows how
many of the other's rows sort above it. That cost is why the feed pages in fifteens.

**The card's controls go through paths that already exist.** The upvote posts to
`/community/vote/post/:id`, the one endpoint the thread page uses, so the points ledger
keeps a single writer; the copy link is built from `appBaseUrl`, never the request; and
"reply" is a LINK to the thread's `#reply` anchor rather than a box on the card. A reply
written against 280 characters of a question is a reply written without reading it, and
duplicate answers are the one thing a question thread cannot recover from.

**"Show more" holds a longer extract, not the body.** The reference expands the whole post
inline, so every card on a fifteen-card feed ships its entire article whether or not
anybody opens it — a feed page must not grow with the length of what people wrote. The card
carries 280 characters and a 760-character extract behind a `<details>`, which is the one
expander on the site that needs no script and that the keyboard reaches unaided.

**`Post.browse` takes `viewerUserId` and uses it.** It did not, while `services/feed.js`
passed one in — the argument went nowhere and every card rendered unvoted however many
times its reader had voted. The viewer's id binds FIRST in that query, because the
`my_vote` subquery sits ahead of the WHERE clause and mysql2 fills `?` in statement order.
`countsByKind` takes no viewer at all: a count of posts by kind is the same number for
everybody, and passing one read like a feature.

**The vote route returns through `returnTo`.** Its own allow-list accepted only paths under
`/community`, so a vote cast on the home feed threw the reader onto the community index —
a page they had not asked for, having lost their place in the one they had.

**A community filter narrows the feed to posts, and the page says so.** A category belongs
to the community tree and `unanswered` to a question; neither means anything for an
advert. Inventing a mapping between the two vocabularies would be a worse answer than
admitting the filter does not apply.

## The job advert's page

**A breadcrumb, not a "Back" button.** The app sends `Referrer-Policy: no-referrer`, so the
server cannot know where somebody came from — and a button labelled "Back" that always goes
to the same place is lying about half the time. The breadcrumb says where it goes. Same
reason `res.redirect('back')` is banned.

**The application count excludes withdrawn applications.** The number answers "how much
competition is there", and somebody who pulled out is not competition: counting them
inflates it in the one direction that discourages the next reader for nothing. It is public
on purpose — a candidate deciding where to spend an evening learns something true from it,
and hiding it advantages nobody but the advertiser.

**Share links are built from `config.app.baseUrl`, never from the request.** A link
assembled from whatever host the browser used carries localhost, or a staging hostname,
into somebody's timeline, where it is wrong forever and nobody can tell why. They are plain
links: a third-party share widget would be the first script from anybody else's domain on a
page that currently loads none. The copy button is built by `public/js/main.js` from
`data-copy` — not `location.href`, which would carry whatever query string the reader
arrived with into the link they send on — and it falls back to `execCommand` because
`navigator.clipboard` needs a secure context that a plain-http deployment is not.

**"About the company" is gated on `about || website`, never on `company_type`.** That column
has a DEFAULT of `end_customer`, so every row has one and a condition including it is always
true — which rendered the heading over an empty box for a company that had filled nothing
in. A heading with nothing under it reads as a company that could not be bothered.

**`CompanyProfile.update` filters against an allowed list and drops an unknown key in
silence.** The columns are `about` and `company_size`; writing `description` and
`size_band` succeeds, changes nothing, and the page renders blank. Same shape as the
certification that asked for `name` when the model returns `label`: in this codebase a
wrong field name is not an error, it is an empty string.

## The advert's sections, and handing one over

**`config/jobSections.js` is the only list of the advert's prose, and it is asserted at
boot.** `description` was the whole advert in one box; "Responsibilities", "Requirements"
and "What we offer" are three more columns, which is three more places the text of one job
lives. That cost is only worth paying because EVERY reader of an advert reads all four from
the same list: the form builds its boxes from it, the page renders from it,
`Job.buildFilter` assembles the `q` clause from it and `utils/jobMatcher.js` builds its
haystack through `sectionText`. A section added to the schema and the form alone is the
silent failure — an advert naming EWM only under "Requirements" would score zero against an
EWM consultant, appear in no search for EWM, and nothing anywhere would say why. The list
lives in config rather than on the model because a util must not reach into a model; `Job`
re-exports it, exactly as it re-exports `ACTIVATE_PHASES`.

**The three are optional and NULL when empty.** An untouched box posts an empty string and
is stored as NULL, so "not asked" and "answered with nothing" stay the same fact in the
column — the same distinction migration 018 holds for the issue fields. An empty section
renders nothing at all, not an empty heading: same rule as "About the company".

**There is no external application URL**, and that is a refusal rather than an omission. An
advert that sends the candidate to somebody else's site has no applications here, so the
pipeline, the public application count, the withdrawn exclusion and the anchored thread all
stop working at once — and the count on the page would read zero forever while people were
applying.

**A transfer is an OFFER addressed to an email, never a link that moves anything.** The
reference emails a claim link. An advert owns applications — cover letters, day rates,
names — and a link in an inbox is an access grant to whoever that inbox forwards to. Here
nothing moves until somebody signed in at that address presses Accept.

**An advert with applications or a thread cannot be handed over at all, and the refusal
NAMES why.** This application has no notion of an organisation: two colleagues are two
unrelated company accounts whose profiles merely happen to share a name, so nothing here
can establish that the recipient works for the employer those people applied to. Moving
their applications to an account the system cannot connect to that employer is a disclosure
nobody asked them about. `JobTransfer.eligibility` is re-checked INSIDE the accepting
transaction with the advert locked, because somebody applying between the offer and the
acceptance is precisely the case the rule exists for — and there it is a refusal rather
than an inconvenience.

**The address is not resolved to an account until acceptance.** Resolving it at creation
would let any company account ask this table whether a given email has an account here, one
offer at a time. The sender is told the MECHANISM — it waits, it expires after seven days —
and never the answer for the address they typed. A notification IS sent when an account
matches; that lookup happens in the handler and nothing about its result reaches the
sender's page. A test posts to a known address and an unknown one and compares the two
sentences.

**One pending offer per advert, held by the schema.** `pending_job_id` is a generated column
that is NULL for every settled row, under a UNIQUE key — so any number of settled offers
coexist and a second live one is refused by the database. Same technique as `cert_key` in
migration 002, and for the same reason. Nothing in `job_transfers` is ever deleted: the row
is the audit trail for an advert changing hands.

**An expired offer is settled by the next person to act, not by a scheduled job.** A status
column that needs a cron to be true is wrong between runs; here `offer` expires a lapsed row
in its own transaction, which is also what makes a second offer possible, and the sender's
list computes the lapse rather than trusting the column. **The settlement after a refused
acceptance happens OUTSIDE that transaction** — writing it next to the check looks right and
is not: the throw that reports the refusal rolls the transaction back, so the row goes back
to `pending` on the way out. A test caught exactly that.

**An open advert is paused when it moves.** The public page names the company that posted
the role and renders their "About the company" box, and that sentence changing under its
readers with nobody having looked at the advert is the one thing a handover must not do
silently. A draft stays a draft — there is nothing live to take down.

**"You cannot accept your own offer" is not a CHECK**, and that is a limitation rather than
a choice: MariaDB refuses a CHECK over a column carrying an `ON DELETE SET NULL` foreign
key. It is held inside `JobTransfer.accept` with both rows locked, in the same transaction
that moves the advert, so there is no window even without a constraint behind it.

## The candidate pipeline

**One filter builder, `Application.buildFilter`, and three layouts over it.** The per-job
pipeline, the cross-job pipeline at `/applications` and the board are the same rows asked
for three ways, so a candidate hidden on one is hidden on all three. The per-job list had
its own two-line WHERE, which was fine while there was one list; the second list is where a
divergence starts, and the first thing to diverge is which rows a stage count counts.
`Application.countsFor` runs the same builder, so the number on a control counts the rows
the control opens.

**`Application.STATUSES` is derived from the state machine, and a test compares it with the
ENUM in migration 003.** It was written out by hand in the route that validates `?status=`
and again in the template that drew the tab strip — the `Job.STATUSES` problem, with the
same failure: a stage offered in a filter and rejected by the handler behind it. A unit test
also fails if a status literal reappears in `routes/applications.js`.

**Withdrawn is hidden by default and one checkbox away.** The same reading as
`countForJob`: a pipeline answers "who is in play", and somebody who pulled out is not. A
row that cannot be reached at all is a row an employer cannot work out what happened to,
so it is a toggle and never a deletion. There is no "withdrawn" tab, because a tab showing
a count the list below it is hiding is the two disagreeing in public.

**"Interviewed" reads the append-only event log, not the current status.** Somebody who
interviewed and was then turned down HAS interviewed, and that is usually the person being
looked for. A filter on `status = 'interviewing'` answers a narrower question than its own
label — and narrower in the direction that loses the rows somebody opened the filter for.

**Both sides of the state machine are declared.** `CONSULTANT_TRANSITIONS` was declared and
the employer's moves were "everything else", so an employer could move an application to
`withdrawn` — withdrawing, on somebody's behalf, the application they made. That is the one
status that means an act by the candidate, and the public application count excludes it on
exactly that reading, so an employer who can set it can quietly change what the number on
their own advert means. `Application.transitionsFor(status, { actorIsEmployer })` is what
the views ask, so a control is never offered for a move the model will refuse.

**The board has no drag-and-drop, and that is the feature.** A drop target offers every
column, including the ones `TRANSITIONS` refuses, so the gesture promises moves the server
then rejects — and a drag is a gesture the keyboard cannot make at all. Each card carries
its declared transitions as real buttons in real forms, which work with scripting off.

**The board shows the live stages only** — not `rejected`, not `withdrawn`. A closed-outcome
column only grows; within a month it is the widest thing on the screen and the live stages
are off the edge of it. Both outcomes keep their place in the list, which can filter and
page. The board cannot page — half a column is a lie about the column — so it is capped,
and when it reaches the cap it says so and points at the list.

**An empty pipeline is two different pages.** No open advert at all means there is nothing
for anybody to apply to; an open advert with no applicants is a waiting room. Telling the
first person to wait for applications is telling them to wait for something that cannot
arrive.

**Saved jobs are a consultant's shortlist.** The dashboard fetched them for every account,
so a company carried a permanently empty "Saved jobs" panel for a list it has no way of
adding to — the dashboard telling somebody they have missed a feature they do not have.

**Testing consequence:** `<% const x = typeof x !== 'undefined' ? x : false %>` in a partial
reads like a default for an optional local and is a temporal dead zone error — the
declaration shadows the local for the whole block, so `typeof` is evaluated against the
uninitialised binding and throws. `npm run validate-boot` compiles every template without
rendering one, so only an integration test that actually renders the page catches it.

## Closing an account

**`models/AccountClosure.js` is the single writer, and a closure is an ERASURE, never a
DELETE.** Deleting the user row would cascade into a points ledger that is append-only so
totals can be audited, a commission ledger recording money somebody is owed, invoices that
must not rewrite themselves, one half of conversations the other party wrote, and the
pipeline rows an employer is working from. Every one of those is a record this file has
already argued must survive its subject changing their mind.

**The page says what is kept, by name, with the reason, BEFORE the button.** A closure
screen that promises "your data will be deleted" and leaves an invoice standing is the one
version of this that is actually dishonest. `REMOVED` and `KEPT` live on the model and the
template iterates them — a list of promises maintained separately from the code that keeps
them goes on saying the old thing after the operation changes, and a test fails if either
list is retyped into the view.

**The order is other people first, identity last.** Open adverts are closed, because an
open advert on a closed account is a role nobody is hiring for and people spend evenings on
those. Live applications are withdrawn through `Application.transition`, so each one writes
its audit event and the employer watching that pipeline can see what happened. Only then is
the identity erased. A closure that erased the identity first and then failed would leave an
anonymous account still advertising.

**Votes are kept, and that is not an oversight.** An upvote was settled to the author while
it STANDS. Deleting it without settling would leave somebody holding points for a vote that
no longer exists; settling it back would take points off a third party because a second
person left. Neither is a thing a closure gets to do.

**Contributed rates are kept, because they were never identifying.** The index never shows
who gave a figure and only publishes a bucket over at least three people. Removing one
person's rows moves a published number for everybody — the same reason `voided_at` exists
and there is no "correct the value" path.

**The tombstone address is `closed-<id>@accounts.invalid`.** `.invalid` is reserved by
RFC 2606, so it can never be delivered to or mistaken for real — and writing it FREES the
member's own address, so somebody who comes back can register with it rather than finding it
taken by a row they cannot reach. The name becomes a neutral label and never the email local
part: `Conversation`'s display-name fallback exists because the reference leaked a
`firstname.lastname` prefix that way, and a closure that reintroduced it would undo that fix
for exactly the people asking to be forgotten.

**Two things block a closure, and both name what is in the way.** An administrator account
is closed by another administrator — same reasoning as the admin screens refusing to act on
your own account. An unpaid commission balance blocks it with the figure printed, because
closing removes the only page on which the person could check what they are owed.

**Sessions are not deleted.** `validateActiveAccount` rebuilds the session user from the
database on every request, so a surviving cookie is dead on its next one. Reaching into the
session store would mean matching on the shape of somebody else's serialised JSON, which
silently stops matching the day that shape changes.

**The confirmation is a PAGE, `/account-closed`, not a flash.** Closing destroys the
session and the flash queue goes with it. It repeats the kept list, because somebody who has
just pressed an irreversible button is the least likely to have read it beforehand.

**Settings LINKS to the profiles rather than duplicating them.** The reference puts company
details — phone, LinkedIn, a description — into its settings page as well as into the
company profile: two forms writing the same columns and two answers to "where do I change
this". Settings is the account; a profile is content, with its own validation and its own
completeness floor.

## The talent directory is anonymous

**Names and photographs are behind an account; everything else is not.** The consultants
most worth talking to are the ones currently working, and they are the ones with most to
lose from a public listing their employer can read. So everything that makes somebody
HIREABLE stays visible — role, modules delivered, experience, country, availability, rate —
and everything that makes them IDENTIFIABLE needs an account, which is free.

**`ConsultantProfile.redactFor` is the only place that decides, and it REDACTS rather than
filters.** The row is still counted, still ranked, still matched: a directory that hid the
people would be lying about how many are in it. It removes the name from the OBJECT rather
than leaving a template to decline to print it, because a template that declines has still
shipped the name to the browser in whatever else the page serialises — the `<title>` being
the easiest one to miss. **The default is redacted**, so a caller that forgets a viewer
breaks visibly instead of leaking.

**It covers every surface a profile reaches**: the directory, the profile page, the search
results, and `/consultants/photo/:id`, which answers the placeholder to a reader without an
account. A face identifies somebody as well as a name, and the LinkedIn identity row
carries a third copy — hiding one and serving the others is anonymity that fools only the
person relying on it. A test asserts all four.

**The delivery history is on the public profile, and its CLIENT is not.** The engagements
are the thing this site knows that a CV does not — which modules, which phase, how many
full lifecycles — and the directory's module filter and the match score both read them, so
a hirer who filtered for EWM and opened the result has to be able to see the EWM engagement
that put it there. The client is different: an employer's name beside a role, a country and
a set of dates narrows "who is this" to a handful of people and often to one, so
`redactProjectsFor` removes it by the same rule and with the same default as `redactFor`.

**An initials avatar is derived from the NAME and nothing else.** `redactFor` already
nulled it, so an anonymised card falls through to the placeholder without
`views/partials/avatar.ejs` knowing anything about anonymity — which is the whole point of
putting the decision in one place. Deriving initials from an id or an email would quietly
put the hint back. It is inline SVG: no request, no 404, and not a stored derivative that
outlives the name it was made from.

**The community block on a profile is signed-in only**, because it links to
`/community/author/:id`, which carries the name. Rendering it to a reader who may not see
the name on the profile hands it over one click later. It shows a total and a level, never
the ledger.

**Testing consequence:** the navigation prints the signed-in user's name on every page, so
a negative assertion about a name must browse as somebody else. Checking that a consultant
is ABSENT from a filtered list, while signed in as that consultant, passes from the navbar.

## The hub landings

**`/consultants` stays the directory.** The reference puts its consultant landing page
there and moves the directory to `/companies/talent`; here that would hand the single most
valuable URL on the site — what somebody types, and what other sites link to, in order to
hire an SAP consultant — to a page of prose, and bury the product behind the brochure. The
landing pages are `/consultant-hub` and `/company-hub`, which match the labels already in
the navigation. `/companies/talent` redirects to `/consultants` for anybody arriving from
the reference's shape.

**The three engagement models are a catalogue, not three pages.**
`config/engagementModels.js` owns them, asserts itself at boot, and `routes/companies.js`
BUILDS ITS ROUTES BY ITERATING IT — a route list written out beside the config is the second
copy of a vocabulary, and the failure is silent: a model renamed in one place answers 404
from the link the other place still renders. A unit test reads the route file and fails if
a slug appears in it as a literal. They are declared before `/:slug`, or a company whose
slug is "project-based" takes the page.

**No model carries a price**, asserted both in the config and in a test. `config/payments.js`
is the only module that decides what anything costs, and a figure on a page a client reads
would be a second answer about money with nothing reconciling the two.

**Each model says when it is the WRONG fit**, and the assertion requires it. A page that
only lists benefits is a sales sheet; the caveat is the one thing the reader cannot get
anywhere else.

**No landing page carries a number that moves** — no consultant count, no average rate.
Same rule as `/about`: a figure nobody owns is a figure nobody updates.

## Agencies

**The guard is `isRecruiter` from `middleware/auth.js` and nowhere else.** This is the file
that rule was written about: DynamicsHub declared a private copy inside
`routes/recruiters.js`, and it answered a background fetch with a redirect to a login page
because a route-local guard does not know about `Sec-Fetch-Dest`.

**No page render writes.** The reference's dashboard and profile handlers both do
`if (!recruiter) createForUser(...)`, so opening a page is an INSERT. A read that writes
cannot be retried safely and creates rows for anybody who merely looked; here a missing
profile renders a prompt and the POST creates it.

**Validation is applied, not declared.** The reference puts express-validator rules on the
profile route and never calls `validationResult`, so every rule is decorative and a
10,000-character agency name reaches the column. Everything goes through
`RecruiterProfile.normaliseProfile`, which is pure and tested.

**A country is refused, never truncated.** `text(input.country, 2)` turns `DEU` into `DE`
and `AUT` into `AU` — Austria silently becomes Australia. The field is bounded generously
and then pattern-checked, so a wrong value is visible instead of being wrong forever.

**Specialisms are PRODUCT LINES from `config/sapProducts.js`**, not modules and not free
text. Eight tick boxes get filled in honestly; fifty-seven do not. The directory filters
with `JSON_CONTAINS` + `JSON_QUOTE`, not a LIKE over the serialised array — `LIKE
'%s4hana%'` would match `s4hana-supply-chain` when only `s4hana-finance` was asked for.

**`CAST(? AS JSON)` is MySQL-only.** MariaDB rejects it with a parse error: its `JSON` is
an alias for LONGTEXT with a `json_valid()` CHECK and there is no JSON cast target. Bind
the serialised string directly — MySQL parses it into the column, MariaDB stores it and the
CHECK accepts it. Every read path hydrates through one `parseSpecialisms`, so no caller has
to know what the driver returned.

**An agency is hidden until its owner lists it, and listing is gated on a completeness
floor that NAMES what is missing.** "Complete your profile" with no list is the message
people bounce off.

## Stories and reviews

**A story is written by an administrator; a review is written by a member and approved
before anybody sees it.** Both are HIDDEN, never deleted. DynamicsHub's `SiteReview.delete`
is a hard DELETE reachable from a bulk action on a list view, and after it runs nobody can
say what was removed or by whom.

**Published and hidden are separate switches.** Unpublished means "not finished"; hidden
means "was live and should not be". Collapsing them loses the retraction, which is the one
somebody asks about later.

**A review requires an account, and the role beside it is DERIVED from the session.** The
reference takes a name and a role from the form, so "SAP Mentor" is a claim the page then
renders as fact. An anonymous write endpoint is also a testimonial farm with a text box:
nothing links the words to anybody who used the site. One account holds one review, and
editing it clears the approval — an approved review whose text can be swapped afterwards
is an approval that means nothing.

**A story carries NO money fields, and a test enforces it.** `gross_before`, `net_after`,
`savings_monthly` — DynamicsHub carries all of them and renders the difference as a monthly
saving, which is the refused savings calculator wearing a different hat. "We shipped in
nine weeks" is evidence; "I went from 3,400 to 5,700 a month" is a financial claim the Hub
cannot stand behind. The test scans both the schema and the normaliser for anything
saving-shaped.

**`utils/videoEmbed.js` is an allowlist, and it runs at RENDER time.** Only URL shapes it
recognises produce an embed; everything else is null, YouTube goes through the no-cookie
host, and query strings are dropped so an embed cannot inherit `?autoplay=1`. Nothing
derived is stored: a stored embed URL looks trustworthy because of a check made once, in
the past, by code that may since have changed.

**`EMBED_HOSTS` is shared between that module and the CSP in `server.js`.** A host added to
one and not the other is either an embed that is silently blocked or a policy widened for
nothing. Same reason `WEBHOOK_PATH` is shared rather than written twice, and a test pins
the exact shape.

**A draft's photo is refused, not just its page.** Otherwise an unpublished story's image
can be enumerated before the story goes live.

## The daily challenge

**The answer key never leaves this process.** `dailySetFor()` returns the full question
including `answer`; every path out of `routes/challenges.js` maps it through
`publicFormOf` first, which strips `answer` AND `explain` — an explanation names the right
option in prose, so handing it over early is handing over the key. A test asserts the
route module cannot render a raw question.

**The browser posts the options it CHOSE; the server decides the score.** There is no
`score` field and no date field to read. DynamicsHub reads `{ score, gameDate }` out of
`req.body`, writes both to a leaderboard, and ships every question with the index of its
correct answer — so anybody signed in can post a perfect score for any date, and that
output feeds a points summary. A client-authored score destroys the auditability of every
total on the site, not just the cheat's.

**The date comes from the server clock, in UTC.** One leaderboard needs one definition of
"today", or somebody in Auckland plays tomorrow's challenge before somebody in Lisbon has
finished today's.

**The daily set is derived deterministically from the date**, options included. Everybody
gets the same five in the same order, a reload does not reshuffle, and a disputed score can
be reconstructed exactly — which is what makes `Challenge.replay` possible.

**A closed attempt is re-graded on reload, not re-rendered from memory.** The reference
sends the explanations only in the response to the POST, so a refresh throws away the
reason to have played. `replay` rebuilds them from the date and the stored choices, and
compares the recomputed score with the stored one — a disagreement means the bank was
edited under a played day, and it is logged rather than hidden.

**One attempt per person per day, enforced by a unique key**, not by a check. It is also
the condition that makes showing the key safe: the answers are only ever rendered for an
attempt the database has already closed.

**`duration_ms` is stored and only ever displayed.** It is client-reported, so it is
exactly the kind of number that must not decide a position.

**Points are settled once per attempt**, keyed on the attempt, to what the grader said —
not one award per correct answer, which would be a second key scheme for the same fact.
The challenge is gated by `communityWritable` like every other write to the ledger: a gate
written into three of four write paths is a gate that is off.

**A question's `topic` is a community category slug**, product line or cross-cutting, and
the boot assertion checks it. A topic nothing else on the site knows is a dead end for
somebody told to go and read about it.

**One game, not nine.** The other eight in DynamicsHub — match, flashcard, typing, word
search, bug hunter, scenario, code quiz, streak check-in — are the same
client-authoritative shape wearing different UI; porting them would be porting the bug
eight more times. The streak is kept and DERIVED from attempt dates, rather than posted by
a check-in endpoint the browser can call as often as it likes.

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

## The auth pages

**"Remember me" lengthens THIS session's cookie and creates nothing else.** The usual shape
is a long-lived token in its own table, which is a second credential to leak, to revoke on
a password change and to expire correctly. The session already exists, the store already
has its row, and `rolling: true` already refreshes it — so the whole feature is one number
in `config/config.js`, and signing out still ends it exactly as before. It is set AFTER
`req.session.regenerate()`, or it is written onto the session being thrown away.

**The show/hide button is built by `public/js/main.js`, never rendered by the template.**
It only works with scripting, and a server-rendered control that silently does nothing is
worse than no control: the person has already decided to trust what it shows them. The
state goes on `aria-pressed` and in the label, because an icon alone does not say whether
the password is currently visible, which is the only thing the button is for.
`autocomplete` is passed per field — a browser offering the current password on a "new
password" field is how somebody sets their old one again.

**The "sign in to continue" box appears only when `?redirect=` is set**, and carries the
destination into the sign-up link beside it. A permanent version tells the person who came
here deliberately nothing they did not know, and an alternative that drops the redirect
loses the thing it just promised.

**"How did you hear about us?" is a closed list and optional.** `config/signupSources.js`
mirrors the ENUM in migration 019 and a test compares them. Eight options are answered
honestly and can be counted; a text box produces "google", "Google" and "googled it". An
unrecognised value is DROPPED in `User.create` rather than stored, because the only point
of the column is that it can be counted. It is **not** `referral_attributions`: that
records a link somebody actually followed and pays a commission on it, and an unverifiable
answer must never reach the table that decides who gets paid.

**Testing consequence:** express-session serialises `Expires` and emits no `Max-Age` at
all. A helper that reads `Max-Age` returns null for every response, and the assertion then
fails without ever having measured anything.

## LinkedIn confirmation

**LINKING ONLY. NEVER A SIGN-IN METHOD.** Both routes require an authenticated session and
there is no path here that creates an account. An OAuth provider that can also sign you in
has to decide what to do when the provider's email matches an existing account, and every
answer to that is a documented account-takeover pattern. Requiring an existing session
removes the question.

**What the badge may claim is the whole feature.** LinkedIn's userinfo response carries
`sub`, `name`, `email` and a picture — and no vanity URL, no headline, no positions, no
employer, under any scope an ordinary application can request. So the badge says exactly
one thing: this person controls a LinkedIn account, and here is the name on it. DynamicsHub
asked for a `linkedin.com/in/...` URL, ran the flow, and set `linkedin_verified` without
ever comparing the two — because there is nothing to compare. The URL stays a claim and is
labelled as one on the profile, next to the SAP Community link, which is the same kind of
claim.

**`ExternalIdentity` is the single writer of `consultant_profiles.linkedin_verified`**, and
it moves the identity row and the flag in ONE transaction, in both directions. The flag is
denormalised because five readers score or render it — the ranking expression, the
consultant card, the profile page, the settings panel and `Application.js`. That is safe
here and is not safe for a featured-job window, and the difference is why: a window
EXPIRES, so a cached boolean needs something to come round and unset it, whereas a
verification only ever changes when the member acts. `unlink` clears the flag even when
there was no identity row, because a badge outliving its proof is the one impossible
outcome.

**The name comparison is recorded, never enforced.** It is the only cross-check available,
and it is loose on purpose — a middle name, a married name, a dropped diacritic, a reversed
order. A mismatch is shown to the member and shown on the profile; refusing on it would
reject real people to catch a case a name comparison cannot catch anyway.

**Nothing from the provider is stored beyond the opaque subject, the display name and the
date.** No access token — the token is used for one request and dropped, because this
application never posts to LinkedIn and holding a credential that can act as the member
would be a liability with no purpose. No profile blob, no provider email. The table has no
column that could take one, and a test asserts that.

**`state` is the CSRF defence on a GET that arrives from a third party.** Compared in
constant time, expiring, and consumed on the way in whatever happens next — a state that
survives a failed attempt is a state that can be replayed. `req.session.save()` is awaited
explicitly before redirecting away, or the callback can arrive before the state has landed
and a legitimate flow fails as "security verification failed".

**One provider account confirms one Hub account.** A second attempt is refused rather than
moved, and the message never names the other account.

## The cookie notice, and what it is not

**It is a notice, not a consent gate, because there is nothing to refuse.** This site sets
ONE cookie — `saphub.sid`, the session — and sets it only because somebody asked to be
signed in. No analytics cookie, no advertising cookie, no third party, nothing loaded from
a tracker. A strictly necessary cookie needs DISCLOSURE, not consent, so an
"Accept all / Reject" pair would be theatre: "Reject" could not do anything that left the
site working. A button offering a choice somebody does not have is worse than no button,
and it is what trains people to click through every real one. A unit test fails if those
words appear in the code.

**The dismissal is remembered in `localStorage`, not in a cookie.** And both the read and
the write are wrapped, because private browsing throws on access — in which case the notice
appears again, which is the honest failure: we genuinely cannot tell whether that person
has read it.

**It is built by `public/js/main.js`, like the password toggle and the back-to-top button**,
so somebody who dismissed it never sees it flash on the next page. The disclosure itself
does not depend on the script: it is the Cookies section of the privacy policy, which is
server-rendered and linked from every footer. The notice links to `#cookies`, and a test
checks that anchor exists — a stale one lands somebody at the top of a long document with
complete confidence they were taken to the right place.

**Adding any other cookie changes three things at once**: that section, the notice's
wording, and the notice's nature — at that point it becomes a consent gate, because then
there would be something to refuse.

**A material change to a policy bumps its version in `config/legal-versions.js`.** The
stamp on an account records what that person was shown; leaving it alone backdates the new
text onto everybody who registered before it existed.

**The back-to-top button appears after one screenful and not before** — a button offering
to take somebody to the top of a page they have not left is noise. It is a real `<button>`
so the keyboard reaches it, it moves FOCUS to `#main` as well as the viewport (or a
keyboard user is returned to the top while their focus stays at the bottom, and the next
Tab takes them straight back down), it honours `prefers-reduced-motion`, and its scroll
listener is passive and throttled to one update a frame.

**Testing consequence:** a test that greps the source for a forbidden string also matches
the comment explaining why the string is forbidden. Strip comments before asserting — the
tempting fix is to delete the sentence.

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

**The model and the contributed index are two answers, never one.** `utils/rateBenchmark.js`
is an editorial model — a base rate per role from `config/roleTaxonomy.js`, moved by five
documented factors in `config/rateBenchmark.js` — and it exists because on day one nobody
has contributed anything and "we cannot tell you" is not a usable answer to "what is this
role worth". It is published under our own name and shown BESIDE the contributed figure,
never merged into it. The reference computes one number from a model and labels it with a
confidence level derived from however much community data happened to be nearby: that reads
as a statistical claim, is not one, and makes the figure impossible to check, because
nobody can tell which part of it came from evidence. Where the model and the evidence
disagree, the disagreement is the useful part.

**The anchor must reproduce itself.** `BASE_DAY_RATES[role]` means a senior consultant, in
the reference region, hybrid, on time-and-materials, with no certifications — so all five
multipliers at that point are exactly 1.0 and the benchmark returns the base rate
unchanged. A unit test asserts it for every role. A model whose "no adjustments" case does
not reproduce its own published figure has a constant hidden in it, and every number on the
site is wrong by that constant without one test failing.

**The benchmark prints its working, and `benchmarkProblems()` checks the working against
the answer.** Same shape as `reconciliationProblems()` in the estimator, and `routes/rates.js`
throws rather than render a result that fails it. A model that hands back only its answer
is one the reader has to trust; one that hands back the five numbers it multiplied is one
they can argue with.

**It is a GET, and nothing is stored.** The answers live in the query string, so a benchmark
is a link somebody can bookmark or send; the back button works and no scripting is needed.
Every field falls back to the anchor rather than 400ing, because people edit these URLs by
hand. Recording who asked what about their own pay would be collecting the most sensitive
thing on the site for nothing the person asking gets back. Note `Number()` and not
`parseInt` on the numeric fields: `parseInt('12; DROP TABLE')` is `12`.

**No tax, no saving, no take-home.** The model answers in euros before tax and says so on
every figure derived from it, and the billable-day divisors behind the monthly and annual
figures are printed rather than assumed. The equivalent-salary figure answers the narrower
question of what a comparable permanent role costs an EMPLOYER, and is below annual
billings because holiday, sickness and the gaps between projects are paid. Two tests — one
on the model, one on the rendered page — fail if anything saving-shaped appears. Same
refusal as the story money fields.

**`/rates/:role` is declared last**, after `/calculator` and `/submit`, or a role slug
shadows them — `/rates/submit` is a perfectly good-looking role parameter. An unknown slug
is a 404 and never a redirect to the index: these URLs are linked to from outside, and a
silent redirect turns a typo nobody notices into a page quietly answering a different
question. The sitemap generates them from `ROLE_SLUGS` rather than listing them.

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

## Development data

**`npm run seed:dev` exists and the refusal in `create-admin.js` still stands.** That
refusal is about a REAL SITE: invented day rates publish a benchmark nobody contributed to,
and invented consultant profiles are a public directory of people who do not exist. Neither
harm has anything to do with somebody walking their own laptop through the navigation — and
an empty database makes every list page, filter and aggregate untestable, because all three
are pages about rows.

So the refusal is kept where it bites, by making the seed hard to run anywhere real: it
stops on `NODE_ENV=production`, it stops when `APP_BASE_URL` is not a local address (the
stronger of the two checks — a real deployment must set it for its own links to work, while
NODE_ENV is easy to leave unset), every account it creates ends in `@seed.saphub.test`, and
`-- --remove` takes all of it out again.

**It writes through the MODELS, never SQL.** Seeding then exercises the same validation,
the same completeness scoring and the same points ledger a real sign-up does. A seed that
inserted rows directly would cheerfully create a profile the application itself would have
refused to publish, and the first person to notice would be somebody debugging why the
directory is empty.

**It seeds things that must stay INVISIBLE**: a draft advert, a closed one, and a hidden
post. A seed that only creates visible rows cannot show that the rules work, and those
three are exactly what a list view, a feed and a search page each have to exclude on their
own.

**`--volume` adds filler, and the filler says it is filler.** Both lists page in twenties,
so the hand-written set — ten adverts and six people, each written to say something — can
never show a second page. The filler carries "Seed filler" where a reader will see it,
because the one thing worse than an empty directory is a full one somebody mistakes for
real. Its module slugs come from `PRODUCT_LINES` rather than being typed, and each filler
profile gets a project and an engagement because the publishing floor would otherwise
refuse it and the seed would report success over an unchanged directory.

**It seeds one rate bucket that publishes and one that stays below the floor.** An index
that only ever shows published figures hides the behaviour that makes it trustworthy.

**Testing consequence, and it found three:** seeded data broke three assertions that were
really asserting the database was empty — a global `COUNT(*)` over `site_reviews`, a
`toHaveLength(1)` over every agency, and a "Not published" that meant "nobody has
contributed to this role". None was about the feature it sat in. Run the suite with the
seed present AND without it; a test that needs one or the other is a test with a hidden
assumption.

## Tests

**Run `npm test`, not `npx jest`.** The script sets `NODE_OPTIONS=--experimental-vm-modules`,
and pptxgenjs lazily `import()`s node built-ins from inside a CJS bundle — without the flag
every deck test fails inside Jest while the same code works perfectly from the command line.

**It sets that variable through `cross-env`, and that is not decoration.** `VAR=value cmd`
is POSIX shell syntax: on Windows, cmd and PowerShell answer `'NODE_OPTIONS' is not
recognized as an internal or external command` and the test suite cannot be run at all.
This was written in a Linux container and only found when somebody cloned it onto Windows.
Any script here that needs an environment variable sets it the same way.

`npm test` runs both suites. The integration suite needs a real MySQL 8 and SKIPS itself
without one — the decision is made in `tests/globalSetup.js`, in the parent process, and
**not** in a `beforeAll`: Jest registers every `describe` while the file is being evaluated,
so a flag set in a hook is still false when the suite decides whether to skip. The first
version of that suite reported seven skipped tests against a database that was running,
which is the worst outcome available — a green run that tested nothing.

**Never assert on a global row count.** `SELECT COUNT(*) FROM users` before and after an
action is green only while no other suite happens to write or delete one at that moment,
and Jest runs suites in parallel — so it fails the day an unrelated suite is added, with a
message blaming the feature under test. Scope the count to the rows the suite owns, or
assert the claim structurally: the LinkedIn test now reads `routes/linkedin.js` and fails
if it contains `User.create`, which proves "linking only, never a sign-in" where a count
could only sample it. Same technique as the search sources test, same trap as an unscoped
`LIMIT 1`.

**Do not close the pool in a test file.** `tests/setup.js` registers a global `afterAll`
that closes the pool and the session store, and a hook registered there runs BEFORE a
top-level hook in the test file — so a top-level `afterAll` that queries anything gets
"Pool is closed", which Jest reports as the suite failing while every test in it passed.
Clear fixtures on the way IN, which also makes a run independent of how the last one ended.
Two `afterAll`s in one file both ending the pool is the same trap one step earlier: every
test in the describe after the first one queries a closed pool, and it surfaces as a 500
from the route, which reads exactly like an application bug.

**A hard-coded hex in `public/css/style.css` fails the palette test**, which scans that
file for colours from the two reference palettes. `var(--token, #fallback)` counts: the
fallback is a literal in the file. The tokens at `:root` are set unconditionally, so there
is nothing to fall back from.

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
