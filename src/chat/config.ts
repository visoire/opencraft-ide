// The frontend's view of the AI configuration in the backend (keys are masked).

import { api } from '../app/backend.js';
import { bus } from '../app/bus.js';
import type { DeepSeekSettings } from './deepseek.js';
import { familyOf, type Family } from './models.js';
import type { TeamSettings } from './team.js';

export interface PublicProvider {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai' | 'gemini';
  local: boolean;
  needsKey: boolean;
  docs: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  keyHint: string;
}
export interface PublicCustom {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
}
export interface McpEntry {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  transport?: 'stdio' | 'http';
  url?: string;
  sandbox?: 'strict' | 'standard' | 'off';
  approval?: 'ask' | 'read' | 'all';
  plugin?: string;
}
export interface Persona {
  id: string;
  name: string;
  prompt: string;
  builtIn?: boolean;
}
export interface PersonalConfig {
  context: string;
  active: string;
  personas: Persona[];
}
export interface SearchConfig {
  embeddings: boolean;
  embedModel: string;
  memory: boolean;
  ragChunks: number;
}
export interface PublicConfig {
  activeProject: string;
  git: { name: string; email: string };
  mcpServers: McpEntry[];
  privacy: { localOnly: boolean; audit: boolean };
  personal: PersonalConfig;
  search: SearchConfig;
  metrics: { enabled: boolean };
  plugins: { disabled: string[] };
  ai: { active: string; providers: PublicProvider[]; custom: PublicCustom[]; deepseek?: DeepSeekSettings };
  /** Team Mode: active team and saved team configurations */
  team?: TeamSettings;
}
export interface AiStatus {
  mode: string;
  localOnly?: boolean;
  active: { id: string; name: string; model: string; local: boolean } | null;
  error?: string;
  ollamaReachable: boolean;
  providers: { id: string; name: string; local: boolean; configured: boolean; blocked?: boolean }[];
}
export interface TestResult {
  ok: boolean;
  models: string[];
  error?: { code: string; message: string };
}

let cachedStatus: AiStatus | null = null;
let cachedConfig: PublicConfig | null = null;

export const aiConfig = {
  async get(): Promise<PublicConfig> {
    cachedConfig = await api.get<PublicConfig>('/api/config');
    bus.emit('config:change');
    return cachedConfig;
  },
  /** Last loaded configuration (personas, privacy) without a request */
  get config() {
    return cachedConfig;
  },
  /** Saves part of the configuration (privacy, personal, search) and keeps the cache fresh. */
  async put(section: 'privacy' | 'personal' | 'search' | 'deepseek' | 'team', body: unknown): Promise<PublicConfig> {
    cachedConfig = await api.send<PublicConfig>('PUT', `/api/config/${section}`, body);
    bus.emit('config:change');
    return cachedConfig;
  },
  async status(force = false): Promise<AiStatus> {
    if (cachedStatus && !force) return cachedStatus;
    cachedStatus = await api.get<AiStatus>('/api/ai/status');
    bus.emit('ai:status');
    return cachedStatus;
  },
  get cached() {
    return cachedStatus;
  },
  async changed() {
    cachedStatus = null;
    await this.status(true).catch(() => {});
  },
};

/**
 * Provider and model the chat uses now: the choice in the chat (chatProvider) or the default.
 * deepseek: counts exactly with the V4 tokenizer and offers the DeepSeek presets.
 */
export function chatTarget(chosen: string): { id: string; name: string; model: string; deepseek: boolean; family: Family; local: boolean } | null {
  const st = cachedStatus;
  const cfg = cachedConfig;
  const id = chosen || st?.active?.id || '';
  if (!id) return null;
  const preset = cfg?.ai.providers.find((x) => x.id === id);
  const custom = cfg?.ai.custom.find((x) => x.id === id);
  const model = preset?.model || custom?.model || (st?.active?.id === id ? st.active.model : '') || '';
  const family = familyOf({ id, kind: preset?.kind || 'openai', baseUrl: preset?.baseUrl || custom?.baseUrl || '' });
  return { id, name: preset?.name || custom?.name || st?.active?.name || id, model, deepseek: family === 'deepseek', family, local: !!preset?.local };
}
