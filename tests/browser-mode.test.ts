import { describe, expect, it } from 'vitest';
import { resolveHeadlessMode } from '../src/browser/mode.js';

describe('resolveHeadlessMode', () => {
  it('forces headed mode for ChatGPT', () => {
    expect(resolveHeadlessMode('chatgpt', true)).toBe(false);
  });

  it('forces headed mode for Claude', () => {
    expect(resolveHeadlessMode('claude', true)).toBe(false);
  });

  it('keeps headless mode for Gemini when config prefers headless', () => {
    expect(resolveHeadlessMode('gemini', true)).toBe(true);
  });

  it('honors explicit headed override for any provider', () => {
    expect(resolveHeadlessMode('grok', true, true)).toBe(false);
  });
});
