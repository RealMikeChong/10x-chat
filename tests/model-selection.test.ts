import { describe, expect, it, vi } from 'vitest';
import { chatgptActions } from '../src/providers/chatgpt.js';
import { claudeActions } from '../src/providers/claude.js';
import { grokActions } from '../src/providers/grok.js';

function createModelPage(evaluateResults: unknown[]) {
  const queue = [...evaluateResults];
  return {
    locator: vi.fn(() => ({
      first: vi.fn().mockReturnThis(),
      isVisible: vi.fn(async () => false),
      click: vi.fn(async () => {}),
    })),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => queue.shift()),
    keyboard: {
      press: vi.fn(async () => {}),
    },
  };
}

describe('Model selection uses page evaluation for remote-browser compatibility', () => {
  it('selects a ChatGPT model without locator filter chains', async () => {
    const page = createModelPage([{ found: true, text: 'Thinking' }, true, true]);

    await chatgptActions.selectModel(page as never, 'Pro');

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.waitForTimeout).toHaveBeenCalledWith(750);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('warns and escapes when the Claude model option is missing', async () => {
    const page = createModelPage([{ found: true, text: 'Claude 4 Sonnet' }, true, false]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await claudeActions.selectModel(page as never, 'Claude 4 Opus');

    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    expect(warn).toHaveBeenCalledWith(
      'Model "Claude 4 Opus" not found in Claude picker — using current model',
    );

    warn.mockRestore();
  });

  it('checks Grok toggle state and only clicks the needed toggle', async () => {
    const page = createModelPage([
      { found: true, active: false },
      { found: true, active: false },
      true,
      true,
    ]);

    await grokActions.selectModel(page as never, 'grok-3-think');

    expect(page.evaluate).toHaveBeenCalledTimes(4);
    expect(page.waitForTimeout).toHaveBeenCalledWith(500);
  });
});
