'use strict';

/**
 * The three URLs a member may put on their own profile.
 *
 * A QA pass stored `javascript:alert(...)`, `not a url` and an arbitrary host in
 * `linkedin_url`, `website_url` and `sap_community_url`, because nothing validated any of
 * them. Nothing renders them as links today, which is exactly why it was worth fixing now:
 * the value is stored, the CV reads the profile, and the first template that decides to
 * make the LinkedIn row clickable inherits a `javascript:` URL that has been sitting in
 * the column for months. A stored value is a decision made once, in the past, by code that
 * may since have changed — the same argument `utils/videoEmbed.js` is built on.
 *
 * So this is an ALLOW-LIST and it runs on the WRITE path. `videoEmbed` can afford to
 * decide at render time because it derives an embed from a URL it is handed; here the
 * column is the thing other code will trust.
 *
 * Two of the three are host-pinned. A field labelled "LinkedIn" pointing somewhere else is
 * a label that is false about its own content, and the profile already presents these as
 * claims rather than verified facts — a claim may be unverified, but it must at least be
 * a claim about what it says it is.
 */

const MAX_LENGTH = 500;

const FIELDS = Object.freeze({
  linkedin_url: Object.freeze({
    label: 'LinkedIn',
    hosts: ['linkedin.com'],
    expected: 'a linkedin.com address'
  }),
  sap_community_url: Object.freeze({
    label: 'SAP Community',
    hosts: ['sap.com'],
    expected: 'an sap.com address'
  }),
  website_url: Object.freeze({
    label: 'Website',
    hosts: null,
    expected: 'a full address starting with https://'
  })
});

/** Is `hostname` the pinned host itself, or a subdomain of it? */
function hostMatches(hostname, host) {
  return hostname === host || hostname.endsWith(`.${host}`);
}

/**
 * Normalise one profile URL.
 *
 * Returns `{ value }` for an accepted address (null when the field was left empty), or
 * `{ error }` with a message naming the field and what it expected.
 */
function normaliseProfileUrl(field, raw) {
  const spec = FIELDS[field];
  if (!spec) throw new Error(`Unknown profile URL field: ${field}`);

  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_LENGTH) {
    return { error: `Your ${spec.label} address is too long.` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `Enter your ${spec.label} as ${spec.expected}.` };
  }

  // The allow-list. Everything else — javascript:, data:, file:, mailto: — is refused.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: `Your ${spec.label} address must start with https:// or http://.` };
  }
  if (!parsed.hostname) {
    return { error: `Enter your ${spec.label} as ${spec.expected}.` };
  }
  /*
   * `https://linkedin.com@evil.example/` parses with hostname `evil.example` and reads as
   * the real thing to anybody skimming it. Nothing legitimate here carries credentials.
   */
  if (parsed.username || parsed.password) {
    return { error: `Your ${spec.label} address must not contain a username or password.` };
  }
  if (spec.hosts && !spec.hosts.some((h) => hostMatches(parsed.hostname.toLowerCase(), h))) {
    return { error: `Your ${spec.label} address should be ${spec.expected}.` };
  }

  return { value: parsed.toString() };
}

/** The consultant profile's three columns, named identically to their specs. */
const CONSULTANT_URL_COLUMNS = Object.freeze({
  linkedin_url: 'linkedin_url',
  website_url: 'website_url',
  sap_community_url: 'sap_community_url'
});

/*
 * The company profile holds the same two facts under one different name: its personal
 * site column is `website`, not `website_url`. The map exists so the SPEC can be shared
 * without the column names having to match — the alternative is a second allow-list for
 * the company, which is the thing this codebase refuses everywhere else.
 */
const COMPANY_URL_COLUMNS = Object.freeze({
  linkedin_url: 'linkedin_url',
  website: 'website_url'
});

/**
 * Normalise a set of URL columns out of a posted body.
 *
 * `columns` maps the COLUMN being written to the SPEC that governs it. Returns
 * `{ values, errors }` — `errors` is an array of `{ param, msg }`, the shape
 * express-validator produces, so a route can concatenate the two lists and the template
 * does not have to know which check refused a field.
 */
function normaliseProfileUrls(body, columns = CONSULTANT_URL_COLUMNS) {
  const values = {};
  const errors = [];

  for (const [column, spec] of Object.entries(columns)) {
    const result = normaliseProfileUrl(spec, body[column]);
    if (result.error) {
      errors.push({ param: column, path: column, msg: result.error });
      // Hand the refused text back so the member can correct it rather than retype it.
      values[column] = String(body[column] ?? '').trim();
    } else {
      values[column] = result.value;
    }
  }

  return { values, errors };
}

module.exports = {
  FIELDS,
  MAX_LENGTH,
  CONSULTANT_URL_COLUMNS,
  COMPANY_URL_COLUMNS,
  normaliseProfileUrl,
  normaliseProfileUrls
};
