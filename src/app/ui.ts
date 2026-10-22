// Dialogs and menus in the .frame/.well style.
import { h } from './util.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

export interface DialogField {
  name: string;
  label: string;
  value?: string;
  mono?: boolean;
  type?: string;
  placeholder?: string;
  textarea?: boolean;
}
export interface DialogOptions {
  title: string;
  tone?: string;
  body?: Node | string;
  fields?: DialogField[];
  ok?: string | false;
  cancel?: string;
  danger?: boolean;
  wide?: boolean;
  validate?: (values: Record<string, string>) => string | null;
  onOpen?: (close: () => void) => void;
}

export function dialog(o: DialogOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const form = h<'form'>('form.well', { method: 'dialog' });
    form.append(h('div.dlg-head', h('h3.duo', o.title, ' ', o.tone ? h('span.tone', o.tone) : null)));
    if (o.body) form.append(typeof o.body === 'string' ? h('p.muted.dlg-text', o.body) : o.body);
    const inputs: (HTMLInputElement | HTMLTextAreaElement)[] = [];
    for (const f of o.fields || []) {
      const inp = f.textarea
        ? h<'textarea'>('textarea.input' + (f.mono ? '.mono' : ''), { name: f.name, rows: 8, placeholder: f.placeholder || '', spellcheck: 'false' })
        : h<'input'>('input.input' + (f.mono ? '.mono' : ''), { name: f.name, type: f.type || 'text', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
      inp.value = f.value || '';
      inputs.push(inp);
      form.append(h('label.field', h('span', f.label), inp));
    }
    const err = h('p.dlg-error', { role: 'alert', hidden: true });
    form.append(err);
    const cancel = h<'button'>('button.btn.ghost', { type: 'button' }, o.cancel || t('Cancel'));
    const ok = o.ok === false ? null : h<'button'>('button.btn' + (o.danger ? '.danger' : '.primary'), { type: 'submit' }, o.ok || 'OK');
    form.append(h('div.dlg-actions', cancel, ok));
    const dlg = h<'dialog'>('dialog.modal' + (o.wide ? '.wide' : ''), h('div.frame.lg', form));
    document.body.append(dlg);
    let result: Record<string, string> | null = null;
    cancel.onclick = () => dlg.close();
    form.onsubmit = (e) => {
      e.preventDefault();
      const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      const problem = o.validate?.(values);
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      result = o.fields ? values : {};
      dlg.close();
    };
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.showModal();
    o.onOpen?.(() => dlg.close());
    (inputs[0] || ok || cancel).focus();
  });
}

export async function promptText(title: string, label: string, value = '', tone?: string): Promise<string | null> {
  const r = await dialog({ title, tone, fields: [{ name: 'v', label, value, mono: true }] });
  return r ? r.v!.trim() : null;
}

export async function confirmDanger(title: string, text: string, ok = t('Delete')): Promise<boolean> {
  return !!(await dialog({ title, body: text, ok, danger: true }));
}

export interface MenuItem {
  label: string;
  icon?: string;
  html?: string;
  hint?: string;
  danger?: boolean;
  /** Shows a check mark (on or off state) */
  checked?: boolean;
  run: () => void;
}
/** An item, a separator ('-') or a small heading above a group */
export type MenuEntry = MenuItem | '-' | { heading: string };

export function menu(items: MenuEntry[], x: number, y: number, opt: { alignRight?: boolean } = {}): () => void {
  document.querySelector('.ctx-menu')?.remove();
  const well = h('div.well.flush');
  const list = h('div.ctx-menu.frame.sm', { role: 'menu' }, well);
  for (const it of items) {
    if (it === '-') {
      well.append(h('hr'));
      continue;
    }
    if ('heading' in it) {
      well.append(h('div.ctx-heading.eyebrow', it.heading));
      continue;
    }
    const check = it.checked === undefined ? '' : `<span class="ctx-check" aria-hidden="true">${it.checked ? icon('check', { size: 14 }) : ''}</span>`;
    const b = h<'button'>('button.ctx-item' + (it.danger ? '.danger' : '') + (it.checked ? '.is-checked' : ''), {
      role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
      ...(it.checked === undefined ? {} : { 'aria-checked': String(it.checked) }),
      type: 'button',
      html: (it.html || (it.icon ? icon(it.icon, { size: 16 }) : '')) + `<span>${it.label}</span>` + (it.hint ? `<kbd>${it.hint}</kbd>` : '') + check,
    });
    b.onclick = () => {
      close();
      it.run();
    };
    well.append(b);
  }
  document.body.append(list);
  const r = list.getBoundingClientRect();
  if (opt.alignRight) x -= r.width;
  list.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  list.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  list.querySelector('button')?.focus();
  const outside = (e: PointerEvent) => {
    if (!list.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const bs = [...list.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
      e.preventDefault();
    }
  };
  function close() {
    list.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', keys, true);
  }
  setTimeout(() => {
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', keys, true);
  });
  return close;
}

/**
 * Small card anchored below a button (usage of the chat, for example). Closes on a tap outside,
 * on Escape and when the anchor's window closes. Uses the anchor's document, so it also works in a
 * native picture-in-picture window.
 */
export function popover(anchor: HTMLElement, content: Node, opt: { width?: number; label?: string } = {}): () => void {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView || window;
  doc.querySelector('.pop-card')?.remove();
  const card = h('div.pop-card.frame.sm', { role: 'dialog', 'aria-label': opt.label || '' }, h('div.well', content));
  if (opt.width) card.style.width = `${opt.width}px`;
  doc.body.append(card);
  const place = () => {
    const a = anchor.getBoundingClientRect();
    const r = card.getBoundingClientRect();
    const vw = win.innerWidth;
    const vh = win.visualViewport?.height || win.innerHeight;
    card.style.left = `${Math.max(8, Math.min(a.right - r.width, vw - r.width - 8))}px`;
    const below = a.bottom + 6;
    card.style.top = `${below + r.height > vh - 8 ? Math.max(8, a.top - r.height - 6) : below}px`;
  };
  place();
  const outside = (e: PointerEvent) => {
    if (!card.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const keys = (e: KeyboardEvent) => e.key === 'Escape' && close();
  function close() {
    card.remove();
    win.removeEventListener('pointerdown', outside, true);
    win.removeEventListener('keydown', keys, true);
    win.removeEventListener('resize', place);
  }
  setTimeout(() => {
    win.addEventListener('pointerdown', outside, true);
    win.addEventListener('keydown', keys, true);
    win.addEventListener('resize', place);
  });
  return close;
}
