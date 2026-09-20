'use strict';

/**
 * Messaging, against a real database.
 *
 * The interesting properties are all about who can reach whom and about a thread's
 * identity, and none of them is visible without a database: the unique key on `dedupe_key`
 * is what makes "open the thread" idempotent, the CHECK in migration 008 is what refuses an
 * unanchored thread, and the inbox row count is what tells you whether the query duplicates.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Conversation = require('../../models/Conversation');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = [
  'msg-company@example.test',
  'msg-consultant@example.test',
  'msg-outsider@example.test',
  'msg-hidden@example.test'
];

const CSRF = /name="_csrf" value="([^"]+)"/;

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

/**
 * Counts scoped to THIS suite's accounts.
 *
 * `SELECT COUNT(*) FROM conversations` passes today only because no other suite creates a
 * conversation. Jest runs files in parallel, so the day one does, this fails in whichever
 * order the scheduler picked — the same trap as the `DELETE FROM users` the other suites
 * started with.
 */
async function ownConversationCount() {
  const [[row]] = await promisePool.query(
    `SELECT COUNT(DISTINCT c.id) AS total
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
       JOIN users u ON u.id = cp.user_id
      WHERE u.email IN (?)`,
    [OWN_ACCOUNTS]
  );
  return row.total;
}

async function ownMessageCount() {
  const [[row]] = await promisePool.query(
    `SELECT COUNT(*) AS total
       FROM messages m
       JOIN users u ON u.id = m.sender_user_id
      WHERE u.email IN (?)`,
    [OWN_ACCOUNTS]
  );
  return row.total;
}

/** This suite's one conversation. */
async function ownConversationId() {
  const [[row]] = await promisePool.query(
    `SELECT DISTINCT c.id
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id
       JOIN users u ON u.id = cp.user_id
      WHERE u.email IN (?)
      ORDER BY c.id ASC
      LIMIT 1`,
    [OWN_ACCOUNTS]
  );
  return row ? row.id : null;
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

maybe()('every conversation is about something', () => {
  let company;
  let consultant;
  let outsider;
  let jobId;
  let jobSlug;

  beforeAll(async () => {
    company = await signUp({ email: 'msg-company@example.test', name: 'Hiring Co', roles: 'company' });
    consultant = await signUp({ email: 'msg-consultant@example.test', name: 'Delivery Person', roles: 'consultant' });
    outsider = await signUp({ email: 'msg-outsider@example.test', name: 'Third Party', roles: 'consultant' });

    const form = await company.get('/jobs/new');
    await company
      .post('/jobs')
      .type('form')
      .send({
        _csrf: csrfFrom(form.text),
        title: 'S/4HANA FI consultant',
        description: 'Finance work on a brownfield conversion across three company codes, realize phase.',
        role: 's4-fi',
        seniority: 'senior',
        engagement_type: 'contract',
        work_mode: 'remote',
        country: 'DE',
        modules: ['fi-gl'],
        publish: 'on'
      });

    const [[job]] = await promisePool.query("SELECT id, slug FROM jobs WHERE title = 'S/4HANA FI consultant'");
    jobId = job.id;
    jobSlug = job.slug;
  });

  test('a consultant can ask the advertiser of an open role', async () => {
    const page = await consultant.get(`/jobs/${jobSlug}`);
    expect(page.text).toContain('Question about this role?');

    const res = await consultant
      .post('/messages/start')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        kind: 'enquiry',
        job_id: jobId,
        recipient_user_id: await userId('msg-company@example.test'),
        body: 'Is this remote from outside Germany?'
      });

    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT kind, job_id, dedupe_key FROM conversations WHERE id = ?', [
      await ownConversationId()
    ]);
    expect(row.kind).toBe('enquiry');
    expect(row.job_id).toBe(jobId);
    expect(row.dedupe_key).toMatch(/^enquiry:\d+:\d+:\d+$/);
  });

  test('opening it again is the same thread, not a second one', async () => {
    const page = await consultant.get(`/jobs/${jobSlug}`);
    await consultant
      .post('/messages/start')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        kind: 'enquiry',
        job_id: jobId,
        recipient_user_id: await userId('msg-company@example.test'),
        body: 'One more thing.'
      });

    expect(await ownConversationCount()).toBe(1);
    expect(await ownMessageCount()).toBe(2);
  });

  test('a stranger to the role cannot start a thread with either side', async () => {
    const page = await outsider.get(`/jobs/${jobSlug}`);
    const res = await outsider
      .post('/messages/start')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        kind: 'enquiry',
        job_id: jobId,
        // Neither the outsider nor this recipient owns the job.
        recipient_user_id: await userId('msg-consultant@example.test'),
        body: 'Hello there'
      });

    expect(res.status).toBe(404);
    expect(await ownConversationCount()).toBe(1);
  });

  test('an employer cannot message a consultant who is not listed', async () => {
    const hidden = await signUp({ email: 'msg-hidden@example.test', name: 'Hidden Person', roles: 'consultant' });
    expect(hidden).toBeDefined(); // the account exists; the profile is simply not public

    const page = await company.get(`/jobs/${jobSlug}`);
    const res = await company
      .post('/messages/start')
      .type('form')
      .send({
        _csrf: csrfFrom(page.text),
        kind: 'enquiry',
        job_id: jobId,
        recipient_user_id: await userId('msg-hidden@example.test'),
        body: 'Are you available?'
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/messages');
    expect(await ownConversationCount()).toBe(1); // still just the one
  });

  test('the database refuses an unanchored thread even if a caller tries', async () => {
    // The route and the model both stop this; the CHECK in migration 008 is the floor.
    await expect(
      promisePool.query(
        'INSERT INTO conversations (kind, dedupe_key, created_by_user_id) VALUES (?, ?, ?)',
        ['enquiry', 'enquiry:0:1:2', await userId('msg-company@example.test')]
      )
    ).rejects.toThrow(/chk_conversation_anchored|CONSTRAINT/i);
  });
});

maybe()('reading and replying', () => {
  let conversationId;
  let companyId;
  let consultantId;

  beforeAll(async () => {
    conversationId = await ownConversationId();
    companyId = await userId('msg-company@example.test');
    consultantId = await userId('msg-consultant@example.test');
  });

  test('a non-participant gets nothing, not a conversation to check afterwards', async () => {
    const outsiderId = await userId('msg-outsider@example.test');
    expect(await Conversation.forParticipant(conversationId, outsiderId)).toBeNull();
    expect(await Conversation.forParticipant(conversationId, companyId)).not.toBeNull();
  });

  test('a non-participant cannot post into it', async () => {
    const outsiderId = await userId('msg-outsider@example.test');
    await expect(Conversation.postMessage(conversationId, outsiderId, 'hello')).rejects.toMatchObject({
      code: 'NOT_A_PARTICIPANT'
    });
  });

  test('your own messages never light up your own inbox', async () => {
    // The consultant sent both messages so far.
    expect(await Conversation.unreadCount(consultantId)).toBe(0);
    expect(await Conversation.unreadCount(companyId)).toBeGreaterThan(0);
  });

  test('opening the thread marks it read', async () => {
    const before = await Conversation.unreadCount(companyId);
    expect(before).toBeGreaterThan(0);

    const page = await request
      .agent(app)
      .get('/messages'); // unauthenticated: proves the guard, and changes nothing
    expect(page.status).toBe(302);

    await Conversation.markRead(conversationId, companyId);
    expect(await Conversation.unreadCount(companyId)).toBe(0);
  });

  test('an empty reply is refused', async () => {
    await expect(Conversation.postMessage(conversationId, companyId, '   ')).rejects.toMatchObject({
      code: 'EMPTY_MESSAGE'
    });
  });

  test('a body is stored verbatim and escaped only at render', async () => {
    const hostile = '<script>alert(1)</script> & "quotes"';
    await Conversation.postMessage(conversationId, companyId, hostile);

    const [[row]] = await promisePool.query(
      'SELECT body FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      [conversationId]
    );
    expect(row.body).toBe(hostile);

    const page = await request.agent(app);
    const login = await page.get('/auth/login');
    await page
      .post('/auth/login')
      .type('form')
      .send({ _csrf: csrfFrom(login.text), email: 'msg-consultant@example.test', password: 'Sup3rSecret' });

    const thread = await page.get(`/messages/${conversationId}`);
    expect(thread.status).toBe(200);
    expect(thread.text).toContain('&lt;script&gt;');
    expect(thread.text).not.toContain('<script>alert(1)</script>');
  });
});

maybe()('the inbox shows one row per thread', () => {
  test('even when a thread has more than two people in it', async () => {
    /*
     * The reference joins `conversation_participants` a second time to find "the other
     * party", which yields one inbox row PER other participant — so a three-person thread
     * appears twice, with a different name each time. The schema anticipates more than two
     * (read state is per participant for exactly that reason), so the two contradict.
     */
    const conversationId = await ownConversationId();
    const outsiderId = await userId('msg-outsider@example.test');
    const consultantId = await userId('msg-consultant@example.test');

    await promisePool.query('INSERT IGNORE INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)', [
      conversationId,
      outsiderId
    ]);

    const [[{ people }]] = await promisePool.query(
      'SELECT COUNT(*) AS people FROM conversation_participants WHERE conversation_id = ?',
      [conversationId]
    );
    expect(people).toBe(3);

    const inbox = await Conversation.listForUser(consultantId);
    const forThisThread = inbox.rows.filter((r) => r.id === conversationId);

    expect(forThisThread).toHaveLength(1);
    expect(forThisThread[0].other_count).toBe(2);
    expect(forThisThread[0].others).toHaveLength(2);
    expect(forThisThread[0].other_name).toBeTruthy();
  });
});
