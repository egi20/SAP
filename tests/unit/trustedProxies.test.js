'use strict';

/**
 * `req.ip` behind Render AND Cloudflare is the visitor, not the edge.
 *
 * The socket peer in these requests is loopback, standing in for Render's balancer.
 */

const express = require('express');
const request = require('supertest');
const { trustProxy } = require('../../config/trustedProxies');

const app = express();
app.set('trust proxy', trustProxy);
app.get('/ip', (req, res) => res.send(req.ip));

const VISITOR = '79.106.1.20';
const EDGE = '162.158.210.25';

describe('trust proxy', () => {
  it('skips the Cloudflare edge and returns the visitor', async () => {
    const res = await request(app).get('/ip').set('X-Forwarded-For', `${VISITOR}, ${EDGE}`);
    expect(res.text).toBe(VISITOR);
  });

  it('ignores an address the client forged to the left of the visitor', async () => {
    const res = await request(app).get('/ip').set('X-Forwarded-For', `1.2.3.4, ${VISITOR}, ${EDGE}`);
    expect(res.text).toBe(VISITOR);
  });

  it('does not let a non-Cloudflare hop vouch for anything further left', async () => {
    const res = await request(app).get('/ip').set('X-Forwarded-For', `1.2.3.4, ${VISITOR}`);
    expect(res.text).toBe(VISITOR);
  });

  it('trusts IPv6 edges too', async () => {
    const res = await request(app).get('/ip').set('X-Forwarded-For', `${VISITOR}, 2606:4700::1`);
    expect(res.text).toBe(VISITOR);
  });
});
