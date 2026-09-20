'use strict';

const fs = require('fs');
const path = require('path');
const { contrastRatio, MIN_TEXT_RATIO } = require('../../utils/contrast');

/*
 * DESIGN.md states a ratio for every interactive colour. A stated ratio is a comment until
 * something measures it, and the one that matters most here looks like a mistake: SAP's own
 * brand blue is NOT the button colour. It clears AA by seven hundredths, which survives
 * nothing — so #0064D9 carries the interactions and #0070F2 is an accent.
 *
 * This test is what keeps somebody from "correcting" that back to the brand blue.
 */
const WHITE = '#FFFFFF';
const NAVY = '#00265B';
const BRAND_BLUE = '#0070F2';
const INTERACTIVE_BLUE = '#0064D9';

describe('the palette meets its own floor', () => {
  test.each([
    ['--primary-blue on white', INTERACTIVE_BLUE, WHITE],
    ['--primary-blue-dark on white', '#004AA8', WHITE],
    ['--primary-navy on white', NAVY, WHITE],
    ['white on --primary-blue', WHITE, INTERACTIVE_BLUE],
    ['white on --primary-navy', WHITE, NAVY],
    ['--text-dark on white', '#16191D', WHITE],
    ['--text-medium on white', '#444C56', WHITE],
    ['--text-light on white', '#5A6673', WHITE],
    ['--primary-blue-bright on navy', '#7AC5FF', NAVY]
  ])('%s clears %s:1', (label, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
  });

  test('--text-muted is large-text only, and is documented as such', () => {
    const ratio = contrastRatio('#8A94A0', WHITE);
    expect(ratio).toBeLessThan(MIN_TEXT_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  test('SAP brand blue passes AA by too little to be the interactive colour', () => {
    const brand = contrastRatio(BRAND_BLUE, WHITE);
    const interactive = contrastRatio(INTERACTIVE_BLUE, WHITE);
    expect(brand).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    expect(brand - MIN_TEXT_RATIO).toBeLessThan(0.1); // the whole argument, in one number
    expect(interactive).toBeGreaterThan(brand);
  });
});

describe('the stylesheet carries the palette DESIGN.md describes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'style.css'), 'utf8');

  test('the interactive blue is the one in the tokens', () => {
    expect(css).toMatch(/--primary-blue:\s*#0064d9/i);
    expect(css).toMatch(/--primary-blue-light:\s*#0070f2/i);
  });

  test('no colour from the reference palettes survived the port', () => {
    // Salesforce Hub's blues and DynamicsHub's teal. A single survivor is a page that is
    // subtly the wrong brand.
    for (const stray of ['#0176d3', '#00a1e0', '#032d60', '#0b5cab', '#008272', '#2b88d8']) {
      expect(css.toLowerCase()).not.toContain(stray);
    }
  });

  test('the primary button never fills with the brand blue', () => {
    const buttonBlock = css.slice(css.indexOf('.btn-primary'), css.indexOf('.btn-primary') + 600);
    expect(buttonBlock.toLowerCase()).not.toContain('#0070f2');
  });
});
