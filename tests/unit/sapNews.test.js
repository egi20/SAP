'use strict';

const news = require('../../services/sapNews');
const { FALLBACK_NEWS, assertSapNewsIntegrity } = require('../../config/sapNews');

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>SAP News Center</title><link>https://news.sap.com</link>
<item>
  <title>Older &#8216;story&#8217; &amp; more</title>
  <link>https://news.sap.com/2026/10/older/</link>
  <pubDate>Mon, 19 Oct 2026 09:00:00 +0000</pubDate>
  <category><![CDATA[Business AI]]></category>
  <description><![CDATA[<p>An <strong>older</strong> story.</p> <p>The post Older story appeared first on SAP News Center.</p>]]></description>
</item>
<item>
  <title>Newest story</title>
  <link>https://news.sap.com/2026/10/newest/</link>
  <pubDate>Wed, 21 Oct 2026 09:00:00 +0000</pubDate>
  <description><![CDATA[<p>${'Word '.repeat(120)}</p>]]></description>
</item>
<item><title>Elsewhere</title><link>https://sap.com.evil.example/x</link><pubDate>Thu, 22 Oct 2026 09:00:00 +0000</pubDate></item>
<item><title>Script</title><link>javascript:alert(1)</link></item>
<item><title>Plain http</title><link>http://news.sap.com/insecure/</link></item>
</channel></rss>`;

describe('reading SAP\'s newsroom feed', () => {
  const items = news.parseFeed(FEED);

  test('keeps SAP items only, newest first', () => {
    expect(items.map((i) => i.title)).toEqual(['Newest story', 'Older ‘story’ & more']);
  });

  test('turns the excerpt into plain text and drops the feed\'s own footer', () => {
    expect(items[1].summary).toBe('An older story.');
    expect(items[1].category).toBe('Business AI');
    expect(items[0].summary.length).toBeLessThanOrEqual(281);
    expect(items[0].summary.endsWith('…')).toBe(true);
    items.forEach((i) => expect(i.summary).not.toMatch(/[<>]/));
  });

  test('a malformed feed returns what it could read, and never throws', () => {
    expect(() => news.parseFeed('<rss><item><title>Half')).not.toThrow();
    expect(news.parseFeed('not xml at all')).toEqual([]);
  });

  test('links only to sap.com over https', () => {
    expect(news.isAllowedLink('https://news.sap.com/a')).toBe(true);
    expect(news.isAllowedLink('https://www.sap.com/a')).toBe(true);
    expect(news.isAllowedLink('https://sap.com.evil.example/')).toBe(false);
    expect(news.isAllowedLink('https://news.sap.com@evil.example/')).toBe(false);
    expect(news.isAllowedLink('http://news.sap.com/a')).toBe(false);
    expect(news.isAllowedLink('javascript:alert(1)')).toBe(false);
  });
});

describe('one item a day', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ title: `Story ${i}`, link: `https://news.sap.com/${i}/` }));

  test('is the same all day, for everybody, and different the next day', () => {
    expect(news.pickFor(list, '2026-10-22').today).toEqual(news.pickFor(list, '2026-10-22').today);
    expect(news.pickFor(list, '2026-10-23').today).not.toEqual(news.pickFor(list, '2026-10-22').today);
  });

  test('rotates through the ten newest only, and the rest never repeats the pick', () => {
    const seen = new Set();
    for (let d = 1; d <= 20; d += 1) {
      const { today, more } = news.pickFor(list, `2026-11-${String(d).padStart(2, '0')}`);
      seen.add(today.title);
      expect(more).not.toContainEqual(today);
    }
    expect([...seen].sort()).toEqual(list.slice(0, 10).map((i) => i.title).sort());
  });
});

describe('what the home page gets', () => {
  afterEach(() => news.reset());

  test('the archive, labelled as such, until the feed has been read', () => {
    news.reset();
    const shown = news.newsOfTheDay(new Date('2026-10-22T10:00:00Z'));
    expect(shown.live).toBe(false);
    expect(FALLBACK_NEWS).toContainEqual(shown.today);
  });

  test('the live feed once it has, with "new" only for the last two days', () => {
    news.reset([{ title: 'Fresh', link: 'https://news.sap.com/f/', date: '2026-10-22T08:00:00.000Z', summary: '', source: 'SAP News Center' }]);
    const shown = news.newsOfTheDay(new Date('2026-10-22T10:00:00Z'));
    expect(shown.live).toBe(true);
    expect(shown.isNew).toBe(true);
    expect(news.newsOfTheDay(new Date('2026-10-26T10:00:00Z')).isNew).toBe(false);
  });

  test('the fallback passes its own assertion', () => {
    expect(assertSapNewsIntegrity()).toBe(true);
  });
});
