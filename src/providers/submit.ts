import type { Page } from 'playwright';

/**
 * Shared prompt submission helper.
 *
 * All chat providers follow the same pattern:
 * 1. Wait for composer → click → select-all → delete
 * 2. Try fill(), fallback to JS innerText injection
 * 3. Wait → click send button
 *
 * This helper encapsulates that pattern so each provider only needs
 * to specify its selectors.
 */
export async function submitPromptToComposer(
  page: Page,
  prompt: string,
  opts: {
    composerSelector: string;
    sendButtonSelector: string;
    composerTimeout?: number;
    sendTimeout?: number;
  },
): Promise<void> {
  const {
    composerSelector,
    sendButtonSelector,
    composerTimeout = 15_000,
    sendTimeout = 5_000,
  } = opts;

  const composer = page.locator(composerSelector).first();
  await composer.waitFor({ state: 'visible', timeout: composerTimeout });

  await composer.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  // Use fill() for speed; fall back to JS injection for contenteditable elements
  try {
    await composer.fill(prompt);
  } catch {
    await page.evaluate(
      ({ sel, text }) => {
        const el = document.querySelector(sel);
        if (el) {
          (el as HTMLElement).innerText = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      },
      { sel: composerSelector, text: prompt },
    );
  }

  await page.waitForTimeout(300);

  const sendButton = page.locator(sendButtonSelector).first();
  await sendButton.waitFor({ state: 'visible', timeout: sendTimeout });
  await sendButton.click();
}
