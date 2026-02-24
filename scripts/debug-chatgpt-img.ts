import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const profileDir = path.join(os.homedir(), '.10x-chat', 'profiles', 'chatgpt');

(async () => {
  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });

  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto('https://chatgpt.com');
  await page.waitForTimeout(4000);

  const initialUrl = page.url();
  console.log(`Initial URL: ${initialUrl}`);

  // Submit prompt
  const composer = await page.waitForSelector(
    '#prompt-textarea, div.ProseMirror[contenteditable="true"]',
    { timeout: 10000 },
  );
  await composer.click();
  await composer.fill('Generate a simple picture of a cat');
  await page.waitForTimeout(300);
  const btn = await page.waitForSelector(
    '#composer-submit-button, button[aria-label="Send prompt"]',
    { timeout: 5000 },
  );
  await btn.click();
  console.log('Prompt submitted');

  // Poll for 2 minutes, logging state every 3 seconds
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(3000);
    const url = page.url();
    const turnCount = await page.locator('[data-message-author-role="assistant"]').count();
    const hasImages = await page.evaluate(
      () => document.querySelectorAll('img[alt="Generated image"]').length,
    );
    const lastTurnText =
      turnCount > 0
        ? (
            await page
              .locator('[data-message-author-role="assistant"]')
              .last()
              .textContent({ timeout: 3000 })
              .catch(() => '(error)')
          )
            ?.trim()
            .slice(0, 60)
        : '(no turns)';
    console.log(
      `[${(i + 1) * 3}s] url_changed=${url !== initialUrl} turns=${turnCount} imgs=${hasImages} text="${lastTurnText}"`,
    );

    if (
      turnCount > 0 &&
      hasImages > 0 &&
      lastTurnText &&
      lastTurnText.length > 0 &&
      lastTurnText !== '(error)'
    ) {
      console.log('✓ Response with images detected!');
      break;
    }
  }

  // Final image extraction
  const images = await page.evaluate(() => {
    const seen = new Set<string>();
    return Array.from(document.querySelectorAll('img[alt="Generated image"]'))
      .filter((img) => {
        const s = img.getAttribute('src') ?? '';
        const m = s.match(/id=([^&]+)/);
        const k = m?.[1] ?? s;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((img) => ({
        src: (img.getAttribute('src') ?? '').slice(0, 120),
        w: (img as HTMLImageElement).naturalWidth,
      }));
  });
  console.log(`\nFinal images: ${JSON.stringify(images, null, 2)}`);

  await browser.close();
})();
