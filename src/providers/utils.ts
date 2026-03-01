import type { Page } from 'playwright';

/**
 * Fills the composer and clicks the send button.
 * Uses a JS evaluation fallback for `contenteditable` elements that reject standard Playwright `fill()`.
 */
export async function fillAndSubmitPrompt(
  page: Page,
  selectors: { composer: string; sendButton: string },
  prompt: string,
): Promise<void> {
  const composer = page.locator(selectors.composer).first();
  await composer.waitFor({ state: 'visible', timeout: 15_000 });

  await composer.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

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
      { sel: selectors.composer, text: prompt },
    );
  }

  await page.waitForTimeout(300);

  const sendButton = page.locator(selectors.sendButton).first();
  await sendButton.waitFor({ state: 'visible', timeout: 5_000 });
  await sendButton.click();
}
