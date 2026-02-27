import type { Page } from 'playwright';

/**
 * Options for the pollUntilStable utility.
 */
export interface PollOptions {
  /** Function that extracts current text from the page. */
  getText: (page: Page) => Promise<string>;
  /** Total timeout for polling in milliseconds. */
  timeoutMs: number;
  /** Called with new text delta when content changes. */
  onChunk?: (delta: string) => void;
  /** Number of consecutive stable polls before considering complete. Default: 3 */
  stableThreshold?: number;
  /** Interval between polls in milliseconds. Default: 1000 */
  pollIntervalMs?: number;
  /** Optional function that returns true if streaming is still in progress. */
  isStreaming?: (page: Page) => Promise<boolean>;
}

/**
 * Poll a page element until its text content stabilizes (stops changing).
 * Used by multiple providers for captureResponse streaming detection.
 *
 * @returns The final stable text, elapsed time, and whether it was truncated.
 */
export async function pollUntilStable(
  page: Page,
  opts: PollOptions,
): Promise<{ text: string; elapsed: number; truncated: boolean }> {
  const {
    getText,
    timeoutMs,
    onChunk,
    stableThreshold = 3,
    pollIntervalMs = 1000,
    isStreaming,
  } = opts;

  const startTime = Date.now();
  let lastText = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    const streaming = isStreaming ? await isStreaming(page) : false;
    const currentText = await getText(page);

    if (currentText === lastText && !streaming) {
      stableCount++;
      if (stableCount >= stableThreshold && currentText.length > 0) {
        break;
      }
    } else {
      if (onChunk && currentText.length > lastText.length) {
        onChunk(currentText.slice(lastText.length));
      }
      lastText = currentText;
      stableCount = 0;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  const elapsed = Date.now() - startTime;
  return {
    text: lastText,
    elapsed,
    truncated: elapsed >= timeoutMs && stableCount < stableThreshold,
  };
}
