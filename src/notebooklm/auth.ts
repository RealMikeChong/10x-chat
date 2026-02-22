import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ConfigurationError } from './errors.js';

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins?: unknown[];
}

const MINIMUM_REQUIRED_COOKIES = new Set(['SID']);

const ALLOWED_COOKIE_DOMAINS = new Set([
  '.google.com',
  'notebooklm.google.com',
  '.googleusercontent.com',
]);

const GOOGLE_REGIONAL_CCTLDS = new Set([
  'com.sg',
  'com.au',
  'com.br',
  'com.mx',
  'com.ar',
  'com.hk',
  'com.tw',
  'com.my',
  'com.ph',
  'com.vn',
  'com.pk',
  'com.bd',
  'com.ng',
  'com.eg',
  'com.tr',
  'com.ua',
  'com.co',
  'com.pe',
  'com.sa',
  'com.ae',
  'co.uk',
  'co.jp',
  'co.in',
  'co.kr',
  'co.za',
  'co.nz',
  'co.id',
  'co.th',
  'co.il',
  'co.ve',
  'co.cr',
  'co.ke',
  'co.ug',
  'co.tz',
  'co.ma',
  'co.ao',
  'co.mz',
  'co.zw',
  'co.bw',
  'cn',
  'de',
  'fr',
  'it',
  'es',
  'nl',
  'pl',
  'ru',
  'ca',
  'be',
  'at',
  'ch',
  'se',
  'no',
  'dk',
  'fi',
  'pt',
  'gr',
  'cz',
  'ro',
  'hu',
  'ie',
  'sk',
  'bg',
  'hr',
  'si',
  'lt',
  'lv',
  'ee',
  'lu',
  'cl',
  'cat',
]);

function isGoogleDomain(domain: string): boolean {
  if (domain === '.google.com') {
    return true;
  }

  if (domain.startsWith('.google.')) {
    return GOOGLE_REGIONAL_CCTLDS.has(domain.slice(8));
  }

  return false;
}

function isAllowedAuthDomain(domain: string): boolean {
  return ALLOWED_COOKIE_DOMAINS.has(domain) || isGoogleDomain(domain);
}

function isAllowedCookieDomain(domain: string): boolean {
  if (ALLOWED_COOKIE_DOMAINS.has(domain)) {
    return true;
  }

  if (isGoogleDomain(domain)) {
    return true;
  }

  return (
    domain.endsWith('.google.com') ||
    domain.endsWith('.googleusercontent.com') ||
    domain.endsWith('.usercontent.google.com')
  );
}

function getGeminiProfileDir(): string {
  const home = process.env.TEN_X_CHAT_HOME
    ? process.env.TEN_X_CHAT_HOME.replace(/^~(?=$|[/])/, process.env.HOME ?? '')
    : path.join(process.env.HOME ?? '', '.10x-chat');
  return process.env.NOTEBOOKLM_PROFILE_DIR ?? path.join(home, 'profiles', 'gemini');
}

function isGoogleAuthRedirect(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'accounts.google.com' || hostname.endsWith('.accounts.google.com');
  } catch {
    return false;
  }
}

function containsGoogleAuthRedirect(text: string): boolean {
  const regex = /https?:\/\/[^\s"'<>]+/g;
  const urls = text.match(regex) ?? [];
  return urls.some((value) => isGoogleAuthRedirect(value));
}

async function readProfileStorageState(profileDir?: string): Promise<PlaywrightStorageState> {
  const dir = profileDir ?? getGeminiProfileDir();
  const storageStatePath = path.join(dir, 'storage_state.json');

  try {
    const raw = await readFile(storageStatePath, 'utf-8');
    const parsed = JSON.parse(raw) as PlaywrightStorageState;
    if (Array.isArray(parsed.cookies)) {
      return parsed;
    }
  } catch {
    // Fall back to extracting storage state from the persistent profile.
  }

  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });

  try {
    return (await context.storageState()) as PlaywrightStorageState;
  } finally {
    await context.close();
  }
}

export function extractCookiesFromStorage(
  storageState: PlaywrightStorageState,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieDomains: Record<string, string> = {};

  for (const cookie of storageState.cookies ?? []) {
    const domain = cookie.domain ?? '';
    const name = cookie.name;
    if (!name || !isAllowedAuthDomain(domain)) {
      continue;
    }

    const isBaseDomain = domain === '.google.com';
    if (!(name in cookies) || isBaseDomain) {
      cookies[name] = cookie.value ?? '';
      cookieDomains[name] = domain;
    }
  }

  const missing = [...MINIMUM_REQUIRED_COOKIES].filter((cookie) => !(cookie in cookies));
  if (missing.length > 0) {
    const allDomains = new Set((storageState.cookies ?? []).map((cookie) => cookie.domain ?? ''));
    const googleDomains = [...allDomains].filter((domain) =>
      domain.toLowerCase().includes('google'),
    );
    const foundNames = Object.keys(cookies).slice(0, 5);

    const parts = [`Missing required cookies: ${missing.join(', ')}`];
    if (foundNames.length > 0) {
      parts.push(
        `Found cookies: ${foundNames.join(', ')}${Object.keys(cookies).length > 5 ? '...' : ''}`,
      );
    }
    if (googleDomains.length > 0) {
      parts.push(`Google domains in storage: ${googleDomains.join(', ')}`);
    }
    parts.push('Re-authenticate Gemini profile if needed (10x-chat login gemini).');

    throw new ConfigurationError(parts.join('\n'));
  }

  return cookies;
}

export function extractCsrfFromHtml(html: string, finalUrl = ''): string {
  const match = /"SNlM0e"\s*:\s*"([^"]+)"/.exec(html);
  if (!match) {
    if (isGoogleAuthRedirect(finalUrl) || containsGoogleAuthRedirect(html)) {
      throw new ConfigurationError('Authentication expired or invalid. Re-authenticate Gemini.');
    }

    throw new ConfigurationError(
      `CSRF token not found in HTML. Final URL: ${finalUrl}. Page structure may have changed.`,
    );
  }
  return match[1] ?? '';
}

export function extractSessionIdFromHtml(html: string, finalUrl = ''): string {
  const match = /"FdrFJe"\s*:\s*"([^"]+)"/.exec(html);
  if (!match) {
    if (isGoogleAuthRedirect(finalUrl) || containsGoogleAuthRedirect(html)) {
      throw new ConfigurationError('Authentication expired or invalid. Re-authenticate Gemini.');
    }

    throw new ConfigurationError(
      `Session ID not found in HTML. Final URL: ${finalUrl}. Page structure may have changed.`,
    );
  }
  return match[1] ?? '';
}

export interface AuthTokens {
  cookies: Record<string, string>;
  csrfToken: string;
  sessionId: string;
  cookieHeader: string;
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadStorageCookies(profileDir?: string): Promise<PlaywrightCookie[]> {
  const state = await readProfileStorageState(profileDir);
  return (state.cookies ?? []).filter((cookie) => {
    if (!cookie.name || !cookie.value) {
      return false;
    }

    const domain = cookie.domain ?? '';
    return isAllowedCookieDomain(domain);
  });
}

export async function loadAuthFromStorage(profileDir?: string): Promise<Record<string, string>> {
  const storageState = await readProfileStorageState(profileDir);
  return extractCookiesFromStorage(storageState);
}

export async function fetchTokens(cookies: Record<string, string>): Promise<[string, string]> {
  const response = await fetchWithTimeout(
    'https://notebooklm.google.com/',
    {
      method: 'GET',
      headers: {
        Cookie: buildCookieHeader(cookies),
      },
      redirect: 'follow',
    },
    30_000,
  );

  if (!response.ok) {
    throw new ConfigurationError(
      `Failed to fetch NotebookLM tokens. HTTP ${response.status} ${response.statusText}`,
    );
  }

  const finalUrl = response.url;
  if (isGoogleAuthRedirect(finalUrl)) {
    throw new ConfigurationError(
      `Authentication expired or invalid. Redirected to: ${finalUrl}. Re-authenticate Gemini profile.`,
    );
  }

  const html = await response.text();
  const csrfToken = extractCsrfFromHtml(html, finalUrl);
  const sessionId = extractSessionIdFromHtml(html, finalUrl);

  return [csrfToken, sessionId];
}

export const AuthTokens = {
  async fromStorage(profileDir?: string): Promise<AuthTokens> {
    const cookies = await loadAuthFromStorage(profileDir);
    const [csrfToken, sessionId] = await fetchTokens(cookies);

    return {
      cookies,
      csrfToken,
      sessionId,
      cookieHeader: buildCookieHeader(cookies),
    };
  },
};
