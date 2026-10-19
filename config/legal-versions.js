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
  // 2026-10-05: added the Cookies section. Bumped because the document now describes
  // something it did not describe before, and the stamp on an account is a record of what
  // that person was shown — leaving it alone would quietly backdate the new text onto
  // everybody who registered before it existed.
  // 2026-10-19: the Cookies and Visitor analytics sections describe Google Analytics (behind
  // a consent choice) and Cloudflare Web Analytics, each rendered only when configured.
  PRIVACY_VERSION: '2026-10-19',
  TERMS_VERSION: '2026-09-01'
};
