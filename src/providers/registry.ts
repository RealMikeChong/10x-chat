import type { Provider, ProviderName } from '../types.js';
import { CHATGPT_CONFIG, chatgptActions } from './chatgpt.js';
import { CLAUDE_CONFIG, claudeActions } from './claude.js';
import { GEMINI_CONFIG, geminiActions } from './gemini.js';
import { GROK_CONFIG, grokActions } from './grok.js';

const PROVIDERS: Record<ProviderName, Provider> = {
  chatgpt: { config: CHATGPT_CONFIG, actions: chatgptActions },
  gemini: { config: GEMINI_CONFIG, actions: geminiActions },
  claude: { config: CLAUDE_CONFIG, actions: claudeActions },
  grok: { config: GROK_CONFIG, actions: grokActions },
};

/** Get a provider by name, throws if not found. */
export function getProvider(name: ProviderName): Provider {
  const provider = PROVIDERS[name];
  if (!Object.hasOwn(PROVIDERS, name)) {
    const available = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown provider "${name}". Available: ${available}`);
  }
  return provider;
}

/** List all registered provider names. */
export function listProviders(): ProviderName[] {
  return Object.keys(PROVIDERS) as ProviderName[];
}

/** Check if a string is a valid provider name. */
export function isValidProvider(name: string): name is ProviderName {
  return Object.hasOwn(PROVIDERS, name);
}
