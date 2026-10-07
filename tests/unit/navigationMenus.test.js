'use strict';

/**
 * The navbar menus carry the same items, in the same order, as dynamicshub.net's, and the
 * panels are opaque. Read as TEXT, like the navigation link walk, so the signed-in half of
 * the user menu is checked too.
 */

const fs = require('fs');
const path = require('path');

const nav = fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'partials', 'navigation.ejs'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'style.css'), 'utf8');

/** The labels of the dropdown items inside the menu whose toggle reads `toggleLabel`. */
function menuLabels(toggleLabel) {
  const start = nav.indexOf(`</i> ${toggleLabel}\n`);
  expect(start).toBeGreaterThan(-1);
  const open = nav.indexOf('<ul class="dropdown-menu', start);
  const close = nav.indexOf('</ul>', open);
  const block = nav.slice(open, close);
  return [...block.matchAll(/<i class="bi (bi-[\w-]+) me-2"><\/i>([^<]+)<\/a>/g)].map((m) => [m[1], m[2].trim()]);
}

describe('navbar menus', () => {
  it('Consultant Hub: five items, in order, with their icons', () => {
    expect(menuLabels('Consultant Hub')).toEqual([
      ['bi-compass', 'Consultant Hub'],
      ['bi-briefcase', 'Find Jobs'],
      ['bi-bookmark-heart', 'Saved Jobs'],
      ['bi-person-badge', 'Build Profile'],
      ['bi-file-earmark-richtext', 'CV Generator']
    ]);
  });

  it('Companies Hub: three, a divider, three', () => {
    expect(menuLabels('Companies Hub')).toEqual([
      ['bi-compass', 'Company Hub'],
      ['bi-people', 'Browse Talent'],
      ['bi-file-text', 'Get SOW Quote'],
      ['bi-people', 'Staff Augmentation'],
      ['bi-kanban', 'Project-Based'],
      ['bi-gear', 'Managed Services']
    ]);
    const start = nav.indexOf('</i> Companies Hub\n');
    const block = nav.slice(start, nav.indexOf('</ul>', start));
    expect(block.indexOf('dropdown-divider')).toBeGreaterThan(block.indexOf('Get SOW Quote'));
    expect(block.indexOf('dropdown-divider')).toBeLessThan(block.indexOf('Staff Augmentation'));
  });

  it('Services: five items, in order', () => {
    expect(menuLabels('Services').map(([, label]) => label)).toEqual([
      'Tax Optimization',
      'Rate &amp; Salary Index',
      'SOW Generator',
      'Document Generator',
      'Dedupe'
    ]);
  });

  it('the user menu runs profile, notifications, tiles, roles, admin, sign out', () => {
    const order = [
      'user-menu-profile',
      'id="userMenuNotifications"',
      'dropdown-quick-links',
      '>Consultant</li>',
      '>Sales Agent</li>',
      'Admin Panel',
      'Sign Out'
    ].map((marker) => nav.indexOf(marker));
    order.forEach((i) => expect(i).toBeGreaterThan(-1));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the bell, the chat icon and the Messages tile read the counts main.js fills', () => {
    expect(nav.match(/data-count="messages"/g)).toHaveLength(2);
    expect(nav.match(/data-count="notifications"/g)).toHaveLength(1);
  });

  it('the panels are opaque and carry no blur of their own', () => {
    const rule = css.slice(css.indexOf('.navbar-hub .dropdown-menu {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toMatch(/background-color:\s*var\(--bg-white\)/);
    expect(body).toMatch(/[^-]backdrop-filter:\s*none/);
    expect(body).toMatch(/-webkit-backdrop-filter:\s*none/);
    expect(css).toMatch(/--bg-white:\s*#ffffff/i);
  });
});
