// Interface settings (per browser). AI keys do not live here but in the backend.
import { bus } from './bus.js';
import { readTheme } from './theme-store.js';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  renderer: 'auto' | 'webgl';
  appDownloads: 'project' | 'both';
  sounds: boolean;
  autoOpenPanels: boolean;
  /** Minutes after which hidden apps are unloaded. 0 = never (the state is kept). */
  autoUnloadMinutes: number;
  chatProvider: string;
  /** Status bar at the bottom. Off by default: the same details are on the Status page in the settings. */
  statusbar: boolean;
  /** Footer line under each panel (file status, renderer, start time). Off by default. */
  panelFooters: boolean;
  /** Focus mode: hides the top bar and the tool rail, only the panels stay. */
  focusMode: boolean;
  /** Side of the AI chat sidebar. The project tree takes the other side of the chat. */
  chatSide: 'right' | 'left';
  /** Thinking effort per provider id from the reasoning bar ('auto': the provider default or preset) */
  effort: Record<string, 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max'>;
  /** Exact counts from Claude and Gemini (count_tokens, countTokens) while typing: sends the draft */
  remoteCount: boolean;
  /** Chat mode: one agent, or Team Mode (a Team Leader with parallel specialist sub-agents) */
  chatMode: 'single' | 'team';
}

const DEFAULTS: Prefs = { theme: 'system', renderer: 'auto', appDownloads: 'project', sounds: false, autoOpenPanels: true, autoUnloadMinutes: 0, chatProvider: '', statusbar: false, panelFooters: false, focusMode: false, chatSide: 'right', effort: {}, remoteCount: false, chatMode: 'single' };
const KEY = 'opencraft.prefs';

function load(): Prefs {
  try {
    const p = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Prefs>) };
    // The IDE's own choice (scope 'ide', newest of localStorage and cookie), separate from the website
    p.theme = readTheme('ide') as Prefs['theme'];
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

const state = load();

export const prefs = {
  get<K extends keyof Prefs>(k: K): Prefs[K] {
    return state[k];
  },
  set<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
    state[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage blocked */
    }
    bus.emit('settings:change', { key: k });
  },
};
