'use strict';

/**
 * Turn a stored video URL into an embed URL, or answer null.
 *
 * THIS IS THE REFERENCE IMPLEMENTATION'S BEST CODE and it is ported almost unchanged,
 * which is worth saying because most of what this codebase takes from there it takes as a
 * correction. `routes/successStories.js` there gets the hard part right: only URL shapes
 * it RECOGNISES produce an embed, everything else returns null, and YouTube goes through
 * the privacy-enhanced no-cookie host.
 *
 * That default matters more than the allowlist itself. An `<iframe src>` built from a
 * value somebody typed into an admin form is a frame of arbitrary third-party script
 * inside this origin's page; the safe shape is "recognise a handful of forms, refuse
 * everything else", not "reject the ones that look dangerous".
 *
 * Two things are tightened here:
 *
 *  - The conversion happens at RENDER time, from the raw stored value, rather than being
 *    stored as a derived `embed_url`. A stored embed URL looks trustworthy because of a
 *    check made once, in the past, by code that may since have changed; re-deriving means
 *    the current rules always apply to every row.
 *  - Query strings and fragments are DROPPED rather than carried through. The reference
 *    reads `?v=` and discards the rest, which is right for `/watch`, but building the
 *    embed from the id alone makes that explicit for every shape — an embed URL should
 *    not inherit `?autoplay=1` or a tracking parameter from what an author pasted.
 */

/**
 * A YouTube or Vimeo id, conservatively. Both are opaque, so this bounds the shape rather
 * than trying to validate it: letters, digits, underscore and hyphen, 5 to 20 characters.
 */
const ID = /^[A-Za-z0-9_-]{5,20}$/;

/** Vimeo ids are numeric. */
const VIMEO_ID = /^\d{5,20}$/;

function youtube(id) {
  return ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

function embedUrlFor(videoUrl) {
  const raw = String(videoUrl ?? '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // http is accepted on the way in and never on the way out: every embed produced below
  // is https, so an author pasting an http link does not create a mixed-content frame.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parsed.pathname === '/watch') return youtube(parsed.searchParams.get('v'));

    const shorts = parsed.pathname.match(/^\/shorts\/([^/]+)$/);
    if (shorts) return youtube(shorts[1]);

    const embed = parsed.pathname.match(/^\/embed\/([^/]+)$/);
    if (embed) return youtube(embed[1]);

    return null;
  }

  if (host === 'youtu.be') {
    return youtube(parsed.pathname.replace(/^\//, '').split('/')[0]);
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // `/12345`, `/video/12345`, and `/12345/abcdef` (an unlisted link's hash — the id is
    // still the first segment, and the hash is dropped with everything else).
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = segments[0] === 'video' ? segments[1] : segments[0];
    return VIMEO_ID.test(first || '') ? `https://player.vimeo.com/video/${first}` : null;
  }

  return null;
}

/** Which hosts a page carrying an embed has to allow in its frame-src. */
const EMBED_HOSTS = Object.freeze(['https://www.youtube-nocookie.com', 'https://player.vimeo.com']);

module.exports = { embedUrlFor, EMBED_HOSTS };
