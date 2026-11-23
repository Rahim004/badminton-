/**
 * ui.js — минимальные DOM-экраны: меню, пауза, конец матча, подсказки.
 * Визуальный агент сделает красиво; логика и колбэки — здесь.
 *
 * Публичный API (не менять сигнатуры):
 *   createUI(root, handlers) -> UI
 *     handlers: { onStart(opts), onPause(), onResume(), onQuit(), onRestart() }
 *   ui.showMenu() / ui.showPause() / ui.showGameOver(info) / ui.hideAll()
 *   ui.setHint(text|null)       — короткая подсказка внизу экрана
 *   ui.settings                 — {mode, difficulty, format, assist}
 *   ui.attach(game)             — подписки на события (подсказки подачи и т.п.)
 */
import { DIFFICULTY, DIFFICULTY_ORDER, MATCH_FORMATS } from './config.js';
import { buildControlsSection, loadControls } from './controlsSettings.js';

const STORE_KEY = 'volan.settings.v1';

function loadSettings() {
  const def = { mode: 'singles', difficulty: 'amateur', format: 'quick', assist: true };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return s ? { ...def, ...s } : def;
  } catch (_) { return def; }
}
function saveSettings(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (_) { /* приватный режим */ } }

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

export function createUI(root, handlers = {}) {
  const settings = loadSettings();
  const screens = {};

  function segmented(name, options, current, onPick) {
    const wrap = h('div', { class: 'seg', role: 'radiogroup', 'data-name': name });
    for (const [val, label] of options) {
      const b = h('button', { class: 'seg-btn' + (val === current ? ' on' : ''), 'data-value': val, type: 'button' }, label);
      b.addEventListener('click', () => {
        wrap.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('on', x === b));
        onPick(val);
      });
      wrap.append(b);
    }
    return wrap;
  }

  // --- меню ---
  const menu = h('div', { class: 'screen menu', id: 'menu' },
    h('div', { class: 'card' },
      h('h1', { class: 'logo' }, 'Волан'),
      h('p', { class: 'tag' }, 'бадминтон в браузере'),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, 'Режим'),
        segmented('mode', [['singles', '1 × 1'], ['doubles', '2 × 2']], settings.mode, v => { settings.mode = v; saveSettings(settings); })),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, 'Сложность'),
        segmented('difficulty', DIFFICULTY_ORDER.map(k => [k, DIFFICULTY[k].label]), settings.difficulty, v => { settings.difficulty = v; saveSettings(settings); })),
      h('div', { class: 'row' }, h('div', { class: 'lbl' }, 'Матч'),
        segmented('format', Object.entries(MATCH_FORMATS).map(([k, f]) => [k, f.label]), settings.format, v => { settings.format = v; saveSettings(settings); })),
      h('label', { class: 'check' },
        (() => { const c = h('input', { type: 'checkbox', id: 'assist' }); c.checked = settings.assist; c.addEventListener('change', () => { settings.assist = c.checked; saveSettings(settings); }); return c; })(),
        h('span', {}, 'Автобег и подсказка приземления')),
      h('button', { class: 'btn primary', id: 'start', type: 'button', onclick: () => handlers.onStart?.({ ...settings }) }, 'Играть'),
      h('p', { class: 'help' }, 'Телефон: слева — джойстик, справа — кнопки «Удар», «Клир», «Смэш/Дроп», «Сетка» (свайпы — в паузе → Управление). ПК: WASD/стрелки — бег, пробел/Shift — удар, J/Z — клир, K/X — смэш/дроп, L/C — сетка.'),
    ));
  // --- пауза (+ раздел «Управление») ---
  const controlsSection = buildControlsSection();
  const pause = h('div', { class: 'screen pause hidden', id: 'pause' },
    h('div', { class: 'card small' },
      h('h2', {}, 'Пауза'),
      h('button', { class: 'btn primary', type: 'button', id: 'resume', onclick: () => handlers.onResume?.() }, 'Продолжить'),
      h('button', { class: 'btn', type: 'button', onclick: () => handlers.onRestart?.() }, 'Заново'),
      h('button', { class: 'btn', type: 'button', onclick: () => handlers.onQuit?.() }, 'В меню'),
      controlsSection,
    ));
  // --- конец матча ---
  const overTitle = h('h2', {}, '');
  const overScore = h('p', { class: 'score-line' }, '');
  const overStats = h('p', { class: 'help' }, '');
  const over = h('div', { class: 'screen over hidden', id: 'over' },
    h('div', { class: 'card small' }, overTitle, overScore, overStats,
      h('button', { class: 'btn primary', type: 'button', id: 'again', onclick: () => handlers.onRestart?.() }, 'Ещё матч'),
      h('button', { class: 'btn', type: 'button', onclick: () => handlers.onQuit?.() }, 'В меню'),
    ));
  // --- кнопка паузы и подсказка ---
  const pauseBtn = h('button', { class: 'pause-btn hidden', id: 'pauseBtn', type: 'button', 'aria-label': 'Пауза', onclick: () => handlers.onPause?.() }, '❚❚');
  const hint = h('div', { class: 'hint hidden', id: 'hint' }, '');
  root.append(menu, pause, over, pauseBtn, hint);
  Object.assign(screens, { menu, pause, over });

  function only(name) {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
    pauseBtn.classList.toggle('hidden', name !== null);
  }

  const ui = {
    settings,
    showMenu() { only('menu'); ui.setHint(null); },
    showPause() { controlsSection.refresh(); only('pause'); },
    showGameOver(info) {
      overTitle.textContent = info.won ? 'Победа!' : 'Поражение';
      overScore.textContent = info.gameScores.map(g => `${g[info.team]}:${g[1 - info.team]}`).join('  ·  ');
      overStats.textContent = info.statsText || '';
      only('over');
      ui.setHint(null);
    },
    hideAll() { only(null); },
    setHint(text) {
      hint.textContent = text || '';
      hint.classList.toggle('hidden', !text);
    },
    attach(game) {
      game.on('serveReady', e => {
        if (e.human) {
          const touch = matchMedia('(pointer: coarse)').matches;
          const c = loadControls();
          ui.setHint(!touch ? 'Подача: пробел — короткая, J — длинная (влево/вправо — направление)'
            : c.touchMode === 'swipes' ? 'Подача: тап — короткая, свайп вверх — длинная'
            : null); // режим кнопок: подписи «короткая/длинная» на самих кнопках (нижняя подсказка их перекрывала)
        } else ui.setHint(null);
      });
      game.on('serve', () => ui.setHint(null));
    },
  };
  return ui;
}
