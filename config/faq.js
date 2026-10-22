'use strict';

/**
 * The FAQ's questions, in order, with the anchor each one opens at.
 *
 * The answers stay in views/legal/faq.ejs, because they are prose with links and live
 * figures in them. The QUESTIONS live here because two pages read them: the FAQ renders
 * every one of them, in this order, and /report-issue suggests the matching ones while
 * somebody types a subject. Two copies of a question is how the suggestion ends up naming one the FAQ no
 * longer asks. `words` are extra terms a subject might use for the same thing.
 */
/*
 * Listed in the order the page shows them. The ids are NOT renumbered when a question is
 * added or moved: /faq#faq3 is a link somebody may have sent, and the report form suggests
 * questions by id, so an id names one question for good.
 */
const FAQ_QUESTIONS = Object.freeze([
  { id: 'faq8', q: 'What is SAP Hub?', words: 'about what hub marketplace who platform site' },
  { id: 'faq1', q: 'Does it cost anything to join?', words: 'price pricing free pay payment cost fee join register sign' },
  { id: 'faq9', q: 'Where can I update my profile?', words: 'profile edit update change details photo logo settings' },
  { id: 'faq11', q: 'How do I post a job?', words: 'post job advert role hire hiring vacancy company recruit' },
  { id: 'faq12', q: 'What does featuring a job advert do?', words: 'feature featured promote advert boost top highlight' },
  { id: 'faq10', q: 'How do I request a quote?', words: 'quote request estimate proposal price project' },
  { id: 'faq3', q: 'What does the scope estimator actually produce?', words: 'estimate estimator quote sow scope document' },
  { id: 'faq2', q: 'How is the day-rate index built?', words: 'rate rates salary index benchmark figure' },
  { id: 'faq4', q: 'Why do consultant names not show until I sign in?', words: 'name hidden anonymous directory consultant photo' },
  { id: 'faq5', q: 'What does the LinkedIn badge on a profile mean?', words: 'linkedin badge verified verify' },
  { id: 'faq6', q: 'Can anyone message me?', words: 'message messages inbox contact spam' },
  { id: 'faq7', q: 'How do I get help with my account?', words: 'account login password help broken error bug support' }
]);

function assertFaqIntegrity() {
  const ids = new Set();
  FAQ_QUESTIONS.forEach((f, i) => {
    if (!/^faq\d+$/.test(f.id) || ids.has(f.id)) throw new Error(`config/faq.js: question ${i} has a bad or repeated id`);
    if (!f.q) throw new Error(`config/faq.js: ${f.id} has no question`);
    ids.add(f.id);
  });
}

module.exports = { FAQ_QUESTIONS, assertFaqIntegrity };
