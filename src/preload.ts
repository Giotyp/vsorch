import { contextBridge, ipcRenderer } from 'electron';

import type { RemoteStatus } from './remoteConnection';
import type { RemoteResolution } from './remotes';
import type { Session } from './session';

export interface VsorchApi {
  /** Resolves the serve-web base URL, or null if the server isn't ready yet. */
  getBaseUrl(): Promise<string | null>;
  /** Saved pane composition + layout from the previous run, or null if none. */
  getSession(): Promise<Session | null>;
  /** Persist the current pane composition + layout for the next launch. */
  saveSession(session: Session): Promise<void>;
  /** Fires once the shared serve-web server is ready. */
  onServerReady(callback: (baseUrl: string) => void): void;
  /** Fires if the server failed to start. */
  onServerError(callback: (message: string) => void): void;
  /** Fires once, alongside server-ready, if a version mismatch was detected. */
  onServerWarning(callback: (message: string) => void): void;
  /** Per-remote resolution results so far (empty until resolution ran). */
  getRemotes(): Promise<RemoteResolution[]>;
  /** Fires when all configured remotes finished resolving. */
  onRemotesResolved(callback: (remotes: RemoteResolution[]) => void): void;
  /** Bring up (or reuse) the host's serve-web; resolves at serving/failed. */
  openRemotePane(hostAlias: string): Promise<RemoteStatus>;
  /** Tear down a host's connection (last pane on it was closed). */
  closeRemote(hostAlias: string): Promise<void>;
  /** Current connection status for every host that was opened. */
  getRemoteStatuses(): Promise<RemoteStatus[]>;
  /** Fires on every remote connection state change. */
  onRemoteStatus(callback: (status: RemoteStatus) => void): void;
}

const api: VsorchApi = {
  getBaseUrl: () => ipcRenderer.invoke('vsorch:get-base-url'),
  getSession: () => ipcRenderer.invoke('vsorch:get-session'),
  saveSession: (session) => ipcRenderer.invoke('vsorch:save-session', session),
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
  onServerWarning: (callback) => {
    ipcRenderer.on('vsorch:server-warning', (_event, message: string) =>
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
  closeRemote: (hostAlias) =>
    ipcRenderer.invoke('vsorch:close-remote', hostAlias),
  getRemoteStatuses: () => ipcRenderer.invoke('vsorch:get-remote-statuses'),
  onRemoteStatus: (callback) => {
    ipcRenderer.on('vsorch:remote-status', (_event, status: RemoteStatus) =>
      callback(status),
    );
  },
};

contextBridge.exposeInMainWorld('vsorch', api);
