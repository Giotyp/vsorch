import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { canBind, getFreePort } from './ports';

const READY_RE = /Web UI available at\s+(http:\/\/127\.0\.0\.1:\d+)/;

/**
 * The workbench persists user state (theme, settings, UI layout) in
 * origin-scoped browser storage — http://127.0.0.1:<port>. A different port
 * per launch would be a different origin and lose that state, so vsorch
 * keeps a stable port in its config and reuses it across launches.
 */
const DEFAULT_PORT = 45990;
const PORT_SCAN_RANGE = 20;
const CONFIG_PATH = path.join(os.homedir(), '.vsorch', 'config.json');

/** How long to wait for readiness. First run may download the server component. */
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;

/**
 * Candidate locations for the `code` CLI. A macOS GUI app doesn't inherit the
 * shell PATH, so fall back to the usual install locations.
 */
const CODE_CLI_CANDIDATES = [
  'code',
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
];

/**
 * `code serve-web` always runs the server component matching its own
 * commit — it downloads one to `~/.vscode/cli/serve-web/<commit>` on demand
 * — so a version mismatch can't happen against *that* binary. It can happen
 * against the desktop *app*: if PATH resolves a different, stale `code` CLI
 * (e.g. a leftover shim from a previous install) before this canonical
 * path, vsorch serves an older VS Code than the one the user has open.
 */
const DESKTOP_APP_CLI =
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

interface CliVersionInfo {
  version: string;
  commit: string;
}

function getCliVersion(cli: string): CliVersionInfo | null {
  try {
    const result = spawnSync(cli, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const lines = result.stdout?.trim().split('\n');
    if (lines && lines.length >= 2) {
      return { version: lines[0].trim(), commit: lines[1].trim() };
    }
  } catch {
    // unreadable or not executable — treat as unknown
  }
  return null;
}

/**
 * If the resolved `code` CLI isn't the desktop app's own binary and reports
 * a different commit, warn: vsorch will serve that (possibly stale) version
 * instead of the VS Code the user actually has installed.
 */
async function checkVersionDrift(resolvedCli: string): Promise<string | null> {
  if (path.resolve(resolvedCli) === DESKTOP_APP_CLI) return null;
  try {
    await fs.access(DESKTOP_APP_CLI);
  } catch {
    return null; // no desktop app at the canonical path to compare against
  }
  const resolved = getCliVersion(resolvedCli);
  const desktop = getCliVersion(DESKTOP_APP_CLI);
  if (!resolved || !desktop || resolved.commit === desktop.commit) return null;
  return (
    `vsorch is serving VS Code ${resolved.version} from "${resolvedCli}", which ` +
    `differs from the installed desktop app (${desktop.version}). Panes may be ` +
    `out of date or fail to load — check for a stale "code" CLI earlier on PATH.`
  );
}

async function readSavedPort(): Promise<number | null> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const config: unknown = JSON.parse(raw);
    if (
      typeof config === 'object' &&
      config !== null &&
      'serverPort' in config
    ) {
      const port = (config as { serverPort: unknown }).serverPort;
      if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
        return port;
      }
    }
  } catch {
    // no config yet, or unreadable — fall back to defaults
  }
  return null;
}

async function savePort(port: number): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // start fresh
    }
    config.serverPort = port;
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  } catch (err) {
    console.warn('[vsorch] could not save server port:', err);
  }
}

/**
 * Pick the serve-web port: the saved one if still free, otherwise scan a
 * small fixed range (so the origin only changes when something else has
 * squatted on the port), and as a last resort any free ephemeral port.
 * The choice is saved so subsequent launches reuse it.
 */
async function getStablePort(): Promise<number> {
  const saved = await readSavedPort();
  const candidates: number[] = [];
  if (saved !== null) candidates.push(saved);
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SCAN_RANGE; p++) {
    if (p !== saved) candidates.push(p);
  }
  for (const port of candidates) {
    if (await canBind(port)) {
      if (port !== saved) await savePort(port);
      return port;
    }
  }
  const fallback = await getFreePort();
  await savePort(fallback);
  return fallback;
}

async function resolveCodeCli(): Promise<string> {
  for (const candidate of CODE_CLI_CANDIDATES) {
    if (candidate === 'code') continue; // PATH lookup — tried last, via spawn.
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return 'code';
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2_000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Spawns and supervises the single shared `code serve-web` child process
 * that backs every vsorch pane.
 */
export class ServeWebManager {
  private child: ChildProcess | null = null;

  /** Base URL (e.g. http://127.0.0.1:9888) once the server is ready. */
  baseUrl: string | null = null;

  /** Set if the resolved `code` CLI doesn't match the desktop app's version. */
  versionWarning: string | null = null;

  /**
   * Start `code serve-web` bound to 127.0.0.1 and resolve with the base URL
   * once the workbench is reachable. Readiness is detected primarily from the
   * "Web UI available at ..." stdout line, with port polling as a fallback.
   *
   * Note: `serve-web` has no `--extensions-dir` flag — the code server it
   * spawns uses `<server-data-dir>/extensions`, which the extensions
   * provisioner populates before this runs.
   */
  async start(serverDataDir: string): Promise<string> {
    if (this.baseUrl) return this.baseUrl;

    const port = await getStablePort();
    const cli = await resolveCodeCli();
    this.versionWarning = await checkVersionDrift(cli);
    if (this.versionWarning) console.warn(`[vsorch] ${this.versionWarning}`);
    const args = [
      'serve-web',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--without-connection-token',
      '--accept-server-license-terms',
      '--server-data-dir',
      serverDataDir,
    ];

    // Own process group so quit can kill serve-web *and* its helper processes.
    const child = spawn(cli, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const expectedUrl = `http://127.0.0.1:${port}`;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const settle = (err: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(deadline);
        if (err || !url) {
          this.stop();
          reject(err ?? new Error('serve-web settled without a URL'));
        } else {
          this.baseUrl = url;
          resolve(url);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = READY_RE.exec(stdout);
        if (match) settle(null, match[1]);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        settle(
          new Error(
            `could not launch the "code" CLI (is VS Code installed with the ` +
              `shell command on PATH?): ${err.message}`,
          ),
        );
      });
      child.on('exit', (code) => {
        settle(
          new Error(
            `code serve-web exited early (code ${code}).\n${stderr || stdout}`,
          ),
        );
      });

      // Fallback: stdout format may change across VS Code versions — poll the
      // port we chose until it answers.
      const pollTimer = setInterval(() => {
        void probe(`${expectedUrl}/`).then((ok) => {
          if (ok) settle(null, expectedUrl);
        });
      }, POLL_INTERVAL_MS);

      const deadline = setTimeout(() => {
        settle(
          new Error(
            `timed out waiting for code serve-web to become ready.\n` +
              `${stderr || stdout}`,
          ),
        );
      }, READY_TIMEOUT_MS);
    });
  }

  /** Kill the serve-web process group so no orphaned servers survive quit. */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.baseUrl = null;
    if (!child || child.pid === undefined || child.exitCode !== null) return;
    child.removeAllListeners('exit');

    const pid = child.pid;

    // Enumerate the group's members up front (serve-web spawns node helpers);
    // signaling them individually backs up the group signal.
    let members: number[] = [];
    try {
      const out = spawnSync('pgrep', ['-g', String(pid)], {
        encoding: 'utf8',
      });
      members = (out.stdout || '')
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((p) => Number.isInteger(p) && p > 0);
    } catch {
      // pgrep unavailable — group signal alone will have to do
    }

    const signalAll = (signal: NodeJS.Signals) => {
      // Helpers first (deepest spawn last in pgrep order), then the group,
      // then the direct child — signaling a helper after its parent died can
      // be unreliable.
      for (const member of [...members].reverse()) {
        if (member === pid) continue;
        try {
          process.kill(member, signal);
        } catch {
          // already dead
        }
      }
      try {
        // Negative PID → the whole process group.
        process.kill(-pid, signal);
      } catch {
        // group already gone (or unsupported)
      }
      try {
        child.kill(signal);
      } catch {
        // already dead
      }
    };

    signalAll('SIGTERM');

    // Escalate in case anything ignored SIGTERM. unref: best-effort — don't
    // hold the app open for it.
    const escalation = setTimeout(() => signalAll('SIGKILL'), 2_000);
    escalation.unref();
  }
}
