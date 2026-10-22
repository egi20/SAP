'use strict';

const fs = require('fs');
const path = require('path');
const { CASES, QA_ROLES, assertRegressionIntegrity } = require('../../config/regressionTests');
const { checkResponse, cookieHeaderFrom, USER_AGENT } = require('../../utils/regressionRunner');
const { looksLikeAPerson } = require('../../middleware/visitGeo');

describe('regression library', () => {
  it('is consistent', () => {
    expect(assertRegressionIntegrity()).toBe(true);
  });

  it('refuses a duplicate name, a foreign path and an admin QA role', () => {
    const ok = { name: 'a', category: 'c', path: '/', status: 200 };
    expect(() => assertRegressionIntegrity([ok, { ...ok }])).toThrow(/duplicate/);
    expect(() => assertRegressionIntegrity([{ ...ok, path: '//evil.example/' }])).toThrow(/site path/);
    expect(() => assertRegressionIntegrity([{ ...ok, role: 'admin' }])).toThrow(/unknown role/);
    expect(() => assertRegressionIntegrity([{ ...ok, redirect: '/x' }])).toThrow(/3xx/);
  });

  it('has no administrator QA account', () => {
    expect(QA_ROLES).not.toContain('admin');
  });

  it('only reads: no case carries a method or a body', () => {
    CASES.forEach((c) => {
      expect(c.method).toBeUndefined();
      expect(c.body).toBeUndefined();
    });
  });

  it('covers every public page in the sitemap', () => {
    const { PUBLIC_PATHS } = require('../../config/seoMeta');
    PUBLIC_PATHS.forEach((p) => expect(CASES.some((c) => c.path === p)).toBe(true));
  });

  it('guards the admin screens both signed out and as a consultant', () => {
    expect(CASES.some((c) => c.path === '/admin/tests' && !c.role && c.redirect === '/auth/login')).toBe(true);
    expect(CASES.some((c) => c.path === '/admin/tests' && c.role === 'consultant' && c.redirect === '/')).toBe(true);
  });
});

describe('regression runner', () => {
  const page = { name: 'p', category: 'c', path: '/', status: 200, contains: ['Hello'], notContains: ['Something went wrong'] };

  it('passes a matching response', () => {
    expect(checkResponse(page, { status: 200, location: null, body: 'Hello there' })).toEqual([]);
  });

  it('names every reason a response fails', () => {
    const problems = checkResponse(page, { status: 500, location: null, body: 'Something went wrong' });
    expect(problems).toEqual([
      'Expected status 200, got 500',
      'Page should contain "Hello"',
      'Page should not contain "Something went wrong"'
    ]);
  });

  it('compares the redirect PATH, so an absolute Location still matches', () => {
    const guard = { name: 'g', category: 'c', path: '/admin', status: 302, redirect: '/auth/login' };
    expect(checkResponse(guard, { status: 302, location: 'http://127.0.0.1:3000/auth/login?redirect=%2Fadmin', body: '' })).toEqual([]);
    expect(checkResponse(guard, { status: 302, location: '/', body: '' })).toEqual(['Expected a redirect to /auth/login, got /']);
  });

  it('keeps cookies across responses and lets a later one replace an earlier one', () => {
    const first = { headers: { getSetCookie: () => ['saphub.sid=one; Path=/; HttpOnly', 'other=x=y; Path=/'] } };
    const second = { headers: { getSetCookie: () => ['saphub.sid=two; Path=/'] } };
    expect(cookieHeaderFrom(second, cookieHeaderFrom(first))).toBe('saphub.sid=two; other=x=y');
  });

  it('declares itself a robot, so a run is not counted as visitors', () => {
    expect(looksLikeAPerson(USER_AGENT)).toBe(false);
  });

  it('calls the loopback, never the request host', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../utils/regressionRunner.js'), 'utf8');
    expect(source).toContain('http://127.0.0.1:');
    expect(source).not.toMatch(/req\.get\(['"]host/);
    expect(source).toContain("redirect: 'manual'");
  });
});
