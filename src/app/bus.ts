// Typed event bus of the workspace.

import type { DeviceInfo } from './device.js';

export interface BusEvents {
  'fs:change': void;
  'fs:file': { path: string; kind: 'change' | 'delete' | 'create'; origin: string };
  'project:changed': void;
  'project:renamed': { id: string; name: string };
  'ai:usage': import('../chat/types.js').TokenUsage;
  'chat:view': { full: boolean };
  'tool:activity': { phase: 'start' | 'progress' | 'end'; name: string; path?: string; message?: string; ok?: boolean; callId?: string };
  'term:data': { id: string; data: string };
  'term:exit': { id: string; code: number | null };
  /** Which shell runs in a terminal panel (PowerShell, Command Prompt or a POSIX shell) */
  'term:shell': { id: string; kind: 'powershell' | 'cmd' | 'posix'; file: string };
  'ws:state': { connected: boolean };
  'settings:change': { key: string };
  'workspace:change': void;
  'workspace:focus': { id: string | null; tool: string | null };
  'workspace:resize': void;
  'workspace:resources': void;
  'ai:status': void;
  /** Configuration in the backend changed (privacy, personas, search) */
  'config:change': void;
  'search:open': string | undefined;
  /** A measurement for the local performance metrics (only kept when metrics are on) */
  metric: { name: string; value: number };
  'log:line': import('./logs.js').UiLog;
  'privacy:change': { localOnly: boolean };
  'ai:toggle': boolean | undefined;
  'palette:open': string | undefined;
  'chat:insert': string;
  /** Put @ or / into the chat input and open the menu (quick access without a keyboard) */
  'chat:trigger': '@' | '/';
  /** Live status changed (offline cache, Git), see src/app/status.ts */
  'status:change': void;
  'open-settings': string | undefined;
  'device:change': DeviceInfo;
  'backend:mode': { mode: 'desktop' | 'browser'; reason?: string };
  /** Team Mode: a sub-agent writes a file (its accent flashes on the panels that show it) */
  'agent:file': { path: string; role: string; label: string; accent: string; state: 'writing' | 'written' | 'error' };
  /** Team Mode: open the team configuration (/roster) */
  'team:roster': void;
  'pencil:sample': { panel: string | null; kind: 'pen' | 'touch' | 'mouse'; pressure: number; tiltX: number; tiltY: number; twist: number; hover: boolean };
}

type Handler<T> = (data: T) => void;
const listeners = new Map<keyof BusEvents, Set<Handler<never>>>();

export const bus = {
  on<K extends keyof BusEvents>(evt: K, fn: Handler<BusEvents[K]>): () => void {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt)!.add(fn as Handler<never>);
    return () => listeners.get(evt)?.delete(fn as Handler<never>);
  },
  emit<K extends keyof BusEvents>(evt: K, ...[data]: BusEvents[K] extends void ? [] : [BusEvents[K]]): void {
    for (const fn of listeners.get(evt) || []) {
      try {
        (fn as Handler<BusEvents[K] | undefined>)(data);
      } catch (e) {
        console.error(`[bus] ${evt}`, e);
      }
    }
  },
};
