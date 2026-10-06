'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bodyParser = require('body-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const flash = require('connect-flash');

const config = require('./config/config');
const { pool, promisePool } = require('./config/database');
const { assertTaxonomyIntegrity, roleLabel } = require('./config/roleTaxonomy');
const { countryName, locationLabel } = require('./utils/geo');
const { assertCatalogueIntegrity, moduleLabel, lineLabel } = require('./config/sapProducts');
const { assertCertificationIntegrity } = require('./config/certifications');
const { assertSettingsIntegrity } = require('./config/settings');
const { assertEstimationIntegrity } = require('./config/estimation');
const { assertCommunityIntegrity } = require('./config/community');
const { assertPaymentIntegrity, WEBHOOK_PATH } = require('./config/payments');
const assistantConfig = require('./config/assistant');
const { assertReferralIntegrity } = require('./config/referrals');
const linkedinConfig = require('./config/linkedin');
const { assertLinkedInIntegrity } = linkedinConfig;
const { EMBED_HOSTS } = require('./utils/videoEmbed');
const { assertChallengeIntegrity } = require('./config/challenges');
const { assertSocialIntegrity, socialLinks } = require('./config/social');
const { assertBenchmarkIntegrity } = require('./config/rateBenchmark');
const { assertEngagementIntegrity } = require('./config/engagementModels');
const { assertJobSectionsIntegrity } = require('./config/jobSections');
const { assertCrmIntegrity } = require('./config/crm');
const { assertDraftingIntegrity } = require('./config/drafting');
const { assertTaxAdvisoryIntegrity } = require('./config/taxAdvisory');
const { assertRateBoundsIntegrity } = require('./config/rateBounds');
const { pendingMigrations } = require('./scripts/migrate');
const { seoLocals } = require('./config/seoMeta');
const AppSetting = require('./models/AppSetting');
const { validateActiveAccount } = require('./middleware/auth');
const { csrfProtection } = require('./middleware/csrf');
const { captureReferralCode } = require('./middleware/referral');
const { notFound, errorHandler, asyncHandler } = require('./middleware/errorHandler');
const { visitGeo } = require('./middleware/visitGeo');
const { sanitizeRichText, toPlainText, jsonForScript } = require('./utils/sanitize');

/*
 * Fail fast rather than degrade silently.
 *
 * Every assertion below guards a failure mode that produces WRONG OUTPUT rather than an
 * error: a role with no base day rate flattens a whole rate bucket, a module depending on
 * one that does not exist drops effort out of an estimate, an alias claimed by two roles
 * turns a match score into noise, a certification code carrying a year suffix goes stale
 * within twelve months. None of them crashes anything. All of them are cheap to check at
 * the one moment somebody is watching the log.
 */
assertTaxonomyIntegrity();
assertCatalogueIntegrity();
assertCertificationIntegrity();
assertSettingsIntegrity();
/*
 * And the estimator: phase or resource percentages that do not sum to 100 shift every
 * estimate by a silent few per cent instead of failing visibly, and a phase table that has
 * drifted from SAP Activate's phases means a quote and a job advert use the same word for
 * different things.
 */
assertEstimationIntegrity();
// And the community: a duplicate category slug collides on a unique key at sync time, and
// a level band that does not start above the one below it makes `levelFor` return the
// wrong title for everybody in it.
assertCommunityIntegrity();
// And money: a product with no resolver, a non-integer price or a deposit floor above its
// own cap is a silently wrong charge rather than a visible failure.
assertPaymentIntegrity();
/*
 * And the assistant: a token price of zero makes every call free, so the spend
 * circuit-breaker never trips and the first anybody hears of it is the invoice. An effort
 * level the API does not accept is a 400 on every request, which this endpoint's own error
 * path turns into "please try again in a moment" forever.
 */
assistantConfig.assertAssistantIntegrity();
/*
 * And the referral scheme: a rate above its own ceiling, or a payout floor no commission
 * could ever reach, does not fail at request time — it fails as a person asking why they
 * have not been paid.
 */
assertReferralIntegrity();
/*
 * And LinkedIn: one credential set without the other is worse than neither, because the
 * button appears, the member is sent to LinkedIn, and the failure lands after they have
 * already granted access.
 */
assertLinkedInIntegrity();
/*
 * And the challenge bank: a question whose answer index is outside its own options, or a
 * bank smaller than a day's set, is a quiz nobody can win — and it fails at the moment
 * somebody plays rather than at the moment somebody could fix it.
 */
assertChallengeIntegrity();
/*
 * And the Hub's own social accounts: a link whose host carries a typo looks right in a
 * diff and is wrong on every page of the site until somebody outside reports it.
 */
assertSocialIntegrity();
/*
 * And the day-rate model: a role missing from the base table benchmarks everybody who
 * picks it at a fallback, a country claimed by two regions takes whichever was written
 * first, and a band table whose anchor is not 1.0 moves every figure on the site by a
 * constant nobody can see. None of the three raises an error on its own.
 */
assertBenchmarkIntegrity();
/*
 * And the engagement models: a slug that does not match its route renders the page
 * under the wrong heading, a missing field renders as a blank bullet, and a price that
 * drifted onto one of them is a second answer about money in front of a client. All
 * three are wrong pages rather than errors.
 */
assertEngagementIntegrity();

/*
 * And the advert's sections. A key here that is not a real column contributes an empty
 * string to every match haystack and every search clause built from the list, so matching
 * gets quietly worse and no page breaks — which is the shape every assertion in this block
 * exists for.
 */
assertJobSectionsIntegrity();

/*
 * And the CRM's own vocabulary. Two of the things this one checks are about somebody's
 * right to be left alone — that `unsubscribed` is terminal, and that every live status can
 * reach it in one step — which is the one thing on that screen that cannot be fixed after
 * the fact.
 */
assertCrmIntegrity();

/*
 * And the drafting model's prices. The failure this one is for is changing the model
 * without changing the prices beside it: the breaker then charges the old rate against the
 * new model, and the first anybody hears of it is the invoice.
 */
assertDraftingIntegrity();

/*
 * And the tax advisory catalogue. Two of its checks are about the refusal rather than the
 * vocabulary: a page that quietly lost the sentence saying it does not calculate a saving
 * is a page making a different promise from the one this feature was allowed to exist
 * under.
 */
assertTaxAdvisoryIntegrity();

/*
 * And the bounds a contributed rate has to fall inside. Every failure here publishes a
 * wrong number instead of raising one: a floor of zero accepts the 5 EUR/day a QA pass
 * actually got stored, and a published percentile is read by somebody deciding what to
 * ask for. The two ranges are also checked for overlap, because that is what lets a
 * mis-picked engagement type be refused rather than averaged in.
 */
assertRateBoundsIntegrity();

/*
 * The support address is the one setting a developer never notices is unset, because the
 * page renders perfectly with it. Production refuses to boot on the placeholder; here it
 * says so once, loudly, every time the server starts — it has now been reported twice from
 * a running install, which is what a silent default buys you.
 */
if (!config.isProduction && config.app.supportEmail === 'support@example.com') {
  console.warn('  SUPPORT_EMAIL is still the example value, and it is printed on /contact');
  console.warn('  and in the footer. Set it in .env. Production refuses to start on it.\n');
}
// Read once. These come from the environment and cannot change while the process runs.
const SOCIAL_LINKS = socialLinks();

const app = express();

if (config.isProduction) {
  // Required for `req.ip` to be the client rather than the load balancer, which is what
  // every IP-keyed rate limiter depends on.
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('x-powered-by', false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is required by the per-page vanilla-JS islands in the views.
        // 'unsafe-eval' is deliberately NOT allowed: no client code may use eval or
        // new Function, and adding a library that needs it is a decision, not an oversight.
        // No CDN is allowed at all: every script, style and font is served from this
        // origin. Adding a host back here means adding a third party to every page.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        /*
         * The two video hosts a success story may embed, and they come from the ONE
         * module that can build an embed URL — so the policy and the allowlist cannot
         * drift apart. The same reason WEBHOOK_PATH is shared between here and
         * config/payments.js rather than written out twice. A test asserts this exact
         * shape, because a host added to utils/videoEmbed.js and not here produces an
         * embed that is silently blocked, and one added here and not there widens the
         * policy for nothing.
         */
        frameSrc: ["'self'", ...EMBED_HOSTS],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    // No referrer at all. CONSEQUENCE, and it is load-bearing: `req.get('Referer')` is
    // empty on real browser POSTs, so "go back to where you came from" must use an
    // explicit allow-listed hidden field, never Referer sniffing. See utils/returnTo.js.
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false
  })
);

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()');
  next();
});

app.use(morgan(config.isProduction ? 'combined' : 'dev'));

/*
 * The Stripe webhook needs the RAW bytes, and it needs them BEFORE any JSON parser sees
 * the stream. Stripe's signature covers exactly what it sent; a body that has been parsed
 * and re-serialised will not verify, however identical it looks.
 *
 * Mounting the raw parser first also disarms the JSON parser below for this one path:
 * body-parser marks the request as read and every later parser skips it.
 */
app.use(WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }));

// 5 MB rather than the 100 kB default: long rich-text bodies were being rejected with a
// bare 413 that gave the author no way to recover their draft.
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(bodyParser.json({ limit: '5mb' }));

/*
 * Bootstrap, Bootstrap Icons and Inter are served from node_modules rather than a CDN.
 *
 * A CDN adds a third party to every page load: the app stops working behind a corporate
 * proxy that blocks it, the version can move under you, and the CSP has to allow a host
 * that also serves everybody else's code. Serving the pinned files from the same origin
 * removes all three, and the icon font resolves relative to its own stylesheet so it comes
 * along without extra configuration.
 */
app.use(
  '/vendor/bootstrap',
  express.static(path.join(__dirname, 'node_modules', 'bootstrap', 'dist'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);
app.use(
  '/vendor/inter',
  express.static(path.join(__dirname, 'node_modules', '@fontsource', 'inter'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);
app.use(
  '/vendor/bootstrap-icons',
  express.static(path.join(__dirname, 'node_modules', 'bootstrap-icons', 'font'), {
    maxAge: '30d',
    immutable: config.isProduction
  })
);

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true
  })
);

const sessionStore = new MySQLStore(
  {
    // The table is created by a migration, not by the store, so the whole schema stays
    // under migration control.
    createDatabaseTable: false,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: config.session.cookie.maxAge,
    schema: {
      tableName: 'sessions',
      columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' }
    }
  },
  pool
);

app.use(
  session({
    key: 'saphub.sid',
    secret: config.session.secret,
    store: sessionStore,
    resave: config.session.resave,
    saveUninitialized: config.session.saveUninitialized,
    rolling: config.session.rolling,
    cookie: config.session.cookie
  })
);

app.use(flash());
/*
 * The webhook is the one exempt route, and it is exempt THROUGH the predicate rather than
 * by being mounted outside the middleware — which is the difference between a documented
 * hole and an accidental one. It authenticates itself with a Stripe signature over the raw
 * body, a stronger check than a token it could not carry anyway: it has no browser, no
 * session and no page to read one from.
 */
app.use(csrfProtection({ exempt: (req) => req.path === WEBHOOK_PATH }));
app.use(validateActiveAccount);
/*
 * A referral link can point at any page, so the code is captured on every request rather
 * than only on the registration form. It writes to the session and nothing else; see
 * middleware/referral.js for why the session is read before the posted field.
 */
app.use(captureReferralCode);
app.use(visitGeo);
app.use(seoLocals);

/*
 * The site-wide notice.
 *
 * Read from a process cache, not the database, on all but roughly one request a minute —
 * a banner nobody has set must not cost a query per page. `AppSetting.all()` falls back to
 * the declared defaults rather than throwing, so a settings table that is briefly
 * unreadable cannot take down every page on the site.
 */
app.use(
  asyncHandler(async (req, res, next) => {
    res.locals.siteNotice = await AppSetting.get('site_notice');
    next();
  })
);

// Locals every template can rely on.
app.use((req, res, next) => {
  res.locals.appName = config.app.name;
  /*
   * The widget is rendered only where the feature is actually configured. A launcher that
   * opens a panel which answers 503 advertises something the deployment does not have.
   */
  res.locals.assistantReady = assistantConfig.isConfigured();
  res.locals.assistantMaxChars = assistantConfig.MAX_MESSAGE_CHARS;
  // Same rule as the assistant widget: a button that leads to "not switched on here" is
  // worse than no button.
  res.locals.linkedinReady = linkedinConfig.isConfigured();
  res.locals.supportEmail = config.app.supportEmail;
  /*
   * The canonical base, for the share and copy links a template builds. Never the request's
   * host: a link assembled from whatever the browser used carries localhost, or a staging
   * hostname, into whatever somebody pastes it into.
   */
  res.locals.appBaseUrl = config.app.baseUrl;
  res.locals.socialLinks = SOCIAL_LINKS;
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.flash = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  res.locals.sanitizeRichText = sanitizeRichText;
  res.locals.toPlainText = toPlainText;
  res.locals.jsonForScript = jsonForScript;
  res.locals.countryName = countryName;
  res.locals.locationLabel = locationLabel;
  res.locals.roleLabel = roleLabel;
  res.locals.moduleLabel = moduleLabel;
  res.locals.lineLabel = lineLabel;
  next();
});

app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/profile', require('./routes/profile'));
app.use('/consultants', require('./routes/consultants'));
app.use('/companies', require('./routes/companies'));
app.use('/jobs', require('./routes/jobs'));
app.use('/applications', require('./routes/applications'));
app.use('/crm', require('./routes/crm'));
app.use('/quotes', require('./routes/quotes'));
app.use('/community', require('./routes/community'));
app.use('/payments', require('./routes/payments'));
app.use('/messages', require('./routes/messages'));
app.use('/rates', require('./routes/rates'));
app.use('/notifications', require('./routes/notifications'));
app.use('/admin', require('./routes/admin'));
app.use('/assistant', require('./routes/assistant'));
app.use('/referrals', require('./routes/referrals'));
app.use('/linkedin', require('./routes/linkedin'));
app.use('/search', require('./routes/search'));
app.use('/recruiters', require('./routes/recruiters'));
app.use('/success-stories', require('./routes/stories'));
app.use('/challenges', require('./routes/challenges'));

app.use(notFound);
app.use(errorHandler);

/**
 * Refuse to serve a database the code has outgrown.
 *
 * `npm start` migrates before it starts. `npm run dev` does not, and the failure that
 * produces is the worst-shaped one available: every page that touches a new column answers
 * 500, and the stack trace says `Unknown column 'j.admin_hidden_at'` — which reads like a
 * bug in the query rather than a migration nobody ran. A QA pass lost most of a day of the
 * company role to it, found it in the stack traces, and could not delete its own test
 * advert because the page carrying the delete button was one of the broken ones.
 *
 * So it is checked once, at the one moment somebody is watching the log, and it NAMES the
 * files and the command. Production refuses outright: serving a schema that does not match
 * the code is how a write lands in a column that means something else. Development warns
 * and continues, because a half-migrated database is sometimes exactly what somebody is
 * in the middle of fixing.
 *
 * Same argument as `scripts/migrate.js` refusing a database with tables and no history:
 * the bare error it would otherwise produce describes the symptom and hides the cause.
 */
async function checkSchemaIsCurrent() {
  let pending;
  try {
    pending = await pendingMigrations(promisePool);
  } catch (err) {
    console.error(`\n  Could not check for pending migrations: ${err.message}`);
    console.error('  The database may be unreachable. Pages that read it will fail.\n');
    return;
  }
  if (!pending.length) return;

  const list = pending.map((f) => `    - ${f}`).join('\n');
  const message = `${pending.length} migration(s) have not been applied:\n${list}\n`
    + '  Run "npm run migrate". Until then every page reading a new column answers 500.';

  if (config.isProduction) {
    console.error(`\n  REFUSING TO START. ${message}\n`);
    process.exit(1);
  }
  console.warn(`\n  ${message}\n`);
}

if (require.main === module) {
  // Awaited, so a production refusal happens before the port is bound rather than after.
  checkSchemaIsCurrent().then(() => {
  const server = app.listen(config.app.port, () => {
    console.log(`${config.app.name} listening on port ${config.app.port} (${config.env})`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => {
      pool.end(() => process.exit(0));
    });
    // Do not wait forever for a hung connection to drain.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  });
}

/*
 * The session store is exported so tests can close it.
 *
 * `express-mysql-session` runs an expiry sweep on a timer, and a timer is a handle that
 * keeps Node alive: without this, every test run ended in "Jest did not exit one second
 * after the test run has completed" and needed --forceExit, which would also have hidden a
 * real leak the day one appeared.
 */
module.exports = app;
module.exports.sessionStore = sessionStore;
