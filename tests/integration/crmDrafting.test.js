'use strict';

/*
 * Set BEFORE the application is required: `config/config.js` reads the key once at module
 * load, and `isConfigured()` is what decides whether the button renders at all. The key is
 * never used — every call in this file goes to a stub.
 */
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';

/**
 * Generating an outreach draft, end to end.
 *
 * The model is stubbed, so what is actually under test is everything around it: that a
 * refused draft is shown and not stored, that a stored one records which model wrote it,
 * that the spend lands in the shared ledger, and that the two refusals before the call —
 * a suppressed address and an erased lead — happen before any money is spent.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const CrmLead = require('../../models/CrmLead');
const CrmDraft = require('../../models/CrmDraft');
const CrmSuppression = require('../../models/CrmSuppression');
const outreach = require('../../utils/outreachDrafting');
const { clearBudgetCache } = require('../../utils/aiBudget');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Draft-Test-Pass-1';
const OWN = ['draft-super@example.test'];
const MARK = 'Drafttest';
/*
 * A FRESH ADDRESS PER RUN. Two cases here suppress an address, and nothing in this
 * application removes a suppression — that is the design. A suite that used a fixed
 * address would pass once and then fail for ever, because the second run cannot create
 * the lead it needs; clearing the table in `beforeAll` would "fix" it by deleting the one
 * record the CRM exists to keep.
 */
const RUN = Date.now();

let app;
let superId;
let agent;

const CLEAN =
  'We run a marketplace where companies hire SAP consultants for contract work, and where a '
  + 'scope estimate can be produced before anybody commits to a programme of work. I am getting '
  + 'in touch because that may be useful to your team. Would it be worth a short conversation '
  + 'about whether it fits?';

function reply(text, { stopReason = 'end_turn', inputTokens = 900, outputTokens = 120 } = {}) {
  return {
    model: 'claude-test-model',
    stop_reason: stopReason,
    content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text }],
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outputTokens
    }
  };
}

function useFakeClient(handler) {
  const calls = [];
  outreach.setClientForTests({
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return handler(params, calls.length);
        }
      }
    }
  });
  return calls;
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

async function newLead(company, over = {}) {
  const created = await CrmLead.upsert(
    {
      company: `${MARK} ${company}`,
      contact_name: 'Petra Klein',
      contact_email: `draft-${company.toLowerCase()}-${RUN}@example.test`,
      job_title: 'CIO',
      country: 'DE',
      source: 'event',
      source_detail: 'SAP Sapphire, June',
      ...over
    },
    { actorUserId: superId }
  );
  return created.id;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');

  await promisePool.query('DELETE FROM crm_leads WHERE company LIKE ?', [`${MARK}%`]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const su = await User.create({ email: OWN[0], password: PASSWORD, name: 'Draft Super', roles: ['admin'] });
  superId = su.id;
  await User.setEmailVerified(superId);
  await User.adminSetRoles(superId, ['admin'], { primary: 'admin' });
  await User.setSuperadmin(superId, true);

  agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form')
    .send({ _csrf: csrfFrom(page.text), email: OWN[0], password: PASSWORD });
});

beforeEach(() => {
  if (!reachable) return;
  clearBudgetCache();
});

maybe()('a draft that passes its checks', () => {
  it('is stored with the model that wrote it and its token counts', async () => {
    const calls = useFakeClient(() => reply(CLEAN));
    const id = await newLead('Alpha');

    const page = await agent.get(`/crm/${id}`);
    const res = await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });
    expect(res.status).toBe(302);

    const [draft] = await CrmDraft.forLead(id);
    expect(draft.body).toContain('marketplace');
    /*
     * A generated draft that could not say where it came from is the unaccountable version
     * of this feature. The columns were on the table before the feature existed.
     */
    expect(draft.model).toBe('claude-test-model');
    expect(draft.input_tokens).toBe(900);
    expect(draft.output_tokens).toBe(120);
    expect(draft.marked_sent_at).toBeNull();

    // And nothing personal left this process.
    const sent = calls[0].messages[0].content;
    expect(sent).toContain(`${MARK} Alpha`);
    expect(sent).not.toContain('Petra');
    expect(sent).not.toContain(`draft-alpha-${RUN}@example.test`);
  });

  it('charges the shared ledger, under its own feature name', async () => {
    const [[row]] = await promisePool.query(
      "SELECT COUNT(*) AS n, SUM(input_tokens) AS input FROM ai_usage WHERE feature = 'crm_outreach'"
    );
    expect(Number(row.n)).toBeGreaterThan(0);
    expect(Number(row.input)).toBeGreaterThan(0);
  });
});

maybe()('a draft that fails its checks', () => {
  it('is shown with its reasons and never stored', async () => {
    /*
     * Not silently retried: somebody should see that the model invented a relationship,
     * because that is the failure this feature has to be watched for — and a retry loop
     * would hide it while paying for every attempt.
     */
    useFakeClient(() => reply(`I saw your recent S/4HANA rollout and we guarantee results. ${CLEAN}`));
    const id = await newLead('Beta');

    const page = await agent.get(`/crm/${id}`);
    const res = await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });

    expect(res.status).toBe(200);
    expect(res.text).toContain('failed its checks');
    expect(res.text).toMatch(/familiarity/i);
    expect(res.text).toMatch(/commitment/i);

    expect(await CrmDraft.forLead(id)).toHaveLength(0);
  });

  it('is not served when the model ran out of room mid-sentence', async () => {
    useFakeClient(() => reply(CLEAN, { stopReason: 'max_tokens' }));
    const id = await newLead('Gamma');

    const page = await agent.get(`/crm/${id}`);
    const res = await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/ran past its ceiling/i);
    expect(await CrmDraft.forLead(id)).toHaveLength(0);
  });
});

maybe()('what happens before any money is spent', () => {
  it('a suppressed address is refused without calling the model', async () => {
    const calls = useFakeClient(() => reply(CLEAN));
    const id = await newLead('Delta');
    await CrmSuppression.add(`draft-delta-${RUN}@example.test`, { reason: 'requested', actorUserId: superId });

    const page = await agent.get(`/crm/${id}`);
    const res = await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });

    expect(res.status).toBe(302);
    expect(calls).toHaveLength(0);
    expect(await CrmDraft.forLead(id)).toHaveLength(0);
  });

  it('an erased lead has nobody left to write to', async () => {
    const calls = useFakeClient(() => reply(CLEAN));
    const id = await newLead('Epsilon');
    await CrmLead.setStatus(id, 'unsubscribed', { actorUserId: superId, note: 'Asked.' });

    const page = await agent.get(`/crm/${id}`);
    const res = await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });

    expect(res.status).toBe(302);
    expect(calls).toHaveLength(0);
  });
});

maybe()('the ceiling on drafts per lead', () => {
  it('bounds the retries, because the button is the unbounded part', async () => {
    useFakeClient(() => reply(CLEAN));
    const id = await newLead('Zeta');

    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < CrmDraft.MAX_DRAFTS_PER_LEAD + 1; i += 1) {
      const page = await agent.get(`/crm/${id}`);
      await agent.post(`/crm/${id}/draft/generate`).type('form').send({ _csrf: csrfFrom(page.text) });
    }
    /* eslint-enable no-await-in-loop */

    const drafts = await CrmDraft.forLead(id);
    expect(drafts).toHaveLength(CrmDraft.MAX_DRAFTS_PER_LEAD);
  });
});
