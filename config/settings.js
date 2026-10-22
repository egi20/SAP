'use strict';

/**
 * Runtime-editable settings, and the complete list of them.
 *
 * The line this file draws, and it is the important part: a setting is an OPERATIONAL
 * switch — something you change at 2am without a deploy. It is never a catalogue value.
 * Roles, SAP modules, phase percentages, day rates and prices live in `config/*.js`
 * under version control, where a change has an author, a diff and a review. Moving any of
 * them into a database table someone can edit through a form would mean an estimate could
 * change with nobody able to say who changed it or when.
 *
 * The two guards that keep it that way:
 *
 *  1. Only keys DECLARED here can be written. An admin form posting an unknown field is
 *     ignored, so this file is provably the whole surface.
 *  2. Every value is coerced and validated by its declared type on the way in, so a
 *     boolean is a boolean and a string is bounded — a settings table is otherwise a
 *     place where a typo becomes a runtime error on every page.
 *
 * The privacy floor is deliberately NOT here. `RATE_MIN_SAMPLE` is an environment
 * variable precisely so that lowering it is a deployment decision rather than a checkbox
 * somebody clicks to make a sparse index look fuller.
 */

const { PLATFORMS, settingKeyFor, problemWith } = require('./social');

/*
 * The Hub's own social links (owner's request, 2026-10-22, as on dynamicshub.net's
 * Settings): the accounts change without a deploy, so they are operational. One key per
 * platform in config/social.js, generated from that list rather than written out, so a
 * platform added there gets its field here. Each value is host-checked on the way in
 * (`problemFor`) and again where it is rendered.
 */
const SOCIAL_DEFINITIONS = Object.fromEntries(PLATFORMS.map((platform) => [settingKeyFor(platform), {
  type: 'url',
  default: '',
  maxLength: 300,
  group: 'social',
  platform: platform.key,
  icon: platform.icon,
  label: `${platform.label} URL`,
  help: `Shown in the social rail, the footer and on the Contact page. Leave empty to use ${platform.env} from the environment, or to hide the icon if that is unset too.`
}]));

const DEFINITIONS = Object.freeze({
  registration_open: {
    type: 'boolean',
    default: true,
    label: 'Public registration is open',
    help: 'Turn off to stop new sign-ups without taking the site down. Existing accounts are unaffected.'
  },
  site_notice: {
    type: 'text',
    default: '',
    maxLength: 300,
    label: 'Site-wide notice',
    help: 'Shown as a banner on every page. Leave empty for none. Plain text — it is escaped, not rendered as markup.'
  },
  community_read_only: {
    type: 'boolean',
    default: false,
    label: 'Community is read-only',
    help: 'Existing posts stay visible; new posts and replies are refused. A blunt instrument for a bad day.'
  },
  ...SOCIAL_DEFINITIONS
});

const KEYS = Object.freeze(Object.keys(DEFINITIONS));

function isValidKey(key) {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, key);
}

/**
 * Coerce one submitted value to its declared type.
 *
 * Booleans read an HTML checkbox, which posts `'on'` when ticked and nothing at all when
 * not — so absence is false, and this must be called for every declared key rather than
 * only for the ones that turned up in the body.
 */
function coerce(key, raw) {
  /*
   * `isValidKey` rather than a truthiness check on the lookup, and this is a real bug a
   * test caught rather than a nicety: `DEFINITIONS['__proto__']` is `Object.prototype`,
   * which is perfectly truthy, so a plain `if (!definition)` guard would let a request
   * carrying `__proto__` fall straight through into the write path.
   */
  if (!isValidKey(key)) return null;
  const definition = DEFINITIONS[key];

  if (definition.type === 'boolean') {
    return raw === true || raw === 'on' || raw === 'true' || raw === '1';
  }

  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  return definition.maxLength ? text.slice(0, definition.maxLength) : text;
}

/**
 * Why a coerced value cannot be saved, or null. Only a link can be wrong in a way worth
 * refusing: a boolean is coerced, and text is bounded.
 */
function problemFor(key, value) {
  if (!isValidKey(key)) return null;
  const definition = DEFINITIONS[key];
  if (definition.type !== 'url' || !value) return null;
  const platform = PLATFORMS.find((p) => p.key === definition.platform);
  return problemWith(platform, value, definition.label);
}

/** Serialise for storage. One representation, so a read never has to guess. */
function serialise(key, value) {
  if (!isValidKey(key)) return null;
  return DEFINITIONS[key].type === 'boolean' ? (value ? '1' : '0') : String(value);
}

/** The inverse, tolerant of a row that predates a type change. */
function deserialise(key, stored) {
  if (!isValidKey(key)) return null;
  const definition = DEFINITIONS[key];
  if (stored === null || stored === undefined) return definition.default;
  if (definition.type === 'boolean') return stored === '1' || stored === 'true';
  return String(stored);
}

function defaults() {
  const out = {};
  for (const [key, definition] of Object.entries(DEFINITIONS)) out[key] = definition.default;
  return out;
}

/** Boot assertion, in the same spirit as the other catalogues. */
function assertSettingsIntegrity() {
  for (const [key, definition] of Object.entries(DEFINITIONS)) {
    if (!['boolean', 'text', 'url'].includes(definition.type)) {
      throw new Error(`Settings: "${key}" has an unknown type "${definition.type}"`);
    }
    if (definition.type === 'boolean' && typeof definition.default !== 'boolean') {
      throw new Error(`Settings: "${key}" is a boolean with a non-boolean default`);
    }
    if (definition.type !== 'boolean' && typeof definition.default !== 'string') {
      throw new Error(`Settings: "${key}" is text with a non-string default`);
    }
    if (definition.type === 'url' && !PLATFORMS.some((p) => p.key === definition.platform)) {
      throw new Error(`Settings: "${key}" names no platform in config/social.js`);
    }
    if (!definition.label) throw new Error(`Settings: "${key}" has no label`);
  }
  return true;
}

module.exports = {
  DEFINITIONS,
  KEYS,
  isValidKey,
  coerce,
  problemFor,
  serialise,
  deserialise,
  defaults,
  assertSettingsIntegrity
};
