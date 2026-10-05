'use strict';

const config = require('./config');

/**
 * The Hub's own social accounts, and the one place that knows them.
 *
 * WHY THESE ARE CONFIGURED AND NOT WRITTEN INTO THE FOOTER. A social icon is a link like
 * any other, and an icon row is the easiest place on a site to leave a link to an account
 * that was never opened — it looks finished, nobody clicks it from the inside, and the
 * first person to find out is a visitor landing on a 404 under somebody else's brand.
 * So an account that is not configured is NOT RENDERED, and the row shrinks to what is
 * real. The same list feeds the footer and the fixed rail, because two copies would drift
 * the moment one account is added.
 *
 * Each host is pinned. A pasted link with a typo in the host still looks right in a diff
 * and is wrong forever on every page of the site, so the check is here and runs at boot
 * rather than at the moment a visitor clicks.
 */
const PLATFORMS = Object.freeze([
  { key: 'linkedin', label: 'LinkedIn', icon: 'bi-linkedin', env: 'SOCIAL_LINKEDIN', hosts: ['www.linkedin.com', 'linkedin.com'] },
  { key: 'x', label: 'X', icon: 'bi-twitter-x', env: 'SOCIAL_X', hosts: ['x.com', 'www.x.com', 'twitter.com'] },
  { key: 'instagram', label: 'Instagram', icon: 'bi-instagram', env: 'SOCIAL_INSTAGRAM', hosts: ['www.instagram.com', 'instagram.com'] },
  { key: 'tiktok', label: 'TikTok', icon: 'bi-tiktok', env: 'SOCIAL_TIKTOK', hosts: ['www.tiktok.com', 'tiktok.com'] },
  { key: 'youtube', label: 'YouTube', icon: 'bi-youtube', env: 'SOCIAL_YOUTUBE', hosts: ['www.youtube.com', 'youtube.com'] }
]);

function problemWith(platform, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `${platform.env} is not a URL`;
  }
  if (url.protocol !== 'https:') return `${platform.env} must be https`;
  if (!platform.hosts.includes(url.hostname)) {
    return `${platform.env} points at ${url.hostname}, not ${platform.label}`;
  }
  return null;
}

function assertSocialIntegrity() {
  const problems = [];
  PLATFORMS.forEach((platform) => {
    const value = (process.env[platform.env] || '').trim();
    if (!value) return;
    const problem = problemWith(platform, value);
    if (problem) problems.push(problem);
  });
  if (problems.length) {
    throw new Error(`Social links are misconfigured:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * The links to render, in order, plus the support address — which is always present,
 * because unlike a social account it is not optional for a site that invites people to
 * write in.
 */
function socialLinks() {
  const links = PLATFORMS
    .map((platform) => ({ platform, value: (process.env[platform.env] || '').trim() }))
    .filter(({ platform, value }) => value && !problemWith(platform, value))
    .map(({ platform, value }) => ({
      key: platform.key,
      label: platform.label,
      icon: platform.icon,
      href: value
    }));

  links.push({
    key: 'email',
    label: 'Email',
    icon: 'bi-envelope',
    href: `mailto:${config.app.supportEmail}`
  });

  return links;
}

module.exports = { PLATFORMS, socialLinks, assertSocialIntegrity };
