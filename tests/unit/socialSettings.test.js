'use strict';

const { PLATFORMS, socialLinks, settingKeyFor } = require('../../config/social');
const { DEFINITIONS, problemFor, assertSettingsIntegrity } = require('../../config/settings');

describe('social links as settings', () => {
  it('declares one setting per platform in config/social.js', () => {
    PLATFORMS.forEach((p) => expect(DEFINITIONS[settingKeyFor(p)]).toMatchObject({ type: 'url', platform: p.key }));
    expect(assertSettingsIntegrity()).toBe(true);
  });

  it('refuses a link that is not the platform\'s own, or not https', () => {
    expect(problemFor('social_linkedin', 'https://www.linkedin.com/company/x')).toBeNull();
    expect(problemFor('social_linkedin', '')).toBeNull();
    expect(problemFor('social_linkedin', 'https://evil.example/x')).toMatch(/not LinkedIn/);
    expect(problemFor('social_x', 'http://x.com/a')).toMatch(/https/);
    expect(problemFor('social_instagram', 'https://instagram.com@evil.example/')).toMatch(/user name/);
    expect(problemFor('registration_open', true)).toBeNull();
  });

  it('prefers the saved link, falls back to the environment, and drops a bad one', () => {
    const saved = process.env.SOCIAL_TIKTOK;
    process.env.SOCIAL_TIKTOK = 'https://www.tiktok.com/@fromenv';
    try {
      const keys = (links) => links.map((l) => `${l.key}=${l.href}`);
      expect(keys(socialLinks({ social_tiktok: 'https://www.tiktok.com/@saved' }))).toContain('tiktok=https://www.tiktok.com/@saved');
      expect(keys(socialLinks({}))).toContain('tiktok=https://www.tiktok.com/@fromenv');
      expect(keys(socialLinks({ social_linkedin: 'https://evil.example/' })).some((k) => k.startsWith('linkedin'))).toBe(false);
      expect(socialLinks({}).at(-1).key).toBe('email');
    } finally {
      if (saved === undefined) delete process.env.SOCIAL_TIKTOK; else process.env.SOCIAL_TIKTOK = saved;
    }
  });
});
