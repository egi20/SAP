'use strict';

/**
 * What "SAP news of the day" shows when the live feed has never been read in this process —
 * a fresh boot with SAP's newsroom unreachable. services/sapNews.js reads the real feed and
 * this list is only the floor under it, so it is short, dated, and every item names its
 * source and links to it. The card says "From our archive" over these, never "Today".
 *
 * Only facts that were checked against more than one report go here, for the reason the
 * Sapphire bank in config/games.js gives: news is the thing most easily remembered wrong.
 */
const FALLBACK_NEWS = Object.freeze([
  {
    title: 'SAP and Anthropic to bring Claude to the SAP Business AI Platform',
    summary: 'Announced at SAP Sapphire 2026: Claude is to serve as a primary reasoning and agentic capability across SAP\'s AI portfolio, working with Joule and Joule agents through the Model Context Protocol.',
    link: 'https://news.sap.com/2026/05/sap-anthropic-to-bring-claude-sap-business-ai-platform/',
    date: '2026-05-12T00:00:00.000Z',
    category: 'Sapphire 2026',
    source: 'SAP News Center'
  },
  {
    title: 'SAP Sapphire 2026: the Business AI Platform and the Autonomous Suite',
    summary: 'The Orlando keynote presented the SAP Business AI Platform — SAP BTP, SAP Business Data Cloud and SAP\'s AI layer in one stack — and an Autonomous Suite of agents built into SAP applications.',
    link: 'https://news.sap.com/2026/05/sap-sapphire-keynote-business-ai-platform-power-autonomous-enterprise/',
    date: '2026-05-11T00:00:00.000Z',
    category: 'Sapphire 2026',
    source: 'SAP News Center'
  },
  {
    title: 'Top Sapphire 2026 AI announcements',
    summary: 'Joule Studio for building custom agents in low-code and pro-code, and Joule Work as the place where assistants and agents meet the user — SAP\'s own round-up of the AI news from Sapphire.',
    link: 'https://www.sap.com/blogs/top-5-sapphire-2026-ai-announcements',
    date: '2026-05-13T00:00:00.000Z',
    category: 'Sapphire 2026',
    source: 'SAP'
  }
]);

function assertSapNewsIntegrity() {
  FALLBACK_NEWS.forEach((item) => {
    ['title', 'summary', 'link', 'date', 'source'].forEach((field) => {
      if (typeof item[field] !== 'string' || !item[field]) throw new Error(`SAP news fallback "${item.title}" has no ${field}`);
    });
    if (!/^https:\/\/([a-z0-9-]+\.)*sap\.com\//.test(item.link)) throw new Error(`SAP news fallback "${item.title}" must link to sap.com over https`);
    if (Number.isNaN(Date.parse(item.date))) throw new Error(`SAP news fallback "${item.title}" has an unreadable date`);
  });
  return true;
}

module.exports = { FALLBACK_NEWS, assertSapNewsIntegrity };
