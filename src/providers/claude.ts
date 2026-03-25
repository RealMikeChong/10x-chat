import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';
import { submitPromptToComposer } from './submit.js';

export const CLAUDE_CONFIG: ProviderConfig = {
  name: 'claude',
  displayName: 'Claude',
  url: 'https://claude.ai/new',
  loginUrl: 'https://claude.ai/login',
  models: ['Claude 4 Opus', 'Claude 4 Sonnet', 'Claude 3.5 Haiku'],
  defaultModel: 'Claude 4 Sonnet',
  defaultTimeoutMs: 5 * 60 * 1000,
};

const SELECTORS = {
  composer: '[contenteditable="true"].ProseMirror, div[enterkeyhint="enter"]',
  sendButton:
    'button[aria-label="Send message"], button[aria-label="Send Message"], button[data-testid="send-message"]',
  responseTurn:
    '[data-is-streaming], .font-claude-message, .font-claude-response, [data-testid="assistant-message"], [data-testid="user-message"] ~ div',
  fileInput: '[data-testid="file-upload"], #chat-input-file-upload-onpage',
  modelPicker:
    'button[aria-label*="model" i], button[aria-haspopup="menu"], button[aria-haspopup="listbox"], [role="button"][aria-haspopup="menu"], [role="button"][aria-haspopup="listbox"]',
  modelOption:
    '[role="menuitemradio"], [role="menuitem"], [role="option"], button, [role="button"]',
} as const;

const THINKING_PREFIX_RE =
  /^(thinking(?: about)?\b|thought for\b|pondering\b|identified\b|analyzing\b|considering\b|evaluating\b|processing\b|synthesized?\b|let me\b)/i;

export function stripClaudeThinkingText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return normalized;

  const lines = normalized.split('\n');
  let firstAnswerLine = 0;
  while (firstAnswerLine < lines.length && THINKING_PREFIX_RE.test(lines[firstAnswerLine].trim())) {
    firstAnswerLine++;
  }

  if (firstAnswerLine > 0) {
    const stripped = lines.slice(firstAnswerLine).join('\n').trim();
    if (stripped) return stripped;
  }

  return normalized;
}

function normalizeModelLabel(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getVisibleModelPicker(page: Page) {
  const candidates = page
    .locator(SELECTORS.modelPicker)
    .filter({ hasText: /claude|opus|sonnet|haiku/i });
  const count = await candidates.count();
  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function getVisibleModelOption(page: Page, model: string) {
  const exactName = new RegExp(`^\\s*${escapeRegExp(model)}\\s*$`, 'i');
  const scopedOptions = page
    .locator(
      [
        '[role="menu"]',
        '[role="listbox"]',
        '[data-radix-popper-content-wrapper]',
        '[data-headlessui-portal]',
        '[data-floating-ui-portal]',
        '[role="dialog"]',
      ].join(', '),
    )
    .locator(SELECTORS.modelOption)
    .filter({ hasText: exactName });

  const scopedCount = await scopedOptions.count();
  for (let index = 0; index < scopedCount; index++) {
    const option = scopedOptions.nth(index);
    if (await option.isVisible().catch(() => false)) {
      return option;
    }
  }

  const fallbackOptions = page.locator(SELECTORS.modelOption).filter({ hasText: exactName });
  const fallbackCount = await fallbackOptions.count();
  for (let index = 0; index < fallbackCount; index++) {
    const option = fallbackOptions.nth(index);
    if (await option.isVisible().catch(() => false)) {
      return option;
    }
  }

  return null;
}

export const claudeActions: ProviderActions = {
  async selectModel(page: Page, model: string): Promise<void> {
    const picker = await getVisibleModelPicker(page);
    if (!picker) {
      console.warn(`Claude model picker not found — skipping model selection for "${model}"`);
      return;
    }

    const currentModel = normalizeModelLabel(await picker.textContent().catch(() => ''));
    if (currentModel === normalizeModelLabel(model)) {
      return;
    }

    await picker.click({ force: true });
    await page.waitForTimeout(750);

    const option = await getVisibleModelOption(page, model);
    if (!option) {
      console.warn(`Model "${model}" not found in Claude picker — using current model`);
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }

    await option.click({ force: true });
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
      getText: async (p) => {
        const selector = SELECTORS.responseTurn;
        const visibleText = await p.evaluate((sel: string) => {
          const nodes = document.querySelectorAll(sel);
          const last = nodes[nodes.length - 1] as HTMLElement | undefined;
          if (!last) return '';

          // Claude's thinking block is rendered as a collapsible <details> or
          // a sibling div before the actual response content. Try to extract
          // only the non-thinking child content. The response text typically
          // lives in .font-claude-message or the last block-level child that
          // isn't a <details>/<button> collapsible.
          const thinkingEls = last.querySelectorAll(
            'details, [data-testid*="thinking"], [class*="thinking"], button[aria-expanded]',
          );
          if (thinkingEls.length > 0) {
            // Clone the node, remove thinking elements, get remaining text
            const clone = last.cloneNode(true) as HTMLElement;
            const removeSelectors = [
              'details',
              '[data-testid*="thinking"]',
              '[class*="thinking"]',
              'button[aria-expanded]',
            ];
            for (const rs of removeSelectors) {
              const matches = clone.querySelectorAll(rs);
              for (let i = 0; i < matches.length; i++) {
                matches[i].remove();
              }
            }
            const cleaned = clone.innerText?.trim();
            if (cleaned) return cleaned;
          }

          return (last.innerText ?? last.textContent ?? '').trim();
        }, selector);
        return stripClaudeThinkingText(visibleText);
      },
      timeoutMs: remainingMs,
      onChunk,
      isStreaming: async (p) => {
        // Claude is still generating when [data-is-streaming] is present
        const streaming = await p.evaluate(() => {
          return document.querySelector('[data-is-streaming]') !== null;
        });
        return streaming;
      },
    });

    const lastTurn = page.locator(SELECTORS.responseTurn).last();
    const markdown = (await lastTurn.innerHTML()) ?? '';

    const totalElapsed = Date.now() - startTime;
    return {
      text,
      markdown,
      truncated,
      thinkingTime: Math.round(totalElapsed / 1000),
    };
  },
};
