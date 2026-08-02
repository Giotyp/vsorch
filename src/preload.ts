import { contextBridge, ipcRenderer } from 'electron';

export interface VsorchApi {
  /** Resolves the serve-web base URL, or null if the server isn't ready yet. */
  getBaseUrl(): Promise<string | null>;
  /** Fires once the shared serve-web server is ready. */
  onServerReady(callback: (baseUrl: string) => void): void;
  /** Fires if the server failed to start. */
  onServerError(callback: (message: string) => void): void;
}

const api: VsorchApi = {
  getBaseUrl: () => ipcRenderer.invoke('vsorch:get-base-url'),
  onServerReady: (callback) => {
    ipcRenderer.on('vsorch:server-ready', (_event, baseUrl: string) =>
      callback(baseUrl),
    );
  },
  onServerError: (callback) => {
    ipcRenderer.on('vsorch:server-error', (_event, message: string) =>
      callback(message),
    );
  },
};

contextBridge.exposeInMainWorld('vsorch', api);
