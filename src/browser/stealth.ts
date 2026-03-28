/**
 * Anti-detection stealth script.
 *
 * Injected into every browser context via addInitScript() to patch
 * common automation detection signals. This helps provider sites
 * (ChatGPT, Claude, Grok, etc.) not flag the session as a bot.
 *
 * Layers:
 * 1. navigator.webdriver = false
 * 2. window.chrome runtime stub
 * 3. navigator.permissions.query fix
 * 4. navigator.plugins/mimeTypes populated
 * 5. navigator.languages populated
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 2. Fake chrome runtime (headless Chrome is missing window.chrome)
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {};
  }

  // 3. Fix permissions query for notifications
  const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(params);
    };
  }

  // 4. Fix plugins/mimeTypes (headless has empty arrays)
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({
      name: 'Chrome PDF Plugin',
      description: 'Portable Document Format',
      filename: 'internal-pdf-viewer',
      length: 1,
    })),
  });

  // 5. Fix languages (some headless configs return empty)
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
})();
`;

/**
 * Detect if real Google Chrome is installed on the system.
 * Returns 'chrome' if found, undefined otherwise.
 */
export function detectChromeChannel(): 'chrome' | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return 'chrome';
    }
  } catch {
    // ignore
  }
  return undefined;
}
