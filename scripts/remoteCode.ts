import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RemoteCodeInfo {
    hostAlias: string;
    codePath: string; // absolute path to `code` on the remote
    version: string; // e.g. "1.104.2"
    serveWebSupported: boolean;
}

export type RemoteCodeErrorKind =
    | "unreachable" // DNS / ProxyJump / timeout / auth under BatchMode
    | "hostKey" // unknown or changed host key
    | "noCode" // couldn't locate `code`
    | "tooOld" // `code` found but no serve-web support
    | "unknown";

export class RemoteCodeError extends Error {
    constructor(
        message: string,
        readonly kind: RemoteCodeErrorKind,
        readonly hostAlias: string,
    ) {
        super(message);
        this.name = "RemoteCodeError";
    }
}

// serve-web landed in VS Code 1.82 (Aug 2023). We trust the remote's own
// `serve-web --help` exit code; this constant is only for messaging.
const MIN_SERVE_WEB_VERSION = "1.82";

// POSIX-sh, portable across sh/dash/bash/zsh. `String.raw` keeps `\`
// line-continuations literal; there is no `${...}` so no JS interpolation.
const FIND_CODE = String.raw`
find_code() {
  for cand in code code-insiders; do
    # (1) non-interactive login shell: .zprofile / .profile
    for sh in "$SHELL" /bin/zsh /bin/bash; do
      [ -x "$sh" ] || continue
      p=$("$sh" -lc "command -v $cand" 2>/dev/null) || true
      if [ -n "$p" ] && [ -x "$p" ]; then printf '%s' "$p"; return 0; fi
    done
    # (2) interactive login shell: .zshrc / .bashrc (where PATH often lives).
    # tail -n1 guards against prompt / MOTD noise leaking onto stdout.
    for sh in "$SHELL" /bin/zsh /bin/bash; do
      [ -x "$sh" ] || continue
      p=$("$sh" -lic "command -v $cand" 2>/dev/null | tail -n1) || true
      if [ -n "$p" ] && [ -x "$p" ]; then printf '%s' "$p"; return 0; fi
    done
  done
  # (3) well-known absolute locations
  for p in \
    /usr/local/bin/code /usr/bin/code /snap/bin/code /opt/homebrew/bin/code \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/.local/bin/code"; do
    [ -x "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}
`;

const VERIFY = String.raw`
VER=$("$CODE" --version 2>/dev/null | head -n1)
if "$CODE" serve-web --help >/dev/null 2>&1; then SW=yes; else SW=no; fi
printf 'VSORCH_CODE=%s\n' "$CODE"
printf 'VSORCH_VER=%s\n'  "$VER"
printf 'VSORCH_SW=%s\n'   "$SW"
`;

function shSingleQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function buildRemoteScript(codePathOverride?: string): string {
    if (codePathOverride) {
        return `CODE=${shSingleQuote(codePathOverride)}
[ -x "$CODE" ] || { echo VSORCH_NO_CODE >&2; exit 3; }
${VERIFY}`;
    }
    return `${FIND_CODE}
CODE=$(find_code) || { echo VSORCH_NO_CODE >&2; exit 3; }
${VERIFY}`;
}

/**
 * Resolve `code` on `hostAlias` and confirm serve-web support.
 *
 * @param codePathOverride  Absolute path to `code` on the remote. When set,
 *   discovery is skipped and we simply verify serve-web at that path. Wire this
 *   to the remote's `codePath` config field for hosts that hide `code` behind
 *   an interactive-only PATH or a module system.
 *
 * BatchMode=yes means we never hang on a password or host-key prompt — an
 * unknown host fails fast and is reported as a `hostKey` error. ConnectTimeout
 * is generous because both of your hosts jump through `ecl-server`.
 */
export async function resolveRemoteCode(
    hostAlias: string,
    codePathOverride?: string,
): Promise<RemoteCodeInfo> {
    const args = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        hostAlias,
        buildRemoteScript(codePathOverride),
    ];

    let stdout: string;
    try {
        ({ stdout } = await execFileAsync("ssh", args, { timeout: 45_000 }));
    } catch (err) {
        throw classifySshError(err, hostAlias);
    }

    const get = (key: string): string | undefined =>
        stdout
            .split("\n")
            .find((line) => line.startsWith(key + "="))
            ?.slice(key.length + 1)
            .trim();

    const codePath = get("VSORCH_CODE");
    const version = get("VSORCH_VER") ?? "";
    const serveWebSupported = get("VSORCH_SW") === "yes";

    if (!codePath) {
        throw new RemoteCodeError(
            `Couldn't find the \`code\` binary on "${hostAlias}". Install VS Code (desktop) there, or set an explicit \`codePath\` for this host in config.`,
            "noCode",
            hostAlias,
        );
    }
    if (!serveWebSupported) {
        throw new RemoteCodeError(
            `VS Code on "${hostAlias}" (${version || "unknown version"}) doesn't support \`serve-web\` — you need ${MIN_SERVE_WEB_VERSION} or newer.`,
            "tooOld",
            hostAlias,
        );
    }

    return { hostAlias, codePath, version, serveWebSupported };
}

function classifySshError(err: unknown, hostAlias: string): RemoteCodeError {
    const e = err as { code?: number | string; stderr?: string; message?: string };
    // Pattern-match on stderr ONLY: execFile's err.message embeds the full
    // command line — including our remote script, which itself contains the
    // literal "VSORCH_NO_CODE" — so matching against it misclassifies every
    // ssh failure as noCode.
    const text = e?.stderr ?? "";

    if (e?.code === 3 || /VSORCH_NO_CODE/.test(text)) {
        return new RemoteCodeError(
            `Couldn't find \`code\` on "${hostAlias}". Install VS Code there, or set an explicit \`codePath\` for this host.`,
            "noCode",
            hostAlias,
        );
    }
    if (/Host key verification failed|No .* host key is known|Host key .* has changed/i.test(text)) {
        return new RemoteCodeError(
            `SSH host key for "${hostAlias}" isn't trusted yet. Run \`ssh ${hostAlias}\` once in a terminal to accept it, then retry.`,
            "hostKey",
            hostAlias,
        );
    }
    if (/Permission denied|password/i.test(text)) {
        return new RemoteCodeError(
            `SSH auth to "${hostAlias}" failed under BatchMode (no key-based login). Make sure \`ssh ${hostAlias}\` works without a password prompt.`,
            "unreachable",
            hostAlias,
        );
    }
    return new RemoteCodeError(
        `Couldn't reach "${hostAlias}" over SSH: ${(e?.stderr || e?.message || "").trim() || "connection failed"}`,
        "unreachable",
        hostAlias,
    );
}