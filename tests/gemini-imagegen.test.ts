import { describe, expect, it, vi } from 'vitest';
import { GEMINI_CONFIG, geminiActions } from '../src/providers/gemini.js';

// ── Mock Page factory ───────────────────────────────────────────

interface MockLocator {
  first: () => MockLocator;
  last: () => MockLocator;
  isVisible: ReturnType<typeof vi.fn>;
  waitFor: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  textContent: ReturnType<typeof vi.fn>;
  innerHTML: ReturnType<typeof vi.fn>;
  nth: (n: number) => MockLocator;
}

function createMockLocator(
  opts: { visible?: boolean; text?: string; html?: string; count?: number } = {},
): MockLocator {
  const { visible = false, text = '', html = '', count = 0 } = opts;
  const loc: MockLocator = {
    first: () => loc,
    last: () => loc,
    isVisible: vi.fn(async () => visible),
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    count: vi.fn(async () => count),
    textContent: vi.fn(async () => text),
    innerHTML: vi.fn(async () => html),
    nth: () => loc,
  };
  return loc;
}

/**
 * Create a mock page that simulates Gemini's DOM.
 * Uses `Date.now()` manipulation to ensure polling loops terminate.
 */
function createGeminiMockPage(opts: {
  responseText: string;
  responseHtml: string;
  existingTurns?: number;
  images?: Array<{ url: string; alt: string; width: number; height: number }>;
  streamingVisibleCount?: number;
}) {
  const {
    responseText,
    responseHtml,
    existingTurns = 0,
    images = [],
    streamingVisibleCount = 0,
  } = opts;

  let streamingCheckCount = 0;
  let evalCallCount = 0;
  let waitForTimeoutCalls = 0;

  // Advance Date.now() on each waitForTimeout to ensure polling loops exit
  const realDateNow = Date.now;
  const startTime = realDateNow();

  const responseTurnLocator = createMockLocator({
    visible: true,
    text: responseText,
    html: responseHtml,
    count: existingTurns + 1,
  });

  const page = {
    locator: vi.fn((selector: string) => {
      // Streaming indicators
      if (
        selector.includes('Stop generating') ||
        selector.includes('loading') ||
        selector.includes('progress')
      ) {
        streamingCheckCount++;
        return createMockLocator({
          visible: streamingCheckCount <= streamingVisibleCount,
        });
      }

      // Response turns
      if (selector.includes('model-response')) {
        return responseTurnLocator;
      }

      return createMockLocator();
    }),
    evaluate: vi.fn(async (_fn: unknown, _arg?: unknown) => {
      evalCallCount++;
      // waitForImages calls:
      // 1st: check image state { count, allLoaded }
      // 2nd+: extract images array
      if (images.length > 0) {
        // Alternate between image state and image extraction
        if (evalCallCount % 2 === 1) {
          return { count: images.length, allLoaded: true };
        }
        return images;
      }
      // No images
      return evalCallCount % 2 === 1 ? { count: 0, allLoaded: true } : [];
    }),
    waitForTimeout: vi.fn(async () => {
      waitForTimeoutCalls++;
      // Simulate time passing so polling loops exit
      vi.spyOn(Date, 'now').mockReturnValue(startTime + waitForTimeoutCalls * 2000);
    }),
    getByRole: vi.fn(() => createMockLocator()),
  };

  return { page, getStats: () => ({ streamingCheckCount, evalCallCount, waitForTimeoutCalls }) };
}

// ── Tests ───────────────────────────────────────────────────────

describe('Gemini provider config', () => {
  it('should have correct provider name', () => {
    expect(GEMINI_CONFIG.name).toBe('gemini');
  });

  it('should have correct URL', () => {
    expect(GEMINI_CONFIG.url).toBe('https://gemini.google.com/app');
  });
});

describe('Gemini captureResponse — image generation', () => {
  it('should detect and return generated images', async () => {
    const imageData = [
      {
        url: 'https://lh3.googleusercontent.com/abc123=s1024-rj',
        alt: 'AI generated image',
        width: 1024,
        height: 1024,
      },
    ];

    const { page } = createGeminiMockPage({
      responseText: 'Here is your generated image',
      responseHtml:
        '<p>Here is your generated image</p><img src="https://lh3.googleusercontent.com/abc123" class="image loaded">',
      images: imageData,
    });

    const result = await geminiActions.captureResponse(page as any, {
      timeoutMs: 5_000,
      onChunk: () => {},
    });

    expect(result.text).toBe('Here is your generated image');
    expect(result.images).toBeDefined();
    expect(result.images!.length).toBe(1);
    expect(result.images![0].url).toContain('lh3.googleusercontent.com');

    vi.restoreAllMocks();
  });

  it('should return text-only response when no images are generated', async () => {
    const { page } = createGeminiMockPage({
      responseText: 'The capital of France is Paris.',
      responseHtml: '<p>The capital of France is Paris.</p>',
      images: [],
    });

    const result = await geminiActions.captureResponse(page as any, {
      timeoutMs: 5_000,
      onChunk: () => {},
    });

    expect(result.text).toBe('The capital of France is Paris.');
    expect(result.images).toBeUndefined();

    vi.restoreAllMocks();
  });

  it('should include thinkingTime in the response', async () => {
    const { page } = createGeminiMockPage({
      responseText: 'Hello!',
      responseHtml: '<p>Hello!</p>',
    });

    const result = await geminiActions.captureResponse(page as any, {
      timeoutMs: 5_000,
    });

    expect(result.thinkingTime).toBeDefined();
    expect(typeof result.thinkingTime).toBe('number');

    vi.restoreAllMocks();
  });

  it('should include markdown (innerHTML) in the response', async () => {
    const { page } = createGeminiMockPage({
      responseText: 'Hello world',
      responseHtml: '<p>Hello <strong>world</strong></p>',
    });

    const result = await geminiActions.captureResponse(page as any, {
      timeoutMs: 5_000,
    });

    expect(result.markdown).toBe('<p>Hello <strong>world</strong></p>');

    vi.restoreAllMocks();
  });
});
