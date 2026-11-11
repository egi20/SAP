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

/*
 * Community post bodies additionally keep <img>, so an article can carry a diagram
 * (typically an SVG embedded as a data: URI). Only the post body, not replies, bios or
 * job adverts: those fields never needed pictures and widening them widens every page
 * that renders one.
 *
 * An SVG loaded through <img> is a picture, not a document: the browser runs none of its
 * scripts and fetches none of its external resources, so the data: URI is safe. Only
 * image media types are let through. A src that is anything else is removed, and an <img>
 * left without a src is dropped entirely rather than rendered as a broken box.
 */
const IMAGE_DATA_URI = /^data:image\/(?:svg\+xml|png|jpeg|gif|webp)(?:;[a-z0-9=._+-]+)*,/i;
const IMAGE_DIMENSION = /^\d{1,4}$/;

function isAllowedImageSrc(src) {
  const value = String(src || '').trim();
  if (IMAGE_DATA_URI.test(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

const POST_BODY_OPTIONS = {
  ...RICH_TEXT_OPTIONS,
  allowedTags: [...RICH_TEXT_OPTIONS.allowedTags, 'img'],
  allowedAttributes: {
    ...RICH_TEXT_OPTIONS.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height']
  },
  allowedSchemesByTag: { img: ['https', 'data'] },
  transformTags: {
    ...RICH_TEXT_OPTIONS.transformTags,
    img: (tagName, attribs) => {
      const out = {};
      if (isAllowedImageSrc(attribs.src)) out.src = String(attribs.src).trim();
      if (attribs.alt) out.alt = attribs.alt;
      if (attribs.title) out.title = attribs.title;
      for (const dim of ['width', 'height']) {
        if (IMAGE_DIMENSION.test(String(attribs[dim] || ''))) out[dim] = attribs[dim];
      }
      return { tagName, attribs: out };
    }
  },
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src
};

function sanitizePostBody(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), POST_BODY_OPTIONS);
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

module.exports = { sanitizeRichText, sanitizePostBody, toPlainText, jsonForScript };
