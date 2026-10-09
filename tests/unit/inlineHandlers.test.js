'use strict';

/**
 * No template carries an inline event handler.
 *
 * The CSP is helmet's, which sends `script-src-attr 'none'`: every `onchange="..."` is
 * blocked by the browser without an error anybody sees. The Sort select on /jobs did
 * nothing and the "Listed in the directory" switch on the consultant profile never saved,
 * and both looked fine in every test that read the HTML. Behaviour goes on a data
 * attribute that public/js/main.js reads instead (`data-autosubmit`, `data-reveal`).
 */

const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, '..', '..', 'views');

function templates(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return templates(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

describe('inline event handlers', () => {
  it('appear in no template', () => {
    const offenders = templates(viewsDir).filter((file) => {
      const source = fs.readFileSync(file, 'utf8').replace(/<%#[\s\S]*?%>/g, '');
      return /\son[a-z]+\s*=\s*["']/i.test(source);
    });
    expect(offenders.map((f) => path.relative(viewsDir, f))).toEqual([]);
  });

  it('main.js handles what replaced them', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'main.js'), 'utf8');
    expect(main).toContain("hasAttribute('data-autosubmit')");
    expect(main).toContain("getAttribute('data-reveal')");
  });
});
