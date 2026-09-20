# SAP Hub

A marketplace for the SAP consulting ecosystem: a job board, a talent directory, and a
day-rate index built from figures contributed by the people doing the work.

Server-rendered Express + EJS on MySQL 8. No SPA, no ORM, no build step for server code.

---

## What is here

| Area | State |
|---|---|
| Accounts, multi-role model, email verification, password reset | built |
| Consultant profiles: skills, coded certifications, experience, photo, completeness gate | built |
| Delivery history: engagements, the modules each touched, SAP Activate phase, full lifecycles | built |
| Company profiles, logo, public directory | built |
| Job board: post, edit, publish/pause/close, bulk actions with an interlock | built |
| Module and phase filters on both the job board and the talent directory | built |
| Applications: apply, employer pipeline, state machine, audit trail | built |
| Match scoring between a consultant and a role, with a visible breakdown | built |
| Day-rate index with an n≥3 privacy floor, percentiles and a trend | built |
| Notifications, saved jobs, dashboards | built |
| Messaging: threads anchored to an application or a role, unread counts, notifications | built |
| Scope estimator: transition approach, clean core, cross-module boundaries, SAP Activate phases | built |
| Quotes: stored breakdown, lifecycle with an audit trail, stale-catalogue flagging | built |
| Deliverables: SOW (.docx), work breakdown with a Gantt (.xlsx), summary deck (.pptx), zipped | built |
| SEO: canonicals, JobPosting JSON-LD, sitemap generated from the robots allowlist | built |

Not built yet, and listed so nobody mistakes the scope: community, payments, the in-site
assistant, admin, referrals, LinkedIn confirmation, search, recruiters, the sales CRM and
finance. See
[`docs/PORT-PLAN.md`](docs/PORT-PLAN.md), which says for each one what it will and will not
carry over.

Deliberately not built at all: a tax savings calculator, browser-scored games, uploaded
document templates, and any path that sends a message to a sales lead on its own. The
reasons are in the port plan and each is pinned by a rule in
[`CLAUDE.md`](CLAUDE.md).

---

## What makes this an SAP marketplace rather than a renamed one

Four things have no counterpart in the reference implementations and were built rather than
adapted:

1. **The product catalogue** — `config/sapProducts.js`, 8 product lines and 57 modules,
   with effort baselines sized for ERP rather than CRM. An S/4HANA finance core is 60
   consultant-days of foundation; the reference's largest is 20.
2. **Cross-module dependencies** — SD without MM is not a smaller project, it is an
   integration problem, and the estimator has to charge for the boundary.
3. **The role taxonomy** — 53 roles whose aliases carry the module codes (FI, CO, MM, SD,
   PP, EWM) and the legacy names (WM, APO, Hybris). Matched on word boundaries, because
   `includes('mm')` matches "committed".
4. **The palette** — SAP's own blue `#0070F2` measures 4.57:1 on white and is therefore the
   accent, not the button. `#0064D9` at 5.49:1 carries the interactions. Measured, and
   pinned by a test.

And two things the ecosystem has that neither reference does: **delivered modules are not
claimed skills** — the module filter and the module term in the match score both read the
delivery history, because anybody can tick EWM on a skills list — and **the transition
approach**, greenfield or brownfield or selective, which the estimator asks first because it
moves the number more than anything else on the form.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 18, CommonJS, no transpilation |
| HTTP | Express 4, `express-session` with a MySQL store |
| Views | EJS, server-rendered; Bootstrap 5 served from this origin plus a hand-written design system |
| Data | MySQL 8 via `mysql2`. **No ORM** — every model is a class of static methods issuing parameterised SQL |
| Schema | Forward-only numbered `.sql` migrations, applied by `scripts/migrate.js` under an advisory lock |
| Auth | First-party email + password, `bcryptjs`, server-side sessions. No OAuth, no JWT |
| Validation | `express-validator` on the server is authoritative; HTML5 attributes are hints only |
| Uploads | `multer` in memory, re-encoded by `sharp`, stored as `MEDIUMBLOB` in MySQL |
| Documents | `docx`, `exceljs`, `pptxgenjs`, zipped with `archiver`. Generated on demand, never stored, and every one is opened and parsed before it is served |
| Tests | Jest + supertest. The integration suite needs a real database and skips itself without one |

No CDN. Bootstrap, Bootstrap Icons and Inter are served from this origin, and the
Content-Security-Policy allows no third-party host.

---

## Running it

```bash
npm install
cp .env.example .env          # then edit DB_* and SESSION_SECRET
npm run db:create             # creates the database if it does not exist
npm run migrate               # applies every migration from empty
npm run sync:catalogues       # seeds the skills table from the module catalogue
npm run create-admin -- you@example.com "Your Name"
npm run dev
```

`npm start` runs the migrations and the catalogue sync before it listens, so a deploy is
one command.

### Checks

```bash
npm run validate-boot   # loads every module, compiles every template, measures the palette
npm run lint
npm test                # unit always; integration only with a database
                        # use the script, not `npx jest` — it sets the flag pptxgenjs needs
```

`validate-boot` needs no database and is the one to run before pushing.

---

## Layout

```
config/        catalogues and environment. Each asserts its own integrity at boot.
middleware/    auth guards, CSRF, rate limits, uploads, error handling
models/        one class per table group, static methods, parameterised SQL, no ORM
routes/        one router per area, mounted in server.js
utils/         pure helpers — matching, aggregation, contrast, LIKE escaping
views/         EJS, with partials/ holding the shared components
scripts/       migrations and the operational scripts
docs/          the port plan
```

`CLAUDE.md` is the operational reference: the rules that are not obvious from the code, each
one there because getting it wrong produced a real bug. `DESIGN.md` is the same for anything
user-facing. Read both before changing either.
