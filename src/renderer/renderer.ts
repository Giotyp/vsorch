import './styles.css';
import type { RemoteStatus } from '../remoteConnection';
import type { RemoteResolution } from '../remotes';
import type { VsorchApi } from '../preload';
import type { Session } from '../session';
import { LayoutKind, rowsFor } from './layout';

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
const warningBanner = document.getElementById('warning-banner') as HTMLDivElement;
const warningText = document.getElementById('warning-text') as HTMLSpanElement;
const warningDismiss = document.getElementById(
  'warning-dismiss',
) as HTMLButtonElement;

let baseUrl: string | null = null;
let layout: LayoutKind = 'row';

// --- session persistence ---
//
// Pane composition (local vs. remote+host, in layout order) and layout kind
// are saved to ~/.vsorch/config.json on every change and replayed on the
// next launch. Sizes are deliberately not persisted — they already reset to
// equal on every pane add/close/layout change, so there's no steady state to
// save.

let savedSession: Session | null = null;
const sessionReady: Promise<void> = window.vsorch.getSession().then((s) => {
  savedSession = s;
});
/** Suppresses persistSession() while replaying a saved session, so a crash
 *  mid-restore can't overwrite the file with a partial pane list. */
let restoringSession = false;

// --- resizable dividers ---
//
// Every axis (the outer row/column layouts, and — nested — each row of the
// grid layout) is a single-row-or-column CSS grid: panes on odd tracks,
// draggable `.divider` elements on even tracks between them. `layoutAxis`
// builds one such grid from a weights array; `grid` layout nests one outer
// axis-grid (row heights) inside which each row is its own axis-grid (that
// row's column widths) — independent weights per row, so dividers always
// have an unambiguous pane boundary to sit on.

type Axis = 'row' | 'column';

interface AxisGrid {
  container: HTMLElement;
  axis: Axis;
  /** fr weights along `axis`, one per item — mutated in place while dragging. */
  weights: number[];
}

const DIVIDER_SIZE = 6; // px
const MIN_PANE_PX = 80;

function applyAxisTemplate(grid: AxisGrid): void {
  const template = grid.weights.map((w) => `${w}fr`).join(` ${DIVIDER_SIZE}px `);
  if (grid.axis === 'column') {
    grid.container.style.gridTemplateColumns = template;
  } else {
    grid.container.style.gridTemplateRows = template;
  }
}

function startAxisDrag(event: MouseEvent, grid: AxisGrid, index: number): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = grid.container.getBoundingClientRect();
  const containerSize = grid.axis === 'column' ? rect.width : rect.height;
  const totalWeight = grid.weights.reduce((a, b) => a + b, 0);
  const minWeight = (MIN_PANE_PX / containerSize) * totalWeight;
  const startPos = grid.axis === 'column' ? event.clientX : event.clientY;
  const startA = grid.weights[index];
  const startB = grid.weights[index + 1];

  document.body.classList.add('resizing');
  document.body.style.cursor = grid.axis === 'column' ? 'col-resize' : 'row-resize';

  const onMove = (e: MouseEvent) => {
    const pos = grid.axis === 'column' ? e.clientX : e.clientY;
    const deltaWeight = ((pos - startPos) / containerSize) * totalWeight;
    const a = startA + deltaWeight;
    const b = startB - deltaWeight;
    if (a < minWeight || b < minWeight) return;
    grid.weights[index] = a;
    grid.weights[index + 1] = b;
    applyAxisTemplate(grid);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/**
 * Lay `items` out along `grid.axis` inside `grid.container`, with a
 * draggable divider between each pair. Reparents `items` into the container
 * (a no-op if already there) — safe to call on elements already connected
 * elsewhere in the live tree, since a single `appendChild` move never
 * disconnects them (which would reload a pane's webview).
 */
function layoutAxis(grid: AxisGrid, items: HTMLElement[]): void {
  grid.container.classList.add('axis-container');
  applyAxisTemplate(grid);
  if (grid.axis === 'column') {
    grid.container.style.gridTemplateRows = '1fr';
  } else {
    grid.container.style.gridTemplateColumns = '1fr';
  }

  items.forEach((item, i) => {
    grid.container.appendChild(item);
    const track = String(2 * i + 1);
    if (grid.axis === 'column') {
      item.style.gridColumn = track;
      item.style.gridRow = '1';
    } else {
      item.style.gridRow = track;
      item.style.gridColumn = '1';
    }
  });

  for (let i = 0; i < items.length - 1; i++) {
    const divider = document.createElement('div');
    divider.className = `divider ${grid.axis === 'column' ? 'divider-col' : 'divider-row'}`;
    const track = String(2 * i + 2);
    if (grid.axis === 'column') {
      divider.style.gridColumn = track;
      divider.style.gridRow = '1';
    } else {
      divider.style.gridRow = track;
      divider.style.gridColumn = '1';
    }
    divider.addEventListener('mousedown', (event) => startAxisDrag(event, grid, i));
    grid.container.appendChild(divider);
  }
}

/** fr weights for row/column layouts — one per pane, reset on count/kind change. */
let colWeights: number[] = [];
let rowWeights: number[] = [];
let weightsFor = ''; // `${layout}:${count}` the weights above currently match

function ensureWeights(): void {
  const key = `${layout}:${panes.length}`;
  if (weightsFor === key) return;
  weightsFor = key;
  if (layout === 'row') colWeights = new Array(panes.length).fill(1);
  else if (layout === 'column') rowWeights = new Array(panes.length).fill(1);
}

/** grid layout: one row-height weight per row, one column-width weight array per row. */
let gridRowWeights: number[] = [];
let gridColWeights: number[][] = [];
let gridWeightsFor = ''; // `grid:${count}` the weights above currently match

function ensureGridWeights(): void {
  const key = `grid:${panes.length}`;
  if (gridWeightsFor === key) return;
  gridWeightsFor = key;
  const sizes = rowsFor('grid', panes.length);
  gridRowWeights = new Array(sizes.length).fill(1);
  gridColWeights = sizes.map((size) => new Array(size).fill(1));
}

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

// --- layout ---

/**
 * Rebuild the pane tree for the current layout. `stale` (old dividers, and
 * — after a `grid` render — old `.grid-row` wrappers) is collected up front
 * but only removed once every live pane has moved to its new home, so a
 * pane is never fully disconnected from the document (which would reload
 * its webview): each move is a direct `appendChild` between two containers
 * that are already connected, never a remove-then-later-reinsert.
 */
function applyLayout(): void {
  const stale = Array.from(panesEl.children).filter(
    (el) => !el.classList.contains('pane'),
  );

  if (layout === 'grid') {
    ensureGridWeights();
    const sizes = rowsFor('grid', panes.length);
    const paneEls = panes.map((p) => p.el);
    const rowsOfPanes: HTMLDivElement[][] = [];
    let cursor = 0;
    for (const size of sizes) {
      rowsOfPanes.push(paneEls.slice(cursor, cursor + size));
      cursor += size;
    }

    const wrappers = rowsOfPanes.map(() => {
      const wrapper = document.createElement('div');
      wrapper.className = 'grid-row';
      return wrapper;
    });
    // Wrappers join the live tree first, then panes move straight into them.
    for (const wrapper of wrappers) panesEl.appendChild(wrapper);
    rowsOfPanes.forEach((rowPanes, i) => {
      for (const el of rowPanes) wrappers[i].appendChild(el);
    });
    for (const el of stale) el.remove();

    rowsOfPanes.forEach((rowPanes, rowIndex) => {
      layoutAxis(
        { container: wrappers[rowIndex], axis: 'column', weights: gridColWeights[rowIndex] },
        rowPanes,
      );
    });
    layoutAxis({ container: panesEl, axis: 'row', weights: gridRowWeights }, wrappers);
    return;
  }

  ensureWeights();
  const axis: Axis = layout === 'row' ? 'column' : 'row';
  const weights = layout === 'row' ? colWeights : rowWeights;
  const paneEls = panes.map((p) => p.el);
  for (const el of paneEls) panesEl.appendChild(el); // pull out of any grid-row wrapper
  for (const el of stale) el.remove();
  layoutAxis({ container: panesEl, axis, weights }, paneEls);
}

function persistSession(): void {
  if (restoringSession) return;
  void window.vsorch.saveSession({
    layout,
    panes: panes.map((p) => (p.host ? { host: p.host } : {})),
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

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close';
  closeBtn.title = 'Close pane';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('mousedown', (event) => event.stopPropagation());
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    closePane(rec);
  });
  el.appendChild(closeBtn);

  panesEl.appendChild(el);
  panes.push(rec);
  applyLayout();
  setActivePane(el);
  persistSession();
  return rec;
}

function closePane(rec: PaneRec): void {
  const index = panes.indexOf(rec);
  if (index === -1) return;
  panes.splice(index, 1);
  const wasActive = rec.el.classList.contains('active');
  rec.el.remove();
  applyLayout();
  if (wasActive && panes.length > 0) {
    setActivePane(panes[panes.length - 1].el);
  }
  persistSession();
  // Last pane on a remote host → tear down its connection (forward, remote
  // server, master); the ☁ menu can bring it back up on demand.
  if (rec.host && panesOf(rec.host).length === 0) {
    void window.vsorch.closeRemote(rec.host);
  }
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
  // Surface load failures instead of hanging behind the overlay forever.
  webview.addEventListener('did-fail-load', (event) => {
    const e = event as unknown as {
      errorCode: number;
      errorDescription: string;
      isMainFrame: boolean;
    };
    if (!e.isMainFrame || e.errorCode === -3 /* ERR_ABORTED: benign */) return;
    setOverlay(rec, {
      text: rec.host ? `${rec.host}: workbench failed to load` : 'workbench failed to load',
      error: `${e.errorDescription} (${e.errorCode})`,
      retry: rec.host !== undefined,
    });
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

/**
 * Create the pane immediately (so it takes its slot in the layout) and kick
 * off the connection in the background. Used both for user-initiated opens
 * (remotes are already resolved by then — the ☁ menu entry is disabled
 * otherwise) and for session restore (remotes may still be resolving;
 * connectRemotePane waits rather than racing main's resolution).
 */
function addRemotePane(host: string): void {
  const rec = createPane(host);
  const known = remoteStatuses.get(host);
  if (known?.state === 'serving' && known.origin) {
    attachWebview(rec, known.origin);
    return;
  }
  setOverlay(rec, { text: `connecting to ${host}…` });
  void connectRemotePane(host);
}

async function connectRemotePane(host: string): Promise<void> {
  await waitForRemotesResolved();
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
        addRemotePane(host);
      });
    }
    remotesMenu.appendChild(entry);
  }
}

let remotesResolvedOnce = false;
let remotesResolvedWaiters: Array<() => void> = [];

/** Resolves once remote resolution has completed at least once (possibly
 *  with zero remotes) — used to sequence session-restored remote panes
 *  behind main's SSH resolution without blocking anything else. */
function waitForRemotesResolved(): Promise<void> {
  if (remotesResolvedOnce) return Promise.resolve();
  return new Promise((resolve) => remotesResolvedWaiters.push(resolve));
}

function onRemotesResolved(remotes: RemoteResolution[]): void {
  remoteList = remotes;
  remotesBtn.disabled = remotes.length === 0;
  renderRemotesMenu();
  if (!remotesResolvedOnce) {
    remotesResolvedOnce = true;
    const waiters = remotesResolvedWaiters;
    remotesResolvedWaiters = [];
    for (const resolve of waiters) resolve();
  }
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
  persistSession();
}

// --- server bring-up ---

/**
 * Replay a saved pane list in order. Local panes attach immediately; remote
 * panes take their layout slot immediately too, but connectRemotePane (via
 * waitForRemotesResolved) defers the actual connection attempt until main
 * has finished resolving hosts, so this never blocks on SSH.
 */
function restoreSession(session: Session): void {
  restoringSession = true;
  setLayout(session.layout);
  for (const p of session.panes) {
    if (p.host) addRemotePane(p.host);
    else addLocalPane();
  }
  restoringSession = false;
  persistSession();
}

async function onServerReady(url: string): Promise<void> {
  if (baseUrl) return; // already initialized
  baseUrl = url;
  statusEl.remove();
  addPaneBtn.disabled = false;
  layoutBtn.disabled = false;
  await sessionReady;
  if (savedSession && savedSession.panes.length > 0) {
    restoreSession(savedSession);
  } else {
    setLayout(layout);
    addLocalPane();
  }
}

addPaneBtn.addEventListener('click', () => addLocalPane());

function onServerError(message: string): void {
  statusEl.textContent = `VS Code failed to start: ${message}`;
}

function onServerWarning(message: string): void {
  warningText.textContent = message;
  warningBanner.classList.remove('hidden');
}

warningDismiss.addEventListener('click', () => {
  warningBanner.classList.add('hidden');
});

window.vsorch.onServerReady(onServerReady);
window.vsorch.onServerError(onServerError);
window.vsorch.onServerWarning(onServerWarning);
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
