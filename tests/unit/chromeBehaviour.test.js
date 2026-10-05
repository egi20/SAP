'use strict';

/**
 * The cookie notice and the back-to-top button.
 *
 * Both are built by public/js/main.js and have no server-rendered counterpart, so there is
 * no page to request and assert against. What is worth pinning is the reasoning, because
 * the obvious change to each of them is the wrong one: an "Accept all / Reject" pair on a
 * site with nothing to refuse, and a dismissal remembered in a cookie.
 */

const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');

/*
 * The same file with its comments stripped.
 *
 * Needed because the comments EXPLAIN why there is no "Accept all / Reject" pair, and a
 * test searching the raw source therefore matches the explanation and fails. The tempting
 * fix is to delete the sentence; the right one is to assert against the code.
 */
const MAIN_CODE = MAIN_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PRIVACY = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'legal', 'privacy.ejs'), 'utf8');

describe('the cookie notice', () => {
  it('is a notice and not a consent gate', () => {
    /*
     * This site sets one cookie, the session, and sets it only because somebody asked to be
     * signed in. A "Reject" button could not do anything that left the site working, and a
     * button offering a choice somebody does not have is what trains people to click
     * through every real one.
     */
    expect(MAIN_CODE).not.toMatch(/Accept all/i);
    expect(MAIN_CODE).not.toMatch(/\bReject\b/i);
    expect(MAIN_CODE).toMatch(/nothing here to opt out of/i);
  });

  it('remembers the dismissal outside a cookie', () => {
    const notice = MAIN_JS.slice(MAIN_JS.indexOf('function cookieNotice'), MAIN_JS.indexOf('function backToTop'));
    expect(notice).toContain('localStorage');
    // Storing "you have seen the cookie notice" in a cookie would be comic.
    expect(notice).not.toMatch(/document\.cookie/);
  });

  it('survives storage being unavailable', () => {
    // Private browsing throws on access. Showing the notice every time is the honest
    // failure: we genuinely cannot tell whether this person has read it.
    const notice = MAIN_JS.slice(MAIN_JS.indexOf('function cookieNotice'), MAIN_JS.indexOf('function backToTop'));
    expect((notice.match(/try \{/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('points at a section the privacy policy actually has', () => {
    // A stale anchor is worse than no anchor: it lands somebody at the top of a long
    // document with complete confidence that they were taken to the right place.
    expect(MAIN_JS).toContain('/legal/privacy#cookies');
    expect(PRIVACY).toContain('id="cookies"');
  });
});

describe('the privacy policy', () => {
  it('describes the one cookie, which is what the disclosure duty actually needs', () => {
    expect(PRIVACY).toContain('saphub.sid');
    expect(PRIVACY).toMatch(/no third-party cookies/i);
  });

  it('was re-versioned when that section was added', () => {
    /*
     * The stamp on an account records what that person was shown. Leaving the version alone
     * would backdate the new text onto everybody who registered before it existed.
     */
    const versions = require('../../config/legal-versions');
    expect(versions.PRIVACY_VERSION).toBe('2026-10-05');
  });
});

describe('back to top', () => {
  it('is a real button, so the keyboard reaches it', () => {
    expect(MAIN_JS).toMatch(/createElement\('button'\)/);
    expect(MAIN_JS).toContain("setAttribute('aria-label', 'Back to top')");
  });

  it('honours prefers-reduced-motion', () => {
    // A smooth scroll through a long page is exactly the movement that setting exists to
    // stop, and it is the one most likely to be left in.
    expect(MAIN_JS).toContain('prefers-reduced-motion');
  });

  it('moves focus as well as the viewport', () => {
    // Otherwise a keyboard user is returned to the top of the page while their focus stays
    // at the bottom of it, and the next Tab takes them back down.
    const section = MAIN_JS.slice(MAIN_JS.indexOf('function backToTop'));
    expect(section).toContain("getElementById('main')");
    expect(section).toContain('focus(');
  });

  it('throttles its scroll handler to one update a frame', () => {
    const section = MAIN_JS.slice(MAIN_JS.indexOf('function backToTop'));
    expect(section).toContain('requestAnimationFrame');
    // And does not block the scroll it is listening to.
    expect(section).toContain('passive: true');
  });
});
