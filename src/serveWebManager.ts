import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const READY_RE = /Web UI available at\s+(http:\/\/127\.0\.0\.1:\d+)/;

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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('could not allocate a free port')));
      }
    });
  });
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

    const port = await getFreePort();
    const cli = await resolveCodeCli();
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
