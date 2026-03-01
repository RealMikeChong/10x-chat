import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { Page } from 'playwright';
import type { GeneratedImage } from '../types.js';

/**
 * Download generated images from the browser context (uses session cookies).
 * Saves to --save-images dir or ~/.10x-chat/sessions/<id>/images/.
 */
export async function downloadImages(
  page: Page,
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
