'use strict';

/**
 * The open mobile menu must scroll from anywhere on it (owner, 2026-10-23): on a phone the
 * Admin Panel and Sign Out sit at the bottom of a menu taller than the screen, and a swipe on
 * the logo row — or a `vh` height under iOS Safari's toolbar — left them unreachable.
 */

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');

describe('the open mobile menu', () => {
  it('makes the whole navbar one full-height scroll container while it is open', () => {
    const rule = css.slice(css.indexOf('.navbar-hub.nav-open,'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('.navbar-hub:has(.navbar-collapse.show)');
    expect(body).toMatch(/max-height:\s*100dvh/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(css).toMatch(/env\(safe-area-inset-bottom/);
    expect(css).toMatch(/body\.nav-locked\s*\{\s*overflow:\s*hidden/);
  });

  it('is switched on and off from Bootstrap\'s own collapse events', () => {
    expect(js).toMatch(/show\.bs\.collapse[\s\S]*nav-open[\s\S]*nav-locked/);
    expect(js).toMatch(/hidden\.bs\.collapse[\s\S]*classList\.remove\('nav-open'\)/);
  });
});
