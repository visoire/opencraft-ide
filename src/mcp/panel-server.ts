// MCP server in the browser: offers the panels of the workspace as tools
// (open-panel, panel-status). The orchestrator connects through InMemoryTransport.

import { McpServer } from '@modelcontextprotocol/server';
import { TOOL_DEFS } from './schemas.js';
import { workspace } from '../workspace/layout.js';
import { TOOLS, type ToolId } from '../workspace/registry.js';
import { t as tr } from '../app/i18n.js';

type Handler = (args: Record<string, unknown>) => Promise<{ text: string; data?: Record<string, unknown> }>;

const HANDLERS: Record<string, Handler> = {
  async 'open-panel'(args) {
    const app = args.app as ToolId;
    const path = typeof args.path === 'string' && args.path ? (args.path.startsWith('/') ? args.path : '/' + args.path) : undefined;
    const { id, instance } = await workspace.instanceForTool(app, path);
    await instance.ready?.catch(() => {});
    const p = workspace.panel(id);
    return { text: p?.path ? tr('{name} is open with {path}.', { name: TOOLS[app].name, path: p.path }) : tr('{name} is open.', { name: TOOLS[app].name }), data: { panel: id, path: p?.path || null } };
  },
  async 'panel-status'(args) {
    const app = args.app as ToolId;
    const list = workspace.panels().filter((p) => p.tool === app);
    if (!list.length) return { text: tr('{name} is not open.', { name: TOOLS[app].name }), data: { open: false } };
    const out = list.map((p) => ({ panel: p.id, file: p.path, mode: p.mode, state: p.paused ? 'paused' : p.status, visible: p.visible, ...(workspace.instance(p.id)?.status?.() || {}) }));
    return { text: JSON.stringify(out, null, 2), data: { open: true, panels: out } };
  },
};

export function createPanelServer(): McpServer {
  const server = new McpServer({ name: 'opencraft-panels', version: '0.2.0' }, { capabilities: { tools: {} } });
  for (const def of TOOL_DEFS.filter((d) => d.side === 'client')) {
    const run = HANDLERS[def.name];
    if (!run) continue;
    server.registerTool(def.name, { title: def.title, description: def.description, inputSchema: def.input, _meta: { app: def.app } }, async (args: Record<string, unknown>) => {
      try {
        const r = await run(args);
        return { content: [{ type: 'text' as const, text: r.text }], structuredContent: { ...(r.data || {}), changed: [] } };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
  }
  return server;
}
