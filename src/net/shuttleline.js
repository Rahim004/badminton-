/**
 * net/shuttleline.js — полёт волана у гостя как функция времени (без DOM).
 *
 * Между ударами полёт полностью детерминирован (physics.stepShuttle), поэтому хост шлёт
 * только начало отрезка (состояние в момент вылета + время), а гость сам считает,
 * где волан будет в любой момент — в том числе «в будущем» (время R, см. timing.js).
 * Отрезки: авторитетные (от хоста) и предсказанные (свой удар гостя до подтверждения).
 */
import { PHYSICS } from '../config.js';
import { stepShuttle } from '../physics.js';

const DT = PHYSICS.DT;
const MAX_STEPS = 120 * 6;

export function makeSeg(id, t0, st, predicted = false) {
  const s = { ...st };
  return { id, t0, st: s, predicted, samples: null, netAt: -1, landAt: -1 };
}

/** Досчитать траекторию отрезка (лениво, до индекса n). */
function ensure(seg, n) {
  if (!seg.samples) {
    const s0 = seg.st;
    seg.samples = [{ x: s0.x, y: s0.y, z: s0.z, vx: s0.vx, vy: s0.vy, vz: s0.vz, state: s0.state, netHit: !!s0.netHit }];
    seg.cur = { x: s0.x, y: s0.y, z: s0.z, vx: s0.vx, vy: s0.vy, vz: s0.vz, state: s0.state, netHit: !!s0.netHit, drag: PHYSICS.DRAG };
  }
  const S = seg.samples, c = seg.cur;
  n = Math.min(n, MAX_STEPS);
  while (S.length <= n) {
    const ev = stepShuttle(c, DT);
    if (ev === 'net' && seg.netAt < 0) seg.netAt = S.length;
    if (ev === 'land' && seg.landAt < 0) seg.landAt = S.length;
    S.push({ x: c.x, y: c.y, z: c.z, vx: c.vx, vy: c.vy, vz: c.vz, state: c.state, netHit: c.netHit });
    if (c.state === 'ground') { while (S.length <= n) S.push(S[S.length - 1]); break; }
  }
}

/** Состояние волана на отрезке в момент t (линейная интерполяция между шагами). */
export function sampleSeg(seg, t) {
  const st = seg.st;
  if (st.state === 'held' || st.state === 'ground') return { x: st.x, y: st.y, z: st.z, vx: 0, vy: 0, vz: 0, state: st.state, netHit: !!st.netHit, i: 0 };
  const f = Math.max(0, (t - seg.t0) / DT);
  const i = Math.floor(f);
  ensure(seg, i + 1);
  const S = seg.samples, n = S.length - 1;
  const a = S[Math.min(i, n)], b = S[Math.min(i + 1, n)], k = Math.min(1, f - i);
  if (a.state === 'ground') return { ...a, i };
  const L = (p, q) => p + (q - p) * k;
  return { x: L(a.x, b.x), y: L(a.y, b.y), z: Math.max(0, L(a.z, b.z)), vx: L(a.vx, b.vx), vy: L(a.vy, b.vy), vz: L(a.vz, b.vz), state: b.state === 'ground' ? 'flight' : a.state, netHit: a.netHit, i };
}

/** Время события отрезка ('net' | 'land') или null, если его не будет (в пределах 6 с). */
export function segEventTime(seg, kind) {
  if (seg.st.state !== 'flight' && seg.st.state !== 'net') return null;
  ensure(seg, MAX_STEPS);
  const i = kind === 'net' ? seg.netAt : seg.landAt;
  return i < 0 ? null : seg.t0 + i * DT;
}

/** Через сколько секунд после t волан окажется на стороне side (0 — уже там; null — не окажется). */
export function timeToSide(seg, t, side) {
  if (seg.st.state !== 'flight') return null;
  const i0 = Math.max(0, Math.floor((t - seg.t0) / DT));
  ensure(seg, i0 + 400);
  const S = seg.samples;
  for (let i = i0; i < S.length && i < i0 + 400; i++) {
    if (Math.sign(S[i].x) === side) return Math.max(0, (i - i0) * DT);
    if (S[i].state === 'ground') return null;
  }
  return null;
}

/**
 * Набор отрезков: выбирает действующий в момент t.
 * Авторитетный отрезок с тем же id заменяет предсказанный.
 */
export function createTimeline() {
  const L = {
    segs: [],
    put(seg) {
      const i = L.segs.findIndex(s => s.id === seg.id);
      if (i >= 0) {
        const old = L.segs[i];
        if (!seg.predicted && (old.predicted || Math.abs(old.t0 - seg.t0) > 1e-4 || differs(old.st, seg.st))) { L.segs[i] = seg; return 'replaced'; }
        return 'same';
      }
      // Новый розыгрыш (id меньше — сброс) или новый удар.
      L.segs.push(seg);
      L.segs.sort((a, b) => a.t0 - b.t0 || a.id - b.id);
      if (L.segs.length > 6) L.segs.splice(0, L.segs.length - 6);
      return 'added';
    },
    drop(id) { L.segs = L.segs.filter(s => s.id !== id); },
    /** Отрезок, действующий в момент t. */
    at(t) {
      let best = null;
      for (const s of L.segs) if (s.t0 <= t + 1e-6 && (!best || s.t0 > best.t0 || (s.t0 === best.t0 && s.id > best.id))) best = s;
      return best || L.segs[0] || null;
    },
    latest() { return L.segs[L.segs.length - 1] || null; },
    clear() { L.segs = []; },
  };
  return L;
}

function differs(a, b) {
  return Math.abs(a.x - b.x) > 0.002 || Math.abs(a.y - b.y) > 0.002 || Math.abs(a.z - b.z) > 0.002 || Math.abs(a.vx - b.vx) > 0.01 || Math.abs(a.vy - b.vy) > 0.01 || Math.abs(a.vz - b.vz) > 0.01 || a.state !== b.state;
}
