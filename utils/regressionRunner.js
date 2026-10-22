'use strict';

/**
 * Runs `config/regressionTests.js` against THIS process, over the loopback, the way
 * dynamicshub.net's Admin › Tests does — every case is a real HTTP request through the
 * whole middleware stack, so a template that throws, a guard that went missing or a
 * catalogue that points at a route that was never built shows up as a failed row.
 *
 * Where this differs from the reference, and why:
 *
 *  - It calls 127.0.0.1, never the public hostname. The reference builds its base URL from
 *    the request's Host, so in production every case leaves the machine, crosses the CDN
 *    and comes back — and is counted by the CDN's analytics and rate-limited by its edge.
 *  - It says it is a robot. The User-Agent is matched by `looksLikeAPerson`, so a run adds
 *    nothing to the server-side visitor count or the tax-interest funnel.
 *  - Redirects are never followed. A case asserts the response of the route it names. The
 *    reference follows them for signed-in cases, which its own notes found could mask a
 *    missing guard: the handler runs, then a later page's guard bounces the request to the
 *    same place a working guard would have.
 *  - QA accounts exist only while QA_TEST_PASSWORD is set, for the consultant and company
 *    roles only, and an account an administrator deactivated is reported, not re-activated.
 *    Turning an account back on is a decision somebody made the other way.
 */

const config = require('../config/config');
const User = require('../models/User');
const RegressionRun = require('../models/RegressionRun');
const { QA_ROLES, statusesOf } = require('../config/regressionTests');

const USER_AGENT = 'SAPHub-RegressionRunner/1.0 (bot; +/admin/tests)';
const REQUEST_TIMEOUT_MS = 15000;

const qaEmail = (role) => `qa-${role}@saphub.test`;

/** Only one run at a time: two runs sharing the QA sessions would sign each other out. */
let activeRunId = null;

/** Session cookies per role, kept between runs so a run does not spend the sign-in limiter. */
const sessionCookies = {};

function baseUrl() {
  return `http://127.0.0.1:${config.app.port}`;
}

function qaPassword() {
  const value = process.env.QA_TEST_PASSWORD;
  return value && value.length >= 12 ? value : null;
}

function cookieHeaderFrom(response, previous = '') {
  const jar = new Map(previous.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  const set = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  set.forEach((line) => {
    const [pair] = line.split(';');
    const [k, v] = pair.split(/=(.*)/s);
    if (k) jar.set(k.trim(), v || '');
  });
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(path, { cookie = '', method = 'GET', body = null } = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml',
    // The loopback peer is the trusted first hop, so this makes `req.secure` true and the
    // production session cookie (Secure) is issued and accepted over plain http.
    'X-Forwarded-Proto': 'https'
  };
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return fetch(`${baseUrl()}${path}`, {
    method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

/**
 * Pure: does this response satisfy this case? Returns the reasons it does not, in the
 * order somebody would want to read them.
 */
function checkResponse(testCase, { status, location, body }) {
  const problems = [];
  const expected = statusesOf(testCase);
  if (!expected.includes(status)) problems.push(`Expected status ${expected.join(' or ')}, got ${status}`);
  if (testCase.redirect !== undefined) {
    const loc = location || '';
    // Express may answer with an absolute URL; compare the path.
    const path = loc.replace(/^https?:\/\/[^/]+/i, '');
    if (!path.startsWith(testCase.redirect)) problems.push(`Expected a redirect to ${testCase.redirect}, got ${loc || 'none'}`);
  }
  (testCase.contains || []).forEach((s) => {
    if (!body.includes(s)) problems.push(`Page should contain "${s}"`);
  });
  (testCase.notContains || []).forEach((s) => {
    if (body.includes(s)) problems.push(`Page should not contain "${s}"`);
  });
  return problems;
}

/** Create or refresh the QA account for a role. Returns a reason when it cannot be used. */
async function prepareQaAccount(role, password) {
  const email = qaEmail(role);
  let user = await User.findByEmail(email);
  if (!user) {
    const created = await User.create({ email, password, name: `QA ${role === 'company' ? 'Company' : 'Consultant'}`, roles: [role] });
    user = await User.findById(created.id || created);
  } else {
    // So a rotated QA_TEST_PASSWORD still signs in.
    await User.updatePassword(user.id, password);
  }
  if (!user) return `the QA ${role} account could not be created`;
  if (!user.is_active) return `${email} has been deactivated; reactivate it on /admin/users to run its cases`;
  if (!user.email_verified) await User.setEmailVerified(user.id);
  return null;
}

async function signIn(role, password) {
  const loginPage = await request('/auth/login');
  const html = await loginPage.text();
  const token = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  if (!token) return { error: 'the sign-in page carried no CSRF token' };
  let cookie = cookieHeaderFrom(loginPage);
  const form = new URLSearchParams({ _csrf: token, email: qaEmail(role), password }).toString();
  const res = await request('/auth/login', { method: 'POST', cookie, body: form });
  cookie = cookieHeaderFrom(res, cookie);
  const location = res.headers.get('location') || '';
  if (res.status !== 302 || /\/auth\/login/.test(location)) {
    return { error: `signing in as ${qaEmail(role)} failed (status ${res.status}${location ? `, sent to ${location}` : ''})` };
  }
  return { cookie };
}

/** A cached session is used only if it still opens a signed-in page. */
async function sessionFor(role, password) {
  if (sessionCookies[role]) {
    const probe = await request('/dashboard', { cookie: sessionCookies[role] });
    if (probe.status === 200) return { cookie: sessionCookies[role] };
    delete sessionCookies[role];
  }
  const problem = await prepareQaAccount(role, password);
  if (problem) return { error: problem };
  const result = await signIn(role, password);
  if (result.cookie) sessionCookies[role] = result.cookie;
  return result;
}

async function runCase(testCase, sessions) {
  const started = Date.now();
  const base = { name: testCase.name, category: testCase.category, path: testCase.path, role: testCase.role || null };
  if (testCase.role) {
    const session = sessions[testCase.role];
    if (!session) {
      return { ...base, outcome: 'skipped', durationMs: 0, message: 'Signed-in cases need QA_TEST_PASSWORD (12+ characters) on the server.' };
    }
    if (session.error) {
      return { ...base, outcome: 'failed', durationMs: 0, message: `No ${testCase.role} session: ${session.error}` };
    }
  }
  try {
    const res = await request(testCase.path, { cookie: testCase.role ? sessions[testCase.role].cookie : '' });
    const body = await res.text();
    const problems = checkResponse(testCase, { status: res.status, location: res.headers.get('location'), body });
    return {
      ...base,
      outcome: problems.length ? 'failed' : 'passed',
      statusCode: res.status,
      durationMs: Date.now() - started,
      message: problems.join('; ') || null
    };
  } catch (err) {
    const message = err.name === 'TimeoutError' ? `No answer within ${REQUEST_TIMEOUT_MS / 1000}s` : err.message;
    return { ...base, outcome: 'failed', durationMs: Date.now() - started, message };
  }
}

/**
 * Start a run of `cases` and return its id at once; the cases run in the background and
 * each result is written as it lands, so the run page shows progress. A press of the
 * button must not wait on a hundred requests behind a CDN that gives up after 100 seconds.
 */
async function startRun(cases, { scope, userId }) {
  if (activeRunId) {
    const err = new Error('A run is already in progress.');
    err.code = 'RUN_IN_PROGRESS';
    err.runId = activeRunId;
    throw err;
  }
  const runId = await RegressionRun.start(scope, userId);
  activeRunId = runId;
  const started = Date.now();

  (async () => {
    try {
      const password = qaPassword();
      const sessions = {};
      if (password) {
        for (const role of QA_ROLES.filter((r) => cases.some((c) => c.role === r))) {
          try {
            // eslint-disable-next-line no-await-in-loop
            sessions[role] = await sessionFor(role, password);
          } catch (err) {
            sessions[role] = { error: err.message };
          }
        }
      }
      for (const testCase of cases) {
        // eslint-disable-next-line no-await-in-loop
        const result = await runCase(testCase, sessions);
        // eslint-disable-next-line no-await-in-loop
        await RegressionRun.addResult(runId, result);
      }
    } catch (err) {
      console.error(`Regression run ${runId} stopped: ${err.message}`);
    } finally {
      await RegressionRun.finish(runId, Date.now() - started).catch((err) => console.error(`Regression run ${runId} could not finish: ${err.message}`));
      activeRunId = null;
    }
  })();

  return runId;
}

function status() {
  return { activeRunId, qaEnabled: Boolean(qaPassword()), qaEmails: QA_ROLES.map(qaEmail) };
}

module.exports = { startRun, status, checkResponse, cookieHeaderFrom, qaEmail, USER_AGENT };
