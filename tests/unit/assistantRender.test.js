'use strict';

/*
 * The assistant renders the model's light markdown like dynamicshub.net's Dynamo
 * (2026-11-11). Model output is steerable by whoever types into the box, so the renderer
 * must build DOM nodes only and must never make a link that leaves this origin.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/assistant.js'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the assistant reply renderer', () => {
  it('never parses text as markup', () => {
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).toContain('function renderReply');
  });

  it('links only same-origin relative paths', () => {
    const literal = source.match(/var SAFE_PATH = (\/.*\/);/)[1];
    const SAFE_PATH = new Function(`return ${literal};`)();
    ['/jobs', '/rates/sap-fico-consultant', '/consultants?country=DE', '/faq#faq3'].forEach((ok) => {
      expect(SAFE_PATH.test(ok)).toBe(true);
    });
    ['//evil.example/x', 'javascript:alert(1)', 'https://evil.example', '/x"onmouseover=1', ''].forEach((bad) => {
      expect(SAFE_PATH.test(bad)).toBe(false);
    });
  });

  it("keeps the visitor's own words as text", () => {
    expect(code).toMatch(/if \(role === 'user'\) p\.textContent = text;/);
  });
});
