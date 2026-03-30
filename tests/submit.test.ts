import { describe, expect, it, vi } from 'vitest';
import { submitPromptToComposer } from '../src/providers/submit.js';

function createSubmitPage(options: { contenteditable: boolean; fillFails?: boolean }) {
  const { contenteditable, fillFails = false } = options;
  const composer = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    fill: fillFails
      ? vi.fn(async () => {
          throw new Error('fill failed');
        })
      : vi.fn(async () => {}),
    evaluate: vi.fn(async (_fn: unknown, arg?: string) =>
      arg === undefined ? contenteditable : undefined,
    ),
  };

  const sendButton = {
    waitFor: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
  };

  const locator = vi.fn((selector: string) => {
    if (selector === '#composer') {
      return {
        first: () => composer,
      };
    }

    if (selector === '#send') {
      return {
        first: () => sendButton,
      };
    }

    throw new Error(`Unexpected selector: ${selector}`);
  });

  return {
    page: {
      locator,
      keyboard: {
        insertText: vi.fn(async () => {}),
        press: vi.fn(async () => {}),
      },
      waitForTimeout: vi.fn(async () => {}),
    },
    composer,
    sendButton,
  };
}

describe('submitPromptToComposer', () => {
  it('uses keyboard text insertion for contenteditable composers', async () => {
    const { page, composer, sendButton } = createSubmitPage({ contenteditable: true });

    await submitPromptToComposer(page as never, 'Hello from ProseMirror', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(composer.waitFor).toHaveBeenCalled();
    expect(composer.click).toHaveBeenCalled();
    expect(page.keyboard.press).toHaveBeenCalledWith('ControlOrMeta+a');
    expect(page.keyboard.press).toHaveBeenCalledWith('Backspace');
    expect(page.keyboard.insertText).toHaveBeenCalledWith('Hello from ProseMirror');
    expect(composer.fill).not.toHaveBeenCalled();
    expect(sendButton.click).toHaveBeenCalled();
  });

  it('still uses fill for textarea-style composers', async () => {
    const { page, composer, sendButton } = createSubmitPage({ contenteditable: false });

    await submitPromptToComposer(page as never, 'Hello from textarea', {
      composerSelector: '#composer',
      sendButtonSelector: '#send',
    });

    expect(composer.fill).toHaveBeenCalledWith('Hello from textarea');
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(sendButton.click).toHaveBeenCalled();
  });
});
