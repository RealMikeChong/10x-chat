import { describe, expect, it } from 'vitest';
import { getProvider, isValidProvider, listProviders } from '../src/providers/registry.js';

describe('Provider Registry', () => {
  it('should list all providers', () => {
    const providers = listProviders();
    expect(providers).toContain('chatgpt');
    expect(providers).toContain('gemini');
    expect(providers).toContain('claude');
    expect(providers).toContain('grok');
    expect(providers).toHaveLength(4);
  });

  it('should get a provider by name', () => {
    const provider = getProvider('chatgpt');
    expect(provider.config.name).toBe('chatgpt');
    expect(provider.config.displayName).toBe('ChatGPT');
    expect(provider.config.url).toBe('https://chatgpt.com');
    expect(provider.actions).toBeDefined();
  });

  it('should throw for unknown provider', () => {
    expect(() => getProvider('unknown' as never)).toThrow('Unknown provider');
  });

  it('should validate provider names', () => {
    expect(isValidProvider('chatgpt')).toBe(true);
    expect(isValidProvider('gemini')).toBe(true);
    expect(isValidProvider('claude')).toBe(true);
    expect(isValidProvider('grok')).toBe(true);
    expect(isValidProvider('unknown')).toBe(false);
    expect(isValidProvider('')).toBe(false);
    // Prototype pollution guard
    expect(isValidProvider('toString')).toBe(false);
    expect(isValidProvider('__proto__')).toBe(false);
  });
});
