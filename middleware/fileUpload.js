'use strict';

const multer = require('multer');
const config = require('../config/config');
const { returnTo } = require('../utils/returnTo');
const { verifyDeferred, csrfError } = require('./csrf');

/*
 * Every route that accepts a multipart body, as the full path. The CSRF middleware defers
 * its check for exactly these (see middleware/csrf.js) and the helpers below run it once
 * multer has parsed the body. A new upload route that is not listed here is refused by
 * the CSRF middleware — it fails closed, loudly, the first time anybody tries it.
 */
const UPLOAD_PATHS = Object.freeze([
  /^\/profile\/consultant\/photo$/,
  /^\/profile\/company\/logo$/,
  /^\/recruiters\/profile\/logo$/,
  /^\/admin\/stories\/\d+\/photo$/,
  /^\/report-issue$/
]);

function isUploadPath(req) {
  return req.method === 'POST' && UPLOAD_PATHS.some((re) => re.test(req.path));
}

/**
 * Uploads are held in memory and written straight to the database.
 *
 * There is deliberately no disk destination: the host filesystem is ephemeral, so a
 * file that exists only on disk is gone at the next deploy. Keeping the bytes in memory
 * for the length of one request and storing them in MySQL removes that whole class of
 * "the image disappeared" bug.
 *
 * The extension allowlist is checked ALONGSIDE the MIME type, never instead of it: the
 * client controls both, so neither alone is evidence. The real guarantee comes later,
 * when sharp re-encodes the image and anything that was not an image fails to decode.
 */
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

function imageFilter(req, file, cb) {
  if (!IMAGE_MIME.has(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG, WebP or GIF images are accepted.'));
  }
  if (!IMAGE_EXT.test(file.originalname || '')) {
    return cb(new Error('That file extension is not accepted for an image.'));
  }
  return cb(null, true);
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxPhotoBytes, files: 1 },
  fileFilter: imageFilter
});

/**
 * Turn multer's own errors into flash + redirect rather than a 500.
 * A file that is too large is a user mistake, not a server fault.
 */
function handleUploadErrors(req, res, next) {
  return (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large. The limit is ${Math.round(config.uploads.maxPhotoBytes / 1024 / 1024)} MB.`
        : err.message;
    req.flash('error', message);
    return res.redirect(returnTo(req, '/dashboard'));
  };
}

/** Wrap a multer middleware so its errors go through `handleUploadErrors`. */
function singleImage(fieldName) {
  const handler = imageUpload.single(fieldName);
  return (req, res, next) => handler(req, res, (err) => {
    // The deferred CSRF check comes first: a forged request learns nothing from an upload error.
    if (!verifyDeferred(req)) return next(csrfError());
    return handleUploadErrors(req, res, next)(err);
  });
}

/*
 * Screenshots on /report-issue: up to SCREENSHOT_MAX_FILES images of up to
 * SCREENSHOT_MAX_BYTES each. Images only — every one is re-encoded by sharp before it is
 * stored, and a PDF or an office document from a stranger is exactly what that re-encode
 * exists to keep away from the administrator who opens the report.
 *
 * An upload problem does NOT redirect: it is put on `req.uploadError` and the route
 * re-renders the form with everything typed still in it. A refused form re-renders.
 */
const SCREENSHOT_MAX_FILES = 5;
const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCREENSHOT_MAX_BYTES, files: SCREENSHOT_MAX_FILES, fields: 40 },
  fileFilter: imageFilter
});

function screenshots(fieldName) {
  const handler = screenshotUpload.array(fieldName, SCREENSHOT_MAX_FILES);
  return (req, res, next) => handler(req, res, (err) => {
    if (!verifyDeferred(req)) return next(csrfError());
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE' ? `Each screenshot can be at most ${SCREENSHOT_MAX_BYTES / 1024 / 1024} MB.`
          : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') ? `At most ${SCREENSHOT_MAX_FILES} screenshots.`
            : err.message;
      req.files = [];
    }
    return next();
  });
}

module.exports = {
  singleImage, imageUpload, screenshots, isUploadPath, UPLOAD_PATHS,
  SCREENSHOT_MAX_FILES, SCREENSHOT_MAX_BYTES
};
