'use strict';

/**
 * The agency directory, against a real database.
 *
 * Two things are being pinned. The first is visibility: an agency is hidden until its
 * owner publishes it, the publish is gated on a completeness floor, and every way in —
 * the directory, the profile page, search — asks the same model. The second is that
 * reading a page never writes: the reference's dashboard self-heals with an INSERT, so
 * merely opening it creates a row for anybody who looked.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const RecruiterProfile = require('../../models/RecruiterProfile');
const { searchEverything } = require('../../services/search');
const { PRODUCT_LINES } = require('../../config/sapProducts');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['agency-one@example.test', 'agency-two@example.test', 'agency-not@example.test'];
const CSRF = /name="_csrf" value="([^"]+)"/;
const TERM = 'Quandorix';

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
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

async function userId(email) {
  const [[row]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('the guard is the shared one', () => {
  let notAnAgency;

  beforeAll(async () => {
    notAnAgency = await signUp({ email: 'agency-not@example.test', name: 'Just Consulting', roles: 'consultant' });
  });

  test('an account without the role cannot reach the agency pages', async () => {
    for (const path of ['/recruiters/dashboard', '/recruiters/profile']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await notAnAgency.get(path);
      expect(res.status).toBe(302);
    }
  });

  test('the public directory is open to everybody', async () => {
    expect((await request(app).get('/recruiters')).status).toBe(200);
  });

  test('a signed-out visitor is sent to sign in, not to a broken page', async () => {
    const res = await request(app).get('/recruiters/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/login/);
  });
});

maybe()('an agency profile', () => {
  let agency;
  let agencyId;

  beforeAll(async () => {
    agency = await signUp({ email: 'agency-one@example.test', name: 'Agency Owner', roles: 'recruiter' });
    agencyId = await userId('agency-one@example.test');
  });

  /*
   * The reference's dashboard and profile handlers both do
   * `if (!recruiter) recruiter = await createForUser(...)`. A read that writes cannot be
   * retried safely and creates rows for anybody who merely looked.
   */
  test('opening the dashboard and the form writes nothing', async () => {
    expect((await agency.get('/recruiters/dashboard')).status).toBe(200);
    expect((await agency.get('/recruiters/profile')).status).toBe(200);

    const [[row]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM recruiter_profiles WHERE user_id = ?',
      [agencyId]
    );
    expect(row.n).toBe(0);
  });

  test('the dashboard prompts for a profile rather than showing an empty shell', async () => {
    const res = await agency.get('/recruiters/dashboard');
    expect(res.text).toContain('Set up your agency profile');
    expect(res.text).toContain('Nothing has been saved yet');
  });

  test('saving creates it, through the normaliser', async () => {
    const form = await agency.get('/recruiters/profile');
    const res = await agency
      .post('/recruiters/profile')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        agency_name: `  ${TERM}   Talent  `,
        about: 'We place S/4HANA finance and EWM people across the DACH region.',
        country: 'de',
        city: 'Munich',
        website: 'quandorix.example',
        specialisms: [PRODUCT_LINES[0].value, 'not-a-real-line']
      });
    expect(res.status).toBe(302);

    const profile = await RecruiterProfile.findByUserId(agencyId);
    expect(profile.agency_name).toBe(`${TERM} Talent`);
    expect(profile.country).toBe('DE');
    // Repaired, not refused — people type bare domains.
    expect(profile.website).toBe('https://quandorix.example/');
    // The bogus line never reached the column. Every read path hydrates the JSON column
    // through the same `parseSpecialisms`, so a caller never has to know whether the
    // driver handed back a string or an array on this engine.
    expect(profile.specialisms).toEqual([PRODUCT_LINES[0].value]);
  });

  test('it is not in the directory until its owner lists it', async () => {
    const { rows } = await RecruiterProfile.browse({ q: TERM });
    expect(rows).toHaveLength(0);
  });

  test('listing it is refused while a required field is empty, and says which', async () => {
    await promisePool.query('UPDATE recruiter_profiles SET about = NULL WHERE user_id = ?', [agencyId]);

    const form = await agency.get('/recruiters/profile');
    const res = await agency
      .post('/recruiters/profile/visibility')
      .type('form')
      .send({ _csrf: csrfFrom(form.text), is_public: 'true' });
    expect(res.status).toBe(302);

    const profile = await RecruiterProfile.findByUserId(agencyId);
    expect(profile.is_public).toBe(0);

    await promisePool.query('UPDATE recruiter_profiles SET about = ? WHERE user_id = ?', [
      'We place S/4HANA finance and EWM people across the DACH region.',
      agencyId
    ]);
  });

  test('a complete profile can be listed, and then appears everywhere at once', async () => {
    const form = await agency.get('/recruiters/profile');
    await agency
      .post('/recruiters/profile/visibility')
      .type('form')
      .send({ _csrf: csrfFrom(form.text), is_public: 'true' });

    const { rows } = await RecruiterProfile.browse({ q: TERM });
    expect(rows).toHaveLength(1);

    // The same row, reached three ways, none of which decides visibility itself.
    const directory = await request(app).get(`/recruiters?q=${TERM}`);
    expect(directory.text).toContain(`${TERM} Talent`);

    const results = await searchEverything(TERM);
    const agencies = results.groups.find((g) => g.key === 'recruiters');
    expect(agencies.total).toBe(1);
  });

  test('the public page is reachable by slug', async () => {
    const profile = await RecruiterProfile.findByUserId(agencyId);
    const res = await request(app).get(`/recruiters/${profile.slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${TERM} Talent`);
  });

  test('unlisting hides it from the directory, the page and search together', async () => {
    const form = await agency.get('/recruiters/profile');
    await agency
      .post('/recruiters/profile/visibility')
      .type('form')
      .send({ _csrf: csrfFrom(form.text), is_public: 'false' });

    const profile = await RecruiterProfile.findByUserId(agencyId);
    expect((await request(app).get(`/recruiters/${profile.slug}`)).status).toBe(404);
    expect((await RecruiterProfile.browse({ q: TERM })).rows).toHaveLength(0);

    const results = await searchEverything(TERM);
    expect(results.groups.find((g) => g.key === 'recruiters').total).toBe(0);
  });

  test('the specialism filter uses the catalogue vocabulary', async () => {
    await promisePool.query('UPDATE recruiter_profiles SET is_public = 1 WHERE user_id = ?', [agencyId]);

    const wanted = PRODUCT_LINES[0].value;
    const other = PRODUCT_LINES[1].value;
    expect((await RecruiterProfile.browse({ specialism: wanted })).rows).toHaveLength(1);
    // JSON_CONTAINS, not a LIKE over the serialised array — no partial slug match.
    expect((await RecruiterProfile.browse({ specialism: other })).rows).toHaveLength(0);
  });
});

maybe()('two agencies with the same name', () => {
  test('each gets its own slug', async () => {
    const second = await signUp({ email: 'agency-two@example.test', name: 'Second Owner', roles: 'recruiter' });
    const form = await second.get('/recruiters/profile');
    await second
      .post('/recruiters/profile')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        // Two agencies called "SAP Talent" is the ordinary case, not the odd one.
        agency_name: `${TERM} Talent`,
        about: 'A different agency that happens to share a name.',
        country: 'AT'
      });

    const a = await RecruiterProfile.findByUserId(await userId('agency-one@example.test'));
    const b = await RecruiterProfile.findByUserId(await userId('agency-two@example.test'));
    expect(a.slug).not.toBe(b.slug);
  });
});
