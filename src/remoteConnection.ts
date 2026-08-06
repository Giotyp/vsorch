import { ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { RemoteCodeError, RemoteCodeErrorKind } from '../scripts/remoteCode';
import { readConfig, updateConfig } from './config';
import { canBind } from './ports';

/**
 * Per-host remote serve-web lifecycle (§2 of the remote-panes plan):
 * one SSH ControlMaster per host, one remote `serve-web` bound to the host's
 * loopback, one `-L` forward to a stable local loopback port. All panes on a
 * host share that one local origin.
 */

/**
 * Per-host port, used identically on BOTH ends of the tunnel: serve-web
 * binds it on the host's loopback and the same number is forwarded locally.
 * The workbench generates URLs from its *configured* port, so a local port
 * that differs from the remote port makes those URLs point at the wrong
 * local server (e.g. the local serve-web) and the workbench never loads.
 * Base is away from the local serve-web port (45990). Candidates must be
 * free locally (canBind) and on the host (trial spawn; `--port 0` is
 * useless — the CLI echoes the configured port, not the bound one).
 */
const REMOTE_PORT_BASE = 46100;
const REMOTE_PORT_RANGE = 40;

/** How long a fresh spawn gets to crash (bad port, bad flags) before we
 *  treat the channel as live. */
const SPAWN_GRACE_MS = 4_000;

/** First-run serve-web may download the server component on the host. */
const REMOTE_READY_TIMEOUT_MS = 240_000;
const HEALTH_POLL_MS = 15_000;
const HEALTH_FAILURES_BEFORE_DROP = 2;
/** Generous per-probe timeout — jump-host links can be slow, and a slow
 *  answer must never be mistaken for a dead forward. */
const PROBE_TIMEOUT_MS = 8_000;
const RECONNECT_ATTEMPTS = 2;
const RECONNECT_BACKOFF_MS = 2_000;

const REMOTE_PID_RE = /VSORCH_RPID=(\d+)/;
const ADDR_IN_USE_RE = /address already in use|EADDRINUSE|Address in use/i;

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

type ProbeResult = 'ok' | 'refused' | 'timeout';

/**
 * Probe the forwarded port. 'refused' (connect error) means the forward is
 * actually gone; 'timeout' means it exists but answered slowly — on a
 * congested jump-host link that is NOT evidence of a dead connection.
 */
function probeHttp(port: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      settle('ok');
    });
    req.on('error', () => settle('refused'));
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      settle('timeout');
      req.destroy();
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
function buildServeWrapper(codePath: string, remotePort: number): string {
  const q = shSingleQuote(codePath);
  const serveCmd = `serve-web --host 127.0.0.1 --port ${remotePort} --server-data-dir "$HOME/.vsorch/server-data" --accept-server-license-terms --without-connection-token`;
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
  private channelExitInfo: { code: number | null; output: string } | null =
    null;
  /** Rolling tail of the serve-web channel's output, for diagnostics. */
  private channelTail = '';
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
        'ServerAliveCountMax=4',
        this.hostAlias,
      ],
      30_000,
    );
    if (master.code !== 0) {
      throw this.classify(master.stderr, 'could not open SSH connection');
    }

    // 2+3. One per-host port, free on both ends: serve-web binds it on the
    //    host, and the same number is forwarded locally (see REMOTE_PORT_BASE
    //    note). Trial-scan — an address-in-use spawn crashes fast.
    const { remotePid, remotePort } = await this.spawnOnFreePort();
    this.remotePid = remotePid;
    this.remotePort = remotePort;
    this.localPort = remotePort;

    // 4. Forward local → remote over the master (same port both ends).
    this.forwardSpec = `127.0.0.1:${remotePort}:127.0.0.1:${remotePort}`;
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

    // 5. Readiness = the workbench answering through the tunnel. The spawn's
    //    output is deliberately NOT parsed for readiness: real binaries print
    //    all sorts of banners and echo the *configured* port, so the HTTP
    //    probe is the only trustworthy signal. Generous deadline — the first
    //    run may download the server component on the host.
    const deadline = Date.now() + REMOTE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.channelExitInfo) {
        const { code, output } = this.channelExitInfo;
        throw this.classify(
          output,
          `remote serve-web exited (code ${code}) before becoming reachable`,
        );
      }
      if ((await probeHttp(this.localPort)) === 'ok') return;
      await delay(1_000);
    }
    throw new RemoteCodeError(
      `serve-web on "${this.hostAlias}" never became reachable through the forwarded port (first run downloads the server component — retry if the host is slow).` +
        (this.channelTail.trim()
          ? ` Server output: …${this.channelTail.trim().slice(-400)}`
          : ''),
      'unreachable',
      this.hostAlias,
    );
  }

  /** Trial-spawn serve-web across the port range; every candidate must be
   *  free locally too (it becomes the forward's local port). The last-good
   *  port is remembered per host, keeping the origin — and therefore the
   *  workbench's origin-scoped state — stable across launches. */
  private async spawnOnFreePort(): Promise<{
    remotePid: number;
    remotePort: number;
  }> {
    const config = await readConfig();
    const savedMap = (config.remotePorts ?? {}) as Record<string, unknown>;
    const savedRaw = savedMap[this.hostAlias];
    const saved = typeof savedRaw === 'number' ? savedRaw : null;

    const otherHosts = new Set<number>(
      Object.entries(savedMap)
        .filter(([host]) => host !== this.hostAlias)
        .map(([, v]) => v)
        .filter((v): v is number => typeof v === 'number'),
    );

    const candidates: number[] = [];
    if (saved !== null) candidates.push(saved);
    for (let p = REMOTE_PORT_BASE; p < REMOTE_PORT_BASE + REMOTE_PORT_RANGE; p++) {
      if (p !== saved && !otherHosts.has(p)) candidates.push(p);
    }

    for (const port of candidates) {
      if (!(await canBind(port))) continue; // must be free locally too
      const result = await this.trySpawn(port);
      if (result === 'busy') continue;
      if (port !== saved) {
        await updateConfig({
          remotePorts: { ...savedMap, [this.hostAlias]: port },
        });
      }
      return result;
    }
    throw new RemoteCodeError(
      `no port free on both this machine and "${this.hostAlias}" in ${REMOTE_PORT_BASE}–${REMOTE_PORT_BASE + REMOTE_PORT_RANGE - 1}.`,
      'unknown',
      this.hostAlias,
    );
  }

  /**
   * Spawn serve-web on one explicit port. Resolves 'busy' if the spawn dies
   * of address-in-use, resolves {pid, port} once the wrapper reported its pid
   * and the process survived the grace window, rejects on anything else.
   */
  private trySpawn(
    remotePort: number,
  ): Promise<'busy' | { remotePid: number; remotePort: number }> {
    return new Promise((resolve, reject) => {
      this.channelExitInfo = null;
      const channel = spawn(
        'ssh',
        [
          ...SSH_BASE_ARGS,
          '-S',
          this.ctlPath,
          this.hostAlias,
          buildServeWrapper(this.codePath, remotePort),
        ],
        // stdin stays open on purpose: the remote wrapper watches it and
        // reaps the serve-web group when the channel dies.
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.channel = channel;

      let out = '';
      let settled = false;
      let remotePid: number | null = null;
      let graceTimer: NodeJS.Timeout | null = null;

      // The wrapper echoes VSORCH_RPID as its first output; give the channel
      // (potentially via a slow ProxyJump) a while to produce it.
      const rpidTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          channel.kill('SIGTERM');
        } catch {
          // already gone
        }
        reject(
          this.classify(out, 'remote serve-web never started (no pid report)'),
        );
      }, 45_000);

      const finishAlive = () => {
        if (settled || remotePid === null) return;
        settled = true;
        clearTimeout(rpidTimer);
        resolve({ remotePid, remotePort });
      };

      const onOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        out += text;
        // Stream the host's output to the app log and keep a tail for
        // error messages — real binaries say surprising things.
        this.channelTail = (this.channelTail + text).slice(-1_000);
        for (const line of text.split('\n')) {
          if (line.trim()) {
            console.log(`[vsorch] ${this.hostAlias} serve-web: ${line}`);
          }
        }
        if (remotePid === null) {
          const pidMatch = REMOTE_PID_RE.exec(out);
          if (pidMatch) {
            remotePid = Number(pidMatch[1]);
            // Survive the grace window (address-in-use crashes fast) → good.
            graceTimer = setTimeout(finishAlive, SPAWN_GRACE_MS);
          }
        }
      };
      channel.stdout?.on('data', onOutput);
      channel.stderr?.on('data', onOutput);

      channel.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(rpidTimer);
        reject(this.classify(err.message, 'could not run ssh'));
      });
      channel.on('exit', (code) => {
        this.channelExitInfo = { code, output: out.slice(-500) };
        if (this.channel === channel) this.channel = null;
        if (!settled) {
          settled = true;
          clearTimeout(rpidTimer);
          if (graceTimer) clearTimeout(graceTimer);
          if (ADDR_IN_USE_RE.test(out)) {
            resolve('busy');
          } else {
            reject(
              this.classify(
                out,
                `remote serve-web exited early (code ${code})`,
              ),
            );
          }
        } else {
          this.onChannelExit();
        }
      });
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
    const result = await probeHttp(this.localPort);
    if (result === 'ok') {
      this.healthFailures = 0;
      return;
    }
    if (result === 'timeout') {
      // Slow ≠ dead. The SSH channel's own exit is the authority on a dead
      // link; a sluggish HTTP answer through a jump host must not trigger a
      // teardown loop that keeps killing a healthy server mid-load.
      console.warn(
        `[vsorch] ${this.hostAlias}: slow health probe (congested link?) — leaving the connection up`,
      );
      return;
    }
    // refused — the forward is really gone
    this.healthFailures += 1;
    if (this.healthFailures >= HEALTH_FAILURES_BEFORE_DROP) {
      void this.handleDrop('forwarded port refused connections');
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
