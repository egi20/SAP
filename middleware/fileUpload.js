'use strict';

const multer = require('multer');
const config = require('../config/config');
const { returnTo } = require('../utils/returnTo');

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
  return (req, res, next) => handler(req, res, handleUploadErrors(req, res, next));
}

module.exports = { singleImage, imageUpload };
