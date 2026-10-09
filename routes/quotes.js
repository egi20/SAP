'use strict';

const { weekRange } = require('../utils/weekRange');

const express = require('express');
const { body, validationResult } = require('express-validator');

const Quote = require('../models/Quote');
const { isAuthenticated, isEmailVerified } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');
const { calculateEstimation, reconciliationProblems } = require('../utils/sapEstimation');
const {
  ADDON_SOLUTIONS,
  TRANSITION_APPROACHES,
  CLEAN_CORE_LEVELS,
  COMPLEXITY_MULTIPLIERS,
  INDUSTRY_MULTIPLIERS,
  COMPANY_SIZE_MULTIPLIERS,
  catalogueVersion
} = require('../config/estimation');
const { PRODUCT_LINES, isModule, lineByValue } = require('../config/sapProducts');
const { sanitizeRichText } = require('../utils/sanitize');
const { depositForTotal, formatMinor, DEPOSIT_PERCENT } = require('../config/payments');
const Payment = require('../models/Payment');
const { returnTo } = require('../utils/returnTo');
const {
  DOCUMENT_KINDS,
  PACKAGE_KIND,
  isDocumentKind,
  generateDocument,
  generatePackage
} = require('../services/quotePackage');

const router = express.Router();

const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'];

router.use(isAuthenticated);

/** Everything the catalogue pickers need, in one place so three handlers cannot drift. */
function catalogueLocals() {
  return {
    productLines: PRODUCT_LINES,
    addons: ADDON_SOLUTIONS,
    transitionApproaches: TRANSITION_APPROACHES,
    cleanCoreLevels: CLEAN_CORE_LEVELS,
    complexityLevels: COMPLEXITY_MULTIPLIERS,
    industries: Object.keys(INDUSTRY_MULTIPLIERS),
    companySizes: Object.keys(COMPANY_SIZE_MULTIPLIERS)
  };
}

/**
 * Turn the posted form into engine inputs.
 *
 * Everything the client can send is filtered against the catalogue here, so an unknown
 * slug is dropped rather than silently costed at a default. Free text survives as free
 * text and is costed explicitly as unmapped scope — costing it at zero is how a quote
 * becomes an argument later.
 */
function inputsFrom(form) {
  const asArray = (value) => (Array.isArray(value) ? value : [value].filter(Boolean));

  return {
    selectedLines: asArray(form.lines).filter((slug) => Boolean(lineByValue(slug))),
    selectedModules: asArray(form.modules).filter(isModule),
    selectedAddons: asArray(form.addons).filter((id) =>
      Object.prototype.hasOwnProperty.call(ADDON_SOLUTIONS, id)
    ),
    transitionApproach: TRANSITION_APPROACHES[form.transition_approach] ? form.transition_approach : 'greenfield',
    cleanCoreLevel: CLEAN_CORE_LEVELS[form.clean_core_level] ? form.clean_core_level : 'moderate',
    complexity: COMPLEXITY_MULTIPLIERS[form.complexity] ? form.complexity : 'moderate',
    clientIndustry: INDUSTRY_MULTIPLIERS[form.client_industry] ? form.client_industry : '',
    companySize: COMPANY_SIZE_MULTIPLIERS[form.company_size] ? form.company_size : '',
    numberOfUsers: form.number_of_users,
    numberOfCompanyCodes: form.number_of_company_codes,
    numberOfCountries: form.number_of_countries,
    numberOfIntegrations: form.number_of_integrations,
    integrationComplexity: ['simple', 'medium', 'complex'].includes(form.integration_complexity)
      ? form.integration_complexity
      : 'medium',
    includeTraining: form.include_training === 'on',
    includeRun: form.include_run === 'on',
    otherModules: String(form.other_modules || '').slice(0, 1000),
    otherAddons: String(form.other_addons || '').slice(0, 1000),
    otherIntegrations: String(form.other_integrations || '').slice(0, 1000)
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = QUOTE_STATUSES.includes(req.query.status) ? req.query.status : '';
    const approach = TRANSITION_APPROACHES[req.query.approach] ? req.query.approach : '';
    const { page, perPage, limit, offset } = paginationFrom(req.query);

    const [{ rows, total }, stats] = await Promise.all([
      Quote.listForOwner(req.session.user.id, { status, approach, limit, offset }),
      Quote.statsForOwner(req.session.user.id)
    ]);

    res.render('quotes/index', {
      title: 'Estimates',
      quotes: rows,
      stats,
      status,
      approach,
      statuses: QUOTE_STATUSES,
      transitionApproaches: TRANSITION_APPROACHES,
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/quotes', req.query, p)
    });
  })
);

// Declared before `/:reference` so "new" is never read as a quote reference.
router.get(
  '/new',
  isEmailVerified,
  asyncHandler(async (req, res) => {
    // Pre-fill nothing from the authoring company: the client is the subject of the quote,
    // and defaulting their name to the author's own company is a confusing wrong answer.
    res.render('quotes/new', {
      title: 'New estimate',
      ...catalogueLocals(),
      values: {
        include_training: 'on',
        include_run: 'on',
        number_of_users: 50,
        number_of_company_codes: 1,
        number_of_countries: 1,
        transition_approach: 'greenfield',
        clean_core_level: 'moderate',
        contingency_percentage: 15
      },
      errors: []
    });
  })
);

const quoteValidators = [
  body('client_company')
    .trim()
    .isLength({ min: 2, max: 200 })
    .withMessage('Who is this estimate for? Enter the client company.'),
  body('client_name').trim().isLength({ min: 2, max: 200 }).withMessage('Enter a contact name.'),
  body('client_email').optional({ checkFalsy: true }).isEmail().withMessage('That contact email is not valid.'),
  body('project_name').trim().isLength({ min: 3, max: 200 }).withMessage('Give the project a name.'),
  body('number_of_users').optional({ checkFalsy: true }).isInt({ min: 1, max: 1000000 }),
  body('number_of_company_codes').optional({ checkFalsy: true }).isInt({ min: 1, max: 500 }),
  body('number_of_countries').optional({ checkFalsy: true }).isInt({ min: 1, max: 100 }),
  body('number_of_integrations').optional({ checkFalsy: true }).isInt({ min: 0, max: 200 })
];

router.post(
  '/',
  isEmailVerified,
  writeLimiter,
  quoteValidators,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);

    const inputs = inputsFrom(req.body);
    const nothingSelected =
      inputs.selectedLines.length === 0 &&
      inputs.selectedModules.length === 0 &&
      inputs.selectedAddons.length === 0 &&
      !inputs.otherModules.trim();

    const problems = errors.array();
    if (nothingSelected) {
      problems.push({ msg: 'Choose at least one product line, module or add-on — an estimate needs a scope.' });
    }

    if (problems.length) {
      return res.status(422).render('quotes/new', {
        title: 'New estimate',
        ...catalogueLocals(),
        values: req.body,
        errors: problems
      });
    }

    const estimate = calculateEstimation(inputs, {
      contingencyPercentage: Math.max(0, Math.min(50, parseInt(req.body.contingency_percentage, 10) || 15)),
      currency: /^[A-Z]{3}$/.test(req.body.currency || '') ? req.body.currency : 'EUR'
    });

    // An estimate whose own parts do not add up must never be shown to a client. This is
    // the guard that makes the invariants in utils/sapEstimation.js real rather than
    // aspirational: a failure here is a bug in the engine, not user error.
    const mismatches = reconciliationProblems(estimate);
    if (mismatches.length) {
      const err = new Error(`Estimate failed its own reconciliation checks: ${mismatches.join('; ')}`);
      err.status = 500;
      throw err;
    }

    const quote = await Quote.create(req.session.user.id, {
      client: {
        name: req.body.client_name.trim(),
        company: req.body.client_company.trim(),
        email: req.body.client_email || null,
        industry: inputs.clientIndustry || null,
        size: inputs.companySize || null
      },
      project: {
        name: req.body.project_name.trim(),
        summary: sanitizeRichText(req.body.project_summary || '')
      },
      inputs,
      estimate,
      catalogueVersion: catalogueVersion()
    });

    req.flash('success', `Estimate ${quote.reference} saved.`);
    return res.redirect(`/quotes/${quote.reference}`);
  })
);

/**
 * One quote.
 *
 * Read by reference rather than by id: it is the string the client was given, it is what
 * somebody pastes back, and it does not enumerate.
 */
router.get(
  '/:reference',
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(String(req.params.reference).toUpperCase());
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const [events, modules, downloads, deposit] = await Promise.all([
      Quote.events(quote.id),
      Quote.modulesFor(quote.id),
      Quote.downloads(quote.id, { limit: 10 }),
      Payment.depositForQuote(quote.id)
    ]);

    // Priced from the quote's OWN stored total, never from today's catalogue — the same
    // rule the estimate itself follows. `basis` says which rule set the amount, because on
    // an SAP-sized total it is almost always the cap rather than the percentage.
    const depositQuote = quote.status === 'accepted' && !deposit ? depositForTotal(quote.total_budget) : null;

    /*
     * A quote priced under an older catalogue is FLAGGED, not silently re-priced.
     *
     * The stored breakdown is what was said to the client on a date. Recomputing it now
     * would quietly change history the moment somebody edits a base effort. So the page
     * says the basis has moved and leaves the figures alone.
     */
    const stale = quote.catalogue_version !== catalogueVersion();

    return res.render('quotes/show', {
      title: `${quote.reference} — ${quote.project_name}`,
      weekRange,
      quote,
      estimate: quote.estimate,
      modules,
      events,
      stale,
      downloads,
      deposit,
      depositQuote,
      depositPercent: DEPOSIT_PERCENT,
      formatMinor,
      documentKinds: DOCUMENT_KINDS,
      currentCatalogue: catalogueVersion(),
      transitionApproaches: TRANSITION_APPROACHES,
      allowedTransitions: Quote.TRANSITIONS[quote.status] || []
    });
  })
);

/**
 * Produce a deliverable from a stored quote.
 *
 * Documents are generated on demand rather than stored, because storing them would mean two
 * sources of truth for the same figures. Each generator opens and parses its own output
 * before returning it, so a file that cannot be opened never reaches the response.
 *
 * Declared before `/:reference/status` only for readability; Express matches on the path, so
 * the order of these two does not matter — unlike `/new`, which genuinely must precede
 * `/:reference`.
 */
router.get(
  '/:reference/download/:kind',
  isEmailVerified,
  asyncHandler(async (req, res) => {
    const kind = String(req.params.kind);
    if (kind !== PACKAGE_KIND && !isDocumentKind(kind)) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const quote = await Quote.findByReference(String(req.params.reference).toUpperCase());
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    /*
     * Company branding is a later area, so nothing is passed. When it lands it is READ from
     * the owner's stored template here — never taken from the request, which would let the
     * colour of a client-facing document be set by whoever crafted the URL.
     */
    const branding = null;

    const document =
      kind === PACKAGE_KIND ? await generatePackage(quote, branding) : await generateDocument(quote, kind, branding);

    // Fire and forget: the audit row must not stand between somebody and their document.
    Quote.recordDownload(quote.id, req.session.user.id, kind, quote.catalogue_version, document.buffer.length);

    res.setHeader('Content-Type', document.contentType);
    // The filename is slugified, so it can carry no quote, slash or newline into the header.
    res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
    res.setHeader('Content-Length', document.buffer.length);
    // A document is built from a stored estimate that can be superseded; never cache it.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(document.buffer);
  })
);

router.post(
  '/:reference/status',
  isEmailVerified,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(String(req.params.reference).toUpperCase());
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    try {
      await Quote.transition(quote.id, req.session.user.id, req.body.status, {
        note: req.body.note ? String(req.body.note).slice(0, 500) : null
      });
      req.flash('success', `Estimate ${quote.reference} is now ${req.body.status}.`);
    } catch (err) {
      if (!['INVALID_TRANSITION', 'FORBIDDEN', 'NOT_FOUND'].includes(err.code)) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(returnTo(req, `/quotes/${quote.reference}`));
  })
);

router.post(
  '/:reference/delete',
  isEmailVerified,
  writeLimiter,
  asyncHandler(async (req, res) => {
    const quote = await Quote.findByReference(String(req.params.reference).toUpperCase());
    if (!quote || quote.owner_user_id !== req.session.user.id) {
      return res.status(404).render('errors/404', { title: 'Not found' });
    }

    const removed = await Quote.remove(quote.id, req.session.user.id);
    if (removed) {
      req.flash('success', 'Draft estimate deleted.');
      return res.redirect('/quotes');
    }

    // Not an error the user can fix by trying again: a sent quote is a record of something
    // said to a client, and it is withdrawn by status rather than erased.
    req.flash('error', 'Only a draft can be deleted. Mark it declined or expired instead.');
    return res.redirect(`/quotes/${quote.reference}`);
  })
);

module.exports = router;
