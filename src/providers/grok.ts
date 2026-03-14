import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';
import { submitPromptToComposer } from './submit.js';

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
  /** Composer: textarea on landing page, ProseMirror in active conversations */
  composer: 'textarea, .tiptap.ProseMirror[contenteditable="true"]',
  sendButton: 'button[aria-label="Submit"]',
  /** Assistant response bubbles — use .message-bubble (both user & assistant use it;
   *  captureResponse counts existing turns before submission to find the new one) */
  assistantTurn: '.message-bubble',
  /** Login page indicators — updated for current Grok UI (Feb 2026) */
  loginPage:
    'a[href*="x.com/i/flow/login"], a[href*="accounts.x.com"], button:has-text("Sign in"), a:has-text("Sign in"), a:has-text("Log in")',
  modelSelector: '#model-select-trigger',
  fileInput: 'input[type="file"][name="files"]',
} as const;

export const grokActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for page to settle — either composer or login indicator will appear
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(3000);

      // Check login indicators FIRST — Grok shows a textarea even when not logged in
      const loginVisible = await page
        .locator(SELECTORS.loginPage)
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (loginVisible) return false;

      // Then check for the composer
      const composerVisible = await page
        .locator(SELECTORS.composer)
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      return composerVisible;
    } catch {
      return false;
    }
  },

  async attachFiles(page: Page, filePaths: string[]): Promise<void> {
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.setInputFiles(filePaths);
    await page.waitForTimeout(2000);
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    await submitPromptToComposer(page, prompt, {
      composerSelector: SELECTORS.composer,
      // Grok needs :not([disabled]) on send button
      sendButtonSelector: `${SELECTORS.sendButton}:not([disabled])`,
    });
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    // Grok redirects to a new conversation URL (grok.com/c/...) after submit.
    // The response may already be rendered by the time we start counting,
    // so we wait for the URL change first, then look for response content.
    const initialUrl = page.url();
    const remainingForNav = Math.min(timeoutMs, 30_000);
    await page
      .waitForURL((url) => url.toString() !== initialUrl, { timeout: remainingForNav })
      .catch(() => {});

    // After navigation, wait for at least one response-content-markdown (assistant response)
    await page
      .locator('.response-content-markdown')
      .first()
      .waitFor({ timeout: timeoutMs - (Date.now() - startTime) });

    // Poll until the response stops changing (streaming complete)
    const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const { text: lastText, truncated } = await pollUntilStable(page, {
      getText: async (p) => {
        const lastTurn = p.locator(SELECTORS.assistantTurn).last();
        const remaining = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
        return (await lastTurn.textContent({ timeout: remaining }))?.trim() ?? '';
      },
      timeoutMs: remainingMs,
      onChunk,
    });

    // Extract the final HTML content
    const lastTurn = page.locator(SELECTORS.assistantTurn).last();
    const finalRemainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const markdown = (await lastTurn.innerHTML({ timeout: finalRemainingMs })) ?? '';

    // Extract generated images (Grok/Aurora)
    const images: GeneratedImage[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(
        document.querySelectorAll('img[src*="assets.grok.com"][src*="/generated/"]'),
      );
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (!src || seen.has(src)) continue;
        seen.add(src);
        results.push({
          url: src,
          alt: img.getAttribute('alt') ?? '',
          width: (img as HTMLImageElement).naturalWidth,
          height: (img as HTMLImageElement).naturalHeight,
        });
      }
      return results;
    });

    const elapsed = Date.now() - startTime;

    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
      ...(images.length > 0 ? { images } : {}),
    };
  },
};
