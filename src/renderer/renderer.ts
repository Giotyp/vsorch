import './styles.css';
import type { VsorchApi } from '../preload';

declare global {
  interface Window {
    vsorch: VsorchApi;
  }
}

const panesEl = document.getElementById('panes') as HTMLDivElement;
const addPaneBtn = document.getElementById('add-pane') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

let baseUrl: string | null = null;

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
  pane.appendChild(webview);
  panesEl.appendChild(pane);
}

function onServerReady(url: string): void {
  if (baseUrl) return; // already initialized
  baseUrl = url;
  statusEl.remove();
  addPaneBtn.disabled = false;
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
