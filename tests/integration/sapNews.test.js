'use strict';

/**
 * "SAP news of the day" leads the home feed: the archive until SAP's newsroom has been read,
 * the live pick after, and never a link off sap.com or a tag from somebody else's feed.
 */

const request = require('supertest');
const news = require('../../services/sapNews');
const { FALLBACK_NEWS } = require('../../config/sapNews');

const reachable = process.env.TEST_DATABASE_AVAILABLE === '1';
const maybe = () => (reachable ? describe : describe.skip);
let app;

beforeAll(() => {
  if (!reachable) return;
  app = require('../../server');
});
afterEach(() => news.reset());

maybe()('SAP news of the day', () => {
  it('shows the archive, saying so, before the feed has been read', async () => {
    news.reset();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('From our SAP news archive');
    expect(FALLBACK_NEWS.some((item) => res.text.includes(item.link))).toBe(true);
  });

  it('shows the live pick, escaped, with its source, a link to read more and a share link', async () => {
    news.reset([
      { title: 'Joule <b>news</b>', link: 'https://news.sap.com/2026/10/joule/', date: new Date().toISOString(), summary: 'Plain summary.', category: 'Business AI', source: 'SAP News Center' }
    ]);
    const res = await request(app).get('/');
    expect(res.text).toContain('SAP news of the day');
    expect(res.text).toContain('Joule &lt;b&gt;news&lt;/b&gt;');
    expect(res.text).toContain('href="https://news.sap.com/2026/10/joule/"');
    expect(res.text).toContain('Read more on SAP News Center');
    expect(res.text).toContain('https://www.linkedin.com/feed/?shareActive=true');
  });

  it('leads the first page only', async () => {
    const res = await request(app).get('/?page=2');
    expect(res.text).not.toContain('data-news-slide');
  });
});
