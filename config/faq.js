'use strict';

/**
 * The FAQ's questions, in order, with the anchor each one opens at.
 *
 * The answers stay in views/legal/faq.ejs, because they are prose with links and live
 * figures in them. The QUESTIONS live here because two pages read them: the FAQ renders its
 * headings from this list, and /report-issue suggests the matching ones while somebody types
 * a subject. Two copies of a question is how the suggestion ends up naming one the FAQ no
 * longer asks. `words` are extra terms a subject might use for the same thing.
 */
const FAQ_QUESTIONS = Object.freeze([
  { id: 'faq1', q: 'Does it cost anything to join?', words: 'price pricing free pay payment cost fee' },
  { id: 'faq2', q: 'How is the day-rate index built?', words: 'rate rates salary index benchmark figure' },
  { id: 'faq3', q: 'What does the scope estimator actually produce?', words: 'estimate estimator quote sow scope document' },
  { id: 'faq4', q: 'Why do consultant names not show until I sign in?', words: 'name hidden anonymous directory consultant photo' },
  { id: 'faq5', q: 'What does the LinkedIn badge on a profile mean?', words: 'linkedin badge verified verify' },
  { id: 'faq6', q: 'Can anyone message me?', words: 'message messages inbox contact spam' },
  { id: 'faq7', q: 'Something looks wrong, or I need help with my account.', words: 'account login password help broken error bug' }
]);

function faqQuestion(id) {
  const found = FAQ_QUESTIONS.find((f) => f.id === id);
  if (!found) throw new Error(`config/faq.js has no question ${id}`);
  return found.q;
}

function assertFaqIntegrity() {
  const ids = new Set();
  FAQ_QUESTIONS.forEach((f, i) => {
    if (!/^faq\d+$/.test(f.id) || ids.has(f.id)) throw new Error(`config/faq.js: question ${i} has a bad or repeated id`);
    if (!f.q) throw new Error(`config/faq.js: ${f.id} has no question`);
    ids.add(f.id);
  });
}

module.exports = { FAQ_QUESTIONS, faqQuestion, assertFaqIntegrity };
