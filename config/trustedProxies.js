'use strict';

const proxyaddr = require('proxy-addr');

/**
 * Which hops in front of the app to trust when working out who sent a request.
 *
 * `trust proxy = 1` trusted exactly one hop, which was right until the deploy turned out
 * to have TWO: Render's load balancer, and Cloudflare in front of it. The access log on
 * saphub.net showed every request arriving from 104.22.x, 162.158.x and 172.70.x — all
 * Cloudflare edges — so `req.ip` was Cloudflare's address, never the visitor's. Three
 * things read it, and all three were wrong without an error anywhere:
 *
 *   - every per-IP rate limiter counted everybody behind the same edge as one person;
 *   - `visit_geo_daily` counted the edge's country, not the visitor's;
 *   - `users.signup_country` stored the same wrong answer on every account.
 *
 * So: the socket peer (Render's balancer) is trusted as before, and so is any address in
 * Cloudflare's published ranges. Express walks X-Forwarded-For from the right, skipping
 * trusted hops, and stops at the first address that is neither — the visitor. A client
 * that forges X-Forwarded-For only adds entries to the LEFT of that point, which are never
 * reached, so this is not spoofable the way trusting the leftmost entry would be.
 *
 * Source: https://www.cloudflare.com/ips/ — the list changes rarely; a stale one fails
 * safe, in that an unknown edge is treated as the client (today's behaviour), not worse.
 */
const CLOUDFLARE_RANGES = Object.freeze([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
]);

const isCloudflare = proxyaddr.compile([...CLOUDFLARE_RANGES]);

/** For `app.set('trust proxy', ...)`: hop 0 is the socket peer, i.e. the platform's balancer. */
function trustProxy(addr, i) {
  return i === 0 || isCloudflare(addr, i);
}

module.exports = { CLOUDFLARE_RANGES, trustProxy };
