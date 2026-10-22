// AI chat: one panel, three views that share the same state (a running answer and the draft stay):
//   sidebar      docked left or right of the workspace (Settings or the chat menu)
//   Full Chat    fills the window, history drawer next to the conversation (ide/?mode=chat)
//   floating     picture-in-picture window above the workspace, or a native window on desktop
//
// Token streaming, @ and / popovers, file attachments (picker, drag and drop, paste), live timeline
// cards of the tool calls, error pause with retry and correction, search, history per project and
// across projects, export, and live token usage with the context window in the footer.

import { h, esc, uid, modKey, debounce, nodes, extname, basename } from '../app/util.js';
import { icon } from '../app/icons.js';
import { bus } from '../app/bus.js';
import { prefs } from '../app/settings.js';
import { dialog, menu, popover, promptText, confirmDanger } from '../app/ui.js';
import { notifyError, banner, explain, toast } from '../app/notifications.js';
import { play } from '../app/sounds.js';
import { APP_ACCENT, TOOL_BY_NAME } from '../mcp/schemas.js';
import { orchestrator, type ToolMeta } from '../mcp/orchestrator.js';
import { toolMark, type PanelContext, type PanelInstance } from '../workspace/registry.js';
import { workspace } from '../workspace/layout.js';
import { attachMentions, findMentions, resolveMentions, agentMentions, SYSTEM_COMMANDS, type Attachment } from './mentions.js';
import { TeamSession, settleSaved, type TeamSendOptions } from './team-runner.js';
import { MissionControl, teamEditor, teamStore, tickTeamTimers, teamMeta, roleUsageTable, phaseLabel } from './team-ui.js';
import { ROLE_DEFS, enabledWorkers, type WorkerRoleId } from './team.js';
import type { Rate, RoleUsage } from './usage.js';
import { Agent, newChat, type AgentStep, type ChatMessage, type ChatRecord, type FailureChoice, type SendExtras, type Thought } from './agent.js';
import { StreamRenderer, mdToHtml } from './markdown.js';
import { history, autosaver, searchMessages, exportChat, type ChatSummary } from './history.js';
import { api, backend } from '../app/backend.js';
import { aiConfig, chatTarget } from './config.js';
import { loadTokenizer, tokenizerNow } from './tokens.js';
import { fitRequest } from './budget.js';
import { DEEPSEEK_PRESETS, presetOf, resolveDeepSeekParams, type DeepSeekPresetId } from './deepseek.js';
import { effortChoices } from './models.js';
import type { Effort } from './types.js';
import { projects } from '../project/manager.js';
import { fs } from '../project/fs.js';
import type { ToolApp } from './types.js';
import { allowScribble } from '../workspace/pencil.js';
import { openPalette } from '../app/palette.js';
import { AttachmentTray, filesOf, enhanceScan } from './attachments.js';
import { cacheHitRatio, cacheSavings, compactTokens, contextWindow, countRequest, money, percent } from './usage.js';
import { telemetry, usageTable, providerTable } from './telemetry.js';
import { nativePipSupported, popOut, nativePipOpen, closeNativePip } from '../workspace/pip.js';
import { t as tr, tn, locale } from '../app/i18n.js';

const STATUS_LABEL: Record<AgentStep['status'], string> = { pending: tr('preparing'), running: tr('running'), done: tr('done'), error: tr('error'), skipped: tr('skipped'), waiting: tr('waiting for you') };
const OPEN_KEY = 'opencraft.chat.open';
const DRAWER_KEY = (full: boolean) => `opencraft.chat.history.${full ? 'full' : 'side'}`;

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

/** Suggestion cards of the welcome screen, with files of the project where there are some. */
function suggestions(): { app: 'gridcraft' | 'wordcraft' | 'deckcraft' | 'pdfcraft'; title: string; text: string; prompt: string }[] {
  const pick = (exts: string[]) => fs.files().find((f) => exts.includes(extname(f.path)));
  const ref = (exts: string[], fallback: string) => {
    const f = pick(exts);
    return f ? '@' + basename(f.path) : fallback;
  };
  const sheet = ref(['xlsx', 'csv'], '@sheets/');
  const doc = ref(['docx', 'md'], '@documents/');
  const pdf = ref(['pdf'], '@pdf/');
  return [
    { app: 'gridcraft', title: tr('Analyze a GridCraft sheet'), text: tr('Read the figures and sum up the trend'), prompt: tr('Read {ref} with @gridcraft and sum up revenue, costs and margin per quarter in a short table.', { ref: sheet }) },
    { app: 'wordcraft', title: tr('Draft a WordCraft report'), text: tr('A one-page report from your data'), prompt: tr('Write a one-page report about {ref} in @wordcraft and save it as /documents/report.docx.', { ref: sheet }) },
    { app: 'deckcraft', title: tr('Build DeckCraft slides'), text: tr('Three slides with the key points'), prompt: tr('Create three presentation slides in @deckcraft with the key points of {ref}.', { ref: doc }) },
    { app: 'pdfcraft', title: tr('Redact a PdfCraft file'), text: tr('Find what should be blacked out'), prompt: tr('Read {ref} with @pdfcraft and list every passage with confidential or personal data that I should redact.', { ref: pdf }) },
  ];
}

export async function mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> {
  let chat: ChatRecord = newChat();
  let agent: Agent;
  const views = new Map<string, { el: HTMLElement; body: HTMLElement; steps: HTMLElement; renderer?: StreamRenderer; cards: Map<string, HTMLElement>; meta: HTMLElement; mission?: MissionControl }>();
  let team: TeamSession;
  /** Rates for the cost per role in Mission Control (US dollars per million tokens) */
  let rates: Record<string, Rate> = {};
  const busy = () => !!agent?.running || !!team?.running;
  const pendingFailures = new Map<string, (c: FailureChoice) => void>();
  const save = autosaver(() => chat);
  const panelEl = () => el.closest<HTMLElement>('.panel');

  // ---------------------------------------------------------------- Header: controls and live badges
  const btn = (ic: string, label: string, run: (e: MouseEvent) => void, extra: Record<string, string> = {}) => h<'button'>('button.icon-btn', { type: 'button', title: label, 'aria-label': label, html: icon(ic, { size: 16 }), onclick: run, ...extra });
  const providerSel = h<'select'>('select.input.chat-provider.mono', { 'aria-label': tr('AI model for this chat') });
  const personaSel = h<'select'>('select.input.chat-persona', { 'aria-label': tr('Persona'), title: tr('Persona: role and system prompt of the AI (Settings, Personal context)'), 'data-action': 'persona' });
  const providerBtn = h<'button'>('button.chat-select-btn.chat-provider-btn.mono', {
    type: 'button',
    'aria-label': tr('AI model for this chat'),
    title: tr('AI model for this chat'),
    'aria-haspopup': 'menu',
    onclick: () => void openProviderMenu(providerBtn),
  });
  const personaBtn = h<'button'>('button.chat-select-btn.chat-persona-btn', {
    type: 'button',
    'aria-label': tr('Persona'),
    title: tr('Persona: role and system prompt of the AI (Settings, Personal context)'),
    'aria-haspopup': 'menu',
    'data-action': 'persona-btn',
    onclick: () => openPersonaMenu(personaBtn),
  });
  const providerWrap = h('div.chat-select-wrap', providerBtn, providerSel);
  const personaWrap = h('div.chat-select-wrap', personaBtn, personaSel);
  const localBadge = h('button.chat-badge.mono', { type: 'button', 'data-kind': 'local-only', hidden: true, title: tr('Local-only mode: cloud providers are blocked'), onclick: () => bus.emit('open-settings', 'privacy') });
  const statusPill = h('button.chat-status.chat-badge.mono', { type: 'button', title: tr('Model settings'), 'data-kind': 'model' });
  const latencyBadge = h('span.chat-badge.mono', { 'data-kind': 'latency', title: tr('Time to the first token of the last answer') }, '– ms');
  const mcpBadge = h('span.chat-badge.mono', { 'data-kind': 'mcp', title: tr('MCP tools ready for the AI') }, 'MCP …');
  // Single Agent or Team Orchestrator Mode, the same switch in the sidebar, Full Chat Mode and the floating chat
  const modeBtns = (['single', 'team'] as const).map((m) =>
    h('button.seg-btn.chat-mode-btn', { type: 'button', 'data-mode': m, 'data-action': `mode-${m}`, title: m === 'single' ? tr('Single Agent Mode: one assistant answers') : tr('Team Orchestrator Mode: a Team Leader plans, specialists work in parallel'), onclick: () => setMode(m), html: icon(m === 'single' ? 'user' : 'users', { size: 13 }) + `<span>${m === 'single' ? tr('Single') : tr('Team')}</span>` })
  );
  const modeSeg = h('div.seg.chat-mode', { role: 'group', 'aria-label': tr('Chat mode') }, modeBtns);
  const rosterBtn = h<'button'>('button.chat-badge.chat-roster.mono', { type: 'button', 'data-action': 'roster', 'aria-haspopup': 'dialog', title: tr('Team configuration: leader, specialists, models ({cmd})', { cmd: '/roster' }), onclick: () => void openRoster(rosterBtn) });
  const historyBtn = btn('sidebar', tr('Chat history'), () => toggleDrawer(), { 'data-action': 'history', 'aria-expanded': 'false' });
  const searchBtn = btn('search', tr('Search in the chat'), () => toggleSearch());
  const usageBtn = btn('trend', tr('Token usage'), (e) => void openUsage(e.currentTarget as HTMLElement), { 'data-action': 'usage' });
  const fullBtn = btn('expand', tr('Full Chat Mode ({key} ⇧ J)', { key: modKey }), () => workspace.setFullChat(), { 'data-action': 'full' });
  const moreBtn = btn('dots', tr('More'), (e) => moreMenu(e.currentTarget as HTMLElement), { 'data-action': 'more', 'aria-haspopup': 'menu' });
  const head = h(
    'div.chat-head',
    h(
      'div.chat-bar',
      historyBtn,
      providerWrap,
      personaWrap,
      h('span.spacer'),
      searchBtn,
      usageBtn,
      btn('download', tr('Export chat'), (e) => exportMenu(e.currentTarget as HTMLElement), { 'data-action': 'export' }),
      btn('trash', tr('Clear chat'), () => void clearChat(), { 'data-action': 'clear' }),
      btn('plus', tr('New chat'), () => void startNew(), { 'data-action': 'new' }),
      fullBtn,
      moreBtn
    ),
    h('div.chat-badges', modeSeg, rosterBtn, localBadge, statusPill, latencyBadge, mcpBadge)
  );
  const searchInput = h<'input'>('input.input.chat-search-input', { type: 'search', placeholder: tr('Search messages and tool parameters'), 'aria-label': tr('Search the chat') });
  const searchInfo = h('span.chat-search-info.mono');
  const searchBar = h('div.chat-search', { hidden: true }, searchInput, searchInfo);
  const bannerHost = h('div.chat-banner');
  const list = h('div.chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': tr('Chat history') });

  // ---------------------------------------------------------------- Prompt bar
  const ta = h<'textarea'>('textarea.chat-input', { rows: 1, placeholder: tr('Message the AI'), 'aria-label': tr('Message the AI'), spellcheck: 'true' });
  const sendBtn = h<'button'>('button.chat-send', { type: 'button', 'aria-label': tr('Send'), title: tr('Send (Enter)'), html: icon('send', { size: 16 }) });
  const fileInput = h<'input'>('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,.pdf,.txt,.md,.csv,.tsv,.json,.xlsx,.xls,.ods,.docx,.doc,.odt,.pptx,.odp' });
  const attachBtn = h<'button'>('button.icon-btn.chat-attach', { type: 'button', 'data-action': 'attach', title: tr('Attach files (or drop or paste them)'), 'aria-label': tr('Attach files'), html: icon('clip', { size: 18 }), onclick: () => fileInput.click() });
  // Scan a document with the camera (iPad, iPhone) or pick a photo: grayscale and contrast for readable text
  const scanInput = h<'input'>('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, 'data-scan': '' });
  const scanBtn = h<'button'>('button.icon-btn.chat-scan', { type: 'button', 'data-action': 'scan', title: tr('Scan a document with the camera or add a photo'), 'aria-label': tr('Scan document'), html: icon('image', { size: 18 }), onclick: () => scanInput.click() });
  scanInput.onchange = async () => {
    const files = [...(scanInput.files || [])];
    scanInput.value = '';
    for (const f of files) await tray.add([await enhanceScan(f)]);
    if (files.length) toast(tr('Scan added'), 'success', tr('Ask for example: extract the table into GridCraft, or combine the scans into a PDF for PdfCraft.'));
  };
  const chips = h('div.chat-chips');
  const tray = new AttachmentTray(() => {
    paintSend();
    attachBtn.dataset.count = tray.count ? String(tray.count) : '';
  });
  // Quick buttons above the input: without a hardware keyboard, by finger or Apple Pencil
  const quickRow = h(
    'div.quick.chat-quick',
    { role: 'group', 'aria-label': tr('Quick access in the chat') },
    h('button.quick-btn', { type: 'button', 'data-quick': 'at', title: tr('@ files, folders, projects, apps'), 'aria-label': tr('Open the @ menu'), onclick: () => trigger('@') }, '@'),
    h('button.quick-btn', { type: 'button', 'data-quick': 'slash', title: tr('/ tools and commands'), 'aria-label': tr('Open the / menu'), onclick: () => trigger('/') }, '/'),
    h('button.quick-btn', { type: 'button', 'data-quick': 'palette', title: tr('Command palette ({key} K)', { key: modKey }), 'aria-label': tr('Open command palette'), html: icon('command', { size: 18 }), onclick: () => openPalette() })
  );
  // Reasoning bar in the prompt bar: provider and thinking effort, switched without leaving the chat
  const modelChip = h<'button'>('button.chat-model-chip.mono', { type: 'button', 'data-action': 'model-chip', 'aria-haspopup': 'menu', onclick: () => void openModelMenu(modelChip) });
  const composerWell = h(
    'div.well.chat-composer-well',
    tray.el,
    chips,
    quickRow,
    h('div.chat-composer-row', attachBtn, scanBtn, ta, sendBtn),
    h('div.chat-reasoning-bar', modelChip),
    h('div.chat-hint.mono', h('span', tr('@ files, apps')), h('span', tr('/ tools')), h('span', tr('Enter sends')), h('span', tr('{key} J on/off', { key: modKey })))
  );
  const composer = h('div.chat-composer.frame.sm', composerWell, fileInput);

  // ---------------------------------------------------------------- Footer: tokens and context window
  const footTokens = h('span.chat-foot-tokens');
  const ctxNext = h('span.ctx-next', { 'data-action': 'preflight' });
  const ctxFill = h('span.ctx-fill');
  const ctxText = h('span.ctx-text');
  const foot = h('button.chat-foot.mono', { type: 'button', 'data-action': 'usage-foot', title: tr('Token usage of this chat'), onclick: (e: MouseEvent) => void openUsage(e.currentTarget as HTMLElement) }, footTokens, ctxNext, h('span.ctx-bar', { 'aria-hidden': 'true' }, ctxFill), ctxText);

  // ---------------------------------------------------------------- History drawer
  const histSearch = h<'input'>('input.input.hist-search', { type: 'search', placeholder: tr('Search chats'), 'aria-label': tr('Search chats') });
  let scope: 'project' | 'all' = 'project';
  const scopeBtns = (['project', 'all'] as const).map((s) =>
    h('button.seg-btn', { type: 'button', 'data-scope': s, 'aria-pressed': String(s === scope), onclick: () => ((scope = s), void renderHistory()) }, s === 'project' ? tr('This project') : tr('All projects'))
  );
  const histList = h('div.hist-list', { role: 'list', 'aria-label': tr('Recent chats') });
  const themeBtn = h<'button'>('button.btn.ghost.hist-theme', { type: 'button', 'data-action': 'theme', onclick: () => prefs.set('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') });
  const drawer = h(
    'aside.chat-history',
    { 'aria-label': tr('Chat history') },
    h('div.hist-head', h('p.eyebrow', tr('Chats')), h('span.spacer'), btn('close', tr('Close the history'), () => toggleDrawer(false), { 'data-action': 'history-close' })),
    h('button.btn.primary.hist-new', { type: 'button', 'data-action': 'new-chat', onclick: () => void startNew(), html: icon('plus', { size: 15 }) + `<span>${tr('New chat')}</span>` }),
    histSearch,
    h('div.seg.hist-scope', { role: 'group', 'aria-label': tr('Which chats') }, scopeBtns),
    histList,
    h('div.hist-foot', themeBtn, h('button.btn.ghost.danger.hist-clear', { type: 'button', 'data-action': 'clear-history', onclick: () => void clearHistory(), html: icon('trash', { size: 14 }) + `<span>${tr('Clear history')}</span>` }))
  );
  const scrim = h('div.chat-scrim', { onclick: () => toggleDrawer(false) });

  const main = h('div.chat-main', head, searchBar, bannerHost, list, h('div.chat-dock', composer, foot));
  const root = h('div.chat', drawer, scrim, main, scanInput);
  el.append(root);
  const detachMentions = attachMentions(ta, composer);
  // Scribble stays on here: handwriting with the Apple Pencil becomes text
  allowScribble(ta);
  allowScribble(searchInput);
  allowScribble(histSearch);
  ta.setAttribute('enterkeyhint', 'send');
  searchInput.setAttribute('enterkeyhint', 'search');

  // ---------------------------------------------------------------- Views
  function paintView() {
    const full = workspace.fullChat;
    root.classList.toggle('is-full', full);
    fullBtn.innerHTML = icon(full ? 'collapse' : 'expand', { size: 16 });
    const label = full ? tr('Back to the sidebar') : tr('Full Chat Mode ({key} ⇧ J)', { key: modKey });
    fullBtn.title = label;
    fullBtn.setAttribute('aria-label', label);
    fullBtn.setAttribute('aria-pressed', String(full));
    setDrawer(readFlag(DRAWER_KEY(full), full), false);
  }
  function setDrawer(open: boolean, remember = true) {
    root.dataset.history = open ? 'open' : 'closed';
    historyBtn.setAttribute('aria-expanded', String(open));
    if (remember) writeFlag(DRAWER_KEY(workspace.fullChat), open);
    if (open) void renderHistory();
  }
  function toggleDrawer(force?: boolean) {
    setDrawer(force ?? root.dataset.history !== 'open');
  }
  function paintTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.innerHTML = icon(dark ? 'sun' : 'moon', { size: 14 }) + `<span>${dark ? tr('Light paper') : tr('Dark paper')}</span>`;
  }

  function moreMenu(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const side = prefs.get('chatSide');
    const floating = !!workspace.panel(ctx.id)?.pip;
    menu(
      [
        { heading: tr('View') },
        { label: tr('Full Chat Mode'), icon: 'expand', checked: workspace.fullChat, hint: `${modKey} ⇧ J`, run: () => workspace.setFullChat() },
        { label: tr('Floating window'), icon: 'pip', checked: floating, run: () => workspace.togglePip(ctx.id) },
        ...(nativePipSupported() ? [{ label: tr('Pop out into its own window'), icon: 'external', checked: nativePipOpen(), run: () => void popOutChat() }] : []),
        '-',
        { heading: tr('Dock the sidebar') },
        { label: tr('Left'), icon: 'sidebar', checked: side === 'left', run: () => prefs.set('chatSide', 'left') },
        { label: tr('Right'), icon: 'sidebar', checked: side === 'right', run: () => prefs.set('chatSide', 'right') },
        '-',
        { label: tr('Chat history'), icon: 'clock', run: () => toggleDrawer(true) },
        { label: tr('Export chat'), icon: 'download', run: () => exportMenu(anchor) },
        { label: tr('Token usage'), icon: 'trend', run: () => void openUsage(anchor) },
        { label: tr('Clear chat'), icon: 'trash', danger: true, run: () => void clearChat() },
      ],
      r.right,
      r.bottom + 4,
      { alignRight: true }
    );
  }

  async function popOutChat() {
    const panel = panelEl();
    if (!panel) return;
    if (nativePipOpen()) return closeNativePip();
    if (workspace.fullChat) workspace.setFullChat(false);
    if (workspace.panel(ctx.id)?.pip) workspace.togglePip(ctx.id, false);
    const ok = await popOut(panel, {
      width: 440,
      height: 680,
      title: tr('OpenCraft AI chat'),
      onReturn: () => {
        workspace.show(ctx.id);
        requestAnimationFrame(() => ta.focus({ preventScroll: true }));
      },
    }).catch((e) => (notifyError(e), false));
    if (ok) workspace.hide(ctx.id);
  }

  // ---------------------------------------------------------------- Provider and badges
  async function paintProvider(force = false) {
    let st;
    try {
      st = await aiConfig.status(force);
    } catch (e) {
      statusPill.textContent = tr('Backend offline');
      statusPill.dataset.state = 'error';
      return void e;
    }
    const chosen = prefs.get('chatProvider');
    providerSel.replaceChildren(
      h('option', { value: '' }, tr('Default')),
      ...st.providers.map((p) => h('option', { value: p.id, disabled: (!p.configured && !p.local) || !!p.blocked, selected: chosen === p.id }, `${p.name}${p.local ? ` (${tr('local')})` : ''}${p.blocked ? ` (${tr('blocked, local-only')})` : !p.configured && !p.local ? ` (${tr('key missing')})` : ''}`))
    );
    localBadge.hidden = !st.localOnly;
    localBadge.innerHTML = icon('lock', { size: 12 }) + `<span>${tr('Local only')}</span>`;
    paintPersonas();
    if (!chosen) providerSel.value = '';
    const picked = chosen ? st.providers.find((p) => p.id === chosen) : null;
    const pName = picked ? picked.name : tr('Default');
    const isLocal = picked ? picked.local : !!st.active?.local;
    providerBtn.innerHTML =
      icon(isLocal ? 'cpu' : 'spark', { size: 14 }) +
      `<span class="chat-select-name">${esc(pName)}</span>` +
      icon('chevronDown', { size: 12 });
    providerBtn.title = picked
      ? `${tr('AI model')}: ${picked.name}${picked.local ? ` (${tr('local')})` : ''}`
      : `${tr('AI model')}: ${tr('Default')}${st.active ? ` (${st.active.name})` : ''}`;
    paintModelChip();

    if (st.active) {
      statusPill.dataset.state = st.active.local ? 'local' : 'ok';
      const tgt = chatTarget(chosen);
      const eff = effortFor(tgt?.id);
      const ds = eff ? ` · ${EFFORT_LABEL[eff]}` : tgt?.deepseek ? ` · ${tr(presetOf(aiConfig.config?.ai.deepseek?.preset).name)}` : '';
      statusPill.textContent = (picked && picked.id !== st.active.id ? picked.name : `${st.active.name} · ${st.active.model}`) + ds;
      statusPill.title = st.active.local ? tr('Local model, no data leaves the computer') : tr('Cloud model through the local backend');
      bannerHost.replaceChildren();
    } else {
      statusPill.dataset.state = 'error';
      statusPill.textContent = tr('no model');
      bannerHost.replaceChildren();
      banner(bannerHost, { ...explain(Object.assign(new Error(st.error || tr('No AI model set up')), { code: 'NO_PROVIDER' })), timeout: 0 });
    }
  }
  function paintPersonas() {
    const pc = aiConfig.config?.personal;
    if (!pc) return void aiConfig.get().then(() => aiConfig.config?.personal && paintPersonas()).catch(() => {});
    personaSel.replaceChildren(...pc.personas.map((p) => h('option', { value: p.id, selected: p.id === pc.active }, p.id === 'default' ? tr('No persona') : p.name)));
    personaSel.dataset.active = pc.active;
    const activePersona = pc.personas.find((p) => p.id === pc.active);
    const isDefault = !activePersona || activePersona.id === 'default';
    const pName = isDefault ? tr('No persona') : activePersona.name;
    personaBtn.classList.toggle('has-persona', !isDefault);
    personaBtn.innerHTML =
      icon(isDefault ? 'spark' : 'user', { size: 14 }) +
      `<span class="chat-select-name">${esc(pName)}</span>` +
      icon('chevronDown', { size: 12 });
    personaBtn.title = isDefault
      ? `${tr('Persona')}: ${tr('No persona')} (${tr('Default assistant')})`
      : `${tr('Persona')}: ${activePersona.name}${activePersona.prompt ? ` — ${activePersona.prompt.slice(0, 80)}` : ''}`;
  }
  personaSel.onchange = async () => {
    try {
      await aiConfig.put('personal', { active: personaSel.value });
      paintPersonas();
      const p = aiConfig.config?.personal.personas.find((x) => x.id === personaSel.value);
      toast(p && p.id !== 'default' ? tr('Persona: {name}', { name: p.name }) : tr('No persona'), 'info');
    } catch (e) {
      notifyError(e);
    }
  };
  providerSel.onchange = () => {
    prefs.set('chatProvider', providerSel.value);
    void paintProvider();
  };
  statusPill.onclick = () => bus.emit('open-settings', 'ai');

  function openPersonaMenu(anchor: HTMLElement) {
    const pc = aiConfig.config?.personal;
    if (!pc) return;
    const r = anchor.getBoundingClientRect();
    const currentActive = pc.active || 'default';
    const items: Parameters<typeof menu>[0] = [
      { heading: tr('AI Assistant & Persona') },
    ];
    for (const p of pc.personas) {
      const isDefault = p.id === 'default';
      const isCurrent = p.id === currentActive;
      const label = isDefault ? tr('No persona') : p.name;
      const hint = isDefault
        ? tr('Default assistant')
        : p.prompt
        ? (p.prompt.length > 24 ? p.prompt.slice(0, 22).trim() + '…' : p.prompt)
        : `/persona ${p.id}`;
      items.push({
        label,
        icon: isDefault ? 'spark' : 'user',
        checked: isCurrent,
        hint,
        run: () => {
          if (personaSel.value !== p.id) {
            personaSel.value = p.id;
            personaSel.dispatchEvent(new Event('change'));
          }
        },
      });
    }
    items.push(
      '-',
      {
        label: tr('Manage personas…'),
        icon: 'settings',
        run: () => bus.emit('open-settings', 'personal'),
      }
    );
    menu(items, r.left, r.bottom + 6);
  }

  async function openProviderMenu(anchor: HTMLElement) {
    let st;
    try {
      st = await aiConfig.status();
    } catch (e) {
      return void notifyError(e);
    }
    const chosen = prefs.get('chatProvider') || '';
    const r = anchor.getBoundingClientRect();
    const items: Parameters<typeof menu>[0] = [
      { heading: tr('AI Model & Provider') },
      {
        label: tr('Default'),
        icon: 'spark',
        checked: chosen === '',
        hint: st.active ? st.active.name : '',
        run: () => {
          if (providerSel.value !== '') {
            providerSel.value = '';
            providerSel.dispatchEvent(new Event('change'));
          }
        },
      },
      '-',
    ];
    for (const p of st.providers) {
      const isCurrent = chosen === p.id;
      const disabled = (!p.configured && !p.local) || !!p.blocked;
      let hint = p.local ? tr('local') : 'cloud';
      if (p.blocked) hint = tr('blocked');
      else if (!p.configured && !p.local) hint = tr('key missing');
      items.push({
        label: p.name,
        icon: p.local ? 'cpu' : 'spark',
        checked: isCurrent,
        hint,
        danger: !!p.blocked,
        run: () => {
          if (disabled) {
            if (p.blocked) {
              toast(tr('Cloud providers are blocked in local-only mode'), 'warning');
            } else {
              toast(tr('API key missing for {name}', { name: p.name }), 'warning');
              bus.emit('open-settings', 'ai');
            }
            return;
          }
          if (providerSel.value !== p.id) {
            providerSel.value = p.id;
            providerSel.dispatchEvent(new Event('change'));
          }
        },
      });
    }
    const target = chatTarget(chosen);
    const efforts = effortItems();
    if (efforts.length) items.push('-', ...efforts);
    if (target?.deepseek) {
      const current = aiConfig.config?.ai.deepseek?.preset || 'reasoning';
      items.push('-', { heading: tr('DeepSeek mode') });
      for (const p of DEEPSEEK_PRESETS) {
        items.push({ label: tr(p.name), icon: p.thinking ? 'spark' : p.id === 'coding' ? 'code' : 'chat', checked: current === p.id, hint: p.thinking ? (p.effort === 'max' ? 'effort max' : 'effort high') : `t ${p.temperature ?? 1}`, run: () => void setDeepSeekPreset(p.id) });
      }
    }
    items.push(
      '-',
      {
        label: tr('Model settings…'),
        icon: 'settings',
        run: () => bus.emit('open-settings', 'ai'),
      }
    );
    menu(items, r.left, r.bottom + 6);
  }

  async function setDeepSeekPreset(id: DeepSeekPresetId) {
    try {
      const cur = aiConfig.config?.ai.deepseek;
      // A new preset starts from its own limits; overrides belong to the preset they were set for
      await aiConfig.put('deepseek', cur?.preset === id ? cur : { preset: id });
      toast(tr('DeepSeek mode: {name}', { name: tr(presetOf(id).name) }), 'info', tr(presetOf(id).hint));
      void paintProvider();
    } catch (e) {
      notifyError(e);
    }
  }

  // ---------------------------------------------------------------- Reasoning bar (provider and effort)
  const EFFORT_LABEL: Record<Effort | 'auto', string> = { auto: tr('Auto'), off: tr('Off'), low: tr('Low'), medium: tr('Medium'), high: tr('High'), max: tr('Max') };
  const targetNow = () => chatTarget(prefs.get('chatProvider'));
  /** Effort chosen for a provider, undefined for Auto (provider default, DeepSeek preset). */
  function effortFor(id: string | undefined): Effort | undefined {
    const e = id ? (prefs.get('effort') || {})[id] : undefined;
    return e && e !== 'auto' ? e : undefined;
  }
  function setEffort(id: string, e: Effort | 'auto') {
    prefs.set('effort', { ...(prefs.get('effort') || {}), [id]: e });
    paintModelChip();
    void paintProvider();
    runPreflight();
  }
  /** Menu entries of the effort levels the current provider and model support. */
  function effortItems(): Parameters<typeof menu>[0] {
    const t = targetNow();
    if (!t) return [];
    const choices = effortChoices(t.family, t.model);
    const cur = (prefs.get('effort') || {})[t.id] || 'auto';
    if (!choices.length) return [{ heading: tr('Reasoning') }, { label: tr('No thinking controls for {model}', { model: esc(t.model || t.name) }), icon: 'cpu', run: () => {} }];
    return [
      { heading: tr('Reasoning effort') },
      { label: EFFORT_LABEL.auto, icon: 'spark', checked: cur === 'auto', hint: t.deepseek ? tr('preset') : tr('default'), run: () => setEffort(t.id, 'auto') },
      ...choices.map((c) => ({ label: EFFORT_LABEL[c.id], icon: c.id === 'off' ? 'cpu' : 'spark', checked: cur === c.id, hint: c.wire, run: () => setEffort(t.id, c.id) })),
    ];
  }
  /** Prompt-bar chip: "Claude · High". */
  function paintModelChip() {
    const t = targetNow();
    const e = t ? (prefs.get('effort') || {})[t.id] || 'auto' : 'auto';
    const supports = t ? effortChoices(t.family, t.model).length > 0 : false;
    modelChip.innerHTML = icon(t?.local ? 'cpu' : 'spark', { size: 13 }) + `<span class="chip-provider">${esc(t?.name || tr('Default'))}</span>` + (supports ? `<span class="chip-sep">·</span><span class="chip-effort" data-effort="${e}">${esc(EFFORT_LABEL[e])}</span>` : '') + icon('chevronDown', { size: 11 });
    modelChip.title = t ? `${t.name} · ${t.model}${supports ? ` · ${tr('Reasoning effort')}: ${EFFORT_LABEL[e]}` : ''}` : tr('AI model for this chat');
    modelChip.dataset.provider = t?.id || '';
    modelChip.dataset.effort = e;
  }
  /** One menu for the prompt bar: providers, then the effort levels of the chosen one. */
  async function openModelMenu(anchor: HTMLElement) {
    let st;
    try {
      st = await aiConfig.status();
    } catch (e) {
      return void notifyError(e);
    }
    const chosen = prefs.get('chatProvider') || '';
    const r = anchor.getBoundingClientRect();
    const pick = (id: string) => {
      if (providerSel.value !== id) {
        providerSel.value = id;
        providerSel.dispatchEvent(new Event('change'));
      }
      paintModelChip();
    };
    const items: Parameters<typeof menu>[0] = [
      { heading: tr('AI Model & Provider') },
      { label: tr('Default'), icon: 'spark', checked: chosen === '', hint: st.active ? esc(st.active.name) : '', run: () => pick('') },
      ...st.providers.map((p) => ({
        label: esc(p.name),
        icon: p.local ? 'cpu' : 'spark',
        checked: chosen === p.id,
        hint: p.blocked ? tr('blocked') : !p.configured && !p.local ? tr('key missing') : p.local ? tr('local') : 'cloud',
        run: () => {
          if ((!p.configured && !p.local) || p.blocked) return void toast(p.blocked ? tr('Cloud providers are blocked in local-only mode') : tr('API key missing for {name}', { name: p.name }), 'warning');
          pick(p.id);
        },
      })),
      '-',
      ...effortItems(),
    ];
    menu(items, r.left, r.top - 8 - Math.min(420, items.length * 34));
  }

  function paintMcp() {
    const ready = orchestrator.ready;
    const n = ready ? orchestrator.tools().length : 0;
    mcpBadge.textContent = ready ? `MCP · ${n}` : 'MCP …';
    mcpBadge.dataset.state = ready ? (n ? 'ok' : 'error') : 'wait';
    mcpBadge.title = ready ? tr('{n} MCP tools ready for the AI', { n }) : tr('Connecting to the MCP tools');
  }
  function paintLatency(ms?: number, model?: string) {
    if (ms === undefined) return;
    latencyBadge.textContent = `${ms} ms`;
    latencyBadge.dataset.state = ms < 1200 ? 'ok' : ms < 4000 ? 'wait' : 'error';
    latencyBadge.title = tr('First token after {ms} ms ({model})', { ms, model: model || '' });
  }

  // ---------------------------------------------------------------- Team Mode: switch and roster
  function setMode(m: 'single' | 'team') {
    if (prefs.get('chatMode') !== m) prefs.set('chatMode', m);
    paintMode();
    if (m === 'team') toast(tr('Team Mode on'), 'info', tr('{name}: the Team Leader plans, {n} specialists work in parallel.', { name: tr(teamStore.current.name), n: enabledWorkers(teamStore.current).length }));
  }
  function paintMode() {
    const m = prefs.get('chatMode');
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    root.dataset.mode = m;
    const cfg = teamStore.current;
    const on = enabledWorkers(cfg);
    rosterBtn.innerHTML = icon('users', { size: 12 }) + `<span>${esc(tr(cfg.name))}</span>` + `<span class="chat-roster-dots" aria-hidden="true">${on.map((r) => `<i style="--agent:${ROLE_DEFS[r].accent}"></i>`).join('')}</span>`;
    rosterBtn.hidden = m !== 'team';
    ta.placeholder = m === 'team' ? tr('Message the AI team (@team, @word-agent …)') : tr('Message the AI');
  }
  async function rosterProviders() {
    try {
      return (await aiConfig.status()).providers;
    } catch {
      return [];
    }
  }
  /** Team configuration as a popover under the header button. */
  async function openRoster(anchor: HTMLElement) {
    if (!aiConfig.config) await aiConfig.get().catch(() => null);
    const body = h('div.team-pop', h('p.eyebrow', tr('Team configuration')), teamEditor({ providers: await rosterProviders(), compact: true, onChange: () => paintMode() }), h('button.btn.ghost.sm', { type: 'button', 'data-action': 'team-settings', onclick: () => (close(), bus.emit('open-settings', 'team')), html: icon('settings', { size: 14 }) + `<span>${tr('Team in the settings')}</span>` }));
    const close = popover(anchor, body, { width: 560, label: tr('Team configuration') });
  }
  /** /roster: the team configuration as a modal. */
  async function openRosterModal() {
    if (!aiConfig.config) await aiConfig.get().catch(() => null);
    await dialog({ title: tr('Team configuration'), tone: tr('leader and specialists'), wide: true, body: teamEditor({ providers: await rosterProviders(), onChange: () => paintMode() }), ok: tr('Done'), cancel: tr('Close') });
    paintMode();
  }

  // ---------------------------------------------------------------- Pre-flight: count the next request before Send
  interface Preflight {
    total: number;
    window: number;
    exact: boolean;
    /** deepseek-v4, o200k_base, cl100k_base, count_tokens (Claude), countTokens (Gemini) or estimate */
    method: string;
    model: string;
    actions: string[];
    overflow: boolean;
    parts: { system: number; tools: number; context: number; history: number; images: number; calib: number };
  }
  let preflight: Preflight | null = null;
  const attCache = new Map<string, { at: number; atts: Attachment[] }>();
  /** Attachments of the draft, cached a few seconds (the file contents come from the backend). */
  async function draftAttachments(text: string): Promise<Attachment[]> {
    const refs = findMentions(text);
    if (!refs.length) return [];
    const key = refs.join('\n');
    const hit = attCache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.atts;
    const atts = await resolveMentions(refs.map((r) => '@' + r).join(' '));
    attCache.set(key, { at: Date.now(), atts });
    if (attCache.size > 20) attCache.delete(attCache.keys().next().value!);
    return atts;
  }
  let preflightSeq = 0;
  /**
   * Counts the whole next request: system prompt, MCP tool schemas, project context, history, the draft
   * and its @-attachments. DeepSeek: exact with the V4 tokenizer, calibrated with the prompt_tokens of
   * the last answer; other providers: estimate. Shows whether the backend will have to shorten it.
   */
  async function computePreflight() {
    const seq = ++preflightSeq;
    const target = chatTarget(prefs.get('chatProvider'));
    const model = target?.model || chat.usage?.model || '';
    let tok = target?.deepseek ? tokenizerNow() : null;
    if (target?.deepseek && !tok) tok = await loadTokenizer().catch(() => null);
    const atts = await draftAttachments(ta.value).catch((): Attachment[] => []);
    if (seq !== preflightSeq) return;
    const req = agent.preview(ta.value, atts);
    const count = tok ? (s: string) => tok!.count(s) : null;
    let c = countRequest(req, count);
    let method = c.exact ? 'deepseek-v4' : 'estimate';
    // Other providers: the backend counts with their tokenizer (OpenAI o200k / cl100k) or, when allowed,
    // asks Claude or Gemini for the exact number
    if (target && !target.deepseek && !backend.browser) {
      try {
        const r = await api.send<{ request?: typeof c; method: string }>('POST', '/api/ai/count', { provider: target.id, model: target.model, effort: effortFor(target.id), remote: prefs.get('remoteCount') && (target.family === 'anthropic' || target.family === 'gemini'), request: { system: req.system, context: req.context, turns: req.turns, tools: req.tools } });
        if (seq !== preflightSeq) return;
        if (r.request) {
          c = r.request;
          method = r.method;
        }
      } catch {
        /* estimate stays */
      }
    }
    const calib = chat.calib && model && chat.calib.model === resolveModel(model) && method !== 'count_tokens' && method !== 'countTokens' ? chat.calib.offset : 0;
    const window = contextWindow(model);
    const reserve = target?.deepseek ? (resolveDeepSeekParams(aiConfig.config?.ai.deepseek || { preset: 'reasoning' }, { model }).params.maxTokens ?? 8192) : 8192;
    const fit = fitRequest({ ...req, toolChoice: 'auto' }, { window, reserve, count });
    preflight = { total: Math.max(0, c.total + calib), window, exact: c.exact, method, model, actions: fit.report.actions, overflow: fit.overflow, parts: { system: c.system, tools: c.tools, context: c.context, history: c.history, images: c.images, calib } };
    paintUsage();
  }
  const METHOD_LABEL: Record<string, string> = {
    'deepseek-v4': tr('counted with the DeepSeek V4 tokenizer'),
    o200k_base: tr('counted with the OpenAI o200k_base tokenizer'),
    cl100k_base: tr('counted with the OpenAI cl100k_base tokenizer'),
    count_tokens: tr('counted by Claude (count_tokens)'),
    countTokens: tr('counted by Gemini (countTokens)'),
    estimate: tr('estimated from the characters'),
  };
  const resolveModel = (m: string) => (m === 'deepseek-chat' || m === 'deepseek-reasoner' ? 'deepseek-flash' : m);
  const runPreflight = debounce(() => void computePreflight().catch(() => {}), 350);

  // ---------------------------------------------------------------- Usage: footer and card
  function paintUsage() {
    const u = chat.usage;
    const win = preflight?.window ?? contextWindow(u?.model || aiConfig.cached?.active?.model);
    const used = preflight ? preflight.total : u?.context || 0;
    const pct = Math.min(100, (used / win) * 100);
    footTokens.textContent = u ? `↑ ${compactTokens(u.input)}  ↓ ${compactTokens(u.output)}${u.cached ? `  ⟲ ${percent(cacheHitRatio(u))}` : ''}` : tr('0 tokens');
    ctxNext.textContent = preflight ? `${preflight.exact ? '' : '≈ '}${compactTokens(preflight.total)}` : '';
    ctxFill.style.width = `${pct.toFixed(1)}%`;
    ctxFill.dataset.level = preflight?.overflow || pct > 85 ? 'high' : pct > 60 || preflight?.actions.length ? 'mid' : 'low';
    ctxText.textContent = `${pct > 0 && pct < 0.1 ? '<0.1' : pct.toFixed(1)}% · ${compactTokens(win)}`;
    foot.dataset.state = preflight?.overflow ? 'over' : preflight?.actions.length ? 'fit' : '';
    const lines = [tr('Token usage of this chat: input {i}, output {o}, cached {c}, {n} requests.', { i: u?.input || 0, o: u?.output || 0, c: u?.cached || 0, n: u?.requests || 0 })];
    if (preflight) {
      const p = preflight.parts;
      lines.push(
        tr('Next request: {n} of {win} tokens ({pct}%), {how}.', { n: preflight.total.toLocaleString(locale()), win: compactTokens(win), pct: pct.toFixed(2), how: METHOD_LABEL[preflight.method] || tr('estimated from the characters') }),
        tr('System {s} · tools {t} · project {c} · history and draft {h}{img}{cal}', { s: p.system, t: p.tools, c: p.context, h: p.history, img: p.images ? ` · ${tr('images')} ${p.images}` : '', cal: p.calib ? ` · ${tr('calibration')} ${p.calib > 0 ? '+' : ''}${p.calib}` : '' })
      );
      if (preflight.overflow) lines.push(tr('Too large even after shortening: remove attachments or shorten the message.'));
      else if (preflight.actions.length) lines.push(tr('Before sending, the backend fits it into the window: {list}', { list: preflight.actions.join('; ') }));
    }
    foot.title = lines.join('\n');
  }

  /** Usage per team role over every team answer of the chat (null without Team Mode answers). */
  function teamUsageOf(c: ChatRecord): Record<string, RoleUsage> | null {
    const out: Record<string, RoleUsage> = {};
    for (const m of c.messages) {
      for (const r of Object.values(m.team?.state.usage || {})) {
        const o = (out[r.role] ||= { ...r, requests: 0, input: 0, output: 0, cached: 0, estimated: 0, firstMs: 0, totalMs: 0, toolCalls: 0, toolOk: 0, toolMs: 0 });
        for (const k of ['requests', 'input', 'output', 'cached', 'estimated', 'firstMs', 'totalMs', 'toolCalls', 'toolOk', 'toolMs', 'cacheWrite', 'reasoning'] as const) o[k] = (o[k] || 0) + (r[k] || 0);
        o.model = r.model;
        o.provider = r.provider;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  async function openUsage(anchor: HTMLElement) {
    const u = chat.usage;
    const kpi = (label: string, value: string, extra: Record<string, string> = {}) => h('div', extra, h('span.muted', label), h('strong', value));
    const savings = h('strong', '…');
    const body = h(
      'div.usage-pop',
      h('p.eyebrow', tr('This chat')),
      h(
        'div.usage-kpis.mono',
        kpi(tr('Input'), compactTokens(u?.input || 0)),
        kpi(tr('Output'), compactTokens(u?.output || 0)),
        kpi(tr('Cached'), compactTokens(u?.cached || 0)),
        kpi(tr('Requests'), String(u?.requests || 0))
      ),
      h(
        'div.usage-kpis.usage-cache.mono',
        kpi(tr('Cache hit'), u?.input ? percent(cacheHitRatio(u)) : '–', { 'data-kpi': 'hit-ratio', title: tr('Share of the input served from the provider cache (DeepSeek prompt_cache_hit_tokens)') }),
        kpi(tr('Cache miss'), u?.cacheMiss !== undefined ? compactTokens(u.cacheMiss) : '–', { 'data-kpi': 'miss', title: tr('Input tokens billed at the full rate (prompt_cache_miss_tokens)') }),
        kpi(tr('Thinking'), u?.reasoning !== undefined ? compactTokens(u.reasoning) : '–', { 'data-kpi': 'reasoning', title: tr('Output tokens spent on the chain of thought (reasoning_tokens)') }),
        h('div', { 'data-kpi': 'savings', title: tr('Cache hits billed at the cached rate instead of the input rate (rates in the settings)') }, h('span.muted', tr('Savings')), savings)
      ),
      preflight ? h('p.usage-next.mono.muted', tr('Next request: {n} tokens, {pct}% of {win}', { n: preflight.total.toLocaleString(locale()), pct: ((preflight.total / preflight.window) * 100).toFixed(2), win: compactTokens(preflight.window) })) : null,
      teamUsageOf(chat) ? h('p.eyebrow', tr('This chat, per team role')) : null,
      teamUsageOf(chat) ? h('div.usage-team-slot') : null,
      h('p.eyebrow', tr('All chats, by provider')),
      h('div.usage-providers', h('p.muted', tr('Loading'))),
      h('p.eyebrow', tr('All chats, by model')),
      h('div.usage-slot', h('p.muted', tr('Loading')))
    );
    const close = popover(anchor, body, { width: 440, label: tr('Token usage') });
    try {
      const store = await telemetry.get();
      const rated = u?.model ? store.rates[u.model] : undefined;
      savings.textContent = u && rated?.cached !== undefined ? money(cacheSavings({ local: false, model: u.model!, cached: u.cached }, store.rates)) : '–';
      if (!rated?.cached) savings.title = tr('Set an input and a cached input rate for {model} in the settings', { model: u?.model || '' });
      body.querySelector('.usage-providers')!.replaceChildren(providerTable(store, { compact: true }));
      const tu = teamUsageOf(chat);
      if (tu) body.querySelector('.usage-team-slot')?.replaceChildren(roleUsageTable(tu, store.rates));
      body.querySelector('.usage-slot')!.replaceChildren(usageTable(store, { compact: true, limit: 6 }));
    } catch (e) {
      body.querySelector('.usage-slot')!.replaceChildren(h('p.muted', (e as Error).message));
    }
    body.append(h('button.btn.ghost', { type: 'button', 'data-action': 'usage-settings', onclick: () => (close(), bus.emit('open-settings', 'usage')), html: icon('settings', { size: 14 }) + `<span>${tr('Usage and rates in the settings')}</span>` }));
  }

  // ---------------------------------------------------------------- Messages
  let stick = true;
  list.addEventListener('scroll', () => (stick = list.scrollHeight - list.scrollTop - list.clientHeight < 60), { passive: true });
  const scrollDown = () => {
    if (stick) list.scrollTop = list.scrollHeight;
  };

  function renderEmpty() {
    list.replaceChildren(
      h(
        'div.chat-empty.chat-welcome',
        h('p.eyebrow', tr('AI assistant')),
        h('h2.duo', tr('How can I help') + ' ', h('span.tone', tr('with your project?'))),
        h('p.muted', tr('Mention files and apps with @, pick tools with /, attach files with the clip. The AI works on the project files through MCP and the apps show the changes right away.')),
        h(
          'div.welcome-cards',
          suggestions().map((s) =>
            h(
              'button.welcome-card.frame.sm',
              { type: 'button', style: `--tool:${APP_ACCENT[s.app]}`, 'data-app': s.app, onclick: () => ((ta.value = s.prompt), autoGrow(), paintChips(), ta.focus()) },
              h('span.well.welcome-well', h('span.welcome-mark', { html: toolMark(s.app, 22) }), h('strong', s.title), h('span.muted', s.text))
            )
          )
        ),
        h('div.chat-examples', h('button.chat-example', { type: 'button', onclick: () => ((ta.value = '/help'), autoGrow(), ta.focus()) }, h('span', { html: icon('slash', { size: 14 }) }), h('span.mono', tr('/help lists every tool and command'))))
      )
    );
  }

  function renderAll() {
    views.clear();
    list.replaceChildren();
    preflight = null;
    paintUsage();
    runPreflight();
    if (!chat.messages.length) return renderEmpty();
    for (const m of chat.messages) if (m.team && !team?.running) settleSaved(m.team.state);
    for (const m of chat.messages) renderMessage(m, true);
    list.scrollTop = list.scrollHeight;
  }

  /** Copy buttons on code blocks (added once per block). */
  function decorateCode(scopeEl: HTMLElement) {
    for (const pre of scopeEl.querySelectorAll('pre')) {
      if (pre.querySelector('.code-copy')) continue;
      const b = h('button.code-copy.mono', { type: 'button', title: tr('Copy code'), 'aria-label': tr('Copy code'), html: icon('copy', { size: 13 }) + `<span>${tr('Copy')}</span>` });
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent || '');
          b.dataset.done = '1';
          b.lastElementChild!.textContent = tr('Copied');
          setTimeout(() => ((b.dataset.done = ''), (b.lastElementChild!.textContent = tr('Copy'))), 1400);
        } catch {
          toast(tr('Copying is not allowed here'), 'warning');
        }
      };
      pre.append(b);
    }
  }

  function renderMessage(m: ChatMessage, finalRender = false) {
    list.querySelector('.chat-empty')?.remove();
    let v = views.get(m.id);
    if (!v) {
      const body = h('div.msg-body.md');
      const steps = h('div.msg-steps');
      const meta = h('div.msg-meta.mono');
      const el = h('article.msg', { 'data-role': m.role, 'data-id': m.id }, m.role === 'assistant' ? steps : null, body, meta);
      list.append(el);
      v = { el, body, steps, meta, cards: new Map() };
      views.set(m.id, v);
    }
    if (m.role === 'user') {
      v.body.innerHTML = esc(m.text).replace(/(^|\s)([@/][^\s]+)/g, '$1<span class="mention mono">$2</span>').replace(/\n/g, '<br>');
      if (m.images?.length) v.body.prepend(h('div.msg-images', m.images.map((src) => h('img', { src, alt: tr('Attached image'), loading: 'lazy' }))));
      v.meta.replaceChildren(...(m.attachments || []).map((a) => h('span.att-chip.mono', { 'data-kind': a.kind, title: a.path || a.label }, a.kind === 'missing' ? tr('{label} not found', { label: a.label }) : `${a.label}${a.chars ? ` · ${(a.chars / 1000).toFixed(1)}k` : ''}`)));
    } else {
      if (finalRender || m.done) {
        v.body.innerHTML = mdToHtml(m.text);
        decorateCode(v.body);
      } else {
        v.renderer ||= new StreamRenderer(v.body, scrollDown);
        v.renderer.set(m.text);
      }
      if (m.team) paintTeam(m);
      for (const th of m.thoughts || []) paintThought(m, th);
      for (const s of m.steps || []) paintStep(m, s);
      orderTimeline(m);
      paintMeta(m);
    }
    scrollDown();
  }

  /** Team Mission Control card of a team answer, above the leader's final text. */
  function paintTeam(m: ChatMessage) {
    const v = views.get(m.id);
    if (!v || !m.team) return;
    if (!v.mission) {
      v.mission = new MissionControl({
        stop: () => team.stop(),
        cancel: (id) => team.cancel(id),
        approve: (id, ok) => team.answer(id, ok),
        open: (path) => void workspace.openFile(path),
      });
      v.el.classList.add('has-team');
      v.steps.prepend(v.mission.el);
    }
    v.mission.update(m.team.state, m.team.threads, rates);
  }
  /** Team updates come from several streams at once: one paint per frame and message. */
  const teamPaints = new Map<string, ChatMessage>();
  let teamFrame = 0;
  function scheduleTeamPaint(m: ChatMessage) {
    teamPaints.set(m.id, m);
    if (teamFrame) return;
    teamFrame = requestAnimationFrame(() => {
      teamFrame = 0;
      const all = [...teamPaints.values()];
      teamPaints.clear();
      for (const x of all) {
        if (!views.get(x.id)) renderMessage(x);
        else {
          paintTeam(x);
          if (!x.done && x.text) {
            const v = views.get(x.id)!;
            v.renderer ||= new StreamRenderer(v.body, scrollDown);
            v.renderer.set(x.text);
          }
          paintMeta(x);
        }
      }
      scrollDown();
      paintSend();
    });
  }

  /**
   * "Thought process" card of one model round: DM Mono, live thinking time and token count, open while
   * the model thinks, collapsed once the answer or a tool call starts (unless the user opened it).
   */
  function paintThought(m: ChatMessage, th: Thought) {
    const v = views.get(m.id);
    if (!v) return;
    const key = `think-${th.round}`;
    let card = v.cards.get(key);
    if (!card) {
      card = h('details.thought.frame.sm', { 'data-round': String(th.round) });
      card.dataset.start = String(Date.now() - th.ms);
      card.addEventListener('toggle', () => {
        if (card!.dataset.auto !== '1') card!.dataset.pinned = '1';
        card!.dataset.auto = '';
      });
      card.append(
        h('summary.thought-head.mono', h('span.thought-dot', { 'aria-hidden': 'true' }), h('span.thought-title', tr('Thought process')), h('span.spacer'), h('span.thought-time'), h('span.thought-tokens')),
        h('div.well.thought-body.mono')
      );
      v.cards.set(key, card);
      v.steps.append(card);
      if (!th.done) setOpen(card, true);
    }
    card.dataset.state = th.done ? 'done' : 'thinking';
    card.querySelector('.thought-title')!.textContent = th.done ? tr('Thought process') : tr('Thinking');
    card.querySelector('.thought-time')!.textContent = `${(th.ms / 1000).toFixed(1)} s`;
    card.querySelector('.thought-tokens')!.textContent = tn(th.tokens, '{n} token', '{n} tokens', { n: `${th.exact ? '' : '≈ '}${th.tokens.toLocaleString(locale())}` });
    const body = card.querySelector<HTMLElement>('.thought-body')!;
    if (body.textContent !== th.text) {
      const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
      body.textContent = th.text;
      if (atEnd) body.scrollTop = body.scrollHeight;
    }
    if (th.done && card.dataset.pinned !== '1' && (card as HTMLDetailsElement).open) setOpen(card, false);
    if (th.done) card.dataset.start = '';
  }
  function setOpen(card: HTMLDetailsElement | HTMLElement, open: boolean) {
    const d = card as HTMLDetailsElement;
    if (d.open === open) return;
    d.dataset.auto = '1';
    d.open = open;
  }
  // Live thinking time between deltas
  const thinkTimer = setInterval(() => {
    tickTeamTimers(list);
    for (const card of list.querySelectorAll<HTMLElement>('.thought[data-state="thinking"]')) {
      const start = Number(card.dataset.start);
      if (start) card.querySelector('.thought-time')!.textContent = `${((Date.now() - start) / 1000).toFixed(1)} s`;
    }
  }, 100);

  /** Thought cards and tool steps in model order: per round the thinking first, then its tool calls. */
  function orderTimeline(m: ChatMessage) {
    const v = views.get(m.id);
    if (!v || !m.thoughts?.length) return;
    const items = [...m.thoughts.map((t) => ({ round: t.round, kind: 0, idx: 0, el: v.cards.get(`think-${t.round}`) })), ...(m.steps || []).map((s, idx) => ({ round: s.round ?? 0, kind: 1, idx, el: v.cards.get(s.id) }))].filter((x) => x.el).sort((a, b) => a.round - b.round || a.kind - b.kind || a.idx - b.idx);
    const want = items.map((x) => x.el!);
    const now = [...v.steps.children];
    if (want.length === now.length && want.every((el, i) => el === now[i])) return;
    for (const el of want) v.steps.append(el);
  }

  function paintMeta(m: ChatMessage) {
    const v = views.get(m.id);
    if (!v) return;
    v.el.classList.toggle('is-streaming', !m.done && !m.error);
    const parts: (Node | null)[] = [];
    if (m.model) parts.push(h('span', `${m.provider} · ${m.model}`));
    if (m.persona) parts.push(h('span.msg-persona', { title: tr('Persona') }, m.persona));
    if (m.memory) parts.push(h('span.msg-memory', { title: [tr('Project memory used'), ...m.memory.passages.map((x) => `${x.source} · ${x.loc}`)].join('\n') }, [tr('memory'), m.memory.notes ? tn(m.memory.notes, '{n} note', '{n} notes') : '', m.memory.passages.length ? tn(m.memory.passages.length, '{n} passage', '{n} passages') : ''].filter(Boolean).join(' · ')));
    if (m.direct) parts.push(h('span', tr('direct, without a language model')));
    if (m.team) parts.push(h('span.msg-team', { title: phaseLabel(m.team.state) }, teamMeta(m.team.state)));
    if (m.usage) {
      const gen = Math.max(1, m.usage.totalMs - m.usage.firstMs);
      const tps = m.usage.output / (gen / 1000);
      parts.push(
        h(
          'span.msg-usage',
          { title: [m.usage.estimated ? tr('Estimated: the provider sent no usage') : tr('Exact numbers from the provider'), m.usage.cached ? tr('Cache: {hit} hit, {miss} miss ({pct})', { hit: m.usage.cached, miss: m.usage.cacheMiss ?? m.usage.input - m.usage.cached, pct: percent(cacheHitRatio(m.usage)) }) : '', m.usage.reasoning ? tr('{n} thinking tokens', { n: m.usage.reasoning }) : ''].filter(Boolean).join('\n') },
          `${m.usage.estimated ? '≈ ' : ''}↑ ${compactTokens(m.usage.input)} ↓ ${compactTokens(m.usage.output)}${m.usage.cached ? ` ⟲ ${percent(cacheHitRatio(m.usage))}` : ''}`
        ),
        m.budget?.actions.length ? h('span.msg-budget', { title: m.budget.actions.join('\n') }, tr('context fitted')) : null,
        h('span', `${m.usage.firstMs} ms`),
        m.done && isFinite(tps) && m.usage.output > 0 ? h('span', `${tps.toFixed(1)} tok/s`) : null
      );
    }
    if (m.role === 'assistant' && m.done) {
      if (m.changed?.length) parts.push(
        m.undone
          ? h('span.msg-undone', tr('changes undone'))
          : h('button.btn.ghost.sm.msg-undo', { type: 'button', 'data-action': 'undo-answer', title: tr('Restore every file this answer changed: {list}', { list: m.changed.join(', ') }), onclick: () => void undoAnswer(m), html: icon('undo', { size: 13 }) + `<span>${tr('Undo changes')}</span>` })
      );
      if (m.text.trim()) parts.push(h('button.btn.ghost.sm.msg-pin', { type: 'button', 'data-action': 'pin-memory', title: tr('Keep a note from this answer in the project memory'), onclick: () => void pinToMemory(m), html: icon('pin', { size: 13 }) + `<span>${tr('Remember')}</span>` }));
    }
    v.meta.replaceChildren(...nodes(...parts));
    v.el.querySelector('.msg-error')?.remove();
    if (m.error) {
      const host = h('div.msg-error');
      v.el.append(host);
      const note = explain(Object.assign(new Error(m.error.message), { code: m.error.code }), () => void retryLast());
      banner(host, { ...note, timeout: 0 });
    }
  }

  /** Timeline card of a tool call: live parameters, duration and a preview of the result. */
  function paintStep(m: ChatMessage, s: AgentStep) {
    const v = views.get(m.id)!;
    let card = v.cards.get(s.id);
    const def = TOOL_BY_NAME.get(s.name);
    const accent = APP_ACCENT[(s.app as ToolApp) || 'workspace'] || '#335CFF';
    const path = def?.pathArg ? (s.args[def.pathArg] as string | undefined) : undefined;
    if (!card) {
      card = h('details.step.frame.sm', { style: `--tool:${accent}`, 'data-tool': s.name });
      v.cards.set(s.id, card);
      v.steps.append(card);
    }
    const open = card.hasAttribute('open') || s.status === 'waiting' || s.status === 'error';
    const elapsed = s.result ? `${s.result.ms} ms` : s.started ? `${((Date.now() - s.started) / 1000).toFixed(1)} s` : '';
    const preview = s.result?.ok ? s.result.text.split('\n').find((l) => l.trim())?.slice(0, 120) : s.progress.at(-1);
    const summary = h(
      'summary.step-head',
      h('span.step-mark', { html: ['wordcraft', 'gridcraft', 'deckcraft', 'pdfcraft'].includes(s.app) ? toolMark(s.app, 16) : icon('bolt', { size: 14 }) }),
      h('span.step-name.mono', s.name),
      path ? h('span.step-path.mono', path) : null,
      h('span.spacer'),
      h('span.step-state.mono', STATUS_LABEL[s.status] + (s.corrected ? ` · ${tr('self-correction')}` : s.repaired?.length ? ` · ${tr('repaired')}` : '') + (s.attempts > 1 ? ` · ${tr('attempt {n}', { n: s.attempts })}` : '')),
      elapsed ? h('span.step-time.mono', elapsed) : null
    );
    const body = h('div.well.step-body.mono');
    if (s.progress.length) body.append(h('ol.step-progress', s.progress.slice(-8).map((p) => h('li', p))));
    body.append(h('div.step-label', tr('Parameters')), h('pre.step-args', JSON.stringify(s.args, null, 2)));
    if (s.result) {
      body.append(h('div.step-label', s.result.ok ? tr('Result') : `${tr('Error')} (${stageLabel(s.result.stage)})`), h('pre.step-result' + (s.result.ok ? '' : '.is-error'), s.result.text.slice(0, 4000) + (s.result.text.length > 4000 ? '\n…' : '')));
      if (s.result.changed.length)
        body.append(
          h(
            'div.step-files',
            s.result.changed.map((p) => h('button.att-chip.mono', { type: 'button', title: tr('Open'), onclick: () => void workspace.openFile(p) }, p))
          )
        );
    }
    if (s.status === 'waiting') body.append(failureActions(s));
    card.replaceChildren(summary, preview ? h('div.step-preview.mono', preview) : '', body);
    card.dataset.status = s.status;
    if (s.corrected) card.dataset.corrected = '1';
    if (open) card.setAttribute('open', '');
    scrollDown();
  }

  function stageLabel(st?: string) {
    return st === 'validation' ? tr('invalid arguments') : st === 'approval' ? tr('not approved') : st === 'transport' ? tr('connection') : tr('execution');
  }

  function failureActions(s: AgentStep): HTMLElement {
    const resolve = (c: FailureChoice) => {
      const fn = pendingFailures.get(s.id);
      pendingFailures.delete(s.id);
      fn?.(c);
    };
    return h(
      'div.step-actions',
      h('button.btn.primary', { type: 'button', 'data-action': 'retry', onclick: () => resolve({ action: 'retry' }), html: icon('retry', { size: 14 }) + `<span>${tr('Retry')}</span>` }),
      h(
        'button.btn',
        {
          type: 'button',
          'data-action': 'edit',
          onclick: async () => {
            const args = await editArgs(s);
            if (args) resolve({ action: 'edit', args });
          },
          html: icon('pen', { size: 14 }) + `<span>${tr('Edit')}</span>`,
        }
      ),
      h('button.btn', { type: 'button', 'data-action': 'report', onclick: () => resolve({ action: 'report' }), html: icon('chat', { size: 14 }) + `<span>${tr('Report the error to the AI')}</span>` }),
      h('button.btn.ghost', { type: 'button', 'data-action': 'abort', onclick: () => resolve({ action: 'abort' }) }, tr('Cancel'))
    );
  }

  /** Manual correction of the arguments, checked with Zod before the next call. */
  async function editArgs(s: AgentStep): Promise<Record<string, unknown> | null> {
    let parsed: Record<string, unknown> | null = null;
    const r = await dialog({
      title: s.title,
      tone: tr('correct the parameters'),
      wide: true,
      body: h('div', s.result?.issues?.length ? h('ul.dlg-issues.mono', s.result.issues.map((i) => h('li', i))) : h('p.muted.dlg-text', s.result?.text.slice(0, 400) || ''), h('p.muted.dlg-text', tr('The parameters are checked against the schema of the tool before the call.'))),
      fields: [{ name: 'json', label: tr('Parameters (JSON)'), value: JSON.stringify(s.args, null, 2), mono: true, textarea: true }],
      ok: tr('Run with these parameters'),
      validate: (v) => {
        try {
          parsed = JSON.parse(v.json!) as Record<string, unknown>;
        } catch (e) {
          return tr('Not valid JSON: {message}', { message: (e as Error).message });
        }
        const check = orchestrator.validate(s.name, parsed!);
        return check.ok ? null : check.issues.join('\n');
      },
    });
    return r ? parsed : null;
  }

  // ---------------------------------------------------------------- Agent
  function makeAgent() {
    agent = new Agent(
      chat,
      {
        update(m, what) {
          if (what === 'thought') {
            const v = views.get(m.id);
            if (!v) renderMessage(m);
            else {
              for (const th of m.thoughts || []) paintThought(m, th);
              orderTimeline(m);
              scrollDown();
            }
            return;
          }
          if (what === 'step') {
            const v = views.get(m.id);
            if (!v) renderMessage(m);
            else {
              for (const s of m.steps || []) paintStep(m, s);
              for (const [id, card] of v.cards) if (!id.startsWith('think-') && !m.steps?.some((s) => s.id === id)) (card.remove(), v.cards.delete(id));
              orderTimeline(m);
            }
          } else renderMessage(m);
          if (what === 'meta') paintUsage();
          if (m.done) runPreflight();
          if (what !== 'text' || m.done) save();
          if (m.role === 'assistant' && m.done) {
            const v = views.get(m.id);
            if (v) {
              v.body.innerHTML = mdToHtml(m.text);
              decorateCode(v.body);
            }
            paintMeta(m);
            play('message');
            refreshHistory();
          }
          paintSend();
        },
        failure(step) {
          play('error');
          return new Promise<FailureChoice>((resolve) => pendingFailures.set(step.id, resolve));
        },
        async approve(tool: ToolMeta, args) {
          const r = await dialog({
            title: tool.title,
            tone: tr('approve'),
            wide: true,
            body: h('div', h('p.muted.dlg-text', tr('The AI wants to run {title}. Check the parameters.', { title: tool.title })), h('pre.step-args.mono', JSON.stringify(args, null, 2))),
            ok: tr('Run'),
            danger: tool.name === 'run-command',
          });
          return !!r;
        },
      },
      () => prefs.get('chatProvider') || undefined,
      () => effortFor(targetNow()?.id)
    );
    team = new TeamSession(
      chat,
      {
        update(m, what) {
          if (m.role === 'user') return void renderMessage(m);
          scheduleTeamPaint(m);
          if (what === 'state' || m.done) save();
          if (!m.done) return;
          const v = views.get(m.id);
          if (v) {
            v.renderer = undefined;
            v.body.innerHTML = mdToHtml(m.text);
            decorateCode(v.body);
            paintTeam(m);
            paintMeta(m);
          }
          paintUsage();
          runPreflight();
          play('message');
          refreshHistory();
          void telemetry.get().then((st) => ((rates = st.rates), m.team && paintTeam(m))).catch(() => {});
          paintSend();
        },
      },
      () => prefs.get('chatProvider') || undefined,
      () => effortFor(targetNow()?.id)
    );
  }

  function paintSend() {
    const running = busy();
    sendBtn.innerHTML = icon(running ? 'stop' : 'send', { size: 16 }) + (running ? `<span>${tr('Stop')}</span>` : '');
    sendBtn.setAttribute('aria-label', running ? tr('Stop generating') : tr('Send'));
    sendBtn.title = running ? tr('Stop generating (Escape)') : tr('Send (Enter)');
    sendBtn.classList.toggle('is-stop', !!running);
    sendBtn.disabled = !running && !ta.value.trim() && !tray.count;
    ctx.setBadge(running ? tr('working') : null);
    root.classList.toggle('is-running', !!running);
  }

  async function submit() {
    if (busy()) {
      agent.stop();
      team.stop();
      for (const [, fn] of pendingFailures) fn({ action: 'abort' });
      pendingFailures.clear();
      return;
    }
    let text = ta.value.trim();
    if (!text && !tray.count) return;
    const slash = text.match(/^\/([\w-]+)/);
    if (slash && !tray.count) {
      const name = slash[1]!;
      const sys = SYSTEM_COMMANDS.find((c) => c.name === name);
      // /team with a prompt runs the team once (attachments included), without a prompt it switches Team Mode on
      if (name === 'team' && text.slice(slash[0].length).trim()) return void sendTeam(text.slice(slash[0].length).trim());
      if (sys) {
        ta.value = '';
        autoGrow();
        return void runSystem(name, text.slice(slash[0].length).trim());
      }
      if (!orchestrator.tool(name)) {
        await orchestrator.connect().catch(() => {});
        if (!orchestrator.tool(name)) return toast(tr('/{name} is not a known tool', { name }), 'warning', tr('Type / for the list of tools and commands.'));
      }
    }
    let extras: SendExtras = {};
    if (tray.count) {
      sendBtn.disabled = true;
      const r = await tray.commit();
      if (r.mentions.length) text = (text ? text + '\n\n' : '') + r.mentions.map((p) => '@' + p).join(' ');
      if (!text && r.images.length) text = tr('Describe the attached image.');
      extras = { images: r.images, previews: r.previews };
      if (!text) return paintSend();
    }
    ta.value = '';
    autoGrow();
    paintChips();
    play('sent');
    stick = true;
    // Team Mode: the switch, @team or @leader, or specialists addressed by name (@word-agent)
    const who = agentMentions(text);
    if (!slash && (prefs.get('chatMode') === 'team' || who.team || who.roles.length)) return void runTeam(text, who, extras);
    const p = agent.send(text, slash && !extras.images?.length && orchestrator.tool(slash[1]!) ? slash[1] : undefined, extras);
    paintSend();
    try {
      await p;
    } catch (e) {
      notifyError(e);
    }
    paintSend();
    save();
    save.flush();
  }

  /** /team prompt: one team run, with attachments like a normal message. */
  async function sendTeam(text: string) {
    let extras: SendExtras = {};
    if (tray.count) {
      const r = await tray.commit();
      if (r.mentions.length) text = text + '\n\n' + r.mentions.map((p) => '@' + p).join(' ');
      extras = { images: r.images, previews: r.previews };
    }
    ta.value = '';
    autoGrow();
    paintChips();
    play('sent');
    await runTeam(text, { team: true, roles: agentMentions(text).roles }, extras);
  }

  /**
   * One team answer. One specialist addressed alone (@word-agent) works directly on the prompt; several
   * specialists form the team for this prompt; otherwise the active team configuration runs.
   */
  async function runTeam(text: string, who: { team: boolean; roles: WorkerRoleId[] }, extras: SendExtras = {}) {
    if (!aiConfig.config) await aiConfig.get().catch(() => null);
    if (!orchestrator.ready) await orchestrator.connect().catch(() => {});
    const cfg = teamStore.current;
    const opt: TeamSendOptions = { ...(extras.images?.length ? { images: extras.images, previews: extras.previews } : {}) };
    if (!who.team && who.roles.length === 1) opt.direct = who.roles[0];
    else if (who.roles.length) opt.only = who.roles;
    // Specialists addressed by name join the run even when the team configuration has them switched off
    const run = who.roles.length ? { ...cfg, workers: cfg.workers.map((w) => (who.roles.includes(w.role as WorkerRoleId) ? { ...w, enabled: true } : w)) } : cfg;
    stick = true;
    const p = team.send(text, run, opt);
    paintSend();
    try {
      await p;
    } catch (e) {
      notifyError(e);
    }
    paintSend();
    save();
    save.flush();
  }

  async function retryLast() {
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser || busy()) return;
    const wasTeam = !!chat.messages[chat.messages.indexOf(lastUser) + 1]?.team;
    // Remove the last failed round and send again (images of that message go along)
    const idx = chat.messages.lastIndexOf(lastUser);
    chat.messages.splice(idx);
    const tIdx = chat.turns.map((t) => t.role).lastIndexOf('user');
    const lastTurn = tIdx >= 0 ? chat.turns[tIdx] : undefined;
    const images = lastTurn?.role === 'user' ? lastTurn.images : undefined;
    if (tIdx >= 0) chat.turns.splice(tIdx);
    renderAll();
    if (wasTeam) return void runTeam(lastUser.text, { team: true, roles: agentMentions(lastUser.text).roles }, { images, previews: lastUser.images });
    await agent.send(lastUser.text, lastUser.forcedTool, { images, previews: lastUser.images });
    save();
  }

  /** Undo across all tools: restore the snapshot the backend took before this answer wrote files. */
  async function undoAnswer(m: ChatMessage) {
    try {
      const snap = await api.get<{ id: string; label: string } | null>(`/api/snapshots/chain/${encodeURIComponent(m.id)}`);
      if (!snap) return toast(tr('No snapshot for this answer'), 'warning', tr('Undo needs the desktop backend.'));
      const ok = await dialog({ title: tr('Undo changes'), tone: tr('all apps'), body: tr('These files go back to their state before the answer: {list}. Files the answer created go to the trash. A snapshot of the current state is kept, so this can be undone too.', { list: (m.changed || []).join(', ') }), ok: tr('Undo changes') });
      if (!ok) return;
      const r = await api.send<{ written: number; trashed: number; safety: string }>('POST', `/api/snapshots/${snap.id}/restore`, { chats: false });
      m.undone = true;
      paintMeta(m);
      save();
      toast(tr('Changes undone'), 'success', tr('{w} files restored, {t} moved to the trash.', { w: r.written, t: r.trashed }));
    } catch (e) {
      notifyError(e);
    }
  }

  async function pinToMemory(m: ChatMessage | null, preset = '') {
    const first = preset || (m?.text || '').replace(/[#*_`>]/g, '').split(/\n\s*\n/)[0]!.trim().slice(0, 400);
    const r = await dialog({ title: tr('Remember'), tone: tr('project memory'), body: tr('The note comes back as context in every chat of this project.'), fields: [{ name: 'text', label: tr('Note or decision'), value: first, textarea: true }], ok: tr('Remember') });
    if (!r?.text?.trim()) return;
    try {
      await api.send('POST', '/api/memory', { text: r.text.trim(), chat: chat.id });
      toast(tr('Kept in the project memory'), 'success');
    } catch (e) {
      notifyError(e);
    }
  }

  async function showMemory() {
    const notes = await api.get<{ id: string; text: string; source: string }[]>('/api/memory').catch(() => []);
    const msg: ChatMessage = { id: uid('m'), role: 'assistant', created: new Date().toISOString(), done: true, text: notes.length ? `**${tr('Project memory')}**\n\n${notes.map((n) => `- ${n.text}${n.source === 'ai' ? ' _(AI)_' : ''}`).join('\n')}` : tr('The project memory is empty. Keep notes with /remember or the Remember button under an answer.') };
    chat.messages.push(msg);
    renderMessage(msg, true);
  }

  function runSystem(name: string, rest: string) {
    if (name === 'persona') {
      const pc = aiConfig.config?.personal;
      const want = rest.trim().toLowerCase();
      const p = pc?.personas.find((x) => x.id === want || x.name.toLowerCase() === want || (want.length >= 3 && x.name.toLowerCase().includes(want)));
      if (!want || !p) return toast(tr('Personas: {list}', { list: (pc?.personas || []).map((x) => x.id).join(', ') }), 'info', tr('For example /persona reviewer. Edit them under Settings, Personal context.'));
      personaSel.value = p.id;
      return void personaSel.onchange?.(new Event('change'));
    }
    if (name === 'remember') return rest.trim() ? void api.send('POST', '/api/memory', { text: rest.trim(), chat: chat.id }).then(() => toast(tr('Kept in the project memory'), 'success')).catch(notifyError) : void pinToMemory(null);
    if (name === 'memory') return void showMemory();
    if (name === 'team') return setMode('team');
    if (name === 'roster') return void openRosterModal();
    if (name === 'undo') {
      const last = [...chat.messages].reverse().find((x) => x.role === 'assistant' && x.changed?.length && !x.undone);
      return last ? void undoAnswer(last) : toast(tr('No AI changes to undo in this chat'), 'info');
    }
    if (name === 'snapshot')
      return void api
        .send<{ fileCount: number }>('POST', '/api/snapshots', { label: rest.trim() || tr('Snapshot from the chat') })
        .then((r) => toast(tr('Snapshot saved'), 'success', tr('{n} files and the chats. Restore it under Settings, History and snapshots.', { n: r.fileCount })))
        .catch(notifyError);
    if (name === 'find') return bus.emit('search:open', rest.trim() || undefined);
    if (name === 'clear') return void clearChat();
    if (name === 'new') return void startNew();
    if (name === 'export-chat') return rest.includes('json') ? exportChat(chat, 'json') : rest.includes('md') ? exportChat(chat, 'md') : exportMenu(head);
    if (name === 'history') return toggleDrawer(true);
    if (name === 'search') {
      toggleSearch(true);
      searchInput.value = rest;
      return doSearch();
    }
    if (name === 'model') return providerSel.focus(), providerSel.showPicker?.();
    if (name === 'help') {
      const m: ChatMessage = {
        id: uid('m'),
        role: 'assistant',
        created: new Date().toISOString(),
        done: true,
        text: [
          tr('**@ mentions** attach content: `@file.xlsx` (sheet as Markdown), `@folder/` (file list), `@wordcraft` (panel state and open file), `@terminal` (last output), `@project:Name`.'),
          tr('**/ commands** force a tool, for example `/read-sheet @finances.xlsx range=A1:E6`. When all parameters are given, the call runs directly without a language model.'),
          tr('**Attachments**: the clip button, drag and drop or paste. Files are saved under /attachments/ in the project.'),
          tr('**Team Mode**: switch to Team in the header, or write `@team` or `/team` before a prompt. The Team Leader plans a task graph, the specialists (`@grid-agent`, `@word-agent`, `@deck-agent`, `@pdf-agent`, `@dev-agent`) work in parallel and the leader reviews every result. `/roster` configures the team.'),
          `${tr('System commands:')} ${SYSTEM_COMMANDS.map((c) => '`/' + c.name + '`').join(', ')}.`,
          `${tr('Tools:')} ${orchestrator
            .tools()
            .map((t) => '`/' + t.name + '`')
            .join(', ')}.`,
        ].join('\n\n'),
      };
      chat.messages.push(m);
      renderMessage(m, true);
    }
  }

  async function clearChat() {
    if (!chat.messages.length) return;
    const ok = await dialog({ title: tr('Clear chat'), body: tr('All messages and tool logs of this chat are deleted.'), ok: tr('Clear'), danger: true });
    if (!ok) return;
    agent.stop();
    team.stop();
    chat.messages = [];
    chat.turns = [];
    chat.usage = undefined;
    chat.title = tr('New chat');
    await history.save(chat).catch(() => {});
    renderAll();
    refreshHistory();
  }

  async function startNew() {
    agent?.stop();
    team?.stop();
    save.flush();
    chat = newChat();
    makeAgent();
    renderAll();
    paintSend();
    ta.focus();
    if (root.dataset.history === 'open') void renderHistory();
  }

  async function openChat(id: string) {
    agent.stop();
    team.stop();
    save.flush();
    try {
      chat = await history.load(id);
    } catch (e) {
      return notifyError(e);
    }
    chat.turns ||= [];
    makeAgent();
    renderAll();
    paintSend();
    if (!workspace.fullChat && innerWidth < 1100) toggleDrawer(false);
    void renderHistory();
  }

  function exportMenu(anchor: HTMLElement) {
    if (!chat.messages.length) return toast(tr('The chat is empty'), 'info');
    const r = anchor.getBoundingClientRect();
    menu(
      [
        { label: tr('As Markdown (.md)'), icon: 'file', run: () => exportChat(chat, 'md') },
        { label: tr('As JSON with parameters (.json)'), icon: 'code', run: () => exportChat(chat, 'json') },
      ],
      r.right - 220,
      r.bottom + 4
    );
  }

  // ---------------------------------------------------------------- History drawer
  let histItems: ChatSummary[] = [];
  async function renderHistory() {
    for (const b of scopeBtns) b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
    try {
      histItems = await history.list(scope);
    } catch {
      histItems = [];
    }
    paintHistory();
  }
  const refreshHistory = debounce(() => root.dataset.history === 'open' && void renderHistory(), 400);
  function paintHistory() {
    const q = histSearch.value.trim().toLowerCase();
    const items = histItems.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.projectName || '').toLowerCase().includes(q));
    if (!items.length) return histList.replaceChildren(h('p.muted.hist-empty', q ? tr('No chat matches.') : tr('No saved chats yet.')));
    const day = (iso: string) => {
      const d = new Date(iso);
      const today = new Date();
      const diff = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
      return diff <= 0 ? tr('Today') : diff === 1 ? tr('Yesterday') : diff < 7 ? tr('This week') : d.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    };
    const groups = new Map<string, ChatSummary[]>();
    for (const c of items) {
      const g = c.updated ? day(c.updated) : tr('Older');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(c);
    }
    const other = (c: ChatSummary) => c.project && c.project !== projects.current?.id;
    histList.replaceChildren(
      ...[...groups].flatMap(([g, cs]) => [
        h('div.hist-group.eyebrow', g),
        ...cs.map((c) =>
          h(
            'div.hist-item' + (c.id === chat.id && !other(c) ? '.is-current' : ''),
            { role: 'listitem', 'data-id': c.id },
            h(
              'button.hist-open',
              { type: 'button', onclick: () => void openFromHistory(c) },
              h('span.hist-title', c.title),
              h('span.hist-sub.mono', [`${c.count} ${c.count === 1 ? tr('message') : tr('messages')}`, scope === 'all' ? c.projectName : ''].filter(Boolean).join(' · '))
            ),
            other(c) ? null : btn('pen', tr('Rename'), () => void renameChat(c), { 'data-action': 'rename' }),
            other(c) ? null : btn('trash', tr('Delete'), () => void deleteChat(c), { 'data-action': 'delete' })
          )
        ),
      ])
    );
  }
  histSearch.addEventListener('input', debounce(paintHistory, 100));

  async function openFromHistory(c: ChatSummary) {
    if (c.project && c.project !== projects.current?.id) {
      const ok = await dialog({ title: c.title, tone: tr('other project'), body: tr('This chat belongs to the project {name}. Switch to that project?', { name: c.projectName || c.project }), ok: tr('Switch project') });
      if (!ok) return;
      try {
        sessionStorage.setItem(OPEN_KEY, c.id);
      } catch {
        /* storage blocked */
      }
      return void projects.switchTo(c.project);
    }
    await openChat(c.id);
  }
  async function renameChat(c: ChatSummary) {
    const title = (await promptText(tr('Rename chat'), tr('Title'), c.title))?.trim();
    if (!title) return;
    try {
      if (c.id === chat.id) {
        chat.title = title;
        await history.save(chat);
      } else {
        const rec = await history.load(c.id);
        rec.title = title;
        await history.save(rec);
      }
      void renderHistory();
    } catch (e) {
      notifyError(e);
    }
  }
  async function deleteChat(c: ChatSummary) {
    if (!(await confirmDanger(tr('Delete chat'), tr('“{title}” and its tool logs are deleted.', { title: c.title })))) return;
    await history.remove(c.id).catch(notifyError);
    if (c.id === chat.id) await startNew();
    void renderHistory();
  }
  async function clearHistory() {
    if (!(await confirmDanger(tr('Clear history'), tr('Every chat of the project {name} is deleted. Files stay.', { name: projects.current?.name || '' }), tr('Clear history')))) return;
    agent.stop();
    team.stop();
    try {
      await history.clear();
    } catch (e) {
      return notifyError(e);
    }
    chat = newChat();
    makeAgent();
    renderAll();
    void renderHistory();
  }

  // ---------------------------------------------------------------- Search
  let hits: { id: string }[] = [];
  let hitIdx = 0;
  function toggleSearch(force?: boolean) {
    searchBar.hidden = force === undefined ? !searchBar.hidden : !force;
    searchBtn.setAttribute('aria-pressed', String(!searchBar.hidden));
    if (!searchBar.hidden) searchInput.focus();
    else {
      searchInput.value = '';
      doSearch();
    }
  }
  function doSearch() {
    hits = searchMessages(chat, searchInput.value);
    hitIdx = 0;
    list.querySelectorAll('.msg.is-hit').forEach((x) => x.classList.remove('is-hit'));
    for (const hh of hits) views.get(hh.id)?.el.classList.add('is-hit');
    searchInfo.textContent = searchInput.value ? tr('{n} hits', { n: hits.length }) : '';
    jump();
  }
  function jump() {
    const t = hits[hitIdx];
    if (!t) return;
    const v = views.get(t.id);
    v?.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    list.querySelectorAll('.msg.is-current').forEach((x) => x.classList.remove('is-current'));
    v?.el.classList.add('is-current');
    v?.el.querySelectorAll('details.step').forEach((d) => d.setAttribute('open', ''));
    searchInfo.textContent = tr('{i} of {n}', { i: hitIdx + 1, n: hits.length });
  }
  searchInput.addEventListener('input', debounce(doSearch, 120));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && hits.length) {
      hitIdx = (hitIdx + (e.shiftKey ? hits.length - 1 : 1)) % hits.length;
      jump();
    } else if (e.key === 'Escape') toggleSearch(false);
  });

  // ---------------------------------------------------------------- Input
  function autoGrow() {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, workspace.fullChat ? 320 : 220)}px`;
  }
  const paintChips = debounce(() => {
    const refs = findMentions(ta.value);
    const slash = ta.value.match(/^\/([\w-]+)/)?.[1];
    const out: HTMLElement[] = [];
    if (slash) {
      const t = orchestrator.tool(slash);
      const sys = SYSTEM_COMMANDS.find((c) => c.name === slash);
      out.push(h('span.att-chip.mono', { 'data-kind': t ? 'tool' : sys ? 'command' : 'missing', style: t ? `--tool:${APP_ACCENT[t.app]}` : '' }, t ? tr('/{name} forces {title}', { name: t.name, title: t.title }) : sys ? `/${sys.name}: ${sys.title}` : tr('/{name} unknown', { name: slash })));
    }
    const who = agentMentions(ta.value);
    if (!slash && (who.team || who.roles.length || (prefs.get('chatMode') === 'team' && ta.value.trim())) || slash === 'team') {
      const label = !who.team && who.roles.length === 1 ? tr('{name} works alone', { name: tr(ROLE_DEFS[who.roles[0]!].name) }) : who.roles.length && !who.team ? tr('Team of {list}', { list: who.roles.map((r) => '@' + ROLE_DEFS[r].mention).join(', ') }) : tr('Team Mode: the Team Leader plans, specialists work in parallel');
      out.push(h('span.att-chip.mono', { 'data-kind': 'team', style: `--tool:${ROLE_DEFS.leader.accent}` }, label));
    }
    for (const r of refs) if (!agentMentions('@' + r).team && !agentMentions('@' + r).roles.length) out.push(h('span.att-chip.mono', { 'data-kind': 'ref' }, '@' + r));
    chips.replaceChildren(...out);
    paintSend();
  }, 80);
  ta.addEventListener('input', () => {
    autoGrow();
    paintChips();
    runPreflight();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && busy()) (agent.stop(), team.stop());
  });
  sendBtn.onclick = () => void submit();
  fileInput.addEventListener('change', () => {
    void tray.add([...(fileInput.files || [])]);
    fileInput.value = '';
  });
  // Paste images or files from the clipboard
  ta.addEventListener('paste', (e) => {
    const files = filesOf(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void tray.add(files);
  });
  // Drag files from the project tree (mention) or from the operating system (attachment)
  const dropZone = main;
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  dropZone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    root.classList.add('is-drop');
  });
  dropZone.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      root.classList.remove('is-drop');
    }
  });
  dropZone.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('text/x-opencraft-path') || hasFiles(e)) e.preventDefault();
  });
  dropZone.addEventListener('drop', (e) => {
    dragDepth = 0;
    root.classList.remove('is-drop');
    const p = e.dataTransfer?.getData('text/x-opencraft-path');
    if (p) {
      e.preventDefault();
      return insert('@' + p.slice(1) + ' ');
    }
    const files = filesOf(e.dataTransfer);
    if (!files.length) return;
    // Files dropped on the chat are attachments (also ZIPs), not a project import
    e.preventDefault();
    e.stopPropagation();
    void tray.add(files);
  });
  /** Puts @ or / at the caret and opens the matching menu. */
  function trigger(ch: '@' | '/') {
    const s = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, s);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + sep + ch + ta.value.slice(ta.selectionEnd ?? s);
    const caret = s + sep.length + 1;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    autoGrow();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function insert(text: string) {
    const s = ta.selectionStart;
    const before = ta.value.slice(0, s);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + sep + text + ta.value.slice(ta.selectionEnd);
    const caret = s + sep.length + text.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    autoGrow();
    paintChips();
  }

  // ---------------------------------------------------------------- Start
  const offs = [
    bus.on('chat:insert', (t) => {
      workspace.show(ctx.id);
      insert(t);
    }),
    bus.on('chat:trigger', (ch) => {
      workspace.show(ctx.id);
      trigger(ch);
    }),
    bus.on('ai:status', () => (void paintProvider(), runPreflight())),
    bus.on('config:change', () => (paintPersonas(), paintMode(), runPreflight())),
    bus.on('team:roster', () => void openRosterModal()),
    bus.on('ai:usage', (u) => paintLatency(u.firstMs, u.model)),
    bus.on('chat:view', () => {
      paintView();
      autoGrow();
    }),
    bus.on('workspace:change', paintMcp),
    bus.on('settings:change', ({ key }) => {
      if (key === 'chatProvider') (void paintProvider(), runPreflight());
      if (key === 'theme') paintTheme();
      if (key === 'chatMode') paintMode();
    }),
    projects.onBeforeSwitch(async () => {
      agent.stop();
      team.stop();
      save.cancel();
      if (chat.messages.length) await history.save(chat).catch(() => {});
    }),
  ];
  const themeObs = new MutationObserver(paintTheme);
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  makeAgent();
  try {
    // A chat picked from another project in the history drawer opens after the switch
    let want: string | null = null;
    try {
      want = sessionStorage.getItem(OPEN_KEY);
      sessionStorage.removeItem(OPEN_KEY);
    } catch {
      /* storage blocked */
    }
    const id = want || (await history.list())[0]?.id;
    if (id) {
      chat = await history.load(id);
      chat.turns ||= [];
      makeAgent();
    }
  } catch {
    /* new chat */
  }
  renderAll();
  paintSend();
  paintView();
  paintTheme();
  paintMcp();
  paintMode();
  void telemetry.get().then((st) => (rates = st.rates)).catch(() => {});
  const lastUsage = [...chat.messages].reverse().find((m) => m.usage)?.usage;
  if (lastUsage) paintLatency(lastUsage.firstMs, chat.usage?.model);
  void paintProvider();
  void orchestrator
    .connect()
    .then(paintMcp)
    .catch((e) => {
      paintMcp();
      banner(bannerHost, { level: 'error', title: tr('MCP connection failed'), message: (e as Error).message, timeout: 0, actions: [{ label: tr('Reconnect'), run: () => void orchestrator.connect().then(paintMcp) }] });
    });

  return {
    getScroll: () => ({ top: list.scrollTop, left: 0 }),
    setScroll: (s) => void (list.scrollTop = s.top),
    status: () => ({ chat: chat.title, messages: chat.messages.length, working: busy(), mode: prefs.get('chatMode'), team: team.running ? { phase: team.run!.state.phase, active: team.run!.active } : null, view: workspace.fullChat ? 'full' : workspace.panel(ctx.id)?.pip ? 'floating' : 'sidebar', side: prefs.get('chatSide'), tokens: chat.usage ? { input: chat.usage.input, output: chat.usage.output, cached: chat.usage.cached, requests: chat.usage.requests } : null, attachments: tray.count }),
    resume: () => ta.focus({ preventScroll: true }),
    unmount() {
      agent.stop();
      team.stop();
      save.cancel();
      offs.forEach((f) => f());
      clearInterval(thinkTimer);
      themeObs.disconnect();
      detachMentions();
      tray.clear();
      root.remove();
    },
  };
}
