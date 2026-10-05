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

/*
 * The support address is printed on a public page, so an unset one is not a missing
 * setting — it is a wrong answer, given confidently, to the one question somebody asks
 * when they are already stuck. The example value ships in `.env.example` and is therefore
 * exactly what an install that skipped this step will carry.
 */
const PLACEHOLDER_SUPPORT_EMAIL = 'support@example.com';
if (isProduction && (process.env.SUPPORT_EMAIL || PLACEHOLDER_SUPPORT_EMAIL) === PLACEHOLDER_SUPPORT_EMAIL) {
  throw new Error('SUPPORT_EMAIL must be set to a real address in production');
}

const config = {
  env,
  isProduction,
  app: {
    name: process.env.APP_NAME || 'SAP Hub',
    port: parseInt(process.env.PORT, 10) || 3000,
    baseUrl: (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    supportEmail: process.env.SUPPORT_EMAIL || PLACEHOLDER_SUPPORT_EMAIL
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
  stripe: {
    /*
     * Unset keys disable payments ENTIRELY rather than half-enabling them: the routes
     * offer a "not available" path and no checkout can be created. Half-configured is the
     * worse failure — a button that appears, takes somebody to a checkout, and fails after
     * they have entered a card number. See utils/stripe.js.
     */
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || ''
  },

  linkedin: {
    /*
     * LINKING ONLY, never a sign-in method — see config/linkedin.js. Both unset disables
     * the feature: the button is not rendered and the routes say so plainly. Setting one
     * without the other is refused at boot, because a half-configured OAuth flow fails
     * after the member has already granted access.
     */
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || ''
  },

  assistant: {
    /*
     * Unset disables the assistant the same way an unset Stripe key disables payments:
     * the widget is never rendered and the endpoint answers 503. Everything else about
     * the feature — model, caps, limits — lives in config/assistant.js, which asserts
     * itself at boot.
     */
    apiKey: process.env.ANTHROPIC_API_KEY || ''
  },
  rates: {
    // Privacy floor: never publish an aggregate derived from fewer than this many
    // distinct people. Counting people (not submissions) is part of the rule.
    minSampleSize: parseInt(process.env.RATE_MIN_SAMPLE, 10) || 3
  }
};

module.exports = config;
