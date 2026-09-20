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

`npm test` runs both suites. The integration suite needs a real MySQL 8 and SKIPS itself
without one — the decision is made in `tests/globalSetup.js`, in the parent process, and
**not** in a `beforeAll`: Jest registers every `describe` while the file is being evaluated,
so a flag set in a hook is still false when the suite decides whether to skip. The first
version of that suite reported seven skipped tests against a database that was running,
which is the worst outcome available — a green run that tested nothing.

Run against a real database before believing anything about SQL. Salesforce Hub's port plan
ends with three bugs that were green under mocks: an alias colliding with a real column
under `only_full_group_by`, a test whose source was unmocked and unreachable, and a DATE
compared as a string because `mysql2` returns it as a JS `Date`.

## What is deliberately not here

See `docs/PORT-PLAN.md` for the full ledger. The refusals that must not quietly arrive
later: a tax savings calculator, browser-scored games, uploaded document templates, and any
path that sends a message to a sales lead without a person pressing send.
