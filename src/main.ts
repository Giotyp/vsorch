import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { provisionExtensions, SERVER_DATA_DIR } from './extensionsProvisioner';
import { RemoteResolution, resolveRemotes } from './remotes';
import { ServeWebManager } from './serveWebManager';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const serveWeb = new ServeWebManager();

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'vsorch',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

const broadcast = (channel: string, ...args: unknown[]) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
};

const startServer = async () => {
  try {
    // Snapshot the desktop extensions into <server-data-dir>/extensions
    // before the server spawns (§9).
    await provisionExtensions();
    const baseUrl = await serveWeb.start(SERVER_DATA_DIR);
    broadcast('vsorch:server-ready', baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vsorch] serve-web failed to start:', message);
    broadcast('vsorch:server-error', message);
  }
};

/** Latest per-remote resolution results (empty until resolution completes). */
let remoteResolutions: RemoteResolution[] = [];

const startRemotes = async () => {
  try {
    remoteResolutions = await resolveRemotes();
    for (const r of remoteResolutions) {
      if (r.ok) {
        console.log(
          `[vsorch] remote ${r.hostAlias}: code ${r.info.version} at ` +
            `${r.info.codePath} (serve-web ok)`,
        );
      } else {
        console.warn(
          `[vsorch] remote ${r.hostAlias}: ${r.error.kind} — ${r.error.message}`,
        );
      }
    }
    broadcast('vsorch:remotes-resolved', remoteResolutions);
  } catch (err) {
    console.error('[vsorch] remote resolution failed:', err);
  }
};

ipcMain.handle('vsorch:get-base-url', () => serveWeb.baseUrl);
ipcMain.handle('vsorch:get-remotes', () => remoteResolutions);

app.on('ready', () => {
  createWindow();
  // Local bring-up and remote resolution run in parallel — SSH latency (or a
  // dead remote) must never delay the local workbench.
  void startServer();
  void startRemotes();
});

// Kill the serve-web process group so no orphaned servers survive quit (§8.3).
app.on('before-quit', () => {
  serveWeb.stop();
});

// Terminal signals (e.g. Ctrl+C during `npm start`) bypass Electron's normal
// quit flow — route them through app.quit() so before-quit still runs.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
