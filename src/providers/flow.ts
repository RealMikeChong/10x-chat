import type { Page } from 'playwright';
import type { CapturedResponse, ProviderActions, ProviderConfig, VideoModel } from '../types.js';

export const FLOW_CONFIG: ProviderConfig = {
  name: 'flow',
  displayName: 'Google Flow',
  url: 'https://labs.google/fx/tools/flow',
  loginUrl: 'https://labs.google/fx/tools/flow',
  models: [
    'Veo 3.1 - Fast',
    'Veo 3.1 - Fast [Lower Priority]',
    'Veo 3.1 - Quality',
    'Veo 2 - Fast',
    'Veo 2 - Quality',
  ],
  defaultModel: 'Veo 3.1 - Fast',
  defaultTimeoutMs: 10 * 60 * 1000, // 10 mins — video gen is slow
};

export const FLOW_SELECTORS = {
  // Navigation
  newProject: 'button:has-text("New project")',
  goBack: 'button:has-text("Go Back")',

  // Prompt composer
  composer: 'div[contenteditable="true"]',
  composerTextbox: '[role="textbox"]',

  // Submit
  createButton: 'button:has-text("arrow_forward")',

  // Model selector popup — open by clicking the pill button
  modelPill: '.sc-46973129-1', // the model pill component class

  // Output type tabs (role="tab")
  imageTab: 'button[role="tab"]:has-text("Image")',
  videoTab: 'button[role="tab"]:has-text("Video")',

  // Video sub-mode tabs
  ingredientsTab: 'button[role="tab"]:has-text("Ingredients")',
  framesTab: 'button[role="tab"]:has-text("Frames")',

  // Orientation
  landscapeBtn: 'button:has-text("Landscape")',
  portraitBtn: 'button:has-text("Portrait")',

  // Count
  countX1: 'button[role="tab"]:has-text("x1")',
  countX2: 'button[role="tab"]:has-text("x2")',
  countX3: 'button[role="tab"]:has-text("x3")',
  countX4: 'button[role="tab"]:has-text("x4")',

  // Model dropdown (within popup)
  modelDropdown: 'button:has-text("arrow_drop_down")',

  // Frame inputs (Frames mode)
  startFrame: 'text="Start"',
  endFrame: 'text="End"',

  // Media upload
  addMedia: 'button:has-text("Add Media")',
  uploadImage: '[role="menuitem"]:has-text("Upload image")',
  fileInput: 'input[type="file"][accept="image/*"]',

  // Cookie
  cookieAgree: 'button:has-text("Agree")',

  // Scenebuilder
  scenebuilder: 'button:has-text("Scenebuilder")',
} as const;

/**
 * Open the model selector popup by clicking the pill button in the bottom bar.
 */
async function openModelSelector(page: Page): Promise<void> {
  // The model pill displays current mode info (e.g. "🍌 Nano Banana", "Video 📺 x2")
  const pill = page.locator(FLOW_SELECTORS.modelPill).first();
  if (await pill.isVisible().catch(() => false)) {
    await pill.click();
    await page.waitForTimeout(1000);
    return;
  }
  // Fallback: try clicking any button that contains the current model info
  const fallback = page
    .locator('button:has-text("Nano Banana"), button:has-text("Video"), button:has-text("Veo")')
    .first();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.click();
    await page.waitForTimeout(1000);
  }
}

/**
 * Configure the model selector for video generation.
 */
export async function configureVideoMode(
  page: Page,
  opts: {
    mode?: 'ingredients' | 'frames';
    model?: VideoModel;
    orientation?: 'landscape' | 'portrait';
    count?: 1 | 2 | 3 | 4;
  },
): Promise<void> {
  await openModelSelector(page);

  // All clicks inside the popup need { force: true } because Flow's
  // overlay/backdrop (<html>) intercepts pointer events.

  // 1. Switch to Video tab (Flow defaults to Image — this is critical)
  const videoTab = page.locator(FLOW_SELECTORS.videoTab).first();
  try {
    await videoTab.waitFor({ state: 'visible', timeout: 5_000 });
    await videoTab.click({ force: true });
    await page.waitForTimeout(800);
  } catch {
    // Popup may not have opened — retry
    await openModelSelector(page);
    const retry = page.locator(FLOW_SELECTORS.videoTab).first();
    if (await retry.isVisible().catch(() => false)) {
      await retry.click({ force: true });
      await page.waitForTimeout(800);
    } else {
      console.warn('⚠ Could not find Video tab — generation may default to Image mode');
    }
  }

  // 2. Select sub-mode (Ingredients or Frames)
  const mode = opts.mode ?? 'ingredients';
  const modeTab =
    mode === 'frames'
      ? page.locator(FLOW_SELECTORS.framesTab).first()
      : page.locator(FLOW_SELECTORS.ingredientsTab).first();
  if (await modeTab.isVisible().catch(() => false)) {
    await modeTab.click({ force: true });
    await page.waitForTimeout(500);
  }

  // 3. Set orientation
  const orientation = opts.orientation ?? 'landscape';
  const orientBtn =
    orientation === 'portrait'
      ? page.locator(FLOW_SELECTORS.portraitBtn).first()
      : page.locator(FLOW_SELECTORS.landscapeBtn).first();
  if (await orientBtn.isVisible().catch(() => false)) {
    await orientBtn.click({ force: true });
    await page.waitForTimeout(300);
  }

  // 4. Set count
  const count = opts.count ?? 1;
  const countSel = {
    1: FLOW_SELECTORS.countX1,
    2: FLOW_SELECTORS.countX2,
    3: FLOW_SELECTORS.countX3,
    4: FLOW_SELECTORS.countX4,
  }[count];
  const countBtn = page.locator(countSel).first();
  if (await countBtn.isVisible().catch(() => false)) {
    await countBtn.click({ force: true });
    await page.waitForTimeout(300);
  }

  // 5. Select model only if non-default (avoids problematic dropdown click)
  if (opts.model && opts.model !== 'Veo 3.1 - Fast') {
    const modelDropdown = page.locator(FLOW_SELECTORS.modelDropdown).last();
    if (await modelDropdown.isVisible().catch(() => false)) {
      await modelDropdown.click({ force: true });
      await page.waitForTimeout(1000);

      const modelOption = page.locator(`text="${opts.model}"`).first();
      if (await modelOption.isVisible().catch(() => false)) {
        await modelOption.click({ force: true });
        await page.waitForTimeout(500);
      }
    }
  }

  // Close popup by pressing Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Upload keyframe images in Frames mode.
 */
export async function uploadKeyframes(
  page: Page,
  opts: { startFrame?: string; endFrame?: string },
): Promise<void> {
  if (opts.startFrame) {
    const startBox = page.locator(FLOW_SELECTORS.startFrame).first();
    if (await startBox.isVisible().catch(() => false)) {
      await startBox.click();
      await page.waitForTimeout(500);
      // The file input should become available
      const fileInput = page.locator(FLOW_SELECTORS.fileInput).first();
      await fileInput.setInputFiles(opts.startFrame);
      await page.waitForTimeout(2000);
    }
  }

  if (opts.endFrame) {
    const endBox = page.locator(FLOW_SELECTORS.endFrame).first();
    if (await endBox.isVisible().catch(() => false)) {
      await endBox.click();
      await page.waitForTimeout(500);
      const fileInput = page.locator(FLOW_SELECTORS.fileInput).first();
      await fileInput.setInputFiles(opts.endFrame);
      await page.waitForTimeout(2000);
    }
  }
}

/**
 * Poll for video generation progress. Returns when all tiles show completion
 * or when the timeout is reached.
 */
export async function waitForGeneration(
  page: Page,
  opts: { timeoutMs: number; onProgress?: (pct: number) => void },
): Promise<void> {
  const { timeoutMs, onProgress } = opts;
  const start = Date.now();
  const POLL_INTERVAL = 3000;

  while (Date.now() - start < timeoutMs) {
    // Check for progress percentages in tiles
    const progress = await page.evaluate(() => {
      const tiles = document.querySelectorAll('[class*="tile"], [class*="card"], [class*="media"]');
      const percents: number[] = [];
      for (const tile of Array.from(tiles)) {
        const text = tile.textContent ?? '';
        const match = text.match(/(\d+)%/);
        if (match) percents.push(Number.parseInt(match[1], 10));
      }
      // Also check for video elements (generation complete)
      const videos = document.querySelectorAll('video');
      if (videos.length > 0) return { done: true, percent: 100, videoCount: videos.length };
      if (percents.length === 0) return { done: false, percent: 0, videoCount: 0 };
      const avg = Math.round(percents.reduce((a, b) => a + b, 0) / percents.length);
      return { done: avg >= 100, percent: avg, videoCount: 0 };
    });

    if (onProgress) onProgress(progress.percent);

    if (progress.done || progress.videoCount > 0) {
      // Wait a bit more for the UI to settle
      await page.waitForTimeout(2000);
      return;
    }

    await page.waitForTimeout(POLL_INTERVAL);
  }
}

export const flowActions: ProviderActions = {
  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // Wait for the studio to load
      await page.waitForTimeout(3000);

      // Flow requires Google account — check for profile avatar or ULTRA badge
      const hasProfile = await page.evaluate(() => {
        const body = document.body.textContent ?? '';
        // If we see "New project" or "Create", we're logged in
        return body.includes('New project') || body.includes('Create a project');
      });
      return hasProfile;
    } catch {
      return false;
    }
  },

  async submitPrompt(page: Page, prompt: string): Promise<void> {
    // Find the composer
    const composer = page.locator(FLOW_SELECTORS.composer).first();
    await composer.waitFor({ state: 'visible', timeout: 10_000 });
    await composer.click();
    await page.waitForTimeout(300);

    // Clear any existing text and type the prompt
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');

    try {
      await composer.fill(prompt);
    } catch {
      await page.keyboard.type(prompt, { delay: 15 });
    }

    await page.waitForTimeout(300);

    // Click the → Create button (last arrow_forward button)
    const createBtn = page.locator(FLOW_SELECTORS.createButton).last();
    await createBtn.waitFor({ state: 'visible', timeout: 5_000 });
    await createBtn.click();
  },

  async captureResponse(
    page: Page,
    opts: { timeoutMs: number; onChunk?: (chunk: string) => void },
  ): Promise<CapturedResponse> {
    const { timeoutMs, onChunk } = opts;
    const startTime = Date.now();

    // Wait for generation to complete
    await waitForGeneration(page, {
      timeoutMs,
      onProgress: (pct) => {
        if (onChunk) onChunk(`\rGenerating... ${pct}%`);
      },
    });

    const elapsed = Date.now() - startTime;
    const timedOut = elapsed >= timeoutMs;

    // Extract video info from the page
    const videoInfo = await page.evaluate(() => {
      const videos = document.querySelectorAll('video');
      const results: string[] = [];
      for (const v of Array.from(videos)) {
        results.push(v.src || v.querySelector('source')?.src || '');
      }
      return { count: videos.length, urls: results.filter(Boolean) };
    });

    const text =
      videoInfo.count > 0
        ? `Generated ${videoInfo.count} video(s) successfully.`
        : timedOut
          ? 'Video generation timed out.'
          : 'Video generation status unknown.';

    return {
      text,
      markdown: text,
      truncated: timedOut,
      thinkingTime: Math.round(elapsed / 1000),
    };
  },
};
