import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getAppDir } from '../paths.js';

const NOTEBOOKLM_DIR_NAME = 'notebooklm';

/**
 * NotebookLM home directory.
 *
 * Precedence: `NOTEBOOKLM_HOME` env var > `~/.10x-chat/notebooklm`
 */
export function getHomeDir(create = false): string {
  const configured = process.env.NOTEBOOKLM_HOME;
  const resolved = configured
    ? path.resolve(configured.replace(/^~(?=$|[/])/, process.env.HOME ?? ''))
    : path.join(getAppDir(), NOTEBOOKLM_DIR_NAME);

  if (create) {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    try {
      chmodSync(resolved, 0o700);
    } catch {
      // Ignore chmod failures on filesystems/platforms that do not support Unix modes.
    }
  }

  return resolved;
}

export function getStoragePath(): string {
  return path.join(getHomeDir(), 'storage_state.json');
}

export function getContextPath(): string {
  return path.join(getHomeDir(), 'context.json');
}

export function getBrowserProfileDir(): string {
  return path.join(getHomeDir(), 'browser_profile');
}

export function getConfigPath(): string {
  return path.join(getHomeDir(), 'config.json');
}

export function getPathInfo(): Record<string, string> {
  const homeFromEnv = process.env.NOTEBOOKLM_HOME;
  return {
    homeDir: getHomeDir(),
    homeSource: homeFromEnv ? 'NOTEBOOKLM_HOME' : 'default (~/.10x-chat/notebooklm)',
    storagePath: getStoragePath(),
    contextPath: getContextPath(),
    configPath: getConfigPath(),
    browserProfileDir: getBrowserProfileDir(),
  };
}
