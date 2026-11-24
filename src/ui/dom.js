/**
 * ui/dom.js — мелкие помощники интерфейса.
 *   h(tag, attrs, ...children)       — создать элемент (on* — обработчики, class, style-строка, прочее — атрибуты)
 *   seg(name, options, current, onPick) — переключатель-сегменты (.seg > .seg-btn[data-value])
 *   copyText(text) -> Promise<'copied'|'selected'|'failed'> — буфер обмена с запасным вариантом
 *   toast(text, kind)                — всплывающая строка внизу (kind: 'ok' | 'err')
 *   icon(name)                       — встроенные SVG-иконки
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export function seg(name, options, current, onPick) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'data-name': name });
  for (const [val, label] of options) {
    const b = h('button', { class: 'seg-btn' + (val === current ? ' on' : ''), 'data-value': String(val), type: 'button', role: 'radio', 'aria-checked': String(val === current) }, label);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.seg-btn').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      onPick(val);
    });
    wrap.append(b);
  }
  wrap.set = v => wrap.querySelectorAll('.seg-btn').forEach(x => { const on = x.dataset.value === String(v); x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
  return wrap;
}

export async function copyText(text, selectEl) {
  try {
    if (navigator.clipboard && globalThis.isSecureContext) { await navigator.clipboard.writeText(text); return 'copied'; }
  } catch (_) { /* нет прав — запасной путь */ }
  // Запасной путь: выделить текст в поле и execCommand('copy').
  let el = selectEl, temp = false;
  if (!el) {
    el = h('textarea', { class: 'copy-temp', readonly: true, 'aria-hidden': 'true' });
    el.value = text; document.body.append(el); temp = true;
  }
  try {
    el.focus({ preventScroll: true }); el.select(); if (el.setSelectionRange) el.setSelectionRange(0, text.length);
    const ok = document.execCommand && document.execCommand('copy');
    return ok ? 'copied' : 'selected';
  } catch (_) { return temp ? 'failed' : 'selected'; }
  finally { if (temp) el.remove(); }
}

let toastEl = null, toastT = 0;
export function toast(text, kind = 'ok') {
  if (!toastEl) { toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); (document.getElementById('ui') || document.body).append(toastEl); }
  toastEl.textContent = text;
  toastEl.className = 'toast show ' + kind;
  clearTimeout(toastT);
  toastT = setTimeout(() => { toastEl.className = 'toast ' + kind; }, 2600);
}

const ICONS = {
  back: '<path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M5 15V5a1 1 0 0 1 1-1h9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  share: '<path d="M12 15V4m0 0-4 4m4-4 4 4M5 13v6h14v-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><circle cx="9" cy="10" r="1.3" fill="currentColor"/><circle cx="12" cy="10" r="1.3" fill="currentColor"/><circle cx="15" cy="10" r="1.3" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  x: '<path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  robot: '<rect x="5" y="8" width="14" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9.5" cy="13" r="1.4" fill="currentColor"/><circle cx="14.5" cy="13" r="1.4" fill="currentColor"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  shuttle: '<path d="M12 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M9 18 5 4l4 2 3-3 3 3 4-2-4 14Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 3v15M9 6l.8 12M15 6l-.8 12" stroke="currentColor" stroke-width="1.2" opacity=".7"/>',
  gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="15" cy="7" r="2.4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="9" cy="17" r="2.4" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  people: '<circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16.5" cy="9" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 14c2.4 0 4 1.5 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  play: '<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
  s.innerHTML = ICONS[name] || '';
  return s;
}
