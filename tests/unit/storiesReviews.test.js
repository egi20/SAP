'use strict';

const fs = require('fs');

const { embedUrlFor, EMBED_HOSTS } = require('../../utils/videoEmbed');
const SuccessStory = require('../../models/SuccessStory');
const { PRODUCT_LINES } = require('../../config/sapProducts');
const SiteReview = require('../../models/SiteReview');
const ImageBlob = require('../../models/ImageBlob');

/**
 * Two readers, because the scans want opposite things.
 *
 * `codeOf` strips comments AND string literals: used when scanning for an IDENTIFIER that
 * must not appear, where the prose explaining why it must not appear would otherwise flag
 * itself.
 *
 * `sqlOf` strips comments only: the SQL lives inside template literals, so stripping
 * strings would leave nothing to assert about.
 */
function sqlOf(modulePath) {
  return fs
    .readFileSync(require.resolve(modulePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function codeOf(modulePath) {
  return sqlOf(modulePath).replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");
}

/**
 * The video allowlist, which is the reference implementation's best code and is ported
 * almost unchanged. The default is what matters: only shapes it RECOGNISES produce an
 * embed. An `<iframe src>` built from a typed value is third-party script inside this
 * origin's page.
 */
describe('video embeds', () => {
  test('recognise the YouTube shapes people actually paste', () => {
    const expected = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    for (const input of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    ]) {
      expect(embedUrlFor(input)).toBe(expected);
    }
  });

  test('always use the privacy-enhanced host', () => {
    // Even when the author pasted the tracking one.
    expect(embedUrlFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toContain('youtube-nocookie.com');
  });

  test('recognise Vimeo, including an unlisted link', () => {
    expect(embedUrlFor('https://vimeo.com/123456789')).toBe('https://player.vimeo.com/video/123456789');
    expect(embedUrlFor('https://vimeo.com/123456789/abcdef123')).toBe('https://player.vimeo.com/video/123456789');
    expect(embedUrlFor('https://player.vimeo.com/video/123456789')).toBe('https://player.vimeo.com/video/123456789');
  });

  test('drop every parameter the author pasted', () => {
    // An embed URL should not inherit ?autoplay=1 or a tracking parameter.
    const built = embedUrlFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&autoplay=1&t=30&si=track');
    expect(built).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(built).not.toContain('autoplay');
    expect(built).not.toContain('si=');
  });

  test('always answer https, whatever arrived', () => {
    // An http link must not become a mixed-content frame.
    expect(embedUrlFor('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toMatch(/^https:/);
    expect(embedUrlFor('http://vimeo.com/123456789')).toMatch(/^https:/);
  });

  test('refuse everything else', () => {
    for (const input of [
      '',
      null,
      undefined,
      'not a url',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://evil.com/embed/x',
      'https://youtube.com/watch',
      'https://youtube.com/watch?v=',
      'https://vimeo.com/notanumber',
      'https://vimeo.com/'
    ]) {
      expect(embedUrlFor(input)).toBeNull();
    }
  });

  test('refuse a lookalike host', () => {
    // The classic: a suffix match would accept all of these.
    for (const input of [
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com.evil.com/123456789'
    ]) {
      expect(embedUrlFor(input)).toBeNull();
    }
  });

  test('every host it can produce is in the frame-src policy', () => {
    // Shared from one constant, so the CSP and the allowlist cannot drift apart — the
    // same reason WEBHOOK_PATH is shared between server.js and config/payments.js.
    const server = fs.readFileSync(require.resolve('../../server.js'), 'utf8');
    expect(server).toMatch(/frameSrc:\s*\["'self'",\s*\.\.\.EMBED_HOSTS\]/);

    for (const url of [
      embedUrlFor('https://youtu.be/dQw4w9WgXcQ'),
      embedUrlFor('https://vimeo.com/123456789')
    ]) {
      expect(EMBED_HOSTS.some((host) => url.startsWith(host))).toBe(true);
    }
  });

  test('nothing derived is stored', () => {
    // The conversion runs at render time from the raw value, so today's rules apply to
    // every row rather than whatever the rules were when it was pasted.
    const model = codeOf('../../models/SuccessStory');
    expect(model).not.toMatch(/embed_url|embedUrl/);
  });
});

describe('success stories', () => {
  const VALID = { title: 'Nine weeks to a live Service Cloud', body: '<p>What we did.</p>' };

  test('carry no money fields at all', () => {
    // The reference stores gross_before / net_before / gross_after / net_after and renders
    // the difference as a monthly saving — the savings calculator in a different hat,
    // attached to a named person.
    const forbidden = /gross_before|net_before|gross_after|net_after|savings?|salary|take_?home/i;

    const model = sqlOf('../../models/SuccessStory');
    expect(model).not.toMatch(forbidden);

    const migration = fs.readFileSync(
      require.resolve('../../scripts/migrations/016_stories_reviews.sql'),
      'utf8'
    ).replace(/^--.*$/gm, '');
    expect(migration).not.toMatch(forbidden);

    expect(Object.keys(SuccessStory.normalise(VALID))).not.toContain('gross_before');
  });

  test('refuse a story with no title or no body', () => {
    expect(() => SuccessStory.normalise({ ...VALID, title: '' })).toThrow(/title/i);
    expect(() => SuccessStory.normalise({ ...VALID, body: '' })).toThrow(/body/i);
    // A body of only markup sanitises to nothing, which is still no body.
    expect(() => SuccessStory.normalise({ ...VALID, body: '<script>x()</script>' })).toThrow(/body/i);
  });

  test('sanitise the body before it is ever stored', () => {
    const out = SuccessStory.normalise({ ...VALID, body: '<p>Fine</p><script>alert(1)</script>' });
    expect(out.body).not.toMatch(/<script/i);
    expect(out.body).toMatch(/Fine/);
  });

  test('keep only a real product line', () => {
    // The same eight-value vocabulary the job board, the estimator, the community
    // categories and the agency directory use — never free text.
    const line = PRODUCT_LINES[0].value;
    expect(SuccessStory.normalise({ ...VALID, family: line }).family).toBe(line);
    expect(SuccessStory.normalise({ ...VALID, family: 'made-up' }).family).toBeNull();
  });

  test('store the video URL as typed, unvalidated', () => {
    // Deliberate: the allowlist runs at render time, so an unusable link is visibly
    // absent rather than silently trusted because it passed a check once.
    expect(SuccessStory.normalise({ ...VALID, video_url: 'https://evil.com/x' }).video_url)
      .toBe('https://evil.com/x');
    expect(embedUrlFor('https://evil.com/x')).toBeNull();
  });

  test('the filter hides drafts and hidden stories by default', () => {
    const { clause } = SuccessStory.buildFilter({});
    expect(clause).toContain('s.published_at IS NOT NULL');
    expect(clause).toContain('s.hidden_at IS NULL');
  });

  test('include_unpublished is the single opt-in, and only admin uses it', () => {
    const { clause } = SuccessStory.buildFilter({ include_unpublished: true });
    expect(clause).not.toContain('published_at');

    const publicRoute = codeOf('../../routes/stories');
    expect(publicRoute).not.toMatch(/include_unpublished/);
  });

  test('the filter is parameterised', () => {
    const { clause, params } = SuccessStory.buildFilter({ q: "o'brien %_", family: 'x' });
    expect(clause).not.toMatch(/o'brien/);
    expect(params[0]).toBe("%o'brien \\%\\_%");
  });

  test('a slug lookup re-checks visibility rather than trusting the link', () => {
    const model = sqlOf('../../models/SuccessStory');
    const fn = model.slice(model.indexOf('static async findPublishedBySlug'), model.indexOf('static async list'));
    expect(fn).toMatch(/published_at IS NOT NULL/);
    expect(fn).toMatch(/hidden_at IS NULL/);
  });

  test('there is no delete anywhere', () => {
    const model = sqlOf('../../models/SuccessStory');
    expect(model).not.toMatch(/DELETE FROM/i);
  });
});

describe('site reviews', () => {
  const VALID = { rating: '5', body: 'x'.repeat(60) };

  test('refuse a rating outside one to five', () => {
    // '3.5' and '4abc' matter: parseInt would round both into a rating nobody chose.
    for (const rating of ['0', '6', '-1', '', 'five', '3.5', '4abc', ' 3 ', null, {}]) {
      expect(() => SiteReview.normaliseSubmission({ ...VALID, rating })).toThrow(/rating/i);
    }
  });

  test('accept each valid rating', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(SiteReview.normaliseSubmission({ ...VALID, rating: String(rating) }).rating).toBe(rating);
    }
  });

  test('refuse a review too short to be worth reading', () => {
    expect(() => SiteReview.normaliseSubmission({ ...VALID, body: 'Great!' })).toThrow(/at least/i);
  });

  test('truncate rather than throw on an over-long body', () => {
    const out = SiteReview.normaliseSubmission({ ...VALID, body: 'y'.repeat(50_000) });
    expect(out.body).toHaveLength(SiteReview.MAX_BODY);
  });

  test('derive the author role from the account, never from the form', () => {
    // The reference stores a free-text author_role, so "Salesforce MVP" becomes a claim
    // the page renders as fact.
    expect(SiteReview.roleLabelFor({ isConsultant: true })).toBe('consultant');
    expect(SiteReview.roleLabelFor({ isCompany: true })).toBe('company');
    expect(SiteReview.roleLabelFor({ isRecruiter: true })).toBe('recruiter');
    expect(SiteReview.roleLabelFor({})).toBeNull();
    expect(SiteReview.roleLabelFor(null)).toBeNull();

    // And nothing reads it out of the body.
    const model = codeOf('../../models/SiteReview');
    expect(model).not.toMatch(/input\.author_role|body\.author_role/);
    const route = codeOf('../../routes/stories');
    expect(route).not.toMatch(/author_role|author_name/);
  });

  test('normaliseSubmission returns only a rating and a body', () => {
    const out = SiteReview.normaliseSubmission({ ...VALID, author_name: 'Fake', approved_at: 'now', user_id: 9 });
    expect(Object.keys(out).sort()).toEqual(['body', 'rating']);
  });

  test('published means approved AND not hidden', () => {
    const { clause } = SiteReview.buildFilter({});
    expect(clause).toContain('r.approved_at IS NOT NULL');
    expect(clause).toContain('r.hidden_at IS NULL');
  });

  test('editing clears the approval but not a hide', () => {
    const model = sqlOf('../../models/SiteReview');
    const submit = model.slice(model.indexOf('static async submit'), model.indexOf('static async forUser'));
    // An approved review whose text can be swapped afterwards is an approval that means
    // nothing.
    expect(submit).toMatch(/approved_at = NULL/);
    expect(submit).toMatch(/approved_by = NULL/);
    // Somebody hidden for abuse must not un-hide themselves by editing.
    expect(submit).not.toMatch(/hidden_at = NULL/);
  });

  test('there is no delete anywhere', () => {
    // SiteReview.delete in the reference is a hard DELETE reachable from a bulk action.
    const model = sqlOf('../../models/SiteReview');
    expect(model).not.toMatch(/DELETE FROM/i);
    expect(typeof SiteReview.delete).toBe('undefined');
    expect(typeof SiteReview.deleteMany).toBe('undefined');

    const admin = codeOf('../../routes/admin');
    expect(admin).not.toMatch(/SiteReview\.delete|SuccessStory\.delete/);
  });

  test('a public listing never selects an email address', () => {
    const model = sqlOf('../../models/SiteReview');
    expect(model).not.toMatch(/u\.email/);
  });

  test('an average is null rather than zero when there is nothing to average', () => {
    // "0.0 out of 5" is a claim; an absent average is a fact. Asserted on the shape the
    // model builds from a row, since the query itself needs a database.
    const model = codeOf('../../models/SiteReview');
    expect(model).toMatch(/total \? Math\.round/);
  });
});

describe('the shared blob store', () => {
  test('keys each table on its own owner column', () => {
    // A story has no user behind it, so the column could not stay `user_id` everywhere.
    const code = sqlOf('../../models/ImageBlob');
    expect(code).not.toMatch(/WHERE user_id = \?/);
    expect(code.match(/ownerColumn\(table\)/g).length).toBeGreaterThanOrEqual(4);
  });

  test('refuses a table it does not know, including __proto__', () => {
    // `ALLOWED_TABLES['__proto__']` is Object.prototype, which is truthy — the trap
    // config/settings.js already documents.
    return Promise.all([
      expect(ImageBlob.get('evil_table', 1)).rejects.toThrow(/Unknown blob table/),
      expect(ImageBlob.get('__proto__', 1)).rejects.toThrow(/Unknown blob table/),
      expect(ImageBlob.get('constructor', 1)).rejects.toThrow(/Unknown blob table/)
    ]);
  });
});
