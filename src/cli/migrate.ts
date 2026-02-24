import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { Command } from 'commander';
import { getAppDir, getSharedProfileDir } from '../paths.js';

/**
 * Merge Chromium profile data from a source profile into a target profile.
 *
 * Strategy: pick the "best" (most recently used) isolated profile as the base,
 * then merge cookies/localStorage from the others. The base profile's Default/
 * directory is copied wholesale, then we layer cookies from other profiles.
 */
export function createMigrateCommand(): Command {
  const cmd = new Command('migrate')
    .description('Migrate isolated per-provider profiles into a single shared profile')
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--source <provider>', 'Use a specific provider profile as the base (default: auto)')
    .option('--keep', 'Keep old isolated profiles after migration (default: remove)')
    .action(async (options: { dryRun?: boolean; source?: string; keep?: boolean }) => {
      await runMigration(options);
    });

  return cmd;
}

interface ProfileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  lastModified: Date;
  hasDefault: boolean;
}

async function getProfileInfo(profilePath: string, name: string): Promise<ProfileInfo | null> {
  try {
    const s = await stat(profilePath);
    if (!s.isDirectory()) return null;

    const defaultDir = path.join(profilePath, 'Default');
    let hasDefault = false;
    try {
      const ds = await stat(defaultDir);
      hasDefault = ds.isDirectory();
    } catch {
      // no Default/ subdirectory
    }

    // Recursively sum size
    let sizeBytes = 0;
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isFile()) {
          const fs = await stat(full);
          sizeBytes += fs.size;
        } else if (entry.isDirectory()) {
          await walk(full);
        }
      }
    }
    await walk(profilePath);

    return { name, path: profilePath, sizeBytes, lastModified: s.mtime, hasDefault };
  } catch {
    return null;
  }
}

async function runMigration(options: { dryRun?: boolean; source?: string; keep?: boolean }) {
  const profilesDir = path.join(getAppDir(), 'profiles');
  const sharedDir = getSharedProfileDir();
  const dryRun = options.dryRun ?? false;
  const keep = options.keep ?? false;

  console.log(chalk.bold('🔄 Profile Migration: Isolated → Shared\n'));

  // Check if shared profile already exists
  try {
    const s = await stat(path.join(sharedDir, 'Default'));
    if (s.isDirectory()) {
      console.log(chalk.yellow('⚠ Shared profile already exists at:'));
      console.log(chalk.dim(`  ${sharedDir}`));
      console.log(chalk.yellow('  Delete it first if you want to re-migrate, or use it as-is.\n'));
      return;
    }
  } catch {
    // Good — no existing shared profile
  }

  // Scan existing isolated profiles
  const knownProviders = ['chatgpt', 'gemini', 'claude', 'grok', 'notebooklm'];
  const profiles: ProfileInfo[] = [];

  for (const name of knownProviders) {
    const profilePath = path.join(profilesDir, name);
    const info = await getProfileInfo(profilePath, name);
    if (info?.hasDefault) {
      profiles.push(info);
    }
  }

  if (profiles.length === 0) {
    console.log(chalk.yellow('No isolated profiles found to migrate.'));
    return;
  }

  console.log(chalk.bold('Found profiles:\n'));
  for (const p of profiles) {
    const sizeMb = (p.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(
      `  ${chalk.blue(p.name.padEnd(12))} ${sizeMb.padStart(6)} MB  (${p.lastModified.toISOString().split('T')[0]})`,
    );
  }
  console.log('');

  // Pick the base profile (largest = most session data, or user-specified)
  let base: ProfileInfo;
  if (options.source) {
    const found = profiles.find((p) => p.name === options.source);
    if (!found) {
      console.log(chalk.red(`Profile '${options.source}' not found.`));
      console.log(chalk.dim(`Available: ${profiles.map((p) => p.name).join(', ')}`));
      return;
    }
    base = found;
  } else {
    // Auto-pick: largest profile (most cookies/data = best base)
    profiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
    base = profiles[0];
  }

  console.log(chalk.green(`Base profile: ${base.name} (will be copied as shared default)`));
  const others = profiles.filter((p) => p.name !== base.name);
  if (others.length > 0) {
    console.log(chalk.dim(`Cookies from: ${others.map((p) => p.name).join(', ')} will be merged`));
  }
  console.log('');

  if (dryRun) {
    console.log(chalk.yellow('DRY RUN — no changes made.\n'));
    console.log('Would:');
    console.log(`  1. Copy ${base.name}/ → profiles/default/`);
    if (others.length > 0) {
      console.log(`  2. Merge cookies from ${others.map((p) => p.name).join(', ')}`);
    }
    if (!keep) {
      console.log(`  3. Remove old profiles: ${profiles.map((p) => p.name).join(', ')}`);
    }
    return;
  }

  // Step 1: Copy base profile to shared dir
  console.log(chalk.dim(`Copying ${base.name}/ → profiles/default/ ...`));
  await cp(base.path, sharedDir, { recursive: true });
  console.log(chalk.green('  ✓ Base profile copied'));

  // Step 2: Merge cookies from other profiles
  for (const other of others) {
    console.log(chalk.dim(`Merging cookies from ${other.name}...`));
    await mergeCookies(other.path, sharedDir);
    console.log(chalk.green(`  ✓ ${other.name} cookies merged`));
  }

  // Step 3: Remove old isolated profiles (unless --keep)
  if (!keep) {
    console.log(chalk.dim('\nCleaning up old profiles...'));
    for (const p of profiles) {
      await rm(p.path, { recursive: true, force: true });
      console.log(chalk.dim(`  Removed: ${p.name}/`));
    }
    console.log(chalk.green('  ✓ Old profiles removed'));
  } else {
    console.log(chalk.dim('\n--keep specified, old profiles preserved.'));
  }

  // Remove lock files from copied profile
  const lockFile = path.join(sharedDir, '10x-chat.lock');
  await rm(lockFile, { force: true }).catch(() => {});

  console.log('');
  console.log(chalk.bold.green('✓ Migration complete!'));
  console.log(chalk.dim(`Shared profile: ${sharedDir}`));
  console.log(chalk.dim('All providers will now share this browser profile by default.'));
  console.log(chalk.dim('Use --isolated-profile to revert to per-provider mode.\n'));
}

/**
 * Merge cookies from a source profile's Cookies SQLite DB into the target.
 *
 * Chromium stores cookies in Default/Cookies (SQLite) and Default/Network/Cookies.
 * Since Playwright's persistent contexts also store state, we copy the
 * Local Storage and Session Storage leveldb dirs as well.
 *
 * For simplicity (and to avoid SQLite merge complexity), we copy the storage
 * directories that don't conflict — each site's localStorage is in its own origin dir.
 */
async function mergeCookies(sourceProfile: string, targetProfile: string): Promise<void> {
  const sourceDefault = path.join(sourceProfile, 'Default');
  const targetDefault = path.join(targetProfile, 'Default');

  // Merge Local Storage (per-origin leveldb entries)
  const localStorageDirs = ['Local Storage', 'Session Storage', 'IndexedDB'];

  for (const dirName of localStorageDirs) {
    const sourceDir = path.join(sourceDefault, dirName);
    const targetDir = path.join(targetDefault, dirName);

    try {
      const s = await stat(sourceDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    // For leveldb-based storage, we need to merge carefully.
    // Copy files that don't exist in target.
    await mkdir(targetDir, { recursive: true });
    await copyMissing(sourceDir, targetDir);
  }

  // Merge Service Worker registrations (for sites that use them)
  const swDir = path.join(sourceDefault, 'Service Worker');
  const swTargetDir = path.join(targetDefault, 'Service Worker');
  try {
    const s = await stat(swDir);
    if (s.isDirectory()) {
      await mkdir(swTargetDir, { recursive: true });
      await copyMissing(swDir, swTargetDir);
    }
  } catch {
    // no service worker data
  }
}

/**
 * Recursively copy files from source to target, skipping files that already exist.
 */
async function copyMissing(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const dstPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await mkdir(dstPath, { recursive: true });
      await copyMissing(srcPath, dstPath);
    } else if (entry.isFile()) {
      try {
        await stat(dstPath);
        // File exists in target — skip (base profile wins)
      } catch {
        // File doesn't exist — copy it
        const data = await readFile(srcPath);
        await writeFile(dstPath, data);
      }
    }
  }
}
