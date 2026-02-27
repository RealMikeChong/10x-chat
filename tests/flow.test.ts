import { describe, expect, it } from 'vitest';
import { FLOW_CONFIG, FLOW_SELECTORS, flowActions } from '../src/providers/flow.js';

describe('Flow Provider', () => {
  describe('FLOW_CONFIG', () => {
    it('should have correct provider name', () => {
      expect(FLOW_CONFIG.name).toBe('flow');
    });

    it('should have correct display name', () => {
      expect(FLOW_CONFIG.displayName).toBe('Google Flow');
    });

    it('should have correct URL', () => {
      expect(FLOW_CONFIG.url).toBe('https://labs.google/fx/tools/flow');
    });

    it('should have available models', () => {
      expect(FLOW_CONFIG.models).toBeDefined();
      expect(FLOW_CONFIG.models?.length).toBeGreaterThan(0);
      expect(FLOW_CONFIG.models).toContain('Veo 3.1 - Fast');
      expect(FLOW_CONFIG.models).toContain('Veo 3.1 - Quality');
      expect(FLOW_CONFIG.models).toContain('Veo 2 - Fast');
      expect(FLOW_CONFIG.models).toContain('Veo 2 - Quality');
    });

    it('should default to Veo 3.1 - Fast model', () => {
      expect(FLOW_CONFIG.defaultModel).toBe('Veo 3.1 - Fast');
    });

    it('should have a 10-minute default timeout for video generation', () => {
      expect(FLOW_CONFIG.defaultTimeoutMs).toBe(10 * 60 * 1000);
    });
  });

  describe('FLOW_SELECTORS', () => {
    it('should define navigation selectors', () => {
      expect(FLOW_SELECTORS.newProject).toBe('button:has-text("New project")');
      expect(FLOW_SELECTORS.goBack).toBe('button:has-text("Go Back")');
    });

    it('should define prompt composer selectors', () => {
      expect(FLOW_SELECTORS.composer).toBe('div[contenteditable="true"]');
      expect(FLOW_SELECTORS.composerTextbox).toBe('[role="textbox"]');
    });

    it('should define submit button selector', () => {
      expect(FLOW_SELECTORS.createButton).toBe('button:has-text("arrow_forward")');
    });

    it('should define output type tab selectors', () => {
      expect(FLOW_SELECTORS.imageTab).toBe('button[role="tab"]:has-text("Image")');
      expect(FLOW_SELECTORS.videoTab).toBe('button[role="tab"]:has-text("Video")');
    });

    it('should define video sub-mode tab selectors', () => {
      expect(FLOW_SELECTORS.ingredientsTab).toBe('button[role="tab"]:has-text("Ingredients")');
      expect(FLOW_SELECTORS.framesTab).toBe('button[role="tab"]:has-text("Frames")');
    });

    it('should define orientation selectors', () => {
      expect(FLOW_SELECTORS.landscapeBtn).toBe('button:has-text("Landscape")');
      expect(FLOW_SELECTORS.portraitBtn).toBe('button:has-text("Portrait")');
    });

    it('should define count selectors for 1-4', () => {
      expect(FLOW_SELECTORS.countX1).toBe('button[role="tab"]:has-text("x1")');
      expect(FLOW_SELECTORS.countX2).toBe('button[role="tab"]:has-text("x2")');
      expect(FLOW_SELECTORS.countX3).toBe('button[role="tab"]:has-text("x3")');
      expect(FLOW_SELECTORS.countX4).toBe('button[role="tab"]:has-text("x4")');
    });

    it('should define frame upload selectors', () => {
      expect(FLOW_SELECTORS.startFrame).toBe('text="Start"');
      expect(FLOW_SELECTORS.endFrame).toBe('text="End"');
    });

    it('should define file input selector', () => {
      expect(FLOW_SELECTORS.fileInput).toBe('input[type="file"][accept="image/*"]');
    });
  });

  describe('flowActions', () => {
    it('should export all required action methods', () => {
      expect(flowActions.isLoggedIn).toBeTypeOf('function');
      expect(flowActions.submitPrompt).toBeTypeOf('function');
      expect(flowActions.captureResponse).toBeTypeOf('function');
    });
  });
});
