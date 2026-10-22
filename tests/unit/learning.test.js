'use strict';

const learning = require('../../config/learning');
const { isCertificationCode } = require('../../config/certifications');

describe('learning paths and certification practice', () => {
  test('pass their boot assertion', () => {
    expect(learning.assertLearningIntegrity()).toBe(true);
  });

  test('every link leaves for an SAP host over https, and nothing else', () => {
    [...learning.LEARNING_PATHS.map((p) => p.url), ...learning.RESOURCES.map((r) => r.url), ...learning.practiceCerts().map((c) => c.studyUrl)]
      .forEach((url) => expect(learning.isAllowedLearningUrl(url)).toBe(true));
    expect(learning.isAllowedLearningUrl('https://learning.sap.com.evil.example/')).toBe(false);
    expect(learning.isAllowedLearningUrl('http://learning.sap.com/')).toBe(false);
  });

  test('practice is for catalogue certifications, by stem', () => {
    learning.practiceCerts().forEach((c) => {
      expect(isCertificationCode(c.code)).toBe(true);
      expect(c.code).not.toMatch(/_\d{4}$/);
    });
  });

  test('a session carries no answer and no explanation', () => {
    const set = learning.practiceSetFor('C_TS4FI', () => 0.42);
    expect(set).toHaveLength(learning.PRACTICE_SET_SIZE);
    expect(JSON.stringify(set)).not.toMatch(/"(answer|explain)"/);
  });

  test('grades by the option text, so the shuffle cannot change what was chosen', () => {
    const bank = learning.practiceFor('C_TS4FI').questions;
    const answers = {};
    bank.slice(0, 3).forEach((item) => { answers[item.id] = item.options[item.answer]; });
    answers[bank[3].id] = 'not an option';
    const graded = learning.gradePractice('C_TS4FI', answers);
    expect(graded.total).toBe(4);
    expect(graded.score).toBe(3);
  });

  test('ignores questions from another exam, and caps a session', () => {
    const fi = learning.practiceFor('C_TS4FI').questions;
    const co = learning.practiceFor('C_TS4CO').questions;
    const answers = {};
    co.forEach((item) => { answers[item.id] = item.options[item.answer]; });
    expect(learning.gradePractice('C_TS4FI', answers)).toBeNull();
    fi.forEach((item) => { answers[item.id] = item.options[item.answer]; });
    expect(learning.gradePractice('C_TS4FI', answers).total).toBe(learning.PRACTICE_SET_SIZE);
  });
});
