// Registry of all panels. The four apps are the WebAssembly builds of the current release set
// (public/releases.json, today versions/v9-10/web/), served under apps/<app>/ (Vite plugin in
// scripts/releases.mjs, copy-apps.mjs in the build). Versions come from that file too: Vite does not
// let code import files from public/, so vite.config.js passes the data in as __OC_RELEASES__.

import { icon } from '../app/icons.js';
import type { AppId } from '../chat/types.js';
import { t } from '../app/i18n.js';
import { ROOT } from '../app/util.js';

export const WORKSPACE_ACCENT = '#335CFF';

export type ToolId = AppId | 'code' | 'terminal' | 'git' | 'settings' | 'tree' | 'chat';
export type Zone = 'stage' | 'left' | 'right';

export interface PanelInstance {
  open?(path: string): Promise<unknown>;
  /** Stop the render loop, keep the state */
  pause?(): void;
  resume?(): void;
  /** May the memory be freed? (no unsaved input) */
  canUnload?(): boolean;
  /** A file changed outside the panel (AI, terminal, disk) */
  externalChange?(path: string, kind: 'change' | 'delete' | 'create'): void;
  status?(): Record<string, unknown>;
  /** Memory of the panel: WebAssembly memory, estimated GPU memory, JS heap (memory monitor) */
  resources?(): PanelResources | null;
  getScroll?(): { top: number; left: number } | null;
  setScroll?(s: { top: number; left: number }): void;
  ready?: Promise<void>;
  beforeClose?(): Promise<boolean> | boolean;
  /** Apple Pencil: open the pencil view (PdfCraft: sign, ink, mark, redact) */
  pen?(tool?: string): Promise<unknown> | void;
  unmount(): void | Promise<void>;
}

export interface PanelResources {
  wasm: number;
  gpu: number;
  gpuApi: string;
  heap: number | null;
  gpuBuffers?: number;
  gpuTextures?: number;
}

export interface PanelContext {
  id: string;
  tool: ToolId;
  readonly path: string | null;
  setPath(path: string | null): void;
  setStatus(text: string): void;
  setDirty(dirty: boolean): void;
  setBadge(text: string | null): void;
  focus(): void;
  openFile(path: string, tool?: ToolId): Promise<string | undefined>;
  restore: { scroll?: { top: number; left: number } } | null;
  onDispose(fn: () => void): void;
  /** Origin tag for writes of this panel (live sync recognises its own changes) */
  origin: string;
}

export interface ToolInfo {
  id: ToolId;
  name: string;
  kind: 'app' | 'dev' | 'system' | 'side';
  zone: Zone;
  accent: string;
  icon: string;
  logo?: string;
  src?: string;
  canvas?: string;
  version?: string;
  folder?: string;
  blurb: string;
  exts: string[];
  single?: boolean;
  load(): Promise<{ mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> }>;
}

export interface AppRelease {
  app: string;
  name: string;
  version: string;
  tag: string;
  date: string;
  web: string;
  /** Set when the browser build is older than the release (webNote says why) */
  webVersion?: string;
  webNote?: string;
  webZipBytes: number;
}

declare const __OC_RELEASES__: AppRelease[] | undefined;

/** The app releases this build serves (public/releases.json, inlined by vite.config.js). */
export const RELEASES: AppRelease[] = typeof __OC_RELEASES__ !== 'undefined' ? __OC_RELEASES__ : [];
export const releaseOf = (id: string): AppRelease | undefined => RELEASES.find((r) => r.app === id);

const app = (id: AppId, name: string, accent: string, blurb: string, exts: string[], folder: string): ToolInfo => ({
  id,
  name,
  // The version that runs in the panel: the browser build, which can be older than the release
  version: releaseOf(id)?.webVersion ?? releaseOf(id)?.version ?? '?',
  kind: 'app',
  zone: 'stage',
  accent,
  icon: 'file',
  logo: `${ROOT}assets/logos/${id}.webp`,
  src: `${ROOT}apps/${id}/`,
  canvas: id === 'pdfcraft' ? 'pdfcraft' : `${id}_canvas`,
  folder,
  blurb,
  exts,
  load: () => import('./panels/craftapp.js'),
});

export const TOOLS: Record<ToolId, ToolInfo> = {
  wordcraft: app('wordcraft', 'WordCraft', '#3B82F6', t('Documents in .docx, .odt and .md'), ['docx', 'doc', 'odt', 'rtf', 'md', 'markdown', 'txt', 'html', 'htm', 'tex'], '/documents'),
  gridcraft: app('gridcraft', 'GridCraft', '#10B981', t('Spreadsheets in .xlsx, .csv with dynamic arrays'), ['xlsx', 'xls', 'xlsb', 'ods', 'csv', 'tsv'], '/sheets'),
  deckcraft: app('deckcraft', 'DeckCraft', '#F97316', t('Presentations in .pptx with vector morphing'), ['pptx', 'deckcraft'], '/presentations'),
  pdfcraft: app('pdfcraft', 'PdfCraft', '#14B8A6', t('PDF with deep zoom, local signing and redaction'), ['pdf'], '/pdf'),
  code: { id: 'code', name: 'Code', kind: 'dev', zone: 'stage', accent: WORKSPACE_ACCENT, icon: 'code', blurb: t('Code editor'), exts: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html', 'xml', 'svg', 'yml', 'yaml', 'toml', 'py', 'sh', 'sql', 'rs', 'go', 'gitignore', 'ini', 'log'], load: () => import('./panels/code.js') },
  terminal: { id: 'terminal', name: 'Terminal', kind: 'dev', zone: 'stage', accent: WORKSPACE_ACCENT, icon: 'terminal', blurb: t('Real terminal in the project folder'), exts: [], load: () => import('./panels/terminal.js') },
  git: { id: 'git', name: t('Versions'), kind: 'dev', zone: 'stage', accent: WORKSPACE_ACCENT, icon: 'git', blurb: t('Local Git'), exts: [], single: true, load: () => import('./panels/git.js') },
  settings: { id: 'settings', name: t('Settings'), kind: 'system', zone: 'stage', accent: WORKSPACE_ACCENT, icon: 'settings', blurb: t('Models, keys and MCP'), exts: [], single: true, load: () => import('./panels/settings.js') },
  tree: { id: 'tree', name: t('Project'), kind: 'side', zone: 'left', accent: WORKSPACE_ACCENT, icon: 'folder', blurb: t('Project tree'), exts: [], single: true, load: () => import('../project/tree.js') },
  chat: { id: 'chat', name: t('AI assistant'), kind: 'side', zone: 'right', accent: WORKSPACE_ACCENT, icon: 'spark', blurb: t('AI chat with @ and /'), exts: [], single: true, load: () => import('../chat/sidebar.js') },
};

export const APP_IDS: AppId[] = ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'];
export const isApp = (id: string): id is AppId => (APP_IDS as string[]).includes(id);

export function toolForPath(path: string): ToolId {
  const ext = (path.split('.').pop() || '').toLowerCase();
  for (const t of Object.values(TOOLS)) if (t.kind !== 'side' && t.exts.includes(ext)) return t.id;
  return 'code';
}

/** WebP logo for the four apps, otherwise an inline SVG from src/app/icons.js. */
export function toolMark(id: string, size = 18): string {
  const t = TOOLS[id as ToolId];
  if (t?.logo) return `<img class="tool-logo" src="${t.logo}" width="${size}" height="${size}" alt="" decoding="async">`;
  return icon(t?.icon || 'file', { size });
}
