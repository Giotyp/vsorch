import type { LayoutKind } from './renderer/layout';

/** One saved pane: local (no host) or remote (host alias), in layout order. */
export interface SessionPane {
  host?: string;
}

/** Pane composition + layout kind, persisted so a restart can restore them. */
export interface Session {
  layout: LayoutKind;
  panes: SessionPane[];
}

/** Guards against a hand-edited or stale `session` key in config.json. */
export function isValidSession(x: unknown): x is Session {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as { layout?: unknown; panes?: unknown };
  if (s.layout !== 'row' && s.layout !== 'column' && s.layout !== 'grid') return false;
  if (!Array.isArray(s.panes)) return false;
  return s.panes.every((p) => {
    if (typeof p !== 'object' || p === null) return false;
    const host = (p as { host?: unknown }).host;
    return host === undefined || typeof host === 'string';
  });
}
