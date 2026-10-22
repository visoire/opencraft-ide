// Project tree (left side bar): shared file access for all panels and the AI chat.
// Import with the file picker, a folder or drag and drop. ZIP archives can be unpacked.

import { h, basename, dirname, extname, normPath, formatBytes, downloadBlob } from '../app/util.js';
import { icon } from '../app/icons.js';
import { bus } from '../app/bus.js';
import { dialog, promptText, confirmDanger, menu, type MenuItem } from '../app/ui.js';
import { toast, notifyError, notify } from '../app/notifications.js';
import { backend } from '../app/backend.js';
import { fs, type Entry } from './fs.js';
import { projects } from './manager.js';
import { TOOLS, toolForPath, toolMark, type PanelContext, type PanelInstance } from '../workspace/registry.js';
import { workspace } from '../workspace/layout.js';
import { allowScribble } from '../workspace/pencil.js';
import { t as tr } from '../app/i18n.js';

const LS_OPEN = 'opencraft.tree.open';

export async function mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> {
  let open: Set<string>;
  try {
    open = new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '["/documents","/sheets"]') as string[]);
  } catch {
    open = new Set(['/documents', '/sheets']);
  }
  let selected: string | null = null;
  let filter = '';
  const saveOpen = () => {
    try {
      localStorage.setItem(LS_OPEN, JSON.stringify([...open]));
    } catch {
      /* blocked */
    }
  };

  const fileInput = h<'input'>('input', { type: 'file', multiple: true, hidden: true });
  const dirInput = h<'input'>('input', { type: 'file', multiple: true, hidden: true });
  dirInput.setAttribute('webkitdirectory', '');
  fileInput.onchange = () => void importFiles([...(fileInput.files || [])], targetDir()).finally(() => (fileInput.value = ''));
  dirInput.onchange = () => void importFiles([...(dirInput.files || [])], targetDir(), true).finally(() => (dirInput.value = ''));

  const act = (ic: string, label: string, run: (e: MouseEvent) => void, action?: string) => h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, html: icon(ic, { size: 16 }), onclick: run, 'data-action': action || null });
  const projectBtn = h<'button'>('button.tree-project', { type: 'button', title: tr('Switch, create or export a project') });
  const search = h<'input'>('input.input.tree-search', { type: 'search', placeholder: tr('Filter'), 'aria-label': tr('Filter files'), spellcheck: 'false' });
  allowScribble(search);
  search.setAttribute('enterkeyhint', 'search');
  const head = h(
    'div.tree-head',
    projectBtn,
    h(
      'div.tree-actions',
      search,
      act('filePlus', tr('New file'), () => void newEntry('file')),
      act('folderPlus', tr('New folder'), () => void newEntry('dir')),
      act('upload', tr('Import files'), () => fileInput.click(), 'import'),
      act('dots', tr('More actions'), (e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu(
          [
            { label: tr('Import folder'), icon: 'folderOpen', run: () => dirInput.click() },
            { label: tr('Export project as ZIP'), icon: 'archive', run: () => void projects.exportZip() },
            '-',
            { label: tr('Collapse all folders'), icon: 'chevron', run: () => (open.clear(), saveOpen(), render()) },
          ],
          r.left,
          r.bottom + 4
        );
      })
    )
  );
  const listEl = h('div.tree-list', { role: 'tree', 'aria-label': tr('Project files'), tabindex: '0' });
  const footEl = h('div.tree-foot.mono');
  const drop = h('div.tree-drop', { 'aria-hidden': 'true' }, h('span', { html: icon('upload', { size: 22 }) }), tr('Drop files here'));
  const root = h('div.tree', head, listEl, footEl, drop, fileInput, dirInput);
  el.append(root);

  async function paintProject() {
    const p = projects.current || (await projects.list().catch(() => null))?.active;
    projectBtn.innerHTML = icon('briefcase', { size: 16 }) + `<span class="tree-project-name">${p ? p.name.replace(/[<>&]/g, '') : tr('Project')}</span>` + icon('chevronDown', { size: 14 });
    ctx.setStatus(p ? tr('Project {name}', { name: p.name }) : '');
  }
  projectBtn.onclick = () => void projects.openSwitcher(projectBtn);

  function targetDir(): string {
    if (!selected) return '/';
    return fs.stat(selected)?.kind === 'dir' ? selected : dirname(selected);
  }

  interface Row extends Entry {
    depth: number;
  }
  function rows(): Row[] {
    const out: Row[] = [];
    if (filter) {
      const q = filter.toLowerCase();
      return fs
        .files()
        .filter((e) => e.path.toLowerCase().includes(q))
        .sort((a, b) => a.path.localeCompare(b.path, 'de'))
        .map((e) => ({ ...e, depth: 0 }));
    }
    const walk = (dir: string, depth: number) => {
      const kids = fs.children(dir).sort((a, b) => (a.kind === b.kind ? basename(a.path).localeCompare(basename(b.path), 'de') : a.kind === 'dir' ? -1 : 1));
      for (const k of kids) {
        out.push({ ...k, depth });
        if (k.kind === 'dir' && open.has(k.path)) walk(k.path, depth + 1);
      }
    };
    walk('/', 0);
    return out;
  }

  function render() {
    const list = rows();
    listEl.replaceChildren(
      ...list.map((e) => {
        const isDir = e.kind === 'dir';
        const tool = isDir ? null : TOOLS[toolForPath(e.path)];
        const row = h(
          'div.tree-row' + (selected === e.path ? '.is-selected' : ''),
          {
            role: 'treeitem',
            'aria-level': String(e.depth + 1),
            'aria-expanded': isDir ? String(open.has(e.path)) : null,
            'aria-selected': selected === e.path ? 'true' : 'false',
            'data-path': e.path,
            draggable: 'true',
            style: `--depth:${e.depth};${tool ? `--tool:${tool.accent}` : ''}`,
            title: e.path,
          },
          h('span.tree-chev', { html: isDir ? icon(open.has(e.path) ? 'chevronDown' : 'chevron', { size: 14 }) : '' }),
          h('span.tree-ic' + (tool?.kind === 'app' ? '.is-app' : ''), { html: isDir ? icon(open.has(e.path) ? 'folderOpen' : 'folder', { size: 16 }) : tool!.kind === 'app' ? toolMark(tool!.id, 16) : icon(tool!.icon, { size: 16 }) }),
          h('span.tree-name', filter ? e.path.slice(1) : basename(e.path)),
          h('span.tree-open-mark', { 'aria-hidden': 'true' }),
          isDir ? null : h('span.tree-size.mono', formatBytes(e.size))
        );
        row.addEventListener('click', () => {
          selected = e.path;
          if (isDir) toggle(e.path);
          else {
            paintSelection();
            void workspace.openFile(e.path);
          }
        });
        row.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          selected = e.path;
          paintSelection();
          contextMenu(e, ev.clientX, ev.clientY);
        });
        // Dragging into the chat creates an @ mention
        row.addEventListener('dragstart', (ev) => {
          ev.dataTransfer?.setData('text/x-opencraft-path', e.path);
          ev.dataTransfer?.setData('text/plain', '@' + e.path.slice(1));
        });
        return row;
      })
    );
    if (!list.length) listEl.append(h('p.muted.tree-empty', filter ? tr('No matches.') : tr('The project is empty. Import files or create new ones.')));
    const files = fs.files();
    footEl.textContent = `${files.length === 1 ? tr('1 file') : tr('{n} files', { n: files.length })} · ${formatBytes(files.reduce((s, f) => s + f.size, 0))} · ${tr('local')}`;
    paintOpenMarks();
  }

  function paintSelection() {
    listEl.querySelectorAll<HTMLElement>('.tree-row').forEach((r) => {
      const on = r.dataset.path === selected;
      r.classList.toggle('is-selected', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  function paintOpenMarks() {
    const openPaths = new Set(workspace.panels().filter((p) => p.path).map((p) => p.path));
    listEl.querySelectorAll<HTMLElement>('.tree-row').forEach((r) => r.classList.toggle('is-open', openPaths.has(r.dataset.path || '')));
  }
  function toggle(path: string) {
    if (open.has(path)) open.delete(path);
    else open.add(path);
    saveOpen();
    render();
  }

  listEl.addEventListener('keydown', (e) => {
    const list = rows();
    const i = list.findIndex((r) => r.path === selected);
    const cur = list[i];
    const go = (j: number) => {
      const r = list[Math.max(0, Math.min(list.length - 1, j))];
      if (!r) return;
      selected = r.path;
      paintSelection();
      listEl.querySelector(`[data-path="${CSS.escape(r.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'ArrowRight' && cur?.kind === 'dir' && !open.has(cur.path)) toggle(cur.path);
    else if (e.key === 'ArrowLeft' && cur?.kind === 'dir' && open.has(cur.path)) toggle(cur.path);
    else if (e.key === 'Enter' && cur) cur.kind === 'dir' ? toggle(cur.path) : void workspace.openFile(cur.path);
    else if (e.key === 'Delete' && cur) void removeEntry(cur.path);
    else if (e.key === 'F2' && cur) void renameEntry(cur.path);
    else return;
    e.preventDefault();
  });
  search.addEventListener('input', () => {
    filter = search.value.trim();
    render();
  });

  function contextMenu(e: Entry, x: number, y: number) {
    const items: (MenuItem | '-')[] = [];
    if (e.kind === 'file') {
      const main = toolForPath(e.path);
      items.push({ label: tr('Open in {name}', { name: TOOLS[main].name }), html: toolMark(main, 16), run: () => void workspace.openFile(e.path) });
      const ext = extname(e.path);
      for (const t of Object.values(TOOLS)) {
        if (t.kind === 'side' || t.id === main) continue;
        if (t.exts.includes(ext) || (t.id === 'code' && (fs.stat(e.path)?.size || 0) < 2e6 && /^(md|txt|csv|tsv|html|svg|json|tex)$/.test(ext))) items.push({ label: tr('Open with {name}', { name: t.name }), html: toolMark(t.id, 16), run: () => void workspace.openFile(e.path, t.id) });
      }
      items.push('-', { label: tr('Mention in the chat'), icon: 'at', run: () => bus.emit('chat:insert', '@' + e.path.slice(1) + ' ') });
      items.push({ label: tr('Download'), icon: 'download', run: () => void exportFile(e.path) });
      items.push({ label: tr('Duplicate'), icon: 'copy', run: async () => void (await fs.write(fs.uniquePath(e.path), await fs.readBinary(e.path))) });
    } else {
      items.push({ label: tr('New file here'), icon: 'filePlus', run: () => void newEntry('file', e.path) });
      items.push({ label: tr('New folder here'), icon: 'folderPlus', run: () => void newEntry('dir', e.path) });
      items.push({ label: tr('Import here'), icon: 'upload', run: () => ((selected = e.path), fileInput.click()) });
      items.push({ label: tr('Mention in the chat'), icon: 'at', run: () => bus.emit('chat:insert', '@' + e.path.slice(1) + '/ ') });
      items.push('-');
    }
    items.push({ label: tr('Rename'), icon: 'pen', hint: 'F2', run: () => void renameEntry(e.path) });
    items.push({ label: tr('Delete'), icon: 'trash', danger: true, run: () => void removeEntry(e.path) });
    menu(items, x, y);
  }

  async function newEntry(kind: 'file' | 'dir', dir = targetDir()) {
    const name = await promptText(kind === 'dir' ? tr('New folder') : tr('New file'), tr('Name'), kind === 'dir' ? tr('folder') : tr('note.md'), tr('create'));
    if (!name) return;
    const p = normPath(dir + '/' + name);
    if (fs.exists(p)) return toast(tr('{name} already exists', { name }), 'error');
    try {
      if (kind === 'dir') {
        await fs.mkdir(p);
        open.add(p);
      } else {
        await fs.write(p, '');
        open.add(dir);
        void workspace.openFile(p);
      }
      saveOpen();
      selected = p;
      render();
    } catch (e) {
      notifyError(e);
    }
  }
  async function renameEntry(path: string) {
    const name = await promptText(tr('Rename'), tr('New name'), basename(path));
    if (!name || name === basename(path)) return;
    try {
      await fs.rename(path, normPath(dirname(path) + '/' + name));
    } catch (e) {
      notifyError(e);
    }
  }
  async function removeEntry(path: string) {
    const st = fs.stat(path);
    const where = backend.browser ? '' : ' ' + tr('It stays in the trash for 30 days.');
    if (!(await confirmDanger(tr('Delete'), (st?.kind === 'dir' ? tr('{name} and everything in it is deleted from the project.', { name: basename(path) }) : tr('{name} is deleted from the project.', { name: basename(path) })) + where))) return;
    for (const p of workspace.panels()) if (p.path && (p.path === path || p.path.startsWith(path + '/'))) await workspace.close(p.id);
    try {
      await fs.remove(path);
      if (!backend.browser) notify({ level: 'success', title: tr('{name} moved to the trash', { name: basename(path) }), actions: [{ label: tr('Open the trash'), run: () => bus.emit('open-settings', 'trash') }], timeout: 6000 });
    } catch (e) {
      notifyError(e);
    }
    if (selected === path) selected = null;
  }
  async function exportFile(path: string) {
    downloadBlob(new Blob([await fs.readBinary(path)]), basename(path));
  }

  async function importFiles(files: File[], dir = '/', keepPaths = false): Promise<number> {
    let n = 0;
    try {
      for (const f of files) {
        const rel = keepPaths && f.webkitRelativePath ? f.webkitRelativePath : f.name;
        if (extname(f.name) === 'zip') {
          const choice = await dialog({ title: f.name, tone: tr('import'), body: tr('Unpack the archive into this folder or keep it as a ZIP file? To import it as its own project, use the project switcher or drop it on the workspace.'), ok: tr('Unpack'), cancel: tr('Keep as file') });
          if (choice) {
            const { unzipSync } = await import('fflate');
            const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
            const base = normPath(dir + '/' + f.name.replace(/\.zip$/i, ''));
            for (const [name, data] of Object.entries(entries)) {
              if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
              await fs.write(normPath(base + '/' + name), data);
              n++;
            }
            continue;
          }
        }
        await fs.write(fs.uniquePath(normPath(dir + '/' + rel)), await f.arrayBuffer());
        n++;
      }
    } catch (e) {
      notifyError(e);
    }
    if (n) {
      open.add(dir);
      saveOpen();
      render();
      toast(n === 1 ? tr('{n} file imported', { n }) : tr('{n} files imported', { n }), 'success');
    }
    return n;
  }

  // Drag and drop of files from the operating system
  let depth = 0;
  root.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    depth++;
    root.classList.add('is-drop');
  });
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  root.addEventListener('dragleave', () => {
    if (--depth <= 0) root.classList.remove('is-drop');
  });
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    depth = 0;
    root.classList.remove('is-drop');
    const p = (e.target as Element).closest<HTMLElement>('.tree-row')?.dataset.path;
    const dir = p ? (fs.stat(p)?.kind === 'dir' ? p : dirname(p)) : '/';
    void importFiles([...e.dataTransfer.files], dir);
  });

  const offs = [bus.on('fs:change', render), bus.on('workspace:change', paintOpenMarks), bus.on('project:renamed', () => void paintProject())];
  void paintProject();
  render();
  if (ctx.restore?.scroll) listEl.scrollTop = ctx.restore.scroll.top;

  return {
    status: () => ({ project: projects.current?.name, files: fs.files().length }),
    getScroll: () => ({ top: listEl.scrollTop, left: 0 }),
    setScroll: (s) => void (listEl.scrollTop = s.top),
    unmount() {
      offs.forEach((f) => f());
      root.remove();
    },
  };
}
