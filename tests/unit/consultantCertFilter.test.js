'use strict';

/*
 * "Who holds C_TS4FI?" — one named credential. "Certified only" could not answer it: a
 * SuccessFactors certificate satisfied the box for a finance search.
 */
const ConsultantProfile = require('../../models/ConsultantProfile');

describe('the certification filter', () => {
  it('filters on the stored stem, bound rather than interpolated', () => {
    const { clause, params } = ConsultantProfile.buildFilter({ cert_code: 'C_TS4FI' });
    expect(clause).toContain('cc2.code = ?');
    expect(clause).not.toContain('C_TS4FI');
    expect(params).toContain('C_TS4FI');
  });

  it('ignores a code the catalogue does not carry, and OTHER, which is free text', () => {
    expect(ConsultantProfile.buildFilter({ cert_code: 'C_MADEUP' }).clause).not.toContain('cc2.code');
    expect(ConsultantProfile.buildFilter({ cert_code: 'OTHER' }).clause).not.toContain('cc2.code');
  });
});
