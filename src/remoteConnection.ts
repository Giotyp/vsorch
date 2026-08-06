import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { RemoteCodeError, RemoteCodeErrorKind } from '../scripts/remoteCode';
import { readConfig, updateConfig } from './config';
import { canBind, scanForFreePort } from './ports';

/**
 * Per-host remote serve-web lifecycle (§2 of the remote-panes plan):
 * one SSH ControlMaster per host, one remote `serve-web` bound to the host's
 * loopback, one `-L` forward to a stable local loopback port. All panes on a
 * host share that one local origin.
 */

/** Local ports for remote hosts scan from here (local serve-web uses 45990). */
const LOCAL_REMOTE_PORT_BASE = 46100;
const LOCAL_REMOTE_PORT_RANGE = 40;

/** First-run serve-web may download the server component on the host. */
const REMOTE_READY_TIMEOUT_MS = 240_000;
const HEALTH_POLL_MS = 10_000;
const HEALTH_FAILURES_BEFORE_DROP = 2;
const RECONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 2_000;

const REMOTE_READY_RE = /Web UI available at\s+http:\/\/127\.0\.0\.1:(\d+)/;
const REMOTE_PID_RE = /VSORCH_RPID=(\d+)/;

export type RemoteConnectionState =
  | 'connecting'
  | 'serving'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export interface RemoteStatus {
  hostAlias: string;
  state: RemoteConnectionState;
  /** Local origin (http://127.0.0.1:<localPort>) once serving. */
  origin?: string;
  error?: { kind: string; message: string };
}

function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3_000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

const SSH_BASE_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

/** Run a short ssh command to completion; resolve {code, stderr}. */
function runSsh(
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...SSH_BASE_ARGS, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: stderr || err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/**
 * The remote wrapper: starts serve-web in its own session/process group,
 * reports its pid, and — crucially — watches stdin: when the SSH channel dies
 * for any reason, stdin EOFs and the whole remote group is reaped. This is
 * the remote analogue of the local pgrep -g cleanup (§3.1).
 */
function buildServeWrapper(codePath: string): string {
  const q = shSingleQuote(codePath);
  const serveCmd = `serve-web --host 127.0.0.1 --port 0 --server-data-dir "$HOME/.vsorch/server-data" --accept-server-license-terms --without-connection-token`;
  return (
    // fd 3 duplicates the channel's stdin: POSIX shells give *background*
    // jobs /dev/null as stdin, so the watchdog must read via 3<&0 or it
    // EOFs instantly and kills the server at birth.
    `exec 3<&0\n` +
    `mkdir -p "$HOME/.vsorch/server-data"\n` +
    `if command -v setsid >/dev/null 2>&1; then\n` +
    `  setsid ${q} ${serveCmd} 2>&1 &\n` +
    `else\n` +
    `  ${q} ${serveCmd} 2>&1 &\n` +
    `fi\n` +
    `pid=$!\n` +
    `echo "VSORCH_RPID=$pid"\n` +
    `{ cat 0<&3 >/dev/null; kill -TERM -"$pid" 2>/dev/null; sleep 1; kill -KILL -"$pid" 2>/dev/null; } &\n` +
    `wait "$pid"\n`
  );
}

export class RemoteConnection {
  private readonly ctlPath: string;
  private channel: ChildProcess | null = null;
  private remotePid: number | null = null;
  private remotePort: number | null = null;
  private localPort: number | null = null;
  private forwardSpec: string | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFailures = 0;
  private closing = false;

  state: RemoteConnectionState = 'connecting';
  lastError: { kind: string; message: string } | null = null;

  constructor(
    readonly hostAlias: string,
    private readonly codePath: string,
    private readonly emit: (status: RemoteStatus) => void,
  ) {
    const hash = crypto
      .createHash('sha256')
      .update(hostAlias)
      .digest('hex')
      .slice(0, 10);
    this.ctlPath = path.join(os.tmpdir(), `vsorch-${hash}.ctl`);
  }

  status(): RemoteStatus {
    return {
      hostAlias: this.hostAlias,
      state: this.state,
      origin:
        this.state === 'serving' && this.localPort !== null
          ? `http://127.0.0.1:${this.localPort}`
          : undefined,
      error: this.lastError ?? undefined,
    };
  }

  private setState(
    state: RemoteConnectionState,
    error?: { kind: string; message: string },
  ): void {
    this.state = state;
    if (error) this.lastError = error;
    this.emit(this.status());
  }

  async connect(): Promise<RemoteStatus> {
    this.closing = false;
    this.setState('connecting');
    try {
      await this.bringUp();
      this.setState('serving');
      this.startHealthWatch();
    } catch (err) {
      const e =
        err instanceof RemoteCodeError
          ? { kind: err.kind as string, message: err.message }
          : { kind: 'unknown', message: String(err) };
      await this.teardown();
      this.setState('failed', e);
    }
    return this.status();
  }

  private async bringUp(): Promise<void> {
    // 1. ControlMaster (through the user's own ~/.ssh/config ProxyJump).
    const master = await runSsh(
      [
        '-M',
        '-N',
        '-f',
        '-S',
        this.ctlPath,
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=2',
        this.hostAlias,
      ],
      30_000,
    );
    if (master.code !== 0) {
      throw this.classify(master.stderr, 'could not open SSH connection');
    }

    // 2. Stable local port for this host (origin-scoped workbench state).
    this.localPort = await this.allocLocalPort();

    // 3. Spawn serve-web on the host (port 0 → the host picks a free port and
    //    prints it, so no remote scan / TOCTOU race).
    const { remotePid, remotePort } = await this.spawnServeWeb();
    this.remotePid = remotePid;
    this.remotePort = remotePort;

    // 4. Forward local → remote over the master.
    this.forwardSpec = `127.0.0.1:${this.localPort}:127.0.0.1:${remotePort}`;
    const fwd = await runSsh([
      '-S',
      this.ctlPath,
      '-O',
      'forward',
      '-L',
      this.forwardSpec,
      this.hostAlias,
    ]);
    if (fwd.code !== 0) {
      throw this.classify(fwd.stderr, 'could not establish port forward');
    }

    // 5. Confirm the workbench answers through the tunnel.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await probeHttp(this.localPort)) return;
      await delay(500);
    }
    throw new RemoteCodeError(
      `serve-web on "${this.hostAlias}" never became reachable through the forwarded port.`,
      'unreachable',
      this.hostAlias,
    );
  }

  private async allocLocalPort(): Promise<number> {
    const config = await readConfig();
    const saved = (config.remoteLocalPorts ?? {}) as Record<string, unknown>;
    const mine = saved[this.hostAlias];
    if (typeof mine === 'number' && (await canBind(mine))) return mine;

    const taken = new Set<number>(
      Object.values(saved).filter((v): v is number => typeof v === 'number'),
    );
    const port = await scanForFreePort(
      LOCAL_REMOTE_PORT_BASE,
      LOCAL_REMOTE_PORT_RANGE,
      taken,
    );
    if (port === null) {
      throw new RemoteCodeError(
        'no free local port for the remote forward',
        'unknown',
        this.hostAlias,
      );
    }
    await updateConfig({
      remoteLocalPorts: { ...saved, [this.hostAlias]: port },
    });
    return port;
  }

  private spawnServeWeb(): Promise<{ remotePid: number; remotePort: number }> {
    return new Promise((resolve, reject) => {
      const channel = spawn(
        'ssh',
        [
          ...SSH_BASE_ARGS,
          '-S',
          this.ctlPath,
          this.hostAlias,
          buildServeWrapper(this.codePath),
        ],
        // stdin stays open on purpose: the remote wrapper watches it and
        // reaps the serve-web group when the channel dies.
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.channel = channel;

      let out = '';
      let stderr = '';
      let settled = false;
      let remotePid: number | null = null;

      const settle = (
        err: Error | null,
        result?: { remotePid: number; remotePort: number },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(result as { remotePid: number; remotePort: number });
      };

      channel.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const pidMatch = REMOTE_PID_RE.exec(out);
        if (pidMatch) remotePid = Number(pidMatch[1]);
        const ready = REMOTE_READY_RE.exec(out);
        if (ready && remotePid !== null) {
          settle(null, { remotePid, remotePort: Number(ready[1]) });
        }
      });
      channel.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      channel.on('error', (err) =>
        settle(this.classify(err.message, 'could not run ssh')),
      );
      channel.on('exit', (code) => {
        if (!settled) {
          settle(
            this.classify(
              stderr || out,
              `remote serve-web exited early (code ${code})`,
            ),
          );
        } else {
          this.onChannelExit();
        }
      });

      const timer = setTimeout(() => {
        settle(
          new RemoteCodeError(
            `timed out waiting for serve-web on "${this.hostAlias}" (first run downloads the server component — retry if the host is slow).`,
            'unreachable',
            this.hostAlias,
          ),
        );
      }, REMOTE_READY_TIMEOUT_MS);
    });
  }

  private classify(stderr: string, context: string): RemoteCodeError {
    const text = stderr || '';
    let kind: RemoteCodeErrorKind = 'unreachable';
    if (/administratively prohibited/i.test(text)) kind = 'forwardingDenied';
    else if (/Permission denied|password/i.test(text)) kind = 'authFailed';
    else if (/Host key/i.test(text)) kind = 'hostKey';
    return new RemoteCodeError(
      `${context} on "${this.hostAlias}"${text.trim() ? `: ${text.trim().split('\n').pop()}` : ''}`,
      kind,
      this.hostAlias,
    );
  }

  // --- liveness (R4) ---

  private startHealthWatch(): void {
    this.stopHealthWatch();
    this.healthFailures = 0;
    this.healthTimer = setInterval(() => {
      void this.healthCheck();
    }, HEALTH_POLL_MS);
  }

  private stopHealthWatch(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async healthCheck(): Promise<void> {
    if (this.state !== 'serving' || this.localPort === null) return;
    const ok = await probeHttp(this.localPort);
    if (ok) {
      this.healthFailures = 0;
      return;
    }
    this.healthFailures += 1;
    if (this.healthFailures >= HEALTH_FAILURES_BEFORE_DROP) {
      void this.handleDrop('forwarded port stopped responding');
    }
  }

  private onChannelExit(): void {
    if (this.closing || this.state !== 'serving') return;
    void this.handleDrop('SSH channel to the host exited');
  }

  private async handleDrop(why: string): Promise<void> {
    if (this.closing || this.state === 'reconnecting') return;
    this.stopHealthWatch();
    this.setState('reconnecting', { kind: 'dropped', message: why });
    await this.teardown();

    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      if (this.closing) return;
      await delay(RECONNECT_BACKOFF_MS * attempt);
      try {
        await this.bringUp();
        this.lastError = null;
        this.setState('serving');
        this.startHealthWatch();
        return;
      } catch {
        await this.teardown();
      }
    }
    this.setState('failed', {
      kind: 'dropped',
      message: `${why}; reconnect failed after ${RECONNECT_ATTEMPTS} attempts.`,
    });
  }

  // --- teardown (§3.1–§3.2) ---

  /** Kill remote group, cancel forward, close channel + master. */
  private async teardown(): Promise<void> {
    this.stopHealthWatch();

    if (this.remotePid !== null) {
      await runSsh(
        [
          '-S',
          this.ctlPath,
          this.hostAlias,
          `kill -TERM -${this.remotePid} 2>/dev/null; sleep 1; kill -KILL -${this.remotePid} 2>/dev/null; true`,
        ],
        8_000,
      );
      this.remotePid = null;
    }
    if (this.forwardSpec !== null) {
      await runSsh([
        '-S',
        this.ctlPath,
        '-O',
        'cancel',
        '-L',
        this.forwardSpec,
        this.hostAlias,
      ]);
      this.forwardSpec = null;
    }
    if (this.channel) {
      // Killing the channel EOFs the remote wrapper's stdin → group reaped
      // even if the explicit kill above never arrived.
      try {
        this.channel.kill('SIGTERM');
      } catch {
        // already gone
      }
      this.channel = null;
    }
    await runSsh(['-S', this.ctlPath, '-O', 'exit', this.hostAlias]);
    this.remotePort = null;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.teardown();
    this.setState('closed');
  }

  /** Fire-and-forget teardown for app quit: detached, survives our exit. */
  closeSync(): void {
    this.closing = true;
    this.stopHealthWatch();
    const spawnDetached = (args: string[]) => {
      try {
        spawn('ssh', [...SSH_BASE_ARGS, ...args], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      } catch {
        // best effort
      }
    };
    if (this.remotePid !== null) {
      spawnDetached([
        '-S',
        this.ctlPath,
        this.hostAlias,
        `kill -TERM -${this.remotePid} 2>/dev/null; sleep 1; kill -KILL -${this.remotePid} 2>/dev/null; true`,
      ]);
    }
    if (this.channel) {
      try {
        this.channel.kill('SIGTERM');
      } catch {
        // already gone
      }
    }
    spawnDetached(['-S', this.ctlPath, '-O', 'exit', this.hostAlias]);
  }
}

export class RemoteConnectionManager {
  private connections = new Map<string, RemoteConnection>();

  constructor(private readonly emit: (status: RemoteStatus) => void) {}

  /** Open (or reuse) the host's connection; resolves at serving/failed. */
  async open(hostAlias: string, codePath: string): Promise<RemoteStatus> {
    const existing = this.connections.get(hostAlias);
    if (existing) {
      if (existing.state === 'serving' || existing.state === 'connecting') {
        return existing.status();
      }
      // failed / closed → replace with a fresh attempt
      await existing.close().catch(() => undefined);
    }
    const connection = new RemoteConnection(hostAlias, codePath, this.emit);
    this.connections.set(hostAlias, connection);
    return connection.connect();
  }

  statuses(): RemoteStatus[] {
    return [...this.connections.values()].map((c) => c.status());
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((c) => c.close()),
    );
  }

  closeAllSync(): void {
    for (const connection of this.connections.values()) connection.closeSync();
  }
}
