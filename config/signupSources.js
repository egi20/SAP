'use strict';

/**
 * "How did you hear about us?" — the closed list, and the only copy of it.
 *
 * It mirrors the ENUM in migration 019, and a unit test compares the two: the same
 * arrangement as `Job.STATUSES` and `Enquiry.KINDS`, because a value added to a dropdown
 * and silently rejected behind it is the failure this keeps producing.
 *
 * CLOSED, not free text. Eight options are answered honestly and can be counted; a text
 * box produces "google", "Google", "googled it" and "a friend of mine" and then the column
 * means nothing. And OPTIONAL — an answer nobody can skip is an answer nobody means.
 *
 * It is NOT the referral system. `referral_attributions` records a link somebody actually
 * followed and pays a commission on it; this is a sentence somebody typed about their own
 * memory. Letting an unverifiable answer near the table that decides who gets paid is how
 * a commission scheme becomes a dropdown.
 */
const SIGNUP_SOURCES = Object.freeze([
  { value: 'search', label: 'A search engine' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'social', label: 'Another social network' },
  { value: 'colleague', label: 'A colleague or friend' },
  { value: 'event', label: 'An event, meetup or conference' },
  { value: 'sap_community', label: 'The SAP Community' },
  { value: 'press', label: 'An article or newsletter' },
  { value: 'other', label: 'Somewhere else' }
]);

const SIGNUP_SOURCE_VALUES = Object.freeze(SIGNUP_SOURCES.map((s) => s.value));

function isSignupSource(value) {
  return SIGNUP_SOURCE_VALUES.includes(value);
}

module.exports = { SIGNUP_SOURCES, SIGNUP_SOURCE_VALUES, isSignupSource };
