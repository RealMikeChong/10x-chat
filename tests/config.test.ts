import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Config Loading', () => {
  const originalEnv = process.env;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'ten-x-chat-config-'));
    process.env = {
      ...originalEnv,
      TEN_X_CHAT_HOME: tempHome,
    };
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it('loads JSON config from disk', async () => {
    await writeFile(
      path.join(tempHome, 'config.json'),
      JSON.stringify({ profileMode: 'isolated', headless: false }, null, 2),
      'utf8',
    );

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.profileMode).toBe('isolated');
    expect(config.headless).toBe(false);
  });

  it('loads JSON5 config from disk', async () => {
    await writeFile(
      path.join(tempHome, 'config.json'),
      '{\n        // provider profile mode\n        profileMode: "isolated",\n        headless: false,\n      }',
      'utf8',
    );

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();

    expect(config.profileMode).toBe('isolated');
    expect(config.headless).toBe(false);
  });
});
