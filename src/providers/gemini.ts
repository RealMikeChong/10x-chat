import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';
import { submitPromptToComposer } from './submit.js';

export const GEMINI_CONFIG: ProviderConfig = {
  name: 'gemini',
  displayName: 'Gemini',
  url: 'https://gemini.google.com/app',
  loginUrl: 'https://gemini.google.com/app',
  models: ['Fast', 'Thinking', 'Deep Think', 'Pro'],
  defaultModel: 'Thinking',
  defaultTimeoutMs: 5 * 60 * 1000,
};

function normalizeGeminiModeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function geminiModeTestId(model: string): string {
  const slug = normalizeGeminiModeLabel(model).replace(/\s+/g, '-');
  return `bard-mode-option-${slug}`;
}

async function clickGeminiModeOption(page: Page, model: string): Promise<boolean> {
  const target = normalizeGeminiModeLabel(model);
  return page.evaluate((targetLabel: string) => {
    const root = document.querySelector('.cdk-overlay-container') ?? document.body;
    const candidates = Array.from(
      root.querySelectorAll('button,[role="menuitem"],[role="option"],mat-option'),
    ) as HTMLElement[];
    for (const el of candidates) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
      const label = `${text} ${aria}`.replace(/[^a-z0-9]+/g, ' ').trim();
      if (
        label === targetLabel ||
        label.startsWith(`${targetLabel} `) ||
        label.includes(targetLabel)
      ) {
        el.click();
        return true;
      }
    }
    return false;
  }, target);
}

const SELECTORS = {
  composer: '.ql-editor[contenteditable="true"], div[role="textbox"][aria-label*="prompt"]',
  sendButton: 'button.send-button, button[aria-label="Send message"]',
  /** Model/mode picker button near the composer (Gemini calls it "mode picker") */
  modelPicker:
    'button[data-test-id="bard-mode-menu-button"], button[aria-label="Open mode picker"]',
  /** model-response is the Angular custom element wrapping each AI turn */
  responseTurn: 'model-response .model-response-text, model-response message-content',
  /** Indicators that Gemini is still generating (text streaming or image generation in flight) */
  streamingIndicators: [
    // Stop/cancel button visible while generating
    'button[aria-label="Stop generating"], button[aria-label="Cancel"]',
    // Imagen / Nano Banana loading spinner or status
    '.image-generation-loading',
    '.loading-indicator',
    // "Generating image" / "Loading Nano Banana" text shown during image gen
    'model-response [class*="loading"]',
    'model-response [class*="progress"]',
  ].join(', '),
  /** Generated images in the response (Imagen / Nano Banana) */
  generatedImages: [
    'img.image.loaded',
    'img[alt*="AI generated"]',
    'img[alt*="Generated"]',
    // Imagen result containers
    'model-response img[src*="lh3.googleusercontent.com"]',
    'model-response img[src*="encrypted"]',
  ].join(', '),
} as const;

/**
 * Wait for Gemini image generation to complete.
 * After text stabilizes, check if image generation is in progress and
 * wait for images to appear and fully load (naturalWidth > 0).
 */
async function waitForImages(page: Page, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2_000;

  // First, check if there are any signs of image generation in the last response
  const lastTurnHtml = await page
    .locator(SELECTORS.responseTurn)
    .last()
    .innerHTML()
    .catch(() => '');
  const lowerHtml = lastTurnHtml.toLowerCase();
  const hasImageGenHints =
    lowerHtml.includes('nano banana') ||
    lowerHtml.includes('imagen') ||
    lowerHtml.includes('image-generation') ||
    lowerHtml.includes('generating') ||
    lowerHtml.includes('img');

  if (!hasImageGenHints) return;

  // Wait for loading indicators to disappear and images to be fully loaded
  while (Date.now() - startTime < timeoutMs) {
    // Check if any loading indicators are still visible
    const stillLoading = await page
      .locator(SELECTORS.streamingIndicators)
      .first()
      .isVisible()
      .catch(() => false);

    if (stillLoading) {
      await page.waitForTimeout(pollInterval);
      continue;
    }

    // Check if images exist and are fully loaded
    const imageState = await page.evaluate((imgSelector: string) => {
      const imgs = Array.from(document.querySelectorAll(imgSelector));
      if (imgs.length === 0) return { count: 0, allLoaded: true };
      const allLoaded = imgs.every((img) => {
        const el = img as HTMLImageElement;
        return el.complete && el.naturalWidth > 0;
      });
      return { count: imgs.length, allLoaded };
    }, SELECTORS.generatedImages);

    if (imageState.count > 0 && imageState.allLoaded) {
      // Images are present and fully loaded
      return;
    }

    if (imageState.count > 0 && !imageState.allLoaded) {
      // Images exist but not yet loaded — keep waiting
      await page.waitForTimeout(pollInterval);
      continue;
    }

    // No loading indicators and no images — likely a text-only response
    break;
  }
}

export const geminiActions: ProviderActions = {
  async selectModel(page: Page, model: string): Promise<void> {
    // Check current mode via page.evaluate (avoids locator.textContent timeout)
    const pickerState = await page.evaluate((sel: string) => {
      const btn = document.querySelector(sel);
      if (!(btn instanceof HTMLElement) || btn.offsetWidth === 0) return { found: false, text: '' };
      return { found: true, text: btn.textContent?.trim() ?? '' };
    }, SELECTORS.modelPicker);

    if (!pickerState.found) {
      console.warn(`Gemini mode picker not found — skipping model selection for "${model}"`);
      return;
    }

    if (normalizeGeminiModeLabel(pickerState.text) === normalizeGeminiModeLabel(model)) {
      return; // Already on the requested mode
    }

    // Open the mode picker menu (Playwright click for React event dispatch)
    await page.locator(SELECTORS.modelPicker).first().click();
    await page.waitForTimeout(1000);

    // Select by data-test-id (e.g. "Thinking" → "bard-mode-option-thinking")
    const testId = geminiModeTestId(model);
    const clicked = await page.evaluate((tid: string) => {
      const btn = document.querySelector(`button[data-test-id="${tid}"]`);
      if (btn instanceof HTMLElement && btn.offsetWidth > 0) {
        btn.click();
        return true;
      }
      return false;
    }, testId);

    const textClicked = clicked || (await clickGeminiModeOption(page, model));

    if (!textClicked) {
      const availableModes = await page.evaluate(() => {
        const root = document.querySelector('.cdk-overlay-container') ?? document.body;
        return (
          Array.from(
            root.querySelectorAll('button,[role="menuitem"],[role="option"],mat-option'),
          ) as HTMLElement[]
        )
          .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(', ');
      });
      console.warn(
        `Mode "${model}" not found in Gemini picker${availableModes ? ` (available: ${availableModes})` : ''} — using current mode`,
      );
      await page.keyboard.press('Escape');
      return;
    }
    await page.waitForTimeout(500);
  },

  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      await page
        .locator(SELECTORS.composer)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .catch(() => {});
      const composerVisible = await page
        .locator(SELECTORS.composer)
        .first()
        .isVisible()
        .catch(() => false);
      if (!composerVisible) return false;
      // Guest users see the composer but can't use authenticated features.
      // Require that no sign-in button is visible.
      const signInVisible = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll(
            '.sign-in-button, button[data-test-id="bard-sign-in-button"], a[href*="accounts.google.com"], button',
          ),
        ) as HTMLElement[];
        return candidates.some((el) => {
          const visible = el.offsetWidth > 0 && el.offsetHeight > 0;
          if (!visible) return false;
          const text = (el.textContent ?? '').trim();
          const testId = el.getAttribute('data-test-id') ?? '';
          const href = el instanceof HTMLAnchorElement ? el.href : '';
          return (
            /sign in/i.test(text) ||
            testId === 'bard-sign-in-button' ||
            href.includes('accounts.google.com')
          );
        });
      });
      if (signInVisible) return false;
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
    await submitPromptToComposer(page, prompt, {
      composerSelector: SELECTORS.composer,
      sendButtonSelector: SELECTORS.sendButton,
    });
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    const existingTurns = await page.locator(SELECTORS.responseTurn).count();

    await page.locator(SELECTORS.responseTurn).nth(existingTurns).waitFor({ timeout: timeoutMs });

    const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const {
      text,
      elapsed: _pollElapsed,
      truncated,
    } = await pollUntilStable(page, {
      getText: async (p) =>
        (await p.locator(SELECTORS.responseTurn).last().textContent())?.trim() ?? '',
      timeoutMs: remainingMs,
      onChunk,
      isStreaming: async (p) => {
        // Check if Gemini is still generating (text or images)
        const indicatorVisible = await p
          .locator(SELECTORS.streamingIndicators)
          .first()
          .isVisible()
          .catch(() => false);
        if (indicatorVisible) return true;

        // Also check for image-generation-specific text in the response
        // (e.g. "Loading Nano Banana", "Generating image", "Creating image")
        const lastTurnText =
          (await p.locator(SELECTORS.responseTurn).last().textContent())?.toLowerCase() ?? '';
        if (
          lastTurnText.includes('loading nano banana') ||
          lastTurnText.includes('generating image') ||
          lastTurnText.includes('creating image') ||
          lastTurnText.includes('loading imagen')
        ) {
          return true;
        }

        return false;
      },
    });

    // Post-poll: wait for images to finish loading if image generation was triggered.
    // Gemini image gen can take 10-30s after the text portion stabilizes.
    const postPollRemainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    await waitForImages(page, postPollRemainingMs);

    const lastTurn = page.locator(SELECTORS.responseTurn).last();
    const markdown = (await lastTurn.innerHTML()) ?? '';

    // Extract generated images (Imagen / Nano Banana)
    const images: GeneratedImage[] = await page.evaluate((imgSelector: string) => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(document.querySelectorAll(imgSelector));
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (!src || seen.has(src)) continue;
        // Skip tiny icons/avatars (likely UI elements, not generated images)
        const w = (img as HTMLImageElement).naturalWidth;
        const h = (img as HTMLImageElement).naturalHeight;
        if (w > 0 && w < 64 && h > 0 && h < 64) continue;
        seen.add(src);
        const fullSizeUrl = src.includes('=s') ? src : `${src}=s1024-rj`;
        results.push({
          url: fullSizeUrl,
          alt: img.getAttribute('alt') ?? '',
          width: w,
          height: h,
        });
      }
      return results;
    }, SELECTORS.generatedImages);

    const totalElapsed = Date.now() - startTime;
    return {
      text,
      markdown,
      truncated,
      thinkingTime: Math.round(totalElapsed / 1000),
      ...(images.length > 0 ? { images } : {}),
    };
  },
};
