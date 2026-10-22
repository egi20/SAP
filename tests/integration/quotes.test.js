'use strict';

/**
 * The estimator and the quote lifecycle, against a real database.
 *
 * The engine's own arithmetic is covered by tests/unit/estimation.test.js. What is only
 * testable here is everything around it: that the reconciliation guard actually runs before
 * anything is stored, that the JSON column survives a round trip, that the modules reach
 * their own table, and that the lifecycle refuses what it says it refuses.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const { catalogueVersion } = require('../../config/estimation');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const CSRF = /name="_csrf" value="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

/**
 * Read a response body as raw bytes.
 *
 * supertest parses a body it recognises and hands back `{}` for one it does not, so
 * `res.body.slice` is not a function on a .pptx or a .zip. These are binary files and the
 * whole point of the assertion is the first two bytes, so the parser is replaced rather
 * than the assertion weakened.
 */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function signUp({ email, name, roles }) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/register');
  await agent
    .post('/auth/register')
    .type('form')
    .send({
      _csrf: csrfFrom(page.text),
      email,
      name,
      password: 'Sup3rSecret',
      confirm_password: 'Sup3rSecret',
      user_types: roles,
      terms: 'on'
    });

  await promisePool.query('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);

  const login = await agent.get('/auth/login');
  await agent
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });

  return agent;
}

const OWN_ACCOUNTS = [
  'partner@example.test',
  'other@example.test',
  'docs@example.test',
  'nosy@example.test',
  'sow@example.test'
];

/**
 * Each suite owns its own accounts and removes only those.
 *
 * `DELETE FROM users` was the first version, and it is a trap: Jest runs test FILES in
 * parallel workers by default, so two suites truncating the same table race each other and
 * fail in whichever order the scheduler picked that day. Everything in this schema cascades
 * from `users`, so deleting this suite's own e-mail addresses is both sufficient and
 * parallel-safe.
 */
async function removeOwnAccounts() {
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await removeOwnAccounts();
});

maybe()('producing and keeping an estimate', () => {
  let author;
  let stranger;
  let reference;

  beforeAll(async () => {
    author = await signUp({ email: 'partner@example.test', name: 'Partner Person', roles: 'company' });
    stranger = await signUp({ email: 'other@example.test', name: 'Other Person', roles: 'company' });

    const form = await author.get('/quotes/new');
    const posted = await author
      .post('/quotes')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        client_company: 'Acme Manufacturing GmbH',
        client_name: 'A Buyer',
        client_email: 'buyer@acme.test',
        client_industry: 'Manufacturing',
        company_size: 'Large (501-5000)',
        project_name: 'S/4HANA finance and sales core',
        project_summary: 'Finance and order-to-cash, three company codes.',
        transition_approach: 'brownfield',
        clean_core_level: 'moderate',
        complexity: 'complex',
        // sd-sales depends on mm-inventory, which is NOT in scope: the boundary is charged.
        modules: ['fi-gl', 'co-cca', 'sd-sales'],
        addons: ['addon-vertex'],
        number_of_users: 600,
        number_of_company_codes: 3,
        number_of_countries: 2,
        number_of_integrations: 5,
        integration_complexity: 'medium',
        contingency_percentage: 15,
        include_training: 'on',
        include_run: 'on'
      });

    expect(posted.status).toBe(302);
    // Scoped to this suite's own author, for the reason spelled out in marketplace.test.js:
    // an unscoped LIMIT 1 reads whichever suite wrote last.
    const [[row]] = await promisePool.query(
      `SELECT q.reference
         FROM quotes q
         JOIN users u ON u.id = q.owner_user_id
        WHERE u.email = ?
        ORDER BY q.id DESC
        LIMIT 1`,
      ['partner@example.test']
    );
    reference = row.reference;
  });

  test('the headline figures are denormalised, not left inside the JSON', async () => {
    const [[quote]] = await promisePool.query('SELECT * FROM quotes WHERE reference = ?', [reference]);

    expect(quote.transition_approach).toBe('brownfield');
    expect(quote.total_man_days).toBeGreaterThan(0);
    expect(Number(quote.total_budget)).toBeGreaterThan(0);
    expect(quote.duration_weeks).toBeGreaterThan(0);
    expect(quote.status).toBe('draft');
    expect(quote.catalogue_version).toBe(catalogueVersion());
  });

  test('the stored breakdown still reconciles after a round trip through JSON', async () => {
    const Quote = require('../../models/Quote');
    const { reconciliationProblems } = require('../../utils/sapEstimation');

    const quote = await Quote.findByReference(reference);
    // Not a re-run of the engine: this is the object as the database handed it back.
    expect(reconciliationProblems(quote.estimate)).toEqual([]);
    expect(quote.estimate.totalManDays).toBe(quote.total_man_days);
  });

  test('the modules reach their own table, so they can be asked about across quotes', async () => {
    const [rows] = await promisePool.query(
      'SELECT module_slug FROM quote_modules qm JOIN quotes q ON q.id = qm.quote_id WHERE q.reference = ?',
      [reference]
    );
    expect(rows.map((r) => r.module_slug).sort()).toEqual(['co-cca', 'fi-gl', 'sd-sales']);
  });

  test('creation wrote its own first history entry', async () => {
    const [events] = await promisePool.query(
      'SELECT qe.to_status FROM quote_events qe JOIN quotes q ON q.id = qe.quote_id WHERE q.reference = ?',
      [reference]
    );
    expect(events).toHaveLength(1);
    expect(events[0].to_status).toBe('draft');
  });

  test('the page shows the boundary to a module that is not in scope', async () => {
    const page = await author.get(`/quotes/${reference}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Boundaries to modules not in scope');
    // sd-sales -> mm-inventory, charged because procurement was not bought.
    expect(page.text).toContain('Inventory Management');
  });

  test('hypercare is shown inside the total, never added to it', async () => {
    const page = await author.get(`/quotes/${reference}`);
    expect(page.text).toMatch(/within<\/strong> the total above, not added to it/);

    const [[quote]] = await promisePool.query('SELECT estimate FROM quotes WHERE reference = ?', [reference]);
    const estimate = typeof quote.estimate === 'string' ? JSON.parse(quote.estimate) : quote.estimate;
    expect(estimate.totalBudget).toBe(estimate.implementationBudget);
  });

  test('a quote belongs to its author and nobody else', async () => {
    const mine = await author.get(`/quotes/${reference}`);
    const theirs = await stranger.get(`/quotes/${reference}`);
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
  });

  test('the lifecycle allows what it declares and refuses the rest', async () => {
    const page = await author.get(`/quotes/${reference}`);
    const token = csrfFrom(page.text);

    // draft -> accepted is not a declared transition.
    await author.post(`/quotes/${reference}/status`).type('form').send({ _csrf: token, status: 'accepted' });
    let [[quote]] = await promisePool.query('SELECT status FROM quotes WHERE reference = ?', [reference]);
    expect(quote.status).toBe('draft');

    await author.post(`/quotes/${reference}/status`).type('form').send({ _csrf: token, status: 'sent' });
    [[quote]] = await promisePool.query('SELECT status, sent_at FROM quotes WHERE reference = ?', [reference]);
    expect(quote.status).toBe('sent');
    expect(quote.sent_at).not.toBeNull();

    await author
      .post(`/quotes/${reference}/status`)
      .type('form')
      .send({ _csrf: token, status: 'accepted', note: 'Signed off at the steering committee.' });
    [[quote]] = await promisePool.query('SELECT status, decided_at FROM quotes WHERE reference = ?', [reference]);
    expect(quote.status).toBe('accepted');
    expect(quote.decided_at).not.toBeNull();

    const [events] = await promisePool.query(
      'SELECT qe.from_status, qe.to_status, qe.note FROM quote_events qe JOIN quotes q ON q.id = qe.quote_id WHERE q.reference = ? ORDER BY qe.id',
      [reference]
    );
    expect(events.map((e) => e.to_status)).toEqual(['draft', 'sent', 'accepted']);
    expect(events[2].note).toContain('steering committee');
  });

  test('a quote that has been sent cannot be deleted', async () => {
    const page = await author.get(`/quotes/${reference}`);
    await author.post(`/quotes/${reference}/delete`).type('form').send({ _csrf: csrfFrom(page.text) });

    const [[quote]] = await promisePool.query('SELECT status FROM quotes WHERE reference = ?', [reference]);
    expect(quote.status).toBe('accepted'); // still there, and still what it was
  });

  test('a scope of nothing is refused rather than costed at a default', async () => {
    const form = await author.get('/quotes/new');
    const posted = await author
      .post('/quotes')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        client_company: 'Empty Co',
        client_name: 'Nobody',
        project_name: 'Nothing at all'
      });

    expect(posted.status).toBe(422);
    expect(posted.text).toContain('an estimate needs a scope');
  });

  test('a stale catalogue is flagged, and the stored figures are left alone', async () => {
    const [[before]] = await promisePool.query('SELECT total_man_days FROM quotes WHERE reference = ?', [reference]);

    await promisePool.query("UPDATE quotes SET catalogue_version = 'deadbeef0000' WHERE reference = ?", [reference]);
    const page = await author.get(`/quotes/${reference}`);
    expect(page.text).toContain('The basis has moved');

    const [[after]] = await promisePool.query('SELECT total_man_days FROM quotes WHERE reference = ?', [reference]);
    expect(after.total_man_days).toBe(before.total_man_days);

    await promisePool.query('UPDATE quotes SET catalogue_version = ? WHERE reference = ?', [
      catalogueVersion(),
      reference
    ]);
  });
});

maybe()('producing the deliverables', () => {
  let author;
  let stranger;
  let reference;

  beforeAll(async () => {
    author = await signUp({ email: 'docs@example.test', name: 'Docs Person', roles: 'company' });
    stranger = await signUp({ email: 'nosy@example.test', name: 'Nosy Person', roles: 'company' });

    const form = await author.get('/quotes/new');
    await author
      .post('/quotes')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        // An ampersand, because pptxgenjs writes document properties into XML unescaped and
        // an ordinary company name is what breaks it.
        client_company: 'Smith & Jones Ltd',
        client_name: 'A Buyer',
        project_name: 'Ariba and MM rollout',
        transition_approach: 'greenfield',
        modules: ['mm-purchasing', 'ariba-buying'],
        number_of_users: 300,
        number_of_company_codes: 2,
        number_of_countries: 1,
        number_of_integrations: 3,
        contingency_percentage: 15,
        include_training: 'on',
        include_run: 'on'
      });

    const [[row]] = await promisePool.query(
      "SELECT reference FROM quotes WHERE client_company = 'Smith & Jones Ltd'"
    );
    reference = row.reference;
  });

  test.each([
    ['sow', 'wordprocessingml.document', '.docx'],
    ['wbs', 'spreadsheetml.sheet', '.xlsx'],
    ['deck', 'presentationml.presentation', '.pptx'],
    ['package', 'application/zip', '.zip']
  ])('%s downloads as a real file', async (kind, contentType, extension) => {
    const res = await author.get(`/quotes/${reference}/download/${kind}`).buffer(true).parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(contentType);
    expect(res.headers['content-disposition']).toContain(extension);
    // Every one of these is a zip container, and every zip starts "PK".
    expect(res.body.slice(0, 2).toString('latin1')).toBe('PK');
    expect(Number(res.headers['content-length'])).toBe(res.body.length);
  });

  test('a document is never cached, because the estimate behind it can be superseded', async () => {
    const res = await author.get(`/quotes/${reference}/download/sow`);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  test('the filename cannot carry a quote or a slash into the header', async () => {
    const res = await author.get(`/quotes/${reference}/download/package`);
    const disposition = res.headers['content-disposition'];
    const filename = disposition.match(/filename="([^"]+)"/)[1];
    expect(filename).not.toMatch(/["/\\\r\n]/);
  });

  test('every download is logged with the catalogue it was priced under', async () => {
    const [rows] = await promisePool.query(
      `SELECT qd.kind, qd.catalogue_version, qd.byte_size
         FROM quote_downloads qd JOIN quotes q ON q.id = qd.quote_id
        WHERE q.reference = ? ORDER BY qd.id`,
      [reference]
    );

    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(['sow', 'wbs', 'deck', 'package']));
    for (const row of rows) {
      expect(row.catalogue_version).toBe(catalogueVersion());
      expect(row.byte_size).toBeGreaterThan(0);
    }
  });

  test('the quote page lists what has been produced', async () => {
    const page = await author.get(`/quotes/${reference}`);
    expect(page.text).toContain('Produced so far');
    expect(page.text).toContain(catalogueVersion());
  });

  test('somebody else cannot download another account\'s documents', async () => {
    for (const kind of ['sow', 'wbs', 'deck', 'package']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await stranger.get(`/quotes/${reference}/download/${kind}`);
      expect({ kind, status: res.status }).toEqual({ kind, status: 404 });
    }
  });

  test('an unknown kind is a 404, not an attempt to build it', async () => {
    const res = await author.get(`/quotes/${reference}/download/exe`);
    expect(res.status).toBe(404);
  });
});

maybe()('the SOW generator form', () => {
  let author;
  let reference;

  const BASE = {
    client_company: 'Context Client AG',
    client_name: 'A Sponsor',
    project_name: 'Finance core with migration',
    transition_approach: 'greenfield',
    clean_core_level: 'moderate',
    complexity: 'moderate',
    modules: ['fi-gl', 'fi-ap'],
    number_of_users: 100,
    number_of_company_codes: 1,
    number_of_countries: 1,
    contingency_percentage: 15,
    include_run: 'on'
  };

  beforeAll(async () => {
    author = await signUp({ email: 'sow@example.test', name: 'Sow Author', roles: 'company' });
    const form = await author.get('/quotes/new');
    const posted = await author
      .post('/quotes')
      .type('form')
      .send({
        ...BASE,
        _csrf: csrfFrom(form.text),
        current_system: 'ecc6',
        go_live_date: '2020-01-01',
        data_migration_scope: 'open-items',
        data_volume: 'high',
        success_criteria: 'Month-end close in three days.',
        constraints: 'No cut-over in December.'
      });
    expect(posted.status).toBe(302);
    const [[row]] = await promisePool.query(
      'SELECT q.reference FROM quotes q JOIN users u ON u.id = q.owner_user_id WHERE u.email = ? ORDER BY q.id DESC LIMIT 1',
      ['sow@example.test']
    );
    reference = row.reference;
  });

  test('the page explains what it produces and marks the required fields', async () => {
    const page = await author.get('/quotes/new');
    expect(page.text).toContain('SOW Generator');
    expect(page.text).toContain("What you'll get");
    for (const label of ['Statement of work', 'Work breakdown', 'Summary deck']) expect(page.text).toContain(label);
    for (const field of ['Client company', 'Contact name', 'Project name']) {
      expect(page.text).toMatch(new RegExp(`${field} <span class="text-danger" aria-hidden="true">\\*</span>`));
    }
  });

  test('the project context and the data migration are stored and shown', async () => {
    const Quote = require('../../models/Quote');
    const { reconciliationProblems } = require('../../utils/sapEstimation');
    const quote = await Quote.findByReference(reference);
    expect(quote.inputs.projectContext).toEqual({
      currentSystem: 'ecc6',
      goLiveDate: '2020-01-01',
      successCriteria: 'Month-end close in three days.',
      constraints: 'No cut-over in December.'
    });
    expect(quote.estimate.dataMigration.days).toBeGreaterThan(0);
    expect(reconciliationProblems(quote.estimate)).toEqual([]);

    const page = await author.get(`/quotes/${reference}`);
    expect(page.text).toContain('Project context');
    expect(page.text).toContain('SAP ECC 6.0');
    expect(page.text).toContain('Month-end close in three days.');
    // A go-live in the past cannot fit any timeline.
    expect(page.text).toContain('at the earliest — after the target');
  });

  test('a new estimate can start from a previous one, and only from the author\'s own', async () => {
    const mine = await author.get(`/quotes/new?from=${reference}`);
    expect(mine.text).toContain(`Copied from <a href="/quotes/${reference}">`);
    expect(mine.text).toMatch(/id="qm-fi-gl" checked/);
    expect(mine.text).toContain('Finance core with migration (copy)');

    // The first suite's quote belongs to another account: the form opens blank. (A second
    // sign-up here would spend the registration limiter the other suites need.)
    const [[foreign]] = await promisePool.query(
      'SELECT q.reference FROM quotes q JOIN users u ON u.id = q.owner_user_id WHERE u.email = ? LIMIT 1',
      ['partner@example.test']
    );
    const theirs = await author.get(`/quotes/new?from=${foreign.reference}`);
    expect(theirs.status).toBe(200);
    expect(theirs.text).not.toContain('Copied from');
    expect(theirs.text).not.toContain('Acme Manufacturing GmbH');
  });

  test('a refused submission keeps the ticked modules', async () => {
    const form = await author.get('/quotes/new');
    const res = await author
      .post('/quotes')
      .type('form')
      .send({ ...BASE, _csrf: csrfFrom(form.text), client_company: '' });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/id="qm-fi-ap" checked/);
  });

  test('the live total is the engine\'s own figure, and nothing is stored', async () => {
    const form = await author.get('/quotes/new');
    const token = csrfFrom(form.text);
    const [[{ n: before }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM quotes q JOIN users u ON u.id = q.owner_user_id WHERE u.email = ?',
      ['sow@example.test']
    );
    const res = await author
      .post('/quotes/preview')
      .set('X-CSRF-Token', token)
      .set('Sec-Fetch-Dest', 'empty')
      .type('form')
      .send({ ...BASE, data_migration_scope: 'open-items', data_volume: 'high' });
    expect(res.status).toBe(200);

    const { calculateEstimation } = require('../../utils/sapEstimation');
    const Quote = require('../../models/Quote');
    const stored = await Quote.findByReference(reference);
    const expected = calculateEstimation({ ...stored.inputs, projectContext: undefined }, { contingencyPercentage: 15, currency: 'EUR' });
    expect(res.body).toMatchObject({
      success: true,
      empty: false,
      modules: 2,
      totalManDays: expected.totalManDays,
      totalBudget: expected.totalBudget,
      dataMigrationDays: expected.dataMigration.days
    });

    const [[{ n: after }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM quotes q JOIN users u ON u.id = q.owner_user_id WHERE u.email = ?',
      ['sow@example.test']
    );
    expect(after).toBe(before);
  });

  test('the preview explains its days and warns when the go-live cannot be met', async () => {
    const form = await author.get('/quotes/new');
    const res = await author
      .post('/quotes/preview')
      .set('X-CSRF-Token', csrfFrom(form.text))
      .type('form')
      .send({ ...BASE, modules: ['fi-ap', 'fi-ar', 'fi-aa'], go_live_date: '2020-01-01', hypercare_duration: '8' });
    expect(res.body.effortSteps.reduce((sum, step) => sum + step.days, 0)).toBe(res.body.totalManDays);
    expect(res.body.effortSteps.map((step) => step.id)).toEqual(expect.arrayContaining(['scope', 'boundaries', 'hypercare', 'contingency']));
    expect(res.body.hypercare).toMatchObject({ included: true, weeks: 8 });
    expect(res.body.goLiveTooSoon).toBe(true);
    expect(res.body.earliestGoLive).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.dataMigrationScope).toBe('not-assessed');

    const later = await author
      .post('/quotes/preview')
      .set('X-CSRF-Token', csrfFrom(form.text))
      .type('form')
      .send({ ...BASE, go_live_date: '2099-01-01' });
    expect(later.body.goLiveTooSoon).toBe(false);
  });

  test('an estimate can be duplicated from its own page and from the list', async () => {
    const page = await author.get(`/quotes/${reference}`);
    expect(page.text).toContain(`href="/quotes/new?from=${reference}"`);
    const list = await author.get('/quotes');
    expect(list.text).toContain(`href="/quotes/new?from=${reference}"`);
  });

  test('the preview with nothing ticked says so rather than pricing an empty programme', async () => {
    const form = await author.get('/quotes/new');
    const res = await author
      .post('/quotes/preview')
      .set('X-CSRF-Token', csrfFrom(form.text))
      .type('form')
      .send({ complexity: 'moderate' });
    expect(res.body).toEqual({ success: true, empty: true });
  });
});
