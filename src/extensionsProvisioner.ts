import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

/** The desktop VS Code extensions dir — the per-machine source of truth. */
export const DESKTOP_EXTENSIONS_DIR = path.join(HOME, '.vscode', 'extensions');

/** Stable snapshot dir owned by vsorch, refreshed incrementally on every launch. */
export const SNAPSHOT_DIR = path.join(HOME, '.vsorch', 'extensions');

/** Stable server data dir (kept across launches, never nested in the snapshot). */
export const SERVER_DATA_DIR = path.join(HOME, '.vsorch', 'server-data');

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Refresh the vsorch extensions snapshot from the desktop VS Code
 * extensions dir. Must complete before `code serve-web` is spawned.
 *
 * Strategy (fastest available first):
 *  1. `rsync -a --delete` — incremental refresh, prunes removed extensions.
 *  2. macOS/APFS: wipe + `cp -c -R` — copy-on-write clones, near-instant.
 *  3. Node `fs.cp` — portable last resort.
 *
 * Returns the snapshot dir to pass as `--extensions-dir`.
 */
export async function provisionExtensions(): Promise<string> {
  await fs.mkdir(SERVER_DATA_DIR, { recursive: true });
  await fs.mkdir(path.dirname(SNAPSHOT_DIR), { recursive: true });

  if (!(await isDirectory(DESKTOP_EXTENSIONS_DIR))) {
    // No desktop VS Code extensions on this machine — serve an empty dir.
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
    return SNAPSHOT_DIR;
  }

  try {
    // Trailing slashes: copy dir *contents* into the snapshot dir.
    await run('rsync', [
      '-a',
      '--delete',
      `${DESKTOP_EXTENSIONS_DIR}/`,
      `${SNAPSHOT_DIR}/`,
    ]);
    return SNAPSHOT_DIR;
  } catch (err) {
    console.warn('[vsorch] rsync snapshot failed, falling back to copy:', err);
  }

  // Fallbacks are full re-copies, so clear the stale snapshot first.
  await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true });

  if (process.platform === 'darwin') {
    try {
      // APFS clonefile fast path.
      await run('cp', ['-c', '-R', DESKTOP_EXTENSIONS_DIR, SNAPSHOT_DIR]);
      return SNAPSHOT_DIR;
    } catch (err) {
      console.warn('[vsorch] cp -c snapshot failed, falling back to fs.cp:', err);
      await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true });
    }
  }

  await fs.cp(DESKTOP_EXTENSIONS_DIR, SNAPSHOT_DIR, { recursive: true });
  return SNAPSHOT_DIR;
}
