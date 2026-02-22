import type { Page } from 'playwright';

// ── Provider Types ──────────────────────────────────────────────

export type ProviderName = 'chatgpt' | 'gemini' | 'claude' | 'grok';

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  url: string;
  loginUrl: string;
  models?: string[];
  defaultModel?: string;
  defaultTimeoutMs: number;
}

export interface CapturedResponse {
  text: string;
  markdown: string;
  model?: string;
  thinkingTime?: number;
  truncated: boolean;
}

export interface ProviderActions {
  /** Check if the user is currently authenticated. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** Select a specific model if the provider has a model picker UI. */
  selectModel?(page: Page, model: string): Promise<void>;

  /** Submit a prompt (type into composer, click send). */
  submitPrompt(page: Page, prompt: string): Promise<void>;

  /** Wait for the assistant response and extract it. */
  captureResponse(
    page: Page,
    opts: {
      timeoutMs: number;
      onChunk?: (chunk: string) => void;
    },
  ): Promise<CapturedResponse>;
}

export interface Provider {
  config: ProviderConfig;
  actions: ProviderActions;
}

// ── Session Types ───────────────────────────────────────────────

export type SessionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout';

export interface SessionMeta {
  id: string;
  provider: ProviderName;
  model?: string;
  promptPreview: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  durationMs?: number;
}

export interface SessionResult {
  meta: SessionMeta;
  bundlePath: string;
  responsePath?: string;
}

// ── Config Types ────────────────────────────────────────────────

export interface AppConfig {
  defaultProvider: ProviderName;
  defaultModel?: string;
  defaultTimeoutMs: number;
  headless: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProvider: 'chatgpt',
  defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes
  headless: true,
};

// ── CLI Option Types ────────────────────────────────────────────

export interface ChatOptions {
  prompt: string;
  provider?: ProviderName;
  providers?: ProviderName[];
  model?: string;
  file?: string[];
  copy?: boolean;
  dryRun?: boolean;
  headed?: boolean;
  timeoutMs?: number;
}
