import type { Page } from 'playwright';

/**
 * Shared prompt submission helper.
 *
 * All chat providers follow the same pattern:
 * 1. Wait for composer → click → select-all → delete
 * 2. Insert text via the right input path for the element type
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

  const isContentEditable = await composer
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      return element.isContentEditable || element.getAttribute('contenteditable') === 'true';
    })
    .catch(() => false);

  if (isContentEditable) {
    try {
      await page.keyboard.insertText(prompt);
    } catch {
      await composer.evaluate((element, text) => {
        if (!(element instanceof HTMLElement)) return;
        element.focus();
        element.innerText = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
  } else {
    try {
      await composer.fill(prompt);
    } catch {
      await composer.evaluate((element, text) => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          element.value = text;
        } else if (element instanceof HTMLElement) {
          element.innerText = text;
        } else {
          return;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }, prompt);
    }
  }

  await page.waitForTimeout(300);

  const sendButton = page.locator(sendButtonSelector).first();
  await sendButton.waitFor({ state: 'visible', timeout: sendTimeout });
  await sendButton.click();
}
