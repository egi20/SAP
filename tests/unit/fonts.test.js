'use strict';

/**
 * Every font file the stylesheet asks for is shipped by a DECLARED dependency.
 *
 * `server.js` serves /vendor/inter from node_modules/@fontsource/inter, and that package
 * was never in package.json — it worked on whichever machine had installed it by hand, and
 * on a clean install every page asked for five font files, got five 404s, and fell back to
 * the system font without a word.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

describe('the Inter font', () => {
  it('comes from a package listed in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@fontsource/inter']).toBeTruthy();
  });

  it('has every file inter.css references', () => {
    const css = fs.readFileSync(path.join(root, 'public', 'css', 'inter.css'), 'utf8');
    const files = [...css.matchAll(/url\('\/vendor\/inter\/([^']+)'\)/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file) => {
      expect(fs.existsSync(path.join(root, 'node_modules', '@fontsource', 'inter', file))).toBe(true);
    });
  });
});
