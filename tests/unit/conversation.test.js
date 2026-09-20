'use strict';

const Conversation = require('../../models/Conversation');

describe('a thread\'s identity is its subject', () => {
  test('an application key is the application', () => {
    expect(Conversation.dedupeKeyFor('application', { applicationId: 7 })).toBe('application:7');
  });

  test('an enquiry key is the same whichever side starts it', () => {
    const a = Conversation.dedupeKeyFor('enquiry', { jobId: 3, userIds: [9, 2] });
    const b = Conversation.dedupeKeyFor('enquiry', { jobId: 3, userIds: [2, 9] });
    expect(a).toBe(b);
    expect(a).toBe('enquiry:3:2:9');
  });

  test('the same pair about a different role is a different thread', () => {
    expect(Conversation.dedupeKeyFor('enquiry', { jobId: 3, userIds: [2, 9] })).not.toBe(
      Conversation.dedupeKeyFor('enquiry', { jobId: 4, userIds: [2, 9] })
    );
  });

  test('an enquiry with no job is refused — there is no unanchored inbox', () => {
    /*
     * The reference defaults the job to 0, producing `enquiry:0:2:9`, which IS a direct
     * message between two accounts with no subject. Its route always passes a job, so the
     * hole is unreachable there today — and a rule that holds only because of what one
     * caller happens to do is not a rule.
     */
    expect(() => Conversation.dedupeKeyFor('enquiry', { userIds: [2, 9] })).toThrow(/unanchored/);
    expect(() => Conversation.dedupeKeyFor('enquiry', { jobId: 0, userIds: [2, 9] })).toThrow(/unanchored/);
    expect(() => Conversation.dedupeKeyFor('enquiry', { jobId: null, userIds: [2, 9] })).toThrow(/unanchored/);
  });

  test('an application with no application is refused', () => {
    expect(() => Conversation.dedupeKeyFor('application', {})).toThrow(/applicationId/);
  });

  test('an enquiry needs exactly two people', () => {
    expect(() => Conversation.dedupeKeyFor('enquiry', { jobId: 1, userIds: [2] })).toThrow(/exactly two/);
    expect(() => Conversation.dedupeKeyFor('enquiry', { jobId: 1, userIds: [2, 3, 4] })).toThrow(/exactly two/);
  });

  test('an unknown kind is refused rather than guessed at', () => {
    expect(() => Conversation.dedupeKeyFor('dm', { userIds: [1, 2] })).toThrow(/Unknown conversation kind/);
    expect(Conversation.KINDS).toEqual(['application', 'enquiry']);
  });
});

describe('message bodies', () => {
  test('are trimmed and length-capped', () => {
    expect(Conversation.normaliseBody('  hello  ')).toBe('hello');
    expect(Conversation.normaliseBody('x'.repeat(9000))).toHaveLength(Conversation.MAX_BODY_LENGTH);
  });

  test('keep the newlines the author typed', () => {
    // The body is rendered as plain text with `white-space: pre-wrap`, so these ARE the
    // only formatting a message has.
    expect(Conversation.normaliseBody('one\r\ntwo\r\n\r\nthree')).toBe('one\ntwo\n\nthree');
  });

  test('an empty or whitespace-only body normalises to nothing', () => {
    for (const value of ['', '   ', '\n\n', null, undefined]) {
      expect(Conversation.normaliseBody(value)).toBe('');
    }
  });

  test('markup is preserved verbatim, because the view escapes rather than the model', () => {
    // If this ever started stripping, it would mean two places decide what a message says.
    expect(Conversation.normaliseBody('<b>hi</b> & <script>')).toBe('<b>hi</b> & <script>');
  });
});
