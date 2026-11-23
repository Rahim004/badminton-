/**
 * render/character.js — персонажи: 2D-проекция 3D-скелета с процедурной анимацией.
 *
 * Скелет (таз, корпус, голова, плечо/предплечье, бедро/голень, стопы, ракетка в руке)
 * строится в мировых координатах и проецируется функцией project() рендера, поэтому
 * перспектива (ближний/дальний игрок) и повороты корпуса получаются сами собой.
 *
 * Анимация не переключает кадры, а смешивает позы: каждая степень свободы
 * (присед, наклон, поворот корпуса, позиции кистей, направление ракетки, стопы)
 * тянется к цели критически демпфированной пружиной — переходы всегда плавные.
 * Цели задаются состоянием игрока из player.js:
 *   p.vx/p.vy           — бег (шаг и частота от реальной скорости, стопы не скользят),
 *   p.swing             — замах → контакт → проводка; время контакта = swing.contactAt,
 *                         ракетка приходит к реальной точке контакта swing.contact,
 *   swing.jump / p.z    — прыжок-смэш (присед, полёт, приземление),
 *   swing.lunge         — выпад,
 *   p.action 'serve'    — подача снизу, 'whiff' — замах мимо;
 * плюс события игры (onHit/onPoint) — сплит-степ, радость/досада после очка.
 *
 * API:
 *   createCharacters(ctx, project, camera) -> {
 *     prepare(p, game, pos, dt)   — обновить позу игрока (pos — интерполированная позиция {x,y})
 *     draw(p)                     — нарисовать (после prepare); тень рисуется здесь же
 *     depth(p)                    — глубина для сортировки сцены
 *     onHit(e), onPoint(e, game)  — события игры
 *   }
 */
import { V, Spring, Spring3, ik2, sampleKeys, clamp, lerp, smoothstep, easeOutCubic, easeInQuad, angleWrap } from './skeleton.js';

/** Масштаб персонажа относительно реального роста (читаемость на телефоне). */
const K = 1.1;
const D = {
  hipZ: 0.98, thigh: 0.47, shin: 0.46, ankle: 0.07, pelvisW: 0.1,
  spine: 0.5, neck: 0.07, headR: 0.13, shoulderW: 0.19,
  upper: 0.29, fore: 0.27, racketHead: 0.47, racketA: 0.13, racketB: 0.1, butt: 0.08,
};

/** Внешность героев (согласована с портретами меню). */
const LOOKS = {
  timur: { skin: '#d9a77c', hair: '#1d140f', hairStyle: 'crop', band: null, pattern: 'sash' },
  kai: { skin: '#f0c9a4', hair: '#0f1420', hairStyle: 'spiky', band: '#ffffff', pattern: 'stripe' },
  mira: { skin: '#e8b48f', hair: '#2a0f12', hairStyle: 'ponytail', band: '#ffd23f', pattern: 'chevron' },
  leo: { skin: '#f3d2bb', hair: '#c9a46a', hairStyle: 'beard', band: null, pattern: 'yoke' },
  aya: { skin: '#f5d6c0', hair: '#101010', hairStyle: 'bob', band: null, pattern: 'dots' },
  niko: { skin: '#a8714f', hair: '#ff7043', hairStyle: 'mohawk', band: '#1c2433', pattern: 'flame' },
};
/**
 * Вертикальная растяжка скелета (только персонажа): камера смотрит сверху, и без неё
 * фигуры выглядят приплюснутыми. Точка контакта и волан в руке компенсируются (/ZS),
 * так что ракетка всё равно приходит точно в волан.
 */
function zStretch(camera) { return camera.orientation === 'portrait' ? 1.16 : 1.06; }
const DEFAULT_LOOK = { skin: '#e0b090', hair: '#2b1c14', hairStyle: 'crop', band: null, pattern: 'sash' };

// --------------------------------------------------------------- ключи ударов
// Позиции кисти/левой руки — в «сеточной» системе игрока: [вперёд к сетке, вправо, вверх], м.
// Значения: [hand(3), racketDir(3), handL(3), yawU, lean, crouch]. Фазы: готов, замах, контакт, проводка, финиш.
const PH = [0, 0.4, 0.55, 0.75, 1];
const KEYS = {
  overhead: [
    [0.15, 0.30, 1.40, 0.15, 0.25, 1, 0.25, -0.28, 1.20, -0.2, 0.08, 0.06],
    [-0.14, 0.36, 1.62, -0.35, 0.15, -1, 0.34, -0.20, 1.90, -1.05, -0.14, 0.12],
    [0.22, 0.22, 2.08, 0.3, -0.05, 1, 0.16, -0.28, 1.45, 0.0, 0.12, 0.0],
    [0.45, 0.02, 1.40, 0.9, -0.35, -0.3, 0.05, -0.22, 1.05, 0.55, 0.32, 0.08],
    [0.28, -0.30, 0.98, 0.35, -0.55, -0.8, 0.02, -0.25, 1.00, 0.55, 0.24, 0.1],
  ],
  side: [
    [0.25, 0.30, 1.25, 0.2, 0.2, 1, 0.25, -0.28, 1.15, 0, 0.12, 0.08],
    [-0.12, 0.52, 1.30, -0.65, 0.45, 0.55, 0.25, -0.35, 1.25, -0.85, 0.05, 0.12],
    [0.30, 0.42, 1.22, 0.55, 0.8, 0.15, 0.15, -0.30, 1.15, 0.1, 0.15, 0.12],
    [0.40, 0.0, 1.25, 0.45, -0.85, 0.25, 0.05, -0.25, 1.10, 0.6, 0.2, 0.1],
    [0.18, -0.30, 1.25, -0.15, -0.8, 0.55, 0.05, -0.25, 1.10, 0.5, 0.18, 0.08],
  ],
  underhand: [
    [0.25, 0.30, 1.15, 0.2, 0.2, 1, 0.22, -0.28, 1.10, 0, 0.15, 0.1],
    [-0.02, 0.42, 0.80, -0.45, 0.35, -0.8, 0.05, -0.35, 1.05, -0.45, 0.25, 0.18],
    [0.42, 0.32, 0.62, 0.75, 0.1, -0.5, -0.1, -0.35, 0.95, 0.05, 0.35, 0.22],
    [0.48, 0.12, 1.20, 0.55, -0.1, 0.85, 0.0, -0.30, 1.05, 0.25, 0.25, 0.14],
    [0.32, 0.0, 1.55, 0.2, -0.25, 1, 0.1, -0.28, 1.10, 0.2, 0.18, 0.1],
  ],
  serve: [
    [-0.18, 0.40, 0.98, -0.55, 0.35, 0.65, 0.35, 0.10, 1.06, -0.35, 0.12, 0.08],
    [-0.20, 0.42, 0.95, -0.6, 0.35, 0.6, 0.35, 0.10, 1.06, -0.4, 0.12, 0.08],
    [0.10, 0.22, 0.80, 0.55, -0.1, 0.4, 0.10, -0.30, 1.05, -0.05, 0.15, 0.1],
    [0.35, -0.05, 1.42, 0.3, -0.4, 0.9, 0.05, -0.28, 1.05, 0.3, 0.12, 0.08],
    [0.22, -0.25, 1.55, -0.1, -0.5, 0.9, 0.1, -0.28, 1.10, 0.35, 0.1, 0.08],
  ],
};
// Смэш: глубже наклон и разворот на проводке.
KEYS.smash = KEYS.overhead.map((k, i) => { const c = k.slice(); if (i >= 3) { c[10] += 0.16; c[9] += 0.2; } if (i === 1) c[10] -= 0.06; return c; });
// Бэкхенд — зеркальная копия по оси «вправо».
function mirrorKey(k) { const c = k.slice(); c[1] = -c[1]; c[4] = -c[4]; c[7] = -c[7] * 0.6 + 0.15; c[9] = -c[9]; return c; }
const KEYS_BH = { side: KEYS.side.map(mirrorKey), underhand: KEYS.underhand.map(mirrorKey) };

// ---------------------------------------------------------------- цвета
const colorCache = new Map();
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
/** amt > 0 — светлее (к белому), < 0 — темнее. */
function shade(hex, amt) {
  const key = hex + amt;
  let v = colorCache.get(key);
  if (!v) {
    const [r, g, b] = hexRgb(hex);
    const f = amt >= 0 ? c => Math.round(c + (255 - c) * amt) : c => Math.round(c * (1 + amt));
    v = `rgb(${f(r)},${f(g)},${f(b)})`;
    colorCache.set(key, v);
  }
  return v;
}
const OUTLINE = 'rgba(9,14,28,0.88)';

export function createCharacters(ctx, project, camera) {
  const states = new WeakMap();

  function stateOf(p) {
    let st = states.get(p);
    if (!st) {
      st = {
        crouch: new Spring(0.06), lean: new Spring(0.08), roll: new Spring(0),
        yawL: new Spring(0), yawU: new Spring(0), headYaw: new Spring(0), headPitch: new Spring(0),
        bodyZ: new Spring(0), gaitW: new Spring(0), swW: new Spring(0), swExact: new Spring(0),
        hand: new Spring3([0.25, 0.3, 1.3]), rdir: new Spring3([0.2, 0.2, 1]), handL: new Spring3([0.25, -0.28, 1.15]),
        footR: new Spring3([0.08, 0.22, 0]), footL: new Spring3([-0.04, -0.22, 0]), pelvis: new Spring3([0, 0, 0]),
        tail: new Spring3([0, 0, 0]),
        phase: Math.random(), lastV: [0, 0], acc: new Spring3([0, 0, 0]),
        rec: null, lastWhiff: null, split: -1, splitCool: 0, pointT: 0, lastPhase: '', airborne: false,
        trail: [], sk: null, look: LOOKS[p.character] || DEFAULT_LOOK, time: Math.random() * 10,
      };
      states.set(p, st);
    }
    return st;
  }

  // ------------------------------------------------------------ события
  function onHit(e, game) {
    const p = e.player; if (!p) return;
    const st = stateOf(p);
    if (e.serve) {
      // Подача в симуляции мгновенная: ракетка из позы ожидания быстро проходит через
      // точку вылета волана и уходит в короткую проводку.
      const sh = game && game.shuttle;
      const C = sh ? { x: sh.x, y: sh.y, z: sh.z } : null;
      st.rec = { src: 'serve', kind: 'serve', t: 0.085, contactAt: 0.1, C, serve: true, end: 0.26 };
    }
  }
  function onPoint() { /* таймер очка ведётся по фазе игры в prepare */ }

  // ------------------------------------------------------------ поза
  function prepare(p, game, pos, dt) {
    const st = stateOf(p);
    st.time += dt;
    const ZS = st.ZS = zStretch(camera);
    const s = p.side;
    const F0 = [-s, 0, 0], R0 = [0, s, 0];
    const toNet = (wx, wy) => [(wx - pos.x) * F0[0] + (wy - pos.y) * F0[1], (wx - pos.x) * R0[0] + (wy - pos.y) * R0[1]];
    const sh = game.shuttle;

    // --- скорость и ускорение (в сеточной системе) ---
    const vNet = toNet(pos.x + p.vx, pos.y + p.vy);
    const speed = Math.hypot(p.vx, p.vy);
    const ax = dt > 0 ? (vNet[0] - st.lastV[0]) / dt : 0, ay = dt > 0 ? (vNet[1] - st.lastV[1]) / dt : 0;
    st.lastV = vNet;
    const acc = st.acc.step([clamp(ax, -30, 30), clamp(ay, -30, 30), 0], 10, dt);

    // --- запись удара (замах продолжается и после того, как симуляция его закрыла) ---
    const w = p.swing;
    if (w && (!st.rec || st.rec.src !== w)) {
      const C = w.contact ? { x: w.contact.x, y: w.contact.y, z: w.contact.z } : null;
      st.rec = { src: w, kind: w.kind, t: w.t, contactAt: w.contactAt, C, jump: !!w.jump, lunge: !!w.lunge, type: w.type };
    } else if (!w && p.action === 'whiff' && p.lastSwing && p.lastSwing.whiff && p.lastSwing !== st.lastWhiff) {
      st.lastWhiff = p.lastSwing;
      st.rec = { src: p.lastSwing, kind: 'overhead', t: 0, contactAt: 0.14, C: null, whiff: true };
    }
    const rec = st.rec;
    if (rec) {
      if (rec.src === p.swing && p.swing) rec.t = p.swing.t; else rec.t += dt;
      if (rec.t > rec.contactAt + (rec.end || 0.34)) st.rec = null;
    }
    // кончился розыгрыш — замах гаснет
    if (st.rec && !p.swing && game.phase !== 'rally' && !st.rec.serve && st.rec.t < st.rec.contactAt) st.rec = null;

    // --- фаза игры: очко / подача ---
    if (game.phase !== st.lastPhase) { st.pointT = 0; st.lastPhase = game.phase; }
    st.pointT += dt;
    const afterPoint = (game.phase === 'point' || game.phase === 'over' || game.phase === 'gameBreak') && game.lastPoint;
    const won = afterPoint && game.lastPoint.winner === p.team;
    const serveWait = game.phase === 'serve' && p.action === 'serve';
    const receiving = game.phase === 'serve' && game.serveInfo && !serveWait &&
      p.team === game.serveInfo.receiverTeam && p.idx === game.serveInfo.receiverIdx;

    // --- сплит-степ: перед ударом соперника ---
    st.splitCool -= dt;
    if (game.phase === 'rally' && !st.rec && st.split < 0 && st.splitCool <= 0 && speed < 3) {
      for (const q of game.players) {
        if (q.team === p.team || !q.swing) continue;
        const ttc = q.swing.contactAt - q.swing.t;
        if (ttc > 0.05 && ttc < 0.2) { st.split = 0; st.splitCool = 0.7; break; }
      }
    }
    let hop = 0, splitCrouch = 0, splitW = 0;
    if (st.split >= 0) {
      st.split += dt;
      const t = st.split;
      hop = t < 0.17 ? 0.075 * Math.sin(Math.PI * t / 0.17) : 0;
      splitCrouch = 0.09 * Math.sin(Math.PI * clamp((t - 0.13) / 0.3, 0, 1));
      splitW = 0.09 * smoothstep(0, 0.15, t) * (1 - smoothstep(0.3, 0.5, t));
      if (t > 0.5) st.split = -1;
    }

    // --- базовая поза ---
    const gaitTarget = smoothstep(0.25, 1.3, speed);
    const gW = st.gaitW.step(gaitTarget, 12, dt);
    const lat = speed > 0.1 ? Math.abs(vNet[1]) / speed : 0;
    const shuffle = lat > 0.72 && speed < 3.9;
    const moveAng = Math.atan2(vNet[1], vNet[0]);
    let yawL = gaitTarget * (shuffle ? 0.22 * Math.sign(vNet[1]) : clamp(moveAng * 0.5, -1.15, 1.15));
    const bob = 0.5 + 0.5 * Math.sin(st.time * 2 * Math.PI * 1.7); // покачивание на носках
    let crouch = 0.07 + 0.015 * bob * (1 - gW) + splitCrouch;
    let lean = 0.1 + gW * 0.08 + clamp(acc[0] * 0.012 + vNet[0] * 0.03, -0.25, 0.3);
    let roll = clamp(acc[1] * 0.01 + vNet[1] * 0.025, -0.22, 0.22) * (shuffle ? 0.6 : 1);
    let W = 0.21 + splitW + (shuffle ? 0.06 : 0);
    let fR = 0.07, fL = -0.05; // стойка: правая (ракеточная) нога чуть впереди
    let hand = [0.28, 0.38, 1.12], rdir = [0.42, 0.35, 0.85], handL = [0.24, -0.27, 1.1];
    let yawU = yawL * 0.6, headPitch = 0;
    let handOmega = 13;
    // бег: работа рук
    if (gW > 0.01) {
      const ph = Math.sin(st.phase * 2 * Math.PI);
      hand = V.lerp(hand, [0.22 - 0.08 * ph, 0.32, 1.22], gW);
      handL = V.lerp(handL, [0.08 + 0.24 * ph, -0.26, 1.02 + 0.06 * Math.abs(ph)], gW);
    }
    // подготовка к удару: волан летит ко мне
    if (game.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== p.team && !st.rec) {
      const d = Math.hypot(sh.x - pos.x, sh.y - pos.y);
      const near = 1 - smoothstep(1.6, 3.6, d);
      if (near > 0 && Math.sign(sh.x) === s) {
        if (sh.z > 1.9) {
          hand = V.lerp(hand, [0.0, 0.36, 1.68], near);
          rdir = V.lerp(rdir, [-0.15, 0.2, 1], near);
          const sl = toNet(sh.x, sh.y);
          handL = V.lerp(handL, [0.3, -0.22, 1.85 + 0.1 * clamp(sh.z - 2.5, 0, 1)], near);
          yawU = lerp(yawU, -0.75, near);
          headPitch = -0.25 * near;
          void sl;
        } else {
          hand = V.lerp(hand, [0.32, 0.34, 1.05], near * 0.7);
          rdir = V.lerp(rdir, [0.5, 0.25, 0.75], near * 0.7);
        }
      }
    }
    // подача: ждём с ракеткой сзади, волан в левой руке
    if (serveWait) {
      const k = KEYS.serve[0];
      hand = k.slice(0, 3); rdir = k.slice(3, 6); yawU = k[9]; lean = k[10];
      const hl = toNet(sh.x, sh.y);
      handL = [hl[0] / K, hl[1] / K, (sh.z / ZS + 0.06) / K];
      fL = 0.12; fR = -0.12; W = 0.2;
    } else if (receiving) {
      hand = [0.12, 0.36, 1.72]; rdir = [0.1, 0.15, 1]; handL = [0.3, -0.3, 1.3];
      crouch = 0.15 + 0.01 * bob; lean = 0.24; fL = 0.22; fR = -0.2; W = 0.19;
    } else if (game.phase === 'serve') {
      crouch = 0.12; lean = 0.18; hand = [0.3, 0.32, 1.38];
    }
    // после очка: радость или досада
    if (afterPoint && !st.rec) {
      const t = st.pointT;
      if (won) {
        const pump = Math.sin(clamp(t - 0.1, 0, 2) * 9) * Math.exp(-t * 1.2);
        if (p.id % 2 === 0) {
          hand = [0.08, 0.32, 2.0]; rdir = [0.05, 0.1, 1];
          handL = [0.25, -0.2, 1.4 + 0.14 * pump];
        } else {
          hand = [0.05, 0.42, 1.95]; rdir = [0.1, 0.45, 1];
          handL = [0.05, -0.42, 1.95 + 0.08 * pump];
        }
        hop = Math.max(hop, t > 0.08 && t < 0.4 ? 0.12 * Math.sin(Math.PI * (t - 0.08) / 0.32) : 0);
        lean = -0.08; crouch = 0.04; yawU = 0; headPitch = -0.2;
      } else {
        const k = smoothstep(0.1, 0.6, t);
        hand = V.lerp(hand, [0.18, 0.3, 0.62], k); rdir = V.lerp(rdir, [0.25, 0.15, -1], k);
        handL = V.lerp(handL, [0.3, -0.18, 0.66], k);
        lean = lerp(lean, 0.5, k); crouch = lerp(crouch, 0.13, k); headPitch = 0.45 * k; yawU = 0;
      }
    }

    // --- удар: смешивание с ключами ---
    let swingTarget = 0, lungeK = 0, jumpCrouch = 0;
    if (rec) {
      const C = rec.contactAt;
      const strike = Math.min(0.09, C * 0.6);
      const wind = C - strike;
      let ph;
      if (rec.t < wind) ph = 0.4 * easeOutCubic(rec.t / Math.max(1e-3, wind));
      else if (rec.t < C) ph = 0.4 + 0.15 * easeInQuad((rec.t - wind) / Math.max(1e-3, strike));
      else ph = 0.55 + 0.45 * easeOutCubic((rec.t - C) / 0.3);
      let keys = KEYS[rec.kind] || KEYS.overhead;
      if (rec.kind === 'overhead' && (rec.type === 'smash' || rec.jump)) keys = KEYS.smash;
      // точка контакта в сеточной системе (относительно текущей позиции и высоты тела)
      let Cl = null;
      if (rec.C) {
        const c2 = toNet(rec.C.x, rec.C.y);
        Cl = [c2[0], c2[1], rec.C.z / ZS - p.z];
        if (rec.backhand == null) rec.backhand = (rec.kind === 'side' || rec.kind === 'underhand') && c2[1] < -0.12;
        if (rec.backhand) keys = KEYS_BH[rec.kind];
      }
      keys = keys.slice();
      if (Cl) {
        // Ключ контакта подгоняем под реальную точку: рука и ракетка вытягиваются
        // по линии плечо → волан, центр обода приходит в волан.
        const kc = keys[2].slice();
        const Ck = V.scale(Cl, 1 / K);
        const low0 = clamp(0.75 - Cl[2] / K, 0, 0.6);
        let shl = [0.1 + low0 * 0.3, rec.backhand ? -0.12 : 0.2, D.hipZ - 0.1 + D.spine - 0.05 - (rec.lunge ? 0.25 : 0) - low0 * 0.5];
        if (rec.lunge) { const l = Math.hypot(Ck[0], Ck[1]) || 1; shl = [shl[0] + Ck[0] / l * 0.3, shl[1] + Ck[1] / l * 0.3, shl[2]]; }
        const u = V.norm(V.sub(Ck, shl));
        const rd = V.norm(V.lerp(V.norm(kc.slice(3, 6)), u, 0.75));
        let hc = V.madd(Ck, rd, -D.racketHead);
        const dv = V.sub(hc, shl), dl = V.len(dv);
        const maxR = (D.upper + D.fore) * 0.98;
        if (dl > maxR) hc = V.madd(shl, dv, maxR / dl);
        kc[0] = hc[0]; kc[1] = hc[1]; kc[2] = hc[2]; kc[3] = rd[0]; kc[4] = rd[1]; kc[5] = rd[2];
        // низкий волан — глубже присед и наклон
        const low = clamp(0.75 - Ck[2], 0, 0.6);
        kc[10] += low * 0.7; kc[11] += low * 0.35;
        keys[2] = kc;
      }
      const v = sampleKeys(PH, keys, ph);
      swingTarget = 1;
      const sw = st.swW.x;
      hand = V.lerp(hand, v.slice(0, 3), sw);
      rdir = V.lerp(rdir, v.slice(3, 6), sw);
      handL = V.lerp(handL, v.slice(6, 9), sw);
      yawU = lerp(yawU, v[9], sw);
      lean = lerp(lean, v[10] + (rec.jump ? 0.05 : 0), sw);
      crouch = lerp(crouch, v[11], sw);
      handOmega = 46;
      if (rec.jump) {
        // присед перед толчком, затем вытягиваемся
        const tt = C - rec.t;
        jumpCrouch = tt > 0.22 ? 0.13 : tt > 0 ? -0.04 : 0;
        headPitch = -0.3;
      }
      if (rec.lunge && Cl) lungeK = 1;
      if (rec.kind === 'overhead') headPitch = Math.min(headPitch, -0.3 * (1 - smoothstep(0.55, 0.8, ph)));
      // разворот ног к волану на ударе
      if (Cl && rec.kind !== 'overhead' && rec.kind !== 'serve') yawL = lerp(yawL, clamp(Math.atan2(Cl[1], Math.max(0.2, Cl[0])) * 0.5, -0.7, 0.7), 0.7);
      if (rec.kind === 'overhead') yawL = lerp(yawL, -0.55, smoothstep(0, 0.4, ph) * (1 - smoothstep(0.55, 0.9, ph)));
    }
    // выпад держим и на восстановлении
    if (!rec && p.action === 'recover' && p.lastSwing && p.lastSwing.lunge) lungeK = 1;
    const sw = st.swW.step(swingTarget, swingTarget ? 60 : 11, dt);
    void sw;

    // --- выпад: ракеточная нога далеко вперёд к волану ---
    let feetR = [fR, W], feetL = [fL, -W];
    const cy = Math.cos(yawL), sy = Math.sin(yawL);
    const rotN = (f, r) => [f * cy - r * sy, f * sy + r * cy];
    feetR = rotN(feetR[0], feetR[1]); feetL = rotN(feetL[0], feetL[1]);
    let pelvisOff = [0, 0, 0];
    if (lungeK > 0) {
      let dir = st.lungeDir;
      if (rec && rec.C) {
        const c2 = toNet(rec.C.x, rec.C.y);
        const l = Math.hypot(c2[0], c2[1]) || 1;
        dir = st.lungeDir = [c2[0] / l, c2[1] / l];
      }
      dir = dir || [1, 0];
      const pr = [-dir[1], dir[0]];
      feetR = [dir[0] * 0.82 + pr[0] * 0.12, dir[1] * 0.82 + pr[1] * 0.12 + 0.08];
      feetL = [-dir[0] * 0.38 - pr[0] * 0.14, -dir[1] * 0.38 - pr[1] * 0.14 - 0.1];
      pelvisOff = [dir[0] * 0.22, dir[1] * 0.22, 0];
      crouch = 0.3; lean = 0.32;
      yawL = clamp(Math.atan2(dir[1], dir[0]) * 0.7, -1.0, 1.0);
      yawU = lerp(yawU, yawL, 0.5);
    }

    // --- пружины ---
    const yL = st.yawL.step(yawL, 11, dt);
    const yU = st.yawU.step(yawU, rec ? 20 : 10, dt);
    const hY = st.headYaw.step(0, 8, dt);
    const hP = st.headPitch.step(headPitch, 9, dt);
    const cr = st.crouch.step(crouch + jumpCrouch, 16, dt);
    const ln = st.lean.step(lean, 12, dt);
    const rl = st.roll.step(roll, 9, dt);
    // Во время удара кисть идёт точно по сплайну (пружина лишь вводит/выводит из удара),
    // иначе запаздывание пружины уводит ракетку от волана в момент контакта.
    const ex = st.swExact.step(rec ? 1 : 0, rec ? 30 : 12, dt);
    const hd = V.lerp(st.hand.step(hand, handOmega, dt), hand, ex);
    const rd = V.norm(V.lerp(st.rdir.step(V.norm(rdir), handOmega, dt), V.norm(rdir), ex));
    const hl = V.lerp(st.handL.step(handL, rec ? 26 : 12, dt), handL, ex * 0.6);
    const pv = st.pelvis.step(pelvisOff, 14, dt);
    const zPrev = st.bodyZ.x;
    const bz = Math.max(0, st.bodyZ.step(p.z + hop, 30, dt));
    // приземление: амортизация
    if (st.airborne && bz < 0.015 && zPrev >= bz) { st.crouch.kick(1.4); st.airborne = false; }
    if (bz > 0.08) st.airborne = true;

    // --- походка: стопы не скользят (смещение = пройденный путь) ---
    let stride;
    if (shuffle) stride = clamp(0.5 + 0.12 * speed, 0.5, 0.95);
    else stride = clamp(0.8 + 0.32 * speed, 0.8, 2.2);
    st.phase = (st.phase + speed / stride * dt) % 1;
    const vdir = speed > 0.05 ? [vNet[0] / speed, vNet[1] / speed] : [0, 0];
    const STANCE = 0.6;
    const gait = i => {
      const ps = (st.phase + i * 0.5) % 1;
      let off, lift = 0, press = 0;
      if (ps < STANCE) { const t = ps / STANCE; off = lerp(0.5, -0.5, t) * STANCE * stride; press = Math.sin(Math.PI * t); }
      else { const t = (ps - STANCE) / (1 - STANCE); off = lerp(-0.5, 0.5, smoothstep(0, 1, t)) * STANCE * stride; lift = Math.sin(Math.PI * t) * (0.06 + 0.035 * Math.min(speed, 5)); }
      return { off, lift, press };
    };
    const gR = gait(0), gL = gait(1);
    const runBob = -0.035 * gW * Math.max(gR.press, gL.press) + (shuffle ? 0.03 * gW * Math.max(gR.lift, gL.lift) / 0.12 : 0);
    // стопы: опорная точка стойки — пружина (шаг в стойку/выпад), поверх неё — походка.
    // Смещение походки задаётся в метрах мира (делим на K), иначе стопа «проскальзывает».
    const fOmega = lungeK ? 20 : 15;
    const baseR = st.footR.step([feetR[0], feetR[1], 0], fOmega, dt);
    const baseL = st.footL.step([feetL[0], feetL[1], 0], fOmega, dt);
    let FR = [baseR[0] + vdir[0] * gR.off * gW / K, baseR[1] + vdir[1] * gR.off * gW / K, gR.lift * gW];
    let FL = [baseL[0] + vdir[0] * gL.off * gW / K, baseL[1] + vdir[1] * gL.off * gW / K, gL.lift * gW];
    // в воздухе — стопы отрываются вместе с телом, ноги поджаты
    if (bz > 0.01) {
      const a = Math.min(1, bz / 0.25);
      FR = [FR[0] + 0.08 * a, FR[1], FR[2] + bz * 0.8];
      FL = [FL[0] - 0.24 * a, FL[1], FL[2] + bz * 0.8 + 0.12 * a];
    }

    // --- сборка скелета (мировые координаты) ---
    const up = [0, 0, 1];
    const root = [pos.x + F0[0] * pv[0] * K + R0[0] * pv[1] * K, pos.y + F0[1] * pv[0] * K + R0[1] * pv[1] * K, bz];
    const N = (l) => [pos.x + (F0[0] * l[0] + R0[0] * l[1]) * K, pos.y + (F0[1] * l[0] + R0[1] * l[1]) * K, bz + l[2] * K];
    const yawF = a => [F0[0] * Math.cos(a) + R0[0] * Math.sin(a), F0[1] * Math.cos(a) + R0[1] * Math.sin(a), 0];
    const yawR = a => [R0[0] * Math.cos(a) - F0[0] * Math.sin(a), R0[1] * Math.cos(a) - F0[1] * Math.sin(a), 0];
    const FLo = yawF(yL), RLo = yawR(yL), FU = yawF(yU), RU = yawR(yU);
    const hipH = (D.hipZ - cr + runBob) * K;
    const pelvis = V.add(root, [0, 0, hipH]);
    const hipR = V.madd(pelvis, RLo, D.pelvisW * K), hipL = V.madd(pelvis, RLo, -D.pelvisW * K);
    const spineDir = V.norm(V.add(V.add(V.scale(up, Math.cos(ln)), V.scale(FU, Math.sin(ln))), V.scale(RU, Math.sin(rl))));
    const neckB = V.madd(pelvis, spineDir, D.spine * K);
    const shC = V.madd(neckB, spineDir, -0.05 * K);
    const shR = V.madd(shC, RU, D.shoulderW * K), shL = V.madd(shC, RU, -D.shoulderW * K);
    const FH = yawF(yU + hY);
    const headDir = V.norm(V.add(V.scale(spineDir, Math.cos(hP)), V.scale(FH, Math.sin(hP))));
    const headC = V.madd(V.madd(neckB, headDir, (D.neck + D.headR) * K), FH, 0.015 * K);
    // руки
    const handW = N(hd), handLW = N(hl);
    const high = clamp((hd[2] - 1.45) * 3, -1, 1);
    const poleR = V.norm(V.add(V.add(V.scale(RU, 1), V.scale(up, high > 0 ? 0.3 * high : -0.7)), V.scale(FU, -0.25)));
    const poleL = V.norm(V.add(V.add(V.scale(RU, -1), V.scale(up, -0.6)), V.scale(FU, -0.2)));
    const armR = ik2(shR, handW, D.upper * K, D.fore * K, poleR);
    const armL = ik2(shL, handLW, D.upper * K, D.fore * K, poleL);
    // ракетка
    const rdW = V.norm([F0[0] * rd[0] + R0[0] * rd[1], F0[1] * rd[0] + R0[1] * rd[1], rd[2]]);
    const grip = armR.end;
    const rHead = V.madd(grip, rdW, D.racketHead * K);
    const butt = V.madd(grip, rdW, -D.butt * K);
    // плоскость обода: нормаль — к сетке
    let face = V.sub(F0, V.scale(rdW, V.dot(F0, rdW)));
    if (V.len(face) < 0.2) face = V.sub(up, V.scale(rdW, V.dot(up, rdW)));
    face = V.norm(face);
    const across = V.norm(V.cross(rdW, face));
    // ноги
    // стопы — от пола (FR[2] уже в метрах), а не от поднятого прыжком тела
    const G = (l) => [pos.x + (F0[0] * l[0] + R0[0] * l[1]) * K, pos.y + (F0[1] * l[0] + R0[1] * l[1]) * K, l[2]];
    const toes = gW < 0.5 && bz < 0.01 ? 0.012 * bob : 0; // на носках
    const ankR = V.add(G(FR), [0, 0, D.ankle * K + toes]);
    const ankL = V.add(G(FL), [0, 0, D.ankle * K + toes]);
    const poleKR = V.norm(V.add(FLo, V.scale(RLo, 0.25))), poleKL = V.norm(V.add(FLo, V.scale(RLo, -0.25)));
    const legR = ik2(hipR, ankR, D.thigh * K, D.shin * K, poleKR);
    const legL = ik2(hipL, ankL, D.thigh * K, D.shin * K, lungeK > 0.5 ? V.norm(V.add(V.scale(FLo, 0.3), [0, 0, -1])) : poleKL);
    // направление стоп: по ногам, носки чуть наружу; при выпаде — по направлению выпада
    const footDir = (side) => {
      const a = yL + side * 0.3;
      return yawF(a);
    };
    const toeR = V.madd(legR.end, footDir(1), 0.14 * K), heelR = V.madd(legR.end, footDir(1), -0.04 * K);
    const toeL = V.madd(legL.end, footDir(-1), 0.14 * K), heelL = V.madd(legL.end, footDir(-1), -0.04 * K);
    toeR[2] = Math.max(0.02, toeR[2] - D.ankle * K * 0.8); heelR[2] = Math.max(0.03, heelR[2] - D.ankle * K * 0.4);
    toeL[2] = Math.max(0.02, toeL[2] - D.ankle * K * 0.8); heelL[2] = Math.max(0.03, heelL[2] - D.ankle * K * 0.4);

    // хвостик — вторичная динамика
    const tailBase = V.madd(V.madd(headC, FH, -0.11 * K), up, 0.02 * K);
    const tailRest = V.add(tailBase, [-p.vx * 0.05, -p.vy * 0.05, -0.17 * K + Math.min(0.1, p.vx * p.vx * 0.0)]);
    const tail = st.tail.step(V.sub(tailRest, tailBase), 14, dt);

    // след ракетки (для смаза)
    const tip = V.madd(rHead, rdW, D.racketA * K), throat = V.madd(rHead, rdW, -D.racketA * K);
    st.trail.push({ tip, throat, rec: !!rec });
    if (st.trail.length > 6) st.trail.shift();

    st.sk = {
      root, pelvis, hipR, hipL, neckB, shR, shL, headC, headDir, FH, FU, RU, spineDir,
      elbowR: armR.mid, handR: armR.end, elbowL: armL.mid, handL: armL.end,
      kneeR: legR.mid, ankR: legR.end, kneeL: legL.mid, ankL: legL.end, toeR, heelR, toeL, heelL,
      grip, rHead, butt, rdW, face, across, bz, tailBase, tail: V.add(tailBase, tail),
      color: p.color, accent: p.accent || '#333', human: p.controller === 'human', swinging: !!rec,
    };
  }

  // ------------------------------------------------------------ отрисовка
  let ZSd = 1;
  function P(a) { return project(a[0], a[1], a[2] * ZSd); }

  function capsule(a, b, w, color, ol) {
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    if (ol > 0) { ctx.strokeStyle = OUTLINE; ctx.lineWidth = w + ol * 2; ctx.stroke(); }
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  }
  function highlight(a, b, w, color) {
    const ox = -w * 0.2, oy = -w * 0.22;
    ctx.beginPath(); ctx.moveTo(a.x + ox, a.y + oy); ctx.lineTo(b.x + ox, b.y + oy);
    ctx.strokeStyle = color; ctx.lineWidth = w * 0.38; ctx.stroke();
  }
  function lerp2(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: a.s + (b.s - a.s) * t, d: a.d }; }

  let shadowSprite = null;
  function getShadow() {
    if (shadowSprite) return shadowSprite;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(4,10,24,0.55)'); gr.addColorStop(0.55, 'rgba(4,10,24,0.3)'); gr.addColorStop(1, 'rgba(4,10,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return (shadowSprite = c);
  }
  /** Мягкая тень-эллипс на полу: аффинное отображение спрайта на проекцию квадрата. */
  function groundShadow(x, y, rx, ry, ax, ay, alpha) {
    const c = project(x, y, 0);
    const a = project(x + ax[0] * rx, y + ax[1] * rx, 0);
    const b = project(x - ax[1] * ry, y + ax[0] * ry, 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.transform((a.x - c.x) / 32, (a.y - c.y) / 32, (b.x - c.x) / 32, (b.y - c.y) / 32, c.x, c.y);
    ctx.drawImage(getShadow(), -32, -32);
    ctx.restore();
  }

  function draw(p) {
    const st = states.get(p); if (!st || !st.sk) return;
    const k = st.sk, look = st.look;
    ZSd = st.ZS || 1;
    const sc = P(k.pelvis).s;
    const ol = clamp(sc * 0.011, 0.7, 1.8);
    const S = m => m * K * sc; // метры → пиксели

    // тени
    const fx = -p.side;
    const air = clamp(1 - k.bz * 1.4, 0.35, 1);
    groundShadow(k.root[0] + fx * 0.05, k.root[1], 0.5 * K * (1.1 - air * 0.1), 0.34 * K, [1, 0], [0, 1], 0.75 * air);
    groundShadow(k.toeR[0], k.toeR[1], 0.14, 0.1, [1, 0], [0, 1], 0.5 * clamp(1 - k.toeR[2] * 6, 0, 1));
    groundShadow(k.toeL[0], k.toeL[1], 0.14, 0.1, [1, 0], [0, 1], 0.5 * clamp(1 - k.toeL[2] * 6, 0, 1));

    // проекции
    const q = {};
    for (const n of ['pelvis', 'hipR', 'hipL', 'neckB', 'shR', 'shL', 'headC', 'elbowR', 'handR', 'elbowL', 'handL',
      'kneeR', 'ankR', 'kneeL', 'ankL', 'toeR', 'heelR', 'toeL', 'heelL', 'grip', 'rHead', 'butt']) q[n] = P(k[n]);

    // смаз ракетки
    drawSwoosh(st, k);

    const skin = look.skin, skinHi = shade(skin, 0.28), shirt = k.color, shirtHi = shade(shirt, 0.35);
    const shorts = shade(k.accent, -0.35), sock = '#f2f4f8', shoe = '#f7f7fa';
    const parts = [];
    const leg = (side) => {
      const hip = q['hip' + side], knee = q['knee' + side], ank = q['ank' + side], toe = q['toe' + side], heel = q['heel' + side];
      return () => {
        capsule(hip, knee, S(0.13), skin, ol); highlight(hip, knee, S(0.13), skinHi);
        capsule(knee, ank, S(0.1), skin, ol); highlight(knee, ank, S(0.1), skinHi);
        const sk = lerp2(knee, ank, 0.62);
        capsule(sk, ank, S(0.098), sock, 0);
        capsule(heel, toe, S(0.095), shoe, ol);
        ctx.strokeStyle = shade(k.accent, 0); ctx.lineWidth = Math.max(1, S(0.028)); ctx.beginPath();
        ctx.moveTo(heel.x, heel.y + S(0.03)); ctx.lineTo(toe.x, toe.y + S(0.03)); ctx.stroke();
        // шорты поверх бедра
        const sh = lerp2(hip, knee, 0.42);
        capsule(hip, sh, S(0.165), shorts, ol);
      };
    };
    const arm = (side) => {
      const sh = q['sh' + side], el = q['elbow' + side], hd = q['hand' + side];
      return () => {
        capsule(sh, el, S(0.088), skin, ol); highlight(sh, el, S(0.088), skinHi);
        capsule(el, hd, S(0.078), skin, ol); highlight(el, hd, S(0.078), skinHi);
        const sl = lerp2(sh, el, 0.38);
        capsule(sh, sl, S(0.125), shirt, ol);
        if (side === 'R') capsule(lerp2(el, hd, 0.72), lerp2(el, hd, 0.86), S(0.085), k.accent, 0); // напульсник
        ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(hd.x, hd.y, Math.max(1.2, S(0.05)), 0, Math.PI * 2); ctx.fill();
      };
    };
    parts.push({ d: (q.hipR.d + q.kneeR.d) / 2, f: leg('R') });
    parts.push({ d: (q.hipL.d + q.kneeL.d) / 2, f: leg('L') });
    parts.push({ d: q.pelvis.d - 0.001, f: () => drawTorso(k, q, S, ol, shirt, shirtHi, shorts, look) });
    parts.push({ d: q.headC.d - 0.002, f: () => drawHead(st, k, q, S, ol, look) });
    // рука: впереди/позади корпуса — по глубине локтя относительно плеч
    parts.push({ d: (q.elbowR.d + q.handR.d + q.shR.d) / 3, f: arm('R') });
    parts.push({ d: (q.elbowL.d + q.handL.d + q.shL.d) / 3, f: arm('L') });
    parts.push({ d: q.rHead.d - 0.003 * (q.rHead.d < q.handR.d ? 1 : -1), f: () => drawRacket(k, q, S, ol) });
    parts.sort((a, b) => b.d - a.d);
    for (const it of parts) it.f();

    if (k.human) {
      const top = P(V.add(k.headC, [0, 0, 0.5 * K]));
      const r = clamp(S(0.07), 4, 8);
      ctx.fillStyle = '#ffe27a'; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(top.x, top.y + r); ctx.lineTo(top.x - r, top.y - r * 0.7); ctx.lineTo(top.x + r, top.y - r * 0.7); ctx.closePath();
      ctx.stroke(); ctx.fill();
    }
  }

  function drawTorso(k, q, S, ol, shirt, shirtHi, shorts, look) {
    // таз/шорты
    capsule(q.hipL, q.hipR, S(0.2), shorts, ol);
    // объём корпуса (виден сбоку): капсула таз→грудь
    const nb0 = P(k.neckB), chest = P(V.madd(k.neckB, k.spineDir, -0.12 * K));
    capsule(lerp2(q.pelvis, nb0, 0.12), chest, S(0.27), shirt, ol);
    // корпус — скруглённая трапеция плечи→бёдра
    const waistR = lerp2(q.hipR, q.shR, 0.12), waistL = lerp2(q.hipL, q.shL, 0.12);
    const pts = [q.shL, q.shR, waistR, waistL];
    const path = () => { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath(); };
    const rw = S(0.12);
    ctx.lineJoin = 'round';
    path(); ctx.strokeStyle = OUTLINE; ctx.lineWidth = rw + ol * 2; ctx.stroke();
    const g = ctx.createLinearGradient(q.shL.x - rw, q.shL.y - rw, q.hipR.x + rw, q.hipR.y);
    g.addColorStop(0, shirtHi); g.addColorStop(0.45, shirt); g.addColorStop(1, shade(shirt, -0.3));
    path(); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = g; ctx.lineWidth = rw; ctx.stroke();
    // узор формы
    ctx.save();
    path(); ctx.lineWidth = rw; ctx.stroke(); ctx.clip();
    ctx.strokeStyle = k.accent; ctx.fillStyle = k.accent;
    const L2 = (a, b, t) => lerp2(a, b, t);
    const pat = look.pattern;
    ctx.lineCap = 'butt';
    if (pat === 'sash') { const a = L2(q.shR, q.shL, -0.1), b = L2(q.hipL, q.hipR, -0.2); ctx.lineWidth = S(0.09); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    else if (pat === 'stripe') { const a = L2(q.shL, waistL, 0.45), b = L2(q.shR, waistR, 0.45); ctx.strokeStyle = '#fff'; ctx.lineWidth = S(0.06); ctx.beginPath(); ctx.moveTo(a.x - rw, a.y); ctx.lineTo(b.x + rw, b.y); ctx.stroke(); }
    else if (pat === 'chevron') { const a = L2(q.shL, waistL, 0.25), b = L2(q.shR, waistR, 0.25), m = L2(L2(q.shL, q.shR, 0.5), L2(waistL, waistR, 0.5), 0.55); ctx.lineWidth = S(0.07); ctx.beginPath(); ctx.moveTo(a.x - rw, a.y); ctx.lineTo(m.x, m.y); ctx.lineTo(b.x + rw, b.y); ctx.stroke(); }
    else if (pat === 'yoke') { const a = L2(q.shL, waistL, 0.2), b = L2(q.shR, waistR, 0.2); ctx.lineWidth = S(0.1); ctx.beginPath(); ctx.moveTo(a.x - rw, a.y - rw * 0.5); ctx.lineTo(b.x + rw, b.y - rw * 0.5); ctx.stroke(); }
    else if (pat === 'flame') { const a = L2(waistL, q.shL, 0.05), b = L2(waistR, q.shR, 0.05), m = L2(a, b, 0.5); ctx.lineWidth = S(0.08); ctx.beginPath(); ctx.moveTo(a.x - rw, a.y); ctx.lineTo(L2(a, m, 0.5).x, L2(a, m, 0.5).y - S(0.12)); ctx.lineTo(m.x, m.y); ctx.lineTo(L2(m, b, 0.5).x, L2(m, b, 0.5).y - S(0.14)); ctx.lineTo(b.x + rw, b.y); ctx.stroke(); }
    else if (pat === 'dots') { ctx.fillStyle = 'rgba(255,255,255,0.85)'; for (let i = 0; i < 3; i++) { const c = L2(L2(q.shL, waistL, 0.5), L2(q.shR, waistR, 0.5), 0.25 + i * 0.25); ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(0.8, S(0.025)), 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
    ctx.lineCap = 'round';
    // воротник
    const nb = P(k.neckB);
    capsule(lerp2(q.shL, nb, 0.6), lerp2(q.shR, nb, 0.6), S(0.035), shade(k.accent, 0), 0);
  }

  function drawHead(st, k, q, S, ol, look) {
    const nb = P(k.neckB);
    capsule(nb, lerp2(nb, q.headC, 0.5), S(0.085), look.skin, ol);
    const c = q.headC, r = Math.max(2, S(D.headR));
    const toCam = V.dot(k.FH, camera.f); // < 0 — лицо к камере
    // лицевая сторона: смещение в экране
    const fp = P(V.madd(k.headC, k.FH, 0.1 * K));
    const fdx = (fp.x - c.x) / r, fdy = (fp.y - c.y) / r;
    // хвостик (за головой)
    if (look.hairStyle === 'ponytail') {
      const a = P(k.tailBase), b = P(k.tail);
      if (toCam < 0) capsule(a, b, S(0.07), look.hair, ol);
      st._tailFront = toCam >= 0 ? [a, b] : null;
    }
    // голова
    ctx.beginPath(); ctx.arc(c.x, c.y, r + ol, 0, Math.PI * 2); ctx.fillStyle = OUTLINE; ctx.fill();
    const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.4, r * 0.1, c.x, c.y, r);
    g.addColorStop(0, shade(look.skin, 0.22)); g.addColorStop(1, shade(look.skin, -0.12));
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    // волосы: шапочка, сдвинутая к затылку и вверх
    const back = P(V.madd(V.madd(k.headC, k.FH, -0.075 * K), k.spineDir, 0.05 * K));
    ctx.save();
    ctx.beginPath(); ctx.arc(c.x, c.y, r * (look.hairStyle === 'bob' ? 1.12 : 1.06), 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = look.hair;
    const hr = look.hairStyle === 'bob' ? r * 1.08 : look.hairStyle === 'mohawk' ? r * 0.75 : r;
    ctx.beginPath(); ctx.arc(back.x, back.y - (look.hairStyle === 'bob' ? 0 : r * 0.05), hr, 0, Math.PI * 2); ctx.fill();
    if (look.hairStyle === 'beard' && toCam < -0.1) {
      ctx.beginPath(); ctx.arc(c.x + fdx * r * 0.5, c.y + fdy * r * 0.5 + r * 0.55, r * 0.55, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // лицо
    if (toCam < -0.15 && r > 2.6) {
      const ru = P(V.madd(k.headC, k.RU, 0.045 * K));
      const rx = (ru.x - c.x), ry = (ru.y - c.y);
      const ex = c.x + fdx * r * 0.55, ey = c.y + fdy * r * 0.55 + r * 0.05;
      ctx.fillStyle = '#1a1414';
      const er = Math.max(0.55, r * 0.11);
      ctx.beginPath(); ctx.arc(ex + rx, ey + ry, er, 0, Math.PI * 2); ctx.arc(ex - rx, ey - ry, er, 0, Math.PI * 2); ctx.fill();
    }
    if (look.hairStyle === 'spiky') {
      ctx.fillStyle = look.hair;
      const t = P(V.madd(k.headC, k.spineDir, D.headR * K * 0.95));
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath(); ctx.moveTo(t.x + i * r * 0.45 - r * 0.25, t.y + r * 0.2); ctx.lineTo(t.x + i * r * 0.55, t.y - r * 0.45); ctx.lineTo(t.x + i * r * 0.45 + r * 0.25, t.y + r * 0.2); ctx.fill();
      }
    } else if (look.hairStyle === 'mohawk') {
      const a = P(V.madd(V.madd(k.headC, k.spineDir, D.headR * K * 0.9), k.FH, 0.07 * K));
      const b = P(V.madd(V.madd(k.headC, k.spineDir, D.headR * K * 0.75), k.FH, -0.09 * K));
      capsule(a, b, r * 0.5, look.hair, ol);
    }
    if (look.band) {
      const a = P(V.madd(V.madd(k.headC, k.RU, -D.headR * K), k.spineDir, 0.035 * K));
      const b = P(V.madd(V.madd(k.headC, k.RU, D.headR * K), k.spineDir, 0.035 * K));
      const m = P(V.madd(V.madd(k.headC, k.FH, D.headR * K * (toCam < 0 ? 1 : -1)), k.spineDir, 0.035 * K));
      ctx.strokeStyle = look.band; ctx.lineWidth = Math.max(1, r * 0.28); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2, b.x, b.y); ctx.stroke();
    }
    if (st._tailFront) capsule(st._tailFront[0], st._tailFront[1], S(0.07), look.hair, ol);
  }

  function drawRacket(k, q, S, ol) {
    // ручка и стержень
    const throat = P(V.madd(k.rHead, k.rdW, -D.racketA * K));
    ctx.lineCap = 'round';
    capsule(q.butt, q.grip, Math.max(1.6, S(0.035)), shade(k.accent, -0.1), ol * 0.7);
    ctx.strokeStyle = '#20242c'; ctx.lineWidth = Math.max(1, S(0.016));
    ctx.beginPath(); ctx.moveTo(q.grip.x, q.grip.y); ctx.lineTo(throat.x, throat.y); ctx.stroke();
    // обод: эллипс в плоскости ракетки
    const n = 14, pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      pts.push(P(V.madd(V.madd(k.rHead, k.rdW, Math.cos(a) * D.racketA * K), k.across, Math.sin(a) * D.racketB * K)));
    }
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    ctx.fillStyle = 'rgba(240,246,255,0.26)'; ctx.fill();
    const fw = Math.max(1.3, S(0.02));
    ctx.strokeStyle = OUTLINE; ctx.lineWidth = fw + ol * 1.4; ctx.stroke();
    ctx.strokeStyle = k.color; ctx.lineWidth = fw; ctx.stroke();
    // струны (если ракетка достаточно крупная)
    const sz = Math.hypot(pts[0].x - pts[7].x, pts[0].y - pts[7].y);
    if (sz > 16) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.6; ctx.beginPath();
      for (const t of [-0.5, 0, 0.5]) {
        const a = P(V.madd(V.madd(k.rHead, k.across, t * D.racketB * K), k.rdW, -Math.sqrt(1 - t * t) * D.racketA * K));
        const b = P(V.madd(V.madd(k.rHead, k.across, t * D.racketB * K), k.rdW, Math.sqrt(1 - t * t) * D.racketA * K));
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        const c = P(V.madd(V.madd(k.rHead, k.rdW, t * D.racketA * K), k.across, -Math.sqrt(1 - t * t) * D.racketB * K));
        const d = P(V.madd(V.madd(k.rHead, k.rdW, t * D.racketA * K), k.across, Math.sqrt(1 - t * t) * D.racketB * K));
        ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      }
      ctx.stroke();
    }
  }

  /** Дуга-смаз за ободом на быстром замахе. */
  function drawSwoosh(st, k) {
    const tr = st.trail;
    if (tr.length < 3 || !k.swinging) return;
    let maxV = 0;
    for (let i = 1; i < tr.length; i++) maxV = Math.max(maxV, V.len(V.sub(tr[i].tip, tr[i - 1].tip)));
    const a0 = clamp((maxV - 0.05) / 0.2, 0, 0.55);
    if (a0 < 0.03) return;
    const pts = tr.map(t => ({ a: P(t.tip), b: P(t.throat) }));
    for (let i = 1; i < pts.length; i++) {
      const k2 = i / (pts.length - 1);
      ctx.fillStyle = `rgba(255,255,255,${(a0 * k2 * k2).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].a.x, pts[i - 1].a.y); ctx.lineTo(pts[i].a.x, pts[i].a.y);
      ctx.lineTo(pts[i].b.x, pts[i].b.y); ctx.lineTo(pts[i - 1].b.x, pts[i - 1].b.y);
      ctx.closePath(); ctx.fill();
    }
  }

  function depth(p) {
    const st = states.get(p);
    if (!st || !st.sk) return project(p.x, p.y, 0.9).d;
    return P(st.sk.pelvis).d;
  }

  return { prepare, draw, depth, onHit, onPoint, _state: p => states.get(p) };
}

export { LOOKS };
