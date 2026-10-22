// Team Mode interface: the roster editor (popover in the chat header, /roster modal, Settings tab) and
// the Team Mission Control card of a team answer (leader bar, live task graph, parallel worker
// swimlanes, per-role telemetry). Style: .frame > .well with concentric radii, DM Mono for
// data, inline SVG icons from src/app/icons.js, one accent per role.

import { h, esc, debounce, nodes } from '../app/util.js';
import { icon } from '../app/icons.js';
import { t as tr, locale } from '../app/i18n.js';
import { promptText, confirmDanger } from '../app/ui.js';
import { notifyError, toast } from '../app/notifications.js';
import { aiConfig, type AiStatus } from './config.js';
import { mdToHtml } from './markdown.js';
import { compactTokens, money, percent, rowCost, type Rate, type RoleUsage } from './usage.js';
import type { ChatMessage } from './agent.js';
import {
  DEFAULT_TEAM,
  EFFORT_CHOICES,
  ROLE_DEFS,
  TEAM_PRESETS,
  WORKER_ROLES,
  levels,
  normalizeTeam,
  type TaskState,
  type TeamConfig,
  type TeamMember,
  type TeamPhase,
  type TeamRoleId,
  type TeamState,
} from './team.js';

// ---------------------------------------------------------------- Store (backend config, browser mode: localStorage)

export const teamStore = {
  get current(): TeamConfig {
    return normalizeTeam(aiConfig.config?.team?.active ?? DEFAULT_TEAM);
  },
  get saved(): TeamConfig[] {
    return (aiConfig.config?.team?.saved || []).map(normalizeTeam);
  },
  async setActive(cfg: TeamConfig): Promise<void> {
    await aiConfig.put('team', { active: normalizeTeam(cfg) });
  },
  async saveAs(name: string, cfg: TeamConfig): Promise<TeamConfig> {
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'team'}`;
    const next = normalizeTeam({ ...cfg, id, name: name.slice(0, 60) });
    const saved = [...this.saved.filter((s) => s.id !== id), next];
    await aiConfig.put('team', { active: next, saved });
    return next;
  },
  async remove(id: string): Promise<void> {
    await aiConfig.put('team', { saved: this.saved.filter((s) => s.id !== id), active: { ...this.current, id: 'custom' } });
  },
};

const EFFORT_LABEL: Record<string, string> = { auto: tr('Auto'), off: tr('Off'), low: tr('Low'), medium: tr('Medium'), high: tr('High'), max: tr('Max') };

/** Role icon: an inline SVG from icons.js in the role accent. */
export const roleIcon = (role: TeamRoleId, size = 16) => icon(ROLE_DEFS[role].icon, { size });

// ---------------------------------------------------------------- Roster editor

export interface EditorOptions {
  /** Providers from /api/ai/status (configured, local, blocked) */
  providers: AiStatus['providers'];
  /** Narrow layout for the chat popover */
  compact?: boolean;
  onChange?: (cfg: TeamConfig) => void;
}

/**
 * Team configuration: preset, Team Leader and the five specialists with provider, model and effort,
 * concurrency, review mode and retries. Every change is saved right away.
 */
export function teamEditor(o: EditorOptions): HTMLElement {
  let cfg = teamStore.current;
  const root = h('div.team-editor' + (o.compact ? '.is-compact' : ''), { 'data-team-editor': '' });
  const persist = debounce(() => void teamStore.setActive(cfg).catch(notifyError), 250);
  /** A preset or saved team keeps its id; any edit by hand makes it a custom team. */
  const change = (next: TeamConfig, how: { preset?: boolean; rerender?: boolean } = {}) => {
    cfg = normalizeTeam(how.preset ? next : { ...next, id: 'custom', name: 'Custom team' });
    if (how.preset || how.rerender) render();
    else paintPreset();
    persist();
    o.onChange?.(cfg);
  };

  const presetSel = h<'select'>('select.input.team-preset', { 'data-field': 'preset', 'aria-label': tr('Team preset') });
  const presetText = h('p.muted.team-preset-text');
  function paintPreset() {
    const preset = TEAM_PRESETS.find((p) => p.id === cfg.id);
    presetText.textContent = preset ? tr(preset.description) : teamStore.saved.some((x) => x.id === cfg.id) ? tr('Saved team') : tr('Your own team: change providers, models and specialists, then save it with Save as.');
    const saved = teamStore.saved;
    presetSel.replaceChildren(
      h('option', { value: 'custom', selected: !TEAM_PRESETS.some((p) => p.id === cfg.id) && !saved.some((s) => s.id === cfg.id) }, tr('Custom team')),
      h('optgroup', { label: tr('Presets') }, ...TEAM_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === cfg.id }, tr(p.name)))),
      ...(saved.length ? [h('optgroup', { label: tr('Saved teams') }, ...saved.map((p) => h('option', { value: p.id, selected: p.id === cfg.id }, p.name)))] : [])
    );
  }
  presetSel.onchange = () => {
    const id = presetSel.value;
    const p = TEAM_PRESETS.find((x) => x.id === id) || teamStore.saved.find((x) => x.id === id);
    if (p) change(normalizeTeam(JSON.parse(JSON.stringify(p))), { preset: true });
  };

  const providerSelect = (m: TeamMember, onPick: (v: string) => void) => {
    const sel = h<'select'>('select.input.team-provider', { 'data-field': 'provider', 'aria-label': tr('Provider') });
    sel.append(h('option', { value: '' }, tr('Chat model')));
    for (const p of o.providers) {
      const off = (!p.configured && !p.local) || !!p.blocked;
      sel.append(h('option', { value: p.id, disabled: off && p.id !== m.provider, selected: p.id === m.provider }, `${p.name}${p.local ? ` (${tr('local')})` : ''}${p.blocked ? ` (${tr('blocked')})` : !p.configured && !p.local ? ` (${tr('key missing')})` : ''}`));
    }
    if (m.provider && !o.providers.some((p) => p.id === m.provider)) sel.append(h('option', { value: m.provider, selected: true }, m.provider));
    sel.onchange = () => onPick(sel.value);
    return sel;
  };
  const effortSelect = (m: TeamMember, onPick: (v: TeamMember['effort']) => void) => {
    const sel = h<'select'>('select.input.team-effort', { 'data-field': 'effort', 'aria-label': tr('Reasoning effort') });
    for (const e of EFFORT_CHOICES) sel.append(h('option', { value: e, selected: e === m.effort }, EFFORT_LABEL[e]!));
    sel.onchange = () => onPick(sel.value as TeamMember['effort']);
    return sel;
  };
  const modelInput = (m: TeamMember, onPick: (v: string) => void) => {
    const inp = h<'input'>('input.input.mono.team-model', { 'data-field': 'model', placeholder: tr('provider default'), 'aria-label': tr('Model'), value: m.model, spellcheck: 'false', autocomplete: 'off' });
    inp.addEventListener('change', () => onPick(inp.value.trim()));
    return inp;
  };

  function memberRow(m: TeamMember) {
    const d = ROLE_DEFS[m.role];
    const set = (patch: Partial<TeamMember>) => {
      if (patch.enabled === false && cfg.workers.filter((w) => w.enabled).length <= 1) {
        toast(tr('The team needs at least one specialist'), 'warning');
        return render();
      }
      const next: TeamConfig = m.role === 'leader' ? { ...cfg, leader: { ...cfg.leader, ...patch } } : { ...cfg, workers: cfg.workers.map((w) => (w.role === m.role ? { ...w, ...patch } : w)) };
      change(next, { rerender: patch.enabled !== undefined });
    };
    const toggle =
      m.role === 'leader'
        ? h('span.team-lead-tag.mono', tr('Orchestrator'))
        : h('label.switch.team-toggle', h<'input'>('input', { type: 'checkbox', 'data-field': 'enabled', checked: m.enabled, 'aria-label': tr('{name} on the team', { name: tr(d.name) }), onchange: (e: Event) => set({ enabled: (e.target as HTMLInputElement).checked }) }), h('small', m.enabled ? tr('On') : tr('Off')));
    return h(
      'div.team-member.frame.sm',
      { 'data-role': m.role, 'data-enabled': String(m.enabled), style: `--agent:${d.accent}` },
      h(
        'div.well.team-member-well',
        h('div.team-member-head', h('span.team-role-ic', { html: roleIcon(m.role, 16) }), h('span.team-member-name', h('strong', tr(d.name)), h('span.mono.team-mention', '@' + d.mention)), h('span.spacer'), toggle),
        h('p.muted.team-scope', tr(d.scope)),
        h('div.team-member-fields', providerSelect(m, (v) => set({ provider: v })), modelInput(m, (v) => set({ model: v })), effortSelect(m, (v) => set({ effort: v })))
      )
    );
  }

  function render() {
    paintPreset();
    const saved = teamStore.saved.some((s) => s.id === cfg.id);
    const num = (field: 'concurrency' | 'maxRetries', from: number, to: number, label: string) => {
      const sel = h<'select'>('select.input.mono', { 'data-field': field, 'aria-label': label });
      for (let i = from; i <= to; i++) sel.append(h('option', { value: String(i), selected: cfg[field] === i }, String(i)));
      sel.onchange = () => change({ ...cfg, [field]: Number(sel.value) });
      return h('label.field.team-opt', h('span', label), sel);
    };
    const review = h<'select'>('select.input', { 'data-field': 'review', 'aria-label': tr('Review') });
    review.append(h('option', { value: 'leader', selected: cfg.review === 'leader' }, tr('Team Leader reviews each result')), h('option', { value: 'checks', selected: cfg.review === 'checks' }, tr('Automatic checks only (faster)')));
    review.onchange = () => change({ ...cfg, review: review.value as TeamConfig['review'] });
    root.replaceChildren(
      ...nodes(
      h(
        'div.team-presets',
        h('label.field.team-opt.grow', h('span', tr('Team')), presetSel),
        h('button.btn.sm', { type: 'button', 'data-action': 'team-save', html: icon('save', { size: 14 }) + `<span>${tr('Save as…')}</span>`, onclick: () => void saveAs() }),
        saved ? h('button.btn.sm.ghost.danger', { type: 'button', 'data-action': 'team-delete', title: tr('Delete this saved team'), html: icon('trash', { size: 14 }), onclick: () => void remove() }) : null
      ),
      presetText,
      h('p.eyebrow', tr('Team Leader')),
      memberRow(cfg.leader),
      h('p.eyebrow', tr('Specialist sub-agents')),
      h('div.team-members', cfg.workers.map(memberRow)),
      h('div.team-options', num('concurrency', 1, 6, tr('Parallel agents')), h('label.field.team-opt.grow', h('span', tr('Review')), review), num('maxRetries', 0, 3, tr('Retries per task')))
      )
    );
  }

  async function saveAs() {
    const name = (await promptText(tr('Save team'), tr('Name'), cfg.name === 'Custom team' ? '' : cfg.name, tr('team configuration')))?.trim();
    if (!name) return;
    try {
      cfg = await teamStore.saveAs(name, cfg);
      render();
      toast(tr('Team saved: {name}', { name }), 'success');
    } catch (e) {
      notifyError(e);
    }
  }
  async function remove() {
    if (!(await confirmDanger(tr('Delete team'), tr('“{name}” is removed from the saved teams.', { name: cfg.name })))) return;
    try {
      await teamStore.remove(cfg.id);
      cfg = teamStore.current;
      render();
    } catch (e) {
      notifyError(e);
    }
  }

  render();
  return root;
}

// ---------------------------------------------------------------- Mission Control

export const PHASE_LABEL: Record<TeamPhase, string> = { planning: tr('Planning'), delegating: tr('Delegating'), reviewing: tr('Reviewing'), completed: tr('Completed'), stopped: tr('Stopped'), failed: tr('Failed') };
const TASK_LABEL: Record<TaskState['status'], string> = { pending: tr('queued'), running: tr('working'), review: tr('in review'), retry: tr('retrying'), done: tr('done'), failed: tr('failed'), cancelled: tr('cancelled'), skipped: tr('skipped') };

export function phaseLabel(s: TeamState): string {
  const active = s.tasks.filter((t) => t.status === 'running').length;
  if (s.phase === 'delegating') return tr('Delegating ({n} active)', { n: active });
  return PHASE_LABEL[s.phase];
}

const live = (s: TaskState['status']) => s === 'pending' || s === 'running' || s === 'review' || s === 'retry';
const fmtSec = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

export interface MissionHandlers {
  stop(): void;
  cancel(taskId: string): void;
  approve(taskId: string, ok: boolean): void;
  open(path: string): void;
}

/** Per-role telemetry: tokens, cache hits, latency, tool calls and estimated cost. */
export function roleUsageTable(usage: Record<string, RoleUsage>, rates: Record<string, Rate> = {}): HTMLElement {
  const order = ['leader', ...WORKER_ROLES];
  const rows = Object.values(usage).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const total = rows.reduce((a, r) => a + rowCost(r, rates), 0);
  return h(
    'table.team-usage.mono',
    h('thead', h('tr', ...[tr('Role'), tr('Model'), '↑', '↓', tr('Cache'), tr('Latency'), tr('Tools'), tr('Cost')].map((x) => h('th', x)))),
    h(
      'tbody',
      ...rows.map((r) => {
        const d = ROLE_DEFS[r.role as TeamRoleId];
        const cost = rowCost(r, rates);
        return h(
          'tr',
          { 'data-role': r.role, style: `--agent:${d?.accent || '#335CFF'}` },
          h('td', h('span.team-usage-role', h('i', { 'aria-hidden': 'true' }), d ? tr(d.short) : r.role)),
          h('td', { title: `${r.provider} · ${r.model}` }, r.model),
          h('td', compactTokens(r.input)),
          h('td', compactTokens(r.output)),
          h('td', r.input ? percent(r.cached / r.input) : '–'),
          h('td', { title: tr('Average time to the first token, total request time {ms} ms', { ms: r.totalMs }) }, r.requests ? `${Math.round(r.firstMs / r.requests)} ms` : '–'),
          h('td', r.toolCalls ? `${r.toolOk ?? 0}/${r.toolCalls}` : '–'),
          h('td', { title: r.local ? tr('Local model') : rates[r.model] ? '' : tr('No rate set for {model}', { model: r.model }) }, r.local ? '$0.00' : rates[r.model] ? money(cost) : '–')
        );
      })
    ),
    rows.length > 1 ? h('tfoot', h('tr', h('td', { colspan: '7' }, tr('Team total')), h('td', total ? money(total) : '–'))) : null
  );
}

/**
 * Mission Control card of one team answer. Elements are kept per task, so open worker cards stay
 * open and simultaneous streams update only their own card.
 */
export class MissionControl {
  readonly el: HTMLElement;
  private leadModel = h('span.team-lead-model.mono');
  private phase = h('span.team-phase.mono');
  private elapsed = h('span.team-elapsed.mono');
  private stopBtn: HTMLButtonElement;
  private leadLine = h('p.team-lead-activity.mono');
  private goal = h('p.team-goal');
  private graph = h('div.team-graph', { role: 'list', 'aria-label': tr('Task graph') });
  private lanes = h('div.team-lanes');
  private usage = h('div.team-usage-wrap');
  private notes = h('p.team-notes.mono.muted');
  private cards = new Map<string, HTMLDetailsElement>();
  private laneEls = new Map<string, HTMLElement>();
  private state: TeamState | null = null;
  private threads: Record<string, ChatMessage[]> = {};

  constructor(private handlers: MissionHandlers) {
    this.stopBtn = h<'button'>('button.btn.sm.danger.team-stop', { type: 'button', 'data-action': 'team-stop', html: icon('stop', { size: 13 }) + `<span>${tr('Stop all agents')}</span>`, onclick: () => handlers.stop() });
    const lead = ROLE_DEFS.leader;
    this.el = h(
      'section.team-mc.frame',
      { 'aria-label': tr('Team Mission Control'), style: `--agent:${lead.accent}` },
      h(
        'div.well.team-mc-well',
        h('header.team-lead', h('span.team-lead-badge', { 'data-role': 'leader', html: icon(lead.icon, { size: 14 }) + `<span>${tr('Team Leader')}</span>` }), this.leadModel, this.phase, h('span.spacer'), this.elapsed, this.stopBtn),
        this.leadLine,
        this.goal,
        this.graph,
        this.lanes,
        this.usage,
        this.notes
      )
    );
  }

  update(s: TeamState, threads: Record<string, ChatMessage[]>, rates: Record<string, Rate> = {}): void {
    this.state = s;
    this.threads = threads;
    const running = !['completed', 'stopped', 'failed'].includes(s.phase);
    this.el.dataset.phase = s.phase;
    this.el.classList.toggle('is-running', running);
    const leadRow = s.roster.find((r) => r.role === 'leader');
    const leadUse = s.usage.leader;
    this.leadModel.textContent = leadUse ? `${leadUse.provider} · ${leadUse.model}` : leadRow?.provider || leadRow?.model ? [leadRow.provider, leadRow.model].filter(Boolean).join(' · ') : tr('chat model');
    this.phase.textContent = phaseLabel(s);
    this.phase.dataset.phase = s.phase;
    this.elapsed.dataset.start = String(s.started);
    this.elapsed.dataset.end = s.ended ? String(s.ended) : '';
    this.elapsed.textContent = fmtSec((s.ended || Date.now()) - s.started);
    this.stopBtn.hidden = !running;
    this.leadLine.textContent = s.leader.activity || '';
    this.leadLine.hidden = !s.leader.activity;
    this.goal.textContent = s.goal || '';
    this.goal.hidden = !s.goal;
    this.paintGraph(s);
    this.paintLanes(s);
    const roles = Object.keys(s.usage).length;
    this.usage.replaceChildren(...(roles ? [h('p.eyebrow', tr('Usage per role')), roleUsageTable(s.usage, rates)] : []));
    // Notes on how the plan was repaired go to the export; the card shows only what the user should know
    const notes = [...s.notes.filter((n) => /^(plan corrected|repaired):/.test(n)), ...(s.error ? [s.error] : [])];
    this.notes.textContent = notes.join(' · ');
    this.notes.hidden = !notes.length;
  }

  /** Live task graph: one column per dependency level, each node in its agent's accent. */
  private paintGraph(s: TeamState) {
    if (!s.tasks.length) {
      this.graph.replaceChildren(h('span.team-node.is-plan.mono', { 'data-status': s.phase === 'planning' ? 'running' : 'pending' }, s.phase === 'planning' ? tr('Planning the task graph …') : tr('No tasks')));
      return;
    }
    const byId = new Map(s.tasks.map((t) => [t.id, t]));
    this.graph.replaceChildren(
      ...levels(s.tasks).map((ids, i) =>
        h(
          'div.team-level',
          { 'data-level': String(i) },
          i ? h('span.team-arrow', { 'aria-hidden': 'true', html: icon('arrow', { size: 12 }) }) : null,
          ...ids.map((id) => {
            const t = byId.get(id)!;
            const d = ROLE_DEFS[t.assignedAgent];
            return h('span.team-node.mono', { role: 'listitem', 'data-task': t.id, 'data-status': t.status, style: `--agent:${d.accent}`, title: `${t.title}${t.dependencies.length ? ` · ${tr('after {list}', { list: t.dependencies.join(', ') })}` : ''}` }, h('i', { 'aria-hidden': 'true' }), `${t.id} · ${tr(d.short)}`);
          })
        )
      )
    );
  }

  private paintLanes(s: TeamState) {
    const roles = [...new Set(s.tasks.map((t) => t.assignedAgent))];
    const want: HTMLElement[] = [];
    for (const role of roles) {
      const d = ROLE_DEFS[role];
      let lane = this.laneEls.get(role);
      if (!lane) {
        lane = h('section.team-lane', { 'data-role': role, style: `--agent:${d.accent}` }, h('div.team-lane-head', h('span.team-role-ic', { html: roleIcon(role, 15) }), h('strong', tr(d.name)), h('span.team-lane-model.mono')));
        this.laneEls.set(role, lane);
      }
      const use = s.usage[role];
      const ros = s.roster.find((r) => r.role === role);
      lane.querySelector('.team-lane-model')!.textContent = use ? use.model : ros?.model || ros?.provider || '';
      const tasks = s.tasks.filter((t) => t.assignedAgent === role);
      const cards = tasks.map((t) => this.paintWorker(t));
      const head = lane.firstElementChild!;
      if (lane.children.length !== cards.length + 1 || cards.some((c, i) => lane!.children[i + 1] !== c)) lane.replaceChildren(head, ...cards);
      want.push(lane);
    }
    if (want.length !== this.lanes.children.length || want.some((l, i) => this.lanes.children[i] !== l)) this.lanes.replaceChildren(...want);
  }

  private paintWorker(t: TaskState): HTMLDetailsElement {
    const d = ROLE_DEFS[t.assignedAgent];
    let card = this.cards.get(t.id);
    if (!card) {
      card = h<'details'>('details.team-worker.frame.sm', { 'data-task': t.id, 'data-role': t.assignedAgent, style: `--agent:${d.accent}` });
      card.addEventListener('toggle', () => card!.open && this.paintBody(card!, t.id));
      this.cards.set(t.id, card);
    }
    card.dataset.status = t.status;
    const cancel = live(t.status)
      ? h('button.icon-btn.team-cancel', {
          type: 'button',
          'data-action': 'team-cancel',
          title: tr('Cancel this worker'),
          'aria-label': tr('Cancel {name}', { name: tr(d.name) }),
          html: icon('close', { size: 13 }),
          onclick: (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.handlers.cancel(t.id);
          },
        })
      : null;
    const files = t.targetFiles.length ? t.targetFiles : t.changed;
    const summary = h(
      'summary.team-worker-head',
      h('span.team-dot', { 'data-status': t.status, 'aria-hidden': 'true' }),
      h('span.team-role-ic', { html: roleIcon(t.assignedAgent, 14) }),
      h('span.team-worker-title', h('span.mono.team-task-id', t.id), ' ', t.title),
      h('span.spacer'),
      h('span.team-worker-state.mono', TASK_LABEL[t.status] + (t.attempts > 1 ? ` · ${tr('attempt {n}', { n: t.attempts })}` : '')),
      h('span.team-elapsed.mono', { 'data-start': t.started ? String(t.started) : '', 'data-end': t.ended ? String(t.ended) : '' }, t.started ? fmtSec((t.ended || Date.now()) - t.started) : ''),
      cancel
    );
    const meta = h(
      'div.team-worker-meta',
      t.tool ? h('span.team-tool.mono', { 'data-tool': t.tool, html: icon('bolt', { size: 11 }) + `<span>${esc(t.tool)}</span>` }) : null,
      ...files.slice(0, 4).map((p) => h('button.team-file.mono', { type: 'button', title: tr('Open {path}', { path: p }), onclick: (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), this.handlers.open(p)) }, p))
    );
    const lineText = t.activity || (t.status === 'done' ? (t.output || '').replace(/\s+/g, ' ').slice(0, 160) : t.error || '');
    const line = h('div.team-worker-live.mono', { 'aria-live': live(t.status) ? 'polite' : 'off' }, lineText);
    const approval = t.approval
      ? h(
          'div.team-approval',
          { role: 'alert' },
          h('p', h('strong', tr('Approval needed: {title}', { title: t.approval.title }))),
          h('pre.step-args.mono', JSON.stringify(t.approval.args, null, 2).slice(0, 1200)),
          h(
            'div.step-actions',
            h('button.btn.primary.sm', { type: 'button', 'data-action': 'team-approve', onclick: () => this.handlers.approve(t.id, true), html: icon('check', { size: 13 }) + `<span>${tr('Run')}</span>` }),
            h('button.btn.ghost.sm', { type: 'button', 'data-action': 'team-deny', onclick: () => this.handlers.approve(t.id, false) }, tr('Deny'))
          )
        )
      : null;
    const body = card.querySelector<HTMLElement>('.team-worker-body') || h('div.well.team-worker-body.mono');
    card.replaceChildren(summary, meta, line, ...(approval ? [approval] : []), body);
    if (t.approval) card.open = true;
    if (card.open) this.paintBody(card, t.id);
    return card;
  }

  /** Sub-thread inspection: the sub-agent's tool calls, thinking, leader feedback and report. */
  private paintBody(card: HTMLDetailsElement, id: string) {
    const t = this.state?.tasks.find((x) => x.id === id);
    const body = card.querySelector<HTMLElement>('.team-worker-body');
    if (!t || !body) return;
    const thread = this.threads[id] || [];
    const answers = thread.filter((m) => m.role === 'assistant');
    const parts: (Node | null)[] = [];
    parts.push(h('div.step-label', tr('Instructions')), h('p.team-instr', t.instructions || t.title));
    if (t.dependencies.length) parts.push(h('p.muted', tr('Uses the results of {list}', { list: t.dependencies.join(', ') })));
    answers.forEach((a, i) => {
      if (answers.length > 1) parts.push(h('div.step-label', tr('Attempt {n}', { n: i + 1 })));
      const th = a.thoughts?.at(-1);
      if (th?.text) parts.push(h('details.team-think', h('summary.mono', `${tr('Thought process')} · ${fmtSec(th.ms)}`), h('div.team-think-body', th.text.slice(-4000))));
      if (a.steps?.length)
        parts.push(
          h(
            'ol.team-steps',
            a.steps.map((st) => {
              const p = Object.values(st.args).find((v) => typeof v === 'string' && v.startsWith('/')) as string | undefined;
              return h('li', { 'data-status': st.status }, h('span.team-dot', { 'data-status': st.status === 'done' ? 'done' : st.status === 'error' ? 'failed' : st.status === 'waiting' ? 'review' : 'running' }), h('span', st.name), p ? h('span.muted', p) : null, st.result ? h('span.muted', `${st.result.ms} ms`) : null);
            })
          )
        );
    });
    for (const f of t.feedback) parts.push(h('div.team-feedback', h('strong', tr('Leader feedback')), h('p', f)));
    if (t.verdict) parts.push(h('p.muted', `${tr('Review')}: ${t.verdict}`));
    const report = answers.at(-1)?.text || t.output;
    if (report) {
      const md = h('div.md.team-report');
      md.innerHTML = mdToHtml(report);
      parts.push(h('div.step-label', tr('Report')), md);
    }
    if (t.changed.length) parts.push(h('div.step-files', t.changed.map((p) => h('button.att-chip.mono', { type: 'button', onclick: () => this.handlers.open(p) }, p))));
    body.replaceChildren(...parts.filter((x): x is Node => !!x));
  }
}

/** Live timers of every running Mission Control card (elapsed time of the team and of each worker). */
export function tickTeamTimers(scope: ParentNode): void {
  for (const el of scope.querySelectorAll<HTMLElement>('.team-mc.is-running .team-elapsed[data-start]')) {
    const start = Number(el.dataset.start);
    if (!start || el.dataset.end) continue;
    el.textContent = fmtSec(Date.now() - start);
  }
}

/** Short status of a team answer for the message meta line. */
export function teamMeta(s: TeamState): string {
  const done = s.tasks.filter((t) => t.status === 'done').length;
  return tr('team · {done}/{n} tasks · {time}', { done, n: s.tasks.length, time: fmtSec((s.ended || Date.now()) - s.started) });
}

export const formatCount = (n: number) => n.toLocaleString(locale());
