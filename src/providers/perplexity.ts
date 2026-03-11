import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';

export const PERPLEXITY_CONFIG: ProviderConfig = {
  name: 'perplexity',
  displayName: 'Perplexity',
  url: 'https://www.perplexity.ai',
  loginUrl: 'https://www.perplexity.ai',
  models: ['Auto', 'Sonar', 'Sonar Pro', 'GPT-4.1', 'Claude 4 Sonnet'],
  defaultModel: 'Auto',
  defaultTimeoutMs: 2 * 60 * 1000, // Perplexity is fast (search + generate)
  // Perplexity uses Cloudflare bot-protection that blocks headless Playwright.
  headlessBlocked: true,
};

const SELECTORS = {
  /** Composer: contenteditable div with role="textbox" */
  composer: 'div[role="textbox"][contenteditable="true"]',
  /** Submit button (appears when text is present in composer) */
  sendButton: 'button[aria-label="Submit"]',
  /** The prose/markdown response container */
  responseTurn: '.prose',
  /** Login indicators — "Sign In" link in sidebar */
  loginIndicator: 'a:has-text("Sign In"), button:has-text("Sign In")',
  /** Sign-in popup overlay with Google/Apple buttons */
  signInPopup: 'button:has-text("Continue with Google")',
  /** File/attachment button */
  fileButton: 'button[aria-label="Add files or tools"]',
  /** Hidden file input (if any) */
  fileInput: 'input[type="file"]',
} as const;

/**
 * Dismiss Perplexity onboarding/sign-in popups that can block the composer.
 * The sign-in popup overlay intercepts pointer events on the Submit button,
 * so we must dismiss it before any click actions.
 */
async function dismissOverlays(page: Page): Promise<void> {
  // Close sign-in popup if present (try multiple times — it can reappear)
  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator('button[aria-label="Close"]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ force: true });
      await page.waitForTimeout(500);
    } else {
      break;
    }
  }

  // Also try clicking outside or pressing Escape to dismiss any remaining overlay
  const overlay = page.locator('.animate-in.fade-in').first();
  if (await overlay.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

export const perplexityActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for either the composer or sign-in prompt to appear
      await page
        .locator(`${SELECTORS.composer}, ${SELECTORS.loginIndicator}`)
        .first()
        .waitFor({ state: 'visible', timeout: 8_000 })
        .catch(() => {});

      // Dismiss overlays
      await dismissOverlays(page);

      // Perplexity works without login for basic searches.
      // Check if user is authenticated by looking for "Sign In" button
      // in the sidebar — when logged in, this is replaced by user avatar.
      const signInVisible = await page
        .locator(SELECTORS.loginIndicator)
        .first()
        .isVisible()
        .catch(() => false);

      // Composer must be visible regardless
      const composerVisible = await page
        .locator(SELECTORS.composer)
        .first()
        .isVisible()
        .catch(() => false);

      if (!composerVisible) return false;

      // If "Sign In" is visible, user is not authenticated.
      // We still return true since Perplexity works without login,
      // but Pro features (model selection, file upload) won't be available.
      if (signInVisible) {
        // Still usable for basic queries — treat as logged in for now.
        // The user gets free-tier behavior without authentication.
        return true;
      }

      return true;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Dismiss sign-in popups before interacting with composer
    await dismissOverlays(page);

    const composer = page.locator(SELECTORS.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    await composer.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    // Type the prompt
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

    // Dismiss overlay again — Perplexity may pop up sign-in after focusing composer
    await dismissOverlays(page);

    // Click send with force to bypass any remaining overlay interception
    const sendButton = page.locator(SELECTORS.sendButton).first();
    await sendButton.waitFor({ state: 'visible', timeout: 5_000 });
    await sendButton.click({ force: true });
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();
    const initialUrl = page.url();

    // Perplexity navigates from / to /search/<slug>-<id> after submit.
    // Wait for the URL to change (indicates response page loaded).
    await page
      .waitForURL((url) => url.toString() !== initialUrl, {
        timeout: Math.min(timeoutMs, 30_000),
      })
      .catch(() => {});

    // Wait for the prose response container to appear
    await page
      .locator(SELECTORS.responseTurn)
      .first()
      .waitFor({ timeout: Math.max(timeoutMs - (Date.now() - startTime), 10_000) });

    // Poll until the response stops changing (streaming complete)
    const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 5_000);
    const { text: lastText, truncated } = await pollUntilStable(page, {
      getText: async (p) =>
        (await p.locator(SELECTORS.responseTurn).first().textContent())?.trim() ?? '',
      timeoutMs: remainingMs,
      onChunk,
    });

    // Extract the final HTML content
    const responseTurn = page.locator(SELECTORS.responseTurn).first();
    const markdown = (await responseTurn.innerHTML({ timeout: 5_000 }).catch(() => '')) ?? '';

    const totalElapsed = Date.now() - startTime;
    return {
      text: lastText,
      markdown,
      truncated,
      thinkingTime: Math.round(totalElapsed / 1000),
    };
  },
};
