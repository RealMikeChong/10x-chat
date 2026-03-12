import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigPath } from './paths.js';
import { type AppConfig, DEFAULT_CONFIG } from './types.js';

/** Load config from disk, falling back to defaults for missing keys. */
export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  try {
    const raw = await readFile(configPath, 'utf-8');
    // Dynamic import JSON5 only when needed
    const JSON5Module = await import('json5');
    const JSON5 = JSON5Module.default ?? JSON5Module;
    const parsed = JSON5.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Save config to disk. */
export async function saveConfig(config: AppConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
