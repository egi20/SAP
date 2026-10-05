'use strict';

/**
 * The talent directory is anonymous to a reader who is not signed in.
 *
 * The consultants most worth talking to are the ones currently working, and they are the
 * ones with most to lose from a public listing their employer can read. So this is not a
 * conversion device: it is the reason the directory can carry people who are employed at
 * all. Which makes it a claim worth testing on EVERY surface a profile reaches, because
 * one that holds on the list and leaks on the search page protects nobody.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const ConsultantProfile = require('../../models/ConsultantProfile');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const OWN = ['anon-con@example.test', 'anon-viewer@example.test', 'anon-peer@example.test'];
const NAME = 'Zyloteq Anonymisable';
const HEADLINE = 'Zyloteq EWM rollout specialist';
const CSRF = /name="_csrf" value="([^"]+)"/;

let app;
let consultantId;

function csrfFrom(html) {
  const match = html.match(CSRF);
  if (!match) throw new Error('No CSRF token on that page');
  return match[1];
}

/** A signed-in agent, to prove the name IS shown to an account. */
async function signedInAgent(as = OWN[1]) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({
    _csrf: csrfFrom(page.text), email: as, password: 'Anon-Test-Pass-1'
  });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const consultant = await User.create({
    email: OWN[0], password: 'Anon-Test-Pass-1', name: NAME, roles: ['consultant']
  });
  consultantId = consultant.id;
  await User.setEmailVerified(consultantId);

  const viewer = await User.create({
    email: OWN[1], password: 'Anon-Test-Pass-1', name: 'Anon Viewer', roles: ['company']
  });
  await User.setEmailVerified(viewer.id);

  // A second reader who is signed in but is NOT a hiring account — the case the contact
  // block used to answer with a login button.
  const peer = await User.create({
    email: OWN[2], password: 'Anon-Test-Pass-1', name: 'Anon Peer', roles: ['consultant']
  });
  await User.setEmailVerified(peer.id);

  await ConsultantProfile.ensureExists(consultantId);
  await ConsultantProfile.update(consultantId, {
    headline: HEADLINE,
    bio: 'Fifteen years of warehouse work.',
    primary_role: 's4-ewm',
    seniority: 'senior',
    country: 'DE',
    years_experience: 15,
    full_lifecycles: 4,
    day_rate: 950,
    currency: 'EUR',
    availability: 'immediate',
    work_mode: 'remote'
  });

  // Publishing is gated on a completeness floor, so it is a separate call that can refuse —
  // and if it refuses here the fixture is wrong and every assertion below would be vacuous.
  const published = await ConsultantProfile.setPublic(consultantId, true);
  if (!published.published) {
    throw new Error(`Fixture profile is only ${published.completeness}% complete and will not publish`);
  }
});

maybe()('a reader who is not signed in', () => {
  it('finds the profile in the directory, and cannot see who it is', async () => {
    const res = await request(app).get('/consultants?q=Zyloteq');
    expect(res.status).toBe(200);
    // Found: redaction is not filtering. A directory that hid the rows would be lying
    // about how many people are in it.
    expect(res.text).toContain(HEADLINE);
    expect(res.text).not.toContain(NAME);
    expect(res.text).toContain('Sign in to view name');
  });

  it('is told why, once, rather than meeting a wall of blanks', async () => {
    const res = await request(app).get('/consultants');
    expect(res.text).toContain('viewing anonymised profiles');
  });

  it('cannot see the name on the profile page either', async () => {
    const res = await request(app).get(`/consultants/${consultantId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(HEADLINE);
    expect(res.text).not.toContain(NAME);
    expect(res.text).toContain('Name hidden');
  });

  it('does not get the name in the page title either', async () => {
    // The <title> is a separate serialisation of the same row, and the easiest one to miss.
    const res = await request(app).get(`/consultants/${consultantId}`);
    const title = res.text.match(/<title>([^<]*)<\/title>/)[1];
    expect(title).not.toContain(NAME);
  });

  it('cannot see the name through the search page', async () => {
    const res = await request(app).get('/search?q=Zyloteq');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(NAME);
  });

  it('cannot fetch the photograph', async () => {
    // A face identifies somebody as well as a name. Hiding one and serving the other is
    // anonymity that fools only the person relying on it.
    const res = await request(app).get(`/consultants/photo/${consultantId}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/images/avatar-placeholder.svg');
  });
});

maybe()('an account', () => {
  it('sees the name on the list and on the profile', async () => {
    const agent = await signedInAgent();

    const list = await agent.get('/consultants?q=Zyloteq');
    expect(list.text).toContain(NAME);
    expect(list.text).not.toContain('Sign in to view name');

    const profile = await agent.get(`/consultants/${consultantId}`);
    expect(profile.text).toContain(NAME);
  });
});

maybe()('redactFor', () => {
  it('defaults to redacted, so a forgotten viewer breaks visibly rather than leaking', () => {
    const row = { name: 'Ana', profile_picture: '/p.png', linkedin_url: 'https://x', headline: 'FI' };
    expect(ConsultantProfile.redactFor(row).name).toBeNull();
    expect(ConsultantProfile.redactFor(row).linkedin_url).toBeNull();
    expect(ConsultantProfile.redactFor(row, 7).name).toBe('Ana');
  });

  it('removes the name from the object rather than leaving it for a template to hide', () => {
    // A template that merely declines to print it has still shipped it to the browser in
    // whatever else the page serialises.
    const redacted = ConsultantProfile.redactFor({ name: 'Ana' });
    expect(Object.values(redacted)).not.toContain('Ana');
  });
});

/**
 * The jobs "posted within" window.
 *
 * It is here rather than in its own file because it shares the fixture accounts; what it
 * asserts is the one rule that makes the control trustworthy — the windows the form offers
 * and the windows the filter accepts are the same list.
 */
maybe()('the posted-within filter', () => {
  const Job = require('../../models/Job');

  it('offers exactly the windows it validates', async () => {
    const res = await request(app).get('/jobs');
    expect(res.status).toBe(200);
    Job.POSTED_WITHIN_DAYS.forEach((days) => {
      expect(res.text).toContain(`value="${days}"`);
    });
  });

  it('ignores a window it does not offer, rather than answering a question the form cannot ask', async () => {
    const res = await request(app).get('/jobs?posted_within=4000');
    expect(res.status).toBe(200);
    // Nothing selected: the value was dropped, not honoured.
    expect(res.text).not.toContain('value="4000"');
  });

  it('narrows to a window it does offer', async () => {
    const res = await request(app).get('/jobs?posted_within=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('value="1" selected');
  });
});

/**
 * Two more findings from a walkthrough with real data, both on the profile page and both
 * invisible on an empty database.
 */
maybe()('the profile page', () => {
  it('prints the certification\'s name and not just a tick', async () => {
    /*
     * The view read `c.name`; the row has no name column. The model derives `label` from
     * the catalogue, so a renamed exam updates on every profile holding it — and asking
     * for the wrong field rendered an empty string beside a green tick, which reads as a
     * certification with no title.
     */
    await ConsultantProfile.addCertification(consultantId, { code: 'C_S4EWM' });

    // Asserted against the catalogue's own label rather than a loose pattern, and NOT
    // inside a catch that would let the case pass by never running.
    const { certByCode } = require('../../config/certifications');
    const label = certByCode('C_S4EWM').label;
    expect(label).toBeTruthy();

    const agent = await signedInAgent();
    const res = await agent.get(`/consultants/${consultantId}`);
    expect(res.text).toContain('Certifications');
    expect(res.text).toContain(label);
  });

  it('does not offer a signed-in reader a button to sign in', async () => {
    /*
     * "Signed out" and "signed in as the wrong kind of account" shared a branch, so a
     * consultant reading another consultant's profile was offered a Sign in button leading
     * to a page they were already past. Signing in would not have helped — which is the
     * worst thing a button can promise.
     */
    const peer = await signedInAgent(OWN[2]);
    const res = await peer.get(`/consultants/${consultantId}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Sign in to contact');
    expect(res.text).toContain('hiring accounts only');
  });

  it('still offers it to somebody who really is signed out', async () => {
    const res = await request(app).get(`/consultants/${consultantId}`);
    expect(res.text).toContain('Sign in to contact');
  });

  it('shows the contact details to a hiring account', async () => {
    const company = await signedInAgent();
    const res = await company.get(`/consultants/${consultantId}`);
    expect(res.text).toContain('anon-con@example.test');
  });
});
