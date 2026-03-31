import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Cookie, Download, FileChooser, Page } from 'playwright';
import { getAppDir } from '../paths.js';
import { acquireProfileLock } from './lock.js';
import { isProcessAlive } from './process.js';
import { loadStorageState, saveStorageState } from './state.js';

const DAEMON_FILE = 'browser-daemon.json';
const DAEMON_LOCK_DIR = path.join(getAppDir(), 'browser-daemon-lock');
const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 3_000;

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type SerializedValue =
  | JsonValue
  | { __type: 'regexp'; source: string; flags: string }
  | { __type: 'function'; source: string };

interface RpcRequest {
  kind: 'browser' | 'context' | 'page' | 'locator' | 'keyboard' | 'tabs' | 'event';
  method: string;
  target?: Record<string, string | number | LocatorStep[] | undefined>;
  args?: SerializedValue[];
}

interface RpcSuccess {
  ok: true;
  result?: SerializedValue | RemoteHandle | JsonValue;
  pageState?: { pageId: string; url: string };
}

interface RpcError {
  ok: false;
  error: string;
}

type RpcResponse = RpcSuccess | RpcError;

interface RemoteHandle {
  __handle: true;
  handleType: 'context' | 'page' | 'filechooser' | 'download';
  id: string;
  contextId?: string;
  pageId?: string;
  url?: string;
  suggestedFilename?: string;
}

interface WaitForUrlPredicate {
  mode: 'changes' | 'startsWith';
  value: string;
}

type LocatorStep =
  | { type: 'locator'; selector: string }
  | { type: 'getByRole'; role: string; options?: JsonValue }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'nth'; index: number };

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  createdAt: string;
}

interface SharedBrowserLaunchOptions {
  headless?: boolean;
  url?: string;
}

interface BrowserSessionProxy {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

class BrowserDaemonHttpClient {
  constructor(private readonly state: DaemonState) {}

  get headless(): boolean {
    return this.state.headless;
  }

  async request(request: RpcRequest): Promise<RpcSuccess> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.state.port}/rpc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.state.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new Error(`Browser daemon request failed: ${getErrorMessage(error)}`);
    }

    let body: RpcResponse;
    try {
      body = (await response.json()) as RpcResponse;
    } catch (error) {
      throw new Error(
        `Browser daemon request failed with invalid response (status ${response.status}): ${getErrorMessage(error)}`,
      );
    }

    if (!response.ok || !body.ok) {
      const message =
        typeof body === 'object' && body && 'error' in body
          ? body.error
          : `Browser daemon request failed with status ${response.status}`;
      throw new Error(message);
    }

    return body;
  }

  async stop(): Promise<void> {
    await fetch(`http://127.0.0.1:${this.state.port}/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.state.token}`,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }).catch(() => {
      // Best effort; caller falls back to pid kill if needed.
    });
  }

  async getLiveTabCount(): Promise<number> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.state.port}/health`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.state.token}`,
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Browser daemon healthcheck failed: ${getErrorMessage(error)}`);
    }

    if (!response.ok) {
      throw new Error(`Browser daemon healthcheck failed with status ${response.status}`);
    }

    let body: { ok?: boolean; activeTabs?: number };
    try {
      body = (await response.json()) as { ok?: boolean; activeTabs?: number };
    } catch (error) {
      throw new Error(
        `Browser daemon healthcheck returned invalid response (status ${response.status}): ${getErrorMessage(error)}`,
      );
    }

    return body.activeTabs ?? 0;
  }
}

interface RemotePageState {
  currentUrl: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDaemonCompatible(state: DaemonState, requestedHeadless: boolean): boolean {
  return !state.headless || state.headless === requestedHeadless;
}

function serializeValue(value: unknown): SerializedValue {
  if (value instanceof RegExp) {
    return {
      __type: 'regexp',
      source: value.source,
      flags: value.flags,
    };
  }

  if (typeof value === 'function') {
    return {
      __type: 'function',
      source: value.toString(),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry)) as SerializedValue;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]);
    return Object.fromEntries(entries) as SerializedValue;
  }

  return value as SerializedValue;
}

function deserializeHandle(
  client: BrowserDaemonHttpClient,
  handle: RemoteHandle,
): BrowserContext | Page | FileChooser | Download {
  switch (handle.handleType) {
    case 'context':
      return createRemoteContextProxy(client, handle.id);
    case 'page':
      return createRemotePageProxy(
        client,
        handle.id,
        handle.contextId ?? '',
        handle.url ?? 'about:blank',
      );
    case 'filechooser':
      return createRemoteFileChooserProxy(client, handle.id);
    case 'download':
      return createRemoteDownloadProxy(client, handle.id, handle.suggestedFilename ?? '');
  }
}

async function decodeResult(
  client: BrowserDaemonHttpClient,
  response: RpcSuccess,
  pageState?: RemotePageState,
): Promise<unknown> {
  if (response.pageState && pageState) {
    pageState.currentUrl = response.pageState.url;
  }

  const { result } = response;
  if (
    result &&
    typeof result === 'object' &&
    '__handle' in result &&
    result.__handle === true &&
    'handleType' in result
  ) {
    return deserializeHandle(client, result as RemoteHandle);
  }

  return result;
}

function createRemoteBrowserProxy(client: BrowserDaemonHttpClient): Browser {
  return {
    newContext: async (options?: Record<string, unknown>) => {
      const response = await client.request({
        kind: 'browser',
        method: 'newContext',
        args: [serializeValue(options ?? {})],
      });
      const result = await decodeResult(client, response);
      return result as BrowserContext;
    },
    close: async () => {
      // A remote client disconnect should not stop the shared daemon.
    },
    isConnected: () => true,
  } as unknown as Browser;
}

function createRemoteContextProxy(
  client: BrowserDaemonHttpClient,
  contextId: string,
): BrowserContext {
  return {
    newPage: async () => {
      const response = await client.request({
        kind: 'context',
        method: 'newPage',
        target: { contextId },
      });
      const result = await decodeResult(client, response);
      return result as Page;
    },
    close: async () => {
      await client.request({
        kind: 'context',
        method: 'close',
        target: { contextId },
      });
    },
    storageState: async (options?: { path?: string }) => {
      const response = await client.request({
        kind: 'context',
        method: 'storageState',
        target: { contextId },
        args: [serializeValue(options ?? {})],
      });
      const result = await decodeResult(client, response);
      return result as { cookies: Cookie[]; origins: Array<Record<string, unknown>> };
    },
    cookies: async (urls?: string[]) => {
      const response = await client.request({
        kind: 'context',
        method: 'cookies',
        target: { contextId },
        args: [serializeValue(urls ?? [])],
      });
      const result = await decodeResult(client, response);
      return (result ?? []) as Cookie[];
    },
  } as unknown as BrowserContext;
}

function createRemotePageProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  contextId: string,
  initialUrl: string,
): Page {
  const pageState: RemotePageState = { currentUrl: initialUrl };
  const context = createRemoteContextProxy(client, contextId);

  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'page',
      method,
      target: { pageId },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    goto: async (url: string, options?: Record<string, unknown>) =>
      invoke('goto', [url, options ?? {}]),
    waitForTimeout: async (timeout: number) => invoke('waitForTimeout', [timeout]),
    waitForLoadState: async (state?: string) => invoke('waitForLoadState', [state ?? 'load']),
    waitForURL: async (
      url: string | RegExp | WaitForUrlPredicate,
      options?: Record<string, unknown>,
    ) => invoke('waitForURL', [url, options ?? {}]),
    waitForEvent: async (event: string, options?: Record<string, unknown>) =>
      invoke('waitForEvent', [event, options ?? {}]),
    evaluate: async (pageFunction: unknown, arg?: unknown) =>
      invoke('evaluate', [pageFunction, arg]),
    close: async () => invoke('close'),
    title: async () => invoke('title'),
    url: () => pageState.currentUrl,
    context: () => context,
    getByRole: (role: string, options?: Record<string, unknown>) =>
      createRemoteLocatorProxy(client, pageId, pageState, [
        { type: 'getByRole', role, options: serializeValue(options ?? {}) as JsonValue },
      ]),
    locator: (selector: string) =>
      createRemoteLocatorProxy(client, pageId, pageState, [{ type: 'locator', selector }]),
    keyboard: createRemoteKeyboardProxy(client, pageId, pageState),
  } as unknown as Page;
}

function createRemoteKeyboardProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  pageState: RemotePageState,
): Page['keyboard'] {
  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'keyboard',
      method,
      target: { pageId },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    press: async (key: string, options?: Record<string, unknown>) =>
      invoke('press', [key, options ?? {}]),
    type: async (text: string, options?: Record<string, unknown>) =>
      invoke('type', [text, options ?? {}]),
  } as Page['keyboard'];
}

function createRemoteLocatorProxy(
  client: BrowserDaemonHttpClient,
  pageId: string,
  pageState: RemotePageState,
  steps: LocatorStep[],
): ReturnType<Page['locator']> {
  const invoke = async (method: string, args: unknown[] = []) => {
    const response = await client.request({
      kind: 'locator',
      method,
      target: { pageId, steps },
      args: args.map((arg) => serializeValue(arg)),
    });
    return decodeResult(client, response, pageState);
  };

  return {
    locator: (selector: string) =>
      createRemoteLocatorProxy(client, pageId, pageState, [
        ...steps,
        { type: 'locator', selector },
      ]),
    first: () => createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'first' }]),
    last: () => createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'last' }]),
    nth: (index: number) =>
      createRemoteLocatorProxy(client, pageId, pageState, [...steps, { type: 'nth', index }]),
    waitFor: async (options?: Record<string, unknown>) => invoke('waitFor', [options ?? {}]),
    isVisible: async (options?: Record<string, unknown>) => invoke('isVisible', [options ?? {}]),
    click: async (options?: Record<string, unknown>) => invoke('click', [options ?? {}]),
    fill: async (value: string) => invoke('fill', [value]),
    count: async () => invoke('count'),
    textContent: async (options?: Record<string, unknown>) =>
      invoke('textContent', [options ?? {}]),
    innerHTML: async (options?: Record<string, unknown>) => invoke('innerHTML', [options ?? {}]),
    setInputFiles: async (files: string | string[]) => invoke('setInputFiles', [files]),
    evaluate: async (pageFunction: unknown, arg?: unknown) =>
      invoke('evaluate', [pageFunction, arg]),
  } as unknown as ReturnType<Page['locator']>;
}

function createRemoteFileChooserProxy(
  client: BrowserDaemonHttpClient,
  eventId: string,
): FileChooser {
  return {
    setFiles: async (files: string | string[]) => {
      await client.request({
        kind: 'event',
        method: 'setFiles',
        target: { eventId },
        args: [serializeValue(files)],
      });
    },
  } as unknown as FileChooser;
}

function createRemoteDownloadProxy(
  client: BrowserDaemonHttpClient,
  eventId: string,
  suggestedFilename: string,
): Download {
  return {
    suggestedFilename: () => suggestedFilename,
    saveAs: async (filePath: string) => {
      await client.request({
        kind: 'event',
        method: 'saveAs',
        target: { eventId },
        args: [serializeValue(filePath)],
      });
    },
  } as unknown as Download;
}

function getDaemonStatePathInternal(): string {
  return path.join(getAppDir(), DAEMON_FILE);
}

export function getDaemonStatePath(): string {
  return getDaemonStatePathInternal();
}

export async function clearDaemonState(): Promise<void> {
  await rm(getDaemonStatePathInternal(), { force: true }).catch(() => {
    // ignore
  });
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(getDaemonStatePathInternal(), 'utf-8');
    const state = JSON.parse(raw) as Partial<DaemonState>;
    if (
      typeof state.pid !== 'number' ||
      typeof state.port !== 'number' ||
      typeof state.token !== 'string'
    ) {
      return null;
    }

    if (!isProcessAlive(state.pid)) {
      await clearDaemonState();
      return null;
    }

    return {
      pid: state.pid,
      port: state.port,
      token: state.token,
      headless: Boolean(state.headless),
      createdAt: typeof state.createdAt === 'string' ? state.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function pingDaemon(state: DaemonState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function acquireDaemonStartLock() {
  return acquireProfileLock(DAEMON_LOCK_DIR, {
    timeoutMs: STARTUP_TIMEOUT_MS * 2,
    pollMs: 200,
  });
}

function getServerEntryPoint(): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const jsPath = path.join(currentDir, 'server.js');
  const tsPath = path.join(currentDir, 'server.ts');
  const sourcePath = currentFile.endsWith('.ts') ? tsPath : jsPath;

  if (sourcePath.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: ['--import', 'tsx', sourcePath],
    };
  }

  return {
    command: process.execPath,
    args: [sourcePath],
  };
}

async function waitForDaemonReady(headless: boolean): Promise<DaemonState> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const state = await readDaemonState();
    if (state && isDaemonCompatible(state, headless)) {
      const healthy = await pingDaemon(state);
      if (healthy) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for browser daemon to start');
}

async function startDaemon(headless: boolean): Promise<DaemonState> {
  const entry = getServerEntryPoint();
  const child = spawn(entry.command, entry.args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TEN_X_CHAT_BROWSER_HEADLESS: headless ? '1' : '0',
      TEN_X_CHAT_BROWSER_STATE_FILE: getDaemonStatePathInternal(),
    },
  });
  child.unref();
  return waitForDaemonReady(headless);
}

async function ensureDaemonState(headless: boolean): Promise<DaemonState> {
  const existing = await readDaemonState();
  if (existing && isDaemonCompatible(existing, headless) && (await pingDaemon(existing))) {
    return existing;
  }

  const lock = await acquireDaemonStartLock();
  try {
    const current = await readDaemonState();
    if (current) {
      const healthy = await pingDaemon(current);
      if (healthy && isDaemonCompatible(current, headless)) {
        return current;
      }

      if (healthy) {
        await new BrowserDaemonHttpClient(current).stop();

        if (isProcessAlive(current.pid)) {
          try {
            process.kill(current.pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
      }

      await clearDaemonState();
    }

    return startDaemon(headless);
  } finally {
    await lock.release();
  }
}

async function getDaemonClient(headless = true): Promise<BrowserDaemonHttpClient> {
  const state = await ensureDaemonState(headless);
  return new BrowserDaemonHttpClient(state);
}

export async function stopDaemon(): Promise<void> {
  const state = await readDaemonState();
  if (!state) return;

  const healthy = await pingDaemon(state);
  if (!healthy) {
    await clearDaemonState();
    return;
  }

  const client = new BrowserDaemonHttpClient(state);
  await client.stop();

  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  await clearDaemonState();
}

export async function getOrLaunchBrowserDaemon(headless = true): Promise<Browser> {
  const client = await getDaemonClient(headless);
  return createRemoteBrowserProxy(client);
}

export async function launchSharedBrowserSession(
  opts: SharedBrowserLaunchOptions,
): Promise<BrowserSessionProxy> {
  const { headless = true, url } = opts;
  const client = await getDaemonClient(headless);
  const storageStatePath = await loadStorageState();

  const browser = createRemoteBrowserProxy(client);
  const context = (await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  })) as BrowserContext;
  const page = (await context.newPage()) as Page;

  try {
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await context.close().catch(() => {
      // best effort
    });
    throw error;
  }

  const close = async () => {
    try {
      await saveStorageState(context);
    } catch {
      // best effort
    }

    await page.close().catch(() => {
      // already closed
    });
    await context.close().catch(() => {
      // already closed
    });
  };

  return { context, page, close };
}

export async function registerDaemonTab(): Promise<string> {
  const client = await getDaemonClient(true);
  const response = await client.request({
    kind: 'tabs',
    method: 'register',
    args: [serializeValue(randomUUID())],
  });
  const result = await decodeResult(client, response);
  return typeof result === 'string' ? result : '';
}

export async function unregisterDaemonTab(tabKey: string): Promise<number> {
  const state = await readDaemonState();
  if (!state) return 0;

  const client = new BrowserDaemonHttpClient(state);
  try {
    const response = await client.request({
      kind: 'tabs',
      method: 'unregister',
      args: [serializeValue(tabKey)],
    });
    const result = await decodeResult(client, response);
    return typeof result === 'number' ? result : 0;
  } catch {
    return 0;
  }
}

export async function readLiveTabCount(): Promise<number> {
  const state = await readDaemonState();
  if (!state) return 0;

  const client = new BrowserDaemonHttpClient(state);
  try {
    return await client.getLiveTabCount();
  } catch {
    return 0;
  }
}

export type { WaitForUrlPredicate };
