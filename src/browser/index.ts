export { acquireProfileLock, type ProfileLock } from './lock.js';
export { type BrowserSession, type LaunchOptions, launchBrowser } from './manager.js';
export { loadStorageState, saveStorageState } from './state.js';
export { type DaemonState, getDaemonStatePath, readDaemonState, clearDaemonState, stopDaemon, getOrLaunchBrowserDaemon } from './daemon.js';
export { registerTab, unregisterTab, getLiveTabCount } from './tabs.js';
