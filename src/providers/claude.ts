import type { Page } from 'playwright';
import { pollUntilStable } from '../core/polling.js';
import type { CapturedResponse, ProviderActions, ProviderConfig } from '../types.js';
import { fillAndSubmitPrompt } from './utils.js';

export const CLAUDE_CONFIG: ProviderConfig = {
  name: 'claude',
  displayName: 'Claude',
  url: 'https://claude.ai/new',
  loginUrl: 'https://claude.ai/login',
  models: ['Claude 4 Sonnet', 'Claude 4 Opus'],
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
} as const;

export const claudeActions: ProviderActions = {
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
    await fillAndSubmitPrompt(page, SELECTORS, prompt);
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
