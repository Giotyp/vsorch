import './styles.css';
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

let baseUrl: string | null = null;
let layout: LayoutKind = 'row';
const paneEls: HTMLDivElement[] = [];

/**
 * Position every pane according to the current layout using CSS grid.
 * Panes are never re-parented — moving a <webview> in the DOM would reload
 * its workbench — only their grid placement styles change.
 */
function applyLayout(): void {
  const plan = planLayout(layout, paneEls.length);
  panesEl.style.gridTemplateColumns = `repeat(${plan.columns}, 1fr)`;
  panesEl.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`;
  paneEls.forEach((pane, i) => {
    const p = plan.placements[i];
    pane.style.gridRow = String(p.row);
    pane.style.gridColumn = `${p.columnStart} / span ${p.columnSpan}`;
  });
}

/**
 * Create a new VS Code pane. All panes share the one serve-web origin; a
 * unique query param keeps each workbench's window state distinct (§8.2).
 */
function addPane(): void {
  if (!baseUrl) return;

  const paneId = crypto.randomUUID();
  const pane = document.createElement('div');
  pane.className = 'pane';

  const webview = document.createElement('webview');
  webview.setAttribute('src', `${baseUrl}/?vsorchPane=${paneId}`);

  // Route keystrokes to whichever pane the user last interacted with, and
  // show a visible active indicator on it.
  webview.addEventListener('focus', () => {
    setActivePane(pane);
    closeLayoutMenu();
  });
  webview.addEventListener('dom-ready', () => webview.focus());
  pane.addEventListener('mousedown', () => webview.focus());

  pane.appendChild(webview);
  panesEl.appendChild(pane);
  paneEls.push(pane);
  applyLayout();
  setActivePane(pane);
  webview.focus();
}

function setActivePane(pane: HTMLDivElement): void {
  for (const active of Array.from(panesEl.querySelectorAll('.pane.active'))) {
    active.classList.remove('active');
  }
  pane.classList.add('active');
}

function setLayout(kind: LayoutKind): void {
  layout = kind;
  for (const option of Array.from(layoutMenu.querySelectorAll('button'))) {
    option.classList.toggle('active', option.dataset.layout === kind);
  }
  applyLayout();
}

function closeLayoutMenu(): void {
  layoutMenu.classList.add('hidden');
}

layoutBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  layoutMenu.classList.toggle('hidden');
});

layoutMenu.addEventListener('click', (event) => {
  event.stopPropagation();
  const target = (event.target as HTMLElement).closest('button');
  const kind = target?.dataset.layout as LayoutKind | undefined;
  if (kind) {
    setLayout(kind);
    closeLayoutMenu();
  }
});

// Clicks anywhere else dismiss the menu (webview clicks are caught via the
// panes' focus handlers, since they don't bubble to the document).
document.addEventListener('click', closeLayoutMenu);

function onServerReady(url: string): void {
  if (baseUrl) return; // already initialized
  baseUrl = url;
  statusEl.remove();
  addPaneBtn.disabled = false;
  layoutBtn.disabled = false;
  setLayout(layout);
  addPane();
}

addPaneBtn.addEventListener('click', () => addPane());

function onServerError(message: string): void {
  statusEl.textContent = `VS Code failed to start: ${message}`;
}

window.vsorch.onServerReady(onServerReady);
window.vsorch.onServerError(onServerError);

// The server may already be up by the time this renderer loads (e.g. after a
// reload) — the ready event would have been missed, so also ask directly.
void window.vsorch.getBaseUrl().then((url) => {
  if (url) onServerReady(url);
});
