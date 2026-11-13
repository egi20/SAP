'use strict';

/**
 * Server-rendered `<button data-copy="…">` buttons (the sales-agent links) had no listener at
 * all, so every Copy on the admin Sales agents table and the agent dashboard did nothing
 * (found 2026-11-13). main.js now binds them; `.copy-link` spans keep their own builder.
 */
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '../../public/js/main.js'), 'utf8');

describe('main.js copy buttons', () => {
  it('binds server-rendered data-copy buttons', () => {
    expect(main).toContain("querySelectorAll('button[data-copy]')");
  });

  it('copies on click and works without a secure context', () => {
    const block = main.slice(main.indexOf('(function copyButtons()'));
    expect(block).toContain('navigator.clipboard.writeText(url)');
    expect(block).toContain("window.prompt('Copy this link:', url)");
  });
});
