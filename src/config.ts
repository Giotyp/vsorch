import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.vsorch', 'config.json');

/** Read `~/.vsorch/config.json`; missing or invalid → empty object. */
export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no config yet
  }
  return {};
}

/** Merge `patch` into the config file, preserving unrelated keys. */
export async function updateConfig(
  patch: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const config = { ...(await readConfig()), ...patch };
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}
