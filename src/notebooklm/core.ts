import { setTimeout as sleep } from 'node:timers/promises';
import type { AuthTokens } from './auth.js';
import {
  ClientError,
  NetworkError,
  RateLimitError,
  RPCError,
  RPCTimeoutError,
  ServerError,
} from './errors.js';
import {
  BATCHEXECUTE_URL,
  buildRequestBody,
  decodeResponse,
  encodeRpcRequest,
  RPCMethod,
} from './rpc/index.js';

export const MAX_CONVERSATION_CACHE_SIZE = 100;

export const DEFAULT_TIMEOUT = 30_000;
export const DEFAULT_CONNECT_TIMEOUT = 10_000;

const AUTH_ERROR_PATTERNS = [
  'authentication',
  'expired',
  'unauthorized',
  'login',
  're-authenticate',
];

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof RPCError) {
    const message = error.message.toLowerCase();
    return AUTH_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
  }

  if (error instanceof ClientError) {
    return error.statusCode === 401 || error.statusCode === 403;
  }

  if (
    error instanceof NetworkError ||
    error instanceof RPCTimeoutError ||
    error instanceof RateLimitError ||
    error instanceof ServerError
  ) {
    return false;
  }

  return false;
}

export interface NotebookHttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  get(url: string, init?: RequestInit): Promise<Response>;
  post(url: string, body: BodyInit, init?: RequestInit): Promise<Response>;
}

interface CachedTurn {
  query: string;
  answer: string;
  turnNumber: number;
}

export class ClientCore {
  public auth: AuthTokens;

  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly refreshCallback: (() => Promise<AuthTokens>) | null;
  private readonly refreshRetryDelayMs: number;

  private refreshTask: Promise<AuthTokens> | null = null;
  private openState = false;

  private reqidCounter = 100_000;
  private readonly conversationCache = new Map<string, CachedTurn[]>();

  private readonly httpClient: NotebookHttpClient;

  public constructor(
    auth: AuthTokens,
    opts: {
      timeoutMs?: number;
      connectTimeoutMs?: number;
      refreshCallback?: (() => Promise<AuthTokens>) | null;
      refreshRetryDelayMs?: number;
    } = {},
  ) {
    this.auth = auth;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT;
    this.refreshCallback = opts.refreshCallback ?? null;
    this.refreshRetryDelayMs = opts.refreshRetryDelayMs ?? 200;

    this.httpClient = {
      fetch: async (url, init) => this.request(url, init),
      get: async (url, init) =>
        this.request(url, {
          ...init,
          method: 'GET',
        }),
      post: async (url, body, init) =>
        this.request(url, {
          ...init,
          method: 'POST',
          body,
        }),
    };
  }

  public async open(): Promise<void> {
    this.openState = true;
  }

  public async close(): Promise<void> {
    this.openState = false;
  }

  public get isOpen(): boolean {
    return this.openState;
  }

  public updateAuthHeaders(): void {
    this.auth.cookieHeader = Object.entries(this.auth.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  private buildUrl(rpcMethod: RPCMethod, sourcePath = '/'): string {
    const params = new URLSearchParams({
      rpcids: rpcMethod,
      'source-path': sourcePath,
      'f.sid': this.auth.sessionId,
      rt: 'c',
    });

    return `${BATCHEXECUTE_URL}?${params.toString()}`;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    if (!this.openState) {
      throw new Error(
        "Client not initialized. Use 'await client.open()' or async context manager.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = new Headers(init.headers ?? {});
    if (!headers.has('Cookie')) {
      headers.set('Cookie', this.auth.cookieHeader);
    }

    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new RPCTimeoutError(`Request timed out after ${timeoutMs / 1000}s`, {
          timeoutSeconds: timeoutMs / 1000,
          originalError: error instanceof Error ? error : null,
        });
      }

      throw new NetworkError(`Request failed: ${String(error)}`, {
        originalError: error instanceof Error ? error : null,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  public async rpcCall(
    method: RPCMethod,
    params: unknown[],
    sourcePath = '/',
    allowNull = false,
    isRetry = false,
  ): Promise<unknown> {
    if (!this.openState) {
      throw new Error(
        "Client not initialized. Use 'await client.open()' or async context manager.",
      );
    }

    const start = Date.now();
    console.debug(`RPC ${String(method)} starting`);

    const url = this.buildUrl(method, sourcePath);
    const rpcRequest = encodeRpcRequest(method, params);
    const body = buildRequestBody(rpcRequest, this.auth.csrfToken);

    let response: Response;
    try {
      response = await this.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body,
        },
        this.timeoutMs,
      );
    } catch (error) {
      if (!isRetry && this.refreshCallback && isAuthError(error)) {
        const refreshed = await this.tryRefreshAndRetry(
          method,
          params,
          sourcePath,
          allowNull,
          error,
        );
        if (refreshed !== null) {
          return refreshed;
        }
      }

      throw error;
    }

    if (!response.ok) {
      const elapsed = (Date.now() - start) / 1000;
      const status = response.status;

      if (!isRetry && this.refreshCallback && (status === 401 || status === 403)) {
        const refreshed = await this.tryRefreshAndRetry(
          method,
          params,
          sourcePath,
          allowNull,
          new RPCError(`HTTP ${status} calling ${String(method)}: ${response.statusText}`, {
            methodId: method,
          }),
        );
        if (refreshed !== null) {
          return refreshed;
        }
      }

      console.error(`RPC ${String(method)} failed after ${elapsed.toFixed(3)}s: HTTP ${status}`);

      if (status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;
        let message = `API rate limit exceeded calling ${String(method)}`;
        if (retryAfter && Number.isFinite(retryAfter)) {
          message += `. Retry after ${retryAfter} seconds`;
        }
        throw new RateLimitError(message, {
          methodId: method,
          retryAfter: retryAfter && Number.isFinite(retryAfter) ? retryAfter : null,
        });
      }

      if (status >= 500 && status < 600) {
        throw new ServerError(
          `Server error ${status} calling ${String(method)}: ${response.statusText}`,
          {
            methodId: method,
            statusCode: status,
          },
        );
      }

      if (status >= 400 && status < 500 && status !== 401 && status !== 403) {
        throw new ClientError(
          `Client error ${status} calling ${String(method)}: ${response.statusText}`,
          {
            methodId: method,
            statusCode: status,
          },
        );
      }

      throw new RPCError(`HTTP ${status} calling ${String(method)}: ${response.statusText}`, {
        methodId: method,
      });
    }

    const text = await response.text();

    try {
      const result = decodeResponse(text, method, allowNull);
      const elapsed = (Date.now() - start) / 1000;
      console.debug(`RPC ${String(method)} completed in ${elapsed.toFixed(3)}s`);
      return result;
    } catch (error) {
      const elapsed = (Date.now() - start) / 1000;

      if (!isRetry && this.refreshCallback && isAuthError(error)) {
        const refreshed = await this.tryRefreshAndRetry(
          method,
          params,
          sourcePath,
          allowNull,
          error,
        );
        if (refreshed !== null) {
          return refreshed;
        }
      }

      if (error instanceof RPCError) {
        console.error(`RPC ${String(method)} failed after ${elapsed.toFixed(3)}s`);
        throw error;
      }

      console.error(`RPC ${String(method)} failed after ${elapsed.toFixed(3)}s: ${String(error)}`);
      throw new RPCError(`Failed to decode response for ${String(method)}: ${String(error)}`, {
        methodId: method,
      });
    }
  }

  private async tryRefreshAndRetry(
    method: RPCMethod,
    params: unknown[],
    sourcePath: string,
    allowNull: boolean,
    originalError: unknown,
  ): Promise<unknown | null> {
    if (!this.refreshCallback) {
      return null;
    }

    console.info(`RPC ${String(method)} auth error detected, attempting token refresh`);

    if (!this.refreshTask) {
      this.refreshTask = (async () => {
        const refreshed = await this.refreshCallback?.();
        if (!refreshed) {
          throw new Error('Refresh callback returned no auth tokens');
        }
        return refreshed;
      })();

      this.refreshTask.finally(() => {
        this.refreshTask = null;
      });
    } else {
      console.debug(`Waiting on existing refresh task for RPC ${String(method)}`);
    }

    try {
      await this.refreshTask;
    } catch (refreshError) {
      console.warn(`Token refresh failed: ${String(refreshError)}`);
      throw originalError;
    }

    if (this.refreshRetryDelayMs > 0) {
      await sleep(this.refreshRetryDelayMs);
    }

    console.info(`Token refresh successful, retrying RPC ${String(method)}`);
    return this.rpcCall(method, params, sourcePath, allowNull, true);
  }

  public getHttpClient(): NotebookHttpClient {
    if (!this.openState) {
      throw new Error(
        "Client not initialized. Use 'await client.open()' or async context manager.",
      );
    }

    return this.httpClient;
  }

  public cacheConversationTurn(
    conversationId: string,
    query: string,
    answer: string,
    turnNumber: number,
  ): void {
    const isNewConversation = !this.conversationCache.has(conversationId);

    if (isNewConversation) {
      while (this.conversationCache.size >= MAX_CONVERSATION_CACHE_SIZE) {
        const oldestKey = this.conversationCache.keys().next().value;
        if (oldestKey) {
          this.conversationCache.delete(oldestKey);
        } else {
          break;
        }
      }

      this.conversationCache.set(conversationId, []);
    }

    const turns = this.conversationCache.get(conversationId);
    if (!turns) {
      return;
    }

    turns.push({ query, answer, turnNumber });
  }

  public getCachedConversation(conversationId: string): CachedTurn[] {
    return this.conversationCache.get(conversationId) ?? [];
  }

  public clearConversationCache(conversationId?: string | null): boolean {
    if (conversationId) {
      if (this.conversationCache.has(conversationId)) {
        this.conversationCache.delete(conversationId);
        return true;
      }

      return false;
    }

    this.conversationCache.clear();
    return true;
  }

  public async getSourceIds(notebookId: string): Promise<string[]> {
    const params = [notebookId, null, [2], null, 0];
    const notebookData = await this.rpcCall(
      RPCMethod.GET_NOTEBOOK,
      params,
      `/notebook/${notebookId}`,
    );

    const sourceIds: string[] = [];
    if (!Array.isArray(notebookData) || notebookData.length === 0) {
      return sourceIds;
    }

    try {
      const notebookInfo = notebookData[0];
      if (!Array.isArray(notebookInfo) || notebookInfo.length <= 1) {
        return sourceIds;
      }

      const sources = notebookInfo[1];
      if (!Array.isArray(sources)) {
        return sourceIds;
      }

      for (const source of sources) {
        if (!Array.isArray(source) || source.length === 0) {
          continue;
        }

        const first = source[0];
        if (!Array.isArray(first) || first.length === 0) {
          continue;
        }

        const sourceId = first[0];
        if (typeof sourceId === 'string') {
          sourceIds.push(sourceId);
        }
      }
    } catch {
      return sourceIds;
    }

    return sourceIds;
  }

  public nextReqIdStep(): number {
    this.reqidCounter += 100_000;
    return this.reqidCounter;
  }

  public getConnectTimeoutMs(): number {
    return this.connectTimeoutMs;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }
}
