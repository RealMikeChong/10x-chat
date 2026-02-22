import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const CLAUDE_CONFIG: ProviderConfig = {
  name: 'claude',
  displayName: 'Claude',
  url: 'https://claude.ai/new',
  loginUrl: 'https://claude.ai/login',
  models: ['Claude 4 Sonnet', 'Claude 4 Opus'],
  defaultModel: 'Claude 4 Sonnet',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer: '[contenteditable="true"].ProseMirror, div[enterkeyhint="enter"]',
  sendButton: 'button[aria-label="Send Message"], button[data-testid="send-message"]',
  responseTurn: '[data-is-streaming], .font-claude-message, [data-testid="assistant-message"]',
} as const;

export const claudeActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }).catch(() => {});
      const composer = await page.$(SELECTORS.composer);
      return !!composer;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await page.waitForSelector(SELECTORS.composer, { timeout: 15_000 });
    if (!composer) {
      throw new Error(
        'Claude composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');

    try {
      await composer.fill(prompt);
    } catch {
      await page.evaluate(
        ({ sel, text }) => {
          const el = document.querySelector(sel);
          if (el) {
            (el as HTMLElement).innerText = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        },
        { sel: SELECTORS.composer, text: prompt },
      );
    }

    await page.waitForTimeout(300);

    const sendButton = await page.waitForSelector(SELECTORS.sendButton, { timeout: 5_000 });
    if (!sendButton) throw new Error('Claude send button not found.');
    await sendButton.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    const existingTurns = await page.locator(SELECTORS.responseTurn).count();

    await page.locator(SELECTORS.responseTurn).nth(existingTurns).waitFor({ timeout: timeoutMs });

    let lastText = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 3;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const lastTurn = page.locator(SELECTORS.responseTurn).last();
      const currentText = (await lastTurn.textContent())?.trim() ?? '';

      if (currentText === lastText) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD && currentText.length > 0) break;
      } else {
        if (onChunk && currentText.length > lastText.length) {
          onChunk(currentText.slice(lastText.length));
        }
        lastText = currentText;
        stableCount = 0;
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    const lastTurn = page.locator(SELECTORS.responseTurn).last();
    const markdown = (await lastTurn.innerHTML()) ?? '';

    const elapsed = Date.now() - startTime;
    return {
      text: lastText,
      markdown,
      truncated: elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
