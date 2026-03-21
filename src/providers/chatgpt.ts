import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';
import { submitPromptToComposer } from './submit.js';

export const CHATGPT_CONFIG: ProviderConfig = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  url: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  models: ['GPT-4o', 'GPT-4o mini', 'GPT-4.5', 'o1', 'o3-mini'],
  defaultModel: 'GPT-4o',
  defaultTimeoutMs: 5 * 60 * 1000,
  // ChatGPT's Cloudflare bot-protection blocks headless Playwright permanently.
  // The chat orchestrator will automatically force headed mode for this provider.
  headlessBlocked: true,
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
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignore — overlay may not exist
    }
  }
}

/**
 * Detect Cloudflare bot-protection challenge pages.
 * Returns true when the current page is the "Just a moment..." challenge.
 */
async function isCloudflareChallenge(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => '');
  if (title === 'Just a moment...' || title.toLowerCase().includes('checking your browser')) {
    return true;
  }
  // Also check for the Cloudflare challenge iframe/form
  const cfElement = await page
    .locator('#challenge-running, #challenge-form, .cf-browser-verification')
    .first()
    .isVisible()
    .catch(() => false);
  return cfElement;
}

/** Sentinel error class so the orchestrator can distinguish CF blocks from other failures. */
export class CloudflareBlockedError extends Error {
  constructor() {
    super(
      'Cloudflare bot-protection is blocking the browser.\n' +
        'ChatGPT requires a visible browser window — run with the --headed flag:\n' +
        '  10x-chat chat --provider chatgpt --headed -p "your prompt"',
    );
    this.name = 'CloudflareBlockedError';
  }
}

export const chatgptActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    // Detect Cloudflare challenge before anything else.
    // This happens when running headless — Cloudflare blocks non-human browsers.
    // The orchestrator should have already forced headed mode via headlessBlocked,
    // but throw a clear error here as a safety net.
    if (await isCloudflareChallenge(page)) {
      throw new CloudflareBlockedError();
    }

    try {
      // Wait for either composer or login indicators to appear
      await page
        .locator(`${SELECTORS.composer}, ${SELECTORS.loginPage}`)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .catch(() => {});

      // Re-check for Cloudflare after the wait (page may have navigated)
      if (await isCloudflareChallenge(page)) {
        throw new CloudflareBlockedError();
      }

      // Dismiss any overlays that might be hiding the composer
      await dismissOverlays(page);

      const composerVisible = await page
        .locator(SELECTORS.composer)
        .first()
        .isVisible()
        .catch(() => false);
      if (composerVisible) return true;

      const loginVisible = await page
        .locator(SELECTORS.loginPage)
        .first()
        .isVisible()
        .catch(() => false);
      if (loginVisible) return false;

      return false;
    } catch (err) {
      // Re-throw Cloudflare errors so the orchestrator can surface them
      if (err instanceof CloudflareBlockedError) throw err;
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
    const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const { text: lastText, truncated } = await pollUntilStable(page, {
      getText: async (p) => {
        const lastTurn = p.locator(SELECTORS.assistantTurn).last();
        const remaining = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
        return (await lastTurn.textContent({ timeout: remaining }))?.trim() ?? '';
      },
      timeoutMs: remainingMs,
      onChunk,
      isStreaming: async (p) =>
        p
          .locator(SELECTORS.stopButton)
          .first()
          .isVisible()
          .catch(() => false),
    });

    // Extract the final HTML content
    const lastTurn = page.locator(SELECTORS.assistantTurn).last();
    const finalRemainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const markdown = (await lastTurn.innerHTML({ timeout: finalRemainingMs })) ?? '';

    // Extract generated images (DALL-E / GPT-Image)
    // ChatGPT uses alt="Generated image: <description>" and src containing
    // backend-api/estuary/content with file IDs.
    const images: GeneratedImage[] = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const imgs = Array.from(
        document.querySelectorAll('img[alt^="Generated image"], img[src*="estuary/content"]'),
      );
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        const alt = img.getAttribute('alt') ?? '';
        const w = (img as HTMLImageElement).naturalWidth;
        const h = (img as HTMLImageElement).naturalHeight;
        // Skip small icons/avatars and profile images
        if (w > 0 && w < 128 && h > 0 && h < 128) continue;
        if (alt === 'Profile image') continue;
        // Deduplicate by file ID in the URL
        const idMatch = src.match(/[?&]id=([^&]+)/);
        const key = idMatch ? idMatch[1] : src;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({ url: src, alt, width: w, height: h });
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
