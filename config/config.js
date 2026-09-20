'use strict';

require('dotenv').config();

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const DEFAULT_SESSION_SECRET = 'change-me-in-production';

/**
 * Central environment -> config object.
 *
 * Carried over from both reference implementations, and the one rule worth restating:
 * this module THROWS at boot in production when SESSION_SECRET is missing or still the
 * placeholder. A silently default-signed session cookie in production is a full
 * account-takeover primitive, so failing to start is the correct behaviour.
 *
 * Sections are added as the features that need them land. An empty config block for a
 * feature that does not exist yet reads like a feature that is broken.
 */
function required(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (NODE_ENV=${env})`);
  }
  return value;
}

const sessionSecret = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
if (isProduction && sessionSecret === DEFAULT_SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set to a non-default value in production');
}

const config = {
  env,
  isProduction,
  app: {
    name: process.env.APP_NAME || 'SAP Hub',
    port: parseInt(process.env.PORT, 10) || 3000,
    baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com'
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sap_hub',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 10
  },
  session: {
    secret: isProduction ? required('SESSION_SECRET', process.env.SESSION_SECRET) : sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    }
  },
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || (isProduction ? 12 : 10)
  },
  email: {
    resendApiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'SAP Hub <noreply@example.com>'
  },
  uploads: {
    // Durable bytes live in MySQL. This directory is a scratch cache only and is
    // assumed to be wiped on every deploy.
    tmpDir: process.env.UPLOAD_TMP_DIR || 'uploads',
    maxPhotoBytes: 5 * 1024 * 1024,
    maxDocumentBytes: 10 * 1024 * 1024
  },
  rates: {
    // Privacy floor: never publish an aggregate derived from fewer than this many
    // distinct people. Counting people (not submissions) is part of the rule.
    minSampleSize: parseInt(process.env.RATE_MIN_SAMPLE, 10) || 3
  }
};

module.exports = config;
