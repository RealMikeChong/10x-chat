import chalk from 'chalk';
import type { Page } from 'playwright';
import { launchBrowser } from '../browser/index.js';
import { resolveHeadlessMode } from '../browser/mode.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { GeneratedImage, ImageGenOptions, ImageGenResult, ProviderName } from '../types.js';
import { downloadImages } from './images.js';

/**
 * Provider-specific image generation polling config.
 */
interface ImageGenProviderConfig {
  /** Check if image generation is still in progress. */
  isGenerating: (page: Page) => Promise<boolean>;
  /** Extract generated images from the page. */
  extractImages: (page: Page) => Promise<GeneratedImage[]>;
  /** Extract any text response alongside the images. */
  extractText: (page: Page) => Promise<string>;
}

const chatgptImageGen: ImageGenProviderConfig = {
  async isGenerating(page: Page) {
    // ChatGPT shows a stop button while DALL-E is generating
    const stopBtn = await page
      .locator('button[aria-label="Stop streaming"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stopBtn) return true;

    // Also check for "Creating image..." text in the last assistant turn
    const lastTurn = page.locator('[data-message-author-role="assistant"]').last();
    const text = (await lastTurn.textContent().catch(() => ''))?.toLowerCase() ?? '';
    return text.includes('creating') || text.includes('generating');
  },

  async extractImages(page: Page) {
    return page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      // DALL-E / GPT-Image: alt starts with "Generated image" and src uses
      // backend-api/estuary/content with file IDs
      const imgs = Array.from(
        document.querySelectorAll('img[alt^="Generated image"], img[src*="estuary/content"]'),
      );
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        const alt = img.getAttribute('alt') ?? '';
        const w = (img as HTMLImageElement).naturalWidth;
        const h = (img as HTMLImageElement).naturalHeight;
        if (w > 0 && w < 128 && h > 0 && h < 128) continue;
        if (alt === 'Profile image') continue;
        const idMatch = src.match(/[?&]id=([^&]+)/);
        const key = idMatch ? idMatch[1] : src;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        results.push({ url: src, alt, width: w, height: h });
      }
      return results;
    });
  },

  async extractText(page: Page) {
    const lastTurn = page.locator('[data-message-author-role="assistant"]').last();
    return (await lastTurn.textContent().catch(() => ''))?.trim() ?? '';
  },
};

const geminiImageGen: ImageGenProviderConfig = {
  async isGenerating(page: Page) {
    // Check for Gemini image generation indicators
    const indicators = [
      'button[aria-label="Stop generating"]',
      'button[aria-label="Cancel"]',
      '.image-generation-loading',
      '.loading-indicator',
      'model-response [class*="loading"]',
      'model-response [class*="progress"]',
    ];
    for (const sel of indicators) {
      const visible = await page
        .locator(sel)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) return true;
    }

    // Check for "Loading Nano Banana" or "Generating image" text
    const lastTurn = page
      .locator('model-response .model-response-text, model-response message-content')
      .last();
    const text = (await lastTurn.textContent().catch(() => ''))?.toLowerCase() ?? '';
    return (
      text.includes('loading nano banana') ||
      text.includes('generating image') ||
      text.includes('creating image') ||
      text.includes('loading imagen')
    );
  },

  async extractImages(page: Page) {
    return page.evaluate(() => {
      const seen = new Set<string>();
      const results: { url: string; alt: string; width: number; height: number }[] = [];
      const selectors = [
        'img.image.loaded',
        'img[alt*="AI generated"]',
        'img[alt*="Generated"]',
        'model-response img[src*="lh3.googleusercontent.com"]',
        'model-response img[src*="encrypted"]',
      ];
      const imgs = Array.from(document.querySelectorAll(selectors.join(', ')));
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (!src || seen.has(src)) continue;
        const w = (img as HTMLImageElement).naturalWidth;
        const h = (img as HTMLImageElement).naturalHeight;
        if (w > 0 && w < 64 && h > 0 && h < 64) continue;
        seen.add(src);
        const fullSizeUrl = src.includes('=s') ? src : `${src}=s1024-rj`;
        results.push({
          url: fullSizeUrl,
          alt: img.getAttribute('alt') ?? '',
          width: w,
          height: h,
        });
      }
      return results;
    });
  },

  async extractText(page: Page) {
    const lastTurn = page
      .locator('model-response .model-response-text, model-response message-content')
      .last();
    return (await lastTurn.textContent().catch(() => ''))?.trim() ?? '';
  },
};

const IMAGE_GEN_CONFIGS: Partial<Record<ProviderName, ImageGenProviderConfig>> = {
  chatgpt: chatgptImageGen,
  gemini: geminiImageGen,
};

/**
 * Run image generation:
 * 1. Launch browser → navigate to provider
 * 2. Submit the image prompt
 * 3. Poll for generation progress (non-blocking)
 * 4. Extract and download generated images
 */
export async function runImageGen(options: ImageGenOptions): Promise<ImageGenResult> {
  const config = await loadConfig();
  const providerName = options.provider ?? 'chatgpt';
  const provider = getProvider(providerName);
  const imageGenConfig = IMAGE_GEN_CONFIGS[providerName];

  if (!imageGenConfig) {
    throw new Error(
      `Provider "${providerName}" does not support image generation. Use: chatgpt, gemini`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 120_000;
  const headless = resolveHeadlessMode(providerName, config.headless, options.headed === true);
  const profileMode = options.isolatedProfile ? 'isolated' : config.profileMode;

  const session = await createSession(providerName, options.prompt);
  await saveBundle(session.id, options.prompt);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));
  console.log(chalk.dim(`Timeout: ${Math.round(timeoutMs / 1000)}s\n`));

  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: providerName,
      headless,
      url: provider.config.url,
      profileMode,
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }

  const startTime = Date.now();

  try {
    // Check login
    const loggedIn = await provider.actions.isLoggedIn(browser.page);
    if (!loggedIn) {
      throw new Error(
        `Not logged in to ${provider.config.displayName}. Run: 10x-chat login ${providerName}`,
      );
    }

    // Submit the image generation prompt
    console.log(chalk.dim('Submitting image prompt...'));
    await provider.actions.submitPrompt(browser.page, options.prompt);

    // Poll for image generation with progress updates
    console.log(chalk.dim('Generating image(s)...\n'));
    const pollInterval = 3_000;
    let lastLogTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const generating = await imageGenConfig.isGenerating(browser.page);

      // Log periodic progress
      if (Date.now() - lastLogTime > 10_000) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(chalk.dim(`  [${elapsed}s] Still generating...`));
        lastLogTime = Date.now();
      }

      if (!generating) {
        // Double-check: wait one more interval to be sure
        await browser.page.waitForTimeout(pollInterval);
        const stillGenerating = await imageGenConfig.isGenerating(browser.page);
        if (!stillGenerating) break;
      }

      await browser.page.waitForTimeout(pollInterval);
    }

    // Wait for images to fully load
    await browser.page.waitForTimeout(2_000);

    // Extract images
    const images = await imageGenConfig.extractImages(browser.page);
    const text = await imageGenConfig.extractText(browser.page);

    console.log(chalk.green(`\n✓ Found ${images.length} image(s)`));

    // Download images
    let savedImages = images;
    if (images.length > 0) {
      console.log(chalk.dim('Downloading images...'));
      savedImages = await downloadImages(browser.page, images, session.id, options.saveDir);
    }

    const durationMs = Date.now() - startTime;
    const truncated = durationMs >= timeoutMs;

    await saveResponse(session.id, text);
    await updateSession(session.id, {
      status: truncated ? 'timeout' : 'completed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      images: savedImages,
      text,
      truncated,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error instanceof Error && error.message.toLowerCase().includes('timeout');
    await updateSession(session.id, {
      status: isTimeout ? 'timeout' : 'failed',
      durationMs,
    });
    throw error;
  } finally {
    await browser.close();
  }
}
