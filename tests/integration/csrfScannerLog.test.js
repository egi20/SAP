'use strict';

/**
 * A CSRF refusal from a request with no session (a scanner POSTing /xmlrpc.php) still gets
 * its 403 but is not written to the error log; one from a browser that has a session is.
 */

const request = require('supertest');
const { promisePool } = require('../../config/database');
const { isScannerCsrfRefusal } = require('../../middleware/errorHandler');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);
const run = Date.now();
let app;

beforeAll(() => {
  if (reachable) app = require('../../server');
});

describe('isScannerCsrfRefusal', () => {
  const csrf = { code: 'EBADCSRFTOKEN' };
  const req = (cookie) => ({ get: (h) => (h === 'cookie' ? cookie : undefined) });
  it('is true only for a CSRF refusal without the session cookie', () => {
    expect(isScannerCsrfRefusal(csrf, req(undefined))).toBe(true);
    expect(isScannerCsrfRefusal(csrf, req('other=1'))).toBe(true);
    expect(isScannerCsrfRefusal(csrf, req('a=1; saphub.sid=s%3Aabc'))).toBe(false);
    expect(isScannerCsrfRefusal({ code: 'OTHER' }, req(undefined))).toBe(false);
  });
});

maybe()('the error log and scanners', () => {
  async function logged(path) {
    await new Promise((r) => setTimeout(r, 300));
    const [[{ n }]] = await promisePool.query('SELECT COUNT(*) AS n FROM error_logs WHERE path = ?', [path]);
    return n;
  }

  it('refuses a cookie-less POST and does not record it', async () => {
    const path = `/xmlrpc.php?probe=${run}`;
    const res = await request(app).post(path).type('form').send({ a: 1 });
    expect([302, 403]).toContain(res.status); // a navigation is redirected with a flash
    expect(await logged(path)).toBe(0);
  });

  it('still records a refusal from a browser that has a session', async () => {
    const agent = request.agent(app);
    await agent.get('/contact');
    const path = `/contact?stale=${run}`;
    const res = await agent.post(path).type('form').send({ _csrf: 'wrong' });
    expect([302, 403]).toContain(res.status); // a navigation is redirected with a flash
    expect(await logged(path)).toBe(1);
  });
});
