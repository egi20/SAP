'use strict';

const fs = require('fs');
const path = require('path');
const { weekRange } = require('../../utils/weekRange');

describe('weekRange', () => {
  it('prints one week as one number and a span as a range', () => {
    expect(weekRange({ startWeek: 4, endWeek: 4 })).toBe('4');
    expect(weekRange({ startWeek: 2, endWeek: 6 })).toBe('2–6');
  });

  it('is what the quote page and both documents use, so they cannot disagree', () => {
    const root = path.join(__dirname, '..', '..');
    ['views/quotes/show.ejs', 'utils/documents/sowDocx.js', 'utils/documents/summaryPptx.js'].forEach((file) => {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      expect(source).toContain('weekRange(');
      expect(source).not.toMatch(/startWeek\s*%?>?\s*–/);
    });
  });
});
