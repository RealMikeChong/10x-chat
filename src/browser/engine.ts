/**
 * Browser engine abstraction.
 *
 * Tries to use Patchright (undetectable Playwright fork) first,
 * falls back to Playwright if Patchright is not installed.
 *
 * Patchright patches CDP-level automation detection signals that
 * Playwright leaks (e.g. Runtime.enable), making the browser
 * virtually undetectable by Cloudflare, DataDome, etc.
 *
 * Both libraries export the same API surface — this module
 * re-exports `chromium` from whichever is available.
 */

import type { BrowserType } from 'playwright';

let _chromium: BrowserType | undefined;
let _engineName: 'patchright' | 'playwright' | 'unknown' = 'unknown';
let _loaded = false;

async function loadEngine(): Promise<BrowserType> {
  if (_chromium) return _chromium;

  // Try Patchright first (drop-in Playwright replacement with stealth)
  try {
    const patchright = await import('patchright');
    if (patchright.chromium) {
      _chromium = patchright.chromium as unknown as BrowserType;
      _engineName = 'patchright';
      _loaded = true;
      return _chromium;
    }
  } catch {
    // Patchright not installed or broken — fall back to Playwright
  }

  try {
    const playwright = await import('playwright');
    _chromium = playwright.chromium as unknown as BrowserType;
    _engineName = 'playwright';
    _loaded = true;
    return _chromium;
  } catch {
    throw new Error(
      'Neither patchright nor playwright is installed. Run: npm install patchright (recommended) or npm install playwright',
    );
  }
}

/** Get the chromium browser type (async — loads engine on first call). */
export async function getChromium(): Promise<BrowserType> {
  return loadEngine();
}

/** Which engine is active. Returns 'unknown' if not yet loaded. */
export function getEngineName(): 'patchright' | 'playwright' | 'unknown' {
  return _engineName;
}

/** Whether the engine has been loaded yet. */
export function isEngineLoaded(): boolean {
  return _loaded;
}
