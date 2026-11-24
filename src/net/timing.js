/**
 * net/timing.js — часы гостя, буфер снимков, интерполяция, адаптивная задержка (без DOM).
 *
 * Три шкалы времени у гостя (все — во «времени симуляции хоста», секунды):
 *   E = est(now)   — время хоста «по самому быстрому снимку» (отстаёт от настоящего на мин. задержку в одну сторону);
 *   V = E − delay  — время показа чужих игроков (интерполяция между снимками, delay растёт с джиттером);
 *   R = E + lead   — «своё» время: ввод, отправленный сейчас, придёт к хосту примерно к R.
 *                    В нём предсказывается свой игрок и детерминированный полёт волана к себе.
 */

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * Оценка смещения часов: off = max(T − recv) по скользящему окну (~2 с).
 * Окно, а не вечный максимум: если симуляция хоста отстаёт от реального времени
 * (подвисания, фоновая вкладка), оценка за пару секунд сползает вниз вслед за ней.
 */
export function createClock(windowSec = 2) {
  const c = {
    off: null,            // с: hostT − localSec для самого быстрого снимка в окне
    win: [],              // [localSec, o]
    jit: [],              // разброс прихода сверх минимума, с
    sample(T, localSec) {
      const o = T - localSec;
      c.win.push([localSec, o]);
      while (c.win.length > 1 && localSec - c.win[0][0] > windowSec) c.win.shift();
      let m = -Infinity; for (const w of c.win) if (w[1] > m) m = w[1];
      c.off = m;
      c.jit.push(Math.max(0, c.off - o)); if (c.jit.length > 90) c.jit.shift();
    },
    reset() { c.win = []; c.jit = []; c.off = null; },
    est(localSec) { return c.off == null ? 0 : localSec + c.off; },
    jitterP(p = 0.9) {
      if (!c.jit.length) return 0;
      const s = c.jit.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
    },
  };
  return c;
}

/** Буфер снимков, упорядоченный по времени хоста. */
export function createSnapBuffer(max = 40) {
  const b = {
    list: [],
    lastN: -1,
    interval: 0.05,       // средний интервал между снимками, с
    push(s) {
      const last = b.list[b.list.length - 1];
      if (last && (s.n <= last.n || s.T < last.T)) return false;   // старый/переставленный снимок
      if (last) b.interval = b.interval * 0.9 + Math.min(0.5, s.T - last.T) * 0.1;
      b.list.push(s); b.lastN = s.n;
      if (b.list.length > max) b.list.splice(0, b.list.length - max);
      return true;
    },
    latest() { return b.list[b.list.length - 1] || null; },
    /** Пара снимков вокруг t: {a, b, k} (k ∈ [0,1]); при нехватке — экстраполяция не делается (держим последний). */
    at(t) {
      const L = b.list;
      if (!L.length) return null;
      if (t <= L[0].T) return { a: L[0], b: L[0], k: 0 };
      let i = L.length - 1;
      while (i > 0 && L[i].T > t) i--;
      const A = L[i], B = L[i + 1];
      if (!B) return { a: A, b: A, k: 0 };
      return { a: A, b: B, k: clamp((t - A.T) / Math.max(1e-6, B.T - A.T), 0, 1) };
    },
    trim(t) { while (b.list.length > 3 && b.list[1].T < t - 1) b.list.shift(); },
  };
  return b;
}

export function lerp(a, b, k) { return a + (b - a) * k; }

/** Интерполяция строки игрока (см. codec.decodePlayer); большие скачки (телепорт к подаче) — без смешивания. */
export function lerpPlayer(pa, pb, k) {
  const jump = Math.hypot(pb.x - pa.x, pb.y - pa.y) > 1.2;
  const kk = jump ? (k < 0.5 ? 0 : 1) : k;
  const src = kk < 0.5 ? pa : pb;
  return { x: lerp(pa.x, pb.x, kk), y: lerp(pa.y, pb.y, kk), z: lerp(pa.z, pb.z, kk), vx: lerp(pa.vx, pb.vx, kk), vy: lerp(pa.vy, pb.vy, kk), action: src.action, whiffN: src.whiffN, swingA: pa.swing, swingB: pb.swing };
}

/**
 * Целевая задержка показа: джиттер p90 + запас на интервал снимков.
 * dmin/dmax зависят от канала (ретранслятор — больше запас).
 */
export function targetDelay(jitP90, interval, dmin, dmax) {
  return clamp(jitP90 + interval * 1.25 + 0.012, dmin, dmax);
}

/** Плавное движение величины к цели: вверх быстрее (rateUp/с), вниз медленнее. */
export function slew(cur, target, dt, rateUp, rateDown) {
  const d = target - cur;
  return cur + clamp(d, -rateDown * dt, rateUp * dt);
}

/**
 * Темп «часов волана» τ: догоняем цель τ* за время Tc, без рывков.
 * Возвращает новое τ.
 */
export function advanceShuttleClock(tau, target, dt, Tc) {
  const gap = target - tau;
  if (Math.abs(gap) > 1.5) return target;   // новый розыгрыш/долгий обрыв — сразу
  const rate = clamp(1 + gap / Math.max(0.12, Tc), 0.35, 3.2);
  let t = tau + dt * rate;
  if (gap > 0 && t > target) t = target;   // не перелетаем цель
  return t;
}
