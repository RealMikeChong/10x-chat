// HTTP daemon architecture inspired by gstack (github.com/garrytan/gstack)

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Browser, BrowserContext, Download, FileChooser, Locator, Page } from 'playwright';
import { getAppDir } from '../paths.js';
import { getChromium, getEngineName } from './engine.js';
import { CHROMIUM_ARGS } from './process.js';
import { detectChromeChannel, STEALTH_INIT_SCRIPT } from './stealth.js';

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type SerializedValue =
  | JsonValue
  | { __type: 'regexp'; source: string; flags: string }
  | { __type: 'function'; source: string };

type LocatorStep =
  | { type: 'locator'; selector: string }
  | { type: 'getByRole'; role: string; options?: JsonValue }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'nth'; index: number };

interface RpcRequest {
  kind: 'browser' | 'context' | 'page' | 'locator' | 'keyboard' | 'tabs' | 'event';
  method: string;
  target?: {
    contextId?: string;
    pageId?: string;
    steps?: LocatorStep[];
    eventId?: string;
  };
  args?: SerializedValue[];
}

interface RpcSuccess {
  ok: true;
  result?: JsonValue | RemoteHandle;
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

interface DaemonStateFile {
  pid: number;
  port: number;
  token: string;
  headless: boolean;
  createdAt: string;
}

const STATE_PATH =
  process.env.TEN_X_CHAT_BROWSER_STATE_FILE ?? path.join(getAppDir(), 'browser-daemon.json');
const AUTH_TOKEN = randomUUID();
const HEADLESS = process.env.TEN_X_CHAT_BROWSER_HEADLESS !== '0';
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_PORT = 10_000;
const MAX_PORT = 60_000;

let browser: Browser | null = null;
let lastActivity = Date.now();
let activePageCount = 0;
let shuttingDown = false;

const contexts = new Map<string, BrowserContext>();
const pages = new Map<string, { page: Page; contextId: string }>();
const manualTabs = new Set<string>();
const fileChoosers = new Map<string, FileChooser>();
const downloads = new Map<string, Download>();

function touchActivity(): void {
  lastActivity = Date.now();
}

function serializeValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function deserializeValue(value: SerializedValue): unknown {
  if (value && typeof value === 'object') {
    if ('__type' in value && value.__type === 'regexp') {
      return new RegExp(String(value.source), String(value.flags));
    }

    if ('__type' in value && value.__type === 'function') {
      return new Function(`return (${value.source});`)();
    }

    if (Array.isArray(value)) {
      return value.map((entry) => deserializeValue(entry as SerializedValue));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        deserializeValue(entry as SerializedValue),
      ]),
    );
  }

  return value;
}

function toContextHandle(contextId: string): RemoteHandle {
  return {
    __handle: true,
    handleType: 'context',
    id: contextId,
  };
}

function toPageHandle(pageId: string, contextId: string, page: Page): RemoteHandle {
  return {
    __handle: true,
    handleType: 'page',
    id: pageId,
    contextId,
    pageId,
    url: page.url(),
  };
}

function toFileChooserHandle(eventId: string): RemoteHandle {
  return {
    __handle: true,
    handleType: 'filechooser',
    id: eventId,
  };
}

function toDownloadHandle(eventId: string, download: Download): RemoteHandle {
  return {
    __handle: true,
    handleType: 'download',
    id: eventId,
    suggestedFilename: download.suggestedFilename(),
  };
}

async function writeStateFile(port: number): Promise<void> {
  const state: DaemonStateFile = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    headless: HEADLESS,
    createdAt: new Date().toISOString(),
  };

  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmpPath, STATE_PATH);
  await chmod(STATE_PATH, 0o600).catch(() => {
    // ignore chmod failures
  });
}

async function clearStateFile(): Promise<void> {
  await rm(STATE_PATH, { force: true }).catch(() => {
    // ignore
  });
}

async function findPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    const available = await new Promise<boolean>((resolve) => {
      const tester = createServer();
      tester.once('error', () => resolve(false));
      tester.once('listening', () => {
        tester.close(() => resolve(true));
      });
      tester.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(`Unable to find an available port in range ${MIN_PORT}-${MAX_PORT}`);
}

function getContext(contextId?: string): BrowserContext {
  if (!contextId) {
    throw new Error('Missing contextId');
  }

  const context = contexts.get(contextId);
  if (!context) {
    throw new Error(`Context not found: ${contextId}`);
  }
  return context;
}

function getPage(pageId?: string): { page: Page; contextId: string } {
  if (!pageId) {
    throw new Error('Missing pageId');
  }

  const page = pages.get(pageId);
  if (!page) {
    throw new Error(`Page not found: ${pageId}`);
  }
  return page;
}

function resolveLocator(page: Page, steps?: LocatorStep[]): Locator {
  if (!steps || steps.length === 0) {
    throw new Error('Missing locator steps');
  }

  let current: Page | Locator = page;
  for (const step of steps) {
    switch (step.type) {
      case 'locator':
        current = current.locator(step.selector);
        break;
      case 'getByRole':
        current = current.getByRole(
          step.role as never,
          deserializeValue(step.options ?? {}) as never,
        );
        break;
      case 'first':
        current = (current as Locator).first();
        break;
      case 'last':
        current = (current as Locator).last();
        break;
      case 'nth':
        current = (current as Locator).nth(step.index);
        break;
    }
  }

  return current as Locator;
}

function buildPageState(pageId: string): { pageId: string; url: string } {
  const entry = pages.get(pageId);
  return {
    pageId,
    url: entry?.page.url() ?? 'about:blank',
  };
}

function attachPage(page: Page, contextId: string): string {
  const pageId = randomUUID();
  pages.set(pageId, { page, contextId });
  activePageCount++;

  page.on('close', () => {
    if (pages.delete(pageId)) {
      activePageCount = Math.max(0, activePageCount - 1);
    }
  });

  return pageId;
}

async function handleRpc(body: RpcRequest): Promise<RpcResponse> {
  const args = (body.args ?? []).map((arg) => deserializeValue(arg));

  switch (body.kind) {
    case 'browser': {
      if (!browser) throw new Error('Browser is not available');
      if (body.method !== 'newContext') {
        throw new Error(`Unsupported browser method: ${body.method}`);
      }

      const context = await browser.newContext((args[0] as Record<string, unknown>) ?? {});
      // Inject stealth patches into every page created in this context
      await context.addInitScript(STEALTH_INIT_SCRIPT);
      const contextId = randomUUID();
      contexts.set(contextId, context);
      return { ok: true, result: toContextHandle(contextId) };
    }

    case 'context': {
      const context = getContext(body.target?.contextId);

      if (body.method === 'newPage') {
        const page = await context.newPage();
        const pageId = attachPage(page, body.target?.contextId ?? '');
        return {
          ok: true,
          result: toPageHandle(pageId, body.target?.contextId ?? '', page),
          pageState: buildPageState(pageId),
        };
      }

      if (body.method === 'close') {
        await context.close();
        contexts.delete(body.target?.contextId ?? '');
        return { ok: true, result: null };
      }

      if (body.method === 'storageState') {
        const options = (args[0] as Record<string, unknown>) ?? {};
        const result = await context.storageState(options as never);
        return { ok: true, result: serializeValue(result) };
      }

      if (body.method === 'cookies') {
        const result = await context.cookies((args[0] as string[]) ?? []);
        return { ok: true, result: serializeValue(result) };
      }

      throw new Error(`Unsupported context method: ${body.method}`);
    }

    case 'page': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';

      switch (body.method) {
        case 'goto':
          await page.goto(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForTimeout':
          await page.waitForTimeout(Number(args[0] ?? 0));
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForLoadState':
          await page.waitForLoadState((args[0] as never) ?? 'load');
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'waitForURL': {
          const matcher = args[0];
          const options = (args[1] as Record<string, unknown>) ?? {};
          if (typeof matcher === 'string' || matcher instanceof RegExp) {
            await page.waitForURL(matcher, options as never);
          } else if (matcher && typeof matcher === 'object') {
            const predicate = matcher as { mode?: string; value?: string };
            if (predicate.mode === 'changes') {
              await page.waitForURL((url) => url.toString() !== predicate.value, options as never);
            } else if (predicate.mode === 'startsWith') {
              await page.waitForURL(
                (url) => url.pathname.startsWith(predicate.value ?? ''),
                options as never,
              );
            } else {
              throw new Error('Unsupported waitForURL predicate');
            }
          } else {
            throw new Error('Unsupported waitForURL matcher');
          }
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        }
        case 'waitForEvent': {
          const eventName = String(args[0] ?? '');
          const options = (args[1] as Record<string, unknown>) ?? {};
          if (eventName === 'filechooser') {
            const fileChooser = await page.waitForEvent('filechooser', options as never);
            const eventId = randomUUID();
            fileChoosers.set(eventId, fileChooser);
            return {
              ok: true,
              result: toFileChooserHandle(eventId),
              pageState: buildPageState(pageId),
            };
          }
          if (eventName === 'download') {
            const download = await page.waitForEvent('download', options as never);
            const eventId = randomUUID();
            downloads.set(eventId, download);
            return {
              ok: true,
              result: toDownloadHandle(eventId, download),
              pageState: buildPageState(pageId),
            };
          }
          throw new Error(`Unsupported page event: ${eventName}`);
        }
        case 'evaluate': {
          const pageFunction = args[0];
          const arg = args[1];
          let result: unknown;
          if (typeof pageFunction === 'string') {
            result = await page.evaluate(pageFunction);
          } else if (typeof pageFunction === 'function') {
            result = await page.evaluate(pageFunction as never, arg as never);
          } else {
            throw new Error('Unsupported evaluate payload');
          }
          return { ok: true, result: serializeValue(result), pageState: buildPageState(pageId) };
        }
        case 'close':
          await page.close();
          return { ok: true, result: null, pageState: { pageId, url: 'about:blank' } };
        case 'title': {
          const result = await page.title();
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        default:
          throw new Error(`Unsupported page method: ${body.method}`);
      }
    }

    case 'keyboard': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';

      if (body.method === 'press') {
        await page.keyboard.press(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
        return { ok: true, result: null, pageState: buildPageState(pageId) };
      }

      if (body.method === 'type') {
        await page.keyboard.type(args[0] as string, (args[1] as Record<string, unknown>) ?? {});
        return { ok: true, result: null, pageState: buildPageState(pageId) };
      }

      throw new Error(`Unsupported keyboard method: ${body.method}`);
    }

    case 'locator': {
      const { page } = getPage(body.target?.pageId);
      const pageId = body.target?.pageId ?? '';
      const locator = resolveLocator(page, body.target?.steps);

      switch (body.method) {
        case 'waitFor':
          await locator.waitFor(((args[0] as Record<string, unknown>) ?? {}) as never);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'isVisible': {
          const result = await locator.isVisible(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'click':
          await locator.click(((args[0] as Record<string, unknown>) ?? {}) as never);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'fill':
          await locator.fill(String(args[0] ?? ''));
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'count': {
          const result = await locator.count();
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'textContent': {
          const result = await locator.textContent(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result: serializeValue(result), pageState: buildPageState(pageId) };
        }
        case 'innerHTML': {
          const result = await locator.innerHTML(
            ((args[0] as Record<string, unknown>) ?? {}) as never,
          );
          return { ok: true, result, pageState: buildPageState(pageId) };
        }
        case 'setInputFiles':
          await locator.setInputFiles((args[0] as string | string[]) ?? []);
          return { ok: true, result: null, pageState: buildPageState(pageId) };
        case 'evaluate': {
          const pageFunction = args[0];
          const arg = args[1];
          let result: unknown;
          if (typeof pageFunction === 'function' || typeof pageFunction === 'string') {
            result =
              arg !== undefined
                ? await locator.evaluate(pageFunction as never, arg as never)
                : await locator.evaluate(pageFunction as never);
          } else {
            throw new Error('Unsupported evaluate payload');
          }
          return {
            ok: true,
            result: serializeValue(result),
            pageState: buildPageState(pageId),
          };
        }
        default:
          throw new Error(`Unsupported locator method: ${body.method}`);
      }
    }

    case 'tabs': {
      if (body.method === 'register') {
        const tabKey = String(args[0] ?? randomUUID());
        manualTabs.add(tabKey);
        return { ok: true, result: tabKey };
      }

      if (body.method === 'unregister') {
        manualTabs.delete(String(args[0] ?? ''));
        return { ok: true, result: Math.max(manualTabs.size, activePageCount) };
      }

      throw new Error(`Unsupported tabs method: ${body.method}`);
    }

    case 'event': {
      if (body.method === 'setFiles') {
        const chooser = fileChoosers.get(body.target?.eventId ?? '');
        if (!chooser) throw new Error('File chooser not found');
        await chooser.setFiles((args[0] as string | string[]) ?? []);
        fileChoosers.delete(body.target?.eventId ?? '');
        return { ok: true, result: null };
      }

      if (body.method === 'saveAs') {
        const download = downloads.get(body.target?.eventId ?? '');
        if (!download) throw new Error('Download not found');
        await download.saveAs(String(args[0] ?? ''));
        downloads.delete(body.target?.eventId ?? '');
        return { ok: true, result: null };
      }

      throw new Error(`Unsupported event method: ${body.method}`);
    }
  }
}

async function shutdown(server?: ReturnType<typeof createServer>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await clearStateFile();

  // Close browser first — this aborts any pending Playwright actions, which
  // unblocks any active long-poll HTTP connections to the server.
  // Add a hard 3s timeout: browser.close() can hang if Playwright's IPC
  // channel is already broken (e.g. Chrome crashed or was kill -9'd).
  if (browser) {
    browser.removeAllListeners('disconnected');
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  // Stop accepting new connections. Active connections will have been aborted
  // by browser.close() above, so this resolves quickly. We add a 2s hard
  // timeout so a stuck connection never prevents the process from exiting.
  if (server) {
    await Promise.race([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {
      // ignore
    });
  }

  process.exit(0);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

async function main(): Promise<void> {
  const channel = detectChromeChannel();

  const chromium = await getChromium();
  const engineName = getEngineName();
  console.log(`Browser engine: ${engineName}${channel ? ' (channel: chrome)' : ''}`);

  browser = await chromium.launch({
    headless: HEADLESS,
    ...(channel ? { channel } : {}),
    args: CHROMIUM_ARGS,
  });

  // Inject stealth script into the default browser context
  // so every new page automatically gets the anti-detection patches
  browser.on('disconnected', () => {
    void clearStateFile().finally(() => process.exit(1));
  });

  const idleInterval = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      void shutdown(server);
    }
  }, 60_000);
  idleInterval.unref();

  const port = await findPort();
  const server = createServer(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' } satisfies RpcError));
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          activeTabs: Math.max(manualTabs.size, activePageCount),
          headless: HEADLESS,
          pid: process.pid,
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        void shutdown(server);
      }, 0);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' } satisfies RpcError));
      return;
    }

    touchActivity();

    try {
      const body = (await readJsonBody(req)) as RpcRequest;
      const response = await handleRpc(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies RpcError),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  await writeStateFile(port);

  const cleanup = () => {
    void shutdown(server);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await clearStateFile();
  process.exit(1);
});
