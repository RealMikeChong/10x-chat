import { describe, expect, it, vi } from 'vitest';
import { chatgptActions } from '../src/providers/chatgpt.js';

function createCapturePage(opts: {
  turnCounts: number[];
  snapshots: Array<{ found: boolean; text: string; html: string }>;
}) {
  const { turnCounts, snapshots } = opts;
  let turnCountIndex = 0;
  let snapshotIndex = 0;

  const stopButtonLocator = {
    first: () => stopButtonLocator,
    isVisible: vi.fn(async () => false),
  };

  const defaultLocator = {
    count: vi.fn(async () => 0),
    first: () => defaultLocator,
    last: () => defaultLocator,
    isVisible: vi.fn(async () => false),
  };

  const page = {
    url: vi.fn(() => 'https://chatgpt.com'),
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => {
      if (selector.includes('Stop streaming')) return stopButtonLocator;
      if (selector === 'div.agent-turn') {
        return {
          ...defaultLocator,
          count: vi.fn(
            async () => turnCounts[Math.min(turnCountIndex++, turnCounts.length - 1)] ?? 0,
          ),
        };
      }
      return defaultLocator;
    }),
    evaluate: vi.fn(async (_fn: unknown, arg?: unknown) => {
      if (Array.isArray(arg)) {
        return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? snapshots.at(-1);
      }
      return [];
    }),
  };

  return { page };
}

describe('ChatGPT Provider', () => {
  describe('captureResponse', () => {
    it('captures response text and markdown via page.evaluate snapshots', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
        ],
      });

      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
      });

      expect(response.text).toBe('Hello');
      expect(response.markdown).toBe('<p>Hello</p>');
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('streams chunk deltas from evaluate-based snapshots', async () => {
      const { page } = createCapturePage({
        turnCounts: [0, 1],
        snapshots: [
          { found: true, text: 'Hel', html: '<p>Hel</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
          { found: true, text: 'Hello', html: '<p>Hello</p>' },
        ],
      });

      const chunks: string[] = [];
      const response = await chatgptActions.captureResponse(page as never, {
        timeoutMs: 5_000,
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(response.text).toBe('Hello');
      expect(chunks).toContain('Hel');
      expect(chunks).toContain('lo');
    });
  });
});
