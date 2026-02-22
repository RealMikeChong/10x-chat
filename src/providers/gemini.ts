import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const GEMINI_CONFIG: ProviderConfig = {
  name: 'gemini',
  displayName: 'Gemini',
  url: 'https://gemini.google.com/app',
  loginUrl: 'https://gemini.google.com/app',
  models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'],
  defaultModel: 'Gemini 2.5 Pro',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer: '.ql-editor[contenteditable="true"], div[role="textbox"][aria-label*="prompt"]',
  sendButton: 'button.send-button, button[aria-label="Send message"]',
  /** model-response is the Angular custom element wrapping each AI turn */
  responseTurn: 'model-response .model-response-text, model-response message-content',
} as const;

export const geminiActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for composer to appear (indicates logged in and loaded)
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
        'Gemini composer not found. The UI may have changed. Try running with --headed to debug.',
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
    if (!sendButton) throw new Error('Gemini send button not found.');
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
