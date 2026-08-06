import { contextBridge, ipcRenderer } from 'electron';

import type { RemoteStatus } from './remoteConnection';
import type { RemoteResolution } from './remotes';

export interface VsorchApi {
  /** Resolves the serve-web base URL, or null if the server isn't ready yet. */
  getBaseUrl(): Promise<string | null>;
  /** Fires once the shared serve-web server is ready. */
  onServerReady(callback: (baseUrl: string) => void): void;
  /** Fires if the server failed to start. */
  onServerError(callback: (message: string) => void): void;
  /** Per-remote resolution results so far (empty until resolution ran). */
  getRemotes(): Promise<RemoteResolution[]>;
  /** Fires when all configured remotes finished resolving. */
  onRemotesResolved(callback: (remotes: RemoteResolution[]) => void): void;
  /** Bring up (or reuse) the host's serve-web; resolves at serving/failed. */
  openRemotePane(hostAlias: string): Promise<RemoteStatus>;
  /** Current connection status for every host that was opened. */
  getRemoteStatuses(): Promise<RemoteStatus[]>;
  /** Fires on every remote connection state change. */
  onRemoteStatus(callback: (status: RemoteStatus) => void): void;
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
  getRemotes: () => ipcRenderer.invoke('vsorch:get-remotes'),
  onRemotesResolved: (callback) => {
    ipcRenderer.on(
      'vsorch:remotes-resolved',
      (_event, remotes: RemoteResolution[]) => callback(remotes),
    );
  },
  openRemotePane: (hostAlias) =>
    ipcRenderer.invoke('vsorch:open-remote-pane', hostAlias),
  getRemoteStatuses: () => ipcRenderer.invoke('vsorch:get-remote-statuses'),
  onRemoteStatus: (callback) => {
    ipcRenderer.on('vsorch:remote-status', (_event, status: RemoteStatus) =>
      callback(status),
    );
  },
};

contextBridge.exposeInMainWorld('vsorch', api);
