import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for ChatGPT overlay/modal dismissal behavior.
 * Uses a lightweight Page mock since Playwright's real Page requires a browser.
 */

// Minimal mock that simulates a Page with an onboarding modal
function createMockPage(options: { hasOnboardingModal?: boolean; hasComposer?: boolean } = {}) {
  const { hasOnboardingModal = false, hasComposer = true } = options;
  const clickedSelectors: string[] = [];

  const mockElement = (visible = true) => ({
    click: vi.fn(async () => {}),
    isVisible: vi.fn(async () => visible),
    fill: vi.fn(async () => {}),
  });

  const composerEl = hasComposer ? mockElement() : null;
  const onboardingBtn = hasOnboardingModal ? mockElement(true) : null;

  return {
    page: {
      $: vi.fn(async (selector: string) => {
        if (selector.includes('modal-onboarding') && selector.includes('Skip') && onboardingBtn) {
          clickedSelectors.push(selector);
          return onboardingBtn;
        }
        if (selector.includes('modal-onboarding') && onboardingBtn) {
          return onboardingBtn;
        }
        if (selector.includes('composer') || selector.includes('ProseMirror')) {
          return composerEl;
        }
        return null;
      }),
      waitForSelector: vi.fn(async () => composerEl),
      waitForTimeout: vi.fn(async () => {}),
      keyboard: {
        press: vi.fn(async () => {}),
      },
      evaluate: vi.fn(async () => {}),
    },
    clickedSelectors,
    composerEl,
    onboardingBtn,
  };
}

describe('ChatGPT Overlay Dismissal', () => {
  it('should not crash when no overlays are present', async () => {
    const { page } = createMockPage({ hasOnboardingModal: false, hasComposer: true });

    // Import the actions
    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // submitPrompt should work fine without overlays
    // We can't fully test submitPrompt without a real browser, but we can
    // verify the overlay dismissal doesn't throw when no modals exist
    await expect(chatgptActions.isLoggedIn(page as never)).resolves.toBeDefined();
  });

  it('should attempt to dismiss onboarding modal selectors', async () => {
    const { page, onboardingBtn } = createMockPage({
      hasOnboardingModal: true,
      hasComposer: true,
    });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // isLoggedIn calls dismissOverlays internally
    const result = await chatgptActions.isLoggedIn(page as never);

    // Should have checked for overlay elements
    const selectorCalls = page.$.mock.calls.map((c: unknown[]) => c[0] as string);
    const overlayChecks = selectorCalls.filter(
      (s: string) => s.includes('modal-onboarding') || s.includes('dialog') || s.includes('Close'),
    );
    expect(overlayChecks.length).toBeGreaterThan(0);

    // The onboarding button should have been clicked
    if (onboardingBtn) {
      expect(onboardingBtn.click).toHaveBeenCalled();
    }

    expect(result).toBe(true);
  });

  it('should handle overlay dismissal errors gracefully', async () => {
    const page = {
      $: vi.fn(async () => {
        throw new Error('Element detached');
      }),
      waitForSelector: vi.fn(async () => ({
        click: vi.fn(),
        fill: vi.fn(),
      })),
      waitForTimeout: vi.fn(async () => {}),
      keyboard: { press: vi.fn() },
      evaluate: vi.fn(),
    };

    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // Should not throw even if page.$ throws
    const result = await chatgptActions.isLoggedIn(page as never);
    expect(result).toBe(false); // Can't find composer when $ throws
  });
});
