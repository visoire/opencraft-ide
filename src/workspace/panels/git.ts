// Versions: local Git in the project folder (the backend calls the git command line).

import { h, esc, formatTime, debounce, nodes } from '../../app/util.js';
import { icon } from '../../app/icons.js';
import { api } from '../../app/backend.js';
import { bus } from '../../app/bus.js';
import { promptText } from '../../app/ui.js';
import { toast, notifyError, banner } from '../../app/notifications.js';
import type { PanelContext, PanelInstance } from '../registry.js';
import { toolbar } from './common.js';
import { desktopOnly } from './common.js';
import { t as tr } from '../../app/i18n.js';

interface StatusEntry {
  path: string;
  index: string;
  work: string;
}
interface Status {
  repo: boolean;
  branch?: string;
  entries?: StatusEntry[];
  branches?: { current: string; all: string[] };
}
interface LogEntry {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  time: number;
  message: string;
}

const LABEL: Record<string, string> = { M: tr('changed'), A: tr('new'), D: tr('deleted'), R: tr('renamed'), '?': tr('new'), U: tr('conflict') };

function diffHtml(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') ? 'd-meta' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('diff ') || l.startsWith('commit ') ? 'd-meta' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join('\n');
}

/** Simple lane calculation for the history graph. */
function lanes(log: LogEntry[]): { lane: number; width: number }[] {
  const active: (string | null)[] = [];
  return log.map((c) => {
    let lane = active.indexOf(c.sha);
    if (lane < 0) {
      lane = active.indexOf(null);
      if (lane < 0) lane = active.push(null) - 1;
    }
    for (let i = 0; i < active.length; i++) if (i !== lane && active[i] === c.sha) active[i] = null;
    active[lane] = c.parents[0] || null;
    for (const p of c.parents.slice(1)) if (!active.includes(p)) {
      const free = active.indexOf(null);
      if (free >= 0) active[free] = p;
      else active.push(p);
    }
    return { lane, width: active.length };
  });
}

export async function mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> {
  const offline = await desktopOnly(el, ctx, tr('Versions'), 'Git');
  if (offline) return offline;
  const root = h('div.gp');
  el.append(root);
  const branchSel = h<'select'>('select.input.gp-branch.mono', { 'aria-label': 'Branch' });
  const bar = toolbar([
    { icon: 'refresh', label: tr('Refresh'), run: () => void refresh() },
    { icon: 'branch', label: tr('New branch'), run: () => void newBranch() },
    '->',
    branchSel,
  ]);
  const changes = h('div.gp-changes');
  const msg = h<'textarea'>('textarea.input.gp-msg', { rows: 2, placeholder: tr('Describe the change'), 'aria-label': tr('Commit message') });
  const commitBtn = h<'button'>('button.btn.primary', { type: 'button', html: icon('commit', { size: 16 }) + '<span>Commit</span>' });
  const history = h('div.gp-log');
  const diffBox = h('pre.gp-diff.mono', { hidden: true });
  const left = h('div.gp-left.well.flush', h('p.eyebrow', tr('Changes')), changes, h('div.gp-commit', msg, commitBtn));
  const right = h('div.gp-right', h('p.eyebrow', tr('History')), history, diffBox);
  const main = h('div.gp-main', left, right);
  const bannerHost = h('div');
  root.append(bar, bannerHost, main);

  let state: Status = { repo: false };
  let closeBanner: (() => void) | null = null;

  async function refresh() {
    try {
      state = await api.get<Status>('/api/git/status');
    } catch (e) {
      closeBanner?.();
      closeBanner = banner(bannerHost, { level: 'error', title: tr('Git not available'), message: (e as Error).message, timeout: 0, actions: [{ label: tr('Check again'), run: () => void refresh() }] });
      return;
    }
    closeBanner?.();
    if (!state.repo) {
      main.hidden = true;
      closeBanner = banner(bannerHost, {
        level: 'info',
        title: tr('No version control yet'),
        message: tr('Create a local Git repository in the project folder. It stays on your computer.'),
        timeout: 0,
        actions: [{ label: tr('Create repository'), primary: true, run: async () => (await api.send('POST', '/api/git/init', {}), void refresh()) }],
      });
      ctx.setStatus(tr('no repository'));
      return;
    }
    main.hidden = false;
    branchSel.replaceChildren(...(state.branches?.all || [state.branch || 'main']).map((b) => h('option', { value: b, selected: b === state.branches?.current }, b)));
    const entries = state.entries || [];
    const staged = entries.filter((e) => e.index !== ' ' && e.index !== '?');
    const unstaged = entries.filter((e) => e.work !== ' ' || e.index === '?');
    const row = (e: StatusEntry, isStaged: boolean) => {
      const code = isStaged ? e.index : e.work === ' ' ? e.index : e.work;
      return h(
        'div.gp-row',
        h('button.gp-file.mono', { type: 'button', title: tr('Show differences'), onclick: () => void showDiff(e.path) }, e.path),
        h('span.gp-code.mono', { 'data-code': code }, LABEL[code] || code),
        h('button.icon-btn', {
          type: 'button',
          title: isStaged ? tr('Remove from the commit') : tr('Stage for commit'),
          'aria-label': isStaged ? tr('Remove from the commit') : tr('Stage for commit'),
          html: icon(isStaged ? 'minus' : 'plus', { size: 16 }),
          onclick: async () => {
            await api.send('POST', isStaged ? '/api/git/unstage' : '/api/git/add', { paths: [e.path] }).catch((err) => notifyError(err));
            void refresh();
          },
        })
      );
    };
    changes.replaceChildren(
      ...nodes(
      staged.length ? h('div.gp-group', h('small.muted', tr('Staged ({n})', { n: staged.length })), staged.map((e) => row(e, true))) : null,
      unstaged.length ? h('div.gp-group', h('small.muted', tr('Not staged ({n})', { n: unstaged.length })), unstaged.map((e) => row(e, false))) : null,
      !entries.length ? h('p.muted.gp-clean', tr('Working tree clean.')) : null
      )
    );
    commitBtn.disabled = !entries.length;
    ctx.setStatus(`${state.branches?.current || state.branch} · ${entries.length === 1 ? tr('1 change') : tr('{n} changes', { n: entries.length })}`);
    ctx.setBadge(entries.length ? String(entries.length) : null);
    const log = await api.get<LogEntry[]>('/api/git/log?limit=150').catch(() => []);
    const ln = lanes(log);
    history.replaceChildren(
      ...log.map((c, i) => {
        const l = ln[i]!;
        const dots = Array.from({ length: Math.max(l.width, l.lane + 1) }, (_, k) => `<i class="${k === l.lane ? 'dot' : 'rail'}"></i>`).join('');
        return h(
          'button.gp-commit-row',
          { type: 'button', onclick: () => void showCommit(c.sha) },
          h('span.gp-graph', { html: dots }),
          h('span.gp-msg', c.message, ...c.refs.map((r) => h('span.pill.mono', r))),
          h('small.mono.muted', `${c.sha.slice(0, 7)} · ${c.author} · ${formatTime(c.time * 1000)}`)
        );
      })
    );
    if (!log.length) history.append(h('p.muted', tr('No commits yet.')));
  }

  async function showDiff(path: string) {
    const text = await api.text(`/api/git/diff?path=${encodeURIComponent('/' + path.replace(/^\//, ''))}`).catch((e: Error) => e.message);
    diffBox.hidden = false;
    diffBox.innerHTML = diffHtml(text || tr('No differences to the last commit (new file or only staged).'));
  }
  async function showCommit(sha: string) {
    const text = await api.text(`/api/git/show?sha=${encodeURIComponent(sha)}`).catch((e: Error) => e.message);
    diffBox.hidden = false;
    diffBox.innerHTML = diffHtml(text);
  }
  async function newBranch() {
    const name = await promptText(tr('New branch'), tr('Name'), '', tr('create'));
    if (!name) return;
    await api.send('POST', '/api/git/switch', { name, create: true }).catch((e) => notifyError(e));
    void refresh();
  }
  branchSel.onchange = async () => {
    await api.send('POST', '/api/git/switch', { name: branchSel.value }).catch((e) => notifyError(e));
    void refresh();
  };
  commitBtn.onclick = async () => {
    const m = msg.value.trim();
    if (!m) {
      msg.focus();
      return toast(tr('Enter a description first'), 'warning');
    }
    const anyStaged = (state.entries || []).some((e) => e.index !== ' ' && e.index !== '?');
    try {
      const r = await api.send<{ sha: string }>('POST', '/api/git/commit', { message: m, all: !anyStaged });
      msg.value = '';
      toast(tr('Commit {sha} created', { sha: r.sha.slice(0, 7) }), 'success');
    } catch (e) {
      notifyError(e);
    }
    void refresh();
  };

  const queued = debounce(() => void refresh(), 700);
  const off = bus.on('fs:file', () => queued());
  await refresh();

  return {
    resume: () => queued(),
    status: () => ({ branch: state.branches?.current || state.branch || null, changes: state.entries?.length || 0 }),
    getScroll: () => ({ top: history.scrollTop, left: 0 }),
    setScroll: (s) => void (history.scrollTop = s.top),
    unmount() {
      off();
      queued.cancel();
      root.remove();
    },
  };
}
