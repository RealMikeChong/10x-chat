import type { ProviderName } from '../types.js';

const HEADED_PROVIDERS = new Set<ProviderName>(['chatgpt', 'claude']);

/**
 * Resolve whether a provider should run headless for this invocation.
 * Explicit --headed always wins. Some providers are more reliable with a
 * visible browser because anti-bot checks or alternate DOM branches trigger
 * under headless Chromium.
 */
export function resolveHeadlessMode(
  providerName: ProviderName,
  configHeadless: boolean,
  headedOverride = false,
): boolean {
  if (headedOverride) return false;
  if (HEADED_PROVIDERS.has(providerName)) return false;
  return configHeadless;
}
