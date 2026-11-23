/**
 * input.js — сенсор + клавиатура → абстрактные команды.
 *
 * Сенсор (pointer events, мультитач):
 *   сторона джойстика (слева; у левши — справа) — плавающий джойстик: появляется там,
 *     где коснулся палец, тянется за пальцем, мёртвая зона + аналоговая скорость;
 *   сторона ударов — режим «Кнопки» (по умолчанию): «Удар» (умный), «Клир»,
 *     «Смэш/Дроп», «Сетка»; удар срабатывает НА КАСАНИЕ (без задержки),
 *     направление — от джойстика в момент нажатия; тап мимо кнопок — «Удар»;
 *   режим «Свайпы»: касание сразу даёт предварительный умный удар, свайп
 *     уточняет его (вверх длинный — клир, вверх короткий — сетка, вниз — смэш/дроп,
 *     вбок — направление).
 * Клавиатура: WASD/стрелки — бег; J/Z — клир, K/X — смэш/дроп, L/C — сетка,
 *   пробел/Shift/Enter — умный удар/подача; Esc/P — пауза.
 *
 * Команды выдаются в ЭКРАННЫХ координатах (x вправо, y вверх);
 * перевод в мир — screenDirToWorldAt() (локально в точке игрока).
 *
 * Публичный API (не менять сигнатуры):
 *   createInput(element, opts?) -> Input
 *   input.poll(dt) -> { move:{x,y}, held:boolean, shots:Array<Shot>, pause:boolean }
 *     Shot: {type, dirX, dirY, at, source:'button'|'tap'|'swipe'|'key', gid?, phase:'provisional'|'final'}
 *   input.state  — {joystick:{active,bx,by,kx,ky,radius,mag}, gestures:[], touchSeen, keys:Set,
 *                   controls, layout, pressed:{[btnId]:{t}}, ripples:[]}
 *   input.setEnabled(bool)
 *   input.setControls(controls)   — см. controlsSettings.js
 *   input.haptic(ms|pattern)      — вибрация (если включена и поддерживается)
 *   input.inject(shot)            — для автотестов
 *   input.destroy()
 *   computeLayout(w, h, controls) -> Layout   (экспорт; используется и отрисовкой)
 *   screenDirToWorldAt(renderer, sx, sy, wx, wy) -> {x, y}
 */
import { loadControls, CONTROL_DEFAULTS } from './controlsSettings.js';

const SHOT_KEYS = {
  KeyJ: 'clear', KeyK: 'smashdrop', KeyL: 'net', Space: 'smart',
  KeyZ: 'clear', KeyX: 'smashdrop', KeyC: 'net', ShiftLeft: 'smart', ShiftRight: 'smart', Enter: 'smart', NumpadEnter: 'smart',
};
const MOVE_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

const SIZE_SCALE = { s: 0.84, m: 1, l: 1.2 };
/** Кнопки: id, тип удара, подпись, подпись на подаче, угол (градусы, 0 — вправо, против часовой). */
const BUTTONS = [
  { id: 'smart', type: 'smart', label: 'Удар', serve: 'короткая', main: true },
  { id: 'clear', type: 'clear', label: 'Клир', serve: 'длинная', angle: 92 },
  { id: 'smashdrop', type: 'smashdrop', label: 'Смэш', label2: 'Дроп', serve: 'длинная', angle: 138 },
  { id: 'net', type: 'net', label: 'Сетка', serve: 'короткая', angle: 184 },
];

/**
 * Раскладка кнопок для размера экрана. Основная кнопка в углу, остальные — дугой вокруг.
 * @returns {{w,h,mirrored,joySide:'left'|'right',buttons:Array<{id,type,label,label2?,serve,x,y,r,main}>, hudH:number}}
 */
export function computeLayout(w, h, controls = CONTROL_DEFAULTS) {
  const k = SIZE_SCALE[controls.buttonSize] || 1;
  const portrait = h > w * 1.05;
  const base = Math.max(36, Math.min(54, Math.min(w, h) * 0.118)) * k;
  const rs = base * 0.66;
  const margin = portrait ? 18 : 22;
  const mirrored = !!controls.leftHanded;
  let cx = w - margin - base - (portrait ? 4 : 18);
  const cy = h - margin - base - (portrait ? 34 : 6);
  const buttons = [];
  for (const b of BUTTONS) {
    let x = cx, y = cy, r = base;
    if (!b.main) {
      const d = base + rs + Math.max(10, base * 0.24);
      const a = b.angle * Math.PI / 180;
      x = cx + Math.cos(a) * d; y = cy - Math.sin(a) * d; r = rs;
    }
    if (mirrored) x = w - x;
    buttons.push({ ...b, x, y, r });
  }
  return { w, h, mirrored, joySide: mirrored ? 'right' : 'left', buttons, hudH: portrait ? 74 : 56 };
}

/**
 * Экранное направление → мировое в точке (wx, wy) пола: обратная матрица Якоби
 * проекции, чтобы «вверх по экрану» было вверх ИМЕННО там, где стоит игрок
 * (в перспективе глобальный вектор камеры ошибается до ~30° у краёв корта).
 * Длина результата = длине входа.
 */
export function screenDirToWorldAt(renderer, sx, sy, wx, wy) {
  const len = Math.hypot(sx, sy);
  if (!len) return { x: 0, y: 0 };
  if (!renderer || !renderer.project || wx == null) return renderer.screenDirToWorld(sx, sy);
  const e = 0.05;
  const p0 = renderer.project(wx, wy, 0), px = renderer.project(wx + e, wy, 0), py = renderer.project(wx, wy + e, 0);
  // Экранные производные (y экрана вверх).
  const a = (px.x - p0.x) / e, c = -(px.y - p0.y) / e;   // d(screen)/d(world x)
  const b = (py.x - p0.x) / e, d = -(py.y - p0.y) / e;   // d(screen)/d(world y)
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-9) return renderer.screenDirToWorld(sx, sy);
  const ux = sx / len, uy = sy / len;
  let x = (d * ux - b * uy) / det, y = (-c * ux + a * uy) / det;
  const l = Math.hypot(x, y) || 1;
  return { x: x / l * len, y: y / l * len };
}

export function createInput(el, opts = {}) {
  const state = {
    joystick: { active: false, id: null, bx: 0, by: 0, kx: 0, ky: 0, radius: 58, mag: 0, t0: 0 },
    gestures: [],          // след свайпа {x0,y0,x1,y1,age}
    touchSeen: false,
    keys: new Set(),
    controls: opts.controls || loadControls(),
    layout: null,
    pressed: {},           // id кнопки → {t, pointerId, held}
    ripples: [],           // {x, y, r, age, kind}
    lastMove: { x: 0, y: 0 },
  };
  let enabled = true;
  const shots = [];
  let pauseReq = false;
  let gidSeq = 1;
  const pointers = new Map(); // pointerId → {role:'joy'|'btn'|'swipe'|'ignore', ...}

  const TAP_MAX = 16, SWIPE_MIN = 34, LONG_SWIPE = 95;
  const DEAD = 0.14;     // мёртвая зона (доля радиуса)

  function rect() { return el.getBoundingClientRect(); }
  function layout() {
    const r = rect();
    const w = Math.round(r.width), h = Math.round(r.height);
    const L = state.layout;
    if (!L || L.w !== w || L.h !== h || L._c !== state.controls) {
      state.layout = computeLayout(w, h, state.controls);
      state.layout._c = state.controls;
    }
    return state.layout;
  }

  function haptic(p) {
    if (!state.controls.vibration) return;
    try { if (navigator.vibrate) navigator.vibrate(p); } catch (_) { /* не поддерживается */ }
  }

  function hitButton(L, x, y) {
    let best = null, bd = Infinity;
    for (const b of L.buttons) {
      const d = Math.hypot(x - b.x, y - b.y);
      // Щедрая зона касания: +30% радиуса (+20 px для основной).
      const lim = b.main ? b.r * 1.25 + 8 : b.r * 1.3;
      if (d < lim && d / b.r < bd) { bd = d / b.r; best = b; }
    }
    return best;
  }

  function buttonsVisible() {
    return state.controls.touchMode === 'buttons' && (state.touchSeen || coarse());
  }

  function pushShot(type, src, extra = {}) {
    const mv = state.lastMove;
    shots.push({ type, dirX: mv.x, dirY: mv.y, at: performance.now(), source: src, phase: 'final', ...extra });
  }

  function onDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = rect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') state.touchSeen = true;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const L = layout();
    const joySide = L.joySide === 'left' ? x < r.width * 0.5 : x >= r.width * 0.5;
    const j = state.joystick;
    if (buttonsVisible()) {
      const b = hitButton(L, x, y);
      if (b) { pressButton(b, e.pointerId); return; }
    }
    if (joySide) {
      if (j.active) { pointers.set(e.pointerId, { role: 'ignore' }); return; } // второй палец на джойстике — не удар
      j.active = true; j.id = e.pointerId; j.bx = x; j.by = y; j.kx = x; j.ky = y; j.mag = 0; j.t0 = performance.now();
      j.radius = Math.max(46, Math.min(72, Math.min(r.width, r.height) * 0.15));
      pointers.set(e.pointerId, { role: 'joy' });
      return;
    }
    if (state.controls.touchMode === 'buttons') {
      // Тап по стороне ударов мимо кнопок — «Удар».
      const main = L.buttons.find(b => b.main);
      pressButton(main, e.pointerId, { x, y });
      return;
    }
    // Свайпы: сразу предварительный умный удар (без задержки), свайп уточнит.
    const gid = gidSeq++;
    pointers.set(e.pointerId, { role: 'swipe', x0: x, y0: y, x1: x, y1: y, t0: performance.now(), final: false, gid });
    shots.push({ type: 'smart', dirX: 0, dirY: 0, at: performance.now(), source: 'tap', gid, phase: 'provisional' });
    haptic(8);
  }

  function pressButton(b, pointerId, at) {
    pointers.set(pointerId, { role: 'btn', id: b.id });
    state.pressed[b.id] = { t: performance.now(), pointerId, held: true };
    state.ripples.push({ x: b.x, y: b.y, r: b.r, age: 0, kind: 'press', id: b.id });
    if (at) state.ripples.push({ x: at.x, y: at.y, r: 18, age: 0, kind: 'tap' });
    if (state.ripples.length > 8) state.ripples.splice(0, state.ripples.length - 8);
    pushShot(b.type, 'button', { button: b.id });
    haptic(10);
  }

  function classify(sw, final) {
    const dx = sw.x1 - sw.x0, dy = sw.y1 - sw.y0; // экранные: y вниз
    const d = Math.hypot(dx, dy);
    if (d < SWIPE_MIN) return final ? { type: 'smart', dirX: 0, dirY: 0 } : null;
    const up = -dy, side = dx;
    const dirX = Math.max(-1, Math.min(1, side / 90));
    if (Math.abs(side) > Math.abs(up) * 1.4) return { type: 'smart', dirX: Math.sign(side), dirY: 0 };
    if (up > 0) {
      if (d >= LONG_SWIPE) return { type: 'clear', dirX, dirY: 1 };
      return final ? { type: 'net', dirX, dirY: 1 } : null;
    }
    return { type: 'smashdrop', dirX, dirY: -1 };
  }

  function finalizeSwipe(sw, c) {
    sw.final = true;
    shots.push({ ...c, at: performance.now(), source: 'swipe', gid: sw.gid, phase: 'final', swipe: true });
    if (Math.hypot(sw.x1 - sw.x0, sw.y1 - sw.y0) >= TAP_MAX) state.gestures.push({ x0: sw.x0, y0: sw.y0, x1: sw.x1, y1: sw.y1, age: 0 });
  }

  function onMove(e) {
    if (!enabled) return;
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    e.preventDefault();
    const r = rect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const j = state.joystick;
    if (pt.role === 'joy' && j.active && e.pointerId === j.id) {
      let dx = x - j.bx, dy = y - j.by;
      const d = Math.hypot(dx, dy);
      if (d > j.radius) {
        // База «тянется» за пальцем — не нужно возвращать палец к центру.
        const k = (d - j.radius) / d;
        j.bx += dx * k; j.by += dy * k;
        dx = x - j.bx; dy = y - j.by;
      }
      j.kx = j.bx + dx; j.ky = j.by + dy;
      return;
    }
    if (pt.role === 'swipe' && !pt.final) {
      pt.x1 = x; pt.y1 = y;
      // Длинный свайп и свайп вниз/вбок срабатывают сразу, не дожидаясь отпускания.
      const c = classify(pt, false);
      if (c && (c.type === 'clear' || c.type === 'smashdrop' || (c.type === 'smart' && c.dirX !== 0)) && Math.hypot(x - pt.x0, y - pt.y0) >= SWIPE_MIN + 10) finalizeSwipe(pt, c);
    }
  }

  function release(e, cancelled) {
    const pt = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    const j = state.joystick;
    if (j.active && e.pointerId === j.id) { j.active = false; j.id = null; j.mag = 0; return; }
    if (!pt) return;
    if (pt.role === 'btn') {
      const p = state.pressed[pt.id];
      if (p && p.pointerId === e.pointerId) p.held = false;
      return;
    }
    if (pt.role === 'swipe' && !pt.final && !cancelled && enabled) {
      const r = rect();
      pt.x1 = e.clientX - r.left; pt.y1 = e.clientY - r.top;
      const c = classify(pt, true);
      if (c) finalizeSwipe(pt, c);
    }
  }
  const onUp = e => release(e, false);
  const onCancel = e => release(e, true);

  function onKey(e, down) {
    const code = e.code;
    if (code === 'Escape' || code === 'KeyP') { if (down && !e.repeat) pauseReq = true; return; }
    if (!enabled) return;
    if (MOVE_KEYS[code] || SHOT_KEYS[code]) e.preventDefault();
    if (down) {
      if (SHOT_KEYS[code] && !state.keys.has(code) && !e.repeat) {
        const m = keyMove();
        shots.push({ type: SHOT_KEYS[code], dirX: m.x, dirY: m.y, at: performance.now(), key: true, source: 'key', phase: 'final' });
      }
      state.keys.add(code);
    } else state.keys.delete(code);
  }

  function keyMove() {
    let x = 0, y = 0;
    for (const k of state.keys) { const v = MOVE_KEYS[k]; if (v) { x += v[0]; y += v[1]; } }
    const l = Math.hypot(x, y);
    return l ? { x: x / l, y: y / l } : { x: 0, y: 0 };
  }

  function resetPointers() {
    for (const id of pointers.keys()) { try { el.releasePointerCapture(id); } catch (_) { /* ignore */ } }
    pointers.clear();
    state.joystick.active = false; state.joystick.id = null; state.joystick.mag = 0;
    for (const k in state.pressed) state.pressed[k].held = false;
  }

  let mq = null;
  function coarse() {
    try { mq = mq || matchMedia('(pointer: coarse)'); return mq.matches; } catch (_) { return false; }
  }

  const kd = e => onKey(e, true), ku = e => onKey(e, false);
  const blur = () => { state.keys.clear(); resetPointers(); };
  // Поворот экрана — сбрасываем касания (pointercancel приходит не везде).
  // Обычный resize (адресная строка) касания не трогает.
  let wasLandscape = innerWidth > innerHeight;
  const onOrient = () => { resetPointers(); state.layout = null; wasLandscape = innerWidth > innerHeight; };
  const relayout = () => {
    state.layout = null;
    const ls = innerWidth > innerHeight;
    if (ls !== wasLandscape) onOrient();
  };
  const prevent = e => { if (e.cancelable) e.preventDefault(); };
  const onLost = e => { if (pointers.has(e.pointerId)) release(e, true); };
  el.addEventListener('pointerdown', onDown, { passive: false });
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', onUp, { passive: false });
  el.addEventListener('pointercancel', onCancel, { passive: false });
  el.addEventListener('lostpointercapture', onLost);
  el.addEventListener('touchstart', prevent, { passive: false });
  el.addEventListener('touchmove', prevent, { passive: false });
  el.addEventListener('touchend', prevent, { passive: false });
  el.addEventListener('contextmenu', prevent);
  el.addEventListener('selectstart', prevent);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  window.addEventListener('blur', blur);
  window.addEventListener('orientationchange', onOrient);
  window.addEventListener('resize', relayout);
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('dblclick', prevent, { passive: false });
  const onCtl = e => { if (e.detail) api.setControls(e.detail); };
  window.addEventListener('volan:controls', onCtl);

  const api = {
    state,
    poll(dt = 1 / 60) {
      for (const g of state.gestures) g.age += dt;
      state.gestures = state.gestures.filter(g => g.age < 0.4);
      for (const r of state.ripples) r.age += dt;
      state.ripples = state.ripples.filter(r => r.age < 0.5);
      let move = keyMove();
      const j = state.joystick;
      if (j.active) {
        const dx = (j.kx - j.bx) / j.radius, dy = -(j.ky - j.by) / j.radius;
        const l = Math.hypot(dx, dy);
        if (l > DEAD) {
          // Аналог: скорость растёт от края мёртвой зоны, полная — чуть раньше края круга.
          const u = Math.min(1, (l - DEAD) / (1 - DEAD - 0.08));
          const k = u / l;
          move = { x: dx * k, y: dy * k };
        } else move = { x: 0, y: 0 };
        j.mag = Math.hypot(move.x, move.y);
      }
      state.lastMove = move;
      const out = { move, held: j.active, shots: shots.splice(0), pause: pauseReq };
      pauseReq = false;
      return out;
    },
    setEnabled(b) { enabled = !!b; if (!b) blur(); },
    setControls(c) { state.controls = { ...CONTROL_DEFAULTS, ...c }; state.layout = null; },
    haptic,
    get layout() { return layout(); },
    buttonsVisible,
    /** Для автотестов: эмулировать команду. */
    inject(shot) { shots.push({ dirX: 0, dirY: 0, at: performance.now(), phase: 'final', ...shot }); },
    destroy() {
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onLost);
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur);
      window.removeEventListener('orientationchange', onOrient); window.removeEventListener('resize', relayout);
      window.removeEventListener('volan:controls', onCtl);
    },
  };
  return api;
}
