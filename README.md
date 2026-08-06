# vsorch

Orchestrate multiple real VS Code workbenches inside a single desktop window.

vsorch is an Electron shell that hosts VS Code panes. It does not reimplement
any editor behavior — each pane is a full VS Code workbench (open folders, edit
and save files, integrated terminal) served by the machine's installed VS Code.

## How it works

On startup vsorch:

1. Snapshots the desktop VS Code extensions (`~/.vscode/extensions`) into a
   stable vsorch-owned dir (`~/.vsorch/server-data/extensions`), refreshed
   incrementally with `rsync -a --delete` (APFS `cp -c` clone fallback). The
   desktop install is the source of truth; the snapshot avoids contention with
   a running desktop VS Code. (`serve-web` has no `--extensions-dir` flag —
   the code server it spawns defaults to `<server-data-dir>/extensions`,
   which is why the snapshot lives there.)
2. Spawns one shared local web server using VS Code's built-in CLI:

   ```
   code serve-web --host 127.0.0.1 --port <PORT> \
     --without-connection-token --accept-server-license-terms \
     --server-data-dir ~/.vsorch/server-data
   ```

3. Embeds the served workbench URL in `<webview>` panes. The `+` button in the
   top bar adds another pane; N panes split the window into equal columns, each
   an independent workbench (distinct `?vsorchPane=<uuid>` query param).

The server binds to `127.0.0.1` only and is killed (whole process group) when
vsorch quits.

The port is stable across launches (saved in `~/.vsorch/config.json`,
default 45990): the workbench keeps user state — color theme, settings, UI
layout — in browser storage scoped to the `http://127.0.0.1:<port>` origin,
so a stable port is what makes those choices persist between vsorch runs. If
another app ever occupies the port, vsorch scans forward to the next free one
and saves it (workbench state resets once when that happens).

## Prerequisites

- macOS (primary target)
- VS Code installed, with the `code` CLI available (`code --version` and
  `code serve-web --help` should work) — in VS Code run
  "Shell Command: Install 'code' command in PATH" if needed
- Node.js LTS + npm
- Internet access on first run (VS Code downloads its server component into
  `~/.vscode/cli/serve-web` the first time `serve-web` runs, so the very first
  vsorch launch can take a while)

## Run

```
npm install
npm start
```

The window opens with one VS Code Welcome workbench. Click `+` in the top bar
to add another independent workbench. Click a pane to focus it (highlighted
with a top accent line).

The `⊞` button picks the pane layout: **one row** (side by side), **one
column** (stacked), or **grid** (near-square — e.g. 3 panes become 2 on top
and 1 spanning the bottom row). Layouts are applied with CSS grid, so
rearranging never reloads a pane.

## Remote hosts (experimental)

Remotes are declared in `~/.vsorch/config.json`. At startup vsorch resolves
the `code` binary on each host over SSH (in parallel, never blocking local
bring-up) and verifies it supports `serve-web`:

```json
{
  "serverPort": 45990,
  "remotes": [
    { "hostAlias": "yecl-gpu-server" },
    { "hostAlias": "other-box", "codePath": "/usr/local/bin/code" }
  ]
}
```

`hostAlias` is an SSH alias from `~/.ssh/config`; key-based auth must work
non-interactively (`BatchMode=yes`). `codePath` skips discovery for hosts
that hide `code` behind an interactive-only PATH. Results are logged and
exposed to the renderer (`getRemotes()` / `onRemotesResolved`); spawning
remote serve-web panes is the next phase. `scripts/probe.ts` tests a single
host from the command line.

## Project structure

```
src/
├── main.ts                  # Electron main: window + IPC wiring
├── extensionsProvisioner.ts # snapshot desktop extensions before server spawn
├── serveWebManager.ts       # spawn/supervise serve-web, readiness, cleanup
├── preload.ts               # contextBridge: server URL + events → renderer
└── renderer/
    ├── index.html           # top bar + #panes container
    ├── renderer.ts          # pane creation, split layout, focus handling
    └── styles.css           # flexbox: fixed top bar + flex-row panes
```

## Known limitations (v0, by design)

- Extensions installed *inside* a pane are ephemeral — the snapshot is
  refreshed from the desktop dir on every launch. Install extensions in
  desktop VS Code to make them permanent.
- serve-web runs the web/server workbench: workspace extensions (language
  servers, linters, formatters) work; some desktop-only UI extensions won't
  activate.
- No pane closing, resizable dividers, session persistence, or remote/SSH
  targets yet. Keyboard chords (Cmd+W/N/T) may be captured by Electron before
  the pane sees them.
- If a pane won't load, check that the auto-installed serve-web server version
  matches the installed VS Code (`~/.vscode/cli/serve-web` can drift).
