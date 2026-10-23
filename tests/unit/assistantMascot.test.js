'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const config = require('../../config/config');

describe('the assistant mascot', () => {
  const html = () => ejs.renderFile(path.join(__dirname, '../../views/partials/assistant.ejs'), {
    assistantName: 'Hubi', assistantMaxChars: 2000
  });

  test('the launcher is the robot with an AI tag, and names the assistant for a screen reader', async () => {
    const out = await html();
    // Versioned, so a new robot is not hidden behind a week of cache.
    expect(out).toMatch(/src="\/images\/hub-assistant\.webp\?v=[^"]*"/);
    expect(out).toContain('class="assistant-launcher-ai"');
    expect(out).toContain('aria-label="Open Hubi, the AI Hub Assistant"');
  });

  test('both images it names exist', () => {
    for (const file of ['hub-assistant.webp', 'hub-assistant-head.webp']) {
      expect(fs.existsSync(path.join(__dirname, '../../public/images', file))).toBe(true);
    }
  });

  test('the widget and the prompt use the same name, from one setting', () => {
    const { stablePrompt } = require('../../utils/assistantPrompt');
    const prompt = typeof stablePrompt === 'function' ? stablePrompt() : stablePrompt;
    expect(String(prompt)).toContain(`You are ${config.assistant.name}, the`);
  });
});
