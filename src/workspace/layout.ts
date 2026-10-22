// Window system of the workspace.
//
// Zones: left (project tree), middle (stage with a split tree), right (AI chat).
// Every panel has the same header: collapse, minimize (dock), maximize (whole workspace),
// hide, close, unload. Gutters change width and height.
//
// Resources: a panel loads its module only when it becomes visible for the first time or an
// MCP command asks for it. Apps (WebAssembly/WebGPU) start one after another through a queue.
// Minimized, collapsed, hidden or covered panels are paused (render loop stops, the document
// stays in memory). Unloading happens only on request or after a configurable time.
//
// Layout, sizes, modes and scroll positions are stored per project (backend + localStorage).

import { TOOLS, toolMark, toolForPath, isApp, type ToolId, type PanelInstance, type PanelContext } from './registry.js';
import { bus, type BusEvents } from '../app/bus.js';
import { api } from '../app/backend.js';
import { prefs } from '../app/settings.js';
import { h, uid, basename, clamp, debounce, nodes, esc } from '../app/util.js';
import { icon } from '../app/icons.js';
import { dialog } from '../app/ui.js';
import { notifyError } from '../app/notifications.js';
import { play } from '../app/sounds.js';
import { device } from '../app/device.js';
import { guardSurface, onDoubleTap, inputKind, capture } from './pencil.js';
import { attachPip, clampRect, defaultRect, type PipRect } from './pip.js';
import { t as tr } from '../app/i18n.js';

export type Mode = 'normal' | 'collapsed' | 'minimized' | 'hidden';
type Side = 'left' | 'right' | 'top' | 'bottom';
type LayoutNode = { t: 'leaf'; id: string } | { t: 'split'; dir: 'row' | 'col'; sizes: number[]; kids: LayoutNode[] };

interface PanelState {
  id: string;
  tool: ToolId;
  path: string | null;
  mode: Mode;
  scroll?: { top: number; left: number };
  prev?: { target: string | null; side: Side };
  /** Floating picture-in-picture window (viewport coordinates). Set: the panel floats. */
  pip?: PipRect;
}

interface LayoutState {
  v: 2;
  panels: Record<string, PanelState>;
  order: string[];
  tree: LayoutNode | null;
  focused: string | null;
  maximized: string | null;
  sides: { left: number; right: number };
}

type Status = 'idle' | 'queued' | 'loading' | 'active' | 'unloaded' | 'error';

interface Runtime {
  el: HTMLElement;
  host: HTMLElement;
  placeholder: HTMLElement;
  pathEl: HTMLElement;
  stateEl: HTMLElement;
  badgeEl: HTMLElement;
  statusText: HTMLElement;
  engineText: HTMLElement;
  btn: Record<'collapse' | 'min' | 'max' | 'hide' | 'close' | 'unload' | 'pip', HTMLButtonElement>;
  status: Status;
  instance: PanelInstance | null;
  paused: boolean;
  disposers: (() => void)[];
  error?: Error;
  loadStarted?: number;
  loadMs?: number;
  unloadTimer?: ReturnType<typeof setTimeout>;
  waiters: { resolve: (i: PanelInstance) => void; reject: (e: Error) => void }[];
}

const MIN = 0.1;
/** Header height and width of collapsed panels follow the CSS variables (touch: 48 and 48 px). */
const cssPx = (name: string, fallback: number) => {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return isFinite(v) && v > 0 ? v : fallback;
};
let HEAD = 38;
let COLLAPSED_W = 44;
function readMetrics() {
  HEAD = cssPx('--panel-head-h', 38);
  COLLAPSED_W = cssPx('--collapsed-w', 44);
}
/** Snap points of the gutters: 50 to 50, 70 to 30, 30 to 70, then full screen */
const SNAPS = [0.5, 0.7, 0.3] as const;
const SIDE_IDS = { left: 'tree', right: 'chat' } as const;

let state: LayoutState = emptyState();
const rt = new Map<string, Runtime>();
let project = '';
let dom: { ws: HTMLElement; stage: HTMLElement; layout: HTMLElement; layer: HTMLElement; left: HTMLElement; right: HTMLElement; gl: HTMLElement; gr: HTMLElement; tabs: HTMLElement; dock: HTMLElement } | null = null;

function emptyState(): LayoutState {
  return { v: 2, panels: {}, order: [], tree: null, focused: null, maximized: null, sides: { left: 260, right: 400 } };
}

// ---------------------------------------------------------------- Persistenz

function snapshotForSave(): LayoutState {
  for (const [id, r] of rt) {
    const s = r.instance?.getScroll?.();
    if (s && state.panels[id]) state.panels[id]!.scroll = s;
  }
  return structuredClone(state);
}

async function putLayout(): Promise<void> {
  if (!project) return;
  const snap = snapshotForSave();
  try {
    localStorage.setItem(`opencraft.layout.${project}`, JSON.stringify(snap));
  } catch {
    /* storage full */
  }
  await api.send('PUT', '/api/meta/layout', snap).catch(() => {});
}
const persist = debounce(() => void putLayout(), 600);

function validState(s: unknown): s is LayoutState {
  const x = s as LayoutState;
  return !!x && x.v === 2 && typeof x.panels === 'object' && Array.isArray(x.order);
}

function prune(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  if (node.t === 'leaf') {
    const p = state.panels[node.id];
    return p && TOOLS[p.tool]?.zone === 'stage' && (p.mode === 'normal' || p.mode === 'collapsed') ? node : null;
  }
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  node.kids.forEach((k, i) => {
    const n = prune(k);
    if (n) {
      kids.push(n);
      sizes.push(node.sizes[i] || 1);
    }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0]!;
  const sum = sizes.reduce((a, b) => a + b, 0);
  return { t: 'split', dir: node.dir, kids, sizes: sizes.map((s) => s / sum) };
}

// ---------------------------------------------------------------- Baum-Operationen

interface Located {
  node: LayoutNode;
  parent: Extract<LayoutNode, { t: 'split' }> | null;
  idx: number;
}
function locate(pred: (n: LayoutNode) => boolean, node: LayoutNode | null = state.tree, parent: Located['parent'] = null, idx = -1): Located | null {
  if (!node) return null;
  if (pred(node)) return { node, parent, idx };
  if (node.t === 'split') {
    for (let i = 0; i < node.kids.length; i++) {
      const r = locate(pred, node.kids[i]!, node, i);
      if (r) return r;
    }
  }
  return null;
}
const locateLeaf = (id: string) => locate((n) => n.t === 'leaf' && n.id === id);

function replaceNode(oldNode: LayoutNode, newNode: LayoutNode) {
  const r = locate((n) => n === oldNode);
  if (!r) return;
  if (!r.parent) {
    state.tree = newNode;
    return;
  }
  if (newNode.t === 'split' && newNode.dir === r.parent.dir) {
    const share = r.parent.sizes[r.idx]!;
    r.parent.kids.splice(r.idx, 1, ...newNode.kids);
    r.parent.sizes.splice(r.idx, 1, ...newNode.sizes.map((s) => s * share));
  } else r.parent.kids[r.idx] = newNode;
}

/** Removes a leaf and remembers neighbour and side for restoring it. */
function removeLeaf(id: string): PanelState['prev'] {
  const r = locateLeaf(id);
  if (!r) return undefined;
  if (!r.parent) {
    state.tree = null;
    return { target: null, side: 'right' };
  }
  const p = r.parent;
  const before = r.idx > 0;
  const sib = p.kids[before ? r.idx - 1 : r.idx + 1]!;
  const firstLeaf = (n: LayoutNode): string | null => (n.t === 'leaf' ? n.id : n.kids[0] ? firstLeaf(n.kids[0]) : null);
  const prev: PanelState['prev'] = { target: firstLeaf(sib), side: p.dir === 'row' ? (before ? 'right' : 'left') : before ? 'bottom' : 'top' };
  p.kids.splice(r.idx, 1);
  p.sizes.splice(r.idx, 1);
  const sum = p.sizes.reduce((a, b) => a + b, 0);
  p.sizes = p.sizes.map((s) => s / sum);
  if (p.kids.length === 1) replaceNode(p, p.kids[0]!);
  return prev;
}

function insertLeaf(id: string, targetId: string | null, side: Side = 'right') {
  const leaf: LayoutNode = { t: 'leaf', id };
  if (!state.tree) {
    state.tree = leaf;
    return;
  }
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const r = (targetId && locateLeaf(targetId)) || { node: state.tree, parent: null, idx: -1 };
  if (r.node === state.tree && state.tree.t === 'split' && state.tree.dir === dir) {
    const n = state.tree.kids.length + 1;
    state.tree.sizes = state.tree.sizes.map((s) => (s * (n - 1)) / n);
    if (before) {
      state.tree.kids.unshift(leaf);
      state.tree.sizes.unshift(1 / n);
    } else {
      state.tree.kids.push(leaf);
      state.tree.sizes.push(1 / n);
    }
    return;
  }
  if (r.parent && r.parent.dir === dir) {
    const half = r.parent.sizes[r.idx]! / 2;
    r.parent.sizes[r.idx] = half;
    const at = r.idx + (before ? 0 : 1);
    r.parent.kids.splice(at, 0, leaf);
    r.parent.sizes.splice(at, 0, half);
    return;
  }
  const split: LayoutNode = { t: 'split', dir, sizes: [0.5, 0.5], kids: before ? [leaf, r.node] : [r.node, leaf] };
  if (!r.parent) state.tree = split;
  else r.parent.kids[r.idx] = split;
}

function leafIds(node: LayoutNode | null = state.tree, out: string[] = []): string[] {
  if (!node) return out;
  if (node.t === 'leaf') out.push(node.id);
  else node.kids.forEach((k) => leafIds(k, out));
  return out;
}

function autoSide(target: string | null): Side {
  const r = target && locateLeaf(target);
  if (r && r.parent?.dir === 'row' && r.parent.kids.length >= 3) return 'bottom';
  return 'right';
}

// ---------------------------------------------------------------- Visibility and resources

const zoneOf = (id: string) => TOOLS[state.panels[id]?.tool as ToolId]?.zone || 'stage';

export function isVisible(id: string): boolean {
  const p = state.panels[id];
  if (!p || p.mode !== 'normal' || document.visibilityState === 'hidden') return false;
  // A floating window stays visible above everything (also above a maximized panel)
  if (p.pip) return !p.pip.collapsed;
  if (zoneOf(id) === 'stage' && !locateLeaf(id)) return false;
  if (state.maximized && state.maximized !== id) return false;
  return true;
}

const queue: string[] = [];
let pumping = false;

function requestMount(id: string, priority = false) {
  const r = rt.get(id);
  if (!r || r.status === 'loading' || r.status === 'active') return;
  if (!isApp(state.panels[id]!.tool)) return void mount(id);
  const at = queue.indexOf(id);
  if (at >= 0) queue.splice(at, 1);
  if (priority) queue.unshift(id);
  else queue.push(id);
  r.status = 'queued';
  renderPanelState(id);
  void pump();
}

/** Loads apps one after another, so WebAssembly start and GPU setup do not slow each other down. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      const r = rt.get(id);
      if (!r || r.status !== 'queued') continue;
      if (!isVisible(id) && !r.waiters.length) {
        r.status = 'idle';
        renderPanelState(id);
        continue;
      }
      await mount(id);
      const inst = rt.get(id)?.instance;
      // Wait for the app to be ready, but not for an app nobody sees while a visible one waits
      // (for example WordCraft behind Full Chat Mode and GridCraft in a floating window)
      if (inst?.ready) {
        let iv: ReturnType<typeof setInterval> | undefined;
        await Promise.race([
          inst.ready.catch(() => {}),
          new Promise<void>((res) => {
            const t0 = Date.now();
            iv = setInterval(() => {
              if (Date.now() - t0 > 25000 || (!isVisible(id) && queue.some((q) => isVisible(q)))) res();
            }, 300);
          }),
        ]);
        clearInterval(iv);
      }
    }
  } finally {
    pumping = false;
  }
}

function syncResources() {
  for (const [id, r] of rt) {
    const v = isVisible(id);
    if (v) {
      clearTimeout(r.unloadTimer);
      r.unloadTimer = undefined;
      if (r.status === 'idle') requestMount(id, id === state.focused);
      if (r.status === 'active' && r.paused) {
        r.paused = false;
        r.instance?.resume?.();
        renderPanelState(id);
      }
    } else if (r.status === 'active' && !r.paused) {
      r.paused = true;
      r.instance?.pause?.();
      const mins = prefs.get('autoUnloadMinutes');
      if (mins > 0 && isApp(state.panels[id]!.tool)) {
        r.unloadTimer = setTimeout(() => {
          if (!isVisible(id) && (r.instance?.canUnload?.() ?? true)) void unloadInstance(id);
        }, mins * 60_000);
      }
      renderPanelState(id);
    }
  }
  bus.emit('workspace:resources');
}

function makeCtx(id: string, r: Runtime): PanelContext {
  return {
    id,
    tool: state.panels[id]!.tool,
    get path() {
      return state.panels[id]?.path ?? null;
    },
    setPath(path) {
      const p = state.panels[id];
      if (!p) return;
      p.path = path;
      updateHead(id);
      renderTabs();
      persist();
      bus.emit('workspace:change');
    },
    setStatus(text) {
      r.statusText.textContent = text;
    },
    setDirty(d) {
      r.el.classList.toggle('is-dirty', d);
    },
    setBadge(text) {
      r.badgeEl.textContent = text || '';
      r.badgeEl.hidden = !text;
    },
    focus: () => workspace.focus(id, false),
    openFile: (path, tool) => workspace.openFile(path, tool),
    restore: state.panels[id]?.scroll ? { scroll: state.panels[id]!.scroll } : null,
    onDispose(fn) {
      r.disposers.push(fn);
    },
    origin: `panel:${id}`,
  };
}

async function mount(id: string) {
  const p = state.panels[id];
  const r = rt.get(id);
  if (!p || !r || r.status === 'loading' || r.status === 'active') return;
  r.status = 'loading';
  r.loadStarted = performance.now();
  renderPanelState(id);
  try {
    const mod = await TOOLS[p.tool].load();
    if (!rt.has(id)) return;
    r.host.replaceChildren();
    r.instance = await mod.mount(r.host, makeCtx(id, r));
    r.status = 'active';
    r.paused = false;
    renderPanelState(id);
    for (const w of r.waiters.splice(0)) w.resolve(r.instance);
    void r.instance.ready?.then(() => {
      r.loadMs = Math.round(performance.now() - (r.loadStarted || 0));
      renderPanelState(id);
    });
    if (state.panels[id]?.scroll) r.instance.setScroll?.(state.panels[id]!.scroll!);
    syncResources();
  } catch (e) {
    console.error(e);
    r.status = 'error';
    r.error = e as Error;
    renderPanelState(id);
    for (const w of r.waiters.splice(0)) w.reject(e as Error);
  }
}

async function unloadInstance(id: string) {
  const r = rt.get(id);
  if (!r || r.status !== 'active') return;
  for (const fn of r.disposers.splice(0)) {
    try {
      fn();
    } catch (e) {
      console.warn(e);
    }
  }
  try {
    await r.instance?.unmount();
  } catch (e) {
    console.warn(e);
  }
  r.instance = null;
  r.host.replaceChildren();
  r.status = 'unloaded';
  r.paused = false;
  renderPanelState(id);
  bus.emit('workspace:resources');
}

export function stats() {
  const all = [...rt.values()];
  return {
    total: all.length,
    active: all.filter((r) => r.status === 'active' && !r.paused).length,
    paused: all.filter((r) => r.status === 'active' && r.paused).length,
    unloaded: all.filter((r) => r.status === 'unloaded' || r.status === 'idle').length,
    apps: [...rt.entries()].filter(([id, r]) => isApp(state.panels[id]?.tool || '') && r.status === 'active').length,
  };
}

// ---------------------------------------------------------------- Panel-DOM

const STATE_LABEL: Record<Status, string> = { idle: tr('not loaded'), queued: tr('waiting'), loading: tr('loading'), active: tr('active'), unloaded: tr('unloaded'), error: tr('error') };

function headButton(ic: string, label: string, run: () => void): HTMLButtonElement {
  const b = h<'button'>('button.icon-btn', { type: 'button', title: label, 'aria-label': label, html: icon(ic, { size: 16 }) });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

// ---------------------------------------------------------------- Team Mode: agent badge on panels

let agentSeq = 0;
const agentTimers = new Map<string, ReturnType<typeof setTimeout>>();
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/**
 * Status badge in the sub-agent's accent on every panel that shows the file: "writing" while the
 * write runs, "updated" when it is done (the app reloads the file through live sync). Panels the
 * write opens a moment later get the badge too.
 */
function flashAgent(e: BusEvents['agent:file'] & { seq: number }, round = 0) {
  for (const [id, r] of rt) {
    const p = state.panels[id];
    if (!p?.path || !samePath(p.path, e.path) || r.el.dataset.agentSeq === String(e.seq)) continue;
    let tag = r.el.querySelector<HTMLElement>('.panel-agent');
    if (!tag) {
      tag = h('span.panel-agent.mono', { role: 'status' });
      r.badgeEl.after(tag);
    }
    tag.hidden = false;
    tag.style.setProperty('--agent', e.accent);
    tag.dataset.state = e.state;
    tag.dataset.role = e.role;
    tag.innerHTML = `<i aria-hidden="true"></i><span>${esc(e.label)} · ${e.state === 'writing' ? tr('writing') : e.state === 'written' ? tr('updated') : tr('error')}</span>`;
    tag.title = tr('Team Mode: {label} {state} {path}', { label: e.label, state: e.state, path: e.path });
    tag.classList.remove('is-flash');
    void tag.offsetWidth;
    tag.classList.add('is-flash');
    r.el.dataset.agentSeq = String(e.seq);
    r.el.dataset.agent = e.role;
    r.el.style.setProperty('--agent', e.accent);
    if (e.state === 'written') r.el.dataset.agentWrites = String(Number(r.el.dataset.agentWrites || 0) + 1);
    clearTimeout(agentTimers.get(id));
    if (e.state !== 'writing')
      agentTimers.set(
        id,
        setTimeout(() => {
          tag!.hidden = true;
          delete r.el.dataset.agent;
        }, 4500)
      );
  }
  if (e.state !== 'writing' && round < 3) setTimeout(() => flashAgent(e, round + 1), 700 * (round + 1));
}

function createPanelDom(id: string) {
  const p = state.panels[id]!;
  const t = TOOLS[p.tool];
  const side = t.zone !== 'stage';
  const el = h('section.panel.frame.sm', { 'data-tool': t.id, 'data-id': id, 'data-zone': t.zone, style: `--tool:${t.accent}`, 'aria-label': t.name, tabindex: '-1' });
  const pathEl = h('span.panel-path.mono');
  const stateEl = h('span.panel-state.mono');
  const badgeEl = h('span.panel-badge.mono', { hidden: true });
  const btn = {
    unload: headButton('power', tr('Unload and free memory'), () => void workspace.unload(id)),
    collapse: headButton('collapseUp', tr('Collapse'), () => workspace.toggleCollapse(id)),
    min: headButton('minimize', tr('Minimize to the dock'), () => workspace.minimize(id)),
    pip: headButton('pip', tr('Picture in picture'), () => workspace.togglePip(id)),
    max: headButton('expand', tr('Maximize'), () => workspace.toggleMaximize(id)),
    hide: headButton('eyeOff', tr('Hide'), () => workspace.hide(id)),
    close: headButton('close', tr('Close'), () => void workspace.close(id)),
  };
  if (side) btn.close.hidden = true;
  for (const [k, b] of Object.entries(btn)) b.dataset.btn = k;
  const head = h(
    'header.panel-head',
    side ? null : h('span.panel-grip', { html: icon('grip', { size: 14 }), 'aria-hidden': 'true' }),
    h('span.panel-mark', { html: toolMark(t.id, 18) }),
    h('span.panel-name', t.name),
    t.version ? h('span.panel-ver.mono', { title: tr('{name} version {v}', { name: t.name, v: t.version }) }, `v${t.version}`) : null,
    pathEl,
    h('span.panel-dirty', { title: tr('Unsaved changes'), 'aria-hidden': 'true' }),
    badgeEl,
    h('span.spacer'),
    stateEl,
    btn.unload,
    btn.collapse,
    btn.min,
    btn.pip,
    btn.max,
    btn.hide,
    btn.close
  );
  head.addEventListener('dblclick', (e) => {
    if (!(e.target as Element).closest('button')) workspace.toggleMaximize(id);
  });
  const host = h('div.panel-host');
  const placeholder = h('div.panel-placeholder');
  const statusText = h('span.panel-status-text');
  const engineText = h('span.panel-engine');
  el.append(head, h('div.panel-body.well.flush', host, placeholder), h('footer.panel-status.mono', h('span.tool-chip', t.version ? `${t.name} ${t.version}` : t.name), statusText, h('span.spacer'), engineText));
  el.addEventListener('pointerdown', () => workspace.focus(id, false), true);
  el.addEventListener('focusin', () => workspace.focus(id, false));
  if (!side) enableDrag(head, id);
  // Floating window: the header moves it, the edges resize it
  attachPip(el, head, {
    active: () => !!state.panels[id]?.pip,
    get: () => state.panels[id]?.pip,
    set: (r) => {
      const p = state.panels[id];
      if (!p?.pip) return;
      p.pip = { ...r, collapsed: p.pip.collapsed };
      placePip(id);
    },
    end: () => {
      persist();
      bus.emit('workspace:resize');
    },
  });
  // Header: move grip without scrolling, text selection and Scribble
  guardSurface(head);
  const r: Runtime = { el, host, placeholder, pathEl, stateEl, badgeEl, statusText, engineText, btn, status: 'idle', instance: null, paused: false, disposers: [], waiters: [] };
  rt.set(id, r);
  if (side) (t.zone === 'left' ? dom!.left : dom!.right).append(el);
  else dom!.layer.append(el);
  updateHead(id);
  renderPanelState(id);
}

function updateHead(id: string) {
  const r = rt.get(id);
  const p = state.panels[id];
  if (!r || !p) return;
  r.pathEl.textContent = p.path || '';
  r.pathEl.title = p.path || '';
  r.el.classList.toggle('is-focused', state.focused === id);
  r.el.classList.toggle('is-max', state.maximized === id);
  r.el.classList.toggle('is-collapsed', p.mode === 'collapsed' || !!p.pip?.collapsed);
  r.el.classList.toggle('is-pip', !!p.pip && p.mode === 'normal');
  r.el.dataset.mode = p.mode;
  r.btn.pip.setAttribute('aria-pressed', String(!!p.pip));
  r.btn.pip.setAttribute('aria-label', p.pip ? tr('Back into the layout') : tr('Picture in picture'));
  r.btn.pip.title = r.btn.pip.getAttribute('aria-label')!;
  const max = state.maximized === id;
  r.btn.max.innerHTML = icon(max ? 'collapse' : 'expand', { size: 16 });
  r.btn.max.setAttribute('aria-label', max ? tr('Restore') : tr('Maximize'));
  r.btn.max.title = r.btn.max.getAttribute('aria-label')!;
  const col = p.mode === 'collapsed';
  r.btn.collapse.innerHTML = icon(col ? 'chevronDown' : 'collapseUp', { size: 16 });
  r.btn.collapse.setAttribute('aria-label', col ? tr('Expand') : tr('Collapse'));
  r.btn.collapse.title = r.btn.collapse.getAttribute('aria-label')!;
  r.btn.collapse.setAttribute('aria-expanded', String(!col));
}

function renderPanelState(id: string) {
  const r = rt.get(id);
  const p = state.panels[id];
  if (!r || !p) return;
  const t = TOOLS[p.tool];
  // No text while running (also when paused): room for the file path. Only loading and errors show.
  const label = r.status === 'active' ? '' : STATE_LABEL[r.status];
  r.stateEl.textContent = label;
  r.stateEl.hidden = !label;
  r.el.dataset.state = r.status;
  r.el.classList.toggle('is-paused', r.paused);
  r.btn.unload.hidden = !(r.status === 'active' && isApp(p.tool));
  const showPh = r.status !== 'active';
  r.placeholder.hidden = !showPh;
  r.host.hidden = showPh;
  if (showPh) {
    const txt: Record<Status, string> = {
      idle: tr('Loads as soon as the panel is visible.'),
      queued: tr('Waits until the previous app has started.'),
      loading: tr('Loading the module.'),
      active: '',
      unloaded: tr('Memory freed. Click to load again.'),
      error: tr('Loading failed: {message}', { message: r.error?.message || tr('unknown error') }),
    };
    r.placeholder.replaceChildren(
      ...nodes(
      h('div.ph-mark', { html: toolMark(t.id, 32) }),
      h('p.duo', t.name, ' ', h('span.tone', STATE_LABEL[r.status])),
      h('small.muted', txt[r.status]),
      r.status === 'unloaded' || r.status === 'error' || r.status === 'idle'
        ? h('button.btn', { type: 'button', onclick: () => requestMount(id, true) }, r.status === 'error' ? tr('Load again') : tr('Load now'))
        : null
      )
    );
  }
  r.engineText.textContent = r.status === 'active' ? `${r.paused ? tr('paused') : tr('running')}${r.loadMs ? ` · ${tr('start {s} s', { s: (r.loadMs / 1000).toFixed(1) })}` : ''}` : '';
}

// ---------------------------------------------------------------- Rendern

/** flex-grow scaled: sums below 1 would only share part of the free space (collapsed neighbours). */
const grow = (size: number) => `${(size * 1000).toFixed(2)} 1 0`;

function renderTree(node: LayoutNode): HTMLElement {
  if (node.t === 'leaf') return h('div.slot', { 'data-slot': node.id });
  const box = h('div.split', { 'data-dir': node.dir });
  node.kids.forEach((k, i) => {
    const collapsed = k.t === 'leaf' && state.panels[k.id]?.mode === 'collapsed';
    const cell = h('div.split-cell' + (collapsed ? '.is-collapsed' : ''), { style: { flex: collapsed ? `0 0 ${node.dir === 'row' ? COLLAPSED_W : HEAD}px` : grow(node.sizes[i]!) } });
    if (collapsed && k.t === 'leaf') rt.get(k.id)?.el.setAttribute('data-axis', node.dir === 'row' ? 'x' : 'y');
    cell.append(renderTree(k));
    box.append(cell);
    if (i < node.kids.length - 1) box.append(makeGutter(node, i, box));
  });
  return box;
}

function makeGutter(node: Extract<LayoutNode, { t: 'split' }>, i: number, box: HTMLElement): HTMLElement {
  const g = h('div.gutter', { role: 'separator', 'aria-orientation': node.dir === 'row' ? 'vertical' : 'horizontal', tabindex: '0', title: tr('Drag to resize. Double click evens out, a double tap with finger or pencil cycles 50:50, 70:30, 30:70 and full screen') });
  const label = h('span.gutter-label.mono', { hidden: true, 'aria-hidden': 'true' });
  g.append(label);
  guardSurface(g);
  const apply = () => {
    const cells = [...box.children].filter((c) => c.classList.contains('split-cell')) as HTMLElement[];
    cells.forEach((c, j) => {
      if (!c.classList.contains('is-collapsed')) c.style.flex = grow(node.sizes[j]!);
    });
    positionPanels();
  };
  let labelTimer: ReturnType<typeof setTimeout> | undefined;
  const showLabel = (ratio: number | 'full') => {
    label.hidden = false;
    label.textContent = ratio === 'full' ? tr('Full screen') : `${Math.round(ratio * 100)} : ${Math.round((1 - ratio) * 100)}`;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => (label.hidden = true), 900);
  };
  const setRatio = (ratio: number) => {
    const sum = node.sizes[i]! + node.sizes[i + 1]!;
    node.sizes[i] = clamp(sum * ratio, MIN, sum - MIN);
    node.sizes[i + 1] = sum - node.sizes[i]!;
  };
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(g, e.pointerId);
    const kind = inputKind(e);
    const rect = box.getBoundingClientRect();
    const total = node.dir === 'row' ? rect.width : rect.height;
    const start = node.dir === 'row' ? e.clientX : e.clientY;
    const a0 = node.sizes[i]!;
    const b0 = node.sizes[i + 1]!;
    document.body.classList.add('is-resizing', node.dir === 'row' ? 'resize-x' : 'resize-y');
    g.classList.add('is-active');
    g.dataset.input = kind;
    const move = (ev: PointerEvent) => {
      const d = ((node.dir === 'row' ? ev.clientX : ev.clientY) - start) / total;
      node.sizes[i] = clamp(a0 + d, MIN, a0 + b0 - MIN);
      node.sizes[i + 1] = a0 + b0 - node.sizes[i]!;
      // Finger and pencil snap at 30, 50 and 70 percent
      if (kind !== 'mouse') {
        const ratio = node.sizes[i]! / (a0 + b0);
        const snap = SNAPS.find((x) => Math.abs(ratio - x) < 0.025);
        if (snap) {
          setRatio(snap);
          showLabel(snap);
        }
      }
      apply();
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      g.classList.remove('is-active');
      document.body.classList.remove('is-resizing', 'resize-x', 'resize-y');
      persist();
      bus.emit('workspace:resize');
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', (e) => {
    // A double tap with finger or pencil also fires dblclick: the snap points apply there
    if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
    if (document.documentElement.dataset.input && document.documentElement.dataset.input !== 'mouse') return;
    node.sizes = node.sizes.map(() => 1 / node.sizes.length);
    apply();
    persist();
  });
  onDoubleTap(g, () => {
    const sum = node.sizes[i]! + node.sizes[i + 1]!;
    const ratio = node.sizes[i]! / sum;
    const at = SNAPS.findIndex((x) => Math.abs(ratio - x) < 0.02);
    if (at === SNAPS.length - 1) {
      // Full screen: maximize the larger side of the last snap point (30:70, so the second one)
      const firstLeaf = (n: LayoutNode): string | null => (n.t === 'leaf' ? n.id : n.kids[0] ? firstLeaf(n.kids[0]) : null);
      const target = firstLeaf(node.kids[i + 1]!);
      showLabel('full');
      setRatio(0.5);
      if (target) workspace.toggleMaximize(target);
      return;
    }
    const next = SNAPS[at + 1] ?? SNAPS[0];
    setRatio(next);
    showLabel(next);
    apply();
    persist();
    bus.emit('workspace:resize');
  });
  g.addEventListener('keydown', (e) => {
    const back = (node.dir === 'row' && e.key === 'ArrowLeft') || (node.dir === 'col' && e.key === 'ArrowUp');
    const fwd = (node.dir === 'row' && e.key === 'ArrowRight') || (node.dir === 'col' && e.key === 'ArrowDown');
    if (!back && !fwd) return;
    e.preventDefault();
    const sum = node.sizes[i]! + node.sizes[i + 1]!;
    node.sizes[i] = clamp(node.sizes[i]! + (fwd ? 0.03 : -0.03) * (e.shiftKey ? 3 : 1), MIN, sum - MIN);
    node.sizes[i + 1] = sum - node.sizes[i]!;
    apply();
    persist();
  });
  return g;
}

/** Floating window: fixed position from the stored rectangle, kept inside the visible area. */
function placePip(id: string) {
  const r = rt.get(id);
  const p = state.panels[id];
  if (!r || !p?.pip) return;
  p.pip = { ...clampRect(p.pip, HEAD), collapsed: p.pip.collapsed };
  r.el.hidden = p.mode !== 'normal';
  r.el.style.setProperty('--pip-x', `${p.pip.x}px`);
  r.el.style.setProperty('--pip-y', `${p.pip.y}px`);
  r.el.style.setProperty('--pip-w', `${p.pip.w}px`);
  r.el.style.setProperty('--pip-h', p.pip.collapsed ? `${HEAD + 8}px` : `${p.pip.h}px`);
}

/** Places every stage panel over its slot. Panels stay in the DOM: iframes never reload. */
function positionPanels() {
  if (!dom) return;
  const base = dom.ws.getBoundingClientRect();
  for (const [id, r] of rt) {
    if (state.panels[id]?.pip) {
      placePip(id);
      continue;
    }
    if (zoneOf(id) !== 'stage') continue;
    if (state.maximized === id) {
      r.el.hidden = false;
      Object.assign(r.el.style, { left: '6px', top: '6px', width: `${base.width - 12}px`, height: `${base.height - 12}px` });
      continue;
    }
    const slot = dom.layout.querySelector(`.slot[data-slot="${CSS.escape(id)}"]`);
    if (!slot) {
      r.el.hidden = true;
      continue;
    }
    const b = slot.getBoundingClientRect();
    r.el.hidden = false;
    Object.assign(r.el.style, { left: `${b.left - base.left}px`, top: `${b.top - base.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  }
}

function renderSides() {
  if (!dom) return;
  // iPad in portrait and medium window widths: both side bars together at most 48 %
  const wsW = dom.ws.clientWidth;
  const open = (['left', 'right'] as const).filter((z) => state.panels[SIDE_IDS[z]]?.mode === 'normal');
  const sum = open.reduce((a, z) => a + state.sides[z], 0);
  const budget = wsW < 1180 ? wsW * 0.48 : Infinity;
  const shrink = sum > budget ? budget / sum : 1;
  dom.ws.dataset.chatSide = prefs.get('chatSide');
  for (const zone of ['left', 'right'] as const) {
    const id = SIDE_IDS[zone];
    const p = state.panels[id];
    const box = zone === 'left' ? dom.left : dom.right;
    const gutter = zone === 'left' ? dom.gl : dom.gr;
    const mode = p?.mode || 'hidden';
    const maxed = state.maximized === id;
    box.dataset.mode = mode;
    box.classList.toggle('is-max', maxed);
    // The panel floats: the zone keeps no width, the panel stays in it (no reload, drafts stay)
    const floating = !!p?.pip && mode === 'normal';
    box.classList.toggle('has-pip', floating);
    if (floating) {
      box.hidden = false;
      box.classList.remove('is-drawer');
      gutter.hidden = true;
      box.style.width = '0px';
      continue;
    }
    const shown = mode === 'normal' || mode === 'collapsed';
    // Narrow windows (Slide Over, Split View 1/3): side bars as drawers over the stage
    const drawer = device.compact && mode === 'normal' && !maxed;
    box.classList.toggle('is-drawer', drawer);
    box.hidden = !shown;
    gutter.hidden = !shown || mode === 'collapsed' || maxed || drawer;
    const maxSide = Math.max(220, Math.round(dom.ws.clientWidth * (drawer ? 0.88 : 0.5)));
    box.style.width = mode === 'collapsed' ? `${COLLAPSED_W}px` : `${Math.round(Math.max(drawer ? 220 : 180, Math.min(state.sides[zone] * (drawer ? 1 : shrink), maxSide)))}px`;
    if (p && rt.get(id)) rt.get(id)!.el.dataset.axis = mode === 'collapsed' ? 'x' : '';
  }
}

function render() {
  if (!dom) return;
  const stageMax = state.maximized && zoneOf(state.maximized) === 'stage' && locateLeaf(state.maximized);
  dom.ws.dataset.max = state.maximized ? zoneOf(state.maximized) : '';
  // Full Chat Mode: the AI chat fills the window (also ?mode=chat)
  const fullChat = state.maximized === 'chat';
  if (document.documentElement.classList.contains('is-chat-full') !== fullChat) {
    document.documentElement.classList.toggle('is-chat-full', fullChat);
    bus.emit('chat:view', { full: fullChat });
  }
  dom.layer.classList.toggle('has-pip', Object.values(state.panels).some((p) => p.pip && p.mode === 'normal' && zoneOf(p.id) === 'stage'));
  dom.ws.classList.toggle('is-compact', device.compact);
  if (!state.tree) dom.layout.replaceChildren(emptyStage());
  else dom.layout.replaceChildren(renderTree(state.tree));
  dom.layer.classList.toggle('has-max', !!stageMax);
  // Gutters of the split tree sit above the panels (z-index 3): hide them behind a maximized panel
  dom.layout.classList.toggle('has-max', !!stageMax);
  renderSides();
  positionPanels();
  for (const id of Object.keys(state.panels)) updateHead(id);
  renderTabs();
  renderDock();
  syncResources();
  persist();
  bus.emit('workspace:change');
  requestAnimationFrame(() => {
    positionPanels();
    bus.emit('workspace:resize');
  });
}

function emptyStage(): HTMLElement {
  const apps = (['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'] as const).map((id) => {
    const t = TOOLS[id];
    return h('button.empty-tool', { type: 'button', style: `--tool:${t.accent}`, onclick: () => workspace.openPanel(id) }, h('span.empty-mark', { html: toolMark(id, 28) }), h('strong', t.name), h('small.muted', t.blurb));
  });
  return h('div.empty-stage', h('div.frame.lg', h('div.well', h('p.eyebrow', tr('Workspace')), h('h2.duo', tr('No panels') + ' ', h('span.tone', tr('open'))), h('p.muted', tr('Open an app. It loads only at that moment.')), h('div.empty-grid', apps))));
}

function renderTabs() {
  if (!dom) return;
  dom.tabs.replaceChildren(
    ...state.order
      .filter((id) => zoneOf(id) === 'stage')
      .map((id) => {
        const p = state.panels[id]!;
        const t = TOOLS[p.tool];
        const r = rt.get(id);
        const cls = ['tab', p.mode !== 'normal' ? 'is-' + p.mode : '', state.focused === id ? 'is-focused' : '', r?.status === 'active' ? (r.paused ? 'is-paused' : 'is-live') : ''].filter(Boolean).join(' ');
        const main = h<'button'>('button.tab-main', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(state.focused === id),
          title: `${t.name}${p.path ? ' · ' + p.path : ''} · ${p.mode === 'normal' ? tr('visible') : p.mode === 'minimized' ? tr('minimized') : p.mode === 'collapsed' ? tr('collapsed') : tr('hidden')}`,
          html: toolMark(t.id, 16) + `<span class="tab-name">${t.name}</span>` + (p.path ? `<span class="tab-file mono">${basename(p.path)}</span>` : ''),
        });
        main.onclick = () => workspace.show(id);
        main.onauxclick = (e) => e.button === 1 && void workspace.close(id);
        const eye = h<'button'>('button.tab-eye', { type: 'button', 'aria-pressed': String(p.mode === 'normal'), 'aria-label': p.mode === 'normal' ? tr('Hide {name}', { name: t.name }) : tr('Show {name}', { name: t.name }), title: p.mode === 'normal' ? tr('Hide') : tr('Show'), html: icon(p.mode === 'normal' ? 'eye' : 'eyeOff', { size: 15 }) });
        eye.onclick = () => (p.mode === 'normal' ? workspace.hide(id) : workspace.show(id));
        return h('div', { class: cls, style: `--tool:${t.accent}`, 'data-id': id, role: 'presentation' }, main, eye);
      })
  );
}

function renderDock() {
  if (!dom) return;
  const items = state.order.filter((id) => state.panels[id]?.mode === 'minimized');
  dom.dock.hidden = !items.length;
  dom.dock.replaceChildren(
    h('span.dock-label.eyebrow', 'Dock'),
    ...items.map((id) => {
      const p = state.panels[id]!;
      const t = TOOLS[p.tool];
      return h(
        'button.dock-chip',
        { type: 'button', style: `--tool:${t.accent}`, title: tr('Restore {name}', { name: t.name }), onclick: () => workspace.show(id) },
        h('span', { html: toolMark(t.id, 16) }),
        h('span', t.name),
        p.path ? h('span.mono.dock-file', basename(p.path)) : null,
        rt.get(id)?.status === 'active' ? h('span.dock-state.mono', tr('paused')) : null
      );
    })
  );
}

// ---------------------------------------------------------------- Side bar width

function enableSideGutter(g: HTMLElement, zone: 'left' | 'right') {
  guardSurface(g);
  onDoubleTap(g, () => {
    state.sides[zone] = zone === 'left' ? 260 : 400;
    renderSides();
    positionPanels();
    persist();
    bus.emit('workspace:resize');
  });
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(g, e.pointerId);
    const start = e.clientX;
    const w0 = state.sides[zone];
    // The chat docked on the left grows to the right
    const growsRight = zone === 'left' || prefs.get('chatSide') === 'left';
    document.body.classList.add('is-resizing', 'resize-x');
    const move = (ev: PointerEvent) => {
      const d = ev.clientX - start;
      state.sides[zone] = clamp(growsRight ? w0 + d : w0 - d, 200, Math.min(760, innerWidth * 0.5));
      renderSides();
      positionPanels();
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-resizing', 'resize-x');
      persist();
      bus.emit('workspace:resize');
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => {
    state.sides[zone] = zone === 'left' ? 260 : 400;
    renderSides();
    positionPanels();
    persist();
  });
}

// ---------------------------------------------------------------- Drag and drop

function enableDrag(head: HTMLElement, id: string) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button') || state.maximized || state.panels[id]?.mode !== 'normal' || state.panels[id]?.pip) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    let hint: HTMLElement | null = null;
    let ghost: HTMLElement | null = null;
    let drop: { target: string; side: Side | 'center' } | null = null;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        dragging = true;
        document.body.classList.add('is-dragging');
        hint = document.body.appendChild(h('div.drop-hint'));
        const t = TOOLS[state.panels[id]!.tool];
        ghost = document.body.appendChild(h('div.drag-ghost', { style: `--tool:${t.accent}`, html: toolMark(t.id, 16) + t.name }));
      }
      ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => n.classList?.contains('panel') && (n as HTMLElement).dataset.zone === 'stage') as HTMLElement | undefined;
      const target = under?.dataset.id;
      if (!target || target === id) {
        hint!.hidden = true;
        drop = null;
        return;
      }
      const r = under!.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const fy = (ev.clientY - r.top) / r.height;
      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      const side: Side | 'center' = edge >= 0.28 ? 'center' : edge === fx ? 'left' : edge === 1 - fx ? 'right' : edge === fy ? 'top' : 'bottom';
      drop = { target, side };
      const box = { left: r.left, top: r.top, width: r.width, height: r.height };
      if (side === 'left' || side === 'right') box.width /= 2;
      if (side === 'right') box.left += r.width / 2;
      if (side === 'top' || side === 'bottom') box.height /= 2;
      if (side === 'bottom') box.top += r.height / 2;
      hint!.hidden = false;
      Object.assign(hint!.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!dragging) return;
      document.body.classList.remove('is-dragging');
      hint?.remove();
      ghost?.remove();
      if (drop) workspace.move(id, drop.target, drop.side);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------------- Public API

export interface PanelSummary {
  id: string;
  tool: ToolId;
  path: string | null;
  mode: Mode;
  status: Status;
  paused: boolean;
  visible: boolean;
  /** Floats as a picture-in-picture window */
  pip: boolean;
}

export const workspace = {
  init(d: { ws: HTMLElement; stage: HTMLElement; left: HTMLElement; right: HTMLElement; gl: HTMLElement; gr: HTMLElement; tabs: HTMLElement; dock: HTMLElement }) {
    const layout = h('div.stage-layout');
    const layer = h('div.stage-panels');
    d.stage.replaceChildren(layout);
    d.ws.append(layer);
    dom = { ...d, layout, layer };
    readMetrics();
    new ResizeObserver(() => positionPanels()).observe(d.ws);
    new ResizeObserver(() => positionPanels()).observe(layout);
    // Rotation, Stage Manager, Split View, Slide Over, keyboard: re-arrange, reload nothing
    let lastCompact = device.compact;
    bus.on('device:change', () => {
      readMetrics();
      if (device.compact !== lastCompact) {
        lastCompact = device.compact;
        render();
        return;
      }
      renderSides();
      positionPanels();
      bus.emit('workspace:resize');
    });
    // Close the drawers when the stage is tapped
    layer.addEventListener('pointerdown', () => {
      if (!device.compact) return;
      for (const id of ['tree', 'chat'] as const) if (state.panels[id]?.mode === 'normal') workspace.hide(id);
    });
    bus.on('settings:change', ({ key }) => key === 'chatSide' && render());
    enableSideGutter(d.gl, 'left');
    enableSideGutter(d.gr, 'right');
    document.addEventListener('visibilitychange', syncResources);
    // Live sync: report changes by the AI, the terminal or other programs to open panels.
    // Writes of a panel itself (origin panel:<id>) are skipped.
    bus.on('fs:file', (e) => {
      for (const [id, r] of rt) {
        const p = state.panels[id];
        if (!p || p.path !== e.path || e.origin === `panel:${id}`) continue;
        if (r.status === 'active') r.instance?.externalChange?.(e.path, e.kind);
      }
    });
    // Team Mode: a sub-agent writes a file; the panels that show it flash its accent and name
    bus.on('agent:file', (e) => flashAgent({ ...e, seq: ++agentSeq }));
    addEventListener('beforeunload', () => persist.flush());
  },

  /** Loads the layout of the project (backend, otherwise localStorage, otherwise the default). */
  async load(projectId: string, fallback: () => void) {
    project = projectId;
    let saved: unknown = null;
    try {
      saved = await api.get('/api/meta/layout');
    } catch {
      /* offline: lokale Kopie */
    }
    if (!validState(saved)) {
      try {
        saved = JSON.parse(localStorage.getItem(`opencraft.layout.${projectId}`) || 'null');
      } catch {
        saved = null;
      }
    }
    state = emptyState();
    if (validState(saved)) {
      for (const [id, p] of Object.entries(saved.panels)) if (TOOLS[p.tool]) state.panels[id] = p;
      state.order = saved.order.filter((id) => state.panels[id]);
      state.tree = prune(saved.tree);
      state.focused = saved.focused && state.panels[saved.focused] ? saved.focused : null;
      state.maximized = saved.maximized && state.panels[saved.maximized] ? saved.maximized : null;
      state.sides = { ...state.sides, ...saved.sides };
      // Stage panels that should be normal but are missing from the tree are kept as hidden
      for (const p of Object.values(state.panels)) if (TOOLS[p.tool].zone === 'stage' && (p.mode === 'normal' || p.mode === 'collapsed') && !p.pip && !locateLeaf(p.id)) p.mode = 'hidden';
    }
    for (const side of ['tree', 'chat'] as const) {
      if (!state.panels[side]) {
        state.panels[side] = { id: side, tool: side, path: null, mode: 'normal' };
        state.order.push(side);
      }
    }
    for (const id of state.order) createPanelDom(id);
    if (!validState(saved)) fallback();
    render();
  },

  openPanel(tool: ToolId, opt: { path?: string | null; focus?: boolean; target?: string | null; side?: Side; silent?: boolean; mode?: Mode } = {}): string {
    const t = TOOLS[tool];
    if (t.single || t.zone !== 'stage') {
      const ex = Object.values(state.panels).find((p) => p.tool === tool);
      if (ex) {
        if (opt.path !== undefined) ex.path = opt.path;
        this.show(ex.id);
        return ex.id;
      }
    }
    const id = uid(tool);
    state.panels[id] = { id, tool, path: opt.path ?? null, mode: opt.mode || 'normal' };
    state.order.push(id);
    createPanelDom(id);
    if (state.panels[id]!.mode === 'normal') {
      const target = opt.target ?? (state.focused && locateLeaf(state.focused) ? state.focused : null);
      // Terminal classically below the focused panel, otherwise next to it
      insertLeaf(id, target, opt.side || (tool === 'terminal' ? 'bottom' : autoSide(target)));
      if (opt.focus !== false) state.focused = id;
      state.maximized = null;
    }
    play('open');
    if (!opt.silent) render();
    return id;
  },

  /** Opens a file in the matching panel (an existing panel of the tool is reused). */
  async openFile(path: string, toolId?: ToolId): Promise<string | undefined> {
    const tool = toolId || toolForPath(path);
    const same = Object.values(state.panels).find((p) => p.path === path && p.tool === tool);
    if (same) {
      this.show(same.id);
      return same.id;
    }
    const candidates = state.order.map((id) => state.panels[id]!).filter((p) => p.tool === tool);
    const reuse = candidates.find((p) => p.id === state.focused) || candidates.find((p) => p.mode === 'normal') || candidates[0];
    if (reuse) {
      reuse.path = path;
      this.show(reuse.id);
      const r = rt.get(reuse.id);
      if (r?.status === 'active' && r.instance?.open) await r.instance.open(path);
      updateHead(reuse.id);
      renderTabs();
      persist();
      return reuse.id;
    }
    return this.openPanel(tool, { path });
  },

  show(id: string) {
    const p = state.panels[id];
    if (!p) return;
    if (zoneOf(id) === 'stage' && !locateLeaf(id) && !p.pip) {
      const prev = p.prev;
      const target = prev?.target && locateLeaf(prev.target) ? prev.target : state.focused && state.focused !== id && locateLeaf(state.focused) ? state.focused : null;
      insertLeaf(id, target, prev?.target && target === prev.target ? prev.side : autoSide(target));
    }
    p.mode = 'normal';
    p.prev = undefined;
    if (state.maximized && state.maximized !== id) state.maximized = null;
    state.focused = id;
    const r = rt.get(id);
    if (r && (r.status === 'unloaded' || r.status === 'error')) requestMount(id, true);
    render();
    r?.el.focus({ preventScroll: true });
  },

  hide(id: string) {
    this.setMode(id, 'hidden');
    play('close');
  },

  minimize(id: string) {
    this.setMode(id, 'minimized');
  },

  toggleCollapse(id: string) {
    const p = state.panels[id];
    // A floating window collapses to its header bar
    if (p?.pip) {
      p.pip.collapsed = !p.pip.collapsed;
      return render();
    }
    this.setMode(id, p?.mode === 'collapsed' ? 'normal' : 'collapsed');
  },

  setMode(id: string, mode: Mode) {
    const p = state.panels[id];
    if (!p || p.mode === mode) return;
    if (mode === 'normal') return this.show(id);
    if (zoneOf(id) === 'stage') {
      if ((mode === 'hidden' || mode === 'minimized') && locateLeaf(id)) p.prev = removeLeaf(id);
      if (mode === 'collapsed' && !locateLeaf(id)) insertLeaf(id, state.focused, 'right');
    }
    p.mode = mode;
    if (state.maximized === id) state.maximized = null;
    if (state.focused === id && mode !== 'collapsed') state.focused = leafIds().find((x) => state.panels[x]?.mode === 'normal') || null;
    render();
  },

  async close(id: string) {
    const r = rt.get(id);
    if (!state.panels[id] || zoneOf(id) !== 'stage') return;
    try {
      if ((await r?.instance?.beforeClose?.()) === false) return;
    } catch (e) {
      console.warn(e);
    }
    await unloadInstance(id);
    removeLeaf(id);
    r?.el.remove();
    rt.delete(id);
    delete state.panels[id];
    state.order = state.order.filter((x) => x !== id);
    const qi = queue.indexOf(id);
    if (qi >= 0) queue.splice(qi, 1);
    if (state.maximized === id) state.maximized = null;
    if (state.focused === id) state.focused = leafIds()[0] || null;
    play('close');
    render();
  },

  focus(id: string, rerender = true) {
    if (state.focused === id) return;
    state.focused = id;
    for (const pid of Object.keys(state.panels)) updateHead(pid);
    renderTabs();
    persist();
    bus.emit('workspace:focus', { id, tool: state.panels[id]?.tool || null });
    if (rerender) render();
  },

  toggleMaximize(id: string | null = state.focused) {
    if (!id || !state.panels[id]) return;
    if (state.panels[id]!.pip) this.togglePip(id, false, true);
    if (state.panels[id]!.mode !== 'normal') this.show(id);
    state.maximized = state.maximized === id ? null : id;
    state.focused = id;
    render();
  },

  /**
   * Picture in picture: the panel floats above the workspace (and above Full Chat Mode) or goes back
   * to its place in the layout. The WebAssembly instance of an app keeps running.
   */
  togglePip(id: string, force?: boolean, silent = false) {
    const p = state.panels[id];
    const r = rt.get(id);
    if (!p || !r) return;
    const on = force ?? !p.pip;
    if (on === !!p.pip) return;
    if (on) {
      const kind = id === 'chat' ? 'chat' : isApp(p.tool) ? 'app' : 'tool';
      if (zoneOf(id) === 'stage' && locateLeaf(id)) p.prev = removeLeaf(id);
      if (state.maximized === id) state.maximized = null;
      p.mode = 'normal';
      p.pip = defaultRect(kind);
      state.focused = id;
    } else {
      delete p.pip;
      if (zoneOf(id) === 'stage' && p.mode !== 'hidden' && p.mode !== 'minimized') {
        const prev = p.prev;
        const target = prev?.target && locateLeaf(prev.target) ? prev.target : state.focused && state.focused !== id && locateLeaf(state.focused) ? state.focused : null;
        insertLeaf(id, target, prev?.target && target === prev.target ? prev.side : autoSide(target));
        p.prev = undefined;
      }
    }
    play(on ? 'open' : 'close');
    if (!silent) render();
    if (r.status === 'unloaded' || r.status === 'error') requestMount(id, true);
  },

  /** Full Chat Mode: the AI chat fills the window (sidebar mode otherwise). */
  setFullChat(on?: boolean) {
    const p = state.panels.chat;
    if (!p) return;
    const want = on ?? state.maximized !== 'chat';
    if (want === (state.maximized === 'chat')) return;
    if (want) {
      if (p.pip) delete p.pip;
      p.mode = 'normal';
      state.maximized = 'chat';
      state.focused = 'chat';
    } else state.maximized = null;
    render();
  },

  get fullChat() {
    return state.maximized === 'chat';
  },

  /** Floating windows and their rectangles (tests, Status page). */
  pips(): { id: string; rect: PipRect }[] {
    return Object.values(state.panels)
      .filter((p) => p.pip && p.mode === 'normal')
      .map((p) => ({ id: p.id, rect: { ...p.pip! } }));
  },

  move(id: string, targetId: string, side: Side | 'center') {
    if (side === 'center') {
      const a = locateLeaf(id);
      const b = locateLeaf(targetId);
      if (a && b && a.node.t === 'leaf' && b.node.t === 'leaf') {
        a.node.id = targetId;
        b.node.id = id;
      }
    } else {
      removeLeaf(id);
      insertLeaf(id, targetId, side);
    }
    state.focused = id;
    render();
  },

  applyPreset(kind: 'single' | 'columns' | 'rows' | 'grid') {
    const ids = leafIds();
    if (!ids.length) return;
    state.maximized = null;
    for (const id of ids) if (state.panels[id]!.mode === 'collapsed') state.panels[id]!.mode = 'normal';
    const leaves: LayoutNode[] = ids.map((id) => ({ t: 'leaf', id }));
    const even = (n: number) => Array<number>(n).fill(1 / n);
    if (kind === 'single') state.maximized = state.focused && ids.includes(state.focused) ? state.focused : ids[0]!;
    else if (kind === 'columns' || ids.length === 1) state.tree = leaves.length === 1 ? leaves[0]! : { t: 'split', dir: 'row', sizes: even(leaves.length), kids: leaves };
    else if (kind === 'rows') state.tree = { t: 'split', dir: 'col', sizes: even(leaves.length), kids: leaves };
    else {
      const cols = Math.ceil(Math.sqrt(leaves.length));
      const rows: LayoutNode[] = [];
      for (let i = 0; i < leaves.length; i += cols) {
        const chunk = leaves.slice(i, i + cols);
        rows.push(chunk.length === 1 ? chunk[0]! : { t: 'split', dir: 'row', sizes: even(chunk.length), kids: chunk });
      }
      state.tree = rows.length === 1 ? rows[0]! : { t: 'split', dir: 'col', sizes: even(rows.length), kids: rows };
    }
    render();
  },

  /** Unloads an app (frees memory, WebAssembly, GPU). Asks when there are unsaved changes, unless forced (emergency stop). */
  async unload(id: string, opt: { force?: boolean } = {}) {
    const r = rt.get(id);
    if (!r || r.status !== 'active') return;
    if (!opt.force && r.instance?.canUnload && !r.instance.canUnload()) {
      const ok = await dialog({ title: TOOLS[state.panels[id]!.tool].name, tone: tr('unload'), body: tr('Unsaved changes will be lost. Save in the app first.'), ok: tr('Unload anyway'), danger: true });
      if (!ok) return;
    }
    await unloadInstance(id);
  },

  /** Returns the instance of a panel. Shows it and loads it first (for MCP commands). */
  ensureInstance(id: string): Promise<PanelInstance> {
    const r = rt.get(id);
    if (!r) return Promise.reject(new Error(tr('Panel not found')));
    if (r.status === 'active' && r.instance) return Promise.resolve(r.instance);
    const p = new Promise<PanelInstance>((resolve, reject) => r.waiters.push({ resolve, reject }));
    if (state.panels[id]!.mode !== 'normal') this.show(id);
    requestMount(id, true);
    return p;
  },

  async instanceForTool(tool: ToolId, path?: string): Promise<{ id: string; instance: PanelInstance }> {
    let id: string | undefined;
    if (path) id = await this.openFile(path, tool);
    else {
      const list = state.order.map((x) => state.panels[x]!).filter((p) => p.tool === tool);
      const pick = list.find((p) => p.id === state.focused) || list.find((p) => p.mode === 'normal') || list[0];
      id = pick ? pick.id : this.openPanel(tool);
      if (pick && pick.mode !== 'normal') this.show(pick.id);
    }
    return { id: id!, instance: await this.ensureInstance(id!) };
  },

  panels(): PanelSummary[] {
    return state.order.map((id) => {
      const p = state.panels[id]!;
      const r = rt.get(id);
      return { id, tool: p.tool, path: p.path, mode: p.mode, status: r?.status || 'idle', paused: !!r?.paused, visible: isVisible(id), pip: !!p.pip };
    });
  },
  /** Everything the Status page shows per panel (the footer texts live here when footers are off). */
  details() {
    return state.order.map((id) => {
      const p = state.panels[id]!;
      const r = rt.get(id);
      return { id, tool: p.tool, name: TOOLS[p.tool].name, path: p.path, mode: p.mode, status: r?.status || 'idle', paused: !!r?.paused, visible: isVisible(id), pip: !!p.pip, text: r?.statusText.textContent || '', loadMs: r?.loadMs || 0, error: r?.error?.message || '' };
    });
  },
  /** Memory per loaded panel for the memory and GPU monitor. */
  resources() {
    return state.order.map((id) => {
      const p = state.panels[id]!;
      const r = rt.get(id);
      let res = null;
      try {
        res = r?.status === 'active' ? r.instance?.resources?.() || null : null;
      } catch {
        res = null;
      }
      return { id, tool: p.tool, name: TOOLS[p.tool].name, path: p.path, status: r?.status || 'idle', paused: !!r?.paused, visible: isVisible(id), loadMs: r?.loadMs || 0, res, unsaved: r?.status === 'active' && !!r.instance?.canUnload && !r.instance.canUnload() };
    });
  },
  panel: (id: string) => state.panels[id] || null,
  instance: (id: string) => rt.get(id)?.instance || null,
  panelsWithPath: (path: string) => Object.values(state.panels).filter((p) => p.path === path).map((p) => p.id),
  get focused() {
    return state.focused;
  },
  get focusedTool(): ToolId | null {
    return state.focused ? state.panels[state.focused]?.tool || null : null;
  },
  /** Unloads all panels and clears the state (project switch). The layout is saved first. */
  async teardown() {
    persist.cancel();
    queue.length = 0;
    for (const id of [...rt.keys()]) {
      const r = rt.get(id)!;
      if (r.status === 'active') await unloadInstance(id);
      clearTimeout(r.unloadTimer);
      for (const w of r.waiters.splice(0)) w.reject(new Error(tr('Project switched')));
      r.el.remove();
      rt.delete(id);
    }
    state = emptyState();
    project = '';
    if (dom) dom.layout.replaceChildren();
  },
  stats,
  isVisible,
  /** Save the layout right away (await it before switching projects). */
  async save() {
    persist.cancel();
    await putLayout();
  },
  render,
};

if (typeof window !== 'undefined') (window as unknown as { __opencraftWorkspace: typeof workspace }).__opencraftWorkspace = workspace;
export { notifyError };
