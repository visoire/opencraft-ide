// Project management in the frontend: create, switch, rename, delete (with confirmation),
// export as ZIP (including chats and layout) and import by drag and drop.

import { api } from '../app/backend.js';
import { bus } from '../app/bus.js';
import { h, formatTime, downloadBlob, extname } from '../app/util.js';
import { icon } from '../app/icons.js';
import { dialog, menu } from '../app/ui.js';
import { toast, notifyError, notify } from '../app/notifications.js';
import { t as tr } from '../app/i18n.js';

export interface ProjectMeta {
  id: string;
  name: string;
  created: string;
  updated: string;
}

let current: ProjectMeta | null = null;
const beforeSwitch = new Set<() => Promise<void> | void>();

/** Save open work (layout, chat) while the old project is still active. */
async function flushBeforeSwitch(): Promise<void> {
  for (const fn of beforeSwitch) {
    try {
      await fn();
    } catch (e) {
      console.warn(e);
    }
  }
}

export const projects = {
  get current() {
    return current;
  },
  onBeforeSwitch(fn: () => Promise<void> | void): () => void {
    beforeSwitch.add(fn);
    return () => beforeSwitch.delete(fn);
  },
  async list(): Promise<{ active: ProjectMeta; projects: ProjectMeta[] }> {
    const r = await api.get<{ active: ProjectMeta; projects: ProjectMeta[] }>('/api/projects');
    current = r.active;
    return r;
  },

  async create(): Promise<void> {
    const r = await dialog({
      title: tr('New project'),
      tone: tr('create'),
      fields: [{ name: 'name', label: tr('Name'), value: '', placeholder: tr('for example Quarterly report') }],
      body: h('p.muted.dlg-text', tr('The project becomes its own folder under ~/OpenCraft/projects. With the template it contains sample files for all four apps.')),
      ok: tr('Create'),
      validate: (v) => (v.name!.trim() ? null : tr('Enter a name.')),
    });
    if (!r) return;
    const template = (await dialog({ title: r.name!.trim(), tone: tr('template'), body: tr('Start with sample files (spreadsheet, document, presentation, PDF) or empty?'), ok: tr('With samples'), cancel: tr('Empty') })) ? 'sample' : 'empty';
    try {
      await flushBeforeSwitch();
      const meta = await api.send<ProjectMeta>('POST', '/api/projects', { name: r.name!.trim(), template, switchTo: true });
      toast(tr('Project {name} created', { name: meta.name }), 'success');
      bus.emit('project:changed');
    } catch (e) {
      notifyError(e);
    }
  },

  async switchTo(id: string): Promise<void> {
    if (current?.id === id) return;
    try {
      await flushBeforeSwitch();
      await api.send('POST', `/api/projects/${encodeURIComponent(id)}/switch`, {});
      bus.emit('project:changed');
    } catch (e) {
      notifyError(e);
    }
  },

  async rename(p: ProjectMeta): Promise<void> {
    const r = await dialog({ title: tr('Rename project'), fields: [{ name: 'name', label: tr('New name'), value: p.name }], ok: tr('Rename'), validate: (v) => (v.name!.trim() ? null : tr('The name is missing.')) });
    if (!r) return;
    try {
      const meta = await api.send<ProjectMeta>('PATCH', `/api/projects/${encodeURIComponent(p.id)}`, { name: r.name!.trim() });
      if (current?.id === meta.id) current = meta;
      bus.emit('project:renamed', meta);
      toast(tr('Project renamed'), 'success');
    } catch (e) {
      notifyError(e);
    }
  },

  /** Delete with confirmation by typing the project name. The project moves to the trash folder. */
  async remove(p: ProjectMeta): Promise<void> {
    const r = await dialog({
      title: tr('Delete project'),
      tone: p.name,
      body: h('p.muted.dlg-text', tr('All files, chats and the layout of this project move to ~/OpenCraft/.trash. Type the project name to confirm.')),
      fields: [{ name: 'confirm', label: tr('Project name'), placeholder: p.name }],
      ok: tr('Delete for good'),
      danger: true,
      validate: (v) => (v.confirm!.trim() === p.name ? null : tr('The name does not match.')),
    });
    if (!r) return;
    try {
      const wasActive = current?.id === p.id;
      if (wasActive) await flushBeforeSwitch();
      await api.send('DELETE', `/api/projects/${encodeURIComponent(p.id)}`);
      notify({ level: 'success', title: tr('Project {name} deleted', { name: p.name }), message: tr('It stays in the trash for 30 days.'), actions: [{ label: tr('Open the trash'), run: () => bus.emit('open-settings', 'trash') }] });
      if (wasActive) bus.emit('project:changed');
    } catch (e) {
      notifyError(e);
    }
  },

  async exportZip(p: ProjectMeta | null = current, includeGit = false): Promise<void> {
    if (!p) return;
    try {
      const bytes = await api.bytes(`/api/projects/${encodeURIComponent(p.id)}/export${includeGit ? '?git=1' : ''}`);
      const name = `${p.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project'}-${new Date().toISOString().slice(0, 10)}.zip`;
      downloadBlob(new Blob([bytes], { type: 'application/zip' }), name);
      toast(tr('Project exported'), 'success', tr('{name} contains files, chats and layout.', { name }));
    } catch (e) {
      notifyError(e);
    }
  },

  /** Exports as a static HTML gallery, a PDF portfolio or a Markdown documentation folder. */
  async exportAs(format: 'html' | 'pdf' | 'markdown', p: ProjectMeta | null = current): Promise<void> {
    if (!p) return;
    const label = { html: tr('HTML gallery'), pdf: tr('PDF portfolio'), markdown: tr('Markdown folder') }[format];
    const close = notify({ level: 'info', title: tr('Exporting: {label}', { label }), message: tr('Building it from the project files …'), timeout: 0 });
    try {
      const bytes = await api.bytes(`/api/projects/${encodeURIComponent(p.id)}/export/${format}`);
      const base = p.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'project';
      const name = format === 'pdf' ? `${base}-portfolio.pdf` : `${base}-${format === 'html' ? 'gallery' : 'docs'}.zip`;
      downloadBlob(new Blob([bytes], { type: format === 'pdf' ? 'application/pdf' : 'application/zip' }), name);
      close();
      toast(tr('{label} exported', { label }), 'success', name);
    } catch (e) {
      close();
      notifyError(e);
    }
  },

  async importZip(file: File, switchTo = true): Promise<ProjectMeta | null> {
    if (extname(file.name) !== 'zip') {
      toast(tr('Only ZIP archives can be imported as a project'), 'warning');
      return null;
    }
    try {
      if (switchTo) await flushBeforeSwitch();
      const j = await api.send<ProjectMeta>('POST', `/api/projects/import?name=${encodeURIComponent(file.name.replace(/\.zip$/i, ''))}&switch=${switchTo ? 1 : 0}`, new Uint8Array(await file.arrayBuffer()), { 'content-type': 'application/zip' });
      toast(tr('Project {name} imported', { name: j.name }), 'success');
      if (switchTo) bus.emit('project:changed');
      return j;
    } catch (e) {
      notifyError(e);
      return null;
    }
  },

  pickZip(): void {
    const input = h<'input'>('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (f) void this.importZip(f);
    };
    document.body.append(input);
    input.click();
  },

  /** Project switcher below the button in the project tree. */
  async openSwitcher(anchor: HTMLElement): Promise<void> {
    let data: { active: ProjectMeta; projects: ProjectMeta[] };
    try {
      data = await this.list();
    } catch (e) {
      return void notifyError(e);
    }
    const r = anchor.getBoundingClientRect();
    const items: Parameters<typeof menu>[0] = data.projects
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map((p) => ({
        label: p.name,
        html: icon(p.id === data.active.id ? 'check' : 'briefcase', { size: 16 }),
        hint: formatTime(p.updated).slice(0, 10),
        run: () => void this.switchTo(p.id),
      }));
    items.push(
      '-',
      { label: tr('New project'), icon: 'plus', run: () => void this.create() },
      { label: tr('Import project (ZIP)'), icon: 'upload', run: () => this.pickZip() },
      { label: tr('Export current project'), icon: 'archive', run: () => void this.exportZip() },
      { label: tr('Export as HTML gallery'), icon: 'browser', run: () => void this.exportAs('html') },
      { label: tr('Export as PDF portfolio'), icon: 'file', run: () => void this.exportAs('pdf') },
      { label: tr('Export as Markdown folder'), icon: 'book', run: () => void this.exportAs('markdown') },
      { label: tr('Share on the home network (read-only)'), icon: 'share', run: () => bus.emit('open-settings', 'share') },
      '-',
      { label: tr('Trash'), icon: 'trash', run: () => bus.emit('open-settings', 'trash') },
      { label: tr('Snapshots and history'), icon: 'clock', run: () => bus.emit('open-settings', 'history') },
      '-',
      { label: tr('Rename'), icon: 'pen', run: () => void this.rename(data.active) },
      { label: tr('Delete project'), icon: 'trash', danger: true, run: () => void this.remove(data.active) }
    );
    menu(items, r.left, r.bottom + 6);
  },

  /** Import ZIP archives dragged onto the workspace (outside the project tree) as a project. */
  installDropImport(overlayHost: HTMLElement): void {
    const overlay = h('div.drop-overlay', { hidden: true }, h('div.frame.lg', h('div.well', h('span', { html: icon('archive', { size: 28 }) }), h('p.duo', tr('Drop the ZIP') + ' ', h('span.tone', tr('as a new project'))), h('small.muted', tr('Drag files without a ZIP into the project tree.')))));
    overlayHost.append(overlay);
    let depth = 0;
    const isZipDrag = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file' && /zip/.test(i.type));
    const outsideTree = (e: DragEvent) => !(e.target as Element | null)?.closest?.('[data-zone="left"]');
    addEventListener('dragenter', (e) => {
      if (!isZipDrag(e) || !outsideTree(e)) return;
      depth++;
      overlay.hidden = false;
    });
    addEventListener('dragover', (e) => {
      if (isZipDrag(e) && outsideTree(e)) e.preventDefault();
    });
    addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        overlay.hidden = true;
      }
    });
    addEventListener('drop', (e) => {
      overlay.hidden = true;
      depth = 0;
      if (!outsideTree(e)) return;
      const files = [...(e.dataTransfer?.files || [])].filter((f) => extname(f.name) === 'zip');
      if (!files.length) return;
      e.preventDefault();
      void (async () => {
        for (const f of files) await this.importZip(f, f === files[files.length - 1]);
      })();
    });
  },
};
