// Panel host for WordCraft, GridCraft, DeckCraft and PdfCraft.
//
// The apps are WebAssembly builds (wgpu: WebGPU, otherwise WebGL2) and run in an iframe of the
// same origin. The bridge to the project:
// - Save/Export in the app (download through <a download>) writes the file into the project.
// - Open in the app (<input type=file>) lists the project files first.
// - Files reach the app as a drop event on its canvas. When the AI or another program changes
//   the open file, it is handed over again: the app shows the new state
//   without reloading the page.
// - Pausing stops the render loop (requestAnimationFrame is held back). The document stays
//   in memory. Resuming runs the held frames.
// - iPadOS: one pixel ratio with the main window, CSS compensation of different sizes
//   (transform: scale with an adjusted container size), WebGL2 without a secure context
//   (home network over HTTP), adapts to Stage Manager, Split View, Slide Over and rotation without
//   reloading the WebAssembly instance.
// - Apple Pencil: a precise mouse in the app (select, drag, place, reshape); pressure, tilt,
//   rotation and hover as a preview in the color of the tool. The finger pans and zooms.

import { h, basename, dirname, extname, normPath, clock, modKey } from '../../app/util.js';
import { icon } from '../../app/icons.js';
import { bus } from '../../app/bus.js';
import { prefs } from '../../app/settings.js';
import { dialog } from '../../app/ui.js';
import { toast, banner } from '../../app/notifications.js';
import { play } from '../../app/sounds.js';
import { fs } from '../../project/fs.js';
import { TOOLS, type PanelContext, type PanelInstance, type PanelResources, type ToolId } from '../registry.js';
import { device } from '../../app/device.js';
import { bridgeFrame, InkLayer, pencilSeen, type InkStyle, type PenSample } from '../pencil.js';
import type { PdfPenTool } from '../pdf-pen.js';
import { t as tr } from '../../app/i18n.js';

interface PenMode {
  id: string;
  label: string;
  color: string;
  style: InkStyle;
  /** PdfCraft: opens the pencil view with this tool */
  pdf?: PdfPenTool;
}

const BLUE = '#3B82F6';
const GREEN = '#10B981';
const ORANGE = '#F97316';
const TEAL = '#14B8A6';

/** Pencil modes per app, with the color codes of the tools. */
export const PEN_MODES: Partial<Record<ToolId, PenMode[]>> = {
  wordcraft: [
    { id: 'text', label: tr('Select text'), color: BLUE, style: 'highlight' },
    { id: 'vector', label: tr('Vector'), color: ORANGE, style: 'ink' },
  ],
  deckcraft: [
    { id: 'vector', label: tr('Place vector'), color: ORANGE, style: 'ink' },
    { id: 'text', label: tr('Select text'), color: BLUE, style: 'highlight' },
  ],
  gridcraft: [
    { id: 'range', label: tr('Cell range'), color: GREEN, style: 'rect' },
    { id: 'fill', label: tr('Fill handle'), color: GREEN, style: 'ink' },
  ],
  pdfcraft: [
    { id: 'sign', label: tr('Sign'), color: TEAL, style: 'ink', pdf: 'sign' },
    { id: 'ink', label: tr('Freehand'), color: TEAL, style: 'ink', pdf: 'ink' },
    { id: 'mark', label: tr('Highlight'), color: TEAL, style: 'highlight', pdf: 'mark' },
    { id: 'redact', label: tr('Redact'), color: TEAL, style: 'redact', pdf: 'redact' },
  ],
};

/** Renderer of the apps: WebGPU only in a secure context (HTTPS, localhost), otherwise WebGL2. */
export function wantsWebgl(): boolean {
  const nav = navigator as Navigator & { gpu?: unknown };
  return prefs.get('renderer') === 'webgl' || !window.isSecureContext || !nav.gpu;
}

const START_TIMEOUT = 90_000;

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pdf: 'application/pdf',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const mimeOf = (p: string) => MIME[extname(p)] || 'application/octet-stream';

type AppWindow = Window & typeof globalThis & { wasmBindings?: unknown };

export async function mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> {
  const t = TOOLS[ctx.tool];
  const root = h('div.ca', { style: `--tool:${t.accent}` });
  el.append(root);

  let iframe: HTMLIFrameElement | null = null;
  let win: AppWindow | null = null;
  let started = false;
  let dirty = false;
  let paused = false;
  let renderer = '';
  let loadMs = 0;
  let t0 = 0;
  let lastSave = '';
  let lastSync = '';
  let pendingOpen: string | null = ctx.path;
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => (readyResolve = r));
  const blobs = new Map<string, Blob>();
  const cleanups: (() => void)[] = [];
  const frames = { held: new Map<number, FrameRequestCallback>(), next: -1, raf: null as null | ((cb: FrameRequestCallback) => number) };
  let closeBanner: (() => void) | null = null;
  let unbridge: (() => void) | null = null;
  const modes = PEN_MODES[ctx.tool] || [];
  let penMode: PenMode | null = modes[0] || null;
  let fingerMode: 'auto' | 'pan' | 'edit' = 'auto';
  const gestures: string[] = [];
  let lastPen: PenSample | null = null;
  let fitScale = 1;

  // ---------- Ladeanzeige ----------
  const elapsed = h('span.mono');
  const overlay = h(
    'div.ca-loading',
    h('div.frame', h('div.well.ca-loading-well', h('img', { src: t.logo, width: 48, height: 48, alt: '' }), h('p.duo', t.name, ' ', h('span.tone', tr('loading'))), h('small.muted.mono', `v${t.version} · WebAssembly`), elapsed))
  );
  const errorBox = h('div.ca-error', { hidden: true });
  const bannerHost = h('div.ca-banner');
  root.append(overlay, errorBox, bannerHost);

  // ---------- Pencil: trail, hover preview and toolbar ----------
  const trailCanvas = h<'canvas'>('canvas.ca-trail', { 'aria-hidden': 'true' });
  const trail = new InkLayer(trailCanvas);
  const hoverRing = h('div.ca-hover', { hidden: true, 'aria-hidden': 'true' });
  const penInfo = h('span.ca-pen-info.mono', { role: 'status' });
  const penBar = h('div.ca-pen.frame.sm', { role: 'toolbar', 'aria-label': `Apple Pencil in ${t.name}` });
  root.append(trailCanvas, hoverRing, penBar);
  let trailFade: ReturnType<typeof setTimeout> | undefined;
  // Collapsed: only the pencil icon and the active mode, so the status line of the app stays free
  let penOpen = false;

  function paintPenBar() {
    const modeBtns = modes.map((m) =>
      h<'button'>('button.ca-pen-mode', {
        type: 'button',
        style: `--pen:${m.color}`,
        'data-mode': m.id,
        'aria-pressed': String(penMode?.id === m.id),
        title: m.pdf ? tr('{label}: open the pencil view', { label: m.label }) : tr('{label} (color {color})', { label: m.label, color: m.color }),
        onclick: () => {
          penMode = m;
          paintPenBar();
          if (m.pdf) void openPdfSheet(m.pdf);
        },
      }, h('i.ca-pen-dot', { 'aria-hidden': 'true' }), h('span', m.label))
    );
    const finger = h<'button'>('button.ca-pen-finger', {
      type: 'button',
      'data-finger': fingerMode,
      title: tr('Finger: move or edit'),
      onclick: () => {
        fingerMode = fingerMode === 'auto' ? 'edit' : fingerMode === 'edit' ? 'pan' : 'auto';
        paintPenBar();
      },
    }, fingerMode === 'pan' ? tr('Finger moves') : fingerMode === 'edit' ? tr('Finger edits') : tr('Finger automatic'));
    const toggle = h<'button'>('button.ca-pen-ic', {
      type: 'button',
      'aria-expanded': String(penOpen),
      'aria-label': penOpen ? tr('Collapse the pencil bar') : tr('Expand the pencil bar'),
      title: 'Apple Pencil',
      html: icon('pen', { size: 16 }),
      onclick: () => {
        penOpen = !penOpen;
        paintPenBar();
      },
    });
    penBar.classList.toggle('is-open', penOpen);
    penBar.replaceChildren(h('div.well.ca-pen-well', toggle, ...(penOpen ? [...modeBtns, finger, penInfo] : modeBtns.filter((b) => b.getAttribute('aria-pressed') === 'true'))));
  }
  paintPenBar();

  /** Coordinates in the app window to coordinates of the panel (with the compensation scale). */
  const toRoot = (x: number, y: number) => ({ x: x * fitScale, y: y * fitScale });

  function onPen(s: PenSample, phase: 'hover' | 'down' | 'move' | 'up' | 'leave') {
    lastPen = s;
    const p = toRoot(s.x, s.y);
    const color = penMode?.color || t.accent;
    const tiltDeg = Math.round(90 - (s.altitude * 180) / Math.PI);
    bus.emit('pencil:sample', { panel: ctx.id, kind: s.kind, pressure: s.pressure, tiltX: s.tiltX, tiltY: s.tiltY, twist: s.twist, hover: s.hover });
    if (phase === 'leave') {
      hoverRing.hidden = true;
      return;
    }
    if (phase === 'hover') {
      hoverRing.hidden = false;
      const size = penMode?.style === 'highlight' ? 18 : penMode?.style === 'rect' ? 12 : 10;
      hoverRing.style.setProperty('--pen', color);
      Object.assign(hoverRing.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${size}px`, height: `${size}px`, transform: `translate(-50%, -50%) rotate(${(s.azimuth * 180) / Math.PI}deg) scaleX(${1 + (tiltDeg / 90) * 0.8})` });
      penInfo.textContent = `${tr('hovering')} · ${tiltDeg}°`;
      return;
    }
    hoverRing.hidden = true;
    const pt = { x: p.x, y: p.y, p: s.pressure || 0.5, tiltX: s.tiltX, tiltY: s.tiltY };
    if (phase === 'down') {
      clearTimeout(trailFade);
      trailCanvas.classList.remove('is-fading');
      trail.clear();
      const r = root.getBoundingClientRect();
      if (trail.size.width !== Math.round(r.width) || trail.size.height !== Math.round(r.height)) trail.resize(Math.round(r.width), Math.round(r.height));
      trail.begin(penMode?.style === 'redact' ? 'rect' : penMode?.style || 'ink', color, penMode?.style === 'highlight' ? 5 : 2.2, pt);
    } else if (phase === 'move') trail.extend(pt);
    else if (phase === 'up') {
      trail.end();
      trailCanvas.classList.add('is-fading');
      trailFade = setTimeout(() => {
        trail.clear();
        trailCanvas.classList.remove('is-fading');
      }, 650);
    }
    penInfo.textContent = `${tr('Pressure')} ${s.pressure.toFixed(2)} · ${tiltDeg}° · ${Math.round(s.twist)}°`;
  }

  /** PdfCraft: pencil view for signature, freehand, highlight and redaction. */
  async function openPdfSheet(tool: PdfPenTool) {
    const path = ctx.path;
    if (!path || extname(path) !== 'pdf') return toast(tr('Open a PDF file first'), 'warning', tr('The pencil view works with the open file.'));
    if (dirty) {
      const ok = await dialog({ title: t.name, tone: tr('unsaved changes'), body: tr('The pencil view works with the saved state of the file. Unsaved changes in PdfCraft are lost when you apply.'), ok: tr('Open anyway') });
      if (!ok) return;
    }
    const { openPdfPen } = await import('../pdf-pen.js');
    const r = await openPdfPen(path, { tool, origin: 'pencil' });
    if (r.saved) {
      dirty = false;
      status();
    }
  }

  // ---------- Size: compensate different measures (Retina, iPadOS iframes) ----------
  /**
   * Measures the width the app uses for its layout and compensates differences to the
   * visible panel size with transform: scale and an adjusted iframe size.
   */
  function fitFrame() {
    const f = iframe;
    if (!f) return;
    const box = root.getBoundingClientRect();
    if (!box.width || !box.height) return;
    f.style.transform = '';
    f.style.minWidth = '';
    f.style.minHeight = '';
    f.style.width = `${box.width}px`;
    f.style.height = `${box.height}px`;
    let inner = 0;
    try {
      inner = f.contentWindow?.innerWidth || 0;
    } catch {
      inner = 0;
    }
    const ratio = inner > 0 ? inner / box.width : 1;
    if (Math.abs(ratio - 1) > 0.02 && isFinite(ratio)) {
      fitScale = 1 / ratio;
      f.style.minWidth = '0';
      f.style.minHeight = '0';
      f.style.width = `${box.width * ratio}px`;
      f.style.height = `${box.height * ratio}px`;
      f.style.transformOrigin = '0 0';
      f.style.transform = `scale(${fitScale.toFixed(5)})`;
    } else fitScale = 1;
    root.dataset.fit = fitScale.toFixed(3);
    try {
      f.contentWindow?.postMessage({ type: 'opencraft:refit' }, location.origin);
    } catch {
      /* not loaded yet */
    }
  }
  const ro = new ResizeObserver(() => fitFrame());
  ro.observe(root);
  cleanups.push(() => ro.disconnect());
  cleanups.push(bus.on('device:change', () => fitFrame()));
  cleanups.push(bus.on('workspace:resize', () => fitFrame()));

  const tick = setInterval(() => {
    if (!started && t0) elapsed.textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' s';
  }, 100);
  cleanups.push(() => clearInterval(tick));

  function status() {
    const parts = [started ? renderer : tr('loading')];
    if (paused) parts.push(tr('paused'));
    if (dirty) parts.push(tr('unsaved changes'));
    if (lastSave) parts.push(tr('saved {time}', { time: lastSave }));
    if (lastSync) parts.push(tr('updated {time}', { time: lastSync }));
    ctx.setStatus(parts.join(' · '));
    ctx.setDirty(dirty);
  }

  // ---------- iframe ----------
  function create() {
    const webgl = wantsWebgl();
    started = false;
    t0 = performance.now();
    overlay.hidden = false;
    errorBox.hidden = true;
    iframe = h<'iframe'>('iframe.ca-frame', {
      src: t.src + (webgl ? '?webgl' : ''),
      title: `${t.name} ${t.version}`,
      allow: 'fullscreen; clipboard-read; clipboard-write',
      scrolling: 'no',
    });
    iframe.addEventListener('load', onLoad);
    root.prepend(iframe);
    fitFrame();
    status();
  }

  function destroy() {
    unbridge?.();
    unbridge = null;
    if (!iframe) return;
    try {
      iframe.src = 'about:blank';
    } catch {
      /* bereits entfernt */
    }
    iframe.remove();
    iframe = null;
    win = null;
    started = false;
    frames.held.clear();
  }

  function onLoad() {
    try {
      win = iframe?.contentWindow as AppWindow | null;
      if (!win || win.location.href === 'about:blank') return;
      void win.document;
    } catch {
      return fail(tr('The app runs on another origin. The project connection only works on the same origin.'));
    }
    installHooks(win);
    const w = win;
    const done = async () => {
      if (started || win !== w) return;
      started = true;
      // public/craft-theme.js may still set the app's own theme option (WordCraft), keep the overlay until then
      const themeReady = (w as unknown as { __ocThemeReady?: Promise<void> }).__ocThemeReady;
      if (themeReady) await Promise.race([themeReady, new Promise((r) => setTimeout(r, 15000))]);
      if (win !== w) return;
      loadMs = performance.now() - t0;
      bus.emit('metric', { name: `app:${ctx.tool}`, value: loadMs });
      renderer = !wantsWebgl() && (w.navigator as Navigator & { gpu?: unknown }).gpu ? 'WebGPU' : 'WebGL2';
      fitFrame();
      overlay.hidden = true;
      status();
      readyResolve();
      // The app accepts drop events only after its first drawn frames
      void settle(w).then(() => {
        if (pendingOpen && win === w) openPath(pendingOpen).catch((e: Error) => toast(e.message, 'error'));
      });
    };
    if (w.wasmBindings) done();
    else {
      w.addEventListener('TrunkApplicationStarted', done, { once: true });
      const poll = setInterval(() => {
        if (win !== w) return clearInterval(poll);
        if (w.wasmBindings) {
          clearInterval(poll);
          done();
        } else if (performance.now() - t0 > START_TIMEOUT) {
          clearInterval(poll);
          fail(tr('{name} did not start within {s} s.', { name: t.name, s: START_TIMEOUT / 1000 }));
        }
      }, 200);
      cleanups.push(() => clearInterval(poll));
    }
  }

  /** Waits a few frames of the app (at most 2.5 s), so its event handling is ready. */
  function settle(W: AppWindow, frameCount = 12): Promise<void> {
    return new Promise((resolve) => {
      let n = 0;
      const timer = setTimeout(resolve, 2500);
      const raf = frames.raf || W.requestAnimationFrame.bind(W);
      const step = () => {
        if (++n >= frameCount) {
          clearTimeout(timer);
          setTimeout(resolve, 120);
        } else raf(step);
      };
      raf(step);
    });
  }

  function fail(msg: string) {
    overlay.hidden = true;
    errorBox.hidden = false;
    readyResolve();
    errorBox.replaceChildren(
      h(
        'div.frame',
        h(
          'div.well',
          h('p.eyebrow', t.name),
          h('h3.duo', tr('Start') + ' ', h('span.tone', tr('failed'))),
          h('p.muted', msg),
          h(
            'div.ca-actions',
            h('button.btn.primary', { type: 'button', onclick: () => reload() }, tr('Reload')),
            h('button.btn', { type: 'button', onclick: () => (prefs.set('renderer', 'webgl'), reload()) }, tr('Load with WebGL2'))
          )
        )
      )
    );
  }

  function reload() {
    destroy();
    create();
  }

  // ---------- Bridge to the app ----------
  function installHooks(W: AppWindow) {
    // Render loop: hold frames back while the panel is paused
    const origRaf = W.requestAnimationFrame.bind(W);
    const origCancel = W.cancelAnimationFrame.bind(W);
    frames.raf = origRaf;
    W.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (!paused) return origRaf(cb);
      const id = frames.next--;
      frames.held.set(id, cb);
      return id;
    };
    W.cancelAnimationFrame = (id: number) => {
      if (id < 0) frames.held.delete(id);
      else origCancel(id);
    };

    const proto = W.HTMLElement.prototype;
    const origClick = proto.click;
    const origPicker = W.HTMLInputElement.prototype.showPicker;
    const origCreate = W.URL.createObjectURL.bind(W.URL);
    const origRevoke = W.URL.revokeObjectURL.bind(W.URL);

    W.URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = origCreate(obj);
      if (obj instanceof W.Blob) blobs.set(url, obj);
      return url;
    };
    W.URL.revokeObjectURL = (url: string) => {
      setTimeout(() => {
        blobs.delete(url);
        origRevoke(url);
      }, 30_000);
    };

    proto.click = function (this: HTMLElement) {
      if (this instanceof W.HTMLInputElement && this.type === 'file') return void pickFor(this);
      if (this instanceof W.HTMLAnchorElement && this.hasAttribute('download') && /^(blob|data):/.test(this.href)) {
        void captureDownload(this.href, this.getAttribute('download'));
        if (prefs.get('appDownloads') === 'both') return origClick.call(this);
        return;
      }
      return origClick.call(this);
    };
    if (origPicker) {
      W.HTMLInputElement.prototype.showPicker = function (this: HTMLInputElement) {
        if (this.type === 'file') return void pickFor(this);
        return origPicker.call(this);
      };
    }

    const doc = W.document;
    let down: { x: number; y: number } | null = null;
    doc.addEventListener(
      'keydown',
      (e) => {
        const mod = e.metaKey || e.ctrlKey;
        const k = e.key.toLowerCase();
        if (mod && (k === 'k' || k === 'j')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (k === 'k') bus.emit('palette:open', undefined);
          else bus.emit('ai:toggle', undefined);
          return;
        }
        if (!['Shift', 'Control', 'Alt', 'Meta', 'Escape', 'Tab'].includes(e.key) && !(mod && ['c', 's', 'p', 'f'].includes(k)) && !e.key.startsWith('Arrow')) markDirty();
      },
      true
    );
    doc.addEventListener('paste', markDirty, true);
    doc.addEventListener(
      'pointerdown',
      (e) => {
        down = { x: e.clientX, y: e.clientY };
        ctx.focus();
      },
      true
    );
    doc.addEventListener(
      'pointerup',
      (e) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) markDirty();
        down = null;
      },
      true
    );
    // Apple Pencil, finger and trackpad: the pencil works precisely, the finger pans
    unbridge?.();
    unbridge = bridgeFrame(W, {
      fingerPans: () => fingerMode === 'pan' || (fingerMode === 'auto' && (ctx.tool === 'gridcraft' || pencilSeen())),
      onSample: (smp, phase) => onPen(smp, phase),
      onGesture: (g) => {
        gestures.push(g.type);
        if (gestures.length > 50) gestures.shift();
      },
    });
    // Files dragged from the device onto the app also land in the project
    doc.addEventListener(
      'drop',
      (e) => {
        if (!e.isTrusted || !e.dataTransfer?.files?.length) return;
        for (const f of e.dataTransfer.files) void importIntoProject(f).then((p) => p && ctx.setPath(p));
      },
      true
    );
  }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    status();
  }

  async function importIntoProject(file: File): Promise<string> {
    const target = fs.uniquePath(normPath(`${t.folder}/${file.name}`));
    await fs.write(target, await file.arrayBuffer(), ctx.origin);
    return target;
  }

  /** Save in the app: write the file into the project. */
  async function captureDownload(href: string, rawName: string | null) {
    try {
      const blob = blobs.get(href) || (await (await fetch(href)).blob());
      const name = (rawName || 'export').replace(/[\\/]/g, '-');
      const cur = ctx.path;
      const dir = cur ? dirname(cur) : t.folder || '/';
      const target = cur && basename(cur) === name ? cur : normPath(`${dir}/${name}`);
      const existed = fs.exists(target);
      await fs.write(target, blob, ctx.origin);
      if (t.exts.includes(extname(target))) ctx.setPath(target);
      dirty = false;
      lastSave = clock();
      closeBanner?.();
      status();
      play('notify');
      toast(`${existed ? 'Aktualisiert' : 'Gespeichert'}: ${target}`, 'success');
    } catch (e) {
      toast(tr('Saving into the project failed'), 'error', (e as Error).message);
    }
  }

  function acceptsPath(input: HTMLInputElement, path: string) {
    const accept = (input.accept || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const ext = extname(path);
    if (!accept.length) return t.exts.includes(ext);
    return accept.some((a) => (a.startsWith('.') ? a.slice(1) === ext : a.endsWith('/*') ? mimeOf(path).startsWith(a.slice(0, -1)) : mimeOf(path) === a));
  }

  /** File picker of the app: project files or the device. */
  async function pickFor(input: HTMLInputElement) {
    const W = win;
    if (!W) return;
    const files = fs.files().filter((e) => acceptsPath(input, e.path));
    let chosen: string[] | null = null;
    let closeDlg = () => {};
    const list = h(
      'div.ca-pick-list',
      files.length
        ? files.map((f) =>
            h(
              'button.ca-pick-item',
              {
                type: 'button',
                onclick: () => {
                  chosen = [f.path];
                  closeDlg();
                },
              },
              h('span', { html: icon('file', { size: 16 }) }),
              h('span.mono', f.path)
            )
          )
        : h('p.muted', tr('No matching file in the project.'))
    );
    const device = h<'button'>('button.btn', { type: 'button', html: icon('upload', { size: 16 }) + `<span>${tr('Choose from the device')}</span>` });
    const dlg = dialog({
      title: tr('Open in {name}', { name: t.name }),
      tone: tr('from the project'),
      body: h('div.ca-pick', list, h('div.ca-pick-foot', device, h('small.muted', tr('Files from the device are also copied into the project.')))),
      ok: false,
      onOpen: (close) => (closeDlg = close),
    });
    device.onclick = () => {
      const picker = h<'input'>('input', { type: 'file', accept: input.accept || t.exts.map((e) => '.' + e).join(','), hidden: true });
      picker.multiple = input.multiple;
      picker.onchange = async () => {
        const arr = [...(picker.files || [])];
        picker.remove();
        if (!arr.length) return;
        const paths: string[] = [];
        for (const f of arr) paths.push(await importIntoProject(f));
        chosen = paths;
        closeDlg();
      };
      document.body.append(picker);
      picker.click();
    };
    await dlg;
    const picked = chosen as string[] | null;
    if (!picked) {
      input.dispatchEvent(new W.Event('cancel'));
      return;
    }
    const dt = new W.DataTransfer();
    for (const p of picked) {
      const f = await projectFile(W, p);
      if (!f) return;
      dt.items.add(f);
    }
    input.files = dt.files;
    input.dispatchEvent(new W.Event('input', { bubbles: true }));
    input.dispatchEvent(new W.Event('change', { bubbles: true }));
    ctx.setPath(picked[0]!);
    dirty = false;
    status();
  }

  async function projectFile(W: AppWindow, path: string): Promise<File | null> {
    const data = await fs.readBinary(path);
    if (win !== W || !W.File) return null;
    return new W.File([data], basename(path), { type: mimeOf(path), lastModified: fs.stat(path)?.mtime || Date.now() });
  }

  /** Hands a project file to the app canvas as a drop. */
  async function openPath(path: string): Promise<string> {
    pendingOpen = path;
    ctx.setPath(path);
    const W = win;
    if (!started || !W) return tr('The file opens after the start.');
    // The iframe may be unloaded while waiting (project switch, closing)
    const gone = () => win !== W || !W.File;
    if (!fs.exists(path)) await fs.reload();
    if (gone()) return tr('The panel was unloaded.');
    if (!fs.exists(path)) throw new Error(tr('File not found: {path}', { path }));
    const file = await projectFile(W, path);
    if (gone() || !file) return tr('The panel was unloaded.');
    const canvas = W.document.getElementById(t.canvas || '') || W.document.querySelector('canvas');
    if (!canvas) throw new Error(tr('{name}: drawing surface not found', { name: t.name }));
    const dt = new W.DataTransfer();
    dt.items.add(file);
    const r = canvas.getBoundingClientRect();
    const opts: DragEventInit = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new W.DragEvent(type, opts));
    // Trigger a frame even when the panel is paused right now
    if (paused) kick();
    pendingOpen = null;
    dirty = false;
    closeBanner?.();
    status();
    return tr('{file} passed to {name}.', { file: basename(path), name: t.name });
  }

  function kick() {
    if (!frames.raf) return;
    const held = [...frames.held.values()];
    frames.held.clear();
    for (const cb of held) frames.raf(cb);
  }

  function pause() {
    if (paused) return;
    paused = true;
    status();
  }
  function resume() {
    if (!paused) return;
    paused = false;
    kick();
    status();
  }

  create();
  status();

  return {
    ready,
    open: (path) => openPath(normPath(path)),
    pause,
    resume,
    canUnload: () => !dirty,
    externalChange(path, kind) {
      if (path !== ctx.path) return;
      if (kind === 'delete') {
        closeBanner?.();
        closeBanner = banner(bannerHost, { level: 'warning', title: tr('{file} was deleted', { file: basename(path) }), message: tr('The app shows the last state. Saving creates the file again.'), timeout: 0 });
        return;
      }
      const apply = async () => {
        await openPath(path);
        lastSync = clock();
        status();
        ctx.setBadge(tr('new'));
        setTimeout(() => ctx.setBadge(null), 2500);
      };
      if (!dirty) return void apply().catch((e: Error) => toast(e.message, 'error'));
      closeBanner?.();
      closeBanner = banner(bannerHost, {
        level: 'warning',
        title: tr('{file} was changed outside', { file: basename(path) }),
        message: tr('The app has unsaved changes. Reload takes the file as it is now and discards your changes.'),
        timeout: 0,
        actions: [
          { label: tr('Reload'), primary: true, run: () => apply() },
          { label: tr('Keep my version'), run: () => {} },
        ],
      });
    },
    resources: () => {
      try {
        const w = iframe?.contentWindow as (Window & { __ocResources?: () => PanelResources }) | null;
        return w?.__ocResources?.() || null;
      } catch {
        return null;
      }
    },
    status: () => ({
      app: t.name,
      version: t.version,
      loaded: started,
      paused: paused,
      renderer: renderer || null,
      file: ctx.path,
      unsaved: dirty,
      start_ms: Math.round(loadMs),
      last_saved: lastSave || null,
      last_synced: lastSync || null,
      scale: Number(fitScale.toFixed(3)),
      pixel_ratio: device.info.renderDpr,
      pen_mode: penMode?.id || null,
      finger: fingerMode,
      last_gestures: gestures.slice(-5),
      last_pen: lastPen ? { pressure: lastPen.pressure, tilt_x: lastPen.tiltX, tilt_y: lastPen.tiltY, twist: lastPen.twist, hover: lastPen.hover } : null,
    }),
    /** Pencil view for PdfCraft (tests and command palette) */
    pen: (tool?: string) => (ctx.tool === 'pdfcraft' ? openPdfSheet((tool as PdfPenTool) || 'sign') : undefined),
    async beforeClose() {
      if (!dirty) return true;
      return !!(await dialog({ title: t.name, tone: tr('close'), body: tr('Unsaved changes will be lost. Save in the app first ({key} S or File, Save).', { key: modKey }), ok: tr('Close anyway'), danger: true }));
    },
    unmount() {
      cleanups.splice(0).forEach((f) => f());
      closeBanner?.();
      destroy();
      root.remove();
    },
  };
}
