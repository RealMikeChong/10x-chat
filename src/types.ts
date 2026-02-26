import type { Page } from 'playwright';

// ── Profile Types ───────────────────────────────────────────────

/**
 * Profile mode controls how browser profiles are managed:
 * - 'shared': Single profile for all providers (login once, shared cookies). Default.
 *   Note: shared mode means only one provider session can run at a time (lock constraint).
 * - 'isolated': Separate profile per provider (original behavior, login per provider).
 */
export type ProfileMode = 'shared' | 'isolated';

// ── Provider Types ──────────────────────────────────────────────

export type ProviderName = 'chatgpt' | 'gemini' | 'claude' | 'grok' | 'notebooklm' | 'flow';

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  url: string;
  loginUrl: string;
  models?: string[];
  defaultModel?: string;
  defaultTimeoutMs: number;
}

export interface GeneratedImage {
  /** Source URL of the generated image (may require auth cookies). */
  url: string;
  /** Alt text or description. */
  alt?: string;
  /** Natural width in pixels. */
  width?: number;
  /** Natural height in pixels. */
  height?: number;
  /** Local file path after download (set by orchestrator). */
  localPath?: string;
}

export interface CapturedResponse {
  text: string;
  markdown: string;
  model?: string;
  thinkingTime?: number;
  truncated: boolean;
  /** Images generated in the response (e.g. DALL-E, Imagen). */
  images?: GeneratedImage[];
}

export interface ProviderActions {
  /** Check if the user is currently authenticated. */
  isLoggedIn(page: Page): Promise<boolean>;

  /** Select a specific model if the provider has a model picker UI. */
  selectModel?(page: Page, model: string): Promise<void>;

  /** Submit a prompt (type into composer, click send). */
  submitPrompt(page: Page, prompt: string): Promise<void>;

  /** Attach files (images, documents) to the composer before sending. */
  attachFiles?(page: Page, filePaths: string[]): Promise<void>;

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
  /** Profile mode: 'shared' (default, single profile) or 'isolated' (per-provider profiles). */
  profileMode: ProfileMode;
}

export const DEFAULT_CONFIG: AppConfig = {
  defaultProvider: 'chatgpt',
  defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes
  headless: true,
  profileMode: 'shared',
};

// ── CLI Option Types ────────────────────────────────────────────

export interface ChatOptions {
  prompt: string;
  provider?: ProviderName;
  providers?: ProviderName[];
  model?: string;
  file?: string[];
  attach?: string[];
  copy?: boolean;
  dryRun?: boolean;
  headed?: boolean;
  timeoutMs?: number;
  /** Directory to save generated images. Defaults to session dir. */
  saveImages?: string;
  /** Override to use isolated (per-provider) profiles regardless of config. */
  isolatedProfile?: boolean;
}

// ── Video Generation Types ──────────────────────────────────────

export type VideoMode = 'ingredients' | 'frames';
export type VideoModel =
  | 'Veo 3.1 - Fast'
  | 'Veo 3.1 - Fast [Lower Priority]'
  | 'Veo 3.1 - Quality'
  | 'Veo 2 - Fast'
  | 'Veo 2 - Quality';
export type VideoOrientation = 'landscape' | 'portrait';

export interface GeneratedVideo {
  /** Local file path after download. */
  localPath?: string;
  /** Duration in seconds, if known. */
  durationSecs?: number;
}

export interface VideoOptions {
  prompt: string;
  mode?: VideoMode;
  model?: VideoModel;
  orientation?: VideoOrientation;
  count?: 1 | 2 | 3 | 4;
  startFrame?: string;
  endFrame?: string;
  headed?: boolean;
  timeoutMs?: number;
  saveDir?: string;
  isolatedProfile?: boolean;
}
