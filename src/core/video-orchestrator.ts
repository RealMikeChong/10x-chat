import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { launchBrowser } from '../browser/index.js';
import { loadConfig } from '../config.js';
import {
  configureVideoMode,
  FLOW_CONFIG,
  uploadKeyframes,
  waitForGeneration,
} from '../providers/flow.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { GeneratedVideo, ProviderName, VideoOptions } from '../types.js';

export interface VideoResult {
  sessionId: string;
  provider: ProviderName;
  message: string;
  videos: GeneratedVideo[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Execute a video generation interaction with Google Flow:
 * 1. Launch browser → navigate to Flow
 * 2. Click "New project"
 * 3. Configure video mode (model, orientation, count, sub-mode)
 * 4. If frames mode: upload Start/End keyframe images
 * 5. Enter prompt → click Create
 * 6. Poll for generation progress
 * 7. When complete: download video files
 * 8. Save session
 */
export async function runVideo(options: VideoOptions): Promise<VideoResult> {
  const config = await loadConfig();
  const providerName: ProviderName = 'flow';
  const provider = getProvider(providerName);
  const timeoutMs = options.timeoutMs ?? FLOW_CONFIG.defaultTimeoutMs;
  const headless = options.headed === true ? false : config.headless;

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, options.prompt);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${FLOW_CONFIG.displayName}`));
  console.log(chalk.dim(`Model: ${options.model ?? FLOW_CONFIG.defaultModel}`));
  console.log(chalk.dim(`Mode: ${options.mode ?? 'ingredients'}`));

  // Note: Flow always uses shared persistent profile for Google SPA auth

  // Launch browser — Flow needs a persistent browser context for Google SPA auth.
  // Use shared profile (default/) with persistent: true.
  let browser: Awaited<ReturnType<typeof launchBrowser>>;
  try {
    await updateSession(session.id, { status: 'running' });
    browser = await launchBrowser({
      provider: 'gemini',
      headless,
      url: FLOW_CONFIG.url,
      profileMode: 'shared',
      persistent: true,
    });
  } catch (error) {
    await updateSession(session.id, { status: 'failed' });
    throw error;
  }

  const startTime = Date.now();
  const page = browser.page;

  try {
    // ── Remove all blocking overlays from DOM ──
    await page.waitForTimeout(5000);

    const dismissOverlays = async () => {
      // Only remove cookie consent bar — nothing else
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('.glue-cookie-notification-bar'))) {
          el.remove();
        }
      });
      await page.waitForTimeout(500);
      // Click "Get started" on onboarding modal if visible
      const getStarted = page.locator('button:has-text("Get started")').first();
      if (await getStarted.isVisible({ timeout: 2000 }).catch(() => false)) {
        await getStarted.click({ force: true });
        console.log(chalk.dim('Dismissed onboarding modal'));
        // The modal dismiss often triggers a navigation — wait for the page
        // to fully settle before doing any page.evaluate() calls.
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(3000);
      }
    };

    await dismissOverlays();

    // ── Handle marketing page → studio navigation ──
    let isMarketingPage = false;
    try {
      isMarketingPage = await page.evaluate(() => {
        const body = document.body.textContent ?? '';
        return body.includes('Where the next wave') || body.includes('Scroll to Explore');
      });
    } catch {
      // Context may have been destroyed by a recent navigation — assume not marketing page
    }

    if (isMarketingPage) {
      console.log(chalk.dim('On marketing page, entering studio...'));
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll('a, button'))) {
          if (el.textContent?.includes('Create with Flow')) {
            (el as HTMLElement).click();
            return;
          }
        }
      });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(8000);
      await dismissOverlays();
    }

    // Step 3: Now we should be in the studio. Check if we need to create a new project.
    // Wait for SPA content to render (studio loads asynchronously)
    await page.waitForTimeout(5000);
    let currentUrl = page.url();
    console.log(chalk.dim(`Studio URL: ${currentUrl}`));

    const isProjectPage = currentUrl.includes('/project/');
    if (!isProjectPage) {
      console.log(chalk.dim('Creating new project...'));
      // Try JS click on "New project" since overlays may still intercept
      const clicked = await page.evaluate(() => {
        for (const btn of Array.from(document.querySelectorAll('button'))) {
          if (btn.textContent?.includes('New project') || btn.textContent?.includes('新建项目')) {
            (btn as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log(chalk.dim('Clicked New project, waiting for project to load...'));
        // Wait for URL to change to /project/
        try {
          await page.waitForURL('**/project/**', { timeout: 15_000 });
        } catch {
          await page.waitForTimeout(5000);
        }
      } else {
        console.log(chalk.dim('New project button not found in DOM'));
      }

      currentUrl = page.url();
      console.log(chalk.dim(`After new project: ${currentUrl}`));
    }

    // Configure video mode
    console.log(chalk.dim('Configuring video mode...'));
    await configureVideoMode(page, {
      mode: options.mode,
      model: options.model,
      orientation: options.orientation,
      count: options.count,
    });

    // Upload keyframes if in frames mode
    if (options.mode === 'frames' && (options.startFrame || options.endFrame)) {
      console.log(chalk.dim('Uploading keyframes...'));
      await uploadKeyframes(page, {
        startFrame: options.startFrame,
        endFrame: options.endFrame,
      });
    }

    // Enter prompt and submit
    console.log(chalk.dim('Submitting prompt...'));
    await provider.actions.submitPrompt(page, options.prompt);

    // Wait for generation
    console.log(chalk.dim('Generating video...'));
    let lastPct = -1;
    await waitForGeneration(page, {
      timeoutMs,
      onProgress: (pct) => {
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r${chalk.blue('▸')} Generating... ${chalk.bold(`${pct}%`)}`);
        }
      },
    });
    process.stdout.write('\n');

    const durationMs = Date.now() - startTime;
    const timedOut = durationMs >= timeoutMs;

    // Download generated videos
    const videos = await downloadVideos(page, session.id, options.saveDir);

    const savedVideos = videos.filter((v) => v.localPath);
    const count = savedVideos.length;
    const message =
      count > 0
        ? `Generated ${count} video(s) in ${Math.round(durationMs / 1000)}s`
        : timedOut
          ? 'Video generation timed out'
          : 'No videos detected';

    await saveResponse(session.id, message);
    await updateSession(session.id, {
      status: timedOut ? 'timeout' : count > 0 ? 'completed' : 'failed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      message,
      videos,
      truncated: timedOut,
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

/**
 * Download generated videos from the browser.
 * Finds <video> elements, fetches their src blobs via the browser context, and saves locally.
 * Handles both blob: URLs and regular HTTPS URLs.
 */
async function downloadVideos(
  page: import('playwright').Page,
  sessionId: string,
  saveDir?: string,
): Promise<GeneratedVideo[]> {
  const outputDir =
    saveDir ?? path.join(os.homedir(), '.10x-chat', 'sessions', sessionId, 'videos');
  await mkdir(outputDir, { recursive: true });

  // Get video source URLs from the page
  const videoSources = await page.evaluate(() => {
    const videos = document.querySelectorAll('video');
    const sources: string[] = [];
    for (const v of Array.from(videos)) {
      const src = v.src || v.querySelector('source')?.src || '';
      if (src) sources.push(src);
    }
    return sources;
  });

  if (videoSources.length === 0) {
    console.log(chalk.yellow('  No downloadable videos found on page.'));

    // Fallback: try to find download buttons and click them
    const downloadBtns = await page.locator('a[download], button:has-text("Download")').count();
    if (downloadBtns > 0) {
      console.log(chalk.dim(`  Found ${downloadBtns} download button(s), attempting click...`));
      const dlPromise = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
      await page.locator('a[download], button:has-text("Download")').first().click();
      const download = await dlPromise;
      if (download) {
        const filePath = path.join(outputDir, download.suggestedFilename() || 'video_1.mp4');
        await download.saveAs(filePath);
        console.log(chalk.green(`  ✓ Saved: ${filePath}`));
        return [{ localPath: filePath }];
      }
    }

    return [];
  }

  const results: GeneratedVideo[] = [];

  for (let i = 0; i < videoSources.length; i++) {
    const src = videoSources[i];
    try {
      let buf: Buffer | null = null;
      let contentType = '';

      if (src.startsWith('blob:')) {
        // For blob: URLs, use XMLHttpRequest inside the browser context
        const dataUrl = await page.evaluate(async (videoUrl: string) => {
          return new Promise<string | null>((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', videoUrl, true);
            xhr.responseType = 'blob';
            xhr.onload = () => {
              if (xhr.status === 200) {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.readAsDataURL(xhr.response);
              } else {
                resolve(null);
              }
            };
            xhr.onerror = () => resolve(null);
            xhr.send();
          });
        }, src);

        if (dataUrl) {
          const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentType = match[1];
            buf = Buffer.from(match[2], 'base64');
          }
        }
      } else {
        // HTTPS URLs (including tRPC redirects) — fetch server-side with cookies
        const context = page.context();
        const cookies = await context.cookies([src]).catch(() => []);
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

        const resp = await fetch(src, {
          headers: cookieHeader ? { cookie: cookieHeader } : undefined,
          redirect: 'follow',
        }).catch(() => null);

        if (resp?.ok) {
          buf = Buffer.from(await resp.arrayBuffer());
          contentType = resp.headers.get('content-type') ?? '';
        } else {
          // Fallback: try in-browser fetch
          const dataUrl = await page.evaluate(async (videoUrl: string) => {
            try {
              const r = await fetch(videoUrl, { credentials: 'include', redirect: 'follow' });
              if (!r.ok) return null;
              const blob = await r.blob();
              return new Promise<string | null>((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.readAsDataURL(blob);
              });
            } catch {
              return null;
            }
          }, src);

          if (dataUrl) {
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              contentType = match[1];
              buf = Buffer.from(match[2], 'base64');
            }
          }
        }
      }

      if (!buf) {
        console.warn(
          chalk.yellow(`  ⚠ Failed to download video ${i + 1} (src: ${src.slice(0, 80)})`),
        );
        results.push({});
        continue;
      }

      const ext = contentType.includes('mp4')
        ? 'mp4'
        : contentType.includes('webm')
          ? 'webm'
          : 'mp4';
      const filename = `video_${i + 1}.${ext}`;
      const filePath = path.join(outputDir, filename);

      await writeFile(filePath, buf);
      console.log(chalk.green(`  ✓ Saved: ${filePath}`));
      results.push({ localPath: filePath });
    } catch (err) {
      console.warn(chalk.yellow(`  ⚠ Error downloading video ${i + 1}: ${err}`));
      results.push({});
    }
  }

  return results;
}
