'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizePostBody, sanitizeRichText } = require('../../utils/sanitize');

const ROOT = path.join(__dirname, '..', '..');
const svgUri = (markup) => `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`;

describe('sanitizePostBody: pictures in community posts', () => {
  test('keeps an SVG diagram embedded as a data: URI, with its alt text', () => {
    const src = svgUri('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const out = sanitizePostBody(`<p>Flow</p><img src="${src}" alt="Process flow" width="640">`);
    expect(out).toContain(`src="${src}"`);
    expect(out).toContain('alt="Process flow"');
    expect(out).toContain('width="640"');
  });

  test('keeps raster data: images and https images', () => {
    expect(sanitizePostBody('<img src="data:image/png;base64,AAAA">')).toContain('data:image/png');
    expect(sanitizePostBody('<img src="https://example.com/a.svg">')).toContain('https://example.com/a.svg');
  });

  test.each([
    'javascript:alert(1)',
    'http://example.com/a.png',
    'data:text/html;base64,PHNjcmlwdD4=',
    '//example.com/a.png',
    ''
  ])('drops an <img> whose src is %p', (src) => {
    expect(sanitizePostBody(`<p>x</p><img src="${src}">`)).toBe('<p>x</p>');
  });

  test('strips event handlers and non-numeric dimensions', () => {
    const out = sanitizePostBody('<img src="data:image/png;base64,AAAA" height="1;x" onerror="alert(1)" style="x">');
    expect(out).not.toMatch(/onerror|style|height/);
  });

  test('inline <svg> is still removed; only <img> carries a picture', () => {
    expect(sanitizePostBody('<svg><script>alert(1)</script></svg><p>ok</p>')).toBe('<p>ok</p>');
  });

  test('keeps the existing rich-text formats', () => {
    const html = '<h3>T</h3><ul><li><strong>a</strong></li></ul><pre>a  b</pre><a href="https://sap.com">l</a>';
    const out = sanitizePostBody(html);
    expect(out).toContain('<h3>T</h3>');
    expect(out).toContain('<pre>a  b</pre>');
    expect(out).toContain('rel="nofollow noopener noreferrer"');
  });

  test('every other rich-text field still refuses images', () => {
    expect(sanitizeRichText('<img src="https://example.com/a.png">')).toBe('');
  });
});

describe('the post editor', () => {
  test('quill is a declared dependency and its served files exist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies.quill).toBeDefined();
    for (const f of ['quill.js', 'quill.snow.css']) {
      expect(fs.existsSync(path.join(ROOT, 'node_modules', 'quill', 'dist', f))).toBe(true);
    }
  });

  test('the post body is saved and rendered through sanitizePostBody', () => {
    const route = fs.readFileSync(path.join(ROOT, 'routes', 'community.js'), 'utf8');
    const show = fs.readFileSync(path.join(ROOT, 'views', 'community', 'show.ejs'), 'utf8');
    expect(route).toContain('body: sanitizePostBody(req.body.body)');
    expect(show).toContain('sanitizePostBody(post.body)');
  });
});
