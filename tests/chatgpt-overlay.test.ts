import { describe, expect, it, vi } from 'vitest';

/**
 * Tests for ChatGPT overlay/modal dismissal behavior.
 * Uses a lightweight Page mock since Playwright's real Page requires a browser.
 */

// Minimal mock that simulates a Page with locator API
function createMockPage(options: { hasOnboardingModal?: boolean; hasComposer?: boolean } = {}) {
  const { hasOnboardingModal = false, hasComposer = true } = options;
  const locatorCalls: string[] = [];
  const clickedSelectors: string[] = [];

  const mockLocator = (selector: string) => {
    locatorCalls.push(selector);
    const isOverlay = selector.includes('modal-onboarding') ||
      selector.includes('dialog') || selector.includes('Close') ||
      selector.includes('Decline') || selector.includes('Accept') ||
      selector.includes('Stay logged out') || selector.includes('onboarding');
    const isComposer = selector.includes('composer') || selector.includes('ProseMirror') ||
      selector.includes('prompt-textarea') || selector.includes('textbox');
    const isLogin = selector.includes('Log in') || selector.includes('Sign up');

    const visible = hasOnboardingModal && isOverlay
      ? true
      : hasComposer && isComposer
        ? true
        : false;

    const locator = {
      first: () => locator,
      last: () => locator,
      isVisible: vi.fn(async () => visible),
      waitFor: vi.fn(async () => { }),
      click: vi.fn(async () => {
        if (visible) clickedSelectors.push(selector);
      }),
      fill: vi.fn(async () => { }),
      count: vi.fn(async () => 0),
      textContent: vi.fn(async () => ''),
      innerHTML: vi.fn(async () => ''),
      nth: (_n: number) => locator,
    };
    return locator;
  };

  return {
    page: {
      locator: vi.fn((selector: string) => mockLocator(selector)),
      waitForTimeout: vi.fn(async () => { }),
      waitForLoadState: vi.fn(async () => { }),
      keyboard: {
        press: vi.fn(async () => { }),
      },
      evaluate: vi.fn(async () => { }),
      url: vi.fn(() => 'https://chatgpt.com'),
    },
    locatorCalls,
    clickedSelectors,
  };
}

describe('ChatGPT Overlay Dismissal', () => {
  it('should not crash when no overlays are present', async () => {
    const { page } = createMockPage({ hasOnboardingModal: false, hasComposer: true });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // isLoggedIn should work fine without overlays — composer found, no login buttons
    await expect(chatgptActions.isLoggedIn(page as never)).resolves.toBeDefined();
  });

  it('should attempt to dismiss onboarding modal selectors', async () => {
    const { page, locatorCalls, clickedSelectors } = createMockPage({
      hasOnboardingModal: true,
      hasComposer: true,
    });

    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // isLoggedIn calls dismissOverlays internally
    const result = await chatgptActions.isLoggedIn(page as never);

    // Should have called locator for overlay-related selectors
    const overlayChecks = locatorCalls.filter(
      (s: string) => s.includes('modal-onboarding') || s.includes('dialog') || s.includes('Close'),
    );
    expect(overlayChecks.length).toBeGreaterThan(0);

    // Overlay buttons should have been clicked
    expect(clickedSelectors.length).toBeGreaterThan(0);

    expect(result).toBe(true);
  });

  it('should handle overlay dismissal errors gracefully', async () => {
    const page = {
      locator: vi.fn(() => ({
        first: vi.fn().mockReturnThis(),
        last: vi.fn().mockReturnThis(),
        isVisible: vi.fn(async () => { throw new Error('Element detached'); }),
        waitFor: vi.fn(async () => { throw new Error('Element detached'); }),
        click: vi.fn(),
        count: vi.fn(async () => 0),
      })),
      waitForTimeout: vi.fn(async () => { }),
      waitForLoadState: vi.fn(async () => { }),
      keyboard: { press: vi.fn() },
      evaluate: vi.fn(),
      url: vi.fn(() => 'https://chatgpt.com'),
    };

    const { chatgptActions } = await import('../src/providers/chatgpt.js');

    // Should not throw even if locator methods throw
    const result = await chatgptActions.isLoggedIn(page as never);
    expect(result).toBe(false); // Can't find composer when locator throws
  });
});
