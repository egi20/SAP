'use strict';

/**
 * Single source of truth for the policy versions stamped at registration.
 *
 * Consent rule carried over verbatim: ONLY the public registration route stamps
 * these. Admin-created, seeded and test accounts pass nothing, because consent must
 * never be fabricated on someone's behalf. Bump a version here whenever the
 * corresponding document changes materially.
 */
module.exports = {
  PRIVACY_VERSION: '2026-09-01',
  TERMS_VERSION: '2026-09-01'
};
