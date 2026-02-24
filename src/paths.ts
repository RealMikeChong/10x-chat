import os from 'node:os';
import path from 'node:path';

const APP_DIR_NAME = '.10x-chat';

/** Root directory for all 10x-chat data: ~/.10x-chat */
export function getAppDir(): string {
  return process.env.TEN_X_CHAT_HOME ?? path.join(os.homedir(), APP_DIR_NAME);
}

/** Shared profile directory: ~/.10x-chat/profiles/default */
export function getSharedProfileDir(): string {
  return path.join(getAppDir(), 'profiles', 'default');
}

/** Isolated profile directory for a specific provider: ~/.10x-chat/profiles/<provider> */
export function getIsolatedProfileDir(provider: string): string {
  return path.join(getAppDir(), 'profiles', provider);
}

/**
 * Get the effective profile directory based on mode.
 * - 'shared': single profile at ~/.10x-chat/profiles/default
 * - 'isolated': per-provider at ~/.10x-chat/profiles/<provider>
 *
 * @deprecated Use getSharedProfileDir() or getIsolatedProfileDir() with explicit mode.
 */
export function getProfileDir(provider: string): string {
  return getIsolatedProfileDir(provider);
}

/** Sessions root: ~/.10x-chat/sessions */
export function getSessionsDir(): string {
  return path.join(getAppDir(), 'sessions');
}

/** Session directory for a specific session: ~/.10x-chat/sessions/<id> */
export function getSessionDir(sessionId: string): string {
  return path.join(getSessionsDir(), sessionId);
}

/** Config file path: ~/.10x-chat/config.json */
export function getConfigPath(): string {
  return path.join(getAppDir(), 'config.json');
}
