import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const GROK_CONFIG: ProviderConfig = {
  name: 'grok',
  displayName: 'Grok',
  url: 'https://grok.com',
  loginUrl: 'https://grok.com',
  models: ['grok-3', 'grok-3-mini', 'grok-2'],
  defaultModel: 'grok-3',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  /** ProseMirror contenteditable composer */
  composer: '.tiptap.ProseMirror[contenteditable="true"]',
  sendButton: 'button[aria-label="Submit"]',
  /** Assistant messages are inside .items-start containers with .message-bubble */
  assistantTurn: '.items-start .message-bubble',
  /** Login page indicators */
  loginPage: 'a[href*="accounts.x.com"], button:has-text("Sign in"), a:has-text("Sign in")',
  modelSelector: '#model-select-trigger',
} as const;

export const grokActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await Promise.race([
        page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }),
        page.waitForSelector(SELECTORS.loginPage, { timeout: 8_000 }),
      ]).catch(() => {});

      const composer = await page.$(SELECTORS.composer);
      if (composer) return true;

      const loginIndicator = await page.$(SELECTORS.loginPage);
      if (loginIndicator) return false;

      return false;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await page.waitForSelector(SELECTORS.composer, { timeout: 15_000 });
    if (!composer) {
      throw new Error(
        'Grok composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');

    // Use evaluate for large text to avoid keyboard.type slowness
    try {
      await composer.fill(prompt);
    } catch {
      // contenteditable ProseMirror elements reject fill() — inject via JS
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

    // Wait for submit button to become enabled
    const sendButton = await page.waitForSelector(`${SELECTORS.sendButton}:not([disabled])`, {
      timeout: 5_000,
    });
    if (!sendButton) {
      throw new Error('Grok send button not found or still disabled. The UI may have changed.');
    }
    await sendButton.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    // Count existing assistant turns before our submission
    const existingTurns = await page.locator(SELECTORS.assistantTurn).count();

    // Wait for a new assistant turn to appear
    await page.locator(SELECTORS.assistantTurn).nth(existingTurns).waitFor({ timeout: timeoutMs });

    // Poll until the response stops changing (streaming complete)
    let lastText = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 3;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const lastTurn = page.locator(SELECTORS.assistantTurn).last();
      const currentText = (await lastTurn.textContent())?.trim() ?? '';

      if (currentText === lastText) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD && currentText.length > 0) {
          break;
        }
      } else {
        if (onChunk && currentText.length > lastText.length) {
          onChunk(currentText.slice(lastText.length));
        }
        lastText = currentText;
        stableCount = 0;
      }

      await page.waitForTimeout(POLL_INTERVAL);
    }

    // Extract the final HTML content
    const lastTurn = page.locator(SELECTORS.assistantTurn).last();
    const markdown = (await lastTurn.innerHTML()) ?? '';

    const elapsed = Date.now() - startTime;
    const truncated = elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD;

    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
