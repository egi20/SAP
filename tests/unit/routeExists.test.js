'use strict';

/**
 * routeExists decides whether a CSRF refusal could be a real form failing (2026-11-05): a
 * refused POST to a path the router does not answer is a scanner, whatever headers it sent.
 */

const express = require('express');
const { routeExists } = require('../../utils/routeExists');

function app() {
  const a = express();
  a.use((req, res, next) => next()); // plain middleware matches everything and must not count
  a.use(express.static(__dirname));
  const inner = express.Router();
  inner.post('/vote/post/:id', (req, res) => res.end());
  inner.get('/', (req, res) => res.end());
  a.use('/community', inner);
  a.post('/contact', (req, res) => res.end());
  a.get('/jobs/:slug', (req, res) => res.end());
  a.all('/anything', (req, res) => res.end());
  return a;
}

describe('routeExists', () => {
  const a = app();

  it('finds direct and mounted routes, by method', () => {
    expect(routeExists(a, 'POST', '/contact')).toBe(true);
    expect(routeExists(a, 'POST', '/community/vote/post/12')).toBe(true);
    expect(routeExists(a, 'GET', '/community')).toBe(true);
    expect(routeExists(a, 'GET', '/jobs/sap-fico')).toBe(true);
    expect(routeExists(a, 'DELETE', '/anything')).toBe(true);
  });

  it('answers no for the paths scanners post to, and for the wrong method', () => {
    ['/graphql', '/api/graphql', '/v1/graphql', '/', '/api', '/app', '/xmlrpc.php',
      '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/community/graphql']
      .forEach((p) => expect(routeExists(a, 'POST', p)).toBe(false));
    expect(routeExists(a, 'POST', '/jobs/sap-fico')).toBe(false);
    expect(routeExists(a, 'GET', '/contact')).toBe(false);
  });

  it('answers yes when it cannot read the router, so nothing real is hidden', () => {
    expect(routeExists(null, 'POST', '/graphql')).toBe(true);
    expect(routeExists({}, 'POST', '/graphql')).toBe(true);
  });
});
