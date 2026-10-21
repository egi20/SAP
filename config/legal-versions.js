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
  // 2026-10-21: a section on messages, problem reports and ideas — what is stored, and that
  // screenshots are deleted a stated time after a report is closed.
  // 2026-10-21.2: the same section now covers the optional browser details, the
  // confirmation email and published ideas with their votes.
  PRIVACY_VERSION: '2026-10-21.2',
  // 2026-10-20: rewritten — who operates the service and under which law, minimum age,
  // licence over content, scraping, closure and suspension, notice of changes, reporting
  // content under the DSA, payments, and liability limited only as far as the law allows.
  TERMS_VERSION: '2026-10-20'
};
