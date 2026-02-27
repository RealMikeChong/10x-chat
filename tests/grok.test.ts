import { describe, expect, it } from 'vitest';
import { GROK_CONFIG, grokActions } from '../src/providers/grok.js';

describe('Grok Provider', () => {
  describe('GROK_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(GROK_CONFIG.name).toBe('grok');
    });

    it('should have correct display name', () => {
      expect(GROK_CONFIG.displayName).toBe('Grok');
    });

    it('should have correct URL', () => {
      expect(GROK_CONFIG.url).toBe('https://grok.com');
    });

    it('should have available models', () => {
      expect(GROK_CONFIG.models).toBeDefined();
      expect(GROK_CONFIG.models?.length).toBeGreaterThan(0);
      expect(GROK_CONFIG.models).toContain('grok-3');
    });

    it('should default to grok-3 model', () => {
      expect(GROK_CONFIG.defaultModel).toBe('grok-3');
    });

    it('should have a 5-minute default timeout', () => {
      expect(GROK_CONFIG.defaultTimeoutMs).toBe(5 * 60 * 1000);
    });
  });

  describe('grokActions', () => {
    it('should export all required action methods', () => {
      expect(grokActions.isLoggedIn).toBeTypeOf('function');
      expect(grokActions.submitPrompt).toBeTypeOf('function');
      expect(grokActions.captureResponse).toBeTypeOf('function');
    });

    it('should export optional attachFiles method', () => {
      expect(grokActions.attachFiles).toBeTypeOf('function');
    });
  });
});
