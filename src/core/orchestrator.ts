import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { launchBrowser } from '../browser/index.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../providers/index.js';
import { createSession, saveBundle, saveResponse, updateSession } from '../session/index.js';
import type { ChatOptions, GeneratedImage, ProviderName } from '../types.js';
import { buildBundle } from './bundle.js';

/** Providers supported by chat --all (excludes special-purpose providers). */
const CHAT_PROVIDERS: ProviderName[] = ['chatgpt', 'gemini', 'claude', 'grok'];

export interface ChatResult {
  sessionId: string;
  provider: ProviderName;
  response: string;
  truncated: boolean;
  durationMs: number;
  /** Images generated in the response (with local paths if saved). */
  images?: GeneratedImage[];
}

/**
 * Execute a chat interaction with a provider:
 * 1. Build the prompt bundle
 * 2. Launch the browser
 * 3. Attach files (if any)
 * 4. Submit the prompt
 * 5. Capture the response
 * 6. Save session
 */
export async function runChat(options: ChatOptions): Promise<ChatResult> {
  const config = await loadConfig();
  const providerName = options.provider ?? config.defaultProvider;
  const provider = getProvider(providerName);
  const timeoutMs = options.timeoutMs ?? config.defaultTimeoutMs;
  const headless = options.headed === true ? false : config.headless;

  // Build the bundle
  const bundle = await buildBundle({
    prompt: options.prompt,
    files: options.file,
  });

  // Create session
  const session = await createSession(providerName, options.prompt, options.model);
  await saveBundle(session.id, bundle);

  console.log(chalk.dim(`Session: ${session.id}`));
  console.log(chalk.blue(`Provider: ${provider.config.displayName}`));

  // Determine profile mode: CLI flag overrides config
  const profileMode = options.isolatedProfile ? 'isolated' : config.profileMode;

  // Launch browser — if this fails, mark session as failed
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

    // Submit prompt
    console.log(chalk.dim('Submitting prompt...'));

    // Attach files if provided
    if (options.attach && options.attach.length > 0) {
      if (!provider.actions.attachFiles) {
        console.warn(
          chalk.yellow(
            `⚠ Provider '${providerName}' does not support file attachments. --attach will be ignored.`,
          ),
        );
      } else {
        const resolvedPaths = await resolveAttachPaths(options.attach);
        if (resolvedPaths.length > 0) {
          console.log(chalk.dim(`Attaching ${resolvedPaths.length} file(s)...`));
          await provider.actions.attachFiles(browser.page, resolvedPaths);
        }
      }
    }

    await provider.actions.submitPrompt(browser.page, bundle);

    // Capture response
    console.log(chalk.dim('Waiting for response...'));
    const captured = await provider.actions.captureResponse(browser.page, {
      timeoutMs,
      onChunk: (chunk) => process.stdout.write(chalk.dim(chunk)),
    });

    const durationMs = Date.now() - startTime;

    // Save response
    await saveResponse(session.id, captured.text);

    // Download generated images if any
    let savedImages: GeneratedImage[] | undefined;
    if (captured.images && captured.images.length > 0) {
      console.log(chalk.dim(`Found ${captured.images.length} generated image(s), downloading...`));
      savedImages = await downloadImages(
        browser.page,
        captured.images,
        session.id,
        options.saveImages,
      );
    }

    await updateSession(session.id, {
      status: captured.truncated ? 'timeout' : 'completed',
      durationMs,
    });

    return {
      sessionId: session.id,
      provider: providerName,
      response: captured.text,
      truncated: captured.truncated,
      durationMs,
      ...(savedImages && savedImages.length > 0 ? { images: savedImages } : {}),
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    // Distinguish timeout from other failures
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

export interface ChatAllResult {
  provider: ProviderName;
  result?: ChatResult;
  error?: string;
}

/**
 * Run the same prompt against multiple providers in parallel.
 * Uses the shared browser daemon — all providers reuse one Chromium process.
 */
export async function runChatAll(options: ChatOptions): Promise<ChatAllResult[]> {
  const targets = options.providers ?? CHAT_PROVIDERS;

  console.log(chalk.bold.blue(`\n🚀 Sending to ${targets.length} providers in parallel...\n`));

  const tasks = targets.map(async (provider): Promise<ChatAllResult> => {
    try {
      const result = await runChat({ ...options, provider });
      return { provider, result };
    } catch (error) {
      return {
        provider,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return Promise.allSettled(tasks).then((settled) =>
    settled.map((s) =>
      s.status === 'fulfilled' ? s.value : { provider: 'chatgpt', error: String(s.reason) },
    ),
  );
}

/**
 * Download generated images from the browser context (uses session cookies).
 * Saves to --save-images dir or ~/.10x-chat/sessions/<id>/images/.
 */
async function downloadImages(
  page: import('playwright').Page,
  images: GeneratedImage[],
  sessionId: string,
  saveDir?: string,
): Promise<GeneratedImage[]> {
  const homedir = (await import('node:os')).homedir();
  const outputDir = saveDir ?? path.join(homedir, '.10x-chat', 'sessions', sessionId, 'images');
  await mkdir(outputDir, { recursive: true });

  const results: GeneratedImage[] = [];
  const context = page.context();

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    try {
      const url = img.url;
      const cookies = await context.cookies([url]).catch(() => []);
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

      let buf: Buffer;
      let contentType = '';

      // Try Node fetch with cookies first
      const resp = await fetch(url, {
        headers: cookieHeader ? { cookie: cookieHeader } : undefined,
      }).catch(() => null);

      if (resp?.ok) {
        buf = Buffer.from(await resp.arrayBuffer());
        contentType = resp.headers.get('content-type') ?? '';
      } else {
        // Fallback: fetch via browser context (handles auth cookies + CORS)
        const dataUrl = await page.evaluate(async (imgUrl: string) => {
          try {
            const r = await fetch(imgUrl, { credentials: 'include' });
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
        }, url);

        if (!dataUrl) {
          console.warn(
            chalk.yellow(`  ⚠ Failed to download image ${i + 1}: HTTP ${resp?.status ?? 'N/A'}`),
          );
          results.push(img);
          continue;
        }

        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          results.push(img);
          continue;
        }
        contentType = match[1];
        buf = Buffer.from(match[2], 'base64');
      }
      const ext = contentType.includes('png')
        ? 'png'
        : contentType.includes('webp')
          ? 'webp'
          : 'jpg';

      const filename = `image_${i + 1}.${ext}`;
      const filePath = path.join(outputDir, filename);

      await writeFile(filePath, buf);
      console.log(chalk.green(`  ✓ Saved: ${filePath}`));
      results.push({ ...img, localPath: filePath });
    } catch (err) {
      console.warn(chalk.yellow(`  ⚠ Error downloading image ${i + 1}: ${err}`));
      results.push(img);
    }
  }

  return results;
}

/**
 * Resolve --attach paths (supports globs) to absolute file paths.
 * Validates that all resolved paths exist and are files.
 */
async function resolveAttachPaths(patterns: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const pattern of patterns) {
    // Check if it's a glob or a literal path
    if (/[*?{}[\]]/.test(pattern)) {
      const matches = await fg(pattern, { absolute: true, onlyFiles: true });
      if (matches.length === 0) {
        throw new Error(`No files matched attachment pattern: ${pattern}`);
      }
      resolved.push(...matches);
    } else {
      const abs = path.resolve(pattern);
      try {
        const s = await stat(abs);
        if (s.isFile()) {
          resolved.push(abs);
        } else {
          console.warn(chalk.yellow(`Skipping directory: ${pattern}`));
        }
      } catch {
        throw new Error(`Attachment not found: ${pattern}`);
      }
    }
  }

  // Deduplicate in case overlapping globs resolved the same file
  return [...new Set(resolved)];
}
