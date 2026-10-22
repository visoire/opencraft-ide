// MCP in the backend:
// - McpServer (@modelcontextprotocol/server) with all project tools, reachable at /mcp
//   (Streamable HTTP). The orchestrator in the frontend and external MCP clients use it.
// - MCP clients (@modelcontextprotocol/client) to own stdio servers from the configuration
//   (for example wordcraft-cli mcp). Their tools are passed on with the prefix ext-<name>-.

import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DEFS, TOOL_BY_NAME } from '../mcp/schemas.js';
import { HANDLERS, ToolError } from './tools.js';
import { activeProject } from './projects.js';
import { broadcast } from './events.js';
import { config, isLocalUrl, type McpServerEntry } from './config.js';
import { HOME } from './paths.js';
import { pluginServers } from './plugins.js';
import { graph } from './graph.js';
import { createSnapshot, snapshotForChain } from './snapshots.js';
import { log, metric } from './logs.js';
import { auditRecord } from './audit.js';
import { VERSION } from '../core/version.js';

// ---------------------------------------------------------------- Approvals (run-command, sign-pdf)

const approvals = new Map<string, { tool: string; hash: string; until: number }>();
const argsHash = (args: unknown) => createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex');

/** One-time token after confirmation in the frontend. Valid for 2 minutes for exactly this call. */
export function issueApproval(tool: string, args: unknown): string {
  if (!TOOL_BY_NAME.get(tool)?.approval && !externalNeedsApproval(tool)) throw Object.assign(new Error('This tool needs no approval'), { code: 'VALIDATION' });
  const token = randomBytes(16).toString('hex');
  // the same normalization as for the call (defaults from the Zod schema)
  const parsed = TOOL_BY_NAME.get(tool)?.input.parse(args ?? {}) ?? args;
  approvals.set(token, { tool, hash: argsHash(parsed), until: Date.now() + 120_000 });
  return token;
}

function consumeApproval(token: unknown, tool: string, args: unknown): boolean {
  if (typeof token !== 'string') return false;
  const a = approvals.get(token);
  approvals.delete(token);
  return !!a && a.tool === tool && a.until > Date.now() && a.hash === argsHash(args);
}

// ---------------------------------------------------------------- External servers and plugins (sandbox)

type ServerEntry = McpServerEntry & { env?: Record<string, string>; cwd?: string; accent?: string };
interface ExtTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}
interface External {
  entry: ServerEntry;
  client: Client | null;
  tools: ExtTool[];
  status: 'connected' | 'error' | 'off';
  error?: string;
  /** what the sandbox actually applies */
  sandbox: string;
}
const externals = new Map<string, External>();
const CALL_TIMEOUT = 120_000;
const MAX_RESULT = 200_000;

/** All wanted servers: added by hand plus plugins. */
function wantedServers(): ServerEntry[] {
  const c = config();
  return [...c.mcpServers, ...pluginServers(c.plugins.disabled)].filter((s) => s.enabled);
}

const sig = (e: ServerEntry) => JSON.stringify([e.transport, e.command, e.args, e.url, e.sandbox, e.env, e.cwd]);

/** Node permission model flag of this Node version (--permission from 23.5, before --experimental-permission). */
const permFlag = () => (process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission');

/**
 * Process parameters with the sandbox applied:
 * - standard: only the safe default environment (PATH, HOME, TEMP …) plus the env of the plugin,
 *   no API keys or tokens of the backend; working folder is the plugin folder or ~/OpenCraft/sandbox/<id>
 * - strict: as standard, and for node commands the Node permission model: read the plugin folder
 *   and the project, write only the project, no child processes, no workers
 * - off: the full environment of the backend (only for servers you trust)
 */
export function sandboxParams(e: ServerEntry, projectRoot: string): { command: string; args: string[]; env: Record<string, string>; cwd: string; applied: string } {
  const cwd = e.cwd || join(HOME, 'sandbox', e.id.replace(/[^\w-]+/g, '_'));
  mkdirSync(cwd, { recursive: true });
  if (e.sandbox === 'off') return { command: e.command, args: e.args, env: { ...(process.env as Record<string, string>), ...(e.env || {}) }, cwd, applied: 'off (full environment)' };
  const env = { ...getDefaultEnvironment(), ...(e.env || {}) };
  for (const k of Object.keys(env)) if (/(_KEY|TOKEN|SECRET|PASSWORD)$/i.test(k) && !(e.env && k in e.env)) delete env[k];
  const isNode = /(^|[\\/])node(\.exe)?$/i.test(e.command);
  if (e.sandbox === 'strict' && isNode) {
    const args = [permFlag(), `--allow-fs-read=${cwd}`, `--allow-fs-read=${projectRoot}`, `--allow-fs-write=${projectRoot}`, ...e.args];
    return { command: e.command, args, env, cwd, applied: 'strict (Node permission model, clean environment)' };
  }
  return { command: e.command, args: e.args, env, cwd, applied: e.sandbox === 'strict' ? 'strict (clean environment, the permission model applies to node commands only)' : 'standard (clean environment)' };
}

export async function syncExternalServers(): Promise<void> {
  const wanted = wantedServers();
  for (const [id, ext] of externals) {
    if (!wanted.find((w) => w.id === id && sig(w) === sig(ext.entry))) {
      await ext.client?.close().catch(() => {});
      externals.delete(id);
    }
  }
  const { root } = await activeProject();
  await Promise.all(
    wanted
      .filter((w) => !externals.has(w.id))
      .map(async (entry) => {
        const ext: External = { entry, client: null, tools: [], status: 'off', sandbox: '' };
        externals.set(entry.id, ext);
        try {
          const client = new Client({ name: 'opencraft', version: VERSION });
          if (entry.transport === 'http') {
            if (!entry.url) throw new Error('The server has no URL');
            if (config().privacy.localOnly && !isLocalUrl(entry.url)) throw new Error('Local-only mode is on: remote MCP servers are blocked');
            ext.sandbox = isLocalUrl(entry.url) ? 'http (this computer or home network)' : 'http (remote, every call lands in the audit log)';
            await client.connect(new StreamableHTTPClientTransport(new URL(entry.url)));
          } else {
            const p = sandboxParams(entry, root);
            ext.sandbox = p.applied;
            await client.connect(new StdioClientTransport({ command: p.command, args: p.args, env: p.env, cwd: p.cwd, stderr: 'ignore' }));
          }
          const list = await client.listTools();
          ext.tools = list.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, readOnly: !!t.annotations?.readOnlyHint }));
          ext.client = client;
          ext.status = 'connected';
          log('info', 'mcp', `${entry.name}: ${ext.tools.length} tools, sandbox ${ext.sandbox}`);
        } catch (e) {
          ext.status = 'error';
          ext.error = (e as Error).message;
          log('warn', 'mcp', `${entry.name}: ${ext.error}`);
        }
      })
  );
}

export function externalStatus() {
  return [...externals.values()].map((e) => ({ id: e.entry.id, name: e.entry.name, status: e.status, error: e.error, tools: e.tools.map((t) => t.name), sandbox: e.sandbox, approval: e.entry.approval, transport: e.entry.transport, plugin: e.entry.plugin }));
}

const extName = (server: string, tool: string) => `ext-${server.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${tool}`.slice(0, 64);

function externalTool(name: string): { ext: External; tool: ExtTool } | null {
  for (const ext of externals.values()) for (const t of ext.tools) if (extName(ext.entry.name, t.name) === name) return { ext, tool: t };
  return null;
}

/** Does a call of this external tool need a confirmation (approval rule of its server)? */
export function externalNeedsApproval(name: string): boolean {
  const x = externalTool(name);
  if (!x) return false;
  const rule = x.ext.entry.approval || 'ask';
  return rule === 'ask' || (rule === 'read' && !x.tool.readOnly);
}

// ---------------------------------------------------------------- Server

function buildServer(): McpServer {
  const server = new McpServer({ name: 'opencraft-project', version: VERSION }, { capabilities: { tools: { listChanged: true } } });
  for (const def of TOOL_DEFS.filter((d) => d.side === 'server')) {
    const handler = HANDLERS[def.name];
    if (!handler) continue;
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.input, annotations: { readOnlyHint: !def.writes && !def.approval, destructiveHint: !!def.approval }, _meta: { app: def.app, approval: !!def.approval } },
      async (args: Record<string, unknown>, ctx) => {
        const meta = (ctx.mcpReq._meta || {}) as Record<string, unknown>;
        const token = meta.progressToken as string | number | undefined;
        const callId = typeof meta['opencraft/callId'] === 'string' ? (meta['opencraft/callId'] as string) : undefined;
        const path = def.pathArg ? String(args[def.pathArg] ?? '') : undefined;
        if (def.approval && !consumeApproval(meta['opencraft/approval'], def.name, args)) {
          return { isError: true, content: [{ type: 'text' as const, text: `${def.title} needs a confirmation in OpenCraft.` }] };
        }
        let step = 0;
        const progress = async (message: string, s?: number, total?: number) => {
          step = s ?? step + 1;
          broadcast({ t: 'tool', phase: 'progress', name: def.name, path, message, callId });
          if (token !== undefined) {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: step, ...(total ? { total } : {}), message } }).catch(() => {});
          }
        };
        const chain = typeof meta['opencraft/chain'] === 'string' ? (meta['opencraft/chain'] as string).slice(0, 80) : undefined;
        const id = callId || randomBytes(6).toString('hex');
        broadcast({ t: 'tool', phase: 'start', name: def.name, path, callId });
        const t0 = Date.now();
        let root = '';
        try {
          root = (await activeProject()).root;
          // Undo across all tools: before the first write of an AI answer, keep the project state
          if (def.writes && chain && !snapshotForChain(root, chain)) await createSnapshot(root, `Before AI: ${def.title}`, { auto: true, chain });
          graph.beginStep(id, def.name, chain);
          const out = await handler(args, { root, origin: `tool:${id}`, progress });
          broadcast({ t: 'tool', phase: 'end', name: def.name, path, ok: true, callId });
          const reads = !def.writes && path ? [path.startsWith('/') ? path : '/' + path] : [];
          graph.endStep(root, id, { ok: true, ms: Date.now() - t0, inputs: reads, outputs: out.changed || [] });
          metric(`mcp:${def.name}`, Date.now() - t0);
          log('info', 'mcp', `${def.name}${path ? ' ' + path : ''}: ok`, Date.now() - t0);
          return {
            content: [{ type: 'text' as const, text: out.text }],
            structuredContent: { ...(out.data || {}), changed: out.changed || [] },
          };
        } catch (e) {
          const err = e as Error & { code?: string };
          broadcast({ t: 'tool', phase: 'end', name: def.name, path, ok: false, message: err.message, callId });
          if (root) graph.endStep(root, id, { ok: false, ms: Date.now() - t0, inputs: [], outputs: [] });
          log('warn', 'mcp', `${def.name}: ${err.message}`, Date.now() - t0);
          return { isError: true, content: [{ type: 'text' as const, text: err instanceof ToolError || err.code ? err.message : `Error: ${err.message}` }] };
        }
      }
    );
  }
  for (const ext of externals.values()) {
    if (ext.status !== 'connected' || !ext.client) continue;
    for (const t of ext.tools) {
      const client = ext.client;
      const name = extName(ext.entry.name, t.name);
      server.registerTool(
        name,
        { title: `${ext.entry.name}: ${t.name}`, description: `[${ext.entry.name}] ${t.description || t.name}`, inputSchema: fromJsonSchema(t.inputSchema as never), annotations: { readOnlyHint: t.readOnly }, _meta: { app: 'project', external: ext.entry.name, approval: externalNeedsApproval(name), accent: ext.entry.accent, sandbox: ext.sandbox } },
        async (args: unknown, ctx) => {
          const meta = (ctx.mcpReq._meta || {}) as Record<string, unknown>;
          if (externalNeedsApproval(name) && !consumeApproval(meta['opencraft/approval'], name, args)) {
            return { isError: true, content: [{ type: 'text' as const, text: `${ext.entry.name}: ${t.name} needs a confirmation in OpenCraft (approval rule of the server).` }] } as never;
          }
          const t0 = Date.now();
          try {
            const r = (await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, { timeout: CALL_TIMEOUT })) as { content?: { type: string; text?: string }[] };
            // Size limit for results of external tools
            for (const c of r.content || []) if (c.type === 'text' && c.text && c.text.length > MAX_RESULT) c.text = c.text.slice(0, MAX_RESULT) + '\n[shortened by the OpenCraft sandbox]';
            metric(`mcp:${ext.entry.plugin || 'external'}`, Date.now() - t0);
            log('info', 'mcp', `${name}: ok`, Date.now() - t0);
            if (ext.entry.transport === 'http' && ext.entry.url && !isLocalUrl(ext.entry.url)) auditRecord({ kind: 'mcp', url: ext.entry.url, bytes: JSON.stringify(args ?? {}).length, files: [], status: 'ok', note: `${ext.entry.name}: ${t.name}` });
            return r as never;
          } catch (e) {
            log('warn', 'mcp', `${name}: ${(e as Error).message}`, Date.now() - t0);
            return { isError: true, content: [{ type: 'text' as const, text: `${ext.entry.name}: ${(e as Error).message}` }] } as never;
          }
        }
      );
    }
  }
  return server;
}

export const mcpHandler = createMcpHandler(() => buildServer(), { onerror: (e) => console.warn('MCP:', e.message) });
