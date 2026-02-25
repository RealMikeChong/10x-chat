import type { Page } from 'playwright';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';

export const CHATGPT_CONFIG: ProviderConfig = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  url: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  models: ['GPT-4o', 'GPT-4o mini', 'GPT-4.5', 'o1', 'o3-mini'],
  defaultModel: 'GPT-4o',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer:
    '#prompt-textarea, [data-testid="composer-input"], div.ProseMirror[contenteditable="true"]',
  sendButton:
    '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
  stopButton: 'button[aria-label="Stop streaming"]',
  assistantTurn: '[data-message-author-role="assistant"]',
  loginPage: 'button:has-text("Log in"), button:has-text("Sign up")',
  /** Hidden file input — exclude the dedicated photo/camera inputs */
  fileInput: 'input[type="file"]:not(#upload-photos):not(#upload-camera)',
} as const;

/**
 * Dismiss ChatGPT onboarding modals, cookie banners, and other overlays
 * that can block the composer input. Fails silently if no overlays are present.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const overlaySelectors = [
    // Onboarding modal skip/dismiss buttons
    '#modal-onboarding button:has-text("Skip")',
    '#modal-onboarding button:has-text("Next")',
    '#modal-onboarding button:has-text("Okay")',
    '#modal-onboarding button:has-text("Got it")',
    '#modal-onboarding button:has-text("Done")',
    '[data-testid="onboarding-skip"]',
    // Generic dialog dismiss
    'dialog button:has-text("Dismiss")',
    'dialog button:has-text("Close")',
    '[role="dialog"] button[aria-label="Close"]',
    // Cookie consent
    'button:has-text("Decline optional cookies")',
    'button:has-text("Accept all")',
    // "Stay logged out" prompt
    'button:has-text("Stay logged out")',
  ];

  for (const selector of overlaySelectors) {
    try {
      const btn = await page.$(selector);
      if (btn && (await btn.isVisible())) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignore — overlay may not exist
    }
  }
}

export const chatgptActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for either composer or login indicators to appear
      await Promise.race([
        page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }),
        page.waitForSelector(SELECTORS.loginPage, { timeout: 8_000 }),
      ]).catch(() => {});

      // Dismiss any overlays that might be hiding the composer
      await dismissOverlays(page);

      const composer = await page.$(SELECTORS.composer);
      if (composer) return true;

      const loginButton = await page.$(SELECTORS.loginPage);
      if (loginButton) return false;

      return false;
    } catch {
      return false;
    }
  },

  async attachFiles(page: Page, filePaths: string[]): Promise<void> {
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.setInputFiles(filePaths);
    // Wait for upload indicators to appear and settle
    await page.waitForTimeout(2000);
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Dismiss onboarding/welcome modals that block the composer
    await dismissOverlays(page);

    const composer = await page.waitForSelector(SELECTORS.composer, { timeout: 15_000 });
    if (!composer) {
      throw new Error(
        'ChatGPT composer not found. The UI may have changed. Try running with --headed to debug.',
      );
    }

    await composer.click();
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');

    // Use evaluate for large text to avoid keyboard.type slowness
    try {
      await composer.fill(prompt);
    } catch {
      // contenteditable elements sometimes reject fill() — inject via JS
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
    if (!sendButton) {
      throw new Error('ChatGPT send button not found. The UI may have changed.');
    }
    await sendButton.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();
    const initialUrl = page.url();

    // ChatGPT navigates from / to /c/<id> after sending a new message.
    // This resets the DOM, so we cannot rely on a fixed nth() index.
    // Strategy: track initial turn count + URL to detect the new response.
    const initialTurnCount = await page.locator(SELECTORS.assistantTurn).count();

    // Phase 1: Wait for a new assistant turn to appear
    const waitForNewTurn = async (): Promise<void> => {
      while (Date.now() - startTime < timeoutMs) {
        const currentUrl = page.url();
        const currentCount = await page.locator(SELECTORS.assistantTurn).count();

        // Case 1: URL changed (new conversation) — any turn is "ours"
        if (currentUrl !== initialUrl && currentCount > 0) return;

        // Case 2: Same URL but turn count increased — new response arrived
        if (currentUrl === initialUrl && currentCount > initialTurnCount) return;

        await page.waitForTimeout(500);
      }
      throw new Error('Timed out waiting for ChatGPT assistant response');
    };
    await waitForNewTurn();

    // Phase 2: Poll until the response stops changing and streaming is complete
    let lastText = '';
    let stableCount = 0;
    const STABLE_THRESHOLD = 3;
    const POLL_INTERVAL = 1000;

    while (Date.now() - startTime < timeoutMs) {
      // If stop button is visible, streaming is still in progress — reset stability
      const stopBtn = await page.$(SELECTORS.stopButton);
      const isStreaming = stopBtn ? await stopBtn.isVisible() : false;

      const lastTurn = page.locator(SELECTORS.assistantTurn).last();
      const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
      const currentText = (await lastTurn.textContent({ timeout: remainingMs }))?.trim() ?? '';

      // For image-generation responses, check if images are present
      const hasImages = await page.evaluate(
        () => document.querySelectorAll('img[alt="Generated image"]').length > 0,
      );

      if (currentText === lastText && !isStreaming) {
        stableCount++;
        if (stableCount >= STABLE_THRESHOLD && (currentText.length > 0 || hasImages)) {
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
    const finalRemainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const markdown = (await lastTurn.innerHTML({ timeout: finalRemainingMs })) ?? '';

    // Extract generated images (DALL-E)
    const images: GeneratedImage[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(document.querySelectorAll('img[alt="Generated image"]'));
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        const idMatch = src.match(/[?&]id=([^&]+)/);
        const key = idMatch ? idMatch[1] : src;
        if (!key || seen.has(key)) continue;
        seen.add(key);
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
    const truncated = elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD;

    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(elapsed / 1000),
      ...(images.length > 0 ? { images } : {}),
    };
  },
};
