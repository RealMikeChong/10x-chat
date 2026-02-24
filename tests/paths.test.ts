import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAppDir,
  getConfigPath,
  getIsolatedProfileDir,
  getProfileDir,
  getSessionDir,
  getSessionsDir,
  getSharedProfileDir,
} from '../src/paths.js';

describe('Paths', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return default app dir', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getAppDir()).toBe(path.join(os.homedir(), '.10x-chat'));
  });

  it('should respect TEN_X_CHAT_HOME env var', () => {
    process.env.TEN_X_CHAT_HOME = '/custom/path';
    expect(getAppDir()).toBe('/custom/path');
  });

  it('should return profile dir for a provider', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getProfileDir('chatgpt')).toBe(
      path.join(os.homedir(), '.10x-chat', 'profiles', 'chatgpt'),
    );
  });

  it('should return sessions dir', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getSessionsDir()).toBe(path.join(os.homedir(), '.10x-chat', 'sessions'));
  });

  it('should return session dir for a specific session', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getSessionDir('abc-123')).toBe(
      path.join(os.homedir(), '.10x-chat', 'sessions', 'abc-123'),
    );
  });

  it('should return config path', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getConfigPath()).toBe(path.join(os.homedir(), '.10x-chat', 'config.json'));
  });

  it('should return shared profile dir', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getSharedProfileDir()).toBe(
      path.join(os.homedir(), '.10x-chat', 'profiles', 'default'),
    );
  });

  it('should return isolated profile dir for a provider', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getIsolatedProfileDir('gemini')).toBe(
      path.join(os.homedir(), '.10x-chat', 'profiles', 'gemini'),
    );
  });

  it('should have getProfileDir as backward-compat alias for getIsolatedProfileDir', () => {
    delete process.env.TEN_X_CHAT_HOME;
    expect(getProfileDir('claude')).toBe(getIsolatedProfileDir('claude'));
  });
});
