'use strict';

const geoip = require('geoip-lite');

/**
 * Offline IP -> ISO country code. No external call is made, and nothing beyond the
 * two-letter country is ever derived or stored: the visitor tables hold a country and
 * a count, never an address.
 */
function countryFromIp(ip) {
  if (!ip) return null;
  const clean = String(ip).replace(/^::ffff:/, '').split(',')[0].trim();
  if (!clean || clean === '::1' || clean === '127.0.0.1') return null;
  const lookup = geoip.lookup(clean);
  return lookup && lookup.country ? lookup.country : null;
}

/*
 * ISO code -> country name, from the one list the forms are built from.
 *
 * The column stores a two-letter code, and a profile rendered "Tirana, AL" reads as an
 * abbreviation somebody is expected to already know — on the public profile, on the
 * consultant card and, worse, on a CV that goes to an employer. Built once at module load
 * from `config/all-countries.json`, which is the same list every country select on the
 * site is rendered from, so a name here can never be one the form could not have produced.
 */
const COUNTRY_NAMES = new Map(
  require('../config/all-countries.json').map((c) => [c.code, c.name])
);

/**
 * The country's name, or the code itself when it is not one we know.
 *
 * Falling back to the code rather than to null or an empty string: a row holding something
 * unexpected should still render as the fact it holds, not disappear from the page.
 */
function countryName(code) {
  if (!code) return null;
  return COUNTRY_NAMES.get(String(code).toUpperCase()) || code;
}

/**
 * A place, as a person reads it: city first, then the country's name.
 */
function locationLabel(city, code) {
  return [city, countryName(code)].filter(Boolean).join(', ') || null;
}

/**
 * The client IP, honouring `X-Forwarded-For` only when Express has been told to trust
 * the proxy. Reading the header unconditionally would let any client spoof its origin.
 */
function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || null;
}

/** Pack an IP into VARBINARY(16) form for storage, or null when unparseable. */
function packIp(ip) {
  if (!ip) return null;
  const clean = String(ip).replace(/^::ffff:/, '');
  const v4 = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    return Buffer.from(octets);
  }
  if (!clean.includes(':')) return null;
  try {
    const groups = expandIpv6(clean);
    if (!groups) return null;
    const buf = Buffer.alloc(16);
    groups.forEach((g, i) => buf.writeUInt16BE(g, i * 2));
    return buf;
  } catch {
    return null;
  }
}

function expandIpv6(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const parts = halves.length === 2 ? [...head, ...Array(fill).fill('0'), ...tail] : head;
  const groups = parts.map((p) => parseInt(p || '0', 16));
  return groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : groups;
}

module.exports = {
  countryName,
  locationLabel, countryFromIp, clientIp, packIp };
