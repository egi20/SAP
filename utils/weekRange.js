'use strict';

/**
 * A phase's weeks as a reader writes them: "4" for a phase inside one week, "4–6" otherwise.
 *
 * One function for the quote page and the documents generated from it, so the web page and
 * the file sent to a client cannot print the same phase two ways. "4–4" was what both did.
 */
function weekRange({ startWeek, endWeek }) {
  return startWeek === endWeek ? String(startWeek) : `${startWeek}–${endWeek}`;
}

module.exports = { weekRange };
