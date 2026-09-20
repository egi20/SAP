'use strict';

/**
 * Return `candidate` if it is a safe same-origin path, otherwise `fallback`.
 *
 * Blocks, in order: control characters (CR/LF injection), backslash variants that some
 * browsers normalise to `/`, absolute URLs with a scheme, and protocol-relative
 * `//host`. Anything that is not a path beginning with a single `/` is rejected.
 */
function safePath(candidate, fallback = '/') {
  if (typeof candidate !== 'string') return fallback;

  const value = candidate.trim();
  if (!value) return fallback;

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return fallback;

  // `/\evil.com` is normalised to `//evil.com` by several browsers. Reject, do not fix.
  if (value.includes('\\')) return fallback;

  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;

  // A scheme cannot legitimately appear in a path-only value.
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return fallback;

  return value;
}

module.exports = { safePath };
