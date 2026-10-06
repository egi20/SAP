'use strict';

const express = require('express');

const countries = require('../config/all-countries.json');
const CrmLead = require('../models/CrmLead');
const CrmSuppression = require('../models/CrmSuppression');
const CrmDraft = require('../models/CrmDraft');
const User = require('../models/User');
const { isAuthenticated, isSuperadmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireIdParam } = require('../utils/ids');
const { readLeads } = require('../utils/crmImport');
const outreach = require('../utils/outreachDrafting');
const { PRODUCT_LINES } = require('../config/sapProducts');
const {
  BULK_ACTIONS,
  CHANNELS,
  LEAD_SOURCES,
  LIMITS,
  OUTCOMES,
  STALE_AFTER_DAYS,
  STATUSES,
  TRANSITIONS
} = require('../config/crm');
const { paginationFrom, paginationMeta, pageUrl } = require('../utils/pagination');

const router = express.Router();

/**
 * The internal sales CRM.
 *
 * SUPERADMIN ONLY, for the same reason `/admin/rates` carries the narrowest guard in the
 * application: every screen here shows the contact details of people who never asked to be
 * contacted. An ordinary administrator moderating a forum has no business reading them.
 *
 * NOTHING IN THIS FILE SENDS ANYTHING. There is no mail call, no queue worker and no
 * scheduler. A draft is written, a person sends it from their own mail client, and a
 * person records that they did. A test reads this file and fails if it grows a transport.
 */
router.use(isAuthenticated, isSuperadmin);

/** The filters a screen may set, read once so the list, the count and a bulk action agree. */
function filtersFrom(query) {
  return {
    q: typeof query.q === 'string' ? query.q.trim().slice(0, 120) : '',
    status: query.status || '',
    source: query.source || '',
    country: query.country || '',
    product_line: query.product_line || '',
    unowned: query.unowned === '1',
    stale: query.stale === '1'
  };
}

/** Everything the board and the import screens need to draw their controls. */
function catalogues() {
  return {
    sources: LEAD_SOURCES,
    statuses: STATUSES,
    transitions: TRANSITIONS,
    channels: CHANNELS,
    outcomes: OUTCOMES,
    productLines: PRODUCT_LINES,
    countries,
    staleAfterDays: STALE_AFTER_DAYS
  };
}

/** GET /crm — the board. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, perPage, limit, offset } = paginationFrom(req.query, { defaultPerPage: 50 });
    const filters = filtersFrom(req.query);

    const [{ rows, total }, statusCounts, stale, suppressed] = await Promise.all([
      CrmLead.list(filters, { limit, offset }),
      CrmLead.statusCounts(),
      CrmLead.staleCount(),
      CrmSuppression.count()
    ]);

    return res.render('crm/index', {
      title: 'Leads',
      leads: rows,
      total,
      filters,
      statusCounts,
      staleCount: stale,
      suppressedCount: suppressed,
      bulkActions: BULK_ACTIONS,
      ...catalogues(),
      pagination: paginationMeta({ page, perPage, total }),
      pageUrl: (p) => pageUrl('/crm', req.query, p)
    });
  })
);

router.get('/new', (req, res) => {
  res.render('crm/form', { title: 'Add a lead', values: {}, ...catalogues() });
});

router.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await CrmLead.upsert(req.body, { actorUserId: req.session.user.id });
      req.flash('success', result.created ? 'Lead added.' : 'That address was already here — the lead was updated.');
      return res.redirect(`/crm/${result.id}`);
    } catch (err) {
      if (!err.code || err.code === 'ER_DUP_ENTRY') throw err;
      req.flash('error', err.message);
      return res.status(422).render('crm/form', { title: 'Add a lead', values: req.body, ...catalogues() });
    }
  })
);

/**
 * GET /crm/import — paste a CSV.
 *
 * PASTED, not uploaded, and that is deliberate. An upload path would hand a file full of
 * other people's contact details to middleware configured for profile photographs, and
 * would put it somewhere — a temp file, a buffer, a disk — for the length of a request.
 * Pasted text lives in one request body, is parsed in memory, and is written or discarded.
 */
router.get('/import', (req, res) => {
  res.render('crm/import', { title: 'Import leads', preview: null, values: {}, ...catalogues() });
});

/**
 * POST /crm/import — PREVIEW ONLY unless `confirm` is set.
 *
 * Two posts of the same text: the first shows what would be written, the second writes it.
 * There is no server-side draft between them, so there is nothing holding a file of
 * contact details between two requests and nothing to expire.
 */
router.post(
  '/import',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const values = {
      csv: typeof req.body.csv === 'string' ? req.body.csv.slice(0, 1_000_000) : '',
      source: req.body.source || '',
      source_detail: req.body.source_detail || ''
    };

    const parsed = readLeads(values.csv, { source: values.source, sourceDetail: values.source_detail });

    // The suppression list is consulted BEFORE anything is written, in one query, and the
    // suppressed rows are reported rather than quietly dropped: "we did not import four of
    // these, and here is why" is the sentence somebody needs.
    const suppressed = await CrmSuppression.filterSuppressed(parsed.leads.map((l) => l.contact_email).filter(Boolean));

    /*
     * And which of these addresses already has an account here. Not a block — it is
     * information the person writing needs, because a cold approach to somebody who is
     * already a member is the one message this site should never send.
     */
    const members = new Set();
    for (const lead of parsed.leads) {
      if (!lead.contact_email || suppressed.has(lead.contact_email)) continue;
      // eslint-disable-next-line no-await-in-loop
      const existing = await User.findByEmail(lead.contact_email);
      if (existing) members.add(lead.contact_email);
    }

    const writable = parsed.leads.filter((l) => !l.contact_email || !suppressed.has(l.contact_email));

    if (req.body.confirm !== '1' || parsed.problems.length) {
      return res.render('crm/import', {
        title: 'Import leads',
        values,
        preview: { ...parsed, suppressed: [...suppressed], members: [...members], writable: writable.length },
        ...catalogues()
      });
    }

    let created = 0;
    let updated = 0;
    const failed = [];
    for (const lead of writable) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await CrmLead.upsert(lead, { actorUserId: req.session.user.id });
        if (result.created) created += 1;
        else updated += 1;
      } catch (err) {
        if (!err.code) throw err;
        failed.push({ line: lead.line, reason: err.message });
      }
    }

    req.flash(
      'success',
      `Imported ${created} new ${created === 1 ? 'lead' : 'leads'}, updated ${updated}` +
        `${suppressed.size ? `, refused ${suppressed.size} on the do-not-contact list` : ''}` +
        `${failed.length ? `, and could not read ${failed.length}` : ''}.`
    );
    if (failed.length) {
      req.flash('error', failed.map((f) => `Line ${f.line}: ${f.reason}`).join(' '));
    }
    return res.redirect('/crm');
  })
);

/** GET /crm/export.csv — the same rows the screen showed, through the same builder. */
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const rows = await CrmLead.exportRows(filtersFrom(req.query));

    const header = [
      'company', 'contact_name', 'contact_email', 'contact_phone', 'job_title',
      'country', 'website', 'linkedin_url', 'source', 'source_detail', 'status',
      'last_activity_at', 'created_at'
    ];
    // Every cell quoted and every quote doubled. A company called `=cmd|'/c calc'!A0` is a
    // formula to a spreadsheet and a string to everything else; quoting is what keeps a
    // CSV a CSV.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(csv);
  })
);

/** GET /crm/suppressions — reasons and dates. There are no addresses to show. */
router.get(
  '/suppressions',
  asyncHandler(async (req, res) => {
    const [entries, total] = await Promise.all([CrmSuppression.recent({ limit: 100 }), CrmSuppression.count()]);
    return res.render('crm/suppressions', { title: 'Do not contact', entries, total });
  })
);

/**
 * POST /crm/suppressions — add an address by hand.
 *
 * Somebody writes in asking never to be contacted and there may be no lead to move: the
 * address was on a list somebody else holds, or the lead was deleted last quarter. The
 * suppression is the half that has to work without the lead.
 */
router.post(
  '/suppressions',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const added = await CrmSuppression.add(req.body.email, {
      reason: 'requested',
      note: req.body.note,
      actorUserId: req.session.user.id
    });
    req.flash(
      'success',
      added ? 'Added. Nothing in this application can write to that address now.' : 'That address was already on the list.'
    );
    return res.redirect('/crm/suppressions');
  })
);

/**
 * POST /crm/bulk — delete or park what a filter matches.
 *
 * `expected` is the number the screen showed. The model aborts on a mismatch, so a bulk
 * action taken against a list that has changed underneath it changes nothing at all.
 */
router.post(
  '/bulk',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const action = BULK_ACTIONS.includes(req.body.action) ? req.body.action : null;
    if (!action) return res.status(404).render('errors/404', { title: 'Not found' });

    const filters = filtersFrom(req.body);
    const expected = Number.parseInt(req.body.expected, 10);

    try {
      if (action === 'delete') {
        const { deleted, kept } = await CrmLead.deleteFiltered(filters, Number.isFinite(expected) ? expected : null);
        req.flash(
          'success',
          `Deleted ${deleted}.` +
            (kept
              ? ` ${kept} ${kept === 1 ? 'was' : 'were'} kept because somebody has actually contacted them — their` +
                ' record is the answer to a complaint about that contact. Unsubscribe those instead, which erases the person and keeps the record.'
              : '')
        );
      } else {
        const { parked, skipped } = await CrmLead.parkFiltered(filters, Number.isFinite(expected) ? expected : null, {
          actorUserId: req.session.user.id
        });
        req.flash('success', `Parked ${parked}.${skipped ? ` ${skipped} could not move there from where they are.` : ''}`);
      }
    } catch (err) {
      if (err.code !== 'BULK_COUNT_MISMATCH') throw err;
      req.flash('error', err.message);
    }

    return res.redirect('/crm');
  })
);

/**
 * Everything the lead page needs.
 *
 * Factored out because a rejected draft is RENDERED rather than redirected to: the text
 * the model produced and the checks it failed have to be on the screen, and a flash
 * message cannot carry a paragraph and a list of reasons.
 */
async function leadPageModel(id) {
  const lead = await CrmLead.findById(id);
  if (!lead) return null;

  const [activities, drafts] = await Promise.all([CrmLead.activitiesFor(lead.id), CrmDraft.forLead(lead.id)]);

  // Shown, never acted on: a cold approach to somebody who already has an account here is
  // the one message this site should not send, and the person writing it needs to know
  // before they write it rather than after.
  const member = lead.contact_email ? await User.findByEmail(lead.contact_email) : null;

  return {
    title: lead.company,
    lead,
    activities,
    drafts,
    isMember: Boolean(member),
    moves: TRANSITIONS[lead.status] || [],
    maxDraftLength: LIMITS.draft,
    maxDrafts: CrmDraft.MAX_DRAFTS_PER_LEAD,
    draftingEnabled: outreach.isConfigured(),
    rejected: null,
    ...catalogues()
  };
}

/** GET /crm/:id — one lead. Declared after every fixed path above it. */
router.get(
  '/:id',
  requireIdParam('id'),
  asyncHandler(async (req, res) => {
    const model = await leadPageModel(req.params.id);
    if (!model) return res.status(404).render('errors/404', { title: 'Not found' });
    return res.render('crm/show', model);
  })
);

router.post(
  '/:id/status',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      const result = await CrmLead.setStatus(req.params.id, req.body.to, {
        actorUserId: req.session.user.id,
        note: req.body.note,
        channel: req.body.channel
      });
      req.flash(
        'success',
        result.erased
          ? 'Recorded. The address is on the do-not-contact list and the contact details have been erased from this lead — the company and the activity log stay.'
          : `Moved to "${result.to}".`
      );
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(`/crm/${req.params.id}`);
  })
);

router.post(
  '/:id/activity',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    try {
      await CrmLead.addActivity(req.params.id, {
        outcome: req.body.outcome,
        channel: req.body.channel,
        note: req.body.note,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Recorded.');
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(`/crm/${req.params.id}`);
  })
);

router.post(
  '/:id/owner',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const claim = req.body.claim === '1';
    await CrmLead.setOwner(req.params.id, claim ? req.session.user.id : null);
    req.flash('success', claim ? 'Yours.' : 'Released.');
    return res.redirect(`/crm/${req.params.id}`);
  })
);

/**
 * POST /crm/:id/draft — write one.
 *
 * A person types it. There is no generator behind this button yet, and the columns that
 * would record one — the model and its token counts — are already on the table, NULL for
 * every draft written here. A generated draft that could not say which model wrote it
 * would be the unaccountable version of this feature.
 */
router.post(
  '/:id/draft',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const lead = await CrmLead.findById(req.params.id);
    if (!lead) return res.status(404).render('errors/404', { title: 'Not found' });

    // Checked here as well as on the way in. A lead written before an address was
    // suppressed is exactly the row somebody would otherwise draft to.
    if (lead.contact_email && (await CrmSuppression.has(lead.contact_email))) {
      req.flash('error', 'That address is on the do-not-contact list.');
      return res.redirect(`/crm/${lead.id}`);
    }

    try {
      await CrmDraft.create(lead.id, {
        body: req.body.body,
        channel: req.body.channel,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Draft saved. Send it yourself, then record that you did.');
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(`/crm/${lead.id}`);
  })
);

/**
 * POST /crm/:id/draft/generate — ask the model for a first version.
 *
 * It writes a draft into the same table the hand-written ones go into, and it sends
 * nothing. Three things stand between this button and a bill: the month-to-date cap it
 * shares with the assistant, the ceiling on drafts per lead, and the fact that a rejected
 * draft is not retried automatically.
 *
 * A draft that fails its checks is RENDERED with its reasons and never stored. Somebody
 * should see that the model invented a relationship or an SAP module, because that is the
 * failure this feature has to be watched for — and an automatic retry would hide it while
 * paying for every attempt.
 */
router.post(
  '/:id/draft/generate',
  requireIdParam('id'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const lead = await CrmLead.findById(req.params.id);
    if (!lead) return res.status(404).render('errors/404', { title: 'Not found' });

    if (lead.erased_at) {
      req.flash('error', 'There is nobody here to write to any more.');
      return res.redirect(`/crm/${lead.id}`);
    }
    if (lead.contact_email && (await CrmSuppression.has(lead.contact_email))) {
      req.flash('error', 'That address is on the do-not-contact list.');
      return res.redirect(`/crm/${lead.id}`);
    }

    const result = await outreach.draftFor(lead, { userId: req.session.user.id });

    if (!result.ok) {
      const model = await leadPageModel(lead.id);
      if (!model) return res.status(404).render('errors/404', { title: 'Not found' });
      return res.status(200).render('crm/show', {
        ...model,
        rejected: { reason: result.reason, problems: result.problems || [], body: result.body || '' }
      });
    }

    try {
      await CrmDraft.create(lead.id, {
        body: result.body,
        channel: 'email',
        // Which model wrote it and what it cost, recorded with the draft. A generated
        // draft that could not say where it came from is the unaccountable version.
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        actorUserId: req.session.user.id
      });
      req.flash('success', 'Drafted. Read it, change what you want, then send it yourself.');
    } catch (err) {
      if (!err.code) throw err;
      req.flash('error', err.message);
    }

    return res.redirect(`/crm/${lead.id}`);
  })
);

router.post(
  '/:id/draft/:draftId/edit',
  requireIdParam('id'),
  requireIdParam('draftId'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    await CrmDraft.saveEdit(req.params.draftId, req.params.id, req.body.edited_body);
    req.flash('success', 'Saved.');
    return res.redirect(`/crm/${req.params.id}`);
  })
);

/**
 * POST /crm/:id/draft/:draftId/sent — record that a PERSON sent it.
 *
 * This endpoint writes a date. It does not send, and there is nothing behind it that
 * could: `marked_sent_at` is a note somebody made.
 */
router.post(
  '/:id/draft/:draftId/sent',
  requireIdParam('id'),
  requireIdParam('draftId'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const moved = await CrmDraft.markSent(req.params.draftId, req.params.id);
    if (moved) {
      await CrmLead.addActivity(req.params.id, {
        outcome: 'sent',
        channel: req.body.channel,
        note: 'Marked as sent by hand.',
        actorUserId: req.session.user.id
      }).catch(() => null);
    }
    req.flash('success', moved ? 'Recorded as sent.' : 'That draft was already marked sent.');
    return res.redirect(`/crm/${req.params.id}`);
  })
);

module.exports = router;
