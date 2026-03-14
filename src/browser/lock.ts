import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProcessAlive } from './process.js';

const LOCK_FILENAME = '10x-chat.lock';

interface LockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
}

export interface ProfileLock {
  lockPath: string;
  lockId: string;
  release: () => Promise<void>;
}

/**
 * Acquire a file-based lock for a provider profile directory.
 * Prevents concurrent browser sessions on the same profile.
 */
export async function acquireProfileLock(
  profileDir: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ProfileLock> {
  const { timeoutMs = 30_000, pollMs = 500 } = opts;
  const lockPath = path.join(profileDir, LOCK_FILENAME);
  const lockId = randomUUID();
  const deadline = Date.now() + timeoutMs;

  await mkdir(profileDir, { recursive: true });

  while (Date.now() < deadline) {
    // Try to read existing lock
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const record: LockRecord = JSON.parse(raw);

      // Check if the lock holder is still alive
      if (!isProcessAlive(record.pid)) {
        // Stale lock from a dead process — remove it
        await rm(lockPath, { force: true });
      } else {
        // Lock is held by a live process — wait
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
    } catch {
      // No lock file exists or unreadable — proceed to acquire
    }

    // Try to write our lock
    const record: LockRecord = {
      pid: process.pid,
      lockId,
      createdAt: new Date().toISOString(),
    };

    try {
      await writeFile(lockPath, JSON.stringify(record), { flag: 'wx' });
    } catch {
      // Race condition: another process grabbed it first
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    // Verify we actually hold the lock
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const current: LockRecord = JSON.parse(raw);
      if (current.lockId === lockId) {
        return {
          lockPath,
          lockId,
          release: async () => {
            try {
              const raw = await readFile(lockPath, 'utf-8');
              const current: LockRecord = JSON.parse(raw);
              if (current.lockId === lockId) {
                await rm(lockPath, { force: true });
              }
            } catch {
              // Lock file already gone
            }
          },
        };
      }
    } catch {
      // Lock vanished — retry
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `Failed to acquire profile lock at ${lockPath} within ${timeoutMs}ms. ` +
      'Another 10x-chat session may be using this profile.',
  );
}
