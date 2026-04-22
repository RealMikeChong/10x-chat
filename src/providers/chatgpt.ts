import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type {
  CapturedResponse,
  GeneratedImage,
  ProviderActions,
  ProviderConfig,
} from '../types.js';
import { submitPromptToComposer } from './submit.js';

const ASSISTANT_TURN_FALLBACK_SELECTORS = [
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
  '.markdown',
] as const;

const ASSISTANT_TURN_COUNT_SELECTORS = [
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
] as const;

const ASSISTANT_CONTENT_FALLBACK_SELECTORS = [
  'div.agent-turn .markdown',
  'article[data-testid^="conversation-turn-"]:has(.markdown) .markdown',
  'div[data-message-id]:has(.markdown) .markdown',
  'div.agent-turn',
  'article[data-testid^="conversation-turn-"]:has(.markdown)',
  'div[data-message-id]:has(.markdown)',
  '[data-message-author-role="assistant"]',
  '.markdown',
] as const;

export const CHATGPT_CONFIG: ProviderConfig = {
  name: 'chatgpt',
  displayName: 'ChatGPT',
  url: 'https://chatgpt.com',
  loginUrl: 'https://chatgpt.com/auth/login',
  models: ['Instant', 'Thinking'],
  defaultModel: 'Thinking',
  defaultTimeoutMs: 5 * 60 * 1000,
  // ChatGPT's Cloudflare bot-protection blocks headless Playwright permanently.
  // The chat orchestrator will automatically force headed mode for this provider.
  headlessBlocked: true,
};

const SELECTORS = {
  composer:
    '#prompt-textarea.ProseMirror[contenteditable="true"][role="textbox"], #prompt-textarea[contenteditable="true"], [data-testid="composer-input"], div.ProseMirror[contenteditable="true"], textarea, .wcDTda_fallbackTextarea',
  sendButton:
    '#composer-submit-button, button[aria-label="Send prompt"], [data-testid="send-button"]',
  stopButton: 'button[aria-label="Stop streaming"]',
  assistantTurn: ASSISTANT_TURN_FALLBACK_SELECTORS.join(', '),
  loginPage: 'button:has-text("Log in"), button:has-text("Sign up")',
  /** Hidden file input — exclude the dedicated photo/camera inputs */
  fileInput: 'input[type="file"]:not(#upload-photos):not(#upload-camera)',
  modelPicker:
    'button[data-testid="model-switcher-dropdown-button"], button[aria-label="Model selector"], button[aria-label*="model" i], button[aria-haspopup="menu"], button[aria-haspopup="listbox"], button[aria-haspopup="dialog"]',
  modelOption: '[role="menuitem"]',
} as const;

const MODEL_OPTION_SCOPE_SELECTORS = [
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-headlessui-portal]',
  '[data-floating-ui-portal]',
  '[role="dialog"]',
] as const;

function normalizeModelLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function getAssistantTurnCount(page: Page): Promise<number> {
  for (const selector of ASSISTANT_TURN_COUNT_SELECTORS) {
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    if (count > 0) {
      return count;
    }
  }

  return page
    .locator(SELECTORS.assistantTurn)
    .count()
    .catch(() => 0);
}

async function getLatestAssistantSnapshot(
  page: Page,
): Promise<{ found: boolean; text: string; html: string }> {
  return page.evaluate(
    (selectors: readonly string[]) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      for (const selector of selectors) {
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length === 0) continue;

        const visibleMatches = matches.filter(isVisible);
        const last = (visibleMatches.length > 0 ? visibleMatches : matches).at(-1);
        if (!(last instanceof Element)) continue;

        const text =
          last instanceof HTMLElement
            ? (last.innerText || last.textContent || '').trim()
            : (last.textContent || '').trim();
        const html = 'innerHTML' in last ? (last as HTMLElement).innerHTML || '' : '';
        return { found: true, text, html };
      }

      return { found: false, text: '', html: '' };
    },
    [...ASSISTANT_CONTENT_FALLBACK_SELECTORS],
  );
}

async function getVisibleModelPickerState(page: Page): Promise<{ found: boolean; text: string }> {
  return page.evaluate(
    ({ explicitSelector, candidateSelector }) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const explicitPicker = Array.from(document.querySelectorAll(explicitSelector)).find(
        isVisible,
      );
      if (explicitPicker) {
        return { found: true, text: normalizeText(explicitPicker.textContent) };
      }

      const pickerTextRe = /instant|thinking|gpt|model/i;
      const candidate = Array.from(document.querySelectorAll(candidateSelector)).find((element) => {
        return (
          isVisible(element) &&
          pickerTextRe.test(
            normalizeText(
              element.getAttribute('aria-label') ||
                element.textContent ||
                element.getAttribute('data-testid'),
            ),
          )
        );
      });

      return candidate
        ? { found: true, text: normalizeText(candidate.textContent) }
        : { found: false, text: '' };
    },
    {
      explicitSelector: 'button[data-testid="model-switcher-dropdown-button"]',
      candidateSelector: SELECTORS.modelPicker,
    },
  );
}

async function clickVisibleModelOption(page: Page, model: string): Promise<boolean> {
  return page.evaluate(
    ({ modelLabel, optionSelector, scopeSelectors, excludedSelector }) => {
      const normalizeText = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const matchesModel = (element: Element) => {
        const text = normalizeText(element.textContent);
        return text.includes(modelLabel);
      };
      const isExcluded = (element: Element) =>
        Boolean(
          excludedSelector &&
            (element.matches(excludedSelector) || element.closest(excludedSelector)),
        );

      for (const scopeSelector of scopeSelectors) {
        const scopes = Array.from(document.querySelectorAll(scopeSelector));
        for (const scope of scopes) {
          const option = Array.from(scope.querySelectorAll(optionSelector)).find((element) => {
            return isVisible(element) && matchesModel(element);
          });
          if (option instanceof HTMLElement) {
            option.click();
            return true;
          }
        }
      }

      const fallbackOption = Array.from(document.querySelectorAll(optionSelector)).find(
        (element) => {
          return isVisible(element) && !isExcluded(element) && matchesModel(element);
        },
      );

      if (!(fallbackOption instanceof HTMLElement)) {
        return false;
      }

      fallbackOption.click();
      return true;
    },
    {
      modelLabel: normalizeModelLabel(model),
      optionSelector: SELECTORS.modelOption,
      scopeSelectors: [...MODEL_OPTION_SCOPE_SELECTORS],
      excludedSelector: SELECTORS.modelPicker,
    },
  );
}

/**
 * Dismiss ChatGPT onboarding modals, cookie banners, and other overlays
 * that can block the composer input. Fails silently if no overlays are present.
 */
async function dismissOverlays(page: Page): Promise<void> {
  const overlaySelectors = [
    // Login/signup modal that blocks all pointer events
    '#modal-no-auth-login button:has-text("Stay logged out")',
    '#modal-no-auth-login button:has-text("Continue without login")',
    '#modal-no-auth-login button:has-text("Not now")',
    '#modal-no-auth-login button[aria-label="Close"]',
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
        await btn.click({ force: true });
        await page.waitForTimeout(300);
      }
    } catch {
      // Ignore — overlay may not exist
    }
  }

  const noAuthModal = page.locator('#modal-no-auth-login').first();
  if (await noAuthModal.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // Last-resort cleanup: sometimes ChatGPT leaves the no-auth modal mounted
  // even though the authenticated composer is visible underneath. In that
  // case, the overlay keeps intercepting clicks for image/chat submission.
  const modalStillVisible = await noAuthModal.isVisible().catch(() => false);
  if (modalStillVisible) {
    const removed = await page.evaluate((composerSelector: string) => {
      const isVisible = (element: Element | null): element is HTMLElement => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const composerVisible = Array.from(document.querySelectorAll(composerSelector)).some(
        isVisible,
      );
      if (!composerVisible) return false;

      const modal = document.querySelector('#modal-no-auth-login');
      if (!(modal instanceof HTMLElement)) return false;
      modal.remove();
      return true;
    }, SELECTORS.composer);

    if (removed) {
      await page.waitForTimeout(150);
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
  async selectModel(page: Page, model: string): Promise<void> {
    await dismissOverlays(page);

    const picker = await getVisibleModelPickerState(page);
    if (!picker.found) {
      console.warn(`ChatGPT model picker not found — skipping model selection for "${model}"`);
      return;
    }

    if (normalizeModelLabel(picker.text) === normalizeModelLabel(model)) {
      return;
    }

    await page.locator('button[data-testid="model-switcher-dropdown-button"]').first().click();
    await page.waitForTimeout(750);

    const optionClicked = await clickVisibleModelOption(page, model);
    if (!optionClicked) {
      console.warn(`Model "${model}" not found in ChatGPT picker — using current model`);
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }

    await page.waitForTimeout(500);
  },

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

      const composerVisible = await page.evaluate((sel: string) => {
        const els = document.querySelectorAll(sel);
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (el instanceof HTMLElement && el.offsetWidth > 0 && el.offsetHeight > 0) return true;
        }
        return false;
      }, SELECTORS.composer);
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
    const initialTurnCount = await getAssistantTurnCount(page);

    // Phase 1: Wait for a new assistant turn to appear
    const waitForNewTurn = async (): Promise<void> => {
      while (Date.now() - startTime < timeoutMs) {
        const currentUrl = page.url();
        const currentCount = await getAssistantTurnCount(page);

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
        const snapshot = await getLatestAssistantSnapshot(p);
        return snapshot.text;
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

    // Extract the final HTML content using page.evaluate instead of locator.textContent/innerHTML.
    // ChatGPT's current UI exposes the nodes, but daemon-proxied locator text extraction can still
    // time out on them even after they are present in the DOM.
    const finalSnapshot = await getLatestAssistantSnapshot(page);
    const markdown = finalSnapshot.html;

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
