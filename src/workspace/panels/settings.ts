// Settings: status, AI providers (Claude, ChatGPT, Gemini, DeepSeek, Ollama, your own
// OpenAI-compatible endpoints), external MCP servers, appearance and layout, Git author, iPad and network.
//
// Keys only go to the local backend and are stored in ~/OpenCraft/config.json
// (file mode 0600). After that the frontend only sees a mask.

import { h, uid } from '../../app/util.js';
import { icon } from '../../app/icons.js';
import { api, live } from '../../app/backend.js';
import { bus } from '../../app/bus.js';
import { prefs } from '../../app/settings.js';
import { confirmDanger } from '../../app/ui.js';
import { toast, notifyError } from '../../app/notifications.js';
import { aiConfig, type PublicConfig, type PublicProvider, type PublicCustom, type TestResult, type McpEntry } from '../../chat/config.js';
import { TOOLS, RELEASES, type PanelContext, type PanelInstance, type ToolId } from '../registry.js';
import { backend } from '../../app/backend.js';
import { device } from '../../app/device.js';
import { allowScribble } from '../pencil.js';
import { wantsWebgl } from './craftapp.js';
import { projects } from '../../project/manager.js';
import { fs } from '../../project/fs.js';
import { downloadBlob, basename, normPath } from '../../app/util.js';
import { t, tn, lang, LANGS, LANG_LABELS, setLang } from '../../app/i18n.js';
import { VERSION, appStatus } from '../../app/status.js';
import { workspace } from '../layout.js';
import { telemetry, usageTable, providerTable } from '../../chat/telemetry.js';
import { usageTotals, compactTokens, money, percent, type Rate, type UsageStore } from '../../chat/usage.js';
import { DEEPSEEK_MAX_OUTPUT, DEEPSEEK_PRESETS, presetOf, type DeepSeekSettings } from '../../chat/deepseek.js';
import { extraSections, type ExtraSection } from './settings-extra.js';

type Section = 'status' | 'ai' | 'usage' | 'mcp' | 'view' | 'git' | 'device' | ExtraSection;

interface LanInfo {
  active: boolean;
  enabled: boolean;
  token: string | null;
  port: number;
  addresses: string[];
  urls: string[];
}

const DESKTOP_KEY = 'opencraft.desktop';
function savedDesktop(): { host: string; port: string; token: string } {
  try {
    return { host: '', port: '5175', token: '', ...(JSON.parse(localStorage.getItem(DESKTOP_KEY) || '{}') as object) };
  } catch {
    return { host: '', port: '5175', token: '' };
  }
}

/** Save a file through the iPadOS share sheet (Save to Files), otherwise as a download. */
async function shareOrDownload(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (device.touchUi && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadBlob(blob, name);
}

export async function mount(el: HTMLElement, ctx: PanelContext): Promise<PanelInstance> {
  const root = h('div.sp');
  const nav = h('nav.sp-nav', { 'aria-label': t('Sections') });
  const body = h('div.sp-body');
  root.append(nav, body);
  el.append(root);

  let cfg: PublicConfig;
  let section: Section = 'ai';
  const GROUPS: [string, [Section, string, string][]][] = [
    [t('Overview'), [['status', t('Status'), 'activity'], ['health', t('Health check'), 'life'], ['monitor', t('Memory and GPU'), 'cpu']]],
    [t('AI'), [['ai', t('AI models'), 'spark'], ['team', t('Team Mode'), 'users'], ['personal', t('Personal context'), 'user'], ['search', t('Search and memory'), 'search'], ['usage', t('Usage and telemetry'), 'trend']]],
    [t('Privacy'), [['privacy', t('Privacy'), 'lock'], ['audit', t('Audit log'), 'shield']]],
    [t('Project'), [['history', t('History and snapshots'), 'clock'], ['trash', t('Trash'), 'trash'], ['share', t('Share and sync'), 'share']]],
    [t('Extensions'), [['mcp', t('MCP servers'), 'plug'], ['plugins', t('Plugins and sandbox'), 'box'], ['logs', t('Logs and metrics'), 'terminal']]],
    [t('Workspace'), [['view', t('Appearance and layout'), 'palette'], ['git', 'Git', 'git'], ['device', t('iPad and network'), 'tablet']]],
  ];
  const SECTIONS: [Section, string, string][] = GROUPS.flatMap(([, list]) => list);
  const extras = extraSections({
    cfg: () => cfg,
    setCfg: (c) => void (cfg = c),
    render: () => render(),
    go: (s) => {
      if (SECTIONS.some(([id]) => id === s)) (section = s as Section), render();
    },
    visible: (s) => section === s && el.isConnected && !el.closest('[hidden]'),
  });

  function renderNav() {
    nav.replaceChildren(
      ...GROUPS.flatMap(([group, list]) => [
        h('p.sp-nav-group.eyebrow', group),
        ...list.map(([id, label, ic]) => h('button.sp-tab' + (section === id ? '.is-active' : ''), { type: 'button', 'data-section': id, 'aria-current': section === id ? 'page' : 'false', html: icon(ic, { size: 16 }) + `<span>${label}</span>`, onclick: () => ((section = id), render()) })),
      ])
    );
  }

  async function reload() {
    cfg = await aiConfig.get();
    render();
  }

  function render() {
    renderNav();
    if (section === 'status') body.replaceChildren(statusSection());
    else if (section === 'ai') body.replaceChildren(aiSection());
    else if (section === 'usage') void usageSection().then((n) => section === 'usage' && body.replaceChildren(n));
    else if (section === 'mcp') void mcpSection().then((n) => body.replaceChildren(n));
    else if (section === 'view') body.replaceChildren(viewSection());
    else if (section === 'device') void deviceSection().then((n) => body.replaceChildren(n));
    else if (section === 'git') body.replaceChildren(gitSection());
    else {
      const want = section;
      body.replaceChildren(h('div.sp-section', h('p.muted', t('Loading …'))));
      void extras[want]()
        .then((n) => section === want && body.replaceChildren(n))
        .catch((e: Error) => section === want && body.replaceChildren(h('div.sp-section', h('p.sp-err', e.message))));
    }
  }

  // ---------------------------------------------------------------- Status

  function row(label: string, value: string | Node, mono = true): HTMLElement {
    return h('div.sp-kv', h('span.muted', label), typeof value === 'string' ? h('span' + (mono ? '.mono' : ''), value) : value);
  }
  function dot(state: string, text: string): HTMLElement {
    return h('span.sp-state', h('span.sp-dot', { 'data-state': state }), h('span', text));
  }

  function statusSection(): HTMLElement {
    const remote = document.documentElement.dataset.backend === 'remote';
    const st = aiConfig.cached;
    const s = workspace.stats();
    const modeText = backend.browser ? t('Browser mode (IndexedDB on this device)') : remote ? t('Desktop PC on the home network') : t('Desktop backend on this computer');
    const backendState = backend.browser ? dot('local', t('Browser mode')) : live.connected ? dot('on', t('connected')) : dot('error', t('disconnected'));
    const ai = st?.active ? dot(st.active.local ? 'local' : 'on', `${st.active.name} · ${st.active.model}`) : dot('error', t('not set up'));
    const mode: Record<string, string> = { normal: t('visible'), minimized: t('minimized'), collapsed: t('collapsed'), hidden: t('hidden') };
    const state: Record<string, string> = { idle: t('not loaded'), queued: t('waiting'), loading: t('loading'), active: t('running'), unloaded: t('unloaded'), error: t('error') };
    const panels = workspace.details().map((p) =>
      h(
        'div.sp-panel-row',
        { 'data-panel': p.id },
        h('strong', p.name),
        h('span.mono.muted', p.path || '–'),
        h('span', `${mode[p.mode] || p.mode} · ${p.status === 'active' && p.paused ? t('paused') : state[p.status] || p.status}`),
        h('span.mono.muted', [p.text, p.loadMs ? t('start {s} s', { s: (p.loadMs / 1000).toFixed(1) }) : '', p.error].filter(Boolean).join(' · ') || '–')
      )
    );
    const themeName: Record<string, string> = { system: t('System'), light: t('Light'), dark: t('Dark') };
    return h(
      'div.sp-section.sp-status',
      h('p.eyebrow', t('Status')),
      h('h2.duo', 'OpenCraft ', h('span.tone', 'v' + VERSION)),
      h(
        'div.frame.sp-card',
        { 'data-card': 'status' },
        h(
          'div.well',
          h('div.sp-card-head', h('h3.duo', t('Connection') + ' ', h('span.tone', t('and services')))),
          h(
            'div.sp-kvs',
            row(t('Mode'), modeText, false),
            row('Backend', backendState),
            row(t('AI model'), ai),
            row('Git', appStatus.get().git || '–'),
            row(t('Offline cache'), appStatus.get().cache || '–', false),
            row(t('Appearance'), `${themeName[prefs.get('theme')]} · ${LANGS.find((l) => l.id === lang)?.name}`, false)
          )
        )
      ),
      h(
        'div.frame.sp-card',
        { 'data-card': 'apps' },
        h(
          'div.well',
          h('div.sp-card-head', h('h3.duo', t('Apps') + ' ', h('span.tone', t('WebAssembly builds on this device')))),
          h(
            'div.sp-kvs',
            ...RELEASES.map((r) => {
              const tool = TOOLS[r.app as ToolId];
              const older = r.webVersion && r.webVersion !== r.version;
              return h(
                'div.sp-kv',
                { 'data-app': r.app, title: r.webNote || '' },
                h('span.sp-app', h('img', { src: tool?.logo || '', width: 18, height: 18, alt: '' }), h('span', r.name)),
                h('span.mono', older ? `v${r.webVersion} · ${t('release {v} on the desktop', { v: r.version })} · ${r.date}` : `v${r.version} · ${r.date} · ${t('web build {mb} MB', { mb: (r.webZipBytes / 1048576).toFixed(1) })}`)
              );
            })
          )
        )
      ),
      h(
        'div.frame.sp-card',
        { 'data-card': 'panels' },
        h(
          'div.well',
          h('div.sp-card-head', h('h3.duo', t('Panels') + ' ', h('span.tone', t('{a} running · {p} paused · {u} not loaded', { a: s.active, p: s.paused, u: s.unloaded })))),
          h('p.muted', tn(s.apps, '{n} app in memory. Hidden apps pause and keep their state.', '{n} apps in memory. Hidden apps pause and keep their state.')),
          h('div.sp-panels', h('div.sp-panel-row.sp-panel-headrow.eyebrow', h('span', t('Panel')), h('span', t('File')), h('span', t('State')), h('span', t('Details'))), ...panels)
        )
      )
    );
  }

  // ---------------------------------------------------------------- AI

  function testLine(): { el: HTMLElement; show: (r: TestResult | null, pending?: boolean) => void } {
    const el = h('div.sp-test.mono', { role: 'status', hidden: true });
    return {
      el,
      show(r, pending) {
        el.hidden = false;
        if (pending) {
          el.dataset.state = 'pending';
          el.textContent = t('Checking the connection …');
          return;
        }
        if (!r) return void (el.hidden = true);
        el.dataset.state = r.ok ? 'ok' : 'error';
        el.textContent = r.ok ? `${t('Connected.')} ${r.models.length ? t('{n} models, for example {list}', { n: r.models.length, list: r.models.slice(0, 4).join(', ') }) : t('Model list not available.')}` : `${r.error?.code || t('ERROR')}: ${r.error?.message || t('unknown')}`;
      },
    };
  }

  function modelInput(value: string, list: string): HTMLInputElement {
    return h<'input'>('input.input.mono', { value, list, placeholder: t('Model name (free text)'), autocomplete: 'off', spellcheck: 'false' });
  }

  function providerCard(p: PublicProvider): HTMLElement {
    const listId = uid('models');
    const datalist = h('datalist', { id: listId });
    const key = h<'input'>('input.input.mono', { type: 'password', placeholder: p.hasKey ? t('saved {hint}', { hint: p.keyHint }) : p.needsKey ? t('API key') : t('no key needed'), autocomplete: 'off', spellcheck: 'false', disabled: !p.needsKey && !p.local ? true : false });
    const model = modelInput(p.model, listId);
    const base = h<'input'>('input.input.mono', { value: p.baseUrl, placeholder: t('Base URL'), spellcheck: 'false' });
    const test = testLine();
    const active = cfg.ai.active === p.id;
    const runTest = async () => {
      test.show(null, true);
      const r = await api.send<TestResult>('POST', '/api/ai/test', { id: p.id, apiKey: key.value.trim() || undefined, baseUrl: base.value.trim() || undefined, model: model.value.trim() || undefined }).catch((e: Error) => ({ ok: false, models: [], error: { code: 'BACKEND_DOWN', message: e.message } }));
      test.show(r);
      datalist.replaceChildren(...r.models.map((m) => h('option', { value: m })));
    };
    const save = async () => {
      try {
        cfg = await api.send<PublicConfig>('PUT', '/api/config/provider', { id: p.id, apiKey: key.value.trim() || undefined, model: model.value.trim(), baseUrl: base.value.trim() });
        key.value = '';
        toast(t('{name} saved', { name: p.name }), 'success');
        await aiConfig.changed();
        render();
      } catch (e) {
        notifyError(e);
      }
    };
    return h(
      'div.frame.sp-card' + (active ? '.is-active' : ''),
      { 'data-provider': p.id },
      h(
        'div.well',
        h(
          'div.sp-card-head',
          h('h3.duo', p.name, ' ', h('span.tone', p.local ? t('local') : p.hasKey ? t('set up') : t('key missing'))),
          h('span.spacer'),
          active ? h('span.pill.mono', t('active')) : h('button.btn.ghost', { type: 'button', onclick: () => void setActive(p.id) }, t('Make default'))
        ),
        h(
          'div.sp-grid',
          p.needsKey ? h('label.field', h('span', t('API key')), key) : null,
          h('label.field', h('span', t('Model')), model, datalist),
          h('label.field', h('span', p.local ? t('Address') : t('Base URL')), base)
        ),
        test.el,
        h(
          'div.sp-actions',
          h('button.btn.primary', { type: 'button', onclick: () => void save() }, t('Save')),
          h('button.btn', { type: 'button', onclick: () => void runTest() }, t('Test connection')),
          p.hasKey
            ? h(
                'button.btn.ghost.danger',
                {
                  type: 'button',
                  onclick: async () => {
                    cfg = await api.send<PublicConfig>('PUT', '/api/config/provider', { id: p.id, apiKey: null });
                    await aiConfig.changed();
                    render();
                  },
                },
                t('Remove key')
              )
            : null,
          h('small.muted', t('Get a key at {url}.', { url: p.docs }))
        )
      )
    );
  }

  function customCard(c: PublicCustom | null): HTMLElement {
    const listId = uid('models');
    const datalist = h('datalist', { id: listId });
    const name = h<'input'>('input.input', { value: c?.name || '', placeholder: t('for example LM Studio, OpenRouter, vLLM') });
    const base = h<'input'>('input.input.mono', { value: c?.baseUrl || '', placeholder: 'https://host/v1', spellcheck: 'false' });
    const key = h<'input'>('input.input.mono', { type: 'password', placeholder: c?.hasKey ? t('saved {hint}', { hint: c.keyHint }) : t('optional'), autocomplete: 'off' });
    const model = modelInput(c?.model || '', listId);
    const test = testLine();
    const active = c && cfg.ai.active === c.id;
    const runTest = async () => {
      if (!base.value.trim()) return toast(t('Enter the base URL first'), 'warning');
      test.show(null, true);
      const r = await api
        .send<TestResult>('POST', '/api/ai/test', { id: c?.id || 'custom-new', apiKey: key.value.trim() || undefined, baseUrl: base.value.trim(), model: model.value.trim() || undefined })
        .catch((e: Error) => ({ ok: false, models: [], error: { code: 'BACKEND_DOWN', message: e.message } }));
      test.show(r);
      datalist.replaceChildren(...r.models.map((m) => h('option', { value: m })));
    };
    const save = async () => {
      const b = { name: name.value.trim(), baseUrl: base.value.trim(), model: model.value.trim(), apiKey: key.value.trim() || undefined };
      if (!b.name || !b.baseUrl || !b.model) return toast(t('Name, base URL and model are required'), 'warning');
      try {
        if (c) cfg = await api.send<PublicConfig>('PUT', `/api/config/custom/${c.id}`, b);
        else {
          const r = await api.send<{ id: string; config: PublicConfig }>('POST', '/api/config/custom', b);
          cfg = r.config;
        }
        toast(t('{name} saved', { name: b.name }), 'success');
        await aiConfig.changed();
        render();
      } catch (e) {
        notifyError(e);
      }
    };
    return h(
      'div.frame.sp-card' + (active ? '.is-active' : ''),
      { 'data-provider': c?.id || 'custom-new' },
      h(
        'div.well',
        h(
          'div.sp-card-head',
          h('h3.duo', c ? c.name : t('Own endpoint'), ' ', h('span.tone', c ? t('OpenAI compatible') : t('add'))),
          h('span.spacer'),
          c ? (active ? h('span.pill.mono', t('active')) : h('button.btn.ghost', { type: 'button', onclick: () => void setActive(c.id) }, t('Make default'))) : null
        ),
        h('div.sp-grid', h('label.field', h('span', t('Name')), name), h('label.field', h('span', t('Base URL')), base), h('label.field', h('span', t('API key')), key), h('label.field', h('span', t('Model')), model, datalist)),
        test.el,
        h(
          'div.sp-actions',
          h('button.btn.primary', { type: 'button', 'data-action': c ? 'save-custom' : 'add-custom', onclick: () => void save() }, c ? t('Save') : t('Add')),
          h('button.btn', { type: 'button', onclick: () => void runTest() }, t('Test connection')),
          c
            ? h(
                'button.btn.ghost.danger',
                {
                  type: 'button',
                  onclick: async () => {
                    if (!(await confirmDanger(t('Remove endpoint'), t('{name} is deleted from the configuration.', { name: c.name }), t('Remove')))) return;
                    cfg = await api.send<PublicConfig>('DELETE', `/api/config/custom/${c.id}`);
                    await aiConfig.changed();
                    render();
                  },
                },
                t('Remove')
              )
            : null
        )
      )
    );
  }

  /**
   * DeepSeek presets (standard chat, thinking, deep thinking, coding and FIM) with the parameters the
   * API reference allows: max_tokens 1 to 384K, temperature only without thinking, effort only with it.
   */
  function deepseekCard(): HTMLElement {
    let cur: DeepSeekSettings = { ...(cfg.ai.deepseek || { preset: 'reasoning' }) };
    const hint = h('p.muted.sp-ds-hint');
    const maxIn = h<'input'>('input.input.mono', { type: 'number', min: '1', max: String(DEEPSEEK_MAX_OUTPUT), step: '1024', inputmode: 'numeric', 'data-ds': 'max-tokens' });
    const tempIn = h<'input'>('input.input.mono', { type: 'number', min: '0', max: '2', step: '0.1', inputmode: 'decimal', 'data-ds': 'temperature' });
    const effortSel = h<'select'>('select.input', { 'data-ds': 'effort' }, ...(['low', 'high', 'max'] as const).map((e) => h('option', { value: e }, e)));
    const segs = DEEPSEEK_PRESETS.map((p) => h('button.seg-btn', { type: 'button', 'data-preset': p.id, onclick: () => ((cur = { preset: p.id }), paint()) }, t(p.name)));
    const paint = () => {
      const p = presetOf(cur.preset);
      for (const b of segs) b.setAttribute('aria-pressed', String(b.dataset.preset === p.id));
      hint.textContent = t(p.hint);
      maxIn.placeholder = String(p.maxTokens);
      maxIn.value = cur.maxTokens ? String(cur.maxTokens) : '';
      tempIn.disabled = p.thinking;
      tempIn.placeholder = p.thinking ? t('no effect in thinking mode') : String(p.temperature ?? 1);
      tempIn.value = !p.thinking && cur.temperature !== undefined ? String(cur.temperature) : '';
      effortSel.disabled = !p.thinking;
      effortSel.value = cur.effort || p.effort || 'high';
    };
    const save = async () => {
      const p = presetOf(cur.preset);
      const max = parseInt(maxIn.value, 10);
      const temp = parseFloat(tempIn.value);
      const next: DeepSeekSettings = { preset: p.id, ...(isFinite(max) && max > 0 ? { maxTokens: Math.min(DEEPSEEK_MAX_OUTPUT, max) } : {}), ...(!p.thinking && isFinite(temp) ? { temperature: Math.min(2, Math.max(0, temp)) } : {}), ...(p.thinking && effortSel.value !== (p.effort || 'high') ? { effort: effortSel.value as 'low' | 'high' | 'max' } : {}) };
      try {
        cfg = await api.send<PublicConfig>('PUT', '/api/config/deepseek', next);
        await aiConfig.get();
        toast(t('DeepSeek mode: {name}', { name: t(p.name) }), 'success');
        render();
      } catch (e) {
        notifyError(e);
      }
    };
    paint();
    return h(
      'div.frame.sp-card.sp-deepseek',
      { 'data-deepseek': 'presets' },
      h(
        'div.well',
        h('div.sp-card-head', h('h3.duo', 'DeepSeek ', h('span.tone', t('mode and parameters')))),
        h('div.seg.sp-ds-presets', { role: 'group', 'aria-label': t('DeepSeek mode') }, segs),
        hint,
        h('div.sp-grid', h('label.field', h('span', t('Max output tokens')), maxIn), h('label.field', h('span', t('Temperature')), tempIn), h('label.field', h('span', t('Thinking effort')), effortSel)),
        h(
          'ul.sp-ds-rules.mono.muted',
          h('li', t('Thinking mode ignores temperature; tool chains send the chain of thought back with every step.')),
          h('li', t('/ commands that force a tool run without thinking (the API rejects a forced tool in thinking mode).')),
          h('li', t('max_tokens 1 to 393,216. FIM completions in the code editor: up to 4,096.')),
          h('li', t('Requests keep a fixed prefix (system prompt, sorted tools, project context) for cache hits.'))
        ),
        h('div.sp-actions', h('button.btn.primary', { type: 'button', 'data-action': 'save-deepseek', onclick: () => void save() }, t('Save')))
      )
    );
  }

  async function setActive(id: string) {
    cfg = await api.send<PublicConfig>('PUT', '/api/config/active', { active: id });
    prefs.set('chatProvider', id);
    await aiConfig.changed();
    render();
  }

  function aiSection(): HTMLElement {
    const modeSel = h<'select'>('select.input', { 'aria-label': t('Default provider') }, h('option', { value: 'auto', selected: cfg.ai.active === 'auto' }, t('Automatic (first provider that is set up, otherwise Ollama)')), ...[...cfg.ai.providers, ...cfg.ai.custom].map((p) => h('option', { value: p.id, selected: cfg.ai.active === p.id }, p.name)));
    modeSel.onchange = () => void setActive(modeSel.value);
    return h(
      'div.sp-section',
      h('p.eyebrow', t('AI models')),
      h('h2.duo', t('Providers') + ' ', h('span.tone', t('and keys'))),
      h(
        'div.frame.sm.sp-notice',
        h(
          'div.well',
          h('span', { html: icon('lock', { size: 16 }) }),
          backend.browser
            ? h('p', h('strong', t('Browser mode:') + ' '), t('Keys stay in the memory of this browser until a reload, unless you allow storing them under iPad and network. Requests go straight from the browser to the provider.'))
            : h('p', t('Keys only go to the local backend on this computer and are stored in') + ' ', h('code.mono', '~/OpenCraft/config.json'), ' ' + t('(readable only by your user account). Requests to providers go through the backend, never straight from the browser. Ollama works fully local.'))
        )
      ),
      h('label.field.sp-mode', h('span', t('Default for the chat')), modeSel),
      h(
        'div.sp-toggles',
        h('label.switch', h('input', { type: 'checkbox', 'data-pref': 'remoteCount', checked: prefs.get('remoteCount'), onchange: (e: Event) => prefs.set('remoteCount', (e.target as HTMLInputElement).checked) }), h('span', t('Exact token counts from Claude and Gemini while typing'), h('small.muted', ' ' + t('(count_tokens and countTokens see the draft like a request; off: estimate. DeepSeek and ChatGPT always count exactly on this computer)'))))
      ),
      ...cfg.ai.providers.flatMap((p) => (p.id === 'deepseek' ? [providerCard(p), deepseekCard()] : [providerCard(p)])),
      h('p.eyebrow.sp-sub', t('Own endpoints')),
      ...cfg.ai.custom.map((c) => customCard(c)),
      customCard(null)
    );
  }

  // ---------------------------------------------------------------- MCP

  async function mcpSection(): Promise<HTMLElement> {
    const ext = await api.get<{ id: string; name: string; status: string; error?: string; tools: string[]; sandbox?: string }[]>('/api/mcp/external').catch(() => []);
    const list = cfg.mcpServers.map((s) => {
      const st = ext.find((e) => e.id === s.id);
      return h(
        'div.sp-mcp-row',
        h('span.sp-dot', { 'data-state': st?.status || 'off' }),
        h('div', h('strong', s.name), h('small.mono.muted', s.transport === 'http' ? String(s.url) : `${s.command} ${s.args.join(' ')}`), (st as { sandbox?: string } | undefined)?.sandbox ? h('small.muted', t('Sandbox applied: {s}', { s: (st as { sandbox?: string }).sandbox! })) : null, st?.error ? h('small.sp-err', st.error) : null, st?.tools.length ? h('small.mono.muted', t('{n} tools: {list}', { n: st.tools.length, list: st.tools.slice(0, 6).join(', ') })) : null),
        h('span.spacer'),
        policySelect(s, 'sandbox', [
          ['strict', t('Sandbox: strict')],
          ['standard', t('Sandbox: standard')],
          ['off', t('Sandbox: off')],
        ]),
        policySelect(s, 'approval', [
          ['ask', t('Ask before every call')],
          ['read', t('Read-only tools run freely')],
          ['all', t('Never ask')],
        ]),
        h('label.switch', h('input', { type: 'checkbox', checked: s.enabled, onchange: (e: Event) => void saveMcp(cfg.mcpServers.map((x) => (x.id === s.id ? { ...x, enabled: (e.target as HTMLInputElement).checked } : x))) }), h('span', t('active'))),
        h('button.icon-btn', { type: 'button', 'aria-label': t('Remove {name}', { name: s.name }), html: icon('trash', { size: 16 }), onclick: () => void saveMcp(cfg.mcpServers.filter((x) => x.id !== s.id)) })
      );
    });
    const name = h<'input'>('input.input', { placeholder: t('Name, for example filesystem') });
    const cmd = h<'input'>('input.input.mono', { placeholder: t('Command (npx -y @modelcontextprotocol/server-everything) or URL (http://127.0.0.1:8188/mcp)'), spellcheck: 'false' });
    return h(
      'div.sp-section',
      h('p.eyebrow', 'Model Context Protocol'),
      h('h2.duo', t('External') + ' ', h('span.tone', t('MCP servers'))),
      h('p.muted', t('OpenCraft itself is an MCP server at') + ' ', h('code.mono', `${location.origin}/mcp`), ' ' + t('(Streamable HTTP). External servers over stdio are then available in the chat under /.')),
      h('div.frame', h('div.well.flush', list.length ? list : h('p.muted.sp-empty', t('No external servers yet.')))),
      h(
        'div.sp-grid',
        h('label.field', h('span', t('Name')), name),
        h('label.field', h('span', t('Command')), cmd),
        h(
          'div.sp-actions',
          h(
            'button.btn.primary',
            {
              type: 'button',
              onclick: () => {
                const parts = cmd.value.trim().match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) || [];
                if (!name.value.trim() || !parts.length) return toast(t('Name and command are required'), 'warning');
                const http = /^https?:\/\//.test(parts[0]!);
                void saveMcp([...cfg.mcpServers, http ? { id: uid('mcp'), name: name.value.trim(), command: 'http', args: [], url: parts[0]!, transport: 'http', enabled: true, sandbox: 'strict', approval: 'ask' } : { id: uid('mcp'), name: name.value.trim(), command: parts[0]!, args: parts.slice(1), enabled: true, transport: 'stdio', sandbox: 'standard', approval: 'ask' }]);
              },
            },
            t('Add server')
          )
        )
      )
    );
  }
  function policySelect(srv: McpEntry, key: 'sandbox' | 'approval', options: [string, string][]): HTMLElement {
    const sel = h<'select'>('select.input.sp-policy', { 'aria-label': key === 'sandbox' ? t('Sandbox of {name}', { name: srv.name }) : t('Approval rule of {name}', { name: srv.name }) }, ...options.map(([v, l]) => h('option', { value: v, selected: (srv[key] || (key === 'sandbox' ? 'standard' : 'ask')) === v }, l)));
    sel.onchange = () => void saveMcp(cfg.mcpServers.map((x) => (x.id === srv.id ? { ...x, [key]: sel.value } : x)));
    return sel;
  }
  async function saveMcp(list: McpEntry[]) {
    try {
      const r = await api.send<{ config: PublicConfig }>('PUT', '/api/config/mcp', list);
      cfg = r.config;
      render();
    } catch (e) {
      notifyError(e);
    }
  }

  // ---------------------------------------------------------------- Appearance and layout

  function choice<K extends 'theme' | 'renderer' | 'appDownloads' | 'chatSide'>(key: K, label: string, options: [string, string][]): HTMLElement {
    const sel = h<'select'>('select.input', { 'data-pref': key }, ...options.map(([v, l]) => h('option', { value: v, selected: prefs.get(key) === v }, l)));
    sel.onchange = () => prefs.set(key, sel.value as never);
    return h('label.field', h('span', label), sel);
  }
  function toggle(key: 'sounds' | 'autoOpenPanels' | 'statusbar' | 'panelFooters' | 'focusMode', label: string, hint?: string): HTMLElement {
    return h('label.switch', h('input', { type: 'checkbox', 'data-pref': key, checked: prefs.get(key), onchange: (e: Event) => prefs.set(key, (e.target as HTMLInputElement).checked) }), h('span', label, hint ? h('small.muted', ' ' + hint) : null));
  }
  function viewSection(): HTMLElement {
    const unload = h<'select'>('select.input', {}, ...[0, 5, 15, 30, 60].map((m) => h('option', { value: String(m), selected: prefs.get('autoUnloadMinutes') === m }, m ? t('after {n} minutes', { n: m }) : t('never (the state is kept)'))));
    unload.onchange = () => prefs.set('autoUnloadMinutes', Number(unload.value));
    const langSel = h<'select'>('select.input', { 'data-pref': 'lang' }, ...LANGS.map((l) => h('option', { value: l.id, selected: l.id === lang }, LANG_LABELS[l.id])));
    langSel.onchange = () => setLang(langSel.value as 'en' | 'de');
    return h(
      'div.sp-section',
      h('p.eyebrow', t('Appearance and layout')),
      h('h2.duo', t('Interface') + ' ', h('span.tone', t('and performance'))),
      h(
        'div.sp-grid',
        choice('theme', t('Color scheme (IDE, chat and the apps in panels)'), [
          ['system', t('System')],
          ['light', t('Light')],
          ['dark', t('Dark')],
        ]),
        h('label.field', h('span', t('Language of the IDE')), langSel, h('small.muted', t('English is the default. German is optional and applies after a reload.'))),
        choice('renderer', t('Graphics of the apps'), [
          ['auto', t('WebGPU, otherwise WebGL2')],
          ['webgl', t('Always WebGL2')],
        ]),
        choice('appDownloads', t('Saving in apps'), [
          ['project', t('Only into the project')],
          ['both', t('Project and downloads folder')],
        ]),
        h('label.field', h('span', t('Unload hidden apps')), unload)
      ),
      h('p.eyebrow.sp-sub', t('AI chat')),
      h(
        'div.sp-grid',
        choice('chatSide', t('Dock the AI chat sidebar'), [
          ['right', t('Right of the workspace')],
          ['left', t('Left of the workspace')],
        ]),
        h(
          'div.field',
          h('span', t('Full Chat Mode')),
          h('button.btn', { type: 'button', 'data-action': 'full-chat', onclick: () => workspace.setFullChat(true), html: icon('chat', { size: 15 }) + `<span>${t('Open Full Chat Mode')}</span>` }),
          h('small.muted', t('Also with {key} ⇧ J, the chat launcher in the top bar or the address ide/?mode=chat.', { key: 'Ctrl/Cmd' }))
        )
      ),
      h('p.eyebrow.sp-sub', t('Layout')),
      h(
        'div.sp-toggles',
        toggle('focusMode', t('Focus mode'), t('(hides the top bar and the tool rail, {key})', { key: 'Ctrl/Cmd ⇧ F' })),
        toggle('statusbar', t('Status bar at the bottom'), t('(the same details are on the Status page)')),
        toggle('panelFooters', t('Footer line under each panel'), t('(file status, renderer, start time)'))
      ),
      h('p.eyebrow.sp-sub', t('Behavior')),
      h('div.sp-toggles', toggle('autoOpenPanels', t('Open panels when the AI edits a file')), toggle('sounds', t('Sounds')))
    );
  }

  // ---------------------------------------------------------------- Usage and telemetry

  async function usageSection(): Promise<HTMLElement> {
    let store: UsageStore;
    try {
      store = await telemetry.get();
    } catch (e) {
      return h('div.sp-section', h('p.eyebrow', t('Usage and telemetry')), h('p.muted', (e as Error).message));
    }
    const tot = usageTotals(store);
    const kpi = (label: string, value: string) => h('div.sp-kpi.frame.sm', h('div.well', h('span.muted', label), h('strong.mono', value)));
    // Rate table: one row per model seen so far, plus rows already set
    const models = [...new Set([...Object.values(store.rows).filter((r) => !r.local).map((r) => r.model), ...Object.keys(store.rates)])].sort();
    const inputs = new Map<string, { input: HTMLInputElement; output: HTMLInputElement; cached: HTMLInputElement; write: HTMLInputElement }>();
    const numIn = (v: number | undefined, label: string) => h<'input'>('input.input.mono', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: v === undefined ? '' : String(v), 'aria-label': label, placeholder: '0.00' });
    const rateRows = models.map((m) => {
      const r = store.rates[m];
      const row = { input: numIn(r?.input, t('Input rate for {model}', { model: m })), output: numIn(r?.output, t('Output rate for {model}', { model: m })), cached: numIn(r?.cached, t('Cached input rate for {model}', { model: m })), write: numIn(r?.cacheWrite, t('Cache write rate for {model}', { model: m })) };
      inputs.set(m, row);
      return h('tr', { 'data-model': m }, h('td.mono', m), h('td', row.input), h('td', row.cached), h('td', row.write), h('td', row.output));
    });
    const newModel = h<'input'>('input.input.mono', { placeholder: t('model name, for example gpt-5'), 'aria-label': t('Model name') });
    const saveRates = async () => {
      const rates: Record<string, Rate> = {};
      for (const [m, r] of inputs) {
        const input = parseFloat(r.input.value);
        const output = parseFloat(r.output.value);
        const cached = parseFloat(r.cached.value);
        const write = parseFloat(r.write.value);
        if (!isFinite(input) && !isFinite(output)) continue;
        rates[m] = { input: isFinite(input) ? input : 0, output: isFinite(output) ? output : 0, ...(isFinite(cached) ? { cached } : {}), ...(isFinite(write) ? { cacheWrite: write } : {}) };
      }
      const add = newModel.value.trim();
      if (add && !rates[add]) rates[add] = { input: 0, output: 0 };
      try {
        await telemetry.setRates(rates);
        toast(t('Rates saved'), 'success');
        render();
      } catch (e) {
        notifyError(e);
      }
    };
    return h(
      'div.sp-section.sp-usage',
      h('p.eyebrow', t('Usage and telemetry')),
      h('h2.duo', t('API usage') + ' ', h('span.tone', t('across all providers'))),
      h('p.muted', t('Every answer counts its tokens: the exact numbers of the provider, or an estimate (≈) when an endpoint sends none. Only numbers are stored, no content. Since {date}.', { date: new Date(store.since).toLocaleString(lang === 'de' ? 'de-DE' : 'en-US') })),
      h('div.sp-kpis', kpi(t('Requests'), String(tot.requests)), kpi(t('Input tokens'), compactTokens(tot.input)), kpi(t('Output tokens'), compactTokens(tot.output)), kpi(t('Cached tokens'), compactTokens(tot.cached)), kpi(t('Estimated cost'), money(tot.cost))),
      h('p.eyebrow.sp-sub', t('Context cache and thinking')),
      h('p.muted', t('Every provider reports its cache hits: DeepSeek prompt_cache_hit_tokens, ChatGPT cached_tokens, Claude cache_read_input_tokens (and cache writes), Gemini cachedContentTokenCount. Hits are billed at the cached input rate; the savings need both rates below.')),
      h('div.sp-kpis.sp-cache-kpis', kpi(t('Cache hit ratio'), tot.input ? percent(tot.cached / tot.input) : '–'), kpi(t('Cache hits'), compactTokens(tot.cached)), kpi(t('Cache misses'), compactTokens(tot.cacheMiss)), kpi(t('Thinking tokens'), compactTokens(tot.reasoning)), kpi(t('Saved by the cache'), money(tot.savings))),
      h('p.eyebrow.sp-sub', t('Providers side by side')),
      h('p.muted', t('Input, output and thinking tokens, cache hits and misses with the hit ratio and the money the cache saved, time to the first token, speed and the share of successful MCP tool calls.')),
      providerTable(store),
      h('p.eyebrow.sp-sub', t('By provider and model')),
      usageTable(store),
      h('p.eyebrow.sp-sub', t('Rates')),
      h('p.muted', t('US dollars per million tokens, from the price list of your provider. Local models (Ollama) always cost $0.00. Without a rate the cost stays $0.00.')),
      h(
        'div.usage-table.mono.sp-rates',
        h('table', h('thead', h('tr', h('th', t('Model')), h('th', t('Input')), h('th', t('Cached input')), h('th', t('Cache write')), h('th', t('Output')))), h('tbody', rateRows.length ? rateRows : h('tr', h('td', { colspan: '5' }, t('Models appear here after their first request. You can also add one below.')))))
      ),
      h('div.sp-actions', newModel, h('button.btn.primary', { type: 'button', 'data-action': 'save-rates', onclick: () => void saveRates() }, t('Save rates'))),
      h('p.eyebrow.sp-sub', t('Reset')),
      h(
        'div.sp-actions',
        h('button.btn.danger', {
          type: 'button',
          'data-action': 'reset-usage',
          onclick: async () => {
            if (!(await confirmDanger(t('Reset usage statistics'), t('All counted requests and tokens are deleted. The rates stay.'), t('Reset')))) return;
            try {
              await telemetry.reset();
              toast(t('Usage statistics reset'), 'success');
              render();
            } catch (e) {
              notifyError(e);
            }
          },
          html: icon('trash', { size: 14 }) + `<span>${t('Reset usage statistics')}</span>`,
        }),
        h('button.btn', { type: 'button', onclick: () => render(), html: icon('refresh', { size: 14 }) + `<span>${t('Refresh')}</span>` })
      )
    );
  }

  // ---------------------------------------------------------------- Git

  function gitSection(): HTMLElement {
    const name = h<'input'>('input.input', { value: cfg.git.name });
    const email = h<'input'>('input.input.mono', { value: cfg.git.email });
    return h(
      'div.sp-section',
      h('p.eyebrow', 'Git'),
      h('h2.duo', t('Author') + ' ', h('span.tone', t('for commits'))),
      h('div.sp-grid', h('label.field', h('span', t('Name')), name), h('label.field', h('span', t('Email')), email)),
      h(
        'div.sp-actions',
        h(
          'button.btn.primary',
          {
            type: 'button',
            onclick: async () => {
              cfg = await api.send<PublicConfig>('PUT', '/api/config/git', { name: name.value.trim() || 'OpenCraft', email: email.value.trim() || 'lokal@opencraft' });
              toast(t('Git author saved'), 'success');
            },
          },
          t('Save')
        )
      )
    );
  }

  // ---------------------------------------------------------------- iPad and network

  async function deviceSection(): Promise<HTMLElement> {
    const d = device.info;
    const remote = document.documentElement.dataset.backend === 'remote';
    const modeText = backend.browser ? t('Browser mode (IndexedDB)') : remote ? t('Desktop PC on the home network') : t('Desktop backend on this computer');
    const wm: Record<string, string> = { full: t('Full screen'), stage: 'Stage Manager', split: 'Split View', slide: t('Slide Over or narrow') };
    const out = h(
      'div.sp-section.sp-device',
      h('p.eyebrow', 'iPadOS'),
      h('h2.duo', 'iPad ', h('span.tone', t('and network'))),
      h(
        'div.frame.sp-card',
        { 'data-card': 'device' },
        h(
          'div.well',
          h('div.sp-card-head', h('h3.duo', t('This device') + ' ', h('span.tone', d.ipad ? 'iPad' : d.touch ? 'Touch' : 'Desktop'))),
          h(
            'div.sp-kvs',
            row(t('Mode'), modeText, false),
            row(t('iPadOS detected'), d.ipad ? t('yes (touch hardware, desktop identifier)') : t('no')),
            row(t('Input'), [d.touch ? t('Finger') : '', d.fine ? t('Pencil or trackpad') : '', d.hover ? t('Hover') : ''].filter(Boolean).join(' · ') || t('Mouse')),
            row(t('Window'), `${wm[d.windowMode]} · ${d.orientation === 'portrait' ? t('portrait') : t('landscape')} · ${Math.round(d.viewport.width)} × ${Math.round(d.viewport.height)}`),
            row(t('Pixel ratio'), `${d.dpr} (${t('apps')} ${d.renderDpr})`),
            row(t('Graphics of the apps'), wantsWebgl() ? (d.secure ? 'WebGL2' : t('WebGL2 (HTTP on the home network, no WebGPU)')) : 'WebGPU'),
            row(t('Offline cache'), d.secure ? t('available') : t('not over HTTP (service workers need HTTPS)'))
          )
        )
      )
    );

    // ---------- Desktop: share on the home network ----------
    if (!backend.browser && !remote) {
      const lan = await api.get<LanInfo>('/api/lan').catch(() => null);
      if (lan) {
        const tokenEl = h<'input'>('input.input.mono', { value: lan.token || '', readonly: true, type: 'password', 'aria-label': t('Access token') });
        const show = h<'button'>('button.btn.ghost', { type: 'button', onclick: () => (tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password') }, t('Show'));
        const copy = h<'button'>('button.btn.ghost', { type: 'button', onclick: () => void navigator.clipboard?.writeText(lan.token || '').then(() => toast(t('Token copied'), 'success')) }, t('Copy'));
        const rotate = h<'button'>('button.btn.ghost.danger', {
          type: 'button',
          onclick: async () => {
            if (!(await confirmDanger(t('New access token'), t('Paired devices have to pair again afterwards.'), t('Renew')))) return;
            await api.send('POST', '/api/lan/token');
            render();
          },
        }, t('Renew'));
        const enabled = h<'input'>('input', { type: 'checkbox', checked: lan.enabled, 'data-lan-toggle': '' });
        enabled.onchange = async () => {
          const r = await api.send<{ enabled: boolean; restart: boolean }>('PUT', '/api/lan', { enabled: enabled.checked });
          toast(r.enabled ? t('Home network mode on') : t('Home network mode off'), 'success', r.restart ? t('Takes effect after restarting the backend (npm start or npm run dev).') : undefined);
          render();
        };
        out.append(
          h(
            'div.frame.sp-card',
            { 'data-card': 'lan' },
            h(
              'div.well',
              h('div.sp-card-head', h('h3.duo', t('Home network') + ' ', h('span.tone', lan.active ? t('active') : t('off'))), h('span.spacer'), h('label.switch', enabled, h('span', t('Share on Wi-Fi')))),
              h('p.muted', t('The backend then listens on 0.0.0.0. Other devices need the access token. The iPad uses the projects, the real terminal, Git and Ollama of this PC. Ollama stays local, only the backend talks to it.')),
              h('label.field', h('span', t('Access token')), h('div.sp-inline', tokenEl, show, copy, rotate)),
              lan.active
                ? h('div.sp-urls', h('span.muted', t('Open on the iPad in Safari (pairs once):')), ...lan.urls.map((u) => h('code.mono.sp-url', u)))
                : h('p.muted', lan.enabled ? t('Switched on. Restart the backend, then the addresses show up here.') : t('Start without this setting: npm run dev:lan or npm run start:lan.'))
            )
          )
        );
      }
    }

    // ---------- iPad: connect to the desktop ----------
    const saved = savedDesktop();
    const host = h<'input'>('input.input.mono', { value: saved.host, placeholder: '192.168.178.20', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('IP address of the desktop PC'), 'data-field': 'lan-host' });
    const port = h<'input'>('input.input.mono', { value: saved.port, inputmode: 'numeric', 'aria-label': 'Port', 'data-field': 'lan-port' });
    const token = h<'input'>('input.input.mono', { value: saved.token, type: 'password', placeholder: t('Access token from the desktop'), autocomplete: 'off', 'data-field': 'lan-token' });
    const remember = h<'input'>('input', { type: 'checkbox', checked: !!saved.token });
    allowScribble(host);
    const connect = h<'button'>('button.btn.primary', {
      type: 'button',
      'data-action': 'lan-connect',
      onclick: () => {
        const ip = host.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const pt = port.value.trim() || '5175';
        if (!/^[\w.-]+$/.test(ip) || !/^\d{2,5}$/.test(pt)) return toast(t('Check the IP address and port'), 'warning', t('Example: 192.168.178.20 and 5175'));
        if (!token.value.trim()) return toast(t('The access token is missing'), 'warning', t('It is on the desktop in the settings under iPad and network.'));
        try {
          localStorage.setItem(DESKTOP_KEY, JSON.stringify({ host: ip, port: pt, token: remember.checked ? token.value.trim() : '' }));
        } catch {
          /* storage blocked */
        }
        location.href = `http://${ip}:${pt}/pair?token=${encodeURIComponent(token.value.trim())}`;
      },
    }, t('Connect to desktop'));
    out.append(
      h(
        'div.frame.sp-card',
        { 'data-card': 'connect' },
        h(
          'div.well',
          h('div.sp-card-head', h('h3.duo', t('Desktop PC') + ' ', h('span.tone', t('on the home network')))),
          h('p.muted', t('Enter the local IP address of the desktop PC. OpenCraft then opens the IDE straight from the PC, on the same Wi-Fi. On the road the IDE switches to browser mode by itself.')),
          h('div.sp-grid', h('label.field', h('span', t('IP address')), host), h('label.field', h('span', 'Port'), port), h('label.field', h('span', t('Access token')), token)),
          h('label.switch', remember, h('span', t('Remember the token on this device'))),
          h('div.sp-actions', connect, h('small.muted', t('Over HTTP on the home network the apps run with WebGL2. Service workers and WebGPU need HTTPS.')))
        )
      )
    );

    // ---------- Browser mode: keys and file exchange ----------
    if (backend.browser) {
      const { keyStore, importFiles, wipeBrowserData } = await import('../../app/offline.js');
      const persist = h<'input'>('input', { type: 'checkbox', checked: keyStore.persistent, 'data-keys-persist': '' });
      persist.onchange = async () => {
        if (persist.checked) {
          const ok = await confirmDanger(t('Store API keys permanently'), t('The keys for Claude, ChatGPT, Gemini and DeepSeek are then stored unencrypted in the browser storage (localStorage) of this iPad. Any extension or person with access to this device and browser profile can read them. Use keys with a spending limit.'), t('Allow storing'));
          if (!ok) return void (persist.checked = false);
        }
        keyStore.setPersistent(persist.checked);
        toast(persist.checked ? t('Keys are stored in this browser') : t('Keys only until the next reload'), 'info');
        await aiConfig.changed();
      };
      const fileIn = h<'input'>('input', { type: 'file', multiple: true, hidden: true, 'data-import-files': '' });
      fileIn.onchange = async () => {
        const list = [...(fileIn.files || [])];
        fileIn.value = '';
        if (!list.length) return;
        const paths = await importFiles(list);
        await fs.reload();
        toast(tn(paths.length, '{n} file imported', '{n} files imported'), 'success', paths.join(', '));
      };
      const pick = h<'select'>('select.input.mono', { 'aria-label': t('File to export') }, ...fs.files().map((f) => h('option', { value: f.path }, f.path)));
      out.append(
        h(
          'div.frame.sp-card.sp-warn',
          { 'data-card': 'keys' },
          h(
            'div.well',
            h('div.sp-card-head', h('h3.duo', t('API keys') + ' ', h('span.tone', t('in the browser')))),
            h(
              'div.frame.sm.sp-notice.is-warn',
              h('div.well', h('span', { html: icon('alert', { size: 16 }) }), h('p', h('strong', t('Local storage:') + ' '), t('Without the desktop backend there is no protected key store. Only allow storing on your own iPad. Without permission keys last until the page reloads.')))
            ),
            h('label.switch', persist, h('span', t('Store keys for Claude, ChatGPT, Gemini and DeepSeek in this browser'))),
            h('div.sp-actions', h('button.btn', { type: 'button', onclick: () => ((section = 'ai'), render()) }, t('Enter keys')))
          )
        ),
        h(
          'div.frame.sp-card',
          { 'data-card': 'files' },
          h(
            'div.well',
            h('div.sp-card-head', h('h3.duo', t('Files') + ' ', h('span.tone', t('exchange')))),
            h('p.muted', t('The iPadOS file dialog opens the Files app, iCloud Drive and connected drives. Export uses the share sheet (Save to Files).')),
            h(
              'div.sp-actions',
              h('button.btn', { type: 'button', 'data-action': 'import-files', html: icon('upload', { size: 16 }) + `<span>${t('Import files')}</span>`, onclick: () => fileIn.click() }),
              h('button.btn', { type: 'button', 'data-action': 'import-zip', html: icon('archive', { size: 16 }) + `<span>${t('Import project ZIP')}</span>`, onclick: () => projects.pickZip() }),
              h('button.btn', {
                type: 'button',
                'data-action': 'export-zip',
                html: icon('download', { size: 16 }) + `<span>${t('Project as ZIP')}</span>`,
                onclick: async () => {
                  const p = projects.current;
                  if (!p) return;
                  const bytes = await api.bytes(`/api/projects/${encodeURIComponent(p.id)}/export`);
                  await shareOrDownload(new Blob([bytes], { type: 'application/zip' }), `${p.name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}.zip`);
                },
              })
            ),
            h(
              'div.sp-inline',
              pick,
              h('button.btn', {
                type: 'button',
                'data-action': 'export-file',
                onclick: async () => {
                  if (!pick.value) return;
                  const data = await fs.readBinary(normPath(pick.value));
                  await shareOrDownload(new Blob([data]), basename(pick.value));
                },
              }, t('Export file'))
            ),
            fileIn
          )
        ),
        h(
          'div.sp-actions',
          h('button.btn.ghost.danger', {
            type: 'button',
            onclick: async () => {
              if (!(await confirmDanger(t('Delete browser data'), t('All projects, chats and keys of browser mode on this device are deleted.'), t('Delete everything')))) return;
              await wipeBrowserData();
              keyStore.setPersistent(false);
              location.reload();
            },
          }, t('Delete browser data'))
        )
      );
    }
    return out;
  }

  const offOpen = bus.on('open-settings', (s) => {
    if (s && SECTIONS.some(([id]) => id === s)) {
      section = s as Section;
      render();
    }
  });
  // The Status page updates itself while it is open
  const refreshStatus = () => section === 'status' && el.isConnected && !el.closest('[hidden]') && body.replaceChildren(statusSection());
  const offs = [bus.on('workspace:change', refreshStatus), bus.on('workspace:resources', refreshStatus), bus.on('status:change', refreshStatus), bus.on('ai:status', refreshStatus), bus.on('ws:state', refreshStatus)];
  const tick = setInterval(refreshStatus, 2000);
  await reload();
  ctx.setStatus(t('Configuration in the local backend'));

  return {
    open: async () => {},
    getScroll: () => ({ top: body.scrollTop, left: 0 }),
    setScroll: (s) => void (body.scrollTop = s.top),
    status: () => ({ section, standard: cfg.ai.active }),
    unmount() {
      offOpen();
      for (const off of offs) off();
      clearInterval(tick);
      root.remove();
    },
  };
}
