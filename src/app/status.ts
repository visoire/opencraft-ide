// Version and live status of the IDE (offline cache, backend, Git). The Status page in the
// settings and the optional status bar read from here, so neither needs the other.
import { bus } from './bus.js';

export const VERSION = '1.2.0';

export interface AppStatus {
  /** Offline cache (service worker) */
  cache: string;
  /** Git branch and number of changes, or why Git is not available */
  git: string;
}

const state: AppStatus = { cache: '', git: '' };

export const appStatus = {
  get: (): Readonly<AppStatus> => state,
  set(patch: Partial<AppStatus>): void {
    Object.assign(state, patch);
    bus.emit('status:change');
  },
};
