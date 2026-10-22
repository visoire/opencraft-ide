// Local configuration: providers, API keys, own endpoints, MCP servers, Git author.
// Lives in ~/OpenCraft/config.json (os.homedir(), on Windows C:\Users\<name>\OpenCraft),
// on macOS and Linux with file mode 0600 (only for the own user account).
// Keys leave the computer only in requests to the provider in question and reach
// the frontend only masked.

import { readFileSync, writeFileSync, chmodSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { CONFIG_FILE, IS_WIN } from './paths.js';
import { PRESETS } from '../chat/providers.js';
import type { ProviderConfig } from '../chat/types.js';
import { DEFAULT_PERSONAS, isLocalUrl } from '../core/defaults.js';
import { TeamSettingsSchema } from '../chat/team.js';
export { isLocalUrl };

const ProviderEntry = z.object({
  apiKey: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
});

const CustomEntry = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]+$/),
  name: z.string().min(1).max(60),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
});

const McpEntry = z.object({
  id: z.string(),
  name: z.string().min(1).max(40),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** stdio (default) or Streamable HTTP (url) */
  transport: z.enum(['stdio', 'http']).default('stdio'),
  url: z.string().url().optional(),
  /** Sandbox of the process: strict (clean environment, Node permission model), standard (clean environment), off */
  sandbox: z.enum(['strict', 'standard', 'off']).default('standard'),
  /** ask: every call needs a confirmation, read: read-only tools run freely, all: no confirmation */
  approval: z.enum(['ask', 'read', 'all']).default('ask'),
  /** Plugin this server comes from (opencraft.plugin.json), otherwise added by hand */
  plugin: z.string().optional(),
});

/** DeepSeek parameter preset plus optional overrides (src/chat/deepseek.ts). */
export const DeepSeekEntry = z.object({
  preset: z.enum(['chat', 'reasoning', 'max', 'coding']).default('reasoning'),
  maxTokens: z.number().int().min(1).max(393_216).optional(),
  temperature: z.number().min(0).max(2).optional(),
  effort: z.enum(['low', 'high', 'max']).optional(),
});

const Persona = z.object({
  id: z.string().regex(/^[\w-]{2,40}$/),
  name: z.string().min(1).max(60),
  prompt: z.string().max(8000),
  builtIn: z.boolean().optional(),
});

export { DEFAULT_PERSONAS };

export const ConfigSchema = z.object({
  activeProject: z.string().nullable().default(null),
  ai: z
    .object({
      active: z.string().default('auto'),
      providers: z.record(z.string(), ProviderEntry).default({}),
      custom: z.array(CustomEntry).default([]),
      deepseek: DeepSeekEntry.default({ preset: 'reasoning' }),
    })
    .default({ active: 'auto', providers: {}, custom: [], deepseek: { preset: 'reasoning' } }),
  mcpServers: z.array(McpEntry).default([]),
  git: z.object({ name: z.string().default('OpenCraft'), email: z.string().default('lokal@opencraft') }).default({ name: 'OpenCraft', email: 'lokal@opencraft' }),
  /** Home network mode: backend reachable on Wi-Fi too (only with the access token), applies at start */
  lan: z.object({ enabled: z.boolean().default(false), token: z.string().min(16).optional() }).default({ enabled: false }),
  /** Privacy: Local-only mode blocks every cloud provider (only Ollama and local endpoints) */
  privacy: z.object({ localOnly: z.boolean().default(false), audit: z.boolean().default(true) }).default({ localOnly: false, audit: true }),
  /** Personal context and personas for the system prompt */
  personal: z
    .object({
      context: z.string().max(8000).default(''),
      active: z.string().default('default'),
      personas: z.array(Persona).default(DEFAULT_PERSONAS),
    })
    .default({ context: '', active: 'default', personas: DEFAULT_PERSONAS }),
  /** Search, embeddings (Ollama) and project memory (RAG) */
  search: z
    .object({
      embeddings: z.boolean().default(false),
      embedModel: z.string().default('nomic-embed-text'),
      memory: z.boolean().default(true),
      ragChunks: z.number().int().min(0).max(12).default(4),
    })
    .default({ embeddings: false, embedModel: 'nomic-embed-text', memory: true, ragChunks: 4 }),
  /** Plugins in ~/OpenCraft/plugins that are switched off */
  plugins: z.object({ disabled: z.array(z.string()).default([]) }).default({ disabled: [] }),
  /** Local performance metrics (never sent anywhere) */
  metrics: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /** Team Mode: the active team (leader, specialists, models) and saved team configurations */
  team: TeamSettingsSchema.default({ saved: [] }),
});
export type Persona = z.infer<typeof Persona>;
export type Config = z.infer<typeof ConfigSchema>;
export type CustomProvider = z.infer<typeof CustomEntry>;
export type McpServerEntry = z.infer<typeof McpEntry>;

let current: Config = load();

function load(): Config {
  if (!existsSync(CONFIG_FILE)) return ConfigSchema.parse({});
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')));
  } catch (e) {
    // Back up a damaged file and go on with defaults
    try {
      renameSync(CONFIG_FILE, CONFIG_FILE + `.broken-${Date.now()}`);
    } catch {
      /* ignorieren */
    }
    console.warn('config.json was invalid and was backed up:', (e as Error).message);
    return ConfigSchema.parse({});
  }
}

export function config(): Config {
  return current;
}

export function saveConfig(next: Config): Config {
  current = ConfigSchema.parse(next);
  const body = JSON.stringify(current, null, 2);
  const tmp = CONFIG_FILE + '.tmp';
  // File mode 0600 exists only on macOS and Linux. Windows ignores mode when writing
  // and protects the file through the user profile (C:\Users\<name>\OpenCraft).
  writeFileSync(tmp, body, IS_WIN ? undefined : { mode: 0o600 });
  try {
    renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    // Windows: target briefly locked (virus scanner, editor). Write directly instead of renaming.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
    writeFileSync(CONFIG_FILE, body);
    try {
      unlinkSync(tmp);
    } catch {
      /* stays, overwritten on the next save */
    }
  }
  if (!IS_WIN) {
    try {
      chmodSync(CONFIG_FILE, 0o600);
    } catch {
      /* file system without Unix permissions */
    }
  }
  return current;
}

export function updateConfig(fn: (c: Config) => void): Config {
  const draft = structuredClone(current);
  fn(draft);
  return saveConfig(draft);
}

const hint = (key?: string) => (key ? `…${key.slice(-4)}` : '');

/** Configuration without plain-text keys for the frontend. */
export function publicConfig() {
  const c = current;
  return {
    activeProject: c.activeProject,
    git: c.git,
    mcpServers: c.mcpServers,
    lan: { enabled: c.lan.enabled },
    privacy: c.privacy,
    personal: c.personal,
    search: c.search,
    metrics: c.metrics,
    plugins: c.plugins,
    team: c.team,
    ai: {
      active: c.ai.active,
      providers: PRESETS.map((p) => {
        const e = c.ai.providers[p.id] || {};
        return { id: p.id, name: p.name, kind: p.kind, local: !!p.local, needsKey: p.needsKey, docs: p.docs, model: e.model || p.model, baseUrl: e.baseUrl || p.baseUrl, hasKey: !!e.apiKey, keyHint: hint(e.apiKey) };
      }),
      custom: c.ai.custom.map((x) => ({ id: x.id, name: x.name, baseUrl: x.baseUrl, model: x.model, hasKey: !!x.apiKey, keyHint: hint(x.apiKey) })),
      deepseek: c.ai.deepseek,
    },
  };
}

/** Full provider configuration (with key) for the AI router. */
export function providerConfig(id: string): ProviderConfig | null {
  const c = current;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) {
    const e = c.ai.providers[id] || {};
    return { id, name: preset.name, kind: preset.kind, baseUrl: e.baseUrl || preset.baseUrl, apiKey: e.apiKey, model: e.model || preset.model, local: preset.local };
  }
  const custom = c.ai.custom.find((x) => x.id === id);
  if (custom) return { id, name: custom.name, kind: 'openai', baseUrl: custom.baseUrl, apiKey: custom.apiKey, model: custom.model };
  return null;
}

export function allProviderIds(): string[] {
  return [...PRESETS.map((p) => p.id), ...current.ai.custom.map((c) => c.id)];
}

/** Is a provider ready (key present, or local, or an own endpoint)? */
export function isConfigured(id: string): boolean {
  const p = providerConfig(id);
  if (!p) return false;
  const preset = PRESETS.find((x) => x.id === id);
  if (preset?.local) return true;
  if (!preset) return true; // own endpoint, key optional
  return !!p.apiKey;
}

/** Does a provider stay on this computer or in the home network? */
export function isLocalProvider(id: string): boolean {
  const p = providerConfig(id);
  if (!p) return false;
  return !!p.local || isLocalUrl(p.baseUrl);
}
