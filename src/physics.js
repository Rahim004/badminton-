/**
 * physics.js — полёт волана.
 *
 * Модель: a = -g·ẑ - k·|v|·v (сильное квадратичное сопротивление).
 * Интегрирование полу-неявное: гравитация явно, сопротивление неявно
 *   v ← (v - g·dt·ẑ) / (1 + k·|v|·dt);  p ← p + v·dt
 * Это безусловно устойчиво даже при скорости смэша 50 м/с и даёт
 * одинаковый результат в симуляции и в прогнозе (одна и та же функция).
 *
 * Публичный API (не менять сигнатуры):
 *   createShuttle() -> Shuttle
 *   stepShuttle(sh, dt) -> null | 'net' | 'land'
 *   predictLanding(state, maxT?) -> { x, y, t, netHit, crossT, crossZ }
 *   predictTrajectory(state, maxT?, stride?) -> Array<{t,x,y,z,vx,vy,vz}>
 *   integrateStep(s, dt)   — «голый» шаг без сетки/пола (для солвера ударов)
 */
import { PHYSICS, COURT } from './config.js';

const G = PHYSICS.GRAVITY;

/** @typedef {{x:number,y:number,z:number,vx:number,vy:number,vz:number,
 *   state:'held'|'flight'|'net'|'ground', netHit:boolean, lastHitTeam:number,
 *   lastHitter:number, hits:number, isServe:boolean}} Shuttle */

export function createShuttle() {
  return {
    x: 0, y: 0, z: 1, vx: 0, vy: 0, vz: 0,
    state: 'held',      // held — в руке подающего, flight — летит, net — упал с сетки, ground — на полу
    netHit: false,
    lastHitTeam: -1,
    lastHitter: -1,
    hits: 0,            // ударов в текущем розыгрыше (включая подачу)
    isServe: false,
    drag: PHYSICS.DRAG, // можно менять (например «тяжёлый волан» в тренировке)
  };
}

/** Один шаг интегрирования без столкновений. Мутирует s. */
export function integrateStep(s, dt, drag = PHYSICS.DRAG) {
  s.vz -= G * dt;
  const sp = Math.hypot(s.vx, s.vy, s.vz);
  const f = 1 / (1 + drag * sp * dt);
  s.vx *= f; s.vy *= f; s.vz *= f;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
}

/**
 * Шаг симуляции с сеткой и полом. Возвращает событие:
 *  'net'  — волан врезался в сетку (дальше падает на сторону удара);
 *  'land' — коснулся пола (s.state = 'ground').
 */
export function stepShuttle(s, dt) {
  if (s.state === 'held' || s.state === 'ground') return null;
  const px = s.x, pz = s.z;
  integrateStep(s, dt, s.drag ?? PHYSICS.DRAG);
  let ev = null;
  // Пересечение плоскости сетки x = 0.
  if (!s.netHit && Math.sign(px) !== Math.sign(s.x) && px !== 0) {
    const t = px / (px - s.x);                 // доля шага до пересечения
    const zc = pz + (s.z - pz) * t;
    const yc = s.y; // y меняется мало за шаг
    if (zc < COURT.NET_HEIGHT && zc > 0 && Math.abs(yc) <= COURT.NET_POST_Y + 0.05) {
      const side = Math.sign(px);
      s.x = side * PHYSICS.NET_THICKNESS;
      s.z = zc;
      s.vx = -s.vx * PHYSICS.NET_DAMP;
      s.vy *= 0.2;
      s.vz = Math.min(s.vz, 0) * 0.2;
      s.netHit = true;
      s.state = 'net';
      ev = 'net';
    }
  }
  if (s.z <= 0) {
    s.z = 0;
    s.vx = s.vy = s.vz = 0;
    s.state = 'ground';
    ev = 'land';
  }
  return ev;
}

function cloneState(st) {
  return {
    x: st.x, y: st.y, z: st.z, vx: st.vx, vy: st.vy, vz: st.vz,
    state: st.state === 'held' ? 'flight' : st.state, netHit: !!st.netHit, drag: st.drag ?? PHYSICS.DRAG,
  };
}

/**
 * Прогноз точки приземления интегрированием той же физики.
 * @param {{x,y,z,vx,vy,vz}} state
 * @returns {{x:number,y:number,t:number,netHit:boolean,crossT:number|null,crossZ:number|null}}
 */
export function predictLanding(state, maxT = PHYSICS.PREDICT_MAX_T) {
  const s = cloneState(state);
  const dt = PHYSICS.DT;
  let t = 0, crossT = null, crossZ = null;
  while (t < maxT) {
    const px = s.x, pz = s.z;
    const ev = stepShuttle(s, dt);
    t += dt;
    if (crossT === null && Math.sign(px) !== Math.sign(s.x) && px !== 0 && !s.netHit) {
      crossT = t; crossZ = pz;
    }
    if (ev === 'net' && crossT === null) { crossT = t; crossZ = s.z; }
    if (s.state === 'ground') break;
  }
  return { x: s.x, y: s.y, t, netHit: s.netHit, crossT, crossZ };
}

/**
 * Прогноз траектории (для ИИ и для отрисовки подсказки).
 * stride — сохранять каждую N-ю точку.
 */
export function predictTrajectory(state, maxT = PHYSICS.PREDICT_MAX_T, stride = 1) {
  const s = cloneState(state);
  const dt = PHYSICS.DT;
  const out = [];
  let t = 0, i = 0;
  while (t < maxT) {
    stepShuttle(s, dt);
    t += dt; i++;
    if (i % stride === 0 || s.state === 'ground') {
      out.push({ t, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, net: s.netHit });
    }
    if (s.state === 'ground') break;
  }
  return out;
}
