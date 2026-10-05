'use strict';

const crypto = require('crypto');

/**
 * The password a shell-created account starts with.
 *
 * It is generated here and printed once rather than taken from an argument, because a
 * password in an argument is a password in the shell history, in `ps` output while the
 * process runs, and in whatever ships those logs somewhere else.
 *
 * Readable but not guessable: characters from an alphabet with no look-alikes, so somebody
 * can retype it off a screen without wondering whether that is a 1 or an l.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 24) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length; i += 1) {
    // Rejection sampling rather than a modulo: `% 55` over 0-255 biases the first
    // characters of the alphabet, which is exactly the kind of quiet weakening nobody
    // notices in a password generator.
    const byte = bytes[i % bytes.length];
    if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) {
      out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

module.exports = { generatePassword, ALPHABET };
