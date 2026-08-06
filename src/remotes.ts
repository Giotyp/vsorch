import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RemoteCodeError,
  RemoteCodeInfo,
  resolveRemoteCode,
} from '../scripts/remoteCode';

const CONFIG_PATH = path.join(os.homedir(), '.vsorch', 'config.json');

/** A remote host entry from `~/.vsorch/config.json` (`remotes` array). */
export interface RemoteConfig {
  /** SSH host alias (from ~/.ssh/config). */
  hostAlias: string;
  /** Optional absolute path to `code` on the remote, skips discovery. */
  codePath?: string;
}

/** Serializable per-remote outcome (safe to send over IPC). */
export type RemoteResolution =
  | { hostAlias: string; ok: true; info: RemoteCodeInfo }
  | {
      hostAlias: string;
      ok: false;
      error: { kind: string; message: string };
    };

/** Read the configured remotes; missing/invalid config → no remotes. */
export async function readRemotes(): Promise<RemoteConfig[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const remotes = (parsed as { remotes?: unknown }).remotes;
  if (!Array.isArray(remotes)) return [];

  const valid: RemoteConfig[] = [];
  for (const entry of remotes) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { hostAlias?: unknown }).hostAlias === 'string' &&
      (entry as { hostAlias: string }).hostAlias.length > 0
    ) {
      const e = entry as { hostAlias: string; codePath?: unknown };
      valid.push({
        hostAlias: e.hostAlias,
        codePath: typeof e.codePath === 'string' ? e.codePath : undefined,
      });
    } else {
      console.warn('[vsorch] ignoring invalid remotes entry:', entry);
    }
  }
  return valid;
}

/**
 * Resolve the `code` binary on every configured remote, in parallel. One
 * remote failing (unreachable, no `code`, too old, …) never affects the
 * others — each entry reports its own outcome.
 */
export async function resolveRemotes(): Promise<RemoteResolution[]> {
  const remotes = await readRemotes();
  if (remotes.length === 0) return [];

  const settled = await Promise.allSettled(
    remotes.map((r) => resolveRemoteCode(r.hostAlias, r.codePath)),
  );

  return settled.map((result, i) => {
    const hostAlias = remotes[i].hostAlias;
    if (result.status === 'fulfilled') {
      return { hostAlias, ok: true, info: result.value };
    }
    const reason: unknown = result.reason;
    if (reason instanceof RemoteCodeError) {
      return {
        hostAlias,
        ok: false,
        error: { kind: reason.kind, message: reason.message },
      };
    }
    return {
      hostAlias,
      ok: false,
      error: {
        kind: 'unknown',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    };
  });
}
