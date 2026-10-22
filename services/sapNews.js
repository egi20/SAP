'use strict';

const sax = require('sax');
const { FALLBACK_NEWS } = require('../config/sapNews');

/**
 * "SAP news of the day" — the first card in the home feed (owner, 2026-10-22).
 *
 * The news is READ from SAP's own newsroom feed, never written here. A news card the Hub
 * typed itself would be a second newsroom nobody owns, and it would be stale the week after
 * it was written. Every item carries the source and the link to read the rest; the Hub
 * summarises nothing and invents nothing — the summary is the feed's own excerpt.
 *
 * Shape of the rules:
 *
 *  - The page NEVER waits on SAP. A render reads the cache; a stale or empty cache starts a
 *    refresh in the background and the page goes out with what it has. A newsroom that is
 *    slow or down must not make the home page slow or down.
 *  - A failed refresh keeps the last good copy. Only a process that has never fetched
 *    successfully shows the curated fallback (config/sapNews.js), which says it is that.
 *  - Links are HOST-PINNED to sap.com. The feed is somebody else's content rendered on our
 *    front page; an item pointing anywhere else is dropped, not linked.
 *  - Text is plain: tags are stripped and entities decoded here, and the template escapes
 *    what is left. No HTML from the feed reaches the page.
 *  - One item a day, different each day: the pick rotates through the newest items by the
 *    server's UTC date, so everybody sees the same one, and a reload does not change it.
 */

const FEED_URL = process.env.SAP_NEWS_FEED_URL || 'https://news.sap.com/feed/';
const SOURCE_LABEL = 'SAP News Center';
const REFRESH_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const ROTATION = 10;
const SUMMARY_CHARS = 280;

const state = { items: null, fetchedAt: 0, lastAttempt: 0, lastError: null, inFlight: null };

/** Only SAP's own hosts are linked from our front page. */
function isAllowedLink(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return host === 'sap.com' || host.endsWith('.sap.com');
  } catch (err) {
    return false;
  }
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(NAMED, code.toLowerCase()) ? NAMED[code.toLowerCase()] : whole;
  });
}

/** Feed HTML → one line of plain text. */
function toPlain(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function excerpt(text, max = SUMMARY_CHARS) {
  // WordPress appends "The post X appeared first on Y." — that is the feed talking, not the story.
  const clean = text.replace(/\s*The post .{1,300} appeared first on .{1,120}\.?\s*$/i, '').replace(/\s*\[(?:…|\.\.\.)\]\s*$/, '…');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).replace(/[\s,;:.—–-]+$/, '')}…`;
}

/** Pure: RSS 2.0 text → items. Never throws on a malformed feed; returns what it could read. */
function parseFeed(xml) {
  const items = [];
  const parser = sax.parser(false, { lowercase: true, trim: false });
  let current = null;
  let field = null;
  let text = '';
  parser.onerror = () => { parser.error = null; parser.resume(); };
  parser.onopentag = (node) => {
    if (node.name === 'item') current = {};
    else if (current) { field = node.name; text = ''; }
  };
  const add = (t) => { if (current && field) text += t; };
  parser.ontext = add;
  parser.oncdata = add;
  parser.onclosetag = (name) => {
    if (name === 'item' && current) {
      items.push(current);
      current = null;
    } else if (current && name === field) {
      if (!(field in current)) current[field] = text;
      field = null;
      text = '';
    }
  };
  try {
    parser.write(String(xml)).close();
  } catch (err) {
    /* keep what was read */
  }
  return items.map((raw) => {
    const date = new Date(raw.pubdate || '');
    return {
      title: toPlain(raw.title),
      link: String(raw.link || '').trim(),
      date: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      summary: excerpt(toPlain(raw.description)),
      category: toPlain(raw.category || ''),
      source: SOURCE_LABEL
    };
  }).filter((item) => item.title && isAllowedLink(item.link))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

async function refresh() {
  if (state.inFlight) return state.inFlight;
  state.lastAttempt = Date.now();
  state.inFlight = (async () => {
    try {
      const res = await fetch(FEED_URL, {
        headers: { Accept: 'application/rss+xml, application/xml;q=0.9', 'User-Agent': 'SAPHub-NewsReader/1.0 (+https://saphub)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`the feed answered ${res.status}`);
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new Error('the feed is larger than expected');
      const items = parseFeed(body);
      if (!items.length) throw new Error('the feed held no readable SAP items');
      state.items = items.slice(0, 30);
      state.fetchedAt = Date.now();
      state.lastError = null;
    } catch (err) {
      // Logged once per attempt; the last good copy stays.
      state.lastError = err.message;
      console.warn(`SAP news: refresh failed (${err.message}); keeping ${state.items ? 'the last good copy' : 'the fallback'}.`);
    } finally {
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}

function refreshIfStale(now = Date.now()) {
  // A test run never reaches out to SAP: its network is not the thing under test.
  if (process.env.NODE_ENV === 'test') return;
  const stale = !state.items || now - state.fetchedAt > REFRESH_MS;
  const mayRetry = now - state.lastAttempt > (state.items ? REFRESH_MS : RETRY_MS) || !state.lastAttempt;
  if (stale && mayRetry && !state.inFlight) refresh().catch(() => {});
}

/** Days since the epoch for an ISO date — the rotation's clock. */
function dayNumber(dateIso) {
  return Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 86400000);
}

/**
 * Pure: today's pick and the rest, from a list sorted newest first. Rotates through the
 * newest `ROTATION` items one day at a time; with one item it is simply that item.
 */
function pickFor(items, dateIso) {
  const pool = items.slice(0, ROTATION);
  if (!pool.length) return { today: null, more: [] };
  const index = ((dayNumber(dateIso) % pool.length) + pool.length) % pool.length;
  return { today: pool[index], more: pool.filter((_, i) => i !== index).slice(0, 5) };
}

/** What the home page renders. Never awaits the network. */
function newsOfTheDay(now = new Date()) {
  refreshIfStale(now.getTime());
  const live = Boolean(state.items && state.items.length);
  const items = live ? state.items : FALLBACK_NEWS;
  const { today, more } = pickFor(items, now.toISOString().slice(0, 10));
  if (!today) return null;
  const freshMs = today.date ? now.getTime() - Date.parse(today.date) : Infinity;
  return { today, more, live, isNew: freshMs >= 0 && freshMs < 48 * 3600 * 1000 };
}

function status() {
  return { feedUrl: FEED_URL, items: state.items ? state.items.length : 0, fetchedAt: state.fetchedAt || null, lastError: state.lastError };
}

/** For tests only. */
function reset(items = null) {
  state.items = items;
  state.fetchedAt = items ? Date.now() : 0;
  state.lastAttempt = items ? Date.now() : 0;
  state.lastError = null;
  state.inFlight = null;
}

module.exports = { newsOfTheDay, parseFeed, pickFor, isAllowedLink, toPlain, excerpt, refresh, status, reset, FEED_URL };
