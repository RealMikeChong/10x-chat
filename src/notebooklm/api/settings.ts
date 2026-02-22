import type { ClientCore } from '../core.js';
import { RPCMethod } from '../rpc/types.js';

function extractNestedValue(data: unknown[] | null, path: number[]): string | null {
  try {
    let result: unknown = data;
    for (const index of path) {
      if (!Array.isArray(result)) {
        return null;
      }
      result = result[index];
    }

    if (typeof result === 'string' && result.length > 0) {
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

export class SettingsAPI {
  private static readonly SET_LANGUAGE_PATH = [2, 4, 0];
  private static readonly GET_SETTINGS_PATH = [0, 2, 4, 0];

  private readonly core: ClientCore;

  public constructor(core: ClientCore) {
    this.core = core;
  }

  public async setOutputLanguage(language: string): Promise<string | null> {
    if (!language) {
      console.warn(
        'Empty string not supported - use getOutputLanguage() to read the current setting. Passing empty string would reset language to default.',
      );
      return null;
    }

    console.debug(`Setting output language: ${language}`);

    const params = [[[null, [[null, null, null, null, [language]]]]]];
    const raw = await this.core.rpcCall(RPCMethod.SET_USER_SETTINGS, params, '/');

    const currentLanguage = extractNestedValue(
      Array.isArray(raw) ? raw : null,
      SettingsAPI.SET_LANGUAGE_PATH,
    );
    this.logLanguageResult(currentLanguage, 'Output language is now');
    return currentLanguage;
  }

  public async getOutputLanguage(): Promise<string | null> {
    console.debug('Fetching user settings to get output language');

    const params = [null, [1, null, null, null, null, null, null, null, null, null, [1]]];
    const raw = await this.core.rpcCall(RPCMethod.GET_USER_SETTINGS, params, '/');

    const currentLanguage = extractNestedValue(
      Array.isArray(raw) ? raw : null,
      SettingsAPI.GET_SETTINGS_PATH,
    );
    this.logLanguageResult(currentLanguage, 'Current output language');
    return currentLanguage;
  }

  private logLanguageResult(language: string | null, successPrefix: string): void {
    if (language) {
      console.debug(`${successPrefix}: ${language}`);
      return;
    }

    console.debug('Could not parse language from response');
  }
}
