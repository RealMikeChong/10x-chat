import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_CONFIG, claudeActions, stripClaudeThinkingText } from '../src/providers/claude.js';

interface MockLocator {
  count: ReturnType<typeof vi.fn>;
  waitFor: ReturnType<typeof vi.fn>;
  nth: (n: number) => MockLocator;
  last: () => MockLocator;
  innerHTML: ReturnType<typeof vi.fn>;
  textContent: ReturnType<typeof vi.fn>;
}

function createCapturePage(opts: { textSequence: string[]; html?: string }) {
  const { textSequence, html = '<p>2 + 2 = 4.</p>' } = opts;
  let evalCallCount = 0;

  const lastLocator: MockLocator = {
    count: vi.fn(async () => 0),
    waitFor: vi.fn(async () => {}),
    nth: () => lastLocator,
    last: () => lastLocator,
    innerHTML: vi.fn(async () => html),
    textContent: vi.fn(async () => textSequence[textSequence.length - 1] ?? ''),
  };

  const page = {
    locator: vi.fn(() => lastLocator),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, _arg?: unknown) => {
      // If called with a string arg (selector), it's the getText evaluate
      if (typeof _arg === 'string') {
        const text = textSequence[Math.min(evalCallCount, textSequence.length - 1)] ?? '';
        evalCallCount++;
        return text;
      }
      // Otherwise it's the isStreaming check — return false (not streaming)
      return false;
    }),
  };

  return { page, lastLocator };
}

describe('Claude Provider', () => {
  describe('CLAUDE_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(CLAUDE_CONFIG.name).toBe('claude');
    });

    it('should have correct display name', () => {
      expect(CLAUDE_CONFIG.displayName).toBe('Claude');
    });

    it('should have correct URL', () => {
      expect(CLAUDE_CONFIG.url).toBe('https://claude.ai/new');
    });
  });

  describe('stripClaudeThinkingText', () => {
    it('removes leading thinking summary lines', () => {
      expect(
        stripClaudeThinkingText(
          'Thinking about the sum of two plus two\nThinking about the sum of two plus two\n2 + 2 = 4.',
        ),
      ).toBe('2 + 2 = 4.');
    });

    it('removes "Thought for" prefix lines', () => {
      expect(stripClaudeThinkingText('Thought for 5 seconds\nThe answer is 42.')).toBe(
        'The answer is 42.',
      );
    });

    it('preserves normal responses without thinking prefix', () => {
      expect(stripClaudeThinkingText('2 + 2 = 4.')).toBe('2 + 2 = 4.');
    });

    it('preserves empty string', () => {
      expect(stripClaudeThinkingText('')).toBe('');
    });

    it('returns thinking text if that is all there is (no answer yet)', () => {
      expect(stripClaudeThinkingText('Thinking about math')).toBe('Thinking about math');
    });
  });

  describe('claudeActions.captureResponse', () => {
    it('captures the answer without the thinking summary prefix', async () => {
      const { page } = createCapturePage({
        textSequence: [
          'Thinking about the sum of two plus two\nThinking about the sum of two plus two\n2 + 2 = 4.',
          'Thinking about the sum of two plus two\nThinking about the sum of two plus two\n2 + 2 = 4.',
          'Thinking about the sum of two plus two\nThinking about the sum of two plus two\n2 + 2 = 4.',
          'Thinking about the sum of two plus two\nThinking about the sum of two plus two\n2 + 2 = 4.',
        ],
        html: '<div>Thinking about the sum of two plus two</div><p>2 + 2 = 4.</p>',
      });

      const response = await claudeActions.captureResponse(page as never, {
        timeoutMs: 5_000,
      });

      expect(response.text).toBe('2 + 2 = 4.');
      expect(response.markdown).toBe(
        '<div>Thinking about the sum of two plus two</div><p>2 + 2 = 4.</p>',
      );
      expect(page.evaluate).toHaveBeenCalled();
    });
  });
});
