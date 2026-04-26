import { describe, expect, it } from 'vitest';
import { extractGrokFailureText, GROK_CONFIG, grokActions } from '../src/providers/grok.js';

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
      expect(GROK_CONFIG.models).toContain('Auto');
    });

    it('should default to Auto model', () => {
      expect(GROK_CONFIG.defaultModel).toBe('Auto');
    });

    it('should have a 5-minute default timeout', () => {
      expect(GROK_CONFIG.defaultTimeoutMs).toBe(5 * 60 * 1000);
    });
  });

  describe('extractGrokFailureText', () => {
    it('detects Grok no-response service failures', () => {
      expect(
        extractGrokFailureText(
          'No response. Grok was unable to finish replying. Please try again later or use a different model. Retry Auto',
        ),
      ).toBe(
        'Grok was unable to finish replying. Please try again later or use a different model.',
      );
    });

    it('does not flag normal assistant responses', () => {
      expect(extractGrokFailureText('OK')).toBeNull();
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
