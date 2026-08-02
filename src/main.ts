import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { provisionExtensions, SERVER_DATA_DIR } from './extensionsProvisioner';
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
    // Snapshot the desktop extensions before the server spawns (§9).
    const extensionsDir = await provisionExtensions();
    const baseUrl = await serveWeb.start(extensionsDir, SERVER_DATA_DIR);
    broadcast('vsorch:server-ready', baseUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[vsorch] serve-web failed to start:', message);
    broadcast('vsorch:server-error', message);
  }
};

ipcMain.handle('vsorch:get-base-url', () => serveWeb.baseUrl);

app.on('ready', () => {
  createWindow();
  void startServer();
});

// Kill the serve-web process group so no orphaned servers survive quit (§8.3).
app.on('before-quit', () => {
  serveWeb.stop();
});

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
