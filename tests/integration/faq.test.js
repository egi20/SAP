'use strict';

/**
 * /faq: every question in config/faq.js is on the page and in the FAQPage structured data,
 * and every link an answer gives opens.
 *
 * Plain Node client: no Sec-Fetch-Dest, so a signed-in-only page answers 302 to the login
 * form (CLAUDE.md, "Auth and roles"), which counts as a link that works.
 */

const request = require('supertest');
const { FAQ_QUESTIONS } = require('../../config/faq');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);
let app;

beforeAll(() => {
  if (reachable) app = require('../../server');
});

maybe()('/faq', () => {
  let html;
  beforeAll(async () => {
    html = (await request(app).get('/faq')).text;
  });

  it('renders every question, in the order config/faq.js gives', () => {
    const positions = FAQ_QUESTIONS.map((f) => html.indexOf(`id="${f.id}"`));
    positions.forEach((p) => expect(p).toBeGreaterThan(-1));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('What is SAP Hub?');
  });

  it('tells search engines exactly the questions the page asks', () => {
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity.map((q) => q.name)).toEqual(FAQ_QUESTIONS.map((f) => f.q));
    ld.mainEntity.forEach((q) => {
      expect(q.acceptedAnswer.text.length).toBeGreaterThan(40);
      expect(q.acceptedAnswer.text).not.toMatch(/<|&amp;/);
    });
  });

  it('links only to pages that exist', async () => {
    const hrefs = [...new Set([...html.matchAll(/class="accordion-body">([\s\S]*?)<\/div>/g)]
      .flatMap((m) => [...m[1].matchAll(/href="([^"#]+)/g)].map((h) => h[1])))];
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(href);
      expect([href, [200, 302].includes(res.status)]).toEqual([href, true]);
    }
  });

  it('ends with a way to ask a person', () => {
    expect(html).toMatch(/Didn't find your answer\?[\s\S]{0,400}href="\/contact"/);
  });
});
