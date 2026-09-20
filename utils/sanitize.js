'use strict';

const sanitizeHtml = require('sanitize-html');

/**
 * Rich text authored by users. Allows a deliberately small tag set; everything else,
 * including every attribute not listed, is stripped rather than escaped.
 */
const RICH_TEXT_OPTIONS = {
  allowedTags: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h3',
    'h4',
    'a',
    'code',
    'pre'
  ],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    // Any surviving link leaves the site with no referrer and no window.opener handle.
    a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' })
  }
};

function sanitizeRichText(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), RICH_TEXT_OPTIONS);
}

/** Strip all markup, e.g. for meta descriptions and list previews. */
function toPlainText(html, maxLength = 0) {
  if (!html) return '';
  const text = sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLength > 0 && text.length > maxLength) {
    return `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * Serialise a value for embedding inside a <script> block.
 *
 * `</script>` inside a string would close the block early, and U+2028/U+2029 are
 * literal line terminators in JavaScript source even though they are legal, unescaped,
 * inside a JSON string.
 */
function jsonForScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

module.exports = { sanitizeRichText, toPlainText, jsonForScript };
