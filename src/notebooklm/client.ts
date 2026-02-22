import { ArtifactsAPI } from './api/artifacts.js';
import { ChatAPI } from './api/chat.js';
import { NotebooksAPI } from './api/notebooks.js';
import { NotesAPI } from './api/notes.js';
import { ResearchAPI } from './api/research.js';
import { SettingsAPI } from './api/settings.js';
import { SharingAPI } from './api/sharing.js';
import { SourcesAPI } from './api/sources.js';
import {
  AuthTokens,
  type AuthTokens as AuthTokensType,
  extractCsrfFromHtml,
  extractSessionIdFromHtml,
} from './auth.js';
import { ClientCore, DEFAULT_TIMEOUT } from './core.js';

function isGoogleAuthRedirect(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'accounts.google.com' || hostname.endsWith('.accounts.google.com');
  } catch {
    return false;
  }
}

export class NotebookLMClient {
  private readonly core: ClientCore;

  public readonly notebooks: NotebooksAPI;
  public readonly sources: SourcesAPI;
  public readonly notes: NotesAPI;
  public readonly artifacts: ArtifactsAPI;
  public readonly chat: ChatAPI;
  public readonly research: ResearchAPI;
  public readonly settings: SettingsAPI;
  public readonly sharing: SharingAPI;

  public constructor(auth: AuthTokensType, timeoutMs = DEFAULT_TIMEOUT) {
    this.core = new ClientCore(auth, {
      timeoutMs,
      refreshCallback: () => this.refreshAuth(),
    });

    this.notebooks = new NotebooksAPI(this.core);
    this.sources = new SourcesAPI(this.core);
    this.notes = new NotesAPI(this.core);
    this.artifacts = new ArtifactsAPI(this.core, this.notes);
    this.chat = new ChatAPI(this.core);
    this.research = new ResearchAPI(this.core);
    this.settings = new SettingsAPI(this.core);
    this.sharing = new SharingAPI(this.core);
  }

  public get auth(): AuthTokensType {
    return this.core.auth;
  }

  public get isConnected(): boolean {
    return this.core.isOpen;
  }

  public async open(): Promise<void> {
    console.debug('Opening NotebookLM client');
    await this.core.open();
  }

  public async close(): Promise<void> {
    console.debug('Closing NotebookLM client');
    await this.core.close();
  }

  public async withClient<T>(fn: (client: NotebookLMClient) => Promise<T>): Promise<T> {
    await this.open();
    try {
      return await fn(this);
    } finally {
      await this.close();
    }
  }

  public static async fromStorage(
    profileDir?: string,
    timeoutMs = DEFAULT_TIMEOUT,
  ): Promise<NotebookLMClient> {
    const auth = await AuthTokens.fromStorage(profileDir);
    return new NotebookLMClient(auth, timeoutMs);
  }

  public async refreshAuth(): Promise<AuthTokensType> {
    const httpClient = this.core.getHttpClient();
    const response = await httpClient.get('https://notebooklm.google.com/', {
      headers: {
        Cookie: this.core.auth.cookieHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh auth: HTTP ${response.status} ${response.statusText}`);
    }

    const finalUrl = response.url;
    if (isGoogleAuthRedirect(finalUrl)) {
      throw new Error('Authentication expired. Re-authenticate your Gemini profile.');
    }

    const html = await response.text();
    const csrfToken = extractCsrfFromHtml(html, finalUrl);
    const sessionId = extractSessionIdFromHtml(html, finalUrl);

    this.core.auth.csrfToken = csrfToken;
    this.core.auth.sessionId = sessionId;

    this.core.updateAuthHeaders();
    return this.core.auth;
  }
}
