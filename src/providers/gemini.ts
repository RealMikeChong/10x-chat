import type { Page } from 'playwright';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';

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
      await page.waitForSelector(SELECTORS.composer, { timeout: 8_000 }).catch(() => {});
      const composer = await page.$(SELECTORS.composer);
      if (!composer) return false;
      // Guest users see the composer but can't use authenticated features.
      // Require that no sign-in button is visible.
      const signInBtn = await page.$(
        '.sign-in-button, a[href*="accounts.google.com"][class*=sign]',
      );
      if (signInBtn) return false;
      return true;
    } catch {
      return false;
    }
  },

  async attachFiles(page: Page, filePaths: string[]): Promise<void> {
    // Gemini upload flow. The upload button only works when the composer is focused.
    //   1. Focus the composer
    //   2. Click upload-card-button → may show one-time consent dialog
    //   3. Dismiss consent if needed, then re-click upload-card-button
    //   4. Click visible "Upload files" menu item via Playwright (Playwright handles the CDK overlay)
    //      which triggers the hidden-local-file-upload-button Angular component
    //   5. Catch the filechooser event and set files

    // Step 1: focus composer (required for the upload button to be interactive)
    const composer = page.locator(SELECTORS.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.click();
    await page.waitForTimeout(500);

    // Helper: dismiss consent dialog if shown
    const dismissConsentDialog = async (): Promise<void> => {
      const agreeBtn = page.getByRole('button', { name: 'Agree' });
      const visible = await agreeBtn.isVisible().catch(() => false);
      if (visible) {
        await agreeBtn.click();
        await page.waitForTimeout(800);
      }
    };

    // Step 2: click upload button via aria-label (more stable than class selector)
    const uploadBtn = page
      .locator('button[aria-label="Open upload file menu"], button.upload-card-button')
      .first();
    await uploadBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await uploadBtn.click();
    await page.waitForTimeout(1200);

    // Check for unauthenticated state — upload button shows sign-in prompt instead of menu
    const isSignedIn = await page.evaluate(() => !document.querySelector('.sign-in-button'));
    if (!isSignedIn) {
      throw new Error(
        'Gemini file upload requires a signed-in Google account. Run `10x-chat login --provider gemini` to authenticate.',
      );
    }

    // Step 3: dismiss consent if it appeared, then re-open menu if needed
    await dismissConsentDialog();
    const overlayOpen = await page.evaluate(
      () => (document.querySelector('.cdk-overlay-container')?.children.length ?? 0) > 0,
    );
    if (!overlayOpen) {
      // Re-focus composer then click upload button again
      await composer.click();
      await page.waitForTimeout(500);
      await uploadBtn.click();
      await page.waitForTimeout(1200);
    }

    // Step 4+5: click visible "Upload files" menu item
    const uploadItem = page.getByRole('menuitem', { name: /Upload files/i }).first();
    await uploadItem.waitFor({ state: 'visible', timeout: 8_000 });

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }),
      uploadItem.click(),
    ]);
    await fileChooser.setFiles(filePaths);

    // Wait for upload to settle
    await page.waitForTimeout(3000);
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

    // Extract generated images (Imagen)
    const images: GeneratedImage[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(
        document.querySelectorAll('img.image.loaded, img[alt*="AI generated"]'),
      );
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (!src || seen.has(src)) continue;
        seen.add(src);
        const fullSizeUrl = src.includes('=s') ? src : `${src}=s1024-rj`;
        results.push({
          url: fullSizeUrl,
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
      truncated: elapsed >= timeoutMs && stableCount < STABLE_THRESHOLD,
      thinkingTime: Math.round(elapsed / 1000),
      ...(images.length > 0 ? { images } : {}),
    };
  },
};
