import type { Page } from 'playwright';
import { waitForUrlChange } from '../browser/page-utils.js';
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
  models: ['Auto', 'Fast', 'Expert', 'Heavy'],
  defaultModel: 'Auto',
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
  fileInput: 'input[type="file"][name="files"]',
  modelPicker:
    'button[aria-label="Model select"], button[aria-label*="model" i], button[aria-haspopup="menu"], button[aria-haspopup="listbox"]',
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

      const pickerTextRe = /auto|fast|expert|heavy|model/i;
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
      explicitSelector: 'button[aria-label="Model select"]',
      candidateSelector: SELECTORS.modelPicker,
    },
  );
}

export function extractGrokFailureText(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (/\bNo response\.?\b/i.test(normalized)) {
    const unableMessage = normalized.match(
      /Grok was unable to finish replying\. Please try again later or use a different model\.?/i,
    );
    if (unableMessage) return unableMessage[0];

    if (/^No response\.?$/i.test(normalized)) {
      return 'Grok returned no response.';
    }
  }

  return null;
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
        return text.startsWith(modelLabel) || text.includes(modelLabel);
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

export const grokActions: ProviderActions = {
  async selectModel(page: Page, model: string): Promise<void> {
    const picker = await getVisibleModelPickerState(page);
    if (!picker.found) {
      console.warn(`Grok model picker not found — skipping model selection for "${model}"`);
      return;
    }

    if (normalizeModelLabel(picker.text) === normalizeModelLabel(model)) {
      return;
    }

    await page.locator('button[aria-label="Model select"]').first().click();
    await page.waitForTimeout(750);

    const optionClicked = await clickVisibleModelOption(page, model);
    if (!optionClicked) {
      console.warn(`Model "${model}" not found in Grok picker — using current model`);
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }

    await page.waitForTimeout(500);
  },

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
    await waitForUrlChange(page, initialUrl, remainingForNav).catch(() => {});

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

    const pageText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const failureText = extractGrokFailureText(`${lastText}\n${pageText}`);
    if (failureText) {
      throw new Error(failureText);
    }

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
