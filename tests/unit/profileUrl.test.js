'use strict';

/**
 * The allow-list on the three URLs a member puts on their own profile.
 *
 * A QA pass stored `javascript:alert(...)` in `linkedin_url` and `not a url` beside it,
 * because nothing validated any of them. Nothing renders them as links today — which is
 * the reason this is worth a test rather than a shrug: the value is in the column, the CV
 * reads the profile, and the first template that decides to make the row clickable
 * inherits whatever has been sitting there.
 */

const fs = require('fs');
const path = require('path');
const { FIELDS, normaliseProfileUrl, normaliseProfileUrls } = require('../../utils/profileUrl');

describe('what is refused', () => {
  it('refuses every scheme but http and https', () => {
    ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'vbscript:x']
      .forEach((raw) => {
        Object.keys(FIELDS).forEach((field) => {
          expect(normaliseProfileUrl(field, raw).value).toBeUndefined();
          expect(normaliseProfileUrl(field, raw).error).toEqual(expect.any(String));
        });
      });
  });

  it('refuses text that is not an address at all', () => {
    expect(normaliseProfileUrl('website_url', 'not a url').error).toBeTruthy();
    expect(normaliseProfileUrl('website_url', 'example.com').error).toBeTruthy();
  });

  it('refuses an address carrying credentials', () => {
    /*
     * `https://linkedin.com@evil.example/` parses with hostname `evil.example` and reads
     * as the real thing to anybody skimming it.
     */
    const result = normaliseProfileUrl('linkedin_url', 'https://linkedin.com@evil.example/');
    expect(result.error).toMatch(/username or password/);
  });

  it('names the field it is refusing', () => {
    // "Invalid value" against fifteen boxes is the message this whole pass is about.
    expect(normaliseProfileUrl('linkedin_url', 'nope').error).toContain('LinkedIn');
    expect(normaliseProfileUrl('sap_community_url', 'nope').error).toContain('SAP Community');
    expect(normaliseProfileUrl('website_url', 'nope').error).toContain('Website');
  });
});

describe('host pinning', () => {
  it('pins LinkedIn to linkedin.com and its subdomains', () => {
    expect(normaliseProfileUrl('linkedin_url', 'https://www.linkedin.com/in/x').value).toBeTruthy();
    expect(normaliseProfileUrl('linkedin_url', 'https://de.linkedin.com/in/x').value).toBeTruthy();
    expect(normaliseProfileUrl('linkedin_url', 'https://linkedin.com/in/x').value).toBeTruthy();
    expect(normaliseProfileUrl('linkedin_url', 'https://evil.example/x').error).toBeTruthy();
    // Not a suffix match: "notlinkedin.com" must not pass for "linkedin.com".
    expect(normaliseProfileUrl('linkedin_url', 'https://notlinkedin.com/in/x').error).toBeTruthy();
  });

  it('pins SAP Community to sap.com', () => {
    expect(normaliseProfileUrl('sap_community_url', 'https://community.sap.com/t5/users/1').value).toBeTruthy();
    expect(normaliseProfileUrl('sap_community_url', 'https://example.com/me').error).toBeTruthy();
  });

  it('lets a personal website be anywhere', () => {
    expect(normaliseProfileUrl('website_url', 'https://some-consultant.de/').value).toBeTruthy();
  });
});

describe('an empty field', () => {
  it('is null and not an error', () => {
    // "Not said" is a real answer, and it must not be reported as a mistake.
    ['', '   ', null, undefined].forEach((raw) => {
      expect(normaliseProfileUrl('website_url', raw)).toEqual({ value: null });
    });
  });
});

describe('normaliseProfileUrls', () => {
  it('hands back the refused text so it can be corrected rather than retyped', () => {
    const { values, errors } = normaliseProfileUrls({
      linkedin_url: 'javascript:alert(1)',
      website_url: 'https://ok.example/',
      sap_community_url: ''
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].param).toBe('linkedin_url');
    expect(values.linkedin_url).toBe('javascript:alert(1)');
    expect(values.website_url).toBe('https://ok.example/');
    expect(values.sap_community_url).toBeNull();
  });

  it('reports in the shape express-validator does, so one list covers both', () => {
    const { errors } = normaliseProfileUrls({ linkedin_url: 'nope' });
    expect(errors[0]).toEqual(expect.objectContaining({ param: expect.any(String), msg: expect.any(String) }));
  });
});

describe('both profile routes use it', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'profile.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('no posted URL reaches a column directly, on either profile', () => {
    /*
     * Comments stripped first: the explanation of a banned line matches the ban.
     *
     * The company half matters most. Its `website` is the one URL the site actually
     * renders as a link — "About the company" is gated on `about || website` — so the
     * hole the QA pass found on the consultant profile was live over here.
     */
    expect(route).not.toMatch(/linkedin_url:\s*req\.body\.linkedin_url/);
    expect(route).not.toMatch(/website_url:\s*req\.body\.website_url/);
    expect(route).not.toMatch(/sap_community_url:\s*req\.body\.sap_community_url/);
    expect(route).not.toMatch(/\bwebsite:\s*req\.body\.website\b/);
    expect(route).toContain('normaliseProfileUrls(req.body)');
    expect(route).toContain('normaliseProfileUrls(req.body, COMPANY_URL_COLUMNS)');
  });

  it('re-renders a refused profile instead of redirecting away from it', () => {
    /*
     * The redirect is the bug: it re-reads the row and everything typed is gone. A member
     * with one mistake in a fifteen-field form started the whole form again. Asserted for
     * the two long forms only — the short ones beside them (a password change, adding one
     * certification) lose nothing worth keeping on a redirect.
     */
    expect(route).toContain("res.status(422).render('profile/consultant'");
    expect(route).toContain("res.status(422).render('profile/company'");
  });
});
