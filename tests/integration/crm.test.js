'use strict';

/**
 * The sales CRM against a real database.
 *
 * What is worth testing here is not that a lead saves. It is the three things that make
 * holding this data defensible and that are each one transaction away from being broken:
 * an unsubscribe erases the person AND writes the suppression AND keeps the record; a
 * suppressed address cannot be written back by the next import; and the source a lead was
 * acquired under cannot be rewritten by a later file.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const User = require('../../models/User');
const CrmLead = require('../../models/CrmLead');
const CrmDraft = require('../../models/CrmDraft');
const CrmSuppression = require('../../models/CrmSuppression');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

const PASSWORD = 'Crm-Test-Pass-1';
const OWN = ['crm-super@example.test', 'crm-admin@example.test', 'crm-member@example.test'];
const MARK = 'Crmtest';

let app;
let superId;
let superagent;
let plainAdmin;

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

async function signIn(email) {
  const agent = request.agent(app);
  const page = await agent.get('/auth/login');
  await agent.post('/auth/login').type('form').send({ _csrf: csrfFrom(page.text), email, password: PASSWORD });
  return agent;
}

const lead = (over = {}) => ({
  company: `${MARK} Nordwind GmbH`,
  contact_name: `${MARK} Petra Klein`,
  contact_email: 'crm-lead-1@example.test',
  source: 'event',
  source_detail: 'SAP Sapphire, June',
  product_lines: ['s4hana-finance'],
  ...over
});

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');

  // Cleared on the way IN, scoped to the rows this suite owns.
  await promisePool.query('DELETE FROM crm_leads WHERE company LIKE ?', [`${MARK}%`]);
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN]);

  const su = await User.create({ email: OWN[0], password: PASSWORD, name: 'Crm Super', roles: ['admin'] });
  superId = su.id;
  await User.setEmailVerified(superId);
  await User.adminSetRoles(superId, ['admin'], { primary: 'admin' });
  await User.setSuperadmin(superId, true);

  const admin = await User.create({ email: OWN[1], password: PASSWORD, name: 'Crm Admin', roles: ['admin'] });
  await User.setEmailVerified(admin.id);
  await User.adminSetRoles(admin.id, ['admin'], { primary: 'admin' });

  const member = await User.create({ email: OWN[2], password: PASSWORD, name: 'Crm Member', roles: ['consultant'] });
  await User.setEmailVerified(member.id);

  [superagent, plainAdmin] = await Promise.all([signIn(OWN[0]), signIn(OWN[1])]);
});

maybe()('who can open it', () => {
  it('a superadmin can', async () => {
    const res = await superagent.get('/crm');
    expect(res.status).toBe(200);
  });

  it('an ordinary administrator cannot', async () => {
    /*
     * The narrowest guard in the application, for the same reason /admin/rates carries
     * one: every screen here shows the contact details of people who never asked to be
     * contacted, and moderating a forum is not a reason to read them.
     */
    const res = await plainAdmin.get('/crm');
    expect(res.status).toBe(302);
  });

  it('and the tab is not rendered to one either', async () => {
    // A tab that answers 403 teaches people to ignore the navigation.
    const res = await plainAdmin.get('/admin');
    expect(res.text).not.toContain('href="/crm"');
  });
});

maybe()('unsubscribing', () => {
  let id;
  /*
   * A FRESH ADDRESS PER RUN, and the reason is the feature rather than the test.
   *
   * Nothing in this application removes a suppression — that is the whole design, and it
   * is why `crm_suppressions` has no foreign key to the leads. So a suite that suppresses
   * a fixed address passes once and then fails for ever after, because the second run
   * cannot create the lead it needs. Clearing the table in `beforeAll` would "fix" it by
   * deleting the one record this area exists to keep.
   */
  const leaveMe = `crm-leaveme-${Date.now()}@example.test`;

  beforeAll(async () => {
    if (!reachable) return;
    const created = await CrmLead.upsert(lead({ contact_email: leaveMe }), { actorUserId: superId });
    id = created.id;
    await CrmLead.addActivity(id, { outcome: 'sent', channel: 'email', note: 'First approach.', actorUserId: superId });
  });

  it('does three things in one transaction', async () => {
    const result = await CrmLead.setStatus(id, 'unsubscribed', {
      actorUserId: superId,
      note: 'Asked by reply.'
    });
    expect(result.erased).toBe(true);

    const after = await CrmLead.findById(id);

    // 1. The person is erased — not kept with a flag that a later query might forget.
    expect(after.contact_email).toBeNull();
    expect(after.contact_name).toBeNull();
    expect(after.job_title).toBeNull();
    expect(after.erased_at).not.toBeNull();

    // 2. The address is on the list, which is the half that survives the row.
    expect(await CrmSuppression.has(leaveMe)).toBe(true);

    // 3. The company and the record of what was sent stay. They carry no personal data and
    //    they are the answer to a question about what was sent and when.
    expect(after.company).toContain('Nordwind');
    const activities = await CrmLead.activitiesFor(id);
    expect(activities.some((a) => a.outcome === 'sent')).toBe(true);
    expect(activities.some((a) => a.to_status === 'unsubscribed')).toBe(true);
  });

  it('and the address cannot be written back afterwards', async () => {
    // The whole point of the list outliving the row: the next quarterly import must not
    // put them straight back in.
    await expect(
      CrmLead.upsert(lead({ contact_email: leaveMe }), { actorUserId: superId })
    ).rejects.toMatchObject({ code: 'SUPPRESSED' });
  });

  it('is terminal — nothing moves out of it', async () => {
    await expect(CrmLead.setStatus(id, 'contacted', { actorUserId: superId }))
      .rejects.toMatchObject({ code: 'BAD_TRANSITION' });
  });
});

maybe()('the source is first-touch', () => {
  it('a re-import corrects the details and never the provenance', async () => {
    const first = await CrmLead.upsert(
      lead({ contact_email: 'crm-provenance@example.test', source: 'event', source_detail: 'SAP Sapphire, June' }),
      { actorUserId: superId }
    );

    const again = await CrmLead.upsert(
      lead({
        contact_email: 'crm-provenance@example.test',
        contact_phone: '+49 30 123456',
        source: 'public_directory',
        source_detail: 'Some list somebody bought'
      }),
      { actorUserId: superId }
    );

    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);

    const row = await CrmLead.findById(first.id);
    // The phone number is new information. The source is the lawful-basis record, and a
    // record a later file can rewrite is not one.
    expect(row.contact_phone).toBe('+49 30 123456');
    expect(row.source).toBe('event');
    expect(row.source_detail).toBe('SAP Sapphire, June');

    // The disagreement is recorded rather than lost.
    const activities = await CrmLead.activitiesFor(first.id);
    expect(activities.some((a) => (a.note || '').includes('public_directory'))).toBe(true);
  });
});

maybe()('bulk actions', () => {
  it('abort entirely when the filter no longer matches what the screen showed', async () => {
    await CrmLead.upsert(lead({ contact_email: 'crm-bulk-1@example.test', company: `${MARK} Bulk One` }), { actorUserId: superId });
    await CrmLead.upsert(lead({ contact_email: 'crm-bulk-2@example.test', company: `${MARK} Bulk Two` }), { actorUserId: superId });

    const filters = { q: `${MARK} Bulk` };
    await expect(CrmLead.deleteFiltered(filters, 99)).rejects.toMatchObject({ code: 'BULK_COUNT_MISMATCH' });

    // And nothing moved.
    const { total } = await CrmLead.list(filters);
    expect(total).toBe(2);
  });

  it('never delete a lead somebody has actually contacted', async () => {
    /*
     * Its activity log is the answer to a complaint about that contact, and the log
     * cascades with the row. The way to remove one of these is `unsubscribed`, which
     * erases the person and keeps the record.
     */
    const contacted = await CrmLead.list({ q: `${MARK} Bulk One` });
    await CrmLead.addActivity(contacted.rows[0].id, { outcome: 'sent', actorUserId: superId });

    const filters = { q: `${MARK} Bulk` };
    const { deleted, kept } = await CrmLead.deleteFiltered(filters, 2);
    expect(deleted).toBe(1);
    expect(kept).toBe(1);

    const left = await CrmLead.list(filters);
    expect(left.rows.map((r) => r.company)).toEqual([`${MARK} Bulk One`]);
  });
});

maybe()('the import', () => {
  it('previews without writing anything', async () => {
    const page = await superagent.get('/crm/import');
    const res = await superagent.post('/crm/import').type('form').send({
      _csrf: csrfFrom(page.text),
      csv: `company,email\n${MARK} Preview AG,crm-preview@example.test\n`,
      source: 'event',
      source_detail: 'SAP Sapphire, June'
    });

    expect(res.status).toBe(200);
    expect(res.text).toContain(`${MARK} Preview AG`);

    const { total } = await CrmLead.list({ q: `${MARK} Preview` });
    expect(total).toBe(0);
  });

  it('writes on the second post, and refuses a suppressed address in the same file', async () => {
    await CrmSuppression.add('crm-blocked@example.test', { reason: 'requested', actorUserId: superId });

    const page = await superagent.get('/crm/import');
    const res = await superagent.post('/crm/import').type('form').send({
      _csrf: csrfFrom(page.text),
      csv:
        `company,email\n` +
        `${MARK} Written AG,crm-written@example.test\n` +
        `${MARK} Blocked AG,crm-blocked@example.test\n`,
      source: 'event',
      source_detail: 'SAP Sapphire, June',
      confirm: '1'
    });
    expect(res.status).toBe(302);

    const written = await CrmLead.list({ q: `${MARK} Written` });
    const blocked = await CrmLead.list({ q: `${MARK} Blocked` });
    expect(written.total).toBe(1);
    // Refused, not imported-and-flagged: a row that exists is a row somebody writes to.
    expect(blocked.total).toBe(0);
  });
});

maybe()('drafts', () => {
  it('record what was written and what was sent, and send nothing', async () => {
    const created = await CrmLead.upsert(lead({ contact_email: 'crm-draft@example.test', company: `${MARK} Draft AG` }), {
      actorUserId: superId
    });

    const draft = await CrmDraft.create(created.id, { body: 'A first approach.', actorUserId: superId });
    await CrmDraft.saveEdit(draft.id, created.id, 'A first approach, in my own words.');

    const [before] = await CrmDraft.forLead(created.id);
    // Both halves survive: what it started as, and what a person actually sent.
    expect(before.body).toBe('A first approach.');
    expect(before.edited_body).toBe('A first approach, in my own words.');
    expect(before.marked_sent_at).toBeNull();
    // Hand-written, so there is no model to name.
    expect(before.model).toBeNull();

    expect(await CrmDraft.markSent(draft.id, created.id)).toBe(true);
    // Only ever set from NULL, so a second click cannot re-date a send.
    expect(await CrmDraft.markSent(draft.id, created.id)).toBe(false);
  });
});
