/**
 * controlsSettings.js — настройки управления и раздел «Управление» в паузе.
 *
 * Хранение: localStorage 'volan.settings' → поле `controls` (остальные поля
 * объекта не трогаем: читаем, дописываем, пишем обратно). Всё в try/catch —
 * без хранилища игра работает на значениях по умолчанию.
 * После сохранения шлётся событие window 'volan:settings' {detail: весь объект}
 * и 'volan:controls' {detail: controls}.
 *
 * API:
 *   CONTROL_DEFAULTS
 *   loadControls() -> Controls
 *   saveControls(patch) -> Controls
 *   onControlsChange(fn) -> unsubscribe
 *   buildControlsSection() -> HTMLElement   — секция для меню паузы
 *
 * Controls: {
 *   touchMode: 'buttons'|'swipes',   кнопки (по умолчанию) или жесты
 *   assist: 'auto'|'off'|'light'|'strong',  сила автобега (auto: новичок — сильный)
 *   buttonSize: 's'|'m'|'l',
 *   leftHanded: boolean,             зеркально: джойстик справа, кнопки слева
 *   vibration: boolean
 * }
 */
export const SETTINGS_KEY = 'volan.settings';

export const CONTROL_DEFAULTS = Object.freeze({
  touchMode: 'buttons',
  assist: 'auto',
  buttonSize: 'm',
  leftHanded: false,
  vibration: true,
});

const ALLOWED = {
  touchMode: ['buttons', 'swipes'],
  assist: ['auto', 'off', 'light', 'strong'],
  buttonSize: ['s', 'm', 'l'],
};

function readAll() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(SETTINGS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch (_) { return {}; }
}

function sanitize(c) {
  const out = { ...CONTROL_DEFAULTS };
  if (c && typeof c === 'object') {
    for (const k of Object.keys(ALLOWED)) if (ALLOWED[k].includes(c[k])) out[k] = c[k];
    if (typeof c.leftHanded === 'boolean') out.leftHanded = c.leftHanded;
    if (typeof c.vibration === 'boolean') out.vibration = c.vibration;
  }
  return out;
}

let cache = null;

export function loadControls() {
  const all = readAll();
  const c = sanitize(all.controls);
  // Общий флаг вибрации из основных настроек (если его ведёт меню).
  if (typeof all.vibration === 'boolean' && !(all.controls && typeof all.controls.vibration === 'boolean')) c.vibration = all.vibration;
  cache = c;
  return { ...c };
}

const listeners = new Set();
export function onControlsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function saveControls(patch = {}) {
  const next = sanitize({ ...(cache || loadControls()), ...patch });
  cache = next;
  const all = readAll();
  all.controls = { ...next };
  try { globalThis.localStorage && localStorage.setItem(SETTINGS_KEY, JSON.stringify(all)); } catch (_) { /* приватный режим */ }
  for (const fn of listeners) { try { fn({ ...next }); } catch (e) { console.error(e); } }
  try {
    if (globalThis.dispatchEvent && globalThis.CustomEvent) {
      dispatchEvent(new CustomEvent('volan:controls', { detail: { ...next } }));
      dispatchEvent(new CustomEvent('volan:settings', { detail: { ...all } }));
    }
  } catch (_) { /* старые браузеры */ }
  return { ...next };
}

// ---------------------------------------------------------------- DOM (пауза)
const STYLE_ID = 'volan-controls-style';
const CSS = `
.ctl-section{margin:10px 0 4px;padding:12px 12px 4px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);text-align:left}
.ctl-section h3{margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.7;font-weight:700}
.ctl-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px;margin:0 0 10px}
.ctl-row>span{font-size:14px;opacity:.9;flex:0 0 auto}
.ctl-seg{display:flex;flex-wrap:nowrap;gap:3px;margin-left:auto;background:rgba(0,0,0,.25);border-radius:10px;padding:3px}
.ctl-seg button{appearance:none;border:0;border-radius:8px;padding:7px 10px;min-height:34px;white-space:nowrap;font:600 13px system-ui,sans-serif;color:inherit;background:transparent;cursor:pointer;touch-action:manipulation}
.ctl-seg button.on{background:rgba(255,255,255,.9);color:#0e1a2b}
.ctl-note{font-size:12px;opacity:.6;margin:-4px 0 10px}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID; st.textContent = CSS;
  document.head.append(st);
}

function seg(key, options, current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl-seg'; wrap.setAttribute('role', 'radiogroup'); wrap.dataset.ctl = key;
  for (const [val, label] of options) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.value = String(val);
    b.className = val === current ? 'on' : '';
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(val === current));
    b.addEventListener('click', () => {
      for (const x of wrap.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
      onPick(val);
    });
    wrap.append(b);
  }
  return wrap;
}

function row(label, control) {
  const r = document.createElement('div');
  r.className = 'ctl-row';
  const s = document.createElement('span'); s.textContent = label;
  r.append(s, control);
  return r;
}

/** Секция «Управление» для паузы. Перестраивается при каждом вызове refresh(). */
export function buildControlsSection() {
  ensureStyle();
  const sec = document.createElement('div');
  sec.className = 'ctl-section'; sec.id = 'controlsSettings';
  function refresh() {
    const c = loadControls();
    sec.textContent = '';
    const h = document.createElement('h3'); h.textContent = 'Управление';
    sec.append(h);
    sec.append(row('Удары', seg('touchMode', [['buttons', 'Кнопки'], ['swipes', 'Свайпы']], c.touchMode, v => saveControls({ touchMode: v }))));
    sec.append(row('Автобег', seg('assist', [['off', 'Выкл'], ['light', 'Лёгкий'], ['strong', 'Сильный']],
      c.assist === 'auto' ? null : c.assist, v => saveControls({ assist: v }))));
    if (c.assist === 'auto') {
      const n = document.createElement('div'); n.className = 'ctl-note';
      n.textContent = 'Сейчас авто: на «Новичке» сильный, иначе лёгкий';
      sec.append(n);
    }
    sec.append(row('Кнопки', seg('buttonSize', [['s', 'S'], ['m', 'M'], ['l', 'L']], c.buttonSize, v => saveControls({ buttonSize: v }))));
    sec.append(row('Левша', seg('leftHanded', [[false, 'Нет'], [true, 'Да']], c.leftHanded, v => saveControls({ leftHanded: v }))));
    sec.append(row('Вибрация', seg('vibration', [[true, 'Вкл'], [false, 'Выкл']], c.vibration, v => saveControls({ vibration: v }))));
  }
  refresh();
  onControlsChange(refresh);
  sec.refresh = refresh;
  return sec;
}
