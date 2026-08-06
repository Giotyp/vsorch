import './styles.css';
import type { RemoteStatus } from '../remoteConnection';
import type { RemoteResolution } from '../remotes';
import type { VsorchApi } from '../preload';
import { LayoutKind, planLayout } from './layout';

declare global {
  interface Window {
    vsorch: VsorchApi;
  }
}

const panesEl = document.getElementById('panes') as HTMLDivElement;
const addPaneBtn = document.getElementById('add-pane') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const layoutBtn = document.getElementById('layout-btn') as HTMLButtonElement;
const layoutMenu = document.getElementById('layout-menu') as HTMLDivElement;
const remotesBtn = document.getElementById('remotes-btn') as HTMLButtonElement;
const remotesMenu = document.getElementById('remotes-menu') as HTMLDivElement;

let baseUrl: string | null = null;
let layout: LayoutKind = 'row';

interface PaneRec {
  el: HTMLDivElement;
  /** undefined → local pane; set → remote pane on this host. */
  host?: string;
  webview: Element | null;
  overlay: HTMLDivElement | null;
}

const panes: PaneRec[] = [];
let remoteList: RemoteResolution[] = [];
const remoteStatuses = new Map<string, RemoteStatus>();

// --- layout (never re-parents panes; CSS grid placement only) ---

function applyLayout(): void {
  const plan = planLayout(layout, panes.length);
  panesEl.style.gridTemplateColumns = `repeat(${plan.columns}, 1fr)`;
  panesEl.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`;
  panes.forEach((pane, i) => {
    const p = plan.placements[i];
    pane.el.style.gridRow = String(p.row);
    pane.el.style.gridColumn = `${p.columnStart} / span ${p.columnSpan}`;
  });
}

function setActivePane(paneEl: HTMLDivElement): void {
  for (const active of Array.from(panesEl.querySelectorAll('.pane.active'))) {
    active.classList.remove('active');
  }
  paneEl.classList.add('active');
}

// --- pane construction ---

function createPane(host?: string): PaneRec {
  const el = document.createElement('div');
  el.className = 'pane';
  const rec: PaneRec = { el, host, webview: null, overlay: null };

  if (host) {
    const label = document.createElement('div');
    label.className = 'pane-label';
    label.textContent = host;
    el.appendChild(label);
  }

  panesEl.appendChild(el);
  panes.push(rec);
  applyLayout();
  setActivePane(el);
  return rec;
}

function setOverlay(
  rec: PaneRec,
  content: { text: string; error?: string; retry?: boolean },
  stale = false,
): void {
  clearOverlay(rec);
  const overlay = document.createElement('div');
  overlay.className = 'pane-overlay' + (stale ? ' stale' : '');

  const text = document.createElement('div');
  text.textContent = content.text;
  overlay.appendChild(text);

  if (content.error) {
    const err = document.createElement('div');
    err.className = 'overlay-error';
    err.textContent = content.error;
    overlay.appendChild(err);
  }
  if (content.retry && rec.host) {
    const host = rec.host;
    const btn = document.createElement('button');
    btn.textContent = 'Reconnect';
    btn.addEventListener('click', () => {
      void reconnectHost(host);
    });
    overlay.appendChild(btn);
  }

  rec.el.appendChild(overlay);
  rec.overlay = overlay;
}

function clearOverlay(rec: PaneRec): void {
  rec.overlay?.remove();
  rec.overlay = null;
}

function attachWebview(rec: PaneRec, origin: string): void {
  if (rec.webview) return;
  const paneId = crypto.randomUUID();
  const webview = document.createElement('webview');
  webview.setAttribute('src', `${origin}/?vsorchPane=${paneId}`);

  webview.addEventListener('focus', () => {
    setActivePane(rec.el);
    closeMenus();
  });
  webview.addEventListener('dom-ready', () => {
    (webview as unknown as { focus(): void }).focus();
    clearOverlay(rec);
  });
  rec.el.addEventListener('mousedown', () =>
    (webview as unknown as { focus(): void }).focus(),
  );

  rec.el.appendChild(webview);
  rec.webview = webview;
}

function reloadWebview(rec: PaneRec, origin: string): void {
  if (!rec.webview) {
    attachWebview(rec, origin);
    return;
  }
  const paneId = crypto.randomUUID();
  rec.webview.setAttribute('src', `${origin}/?vsorchPane=${paneId}`);
}

// --- local panes ---

function addLocalPane(): void {
  if (!baseUrl) return;
  const rec = createPane();
  attachWebview(rec, baseUrl);
}

// --- remote panes ---

function panesOf(host: string): PaneRec[] {
  return panes.filter((p) => p.host === host);
}

async function addRemotePane(host: string): Promise<void> {
  const rec = createPane(host);
  const known = remoteStatuses.get(host);
  if (known?.state === 'serving' && known.origin) {
    attachWebview(rec, known.origin);
    return;
  }
  setOverlay(rec, { text: `connecting to ${host}…` });
  const status = await window.vsorch.openRemotePane(host);
  applyRemoteStatus(status);
}

async function reconnectHost(host: string): Promise<void> {
  for (const rec of panesOf(host)) {
    setOverlay(rec, { text: `reconnecting to ${host}…` });
  }
  const status = await window.vsorch.openRemotePane(host);
  applyRemoteStatus(status);
}

function applyRemoteStatus(status: RemoteStatus): void {
  remoteStatuses.set(status.hostAlias, status);
  renderRemotesMenu();

  for (const rec of panesOf(status.hostAlias)) {
    switch (status.state) {
      case 'connecting':
        if (!rec.webview) {
          setOverlay(rec, { text: `connecting to ${status.hostAlias}…` });
        }
        break;
      case 'reconnecting':
        setOverlay(
          rec,
          { text: `connection to ${status.hostAlias} lost — reconnecting…` },
          true,
        );
        break;
      case 'serving':
        if (status.origin) {
          if (rec.webview) {
            // back after a drop: reload against the (stable) origin; the
            // overlay clears on the webview's next dom-ready
            if (rec.overlay) reloadWebview(rec, status.origin);
          } else {
            attachWebview(rec, status.origin);
          }
        }
        break;
      case 'failed':
        setOverlay(
          rec,
          {
            text: `${status.hostAlias} unavailable`,
            error: status.error
              ? `${status.error.kind}: ${status.error.message}`
              : undefined,
            retry: true,
          },
          rec.webview !== null,
        );
        break;
      case 'closed':
        setOverlay(rec, {
          text: `connection to ${status.hostAlias} closed`,
          retry: true,
        });
        break;
    }
  }
}

// --- remotes menu ---

function stateDot(host: string): string {
  const status = remoteStatuses.get(host);
  const resolution = remoteList.find((r) => r.hostAlias === host);
  if (status) {
    if (status.state === 'serving') return 'ok';
    if (status.state === 'connecting' || status.state === 'reconnecting')
      return 'busy';
    return 'bad';
  }
  if (resolution) return resolution.ok ? 'ok' : 'bad';
  return '';
}

function renderRemotesMenu(): void {
  remotesMenu.replaceChildren();
  if (remoteList.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'remotes-empty';
    empty.textContent = 'no remotes configured';
    remotesMenu.appendChild(empty);
    return;
  }
  for (const resolution of remoteList) {
    const host = resolution.hostAlias;
    const entry = document.createElement('button');
    entry.className = 'remote-entry';
    entry.disabled = !resolution.ok;
    entry.title = resolution.ok
      ? `open a pane on ${host}`
      : `${resolution.error.kind}: ${resolution.error.message}`;

    const dot = document.createElement('span');
    dot.className = `remote-dot ${stateDot(host)}`;
    entry.appendChild(dot);

    const name = document.createElement('span');
    name.textContent = host;
    entry.appendChild(name);

    const detail = document.createElement('span');
    detail.className = 'remote-detail';
    detail.textContent = resolution.ok
      ? (remoteStatuses.get(host)?.state ?? resolution.info.version)
      : resolution.error.kind;
    entry.appendChild(detail);

    if (resolution.ok) {
      entry.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenus();
        void addRemotePane(host);
      });
    }
    remotesMenu.appendChild(entry);
  }
}

function onRemotesResolved(remotes: RemoteResolution[]): void {
  remoteList = remotes;
  remotesBtn.disabled = remotes.length === 0;
  renderRemotesMenu();
}

// --- menus ---

function closeMenus(): void {
  layoutMenu.classList.add('hidden');
  remotesMenu.classList.add('hidden');
}

layoutBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  remotesMenu.classList.add('hidden');
  layoutMenu.classList.toggle('hidden');
});

remotesBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  layoutMenu.classList.add('hidden');
  remotesMenu.classList.toggle('hidden');
});

layoutMenu.addEventListener('click', (event) => {
  event.stopPropagation();
  const target = (event.target as HTMLElement).closest('button');
  const kind = target?.dataset.layout as LayoutKind | undefined;
  if (kind) {
    setLayout(kind);
    closeMenus();
  }
});

document.addEventListener('click', closeMenus);

function setLayout(kind: LayoutKind): void {
  layout = kind;
  for (const option of Array.from(layoutMenu.querySelectorAll('button'))) {
    option.classList.toggle('active', option.dataset.layout === kind);
  }
  applyLayout();
}

// --- server bring-up ---

function onServerReady(url: string): void {
  if (baseUrl) return; // already initialized
  baseUrl = url;
  statusEl.remove();
  addPaneBtn.disabled = false;
  layoutBtn.disabled = false;
  setLayout(layout);
  addLocalPane();
}

addPaneBtn.addEventListener('click', () => addLocalPane());

function onServerError(message: string): void {
  statusEl.textContent = `VS Code failed to start: ${message}`;
}

window.vsorch.onServerReady(onServerReady);
window.vsorch.onServerError(onServerError);
window.vsorch.onRemotesResolved(onRemotesResolved);
window.vsorch.onRemoteStatus(applyRemoteStatus);

// The server/remotes may already be up by the time this renderer loads (e.g.
// after a reload) — events would have been missed, so also ask directly.
void window.vsorch.getBaseUrl().then((url) => {
  if (url) onServerReady(url);
});
void window.vsorch.getRemotes().then((remotes) => {
  if (remotes.length) onRemotesResolved(remotes);
});
void window.vsorch.getRemoteStatuses().then((statuses) => {
  for (const status of statuses) {
    remoteStatuses.set(status.hostAlias, status);
  }
  if (statuses.length) renderRemotesMenu();
});
