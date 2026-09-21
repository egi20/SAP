'use strict';

/**
 * The parts of the LinkedIn flow that are decidable without a network.
 *
 * The state check is the CSRF defence on a GET that arrives from a third party, and the
 * name comparison is the ONE cross-check the provider makes available — so both are pure
 * functions here, argued with in a test rather than discovered in production.
 */

const {
  newState,
  stateMatches,
  authorisationUrl,
  namesAgree,
  redirectUri
} = require('../../utils/linkedin');
const { SCOPES, STATE_TTL_MS, assertLinkedInIntegrity } = require('../../config/linkedin');

describe('the integration asserts itself', () => {
  test('integrity', () => expect(assertLinkedInIntegrity()).toBe(true));

  /*
   * Asking for the ability to post as somebody, in order to check who they are, is a much
   * larger permission than the task needs — and the consent screen says so, which is the
   * first thing that makes people abandon the flow.
   */
  test('it never asks for permission to post', () => {
    expect(SCOPES).toBe('openid profile email');
    expect(SCOPES).not.toMatch(/w_member_social/);
  });
});

describe('the authorisation state', () => {
  test('a fresh state matches itself', () => {
    const state = newState();
    expect(stateMatches(state, state.value)).toBe(true);
  });

  test('a different value does not match', () => {
    const state = newState();
    expect(stateMatches(state, 'something else entirely')).toBe(false);
    // Same length, different bytes: the comparison is constant-time, not a length check.
    expect(stateMatches(state, 'x'.repeat(state.value.length))).toBe(false);
  });

  test('an expired state does not match, however correct the value', () => {
    const state = newState();
    state.expiresAt = Date.now() - 1;
    expect(stateMatches(state, state.value)).toBe(false);
  });

  test('a missing or malformed state never matches', () => {
    expect(stateMatches(null, 'anything')).toBe(false);
    expect(stateMatches(newState(), null)).toBe(false);
    expect(stateMatches({}, 'anything')).toBe(false);
  });

  test('the window is short enough that a stale state is an abandoned flow', () => {
    expect(STATE_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  test('two states are never the same', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newState().value));
    expect(seen.size).toBe(200);
  });
});

describe('the authorisation URL', () => {
  test('it carries the state, the redirect and nothing surprising', () => {
    const url = new URL(authorisationUrl('the-state'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri());
  });

  test('the redirect URI is this application, absolute', () => {
    expect(redirectUri()).toMatch(/^https?:\/\/.+\/linkedin\/callback$/);
  });
});

describe('whether two names plausibly belong to one person', () => {
  /*
   * Deliberately loose, and the looseness is the point: the answer is SHOWN to the member
   * rather than used to refuse the link. A stricter rule would reject real people to
   * catch a case a name comparison cannot catch anyway.
   */
  test('an exact name agrees', () => {
    expect(namesAgree('Ana Pjetri', 'Ana Pjetri')).toBe(true);
  });

  test('a middle name on one side still agrees', () => {
    expect(namesAgree('Ana Pjetri', 'Ana Maria Pjetri')).toBe(true);
  });

  test('a reversed order still agrees', () => {
    expect(namesAgree('Pjetri Ana', 'Ana Pjetri')).toBe(true);
  });

  test('diacritics are not a difference', () => {
    expect(namesAgree('Ana Pjetrí', 'Ana Pjetri')).toBe(true);
    expect(namesAgree('Jürgen Müller', 'Jurgen Muller')).toBe(true);
  });

  test('two unrelated names do not agree', () => {
    expect(namesAgree('Ana Pjetri', 'Wolfgang Schmidt')).toBe(false);
  });

  test('an empty side never agrees', () => {
    expect(namesAgree('', 'Ana Pjetri')).toBe(false);
    expect(namesAgree('Ana Pjetri', '')).toBe(false);
    expect(namesAgree(null, undefined)).toBe(false);
  });

  test('a single shared initial is not a match', () => {
    // Tokens of one character are dropped, or "A Smith" would agree with everybody
    // whose name contains a stray initial.
    expect(namesAgree('A Pjetri', 'A Schmidt')).toBe(false);
  });
});
