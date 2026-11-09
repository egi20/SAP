'use strict';

const { coerce, problemFor, isPlainEmail, assertSettingsIntegrity } = require('../../config/settings');
const { socialLinks } = require('../../config/social');

describe('the email address on /admin/settings', () => {
  it('is a declared setting the boot assertion accepts', () => {
    expect(assertSettingsIntegrity()).toBe(true);
    expect(coerce('social_email', '  hello@saphub.net ')).toBe('hello@saphub.net');
  });

  it('refuses anything that is not one plain address', () => {
    expect(problemFor('social_email', 'hello@saphub.net')).toBeNull();
    expect(problemFor('social_email', '')).toBeNull();
    ['not an email', 'a@b', 'a@b.com?bcc=x@y.com', 'a@b.com,c@d.com', 'mailto:a@b.com', 'a b@c.com']
      .forEach((bad) => expect(isPlainEmail(bad)).toBe(false));
  });

  it('drives the envelope icon, and falls back to info@saphub.net', () => {
    const icon = (settings) => socialLinks(settings).find((l) => l.key === 'email').href;
    expect(icon({ social_email: 'hello@saphub.net' })).toBe('mailto:hello@saphub.net');
    expect(icon({})).toBe('mailto:info@saphub.net');
    expect(icon({ social_email: '' })).toBe('mailto:info@saphub.net');
    expect(icon({ social_email: 'a@b.com?bcc=x@y.com' })).toBe('mailto:info@saphub.net');
  });
});
