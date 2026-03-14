import { describe, expect, it, vi } from 'vitest';
import {
  configureVideoMode,
  FLOW_CONFIG,
  FLOW_SELECTORS,
  flowActions,
  waitForGeneration,
} from '../src/providers/flow.js';

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
  setInputFiles: ReturnType<typeof vi.fn>;
}

function createMockLocator(opts: { visible?: boolean } = {}): MockLocator {
  const { visible = false } = opts;
  const loc: MockLocator = {
    first: () => loc,
    last: () => loc,
    isVisible: vi.fn(async () => visible),
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    count: vi.fn(async () => 0),
    textContent: vi.fn(async () => ''),
    innerHTML: vi.fn(async () => ''),
    nth: () => loc,
    setInputFiles: vi.fn(async () => {}),
  };
  return loc;
}

interface MockPageOpts {
  /** Map of selector substring → visibility */
  visibleSelectors?: Record<string, boolean>;
  /** Value returned by page.evaluate */
  evaluateReturn?: unknown;
  /** Sequence of evaluate returns (for polling) */
  evaluateSequence?: unknown[];
}

function createMockPage(opts: MockPageOpts = {}) {
  const { visibleSelectors = {}, evaluateReturn, evaluateSequence } = opts;
  const locatorCalls: string[] = [];
  const clickedSelectors: string[] = [];
  let evalCallCount = 0;

  const page = {
    locator: vi.fn((selector: string) => {
      locatorCalls.push(selector);
      const visible = Object.entries(visibleSelectors).some(
        ([sub, v]) => selector.includes(sub) && v,
      );
      const loc = createMockLocator({ visible });
      loc.click = vi.fn(async () => {
        if (visible) clickedSelectors.push(selector);
      });
      return loc;
    }),
    waitForTimeout: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    keyboard: {
      press: vi.fn(async () => {}),
    },
    evaluate: vi.fn(async () => {
      if (evaluateSequence && evalCallCount < evaluateSequence.length) {
        return evaluateSequence[evalCallCount++];
      }
      return evaluateReturn ?? {};
    }),
    url: vi.fn(() => 'https://labs.google/fx/tools/flow'),
  };

  return { page, locatorCalls, clickedSelectors };
}

// ── Static config tests ─────────────────────────────────────────

describe('Flow Provider', () => {
  describe('FLOW_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(FLOW_CONFIG.name).toBe('flow');
    });

    it('should have correct display name', () => {
      expect(FLOW_CONFIG.displayName).toBe('Google Flow');
    });

    it('should have correct URL', () => {
      expect(FLOW_CONFIG.url).toBe('https://labs.google/fx/tools/flow');
    });

    it('should have available models', () => {
      expect(FLOW_CONFIG.models).toBeDefined();
      expect(FLOW_CONFIG.models?.length).toBeGreaterThan(0);
      expect(FLOW_CONFIG.models).toContain('Veo 3.1 - Fast');
      expect(FLOW_CONFIG.models).toContain('Veo 3.1 - Quality');
      expect(FLOW_CONFIG.models).toContain('Veo 2 - Fast');
      expect(FLOW_CONFIG.models).toContain('Veo 2 - Quality');
    });

    it('should default to Veo 3.1 - Fast model', () => {
      expect(FLOW_CONFIG.defaultModel).toBe('Veo 3.1 - Fast');
    });

    it('should have a 10-minute default timeout for video generation', () => {
      expect(FLOW_CONFIG.defaultTimeoutMs).toBe(10 * 60 * 1000);
    });
  });

  describe('FLOW_SELECTORS', () => {
    it('should define navigation selectors', () => {
      expect(FLOW_SELECTORS.newProject).toBe('button:has-text("New project")');
      expect(FLOW_SELECTORS.goBack).toBe('button:has-text("Go Back")');
    });

    it('should define prompt composer selectors', () => {
      expect(FLOW_SELECTORS.composer).toBe('div[contenteditable="true"]');
      expect(FLOW_SELECTORS.composerTextbox).toBe('[role="textbox"]');
    });

    it('should define submit button selector', () => {
      expect(FLOW_SELECTORS.createButton).toBe('button:has-text("arrow_forward")');
    });

    it('should define output type tab selectors', () => {
      expect(FLOW_SELECTORS.imageTab).toBe('button[role="tab"]:has-text("Image")');
      expect(FLOW_SELECTORS.videoTab).toBe('button[role="tab"]:has-text("Video")');
    });

    it('should define video sub-mode tab selectors', () => {
      expect(FLOW_SELECTORS.ingredientsTab).toBe('button[role="tab"]:has-text("Ingredients")');
      expect(FLOW_SELECTORS.framesTab).toBe('button[role="tab"]:has-text("Frames")');
    });

    it('should define orientation selectors', () => {
      expect(FLOW_SELECTORS.landscapeBtn).toBe('button:has-text("Landscape")');
      expect(FLOW_SELECTORS.portraitBtn).toBe('button:has-text("Portrait")');
    });

    it('should define count selectors for 1-4', () => {
      expect(FLOW_SELECTORS.countX1).toBe('button[role="tab"]:has-text("x1")');
      expect(FLOW_SELECTORS.countX2).toBe('button[role="tab"]:has-text("x2")');
      expect(FLOW_SELECTORS.countX3).toBe('button[role="tab"]:has-text("x3")');
      expect(FLOW_SELECTORS.countX4).toBe('button[role="tab"]:has-text("x4")');
    });

    it('should define frame upload selectors', () => {
      expect(FLOW_SELECTORS.startFrame).toBe('text="Start"');
      expect(FLOW_SELECTORS.endFrame).toBe('text="End"');
    });

    it('should define file input selector', () => {
      expect(FLOW_SELECTORS.fileInput).toBe('input[type="file"][accept="image/*"]');
    });
  });

  describe('flowActions', () => {
    it('should export all required action methods', () => {
      expect(flowActions.isLoggedIn).toBeTypeOf('function');
      expect(flowActions.submitPrompt).toBeTypeOf('function');
      expect(flowActions.captureResponse).toBeTypeOf('function');
    });
  });

  // ── Behavioral tests ────────────────────────────────────────────

  describe('configureVideoMode', () => {
    it('should click the model pill to open selector', async () => {
      const { page, locatorCalls } = createMockPage({
        visibleSelectors: {
          [FLOW_SELECTORS.modelPill]: true,
          Video: true,
          Landscape: true,
          x1: true,
        },
      });

      await configureVideoMode(page as never, {});

      // Should have attempted to find the model pill
      const pillClicked = locatorCalls.some((s) => s.includes(FLOW_SELECTORS.modelPill));
      expect(pillClicked).toBe(true);

      // Should press Escape to close popup
      expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    });

    it('should click Video tab, orientation, and count buttons', async () => {
      const { page, clickedSelectors } = createMockPage({
        visibleSelectors: {
          [FLOW_SELECTORS.modelPill]: true,
          Video: true,
          Portrait: true,
          x3: true,
        },
      });

      await configureVideoMode(page as never, {
        orientation: 'portrait',
        count: 3,
      });

      // Should have clicked Video tab
      expect(clickedSelectors.some((s) => s.includes('Video'))).toBe(true);
      // Should have clicked Portrait
      expect(clickedSelectors.some((s) => s.includes('Portrait'))).toBe(true);
      // Should have clicked x3
      expect(clickedSelectors.some((s) => s.includes('x3'))).toBe(true);
    });

    it('should select non-default model via dropdown', async () => {
      const { page, locatorCalls } = createMockPage({
        visibleSelectors: {
          [FLOW_SELECTORS.modelPill]: true,
          Video: true,
          Landscape: true,
          x1: true,
          arrow_drop_down: true,
          'Veo 3.1 - Quality': true,
        },
      });

      await configureVideoMode(page as never, {
        model: 'Veo 3.1 - Quality',
      });

      // Should have looked for the model in text
      expect(locatorCalls.some((s) => s.includes('Veo 3.1 - Quality'))).toBe(true);
    });

    it('should not open model dropdown for default model', async () => {
      const { page, locatorCalls } = createMockPage({
        visibleSelectors: {
          [FLOW_SELECTORS.modelPill]: true,
          Video: true,
          Landscape: true,
          x1: true,
        },
      });

      await configureVideoMode(page as never, {
        model: 'Veo 3.1 - Fast', // default — should skip dropdown
      });

      // Should NOT have tried to open the dropdown
      expect(locatorCalls.some((s) => s.includes('arrow_drop_down'))).toBe(false);
    });
  });

  describe('waitForGeneration', () => {
    it('should call onProgress with percentage updates', async () => {
      const progressValues: number[] = [];
      const { page } = createMockPage({
        evaluateSequence: [
          { done: false, percent: 25, videoCount: 0 },
          { done: false, percent: 50, videoCount: 0 },
          { done: false, percent: 75, videoCount: 0 },
          { done: true, percent: 100, videoCount: 1 },
        ],
      });

      await waitForGeneration(page as never, {
        timeoutMs: 30_000,
        onProgress: (pct) => progressValues.push(pct),
      });

      expect(progressValues).toEqual([25, 50, 75, 100]);
    });

    it('should exit early when videos are detected', async () => {
      const { page } = createMockPage({
        evaluateSequence: [
          { done: false, percent: 0, videoCount: 0 },
          { done: true, percent: 100, videoCount: 2 },
        ],
      });

      // Should resolve without timing out
      await expect(waitForGeneration(page as never, { timeoutMs: 5_000 })).resolves.toBeUndefined();

      // Should have called evaluate at least twice (two polls)
      expect(page.evaluate).toHaveBeenCalledTimes(2);
    });

    it('should respect timeout when generation never completes', async () => {
      const { page } = createMockPage({
        evaluateReturn: { done: false, percent: 10, videoCount: 0 },
      });

      // Use a very short timeout
      const start = Date.now();
      await waitForGeneration(page as never, { timeoutMs: 100 });
      const elapsed = Date.now() - start;

      // Should have completed near the timeout (within tolerance)
      expect(elapsed).toBeLessThan(2000); // generous upper bound
    });
  });

  describe('flowActions.isLoggedIn', () => {
    it('should return true when studio content is present', async () => {
      const { page } = createMockPage({
        evaluateReturn: true, // body contains "New project"
      });

      const result = await flowActions.isLoggedIn(page as never);
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      const page = {
        waitForTimeout: vi.fn(async () => {}),
        evaluate: vi.fn(async () => {
          throw new Error('Page crashed');
        }),
      };

      const result = await flowActions.isLoggedIn(page as never);
      expect(result).toBe(false);
    });
  });

  describe('flowActions.captureResponse', () => {
    it('should return CapturedResponse with video count', async () => {
      const { page } = createMockPage({
        evaluateSequence: [
          // First call: waitForGeneration poll → done immediately
          { done: true, percent: 100, videoCount: 1 },
          // Second call: video info extraction
          { count: 2, urls: ['https://example.com/video1.mp4', 'https://example.com/video2.mp4'] },
        ],
      });

      const response = await flowActions.captureResponse(page as never, {
        timeoutMs: 5_000,
      });

      expect(response.text).toContain('Generated 2 video(s)');
      expect(response.truncated).toBe(false);
      expect(response.thinkingTime).toBeDefined();
    });

    it('should report timeout when generation does not complete', async () => {
      const { page } = createMockPage({
        evaluateSequence: [
          { done: false, percent: 50, videoCount: 0 },
          { count: 0, urls: [] },
        ],
      });

      const response = await flowActions.captureResponse(page as never, {
        timeoutMs: 100, // Very short timeout
      });

      expect(response.truncated).toBe(true);
    });

    it('should invoke onChunk with progress updates', async () => {
      const chunks: string[] = [];
      const { page } = createMockPage({
        evaluateSequence: [
          { done: false, percent: 30, videoCount: 0 },
          { done: true, percent: 100, videoCount: 1 },
          { count: 1, urls: ['https://example.com/v.mp4'] },
        ],
      });

      await flowActions.captureResponse(page as never, {
        timeoutMs: 10_000,
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.includes('30%'))).toBe(true);
    });
  });
});
