/**
 * input.js — сенсор + клавиатура → абстрактные команды.
 *
 * Сенсор (pointer events):
 *   левая половина экрана — плавающий виртуальный джойстик (движение);
 *   правая половина — жесты:
 *     тап                  → 'smart' (умный удар / подача)
 *     свайп вверх длинный  → 'clear'
 *     свайп вверх короткий → 'net'  (сетка / укороченный)
 *     свайп вниз           → 'smash' (если волан низко — игра превратит в укороченный/драйв)
 *     свайп вбок           → 'smart' с направлением
 * Клавиатура: WASD/стрелки — движение; J — клир, K — смэш/драйв, L — дроп/сетка,
 *   пробел — умный удар/подача; Esc/P — пауза.
 *
 * Команды выдаются в ЭКРАННЫХ координатах (x вправо, y вверх);
 * перевод в мир делает main.js через renderer.screenDirToWorld.
 *
 * Публичный API (не менять сигнатуры):
 *   createInput(element, opts?) -> Input
 *   input.poll() -> { move:{x,y}, shots:Array<{type, dirX, dirY, at}>, pause:boolean }
 *   input.state  — {joystick:{active,bx,by,kx,ky,radius}, gestures:[], touchSeen, keys:Set}
 *   input.setEnabled(bool)
 *   input.destroy()
 */

const SHOT_KEYS = { KeyJ: 'clear', KeyK: 'smash', KeyL: 'net', Space: 'smart' };
const MOVE_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

export function createInput(el, opts = {}) {
  const state = {
    joystick: { active: false, id: null, bx: 0, by: 0, kx: 0, ky: 0, radius: 58 },
    gestures: [],          // для отрисовки следа свайпа {x0,y0,x1,y1,age}
    touchSeen: false,
    keys: new Set(),
  };
  let enabled = true;
  const shots = [];
  let pauseReq = false;
  const swipes = new Map(); // pointerId → {x0,y0,t0,fired}

  const TAP_MAX = 16, SWIPE_MIN = 34, LONG_SWIPE = 95;

  function rect() { return el.getBoundingClientRect(); }

  function onDown(e) {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = rect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') state.touchSeen = true;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const leftZone = x < r.width * 0.5;
    // Мышь на ПК: левая половина тоже джойстик (удобно для тестов), но клавиатура приоритетна.
    if (leftZone && !state.joystick.active) {
      const j = state.joystick;
      j.active = true; j.id = e.pointerId; j.bx = x; j.by = y; j.kx = x; j.ky = y;
      j.radius = Math.max(44, Math.min(70, r.width * 0.13));
    } else {
      swipes.set(e.pointerId, { x0: x, y0: y, t0: performance.now(), fired: false, x1: x, y1: y });
    }
  }

  function classify(sw, final) {
    const dx = sw.x1 - sw.x0, dy = sw.y1 - sw.y0; // экранные: y вниз
    const d = Math.hypot(dx, dy);
    if (d < TAP_MAX) return final ? { type: 'smart', dirX: 0, dirY: 0 } : null;
    if (d < SWIPE_MIN) return final ? { type: 'smart', dirX: 0, dirY: 0 } : null;
    const up = -dy, side = dx;
    const dirX = Math.max(-1, Math.min(1, side / 90));
    if (Math.abs(side) > Math.abs(up) * 1.4) return { type: 'smart', dirX: Math.sign(side), dirY: 0 };
    if (up > 0) {
      if (d >= LONG_SWIPE) return { type: 'clear', dirX, dirY: 1 };
      return final ? { type: 'net', dirX, dirY: 1 } : null;
    }
    return { type: 'smash', dirX, dirY: -1 };
  }

  function fire(sw, c) {
    sw.fired = true;
    shots.push({ ...c, at: performance.now() });
    state.gestures.push({ x0: sw.x0, y0: sw.y0, x1: sw.x1, y1: sw.y1, age: 0 });
  }

  function onMove(e) {
    if (!enabled) return;
    const r = rect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const j = state.joystick;
    if (j.active && e.pointerId === j.id) {
      e.preventDefault();
      let dx = x - j.bx, dy = y - j.by;
      const d = Math.hypot(dx, dy);
      if (d > j.radius) {
        // Джойстик «тянется» за пальцем.
        const k = (d - j.radius) / d;
        j.bx += dx * k; j.by += dy * k;
        dx = x - j.bx; dy = y - j.by;
      }
      j.kx = j.bx + dx; j.ky = j.by + dy;
      return;
    }
    const sw = swipes.get(e.pointerId);
    if (sw && !sw.fired) {
      e.preventDefault();
      sw.x1 = x; sw.y1 = y;
      // Длинный свайп и свайп вниз срабатывают сразу, не дожидаясь отпускания (меньше задержка).
      const c = classify(sw, false);
      if (c && (c.type === 'clear' || c.type === 'smash' || (c.type === 'smart' && c.dirX !== 0)) && Math.hypot(x - sw.x0, y - sw.y0) >= SWIPE_MIN + 10) fire(sw, c);
    }
  }

  function onUp(e) {
    const j = state.joystick;
    if (j.active && e.pointerId === j.id) { j.active = false; j.id = null; return; }
    const sw = swipes.get(e.pointerId);
    if (sw) {
      swipes.delete(e.pointerId);
      if (!enabled || sw.fired) return;
      const r = rect();
      sw.x1 = e.clientX - r.left; sw.y1 = e.clientY - r.top;
      const c = classify(sw, true);
      if (c) fire(sw, c);
    }
  }

  function onKey(e, down) {
    const code = e.code;
    if (code === 'Escape' || code === 'KeyP') { if (down) pauseReq = true; return; }
    if (!enabled) return;
    if (MOVE_KEYS[code] || SHOT_KEYS[code]) e.preventDefault();
    if (down) {
      if (SHOT_KEYS[code] && !state.keys.has(code)) {
        const m = keyMove();
        shots.push({ type: SHOT_KEYS[code], dirX: m.x, dirY: m.y, at: performance.now(), key: true });
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

  const kd = e => onKey(e, true), ku = e => onKey(e, false);
  const blur = () => { state.keys.clear(); state.joystick.active = false; swipes.clear(); };
  const prevent = e => e.preventDefault();
  el.addEventListener('pointerdown', onDown, { passive: false });
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', onUp, { passive: false });
  el.addEventListener('pointercancel', onUp, { passive: false });
  el.addEventListener('touchstart', prevent, { passive: false });
  el.addEventListener('touchmove', prevent, { passive: false });
  el.addEventListener('contextmenu', prevent);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  window.addEventListener('blur', blur);
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('dblclick', prevent, { passive: false });

  return {
    state,
    poll(dt = 1 / 60) {
      for (const g of state.gestures) g.age += dt;
      state.gestures = state.gestures.filter(g => g.age < 0.4);
      let move = keyMove();
      const j = state.joystick;
      if (j.active) {
        const dx = (j.kx - j.bx) / j.radius, dy = -(j.ky - j.by) / j.radius;
        const l = Math.hypot(dx, dy);
        const dead = 0.12;
        if (l > dead) { const k = Math.min(1, (l - dead) / (1 - dead)) / l; move = { x: dx * k, y: dy * k }; }
        else move = { x: 0, y: 0 };
      }
      const out = { move, shots: shots.splice(0), pause: pauseReq };
      pauseReq = false;
      return out;
    },
    setEnabled(b) { enabled = !!b; if (!b) blur(); },
    /** Для автотестов: эмулировать команду. */
    inject(shot) { shots.push({ dirX: 0, dirY: 0, at: performance.now(), ...shot }); },
    destroy() {
      el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); window.removeEventListener('blur', blur);
    },
  };
}
