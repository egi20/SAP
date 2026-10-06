'use strict';

/**
 * The application filter builder, the status vocabulary, and who may move what.
 *
 * All three were spread out: the statuses were typed into a route and again into a
 * template, the per-job list had its own two-line WHERE, and only one side of the state
 * machine declared which transitions were its own. None of that is visible on the page,
 * which is why it is asserted here.
 */

const fs = require('fs');
const path = require('path');
const Application = require('../../models/Application');

const MIGRATION = path.join(__dirname, '..', '..', 'scripts', 'migrations', '003_jobs.sql');

/** Comments are stripped before any structural assertion: the sentence explaining why a
 *  thing is forbidden contains the forbidden thing, and the tempting fix is to delete it. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<%#[\s\S]*?%>/g, '');
}

describe('Application.STATUSES', () => {
  it('matches the ENUM in migration 003, in order', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const applications = sql.slice(sql.indexOf('CREATE TABLE applications'));
    const match = applications.match(/status\s+ENUM\(([^)]+)\)/);
    expect(match).not.toBeNull();

    const fromSchema = match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(Application.STATUSES).toEqual(fromSchema);
  });

  it('is derived from the state machine rather than written out again', () => {
    expect(Application.STATUSES).toEqual(Object.keys(Application.TRANSITIONS));
  });

  it('does not reappear as literals in the route that validates them', () => {
    const source = withoutComments(
      fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'applications.js'), 'utf8')
    );
    // 'submitted' and the rest belong to the schema. A route that spells one out is the
    // second copy, and the failure is silent: a stage filtered in the template and
    // rejected by the handler behind it.
    ['submitted', 'reviewing', 'shortlisted', 'offered', 'hired', 'rejected'].forEach((status) => {
      expect(source).not.toContain(`'${status}'`);
    });
  });
});

describe('Application.buildFilter', () => {
  it('refuses to answer an unscoped question', () => {
    // Without a company or a job this would be every application on the site.
    expect(() => Application.buildFilter({})).toThrow(/scoped/i);
  });

  it('hides withdrawn applications unless they are asked for', () => {
    const { clause } = Application.buildFilter({ company_user_id: 1 });
    expect(clause).toContain("a.status <> 'withdrawn'");

    const included = Application.buildFilter({ company_user_id: 1, include_withdrawn: true });
    expect(included.clause).not.toContain("a.status <> 'withdrawn'");

    // Asking for them by name is asking for them.
    const byName = Application.buildFilter({ company_user_id: 1, status: 'withdrawn' });
    expect(byName.clause).toContain('a.status = ?');
    expect(byName.params).toContain('withdrawn');
  });

  it('puts a search through likePattern', () => {
    const { params } = Application.buildFilter({ company_user_id: 1, q: '100%' });
    // A search for "100%" is a search for a per-cent sign, not for everything.
    expect(params).toContain('%100\\%%');
  });

  it('ignores a status or a stage it does not recognise', () => {
    const { clause, params } = Application.buildFilter({
      company_user_id: 1,
      status: 'promoted',
      reached: 'promoted'
    });
    expect(params).not.toContain('promoted');
    expect(clause).not.toContain('EXISTS');
  });

  it('reads "has interviewed" from the event log, not from the current status', () => {
    const { clause, params } = Application.buildFilter({ company_user_id: 1, reached: 'interviewing' });
    // Somebody who interviewed and was then turned down has still interviewed.
    expect(clause).toContain('application_events');
    expect(clause).not.toContain("a.status = 'interviewing'");
    expect(params).toContain('interviewing');
  });

  it('binds every value and interpolates none', () => {
    const { clause } = Application.buildFilter({
      company_user_id: 7, job_id: 9, q: "'; DROP TABLE users; --", reached: 'interviewing'
    });
    expect(clause).not.toContain('DROP TABLE');
    expect(clause).not.toContain('7');
  });
});

describe('who may move an application', () => {
  it('never offers an employer the applicant\'s own withdrawal', () => {
    /*
     * Withdrawing is an act by the candidate, and `countForJob` excludes withdrawn rows on
     * exactly that reading. An employer able to set it can quietly change what the public
     * count on their own advert means.
     */
    Application.STATUSES.forEach((status) => {
      expect(Application.transitionsFor(status, { actorIsEmployer: true })).not.toContain('withdrawn');
    });
  });

  it('never offers a consultant a hiring decision', () => {
    Application.STATUSES.forEach((status) => {
      const allowed = Application.transitionsFor(status, { actorIsEmployer: false });
      ['reviewing', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected'].forEach((to) => {
        expect(allowed).not.toContain(to);
      });
    });
  });

  it('offers nothing the state machine would refuse', () => {
    Application.STATUSES.forEach((status) => {
      [true, false].forEach((actorIsEmployer) => {
        Application.transitionsFor(status, { actorIsEmployer }).forEach((to) => {
          expect(Application.canTransition(status, to)).toBe(true);
        });
      });
    });
  });
});

describe('the board', () => {
  it('carries the live stages and neither closed outcome', () => {
    // A closed-outcome column only grows; within a month it is the widest thing on the
    // screen and the live stages are off the edge of it.
    expect(Application.BOARD_COLUMNS).not.toContain('rejected');
    expect(Application.BOARD_COLUMNS).not.toContain('withdrawn');
    Application.BOARD_COLUMNS.forEach((c) => expect(Application.STATUSES).toContain(c));
  });
});
