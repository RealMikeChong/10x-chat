import chalk from 'chalk';
import { Command } from 'commander';
import { launchBrowser } from '../browser/index.js';
import { resolveHeadlessMode } from '../browser/mode.js';
import { loadConfig } from '../config.js';
import { getProvider, isValidProvider } from '../providers/index.js';
import type { ProfileMode, ProviderName } from '../types.js';

const HISTORY_PROVIDERS: ProviderName[] = ['chatgpt', 'gemini', 'claude', 'grok', 'perplexity'];

interface HistoryItem {
  title: string;
  href?: string;
}

interface HistoryResult {
  provider: ProviderName;
  items: HistoryItem[];
  error?: string;
}

const HISTORY_URL_HINTS: Partial<Record<ProviderName, RegExp[]>> = {
  chatgpt: [/\/c\//, /chatgpt\.com\/share\//],
  gemini: [/gemini\.google\.com\/app\//],
  claude: [/claude\.ai\/chat\//],
  grok: [/grok\.com\/chat\//],
  perplexity: [/perplexity\.ai\/(?:search|thread)\//],
  notebooklm: [/notebooklm\.google\.com\/notebook\//],
};

const HISTORY_SELECTOR_HINTS: Partial<Record<ProviderName, string>> = {
  chatgpt: '[data-testid^="history-item"], nav a, a',
  gemini: 'a[data-test-id="conversation"], [data-test-id="conversation"], nav a, a',
  claude: 'nav a, a[href*="/chat/"], a',
  grok: 'nav a, a[href*="/chat/"], a',
  perplexity: 'nav a, a[href*="/search/"], a[href*="/thread/"], a',
  notebooklm: 'a[href*="/notebook/"], [role="link"], a',
};

export function createHistoryCommand(): Command {
  return new Command('history')
    .description('List chat history visible in provider sidebars')
    .option('--provider <name>', `Provider (${HISTORY_PROVIDERS.join(', ')}, all)`, 'all')
    .option('--limit <n>', 'Maximum items per provider', '20')
    .option('--headed', 'Show browser window')
    .option('--json', 'Output JSON')
    .option('--isolated-profile', 'Use per-provider browser profiles')
    .action(async (options) => {
      const providerOption = String(options.provider ?? 'all');
      const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);

      const providers = (() => {
        if (providerOption === 'all') return HISTORY_PROVIDERS;
        if (!isValidProvider(providerOption) || !HISTORY_PROVIDERS.includes(providerOption)) {
          console.error(
            chalk.red(
              `Unknown or unsupported provider: ${providerOption}. Use: ${HISTORY_PROVIDERS.join(', ')}, all`,
            ),
          );
          process.exit(1);
        }
        return [providerOption];
      })();

      const results: HistoryResult[] = [];
      for (const providerName of providers) {
        results.push(
          await listProviderHistory(providerName, {
            headed: options.headed === true,
            isolatedProfile: options.isolatedProfile === true,
            limit,
            quiet: options.json === true,
          }),
        );
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      renderHistory(results);
    });
}

async function listProviderHistory(
  providerName: ProviderName,
  opts: { headed: boolean; isolatedProfile: boolean; limit: number; quiet: boolean },
): Promise<HistoryResult> {
  const config = await loadConfig();
  const provider = getProvider(providerName);
  const headless = resolveHeadlessMode(providerName, config.headless, opts.headed);
  const profileMode: ProfileMode = opts.isolatedProfile ? 'isolated' : config.profileMode;

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  if (opts.quiet) {
    console.log = () => {};
    console.error = () => {};
  }
  try {
    browser = await launchBrowser({
      provider: providerName,
      headless,
      url: provider.config.url,
      profileMode,
    });

    const loggedIn = await provider.actions.isLoggedIn(browser.page);
    if (!loggedIn) {
      return { provider: providerName, items: [], error: 'not logged in' };
    }

    await revealHistory(browser.page, providerName);
    const items = await extractHistoryItems(browser.page, providerName, opts.limit);
    return { provider: providerName, items };
  } catch (error) {
    return {
      provider: providerName,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await browser?.close().catch(() => {});
    if (opts.quiet) {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }
  }
}

async function revealHistory(
  page: Awaited<ReturnType<typeof launchBrowser>>['page'],
  providerName: ProviderName,
): Promise<void> {
  await page.waitForTimeout(2_000);

  if (providerName === 'chatgpt') {
    const searchButton = page
      .locator('[aria-label*="Search chats"], button:has-text("Search chats")')
      .first();
    if (await searchButton.isVisible().catch(() => false)) return;
  }

  if (providerName === 'gemini') {
    const historyVisible = await page
      .locator('a[data-test-id="conversation"], [data-test-id="conversation"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (historyVisible) return;
  }

  const maybeOpenSidebar = page
    .locator(
      [
        '[data-testid="side-nav-menu-button"]',
        '[aria-label="Main menu"]',
        '[aria-label*="menu" i]',
        'button:has-text("Recents")',
        'button:has-text("History")',
      ].join(', '),
    )
    .first();

  if (await maybeOpenSidebar.isVisible().catch(() => false)) {
    await maybeOpenSidebar.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
}

async function extractHistoryItems(
  page: Awaited<ReturnType<typeof launchBrowser>>['page'],
  providerName: ProviderName,
  limit: number,
): Promise<HistoryItem[]> {
  return page.evaluate(
    ({ provider, limit: maxItems, selector, urlHints }) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (el: Element): boolean => {
        if (!(el instanceof HTMLElement)) return false;
        return el.offsetWidth > 0 && el.offsetHeight > 0;
      };
      const matchesUrlHint = (href: string): boolean => {
        if (!href) return false;
        return urlHints.some((pattern) => new RegExp(pattern).test(href));
      };

      const candidates = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
      const seen = new Set<string>();
      const items: Array<{ title: string; href?: string }> = [];

      for (const el of candidates) {
        if (!isVisible(el)) continue;

        const anchor = el instanceof HTMLAnchorElement ? el : el.querySelector('a');
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : '';
        const title = normalize(
          el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.textContent ||
            anchor?.textContent,
        );

        if (!title || title.length < 2) continue;
        if (
          /^(new chat|search chats|settings|upgrade|log in|sign in|explore gpts|library)$/i.test(
            title,
          ) ||
          /^open (?:conversation|project|chat) options/i.test(title)
        ) {
          continue;
        }

        const providerSpecific = (() => {
          if (provider === 'gemini')
            return el.getAttribute('data-test-id') === 'conversation' || matchesUrlHint(href);
          if (provider === 'chatgpt') return matchesUrlHint(href);
          return matchesUrlHint(href);
        })();
        if (!providerSpecific) continue;

        const key = href || title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ title, ...(href ? { href } : {}) });
        if (items.length >= maxItems) break;
      }

      return items;
    },
    {
      provider: providerName,
      limit,
      selector: HISTORY_SELECTOR_HINTS[providerName] ?? 'a, button, [role="link"]',
      urlHints: (HISTORY_URL_HINTS[providerName] ?? []).map((re) => re.source),
    },
  );
}

function renderHistory(results: HistoryResult[]): void {
  for (const result of results) {
    console.log(chalk.bold(`\n${result.provider}`));
    if (result.error) {
      console.log(chalk.red(`  ${result.error}`));
      continue;
    }
    if (result.items.length === 0) {
      console.log(chalk.dim('  No history items found.'));
      continue;
    }

    result.items.forEach((item, index) => {
      const href = item.href ? chalk.dim(` ${item.href}`) : '';
      console.log(`  ${String(index + 1).padStart(2, ' ')}. ${item.title}${href}`);
    });
  }
}
