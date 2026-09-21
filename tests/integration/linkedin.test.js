'use strict';

/**
 * LinkedIn confirmation, against a real database and the real routes — but never the real
 * provider. The two outbound calls are faked, and nothing here touches linkedin.com.
 *
 * What is actually at stake is the BADGE. `consultant_profiles.linkedin_verified` is read
 * by the directory's ranking expression, by the consultant card, by the profile page and
 * by Application.js, and before this area nothing could ever set it. So the tests are
 * mostly about the one rule that makes the flag safe to denormalise: the identity row and
 * the flag move together, always, in both directions.
 */

// Set before anything is required: config/config.js reads the environment at load, and
// with no credentials the routes answer "not switched on" and never reach the fake.
process.env.LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || 'test-client-id';
process.env.LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || 'test-client-secret';

const request = require('supertest');
const { promisePool } = require('../../config/database');
const ExternalIdentity = require('../../models/ExternalIdentity');
const linkedin = require('../../utils/linkedin');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = ['li-one@example.test', 'li-two@example.test'];
const CSRF_FORM = /name="_csrf" value="([^"]+)"/;
const CSRF_META = /<meta name="csrf-token" content="([^"]+)"/;

function csrfFrom(html) {
  const match = html.match(CSRF_FORM) || html.match(CSRF_META);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

async function signUp({ email, name }) {
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
      user_types: 'consultant',
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

async function verifiedFlag(email) {
  const [[row]] = await promisePool.query(
    'SELECT linkedin_verified, linkedin_verified_at FROM consultant_profiles WHERE user_id = ?',
    [await userId(email)]
  );
  return row;
}

/**
 * Drive the callback without leaving the process.
 *
 * `exchangeCode` and `fetchIdentity` are the only two functions that reach the network,
 * so replacing them is the whole of the fake. The state, the session, the routing and
 * every database write below are the real ones.
 */
function fakeProvider({ subject, name }) {
  linkedin.exchangeCode = async () => 'an-access-token';
  linkedin.fetchIdentity = async () => ({ subject, name });
}

/** Start the flow properly and return the state the session is actually holding. */
async function startFlow(agent) {
  const res = await agent.get('/linkedin/start');
  expect(res.status).toBe(302);
  return new URL(res.headers.location).searchParams.get('state');
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('it is a linking flow, never a sign-in', () => {
  test('starting it without a session is refused', async () => {
    const res = await request(app).get('/linkedin/start');
    // 302 to the login page: supertest sends no Sec-Fetch-Dest, so the guard reads this
    // as a navigation. See CLAUDE.md.
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/login/);
  });

  test('the callback without a session is refused too', async () => {
    // A callback that worked without a session would be a sign-in path by another name.
    const res = await request(app).get('/linkedin/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/auth\/login/);
  });

  test('no account is ever created by this flow', async () => {
    const [[before]] = await promisePool.query('SELECT COUNT(*) AS n FROM users');
    await request(app).get('/linkedin/callback?code=x&state=y');
    const [[after]] = await promisePool.query('SELECT COUNT(*) AS n FROM users');
    expect(after.n).toBe(before.n);
  });
});

maybe()('confirming an account', () => {
  let one;
  let two;

  beforeAll(async () => {
    one = await signUp({ email: 'li-one@example.test', name: 'Ana Pjetri' });
    two = await signUp({ email: 'li-two@example.test', name: 'Wolfgang Schmidt' });
  });

  test('the badge is off until somebody confirms', async () => {
    expect((await verifiedFlag('li-one@example.test')).linkedin_verified).toBe(0);
  });

  test('a completed flow sets the identity and the flag together', async () => {
    const state = await startFlow(one);
    fakeProvider({ subject: 'urn:li:person:AAA', name: 'Ana Pjetri' });

    const res = await one.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(identity.subject).toBe('urn:li:person:AAA');
    expect(identity.display_name).toBe('Ana Pjetri');
    expect(identity.name_matched).toBe(1);

    const flag = await verifiedFlag('li-one@example.test');
    expect(flag.linkedin_verified).toBe(1);
    expect(flag.linkedin_verified_at).not.toBeNull();
  });

  test('nothing about the access token is written anywhere', async () => {
    /*
     * The token is used for one request and dropped. Holding a credential that can act as
     * the member, on a machine with no reason to, is a liability with no purpose — so the
     * table has no column that could take one.
     */
    const [columns] = await promisePool.query('SHOW COLUMNS FROM external_identities');
    const names = columns.map((c) => c.Field);
    expect(names).not.toContain('access_token');
    expect(names).not.toContain('refresh_token');
    expect(names).not.toContain('profile_json');
    expect(names).not.toContain('email');
  });

  test('a mismatched name is recorded and surfaced, not refused', async () => {
    const state = await startFlow(two);
    // Shares no distinctive token with "Wolfgang Schmidt". A shared surname WOULD match,
    // and should: "W. Schmidt-Bauer" is the same person often enough that refusing it
    // would be the rule rejecting real people.
    fakeProvider({ subject: 'urn:li:person:BBB', name: 'Klaus Baumgartner' });

    await two.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-two@example.test'));
    // Linked anyway: people legitimately differ between the two sides, and refusing on a
    // name comparison rejects real people to catch a case it cannot catch anyway.
    expect(identity).toBeTruthy();
    expect(identity.name_matched).toBe(0);
    expect((await verifiedFlag('li-two@example.test')).linkedin_verified).toBe(1);
  });

  test('re-confirming refreshes the name rather than duplicating the row', async () => {
    const state = await startFlow(one);
    fakeProvider({ subject: 'urn:li:person:AAA', name: 'Ana Maria Pjetri' });
    await one.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    const [[{ n }]] = await promisePool.query(
      'SELECT COUNT(*) AS n FROM external_identities WHERE user_id = ?',
      [await userId('li-one@example.test')]
    );
    expect(n).toBe(1);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(identity.display_name).toBe('Ana Maria Pjetri');
  });

  test('one LinkedIn account cannot badge a second Hub account', async () => {
    const state = await startFlow(two);
    // The same subject account one already holds.
    fakeProvider({ subject: 'urn:li:person:AAA', name: 'Ana Pjetri' });
    await two.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    // Refused rather than moved: silently transferring it would let somebody take a badge
    // off an account they do not control.
    const stillOne = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(stillOne.subject).toBe('urn:li:person:AAA');

    const other = await ExternalIdentity.find('linkedin', await userId('li-two@example.test'));
    expect(other.subject).toBe('urn:li:person:BBB');
  });
});

maybe()('the state is the CSRF defence on the callback', () => {
  let agent;

  beforeAll(async () => {
    agent = await signUp({ email: 'li-one@example.test', name: 'Ana Pjetri' }).catch(async () => {
      const client = request.agent(app);
      const login = await client.get('/auth/login');
      await client
        .post('/auth/login')
        .type('form')
        .send({ _csrf: csrfFrom(login.text), email: 'li-one@example.test', password: 'Sup3rSecret' });
      return client;
    });
  });

  test('a callback with no state at all changes nothing', async () => {
    fakeProvider({ subject: 'urn:li:person:EVIL', name: 'Attacker' });
    const res = await agent.get('/linkedin/callback?code=good');
    expect(res.status).toBe(302);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(identity.subject).not.toBe('urn:li:person:EVIL');
  });

  test('a callback with a forged state changes nothing', async () => {
    await startFlow(agent);
    fakeProvider({ subject: 'urn:li:person:EVIL', name: 'Attacker' });

    const res = await agent.get('/linkedin/callback?code=good&state=not-the-one-we-issued');
    expect(res.status).toBe(302);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(identity.subject).not.toBe('urn:li:person:EVIL');
  });

  test('a state is single-use: replaying it fails', async () => {
    const state = await startFlow(agent);
    fakeProvider({ subject: 'urn:li:person:AAA', name: 'Ana Pjetri' });
    await agent.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    // Consumed on the way in, whatever happened next: a state that survives an attempt is
    // a state that can be replayed.
    fakeProvider({ subject: 'urn:li:person:EVIL', name: 'Attacker' });
    await agent.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    const identity = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(identity.subject).toBe('urn:li:person:AAA');
  });

  test('a cancelled authorisation changes nothing and does not alarm anybody', async () => {
    const before = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    const res = await agent.get('/linkedin/callback?error=user_cancelled_login');
    expect(res.status).toBe(302);

    const after = await ExternalIdentity.find('linkedin', await userId('li-one@example.test'));
    expect(after.subject).toBe(before.subject);
  });
});

maybe()('disconnecting', () => {
  let agent;

  beforeAll(async () => {
    agent = request.agent(app);
    const login = await agent.get('/auth/login');
    await agent
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'li-one@example.test', password: 'Sup3rSecret' });
  });

  test('the badge never outlives the proof', async () => {
    expect((await verifiedFlag('li-one@example.test')).linkedin_verified).toBe(1);

    const settings = await agent.get('/profile/settings');
    await agent
      .post('/linkedin/disconnect')
      .type('form')
      .send({ _csrf: csrfFrom(settings.text) });

    expect(await ExternalIdentity.find('linkedin', await userId('li-one@example.test'))).toBeNull();
    const flag = await verifiedFlag('li-one@example.test');
    expect(flag.linkedin_verified).toBe(0);
    expect(flag.linkedin_verified_at).toBeNull();
  });

  test('the flag is cleared even when there was no identity row to delete', async () => {
    // Belt and braces, and the one outcome that must be impossible: a badge with nothing
    // behind it. Set the flag by hand, as a stray write elsewhere would.
    await promisePool.query('UPDATE consultant_profiles SET linkedin_verified = 1 WHERE user_id = ?', [
      await userId('li-one@example.test')
    ]);

    await ExternalIdentity.unlink('linkedin', await userId('li-one@example.test'));
    expect((await verifiedFlag('li-one@example.test')).linkedin_verified).toBe(0);
  });

  test('the same account can be confirmed again afterwards', async () => {
    const state = await startFlow(agent);
    fakeProvider({ subject: 'urn:li:person:AAA', name: 'Ana Pjetri' });
    await agent.get(`/linkedin/callback?code=good&state=${encodeURIComponent(state)}`);

    expect((await verifiedFlag('li-one@example.test')).linkedin_verified).toBe(1);
  });
});
