import { readLiveTabCount, registerDaemonTab, unregisterDaemonTab } from './daemon.js';

/**
 * Shared browser tab ref-counting is handled by the HTTP daemon.
 * These wrappers keep the public API stable.
 */

export async function registerTab(): Promise<string> {
  return registerDaemonTab();
}

export async function unregisterTab(tabKey: string): Promise<number> {
  return unregisterDaemonTab(tabKey);
}

export async function getLiveTabCount(): Promise<number> {
  return readLiveTabCount();
}
