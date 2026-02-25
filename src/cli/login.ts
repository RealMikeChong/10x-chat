import chalk from 'chalk';
import { Command } from 'commander';
import { launchBrowser } from '../browser/index.js';
import { loadConfig } from '../config.js';
import { getProvider, isValidProvider, listProviders } from '../providers/index.js';
import type { ProfileMode, ProviderName } from '../types.js';

export function createLoginCommand(): Command {
  const cmd = new Command('login')
    .description('Login to an AI provider (opens browser for authentication)')
    .argument('[provider]', 'Provider to login to (chatgpt, gemini, claude, grok)')
    .option('--all', 'Login to all providers')
    .option('--status', 'Check login status for all providers')
    .option('--isolated-profile', 'Use per-provider browser profiles (backward compat)')
    .action(
      async (
        providerArg?: string,
        options?: { all?: boolean; status?: boolean; isolatedProfile?: boolean },
      ) => {
        const config = await loadConfig();
        const profileMode: ProfileMode = options?.isolatedProfile ? 'isolated' : config.profileMode;

        if (options?.status) {
          await checkLoginStatus(profileMode);
          return;
        }

        if (profileMode === 'shared') {
          console.log(
            chalk.dim(
              'Using shared profile (all providers share one browser profile). Use --isolated-profile for per-provider.',
            ),
          );
        }

        if (options?.all) {
          for (const name of listProviders()) {
            await loginToProvider(name, profileMode);
          }
          return;
        }

        if (!providerArg) {
          console.log(chalk.yellow('Usage: 10x-chat login <provider>'));
          console.log(chalk.dim(`Available providers: ${listProviders().join(', ')}`));
          if (profileMode === 'shared') {
            console.log(
              chalk.dim('Tip: In shared mode, login to one provider and all share the session.'),
            );
          }
          return;
        }

        if (!isValidProvider(providerArg)) {
          console.log(chalk.red(`Unknown provider: ${providerArg}`));
          console.log(chalk.dim(`Available: ${listProviders().join(', ')}`));
          process.exit(1);
        }

        await loginToProvider(providerArg, profileMode);
      },
    );

  return cmd;
}

async function loginToProvider(
  providerName: ProviderName,
  profileMode: ProfileMode = 'shared',
): Promise<void> {
  const provider = getProvider(providerName);
  console.log(chalk.blue(`Opening ${provider.config.displayName} for login...`));
  console.log(chalk.dim('Please login in the browser window. The session will be saved.'));

  const browser = await launchBrowser({
    provider: providerName,
    headless: false, // Always headed for login
    url: provider.config.loginUrl,
    profileMode,
    persistent: true, // Login needs persistent context to auto-save cookies
  });

  try {
    // Wait for the user to login — poll until logged in or timeout
    const timeoutMs = 5 * 60 * 1000; // 5 minutes to login
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const loggedIn = await provider.actions.isLoggedIn(browser.page);
      if (loggedIn) {
        console.log(chalk.green(`✓ Logged in to ${provider.config.displayName}`));
        return;
      }
      await browser.page.waitForTimeout(2000);
    }

    console.log(chalk.yellow('Login timed out. You can try again.'));
  } finally {
    await browser.close();
  }
}

async function checkLoginStatus(profileMode: ProfileMode = 'shared'): Promise<void> {
  console.log(chalk.bold('Login Status\n'));
  if (profileMode === 'shared') {
    console.log(chalk.dim('(shared profile mode — all providers use the same browser profile)\n'));
  }

  for (const name of listProviders()) {
    const provider = getProvider(name);
    try {
      const browser = await launchBrowser({
        provider: name,
        headless: true,
        url: provider.config.url,
        profileMode,
      });

      try {
        // Give the page a moment to load
        await browser.page.waitForTimeout(3000);
        const loggedIn = await provider.actions.isLoggedIn(browser.page);
        const status = loggedIn ? chalk.green('✓ logged in') : chalk.red('✗ not logged in');
        console.log(`  ${provider.config.displayName}: ${status}`);
      } finally {
        await browser.close();
      }
    } catch {
      console.log(`  ${provider.config.displayName}: ${chalk.dim('unable to check')}`);
    }
  }
}
