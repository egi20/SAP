'use strict';

/**
 * The admin surface, against a real database.
 *
 * Two things are being tested here and they are not the same thing. One is the guard: who
 * can reach which screen, and what a refused request actually gets back. The other is the
 * arithmetic behind a moderation decision — the counter, the accepted-answer mark and the
 * points ledger all move with a hidden flag, and the only way to see whether they moved
 * correctly is to hide something and read the rows afterwards.
 *
 * The ledger cases are the point of the file. Hiding is a TOGGLE, and a toggle is where
 * the reference's award/reverse pairing goes wrong: a key it has already consumed makes
 * the second half of the second cycle a silent no-op. The final assertion drives three
 * half-cycles and checks the author's balance is a function of the current state rather
 * than of how many times a moderator changed their mind.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const Moderation = require('../../models/Moderation');
const Points = require('../../models/Points');
const Post = require('../../models/Post');
const { POINT_AWARDS } = require('../../config/community');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);

let app;

const OWN_ACCOUNTS = [
  'admin-super@example.test',
  'admin-plain@example.test',
  'admin-member@example.test',
  'admin-answerer@example.test'
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

async function userId(email) {
  const [[row]] = await promisePool.query('SELECT id FROM users WHERE email = ?', [email]);
  return row.id;
}

/** Sign the account in again, so the session carries the privileges just granted. */
async function reSignIn(email) {
  const agent = request.agent(app);
  const login = await agent.get('/auth/login');
  await agent
    .post('/auth/login')
    .type('form')
    .send({ _csrf: csrfFrom(login.text), email, password: 'Sup3rSecret' });
  return agent;
}

beforeAll(async () => {
  if (!reachable) return;
  app = require('../../server');
  await promisePool.query('DELETE FROM users WHERE email IN (?)', [OWN_ACCOUNTS]);
});

maybe()('who can reach the admin surface', () => {
  let member;
  let plainAdmin;
  let superAdmin;

  beforeAll(async () => {
    member = await signUp({ email: 'admin-member@example.test', name: 'Ordinary Member', roles: 'consultant' });

    await signUp({ email: 'admin-plain@example.test', name: 'Plain Admin', roles: 'consultant' });
    await promisePool.query("UPDATE users SET user_type = 'admin' WHERE email = ?", ['admin-plain@example.test']);
    plainAdmin = await reSignIn('admin-plain@example.test');

    await signUp({ email: 'admin-super@example.test', name: 'Super Admin', roles: 'consultant' });
    await promisePool.query("UPDATE users SET user_type = 'admin', is_superadmin = 1 WHERE email = ?", [
      'admin-super@example.test'
    ]);
    superAdmin = await reSignIn('admin-super@example.test');
  });

  /*
   * 302, not 401, and the choice is deliberate: supertest sends no `Sec-Fetch-Dest`, so
   * `middleware/auth.js` reads the request as a top-level navigation and answers with a
   * flash and a redirect. A browser `fetch()` would send `Sec-Fetch-Dest: empty` and get
   * 401 from the same guard. See CLAUDE.md.
   */
  test('an ordinary member is redirected away from every admin screen', async () => {
    for (const path of ['/admin', '/admin/users', '/admin/moderation', '/admin/payments']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await member.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/\/auth\/login|^\/$/);
    }
  });

  test('an admin who is not a superadmin gets the ordinary screens and not the narrow ones', async () => {
    expect((await plainAdmin.get('/admin')).status).toBe(200);
    expect((await plainAdmin.get('/admin/users')).status).toBe(200);
    expect((await plainAdmin.get('/admin/moderation')).status).toBe(200);

    // The two screens that show one person's figures and the switches that close the site.
    expect((await plainAdmin.get('/admin/rates')).status).toBe(302);
    expect((await plainAdmin.get('/admin/settings')).status).toBe(302);
  });

  test('the tab strip does not offer a screen the account cannot open', async () => {
    const plain = await plainAdmin.get('/admin');
    expect(plain.text).not.toContain('href="/admin/settings"');

    const superuser = await superAdmin.get('/admin');
    expect(superuser.text).toContain('href="/admin/settings"');
  });

  test('a role change refuses to act on your own account', async () => {
    const page = await superAdmin.get('/admin/users');
    const id = await userId('admin-super@example.test');

    const res = await superAdmin
      .post(`/admin/users/${id}/roles`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), roles: ['consultant'] });

    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT user_type FROM users WHERE id = ?', [id]);
    // Still an admin: locking yourself out of the only screen that could undo it is not
    // an action this form offers.
    expect(row.user_type).toBe('admin');
  });

  test('a deactivation refuses to act on your own account', async () => {
    const page = await superAdmin.get('/admin/users');
    const id = await userId('admin-super@example.test');

    await superAdmin
      .post(`/admin/users/${id}/active`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text) });

    const [[row]] = await promisePool.query('SELECT is_active FROM users WHERE id = ?', [id]);
    expect(Boolean(row.is_active)).toBe(true);
  });

  test('a plain admin cannot grant itself a privileged role through the roles form', async () => {
    const page = await plainAdmin.get('/admin/users');
    const victim = await userId('admin-member@example.test');

    const res = await plainAdmin
      .post(`/admin/users/${victim}/roles`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), roles: ['admin'] });

    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT user_type FROM users WHERE id = ?', [victim]);
    expect(row.user_type).not.toBe('admin');
  });
});

maybe()('hiding content moves everything that hangs off it', () => {
  let superAdmin;
  let authorId;
  let answererId;
  let postId;
  let postSlug;
  let replyId;

  beforeAll(async () => {
    await signUp({ email: 'admin-answerer@example.test', name: 'Answering Person', roles: 'consultant' });
    superAdmin = await reSignIn('admin-super@example.test');

    authorId = await userId('admin-member@example.test');
    answererId = await userId('admin-answerer@example.test');

    const [[category]] = await promisePool.query('SELECT id FROM post_categories LIMIT 1');
    const created = await Post.create(authorId, {
      categoryId: category.id,
      kind: 'question',
      title: 'How is EWM decentralised warehousing licensed on S/4HANA?',
      body: 'Asking because the answer decides whether the programme needs a separate stack.'
    });
    postId = created.id;
    postSlug = created.slug;

    const replied = await Post.reply(postId, answererId, 'It depends on the deployment option you pick.');
    replyId = replied.replyId;
    await Post.acceptSolution(postId, replyId, authorId);
  });

  test('a hidden post leaves the public list and takes its points with it', async () => {
    const before = await Points.totalFor(authorId);

    const page = await superAdmin.get('/admin/moderation');
    const res = await superAdmin
      .post(`/admin/moderation/posts/${postId}`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), hidden: 'true', reason: 'Testing the queue' });
    expect(res.status).toBe(302);

    const [[row]] = await promisePool.query('SELECT hidden_at, hidden_reason FROM posts WHERE id = ?', [postId]);
    expect(row.hidden_at).not.toBeNull();
    expect(row.hidden_reason).toBe('Testing the queue');

    // Gone from the public list, through the same builder the reader uses.
    const listed = await Post.browse({}, { limit: 50, offset: 0, sort: 'recent' });
    expect(listed.rows.map((p) => p.id)).not.toContain(postId);

    expect(await Points.totalFor(authorId)).toBe(before - POINT_AWARDS.post_created.points);
  });

  test('the decision is on the record, with who and why', async () => {
    const { rows } = await Moderation.events({ limit: 10 });
    const entry = rows.find((e) => e.subject_type === 'post' && e.subject_id === postId);

    expect(entry).toBeTruthy();
    expect(entry.action).toBe('hide');
    expect(entry.reason).toBe('Testing the queue');
    expect(entry.subject_user_id).toBe(authorId);
    expect(entry.actor_name).toBe('Super Admin');
  });

  /*
   * The case the reference gets wrong.
   *
   * It keys each adjustment on a fresh moderation event, which works, but makes the
   * balance a function of the SEQUENCE of decisions. Settling keys on the content, so the
   * balance is a function of the current state: after hide → restore → hide the author is
   * exactly one award down, no matter how many times the flag moved.
   */
  test('hiding, restoring and hiding again leaves the author exactly one award down', async () => {
    const hiddenOnce = await Points.totalFor(authorId);

    const page = await superAdmin.get('/admin/moderation');
    const token = csrfFrom(page.text);

    await superAdmin.post(`/admin/moderation/posts/${postId}`).type('form').send({ _csrf: token, hidden: 'false' });
    const restored = await Points.totalFor(authorId);
    expect(restored).toBe(hiddenOnce + POINT_AWARDS.post_created.points);

    await superAdmin.post(`/admin/moderation/posts/${postId}`).type('form').send({ _csrf: token, hidden: 'true' });
    expect(await Points.totalFor(authorId)).toBe(hiddenOnce);

    // And every swing is on the ledger: append-only, so nothing was edited away.
    const [[{ entries }]] = await promisePool.query(
      "SELECT COUNT(*) AS entries FROM points_ledger WHERE dedupe_key LIKE ?",
      [`post:${postId}#%`]
    );
    expect(Number(entries)).toBe(4);
  });

  test('pressing hide on something already hidden changes nothing', async () => {
    const before = await Points.totalFor(authorId);
    const result = await Moderation.setPostHidden(postId, true, { actorUserId: 1, reason: 'again' });

    expect(result.changed).toBe(false);
    expect(await Points.totalFor(authorId)).toBe(before);
  });

  test('hiding the accepted answer un-solves the question and settles both awards', async () => {
    await Moderation.setPostHidden(postId, false, { actorUserId: null });
    const before = await Points.totalFor(answererId);

    const [[postBefore]] = await promisePool.query('SELECT reply_count, is_solved FROM posts WHERE id = ?', [postId]);
    expect(Boolean(postBefore.is_solved)).toBe(true);

    const result = await Moderation.setReplyHidden(replyId, true, { actorUserId: null, reason: 'wrong answer' });
    expect(result.changed).toBe(true);

    const [[postAfter]] = await promisePool.query(
      'SELECT reply_count, is_solved, solution_reply_id FROM posts WHERE id = ?',
      [postId]
    );
    // A question must never point at content nobody can read.
    expect(Boolean(postAfter.is_solved)).toBe(false);
    expect(postAfter.solution_reply_id).toBeNull();
    expect(postAfter.reply_count).toBe(postBefore.reply_count - 1);

    expect(await Points.totalFor(answererId)).toBe(
      before - POINT_AWARDS.reply_created.points - POINT_AWARDS.reply_accepted.points
    );
  });

  test('restoring the reply gives back the writing points but not the solution mark', async () => {
    const before = await Points.totalFor(answererId);
    await Moderation.setReplyHidden(replyId, false, { actorUserId: null });

    const [[row]] = await promisePool.query('SELECT is_solution FROM post_replies WHERE id = ?', [replyId]);
    // Whether this is still the best answer is the asker's call, not a side effect of an
    // administrator undoing a removal.
    expect(Boolean(row.is_solution)).toBe(false);

    expect(await Points.totalFor(answererId)).toBe(before + POINT_AWARDS.reply_created.points);
  });

  test('a post that does not exist is reported, not thrown at the user', async () => {
    const page = await superAdmin.get('/admin/moderation');
    const res = await superAdmin
      .post('/admin/moderation/posts/999999')
      .type('form')
      .send({ _csrf: csrfFrom(page.text), hidden: 'true' });

    expect(res.status).toBe(302);
    expect(postSlug).toBeTruthy();
  });
});

maybe()('voiding a rate submission', () => {
  let superAdmin;
  let contributorId;
  let submissionId;

  beforeAll(async () => {
    superAdmin = await reSignIn('admin-super@example.test');
    contributorId = await userId('admin-member@example.test');

    const RateSubmission = require('../../models/RateSubmission');
    const submitted = await RateSubmission.submit(contributorId, {
      role: 's4-fi',
      seniority: 'senior',
      engagementType: 'contract',
      workMode: 'remote',
      country: 'DE',
      amount: 950,
      currency: 'EUR'
    });
    submissionId = submitted.id;
    // The route pays this; here the model is driven directly, so pay it the same way.
    await require('../../models/Points').settleTo(
      contributorId,
      'rate_contributed',
      `rate:${submissionId}`,
      POINT_AWARDS.rate_contributed.points
    );
  });

  test('the figure leaves every aggregate and the points go with it', async () => {
    const before = await Points.totalFor(contributorId);

    const page = await superAdmin.get('/admin/rates');
    const res = await superAdmin
      .post(`/admin/moderation/rates/${submissionId}`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), hidden: 'true', reason: 'annual salary in a day rate field' });
    expect(res.status).toBe(302);

    const [[row]] = await promisePool.query('SELECT voided_at, void_reason FROM rate_submissions WHERE id = ?', [
      submissionId
    ]);
    expect(row.voided_at).not.toBeNull();
    expect(row.void_reason).toBe('annual salary in a day rate field');

    // `voided_at IS NULL` is in every query in the model and there is no opt-out, so the
    // row is simply not there any more as far as the index is concerned.
    const RateSubmission = require('../../models/RateSubmission');
    const rows = await RateSubmission.rowsFor({
      role: 's4-fi',
      seniority: 'senior',
      engagementType: 'contract',
      periods: [row.voided_at ? new Date().toISOString().slice(0, 7) : '']
    });
    expect(rows.map((r) => r.id)).not.toContain(submissionId);

    expect(await Points.totalFor(contributorId)).toBe(before - POINT_AWARDS.rate_contributed.points);
  });

  test('re-submitting under a voided row says so instead of thanking you', async () => {
    const RateSubmission = require('../../models/RateSubmission');
    const again = await RateSubmission.submit(contributorId, {
      role: 's4-fi',
      seniority: 'senior',
      engagementType: 'contract',
      workMode: 'remote',
      country: 'DE',
      amount: 900,
      currency: 'EUR'
    });

    // Same row, through the unique key — and still voided, which is what the flash has to
    // reflect. Telling somebody their figure "counts towards this month" when it is
    // excluded from every published bucket is the one answer this path must not give.
    expect(again.id).toBe(submissionId);
    expect(again.voided).toBe(true);
  });

  test('a plain admin cannot void anything', async () => {
    const plain = await reSignIn('admin-plain@example.test');
    const page = await plain.get('/admin/moderation');
    const res = await plain
      .post(`/admin/moderation/rates/${submissionId}`)
      .type('form')
      .send({ _csrf: csrfFrom(page.text), hidden: 'false' });

    expect(res.status).toBe(302);
    const [[row]] = await promisePool.query('SELECT voided_at FROM rate_submissions WHERE id = ?', [submissionId]);
    expect(row.voided_at).not.toBeNull();
  });
});
