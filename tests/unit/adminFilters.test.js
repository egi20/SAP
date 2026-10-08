'use strict';

/**
 * The three admin screens' own filters, and the vocabulary the moderation log now owns.
 */

const fs = require('fs');
const path = require('path');
const ErrorLog = require('../../models/ErrorLog');
const Job = require('../../models/Job');
const Moderation = require('../../models/Moderation');

const root = path.join(__dirname, '..', '..');

describe('Moderation.SUBJECT_TYPES', () => {
  // The comparison against the EFFECTIVE schema lives in adminCatalogues.test.js, which
  // walks every migration in order rather than pinning itself to the one that happens to
  // define the column today. Pinning is how that test failed on this change while the
  // code it was checking was correct.

  it('can act on a profile and an advert, which is what 025 and 026 added', () => {
    expect(Moderation.SUBJECT_TYPES).toContain('consultant_profile');
    expect(Moderation.SUBJECT_TYPES).toContain('job');
    expect(typeof Moderation.setProfileHidden).toBe('function');
    expect(typeof Moderation.setJobHidden).toBe('function');
  });
});

describe('a takedown has no escape hatch on the filter builder', () => {
  it('Job.buildFilter always excludes an advert taken down', () => {
    // Whatever else is asked for. An `include_hidden` option is how the rule ends up
    // switched off on whichever page forgets to pass it.
    [{}, { status: 'draft' }, { status: 'closed', q: 'x' }].forEach((filters) => {
      expect(Job.buildFilter(filters).clause).toContain('j.admin_hidden_at IS NULL');
    });
  });

  it('and neither builder offers one', () => {
    /*
     * Comments stripped first. A test that greps the source for a forbidden string also
     * matches the sentence explaining why the string is forbidden — and the tempting fix
     * is to delete the sentence. This one caught itself on the first run.
     */
    const withoutComments = (source) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    ['models/Job.js', 'models/ConsultantProfile.js'].forEach((file) => {
      const source = withoutComments(fs.readFileSync(path.join(root, file), 'utf8'));
      expect(source).not.toMatch(/include_hidden|includeHidden/);
    });
  });

  it('the one screen that sees them reads from Moderation instead', () => {
    const source = fs.readFileSync(path.join(root, 'models', 'Moderation.js'), 'utf8');
    const block = source.slice(source.indexOf('static async hiddenContent'));
    expect(block).toContain('FROM jobs j');
    expect(block).toContain('FROM consultant_profiles p');
  });
});

describe('the member cannot undo a moderator', () => {
  it('ConsultantProfile.setPublic refuses while an administrator has it hidden', () => {
    /*
     * If this check were missing the member would press Publish again and the decision
     * would be gone, with nothing on their screen having said one was made.
     */
    const source = fs.readFileSync(path.join(root, 'models', 'ConsultantProfile.js'), 'utf8');
    const block = source.slice(source.indexOf('static async setPublic'));
    expect(block).toContain('admin_hidden_at');
    expect(block).toMatch(/adminHidden: true/);
  });

  it('and the two columns are not the same column', () => {
    const sql = fs.readFileSync(path.join(root, 'scripts', 'migrations', '025_profile_moderation.sql'), 'utf8');
    expect(sql).toContain('admin_hidden_at');
    // `is_public` is the member's and is never touched by 025.
    expect(sql).not.toMatch(/MODIFY COLUMN is_public|DROP COLUMN is_public/);
  });
});

describe('ErrorLog.buildFilter', () => {
  it('puts the search through likePattern', () => {
    expect(ErrorLog.buildFilter({ q: '100%' }).params).toContain('%100\\%%');
  });

  it('includes the whole of the last day asked for', () => {
    /*
     * `created_at <= '2026-01-05'` means midnight at the START of the 5th, so the obvious
     * spelling silently drops everything that happened on the last day of the range — the
     * one day somebody is most likely to care about.
     */
    const { clause } = ErrorLog.buildFilter({ to: '2026-01-05' });
    expect(clause).toContain('DATE_ADD(?, INTERVAL 1 DAY)');
    expect(clause).not.toMatch(/created_at <= \?/);
  });

  it('ignores a status code that is not one, and a date that is not one', () => {
    expect(ErrorLog.buildFilter({ statusCode: '999' }).clause).toBe('1 = 1');
    expect(ErrorLog.buildFilter({ statusCode: 'drop' }).clause).toBe('1 = 1');
    expect(ErrorLog.buildFilter({ from: '2026-13-45x' }).clause).toBe('1 = 1');
  });

  it('is used by the list, the summary and the export alike', () => {
    const source = fs.readFileSync(path.join(root, 'models', 'ErrorLog.js'), 'utf8');
    ['static async list', 'static async topPaths', 'static async exportRows'].forEach((method) => {
      const block = source.slice(source.indexOf(method), source.indexOf(method) + 700);
      expect(block).toContain('ErrorLog.buildFilter');
    });
  });

  it('groups by a real column, never an alias', () => {
    // The trap /admin/analytics hit: MySQL resolves a name against the table's real
    // columns first, and grouping by an alias that shares a name groups by the wrong one.
    const source = fs.readFileSync(path.join(root, 'models', 'ErrorLog.js'), 'utf8');
    expect(source).toContain('GROUP BY path');
    expect(source).not.toMatch(/AS path[\s\S]{0,200}GROUP BY path/);
  });

  it('leaves the stack trace out of an export', () => {
    // The one field that can carry a file path, a query fragment or a value from the
    // request behind it, in a file that leaves the machine.
    const source = fs.readFileSync(path.join(root, 'models', 'ErrorLog.js'), 'utf8');
    const block = source.slice(source.indexOf('static async exportRows'));
    expect(block).not.toContain('stack');
  });
});
