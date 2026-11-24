/**
 * render/character.js — персонажи в стиле аниме-спорта: 2D-проекция 3D-скелета
 * с процедурной анимацией и cel-shading отрисовкой.
 *
 * Скелет (таз, поясница + грудь с прогибом, голова, руки/ноги по IK, стопы, ракетка)
 * строится в мировых координатах и проецируется функцией project() рендера.
 * Анимация смешивает позы: каждая степень свободы тянется к цели критически
 * демпфированной пружиной, вторичная динамика (волосы, хвост, ленты повязки, подол
 * футболки/юбки) — недодемпфированными пружинами (покачивание с затуханием).
 * Цели задаются состоянием игрока из player.js:
 *   p.vx/p.vy           — бег (шаг и частота от реальной скорости, стопы не скользят),
 *   p.swing             — замах → контакт → проводка; время контакта = swing.contactAt,
 *                         ракетка приходит к реальной точке контакта swing.contact,
 *   swing.jump / p.z    — прыжок-смэш (прогиб, «ножницы», полное вытяжение, приземление),
 *   swing.lunge         — глубокий выпад,
 *   p.action 'serve'    — подача снизу, 'whiff' — замах мимо;
 * плюс события игры — сплит-степ, радость/досада после очка, эмоции лица
 * (сосредоточенность, крик на смэше, улыбка, досада), моргание, взгляд на волан.
 *
 * Отрисовка — cel-shading: плоский цвет + один жёсткий тон тени, контровой блик,
 * тёмный контур (толще по внешнему силуэту, тоньше внутри). Лицо и причёски —
 * render/characters/head.js, внешность героев — render/characters/looks.js.
 *
 * API:
 *   createCharacters(ctx, project, camera) -> {
 *     prepare(p, game, pos, dt)   — обновить позу игрока (pos — интерполированная позиция {x,y})
 *     draw(p)                     — нарисовать (после prepare); тень рисуется здесь же
 *     depth(p)                    — глубина для сортировки сцены
 *     onHit(e), onPoint(e, game)  — события игры
 *     drawBust(p|heroId, x, y, r, mood, opts?) — бюст героя (кат-ин «аниме-вставка» на смэше и т.п.)
 *     headScreen(p) -> {x, y, r} | null        — где на экране голова (для эффектов)
 *   }
 */
import { V, Spring, Spring3, Wobble, Wobble3, Chain, hull2, ik2, sampleKeys, clamp, lerp, smoothstep, easeOutCubic, easeInQuad, angleWrap } from './skeleton.js';
import { LOOKS as HERO_LOOKS, DEFAULT_LOOK } from './characters/looks.js';
import { drawHead, headBasis } from './characters/head.js';
import { INK, tone, celCapsule, celFill, celPoly, smoothPath } from './characters/paint.js';

/** Масштаб персонажа относительно реального роста (читаемость на телефоне). */
const K = 1.1;
const D = {
  hipZ: 0.98, thigh: 0.47, shin: 0.46, ankle: 0.07, pelvisW: 0.1,
  spine: 0.5, neck: 0.04, headR: 0.168, shoulderW: 0.19,
  upper: 0.29, fore: 0.27, racketHead: 0.47, racketA: 0.13, racketB: 0.1, butt: 0.08,
};
const NUM_FONT = '"Unbounded", "Arial Black", "Segoe UI Black", system-ui, sans-serif';

/**
 * Вертикальная растяжка скелета (только персонажа): камера смотрит сверху, и без неё
 * фигуры выглядят приплюснутыми. Точка контакта и волан в руке компенсируются (/ZS),
 * так что ракетка всё равно приходит точно в волан.
 */
function zStretch(camera) { return camera.orientation === 'portrait' ? 1.16 : 1.06; }

// --------------------------------------------------------------- ключи ударов
// Позиции кисти/левой руки — в «сеточной» системе игрока: [вперёд к сетке, вправо, вверх], м.
// Значения: [hand(3), racketDir(3), handL(3), yawU, lean, crouch, arch].
// Фазы: готов, замах, контакт, проводка, финиш. arch < 0 — прогиб назад (грудь), > 0 — «складка».
const PH = [0, 0.4, 0.55, 0.75, 1];
const KEYS = {
  overhead: [
    [0.15, 0.30, 1.40, 0.15, 0.25, 1, 0.25, -0.28, 1.20, -0.2, 0.08, 0.06, 0],
    [-0.22, 0.40, 1.55, -0.5, 0.12, -0.86, 0.40, -0.18, 1.98, -1.15, -0.12, 0.13, -0.2],
    [0.22, 0.22, 2.08, 0.3, -0.05, 1, 0.16, -0.28, 1.45, 0.0, 0.12, 0.0, 0.0],
    [0.50, -0.08, 1.32, 0.9, -0.45, -0.45, -0.05, -0.30, 1.0, 0.7, 0.34, 0.08, 0.18],
    [0.30, -0.36, 0.96, 0.3, -0.6, -0.8, -0.04, -0.30, 1.0, 0.6, 0.26, 0.1, 0.1],
  ],
  side: [
    [0.25, 0.30, 1.25, 0.2, 0.2, 1, 0.25, -0.28, 1.15, 0, 0.12, 0.08, 0],
    [-0.16, 0.55, 1.32, -0.7, 0.45, 0.55, 0.32, -0.30, 1.30, -1.0, 0.06, 0.13, -0.08],
    [0.30, 0.42, 1.22, 0.55, 0.8, 0.15, 0.15, -0.30, 1.15, 0.1, 0.15, 0.12, 0],
    [0.42, -0.05, 1.28, 0.45, -0.85, 0.3, -0.05, -0.32, 1.12, 0.8, 0.24, 0.1, 0.12],
    [0.18, -0.34, 1.28, -0.15, -0.8, 0.55, -0.02, -0.30, 1.10, 0.6, 0.2, 0.08, 0.06],
  ],
  underhand: [
    [0.25, 0.30, 1.15, 0.2, 0.2, 1, 0.22, -0.28, 1.10, 0, 0.15, 0.1, 0],
    [-0.05, 0.44, 0.78, -0.5, 0.35, -0.8, 0.12, -0.38, 1.12, -0.5, 0.26, 0.2, 0.06],
    [0.42, 0.32, 0.62, 0.75, 0.1, -0.5, -0.1, -0.35, 0.95, 0.05, 0.35, 0.22, 0.06],
    [0.50, 0.12, 1.30, 0.55, -0.1, 0.9, -0.05, -0.32, 1.02, 0.3, 0.25, 0.14, -0.04],
    [0.32, 0.0, 1.62, 0.2, -0.25, 1, 0.08, -0.28, 1.10, 0.2, 0.16, 0.1, -0.06],
  ],
  serve: [
    [-0.18, 0.40, 0.98, -0.55, 0.35, 0.65, 0.35, 0.10, 1.06, -0.35, 0.12, 0.08, 0],
    [-0.20, 0.42, 0.95, -0.6, 0.35, 0.6, 0.35, 0.10, 1.06, -0.4, 0.12, 0.08, 0],
    [0.10, 0.22, 0.80, 0.55, -0.1, 0.4, 0.10, -0.30, 1.05, -0.05, 0.15, 0.1, 0],
    [0.35, -0.05, 1.42, 0.3, -0.4, 0.9, 0.05, -0.28, 1.05, 0.3, 0.12, 0.08, 0],
    [0.22, -0.25, 1.55, -0.1, -0.5, 0.9, 0.1, -0.28, 1.10, 0.35, 0.1, 0.08, 0],
  ],
};
// Смэш: драматичнее — глубокий разворот и прогиб на замахе, ракетка «складывается» через корпус.
KEYS.smash = KEYS.overhead.map((k, i) => {
  const c = k.slice();
  if (i === 1) { c[0] = -0.28; c[2] = 1.5; c[3] = -0.6; c[5] = -0.8; c[6] = 0.46; c[7] = -0.14; c[8] = 2.08; c[9] = -1.35; c[10] = -0.2; c[12] = -0.36; }
  if (i === 3) { c[0] = 0.48; c[1] = -0.24; c[2] = 1.05; c[3] = 0.7; c[4] = -0.65; c[5] = -0.6; c[9] = 0.95; c[10] = 0.5; c[11] = 0.12; c[12] = 0.3; c[6] = -0.12; c[7] = -0.36; c[8] = 0.95; }
  if (i === 4) { c[0] = 0.22; c[1] = -0.42; c[2] = 0.82; c[10] = 0.42; c[12] = 0.18; c[9] = 0.75; }
  return c;
});
// Бэкхенд — зеркальная копия по оси «вправо».
function mirrorKey(k) { const c = k.slice(); c[1] = -c[1]; c[4] = -c[4]; c[7] = -c[7] * 0.6 + 0.15; c[9] = -c[9]; return c; }
const KEYS_BH = { side: KEYS.side.map(mirrorKey), underhand: KEYS.underhand.map(mirrorKey) };

function lookOf(id) { return HERO_LOOKS[id] || DEFAULT_LOOK; }

export function createCharacters(ctx, project, camera) {
  const states = new WeakMap();

  function stateOf(p) {
    let st = states.get(p);
    if (!st) {
      const look = lookOf(p.character);
      st = {
        crouch: new Spring(0.06), lean: new Spring(0.08), roll: new Spring(0), arch: new Spring(0),
        yawL: new Spring(0), yawU: new Spring(0), headYaw: new Spring(0), headPitch: new Spring(0),
        bodyZ: new Spring(0), gaitW: new Spring(0), swW: new Spring(0), swExact: new Spring(0),
        hand: new Spring3([0.25, 0.3, 1.3]), rdir: new Spring3([0.2, 0.2, 1]), handL: new Spring3([0.25, -0.28, 1.15]),
        footR: new Spring3([0.08, 0.22, 0]), footL: new Spring3([-0.04, -0.22, 0]), pelvis: new Spring3([0, 0, 0]),
        phase: Math.random(), lastV: [0, 0], acc: new Spring3([0, 0, 0]),
        rec: null, lastWhiff: null, split: -1, splitCool: 0, pointT: 0, lastPhase: '', airborne: false,
        trail: [], sk: null, look, time: Math.random() * 10,
        // вторичная динамика
        hairW: new Wobble3([0, 0, 0], 12, 0.28), hemW: new Wobble(0, 15, 0.28), pelW: new Wobble3([0, 0, 0], 11, 0.32),
        tail: look.tail ? new Chain(look.tail.n, look.tail.seg * K, 15, 0.24) : null,
        ribbons: look.band ? [0, 1].map(() => new Chain(2, look.band.tailLen * K, 13, 0.18)) : null,
        blinkT: 1 + Math.random() * 3, blink: 0, mood: 'calm', sweat: 0,
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
  let firstPlayer = null;
  function prepare(p, game, pos, dt) {
    const st = stateOf(p);
    firstPlayer = game.players[0] || p;
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
      if (rec.t > rec.contactAt + (rec.end || 0.36)) st.rec = null;
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
      splitCrouch = 0.1 * Math.sin(Math.PI * clamp((t - 0.13) / 0.3, 0, 1));
      splitW = 0.1 * smoothstep(0, 0.15, t) * (1 - smoothstep(0.3, 0.5, t));
      if (t > 0.5) st.split = -1;
    }

    // --- базовая поза: низкая пружинистая стойка ---
    const gaitTarget = smoothstep(0.25, 1.3, speed);
    const gW = st.gaitW.step(gaitTarget, 12, dt);
    const lat = speed > 0.1 ? Math.abs(vNet[1]) / speed : 0;
    const shuffle = lat > 0.72 && speed < 3.9;
    const moveAng = Math.atan2(vNet[1], vNet[0]);
    let yawL = gaitTarget * (shuffle ? 0.22 * Math.sign(vNet[1]) : clamp(moveAng * 0.5, -1.15, 1.15));
    const bob = 0.5 + 0.5 * Math.sin(st.time * 2 * Math.PI * 1.7); // покачивание на носках
    let crouch = 0.09 + 0.018 * bob * (1 - gW) + splitCrouch;
    let lean = 0.14 + gW * 0.12 + clamp(acc[0] * 0.014 + vNet[0] * 0.035, -0.25, 0.34);
    let roll = clamp(acc[1] * 0.012 + vNet[1] * 0.028, -0.26, 0.26) * (shuffle ? 0.6 : 1);
    let arch = 0;
    let W = 0.23 + splitW + (shuffle ? 0.06 : 0);
    let fR = 0.08, fL = -0.06; // стойка: правая (ракеточная) нога чуть впереди
    let hand = [0.3, 0.38, 1.14], rdir = [0.42, 0.35, 0.85], handL = [0.26, -0.28, 1.12];
    let yawU = yawL * 0.6, headPitch = 0, headYawT = 0, trackHead = game.phase === 'rally';
    let handOmega = 13;
    // бег: работа рук, корпус вперёд
    if (gW > 0.01) {
      const ph = Math.sin(st.phase * 2 * Math.PI);
      hand = V.lerp(hand, [0.24 - 0.1 * ph, 0.34, 1.22], gW);
      handL = V.lerp(handL, [0.08 + 0.3 * ph, -0.27, 1.0 + 0.08 * Math.abs(ph)], gW);
      arch += 0.06 * gW;
    }
    // подготовка к удару: волан летит ко мне
    if (game.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== p.team && !st.rec) {
      const d = Math.hypot(sh.x - pos.x, sh.y - pos.y);
      const near = 1 - smoothstep(1.6, 3.6, d);
      if (near > 0 && Math.sign(sh.x) === s) {
        if (sh.z > 1.9) {
          hand = V.lerp(hand, [-0.02, 0.38, 1.66], near);
          rdir = V.lerp(rdir, [-0.2, 0.2, 1], near);
          handL = V.lerp(handL, [0.32, -0.2, 1.9 + 0.1 * clamp(sh.z - 2.5, 0, 1)], near);
          yawU = lerp(yawU, -0.85, near);
          arch = lerp(arch, -0.1, near);
          headPitch = -0.28 * near;
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
      headPitch = 0.12;
    } else if (receiving) {
      hand = [0.12, 0.38, 1.72]; rdir = [0.1, 0.15, 1]; handL = [0.32, -0.3, 1.32];
      crouch = 0.17 + 0.012 * bob; lean = 0.28; fL = 0.24; fR = -0.22; W = 0.2;
    } else if (game.phase === 'serve') {
      crouch = 0.13; lean = 0.2; hand = [0.3, 0.32, 1.38];
    }
    // после очка: радость или досада
    const variant = p.id % 3;
    if (afterPoint && !st.rec) {
      const t = st.pointT;
      trackHead = false;
      if (won) {
        const pump = Math.sin(clamp(t - 0.1, 0, 3) * 10) * Math.exp(-t * 1.1);
        if (variant === 0) {        // кулак вверх: ракетка к небу
          hand = [0.06, 0.32, 2.06]; rdir = [0.05, 0.1, 1];
          handL = [0.22, -0.22, 1.36 + 0.16 * pump];
          headPitch = -0.12;
        } else if (variant === 1) { // «банзай» обеими руками
          hand = [0.04, 0.44, 1.98]; rdir = [0.1, 0.45, 1];
          handL = [0.04, -0.44, 1.98 + 0.08 * pump];
          headPitch = -0.15;
        } else {                    // «Да!»: присел, кулак вниз к бедру
          hand = [0.2, 0.42, 1.5]; rdir = [0.2, 0.5, 0.8];
          handL = [0.3, -0.2, 0.92 + 0.18 * Math.max(0, pump)];
          crouch = 0.2; lean = 0.32; arch = 0.18; headPitch = -0.15;
        }
        if (variant !== 2) {
          hop = Math.max(hop, t > 0.08 && t < 0.42 ? 0.16 * Math.sin(Math.PI * (t - 0.08) / 0.34) : 0);
          lean = -0.05; crouch = 0.04; arch = -0.08;
        }
        yawU = 0;
      } else {
        const k = smoothstep(0.1, 0.6, t);
        if (variant === 1) { // руки на коленях
          hand = V.lerp(hand, [0.32, 0.22, 0.6], k); rdir = V.lerp(rdir, [0.35, 0.15, -1], k);
          handL = V.lerp(handL, [0.32, -0.22, 0.6], k);
          lean = lerp(lean, 0.72, k); crouch = lerp(crouch, 0.2, k); arch = lerp(arch, 0.15, k);
        } else {             // опущенная голова, ракетка висит
          hand = V.lerp(hand, [0.18, 0.32, 0.62], k); rdir = V.lerp(rdir, [0.25, 0.15, -1], k);
          handL = V.lerp(handL, [0.26, -0.12, 1.4], k); // рука ко лбу
          lean = lerp(lean, 0.35, k); crouch = lerp(crouch, 0.12, k); arch = lerp(arch, 0.2, k);
        }
        headPitch = 0.55 * k; yawU = 0;
      }
    }

    // --- удар: смешивание с ключами ---
    let swingTarget = 0, lungeK = 0, jumpCrouch = 0, swPh = 0;
    if (rec) {
      const C = rec.contactAt;
      const strike = Math.min(0.09, C * 0.6);
      const wind = C - strike;
      let ph;
      if (rec.t < wind) ph = 0.4 * easeOutCubic(rec.t / Math.max(1e-3, wind));
      else if (rec.t < C) ph = 0.4 + 0.15 * easeInQuad((rec.t - wind) / Math.max(1e-3, strike));
      // контакт держим один шаг симуляции (1/120 с): удар засчитывается чуть позже contactAt,
      // и без паузы ракетка уже улетала бы в проводку
      else ph = 0.55 + 0.45 * easeOutCubic(Math.max(0, rec.t - C - 0.0095) / 0.32);
      swPh = ph;
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
      arch = lerp(arch, v[12] * (rec.jump ? 1.25 : 1), sw);
      handOmega = 46;
      if (rec.jump) {
        // глубокий присед перед толчком, затем вытягиваемся в струну
        const tt = C - rec.t;
        jumpCrouch = tt > 0.22 ? 0.15 : tt > 0 ? -0.04 : 0;
        headPitch = -0.32;
      }
      if (rec.lunge && Cl) lungeK = 1;
      if (rec.kind === 'overhead') headPitch = Math.min(headPitch, -0.32 * (1 - smoothstep(0.55, 0.8, ph)));
      // разворот ног к волану на ударе
      if (Cl && rec.kind !== 'overhead' && rec.kind !== 'serve') yawL = lerp(yawL, clamp(Math.atan2(Cl[1], Math.max(0.2, Cl[0])) * 0.5, -0.7, 0.7), 0.7);
      if (rec.kind === 'overhead') yawL = lerp(yawL, -0.6, smoothstep(0, 0.4, ph) * (1 - smoothstep(0.55, 0.9, ph)));
    }
    // выпад держим и на восстановлении
    if (!rec && p.action === 'recover' && p.lastSwing && p.lastSwing.lunge) lungeK = 1;
    st.swW.step(swingTarget, swingTarget ? 60 : 11, dt);

    // --- выпад: ракеточная нога далеко вперёд к волану, задняя — прямая ---
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
      feetR = [dir[0] * 0.86 + pr[0] * 0.12, dir[1] * 0.86 + pr[1] * 0.12 + 0.08];
      feetL = [-dir[0] * 0.48 - pr[0] * 0.16, -dir[1] * 0.48 - pr[1] * 0.16 - 0.1];
      pelvisOff = [dir[0] * 0.22, dir[1] * 0.22, 0];
      crouch = 0.33; lean = 0.32; arch = 0.04;
      // свободная рука уходит назад для баланса
      handL = V.lerp(handL, [-dir[0] * 0.3 - 0.05, -0.42, 1.05], 0.75);
      yawL = clamp(Math.atan2(dir[1], dir[0]) * 0.7, -1.0, 1.0);
      yawU = lerp(yawU, yawL, 0.5);
    }

    // --- голова следит за воланом ---
    if (trackHead && sh && !serveWait) {
      const sl = toNet(sh.x, sh.y);
      const dHead = Math.hypot(sl[0], sl[1]);
      if (dHead > 0.3) headYawT = clamp(angleWrap(Math.atan2(sl[1], sl[0]) - yawU), -0.9, 0.9) * 0.75;
      if (headPitch === 0) headPitch = clamp(-Math.atan2(sh.z - 1.75, Math.max(0.5, dHead)) * 0.55, -0.55, 0.3);
    }

    // --- пружины ---
    const yL = st.yawL.step(yawL, 11, dt);
    const yUs = st.yawU.step(yawU, rec ? 20 : 10, dt);
    const hY = st.headYaw.step(headYawT, 9, dt);
    const hP = st.headPitch.step(headPitch, 9, dt);
    const crS = st.crouch.step(crouch + jumpCrouch, 16, dt);
    const lnS = st.lean.step(lean, 12, dt);
    const rl = st.roll.step(roll, 9, dt);
    const arS = st.arch.step(arch, rec ? 22 : 10, dt);
    // Во время удара кисть идёт точно по сплайну (пружина лишь вводит/выводит из удара),
    // иначе запаздывание пружины уводит ракетку от волана в момент контакта.
    const exS = st.swExact.step(rec ? 1 : 0, rec ? 30 : 12, dt);
    // к моменту контакта — строго 1 (иначе на коротком замахе ракетка не доходит до волана)
    const ex = rec ? Math.max(exS, smoothstep(0, rec.contactAt * 0.92, rec.t)) : exS;
    const hd = V.lerp(st.hand.step(hand, handOmega, dt), hand, ex);
    const rd = V.norm(V.lerp(st.rdir.step(V.norm(rdir), handOmega, dt), V.norm(rdir), ex));
    const hl = V.lerp(st.handL.step(handL, rec ? 26 : 12, dt), handL, ex * 0.6);
    const ar = lerp(arS, arch, ex);
    // корпус на ударе тоже идёт точно по сплайну ключей (иначе плечо запаздывает и ракетка не дотягивается)
    const yU = lerp(yUs, yawU, ex * 0.85), ln = lerp(lnS, lean, ex * 0.85), cr = lerp(crS, crouch + jumpCrouch, ex * 0.6); // на ударе прогиб точно по ключам — плечо там, где его ждёт подгонка контакта
    const pv = st.pelvis.step(pelvisOff, 14, dt);
    const zPrev = st.bodyZ.x;
    const bzS = Math.max(0, st.bodyZ.step(p.z + hop, 30, dt));
    const bz = rec && rec.jump ? lerp(bzS, p.z + hop, ex) : bzS; // в прыжке высота тела — точно как в симуляции
    // приземление: амортизация
    if (st.airborne && bz < 0.015 && zPrev >= bz) { st.crouch.kick(1.6); st.airborne = false; }
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
      else { const t = (ps - STANCE) / (1 - STANCE); off = lerp(-0.5, 0.5, smoothstep(0, 1, t)) * STANCE * stride; lift = Math.sin(Math.PI * t) * (0.07 + 0.04 * Math.min(speed, 5)); }
      return { off, lift, press };
    };
    const gR = gait(0), gL = gait(1);
    const runBob = -0.04 * gW * Math.max(gR.press, gL.press) + (shuffle ? 0.03 * gW * Math.max(gR.lift, gL.lift) / 0.12 : 0);
    // стопы: опорная точка стойки — пружина (шаг в стойку/выпад), поверх неё — походка.
    // Смещение походки задаётся в метрах мира (делим на K), иначе стопа «проскальзывает».
    const fOmega = lungeK ? 20 : 15;
    const baseR = st.footR.step([feetR[0], feetR[1], 0], fOmega, dt);
    const baseL = st.footL.step([feetL[0], feetL[1], 0], fOmega, dt);
    let FR = [baseR[0] + vdir[0] * gR.off * gW / K, baseR[1] + vdir[1] * gR.off * gW / K, gR.lift * gW];
    let FL = [baseL[0] + vdir[0] * gL.off * gW / K, baseL[1] + vdir[1] * gL.off * gW / K, gL.lift * gW];
    // в воздухе — «ножницы»: до удара ракеточная нога отведена назад, после — меняются местами
    if (bz > 0.01) {
      const a = Math.min(1, bz / 0.22);
      let sc = 0;
      if (rec && rec.jump) sc = smoothstep(rec.contactAt - 0.04, rec.contactAt + 0.14, rec.t);
      const back = lerp(-0.3, 0.14, sc), fwd = lerp(0.16, -0.26, sc);
      FR = [FR[0] + back * a, FR[1], FR[2] + bz * 0.8 + lerp(0.2, 0.06, sc) * a];
      FL = [FL[0] + fwd * a, FL[1], FL[2] + bz * 0.8 + lerp(0.06, 0.18, sc) * a];
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
    // поясница → грудь: прогиб/складка (arch) не меняет высоту плеч к контакту
    const chestDir = V.norm(V.add(V.scale(spineDir, Math.cos(ar)), V.scale(FU, Math.sin(ar))));
    const midSp = V.madd(pelvis, spineDir, D.spine * 0.48 * K);
    const neckB = V.madd(midSp, chestDir, D.spine * 0.52 * K);
    const shC = V.madd(neckB, chestDir, -0.05 * K);
    const shR = V.madd(shC, RU, D.shoulderW * K), shL = V.madd(shC, RU, -D.shoulderW * K);
    const FH = yawF(yU + hY);
    const headDir = V.norm(V.add(V.scale(chestDir, Math.cos(hP)), V.scale(FH, Math.sin(hP))));
    const headC = V.madd(V.madd(neckB, headDir, (D.neck + D.headR * 0.95) * K), FH, 0.02 * K);
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
    // ноги: стопы — от пола (FR[2] уже в метрах), а не от поднятого прыжком тела
    const G = (l) => [pos.x + (F0[0] * l[0] + R0[0] * l[1]) * K, pos.y + (F0[1] * l[0] + R0[1] * l[1]) * K, l[2]];
    const toes = gW < 0.5 && bz < 0.01 ? 0.012 * bob : 0; // на носках
    const ankR = V.add(G(FR), [0, 0, D.ankle * K + toes]);
    const ankL = V.add(G(FL), [0, 0, D.ankle * K + toes]);
    const poleKR = V.norm(V.add(FLo, V.scale(RLo, 0.25))), poleKL = V.norm(V.add(FLo, V.scale(RLo, -0.25)));
    const legR = ik2(hipR, ankR, D.thigh * K, D.shin * K, poleKR);
    const legL = ik2(hipL, ankL, D.thigh * K, D.shin * K, lungeK > 0.5 ? V.norm(V.add(V.scale(FLo, 0.3), [0, 0, -1])) : poleKL);
    // направление стоп: по ногам, носки чуть наружу; в воздухе носок тянется вниз
    const footDir = (side) => yawF(yL + side * 0.3);
    const point = bz > 0.05 ? 0.06 : 0;
    const toeR = V.madd(legR.end, footDir(1), 0.15 * K), heelR = V.madd(legR.end, footDir(1), -0.045 * K);
    const toeL = V.madd(legL.end, footDir(-1), 0.15 * K), heelL = V.madd(legL.end, footDir(-1), -0.045 * K);
    toeR[2] = Math.max(0.02, toeR[2] - D.ankle * K * 0.8 - point); heelR[2] = Math.max(0.03, heelR[2] - D.ankle * K * 0.4);
    toeL[2] = Math.max(0.02, toeL[2] - D.ankle * K * 0.8 - point); heelL[2] = Math.max(0.03, heelL[2] - D.ankle * K * 0.4);

    // --- оси головы (для причёски и лица) ---
    const Uh = headDir;
    const Fh = V.norm(V.madd(FH, Uh, -V.dot(FH, Uh)));
    let Rh = V.madd(V.madd(RU, Uh, -V.dot(RU, Uh)), Fh, -V.dot(RU, Fh));
    Rh = V.norm(Rh);
    const hr = D.headR * K;
    const toLocal = (wv) => [V.dot(wv, Rh) / hr, V.dot(wv, Uh) / hr, V.dot(wv, Fh) / hr];
    const fromLocal = (l) => [headC[0] + (Rh[0] * l[0] + Uh[0] * l[1] + Fh[0] * l[2]) * hr, headC[1] + (Rh[1] * l[0] + Uh[1] * l[1] + Fh[1] * l[2]) * hr, headC[2] + (Rh[2] * l[0] + Uh[2] * l[1] + Fh[2] * l[2]) * hr];

    // --- вторичная динамика ---
    const down = [0, 0, -1];
    const hw = st.hairW.step(headC, dt);
    let lagW = V.scale(V.sub(hw, headC), 1 / hr);
    lagW = V.add(lagW, [-p.vx * 0.05, -p.vy * 0.05, 0]);
    const ll = V.len(lagW); if (ll > 0.9) lagW = V.scale(lagW, 0.9 / ll);
    const lag = [V.dot(lagW, Rh), V.dot(lagW, Uh), V.dot(lagW, Fh)];
    let tailL = null, ribL = null;
    const look = st.look;
    if (st.tail) {
      const r0 = fromLocal(look.tail.root);
      const pts = st.tail.step(r0, (i, prev) => {
        const d = i === 0 ? V.norm(V.add(V.scale(Fh, -0.6), V.scale(Uh, 0.2))) : V.norm(V.add(V.scale(Fh, -0.3 + 0.05 * i), V.scale(down, 0.6 + 0.25 * i)));
        return V.madd(prev, d, look.tail.seg * K);
      }, dt, 1.6);
      tailL = pts.map(q => toLocal(V.sub(q, headC)));
    }
    if (st.ribbons) {
      const knot = fromLocal([0, 0.15, -1.07]);
      ribL = st.ribbons.map((ch, j) => {
        const sgn = j ? 1 : -1;
        const pts = ch.step(knot, (i, prev) => {
          const d = V.norm(V.add(V.add(V.scale(Fh, -0.55 + 0.1 * i), V.scale(down, 0.75 + 0.25 * i)), V.scale(Rh, sgn * (0.3 - 0.08 * i))));
          return V.madd(prev, d, look.band.tailLen * K);
        }, dt, 2);
        return pts.map(q => toLocal(V.sub(q, headC)));
      });
    }
    const hemLag = clamp((st.hemW.step(bz, dt) - bz) / 0.08, -1, 1);
    const pl = st.pelW.step(pelvis, dt);
    let pelLag = V.sub(pl, pelvis); pelLag[2] = 0;
    const pll = V.len(pelLag); if (pll > 0.12) pelLag = V.scale(pelLag, 0.12 / pll);

    // --- эмоции ---
    st.blinkT -= dt;
    if (st.blinkT < 0) { st.blink = 1; st.blinkT = 2 + Math.random() * 3.2; }
    st.blink = Math.max(0, st.blink - dt * 7);
    let mood = 'focus';
    if (afterPoint && !st.rec) mood = won ? (variant === 2 && st.pointT < 0.9 ? 'shout' : 'happy') : 'sad';
    else if (rec && (rec.type === 'smash' || rec.jump) && swPh > 0.18 && swPh < 0.8) mood = 'shout';
    else if (rec && lungeK > 0 && swPh > 0.3 && swPh < 0.75) mood = 'shout';
    else if (rec && swPh > 0.35 && swPh < 0.7) mood = 'effort';
    else if (speed > 3.4) mood = 'effort';
    else if (game.phase === 'serve' && !receiving) mood = 'calm';
    else if (game.phase !== 'rally') mood = 'calm';
    st.mood = mood;
    st.sweat = mood === 'sad' ? clamp(st.pointT * 0.8, 0, 1) : 0;
    // взгляд на волан
    let gaze = null;
    if (sh && game.phase === 'rally') {
      const dsh = V.norm(V.sub([sh.x, sh.y, sh.z / ZS], headC));
      gaze = [clamp(V.dot(dsh, Rh) * 1.6, -1, 1), clamp(-V.dot(dsh, Uh) * 1.6, -1, 1)];
    }

    // след ракетки (для смаза)
    const tip = V.madd(rHead, rdW, D.racketA * K), throat = V.madd(rHead, rdW, -D.racketA * K);
    st.trail.push({ tip, throat, rec: !!rec });
    if (st.trail.length > 6) st.trail.shift();

    st.sk = {
      root, pelvis, hipR, hipL, midSp, neckB, shR, shL, headC, headDir, FH, FU, RU, FLo, RLo, spineDir, chestDir,
      elbowR: armR.mid, handR: armR.end, elbowL: armL.mid, handL: armL.end,
      kneeR: legR.mid, ankR: legR.end, kneeL: legL.mid, ankL: legL.end, toeR, heelR, toeL, heelL,
      grip, rHead, butt, rdW, face, across, bz,
      Rh, Uh, Fh, lag, tailL, ribL, hemLag, pelLag, gaze,
      color: p.color, accent: p.accent || '#333', human: p.controller === 'human', swinging: !!rec,
    };
  }

  // ------------------------------------------------------------ отрисовка
  let ZSd = 1;
  function P(a) { return project(a[0], a[1], a[2] * ZSd); }
  function lerp2(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: a.s + (b.s - a.s) * t, d: a.d }; }

  let shadowSprite = null;
  function getShadow() {
    if (shadowSprite) return shadowSprite;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(4,10,24,0.6)'); gr.addColorStop(0.6, 'rgba(4,10,24,0.32)'); gr.addColorStop(1, 'rgba(4,10,24,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return (shadowSprite = c);
  }
  /** Мягкая тень-эллипс на полу: аффинное отображение спрайта на проекцию квадрата. */
  function groundShadow(x, y, rx, ry, alpha) {
    const c = project(x, y, 0);
    const a = project(x + rx, y, 0);
    const b = project(x, y + ry, 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.transform((a.x - c.x) / 32, (a.y - c.y) / 32, (b.x - c.x) / 32, (b.y - c.y) / 32, c.x, c.y);
    ctx.drawImage(getShadow(), -32, -32);
    ctx.restore();
  }

  /** Эллиптическое сечение тела: центр c, полуоси rx (по R) и rz (по F) — точки на экране. */
  function ring(out, c, R, F, rx, rz, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      out.push(P([c[0] + R[0] * rx * sa + F[0] * rz * ca, c[1] + R[1] * rx * sa + F[1] * rz * ca, c[2] + R[2] * rx * sa + F[2] * rz * ca]));
    }
    return out;
  }
  function toCam(pt) {
    const e = camera.eye || [0, 0, 20];
    return V.norm([e[0] - pt[0], e[1] - pt[1], e[2] - pt[2] * ZSd]);
  }

  // --- адаптивное качество: если кадры стабильно медленные (слабый телефон),
  // упрощаем детали (лица/пряди/блики). quality: 'auto' | 'full' | 'lite'.
  const perf = { quality: 'auto', lite: false, last: 0, ema: 1 / 60, slow: 0, fast: 0 };
  function trackFrame() {
    const now = performance.now();
    const dt = perf.last ? (now - perf.last) / 1000 : 1 / 60;
    perf.last = now;
    if (dt > 0.25) return; // пауза/вкладка в фоне
    perf.ema += (dt - perf.ema) * 0.05;
    if (perf.ema > 1 / 42) { perf.slow += dt; perf.fast = 0; } else if (perf.ema < 1 / 56) { perf.fast += dt; perf.slow = 0; }
    if (perf.slow > 2) perf.lite = true;
    if (perf.fast > 6) perf.lite = false;
  }
  function isLite() { return perf.quality === 'lite' || (perf.quality === 'auto' && perf.lite); }

  function draw(p) {
    const st = states.get(p); if (!st || !st.sk) return;
    if (p === firstPlayer) trackFrame();
    const k = st.sk, look = st.look;
    ZSd = st.ZS || 1;
    const sc = P(k.pelvis).s;
    const ol = clamp(0.55 + sc * 0.02, 0.9, 2.2);   // внешний контур, px
    const S = m => m * K * sc;                        // метры → пиксели
    const f = look.build === 'f';

    // тени на полу
    const air = clamp(1 - k.bz * 1.4, 0.35, 1);
    groundShadow(k.root[0] - p.side * 0.04, k.root[1], 0.5 * K * (1.1 - air * 0.1), 0.36 * K, 0.8 * air);
    if (sc >= 34) {
      groundShadow(k.toeR[0], k.toeR[1], 0.15, 0.11, 0.55 * clamp(1 - k.toeR[2] * 6, 0, 1));
      groundShadow(k.toeL[0], k.toeL[1], 0.15, 0.11, 0.55 * clamp(1 - k.toeL[2] * 6, 0, 1));
    }

    const q = {};
    for (const n of ['pelvis', 'hipR', 'hipL', 'midSp', 'neckB', 'shR', 'shL', 'headC', 'elbowR', 'handR', 'elbowL', 'handL',
      'kneeR', 'ankR', 'kneeL', 'ankL', 'toeR', 'heelR', 'toeL', 'heelL', 'grip', 'rHead', 'butt']) q[n] = P(k[n]);

    drawSwoosh(st, k);

    // дальний/мелкий игрок или слабое устройство — плоские конечности без тени
    const flat = isLite() || sc < 34;
    const C = {
      skin: look.skin, skinSh: flat ? null : tone(look.skin, 'skinShadow'), skinRim: tone(look.skin, 'rim'),
      shirt: k.color, shirtSh: flat ? null : tone(k.color, 'shadow'), shirtRim: tone(k.color, 'rim'),
      accent: k.accent, accentSh: flat ? null : tone(k.accent, 'shadow'),
    };
    const parts = [];
    parts.push({ n: 'leg', d: (q.hipR.d + q.kneeR.d) / 2, f: () => drawLeg(k, q, 'R', S, ol, C, look) });
    parts.push({ n: 'leg', d: (q.hipL.d + q.kneeL.d) / 2, f: () => drawLeg(k, q, 'L', S, ol, C, look) });
    parts.push({ n: 'torso', d: q.pelvis.d - 0.001, f: () => drawTorso(p, k, q, S, ol, C, look) });
    parts.push({ n: 'head', d: q.headC.d - 0.002, f: () => drawHeadPart(st, k, q, S, ol, look) });
    // рука: впереди/позади корпуса — по глубине локтя относительно плеч
    parts.push({ n: 'arm', d: (q.elbowR.d + q.handR.d + q.shR.d) / 3, f: () => drawArm(k, q, 'R', S, ol, C, look) });
    parts.push({ n: 'arm', d: (q.elbowL.d + q.handL.d + q.shL.d) / 3, f: () => drawArm(k, q, 'L', S, ol, C, look) });
    parts.push({ n: 'racket', d: q.rHead.d - 0.003 * (q.rHead.d < q.handR.d ? 1 : -1), f: () => drawRacket(k, q, S, ol, look) });
    parts.sort((a, b) => b.d - a.d);
    for (const it of parts) it.f();
    void f;

    if (k.human) {
      const top = P(V.add(k.headC, [0, 0, 0.55 * K]));
      const r = clamp(S(0.07), 4, 8);
      ctx.fillStyle = '#ffe27a'; ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(top.x, top.y + r); ctx.lineTo(top.x - r, top.y - r * 0.7); ctx.lineTo(top.x + r, top.y - r * 0.7); ctx.closePath();
      ctx.stroke(); ctx.fill();
    }
  }

  // ---------------------------------------------------------- ноги, шорты, обувь
  function drawLeg(k, q, side, S, ol, C, look) {
    const hip = q['hip' + side], knee = q['knee' + side], ank = q['ank' + side];
    const big = S(0.14) > 5;
    celCapsule(ctx, [hip, knee, ank], [S(0.15), S(0.115)], C.skin, C.skinSh, ol, big ? C.skinRim : null);
    // гольфы
    const sockTop = lerp2(knee, ank, 0.6);
    celCapsule(ctx, [sockTop, ank], S(0.112), '#f4f5fb', null, 0, null);
    ctx.strokeStyle = C.accent; ctx.lineWidth = Math.max(0.8, S(0.022)); ctx.lineCap = 'butt';
    const st1 = lerp2(sockTop, ank, 0.16);
    const nx = -(ank.y - sockTop.y), ny = ank.x - sockTop.x, nl = Math.hypot(nx, ny) || 1, hw = S(0.056);
    ctx.beginPath(); ctx.moveTo(st1.x + nx / nl * hw, st1.y + ny / nl * hw); ctx.lineTo(st1.x - nx / nl * hw, st1.y - ny / nl * hw); ctx.stroke();
    drawShoe(k, side, S, ol, C);
    // шорты (у юбки — общая деталь в корпусе)
    if (look.bottom !== 'skirt') {
      const H3 = k['hip' + side], K3 = k['knee' + side];
      const pts = [];
      ring(pts, V.madd(k.pelvis, k.spineDir, 0.05 * K), k.RLo, k.FLo, 0.15 * K, 0.105 * K, 10);
      const th = V.lerp(H3, K3, 0.4);
      const ax = V.norm(V.sub(K3, H3));
      let r1 = V.norm(V.cross(ax, k.FLo)); if (V.len(V.cross(ax, k.FLo)) < 0.1) r1 = k.RLo;
      const f1 = V.norm(V.cross(r1, ax));
      ring(pts, th, r1, f1, 0.088 * K, 0.088 * K, 8);
      const hull = hull2(pts);
      const shorts = look.shorts || '#1d2238';
      celPoly(ctx, hull, shorts, C.shirtSh ? tone(shorts, 'shadow') : null, S(0.06), ol);
      // боковой кант цвета формы
      const a = P(V.madd(V.madd(k.pelvis, k.spineDir, 0.02 * K), k.RLo, (side === 'R' ? 1 : -1) * 0.17 * K));
      const b = P(V.madd(th, r1, (side === 'R' ? 1 : -1) * 0.1 * K));
      ctx.strokeStyle = C.shirt; ctx.lineWidth = Math.max(0.8, S(0.03)); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  function drawShoe(k, side, S, ol, C) {
    const heel = k['heel' + side], toe = k['toe' + side];
    let fd = V.sub(toe, heel); fd[2] = 0; fd = V.norm(fd);
    const sd = V.norm(V.cross(fd, [0, 0, 1]));
    const pts = [];
    const add = (base, w, h) => { pts.push(P(V.madd(base, sd, w)), P(V.madd(base, sd, -w)), P(V.add(V.madd(base, sd, w), [0, 0, h])), P(V.add(V.madd(base, sd, -w), [0, 0, h]))); };
    const hb = V.madd(heel, fd, -0.01), tb = V.madd(toe, fd, 0.02);
    add([hb[0], hb[1], hb[2] - 0.035], 0.045 * K, 0.1 * K);
    add([tb[0], tb[1], tb[2] - 0.02], 0.045 * K, 0.05 * K);
    const md = V.lerp(heel, toe, 0.5);
    add([md[0], md[1], md[2] - 0.03], 0.055 * K, 0.085 * K);
    const hull = hull2(pts);
    celPoly(ctx, hull, '#fbfbff', C.shirtSh ? '#b9bfd8' : null, S(0.05), ol);
    // подошва и полоса в цвет героя
    const a = P(V.lerp(heel, toe, 0.15)), b = P(V.lerp(heel, toe, 0.85));
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.shirt; ctx.lineWidth = Math.max(1, S(0.035));
    const lift = S(0.03);
    ctx.beginPath(); ctx.moveTo(a.x, a.y - lift); ctx.lineTo(b.x, b.y - lift * 0.6); ctx.stroke();
  }

  // ---------------------------------------------------------- корпус: майка, номер, юбка
  function drawTorso(p, k, q, S, ol, C, look) {
    const f = look.build === 'f';
    const KK = K;
    const hemDrop = -k.hemLag * 0.05 * KK;
    if (look.bottom === 'skirt') {
      const pts = [];
      const wc = V.madd(k.pelvis, k.spineDir, 0.06 * KK);
      ring(pts, wc, k.RLo, k.FLo, 0.16 * KK, 0.11 * KK, 10);
      const hc = V.add(V.madd(k.pelvis, k.spineDir, -0.2 * KK + hemDrop), V.scale(k.pelLag, 1.2));
      const flare = 1 + Math.max(0, -k.hemLag) * 0.3;
      const hemPts = ring([], hc, k.RLo, k.FLo, 0.25 * KK * flare, 0.2 * KK * flare, 12);
      const hull = hull2(pts.concat(hemPts));
      celPoly(ctx, hull, C.accent, C.accentSh, S(0.07), ol);
      // складки
      ctx.strokeStyle = tone(C.accent, 'deep'); ctx.lineWidth = Math.max(0.6, ol * 0.5); ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 12; i += 2) {
        const a = pts[(i * 10 / 12) | 0], b = hemPts[i];
        if (!a || !b) continue;
        ctx.moveTo(a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.strokeStyle = C.shirt; ctx.lineWidth = Math.max(0.8, S(0.025));
      smoothPath(ctx, hemPts); ctx.stroke();
    }
    // майка: оболочка сечений плечи → грудь → талия → подол
    const sw = f ? 0.17 : 0.2;
    const secs = [];
    const shC = V.madd(k.neckB, k.chestDir, -0.06 * KK);
    const chest = V.madd(k.neckB, k.chestDir, -0.17 * KK);
    const waist = V.madd(k.midSp, k.spineDir, -0.03 * KK);
    const hem = V.add(V.madd(k.pelvis, k.spineDir, 0.02 * KK + hemDrop), V.scale(k.pelLag, 0.8));
    ring(secs, shC, k.RU, k.FU, sw * KK, 0.09 * KK);
    ring(secs, chest, k.RU, k.FU, (f ? 0.165 : 0.185) * KK, (f ? 0.125 : 0.12) * KK);
    ring(secs, waist, k.RLo, k.FLo, (f ? 0.13 : 0.15) * KK, 0.1 * KK);
    ring(secs, hem, k.RLo, k.FLo, (f ? 0.16 : 0.17) * KK, 0.12 * KK);
    const hull = hull2(secs);
    const path = () => smoothPath(ctx, hull);
    celPoly(ctx, hull, C.shirt, C.shirtSh, S(0.09), ol);
    // детали формы внутри силуэта
    ctx.save(); path(); ctx.clip();
    const tc = toCam(chest);
    const frontFace = V.dot(k.FU, tc);
    // боковые вставки цвета акцента
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const sgn of [1, -1]) {
      const nrm = V.madd(V.scale(k.RU, sgn), k.FU, 0);
      if (V.dot(nrm, tc) < -0.5) continue;
      const a = P(V.madd(V.madd(chest, k.RU, sgn * 0.17 * KK), k.chestDir, 0.04 * KK));
      const b = P(V.madd(waist, k.RLo, sgn * 0.14 * KK));
      const c = P(V.madd(hem, k.RLo, sgn * 0.165 * KK));
      ctx.strokeStyle = C.accent; ctx.lineWidth = S(0.07);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke();
    }
    // плечевая кокетка (диагональ через грудь/спину)
    {
      const nrmS = frontFace >= 0 ? 1 : -1;
      const a = P(V.madd(V.madd(shC, k.RU, -0.2 * KK), k.FU, nrmS * 0.09 * KK));
      const b = P(V.madd(V.madd(waist, k.RLo, 0.16 * KK), k.FLo, nrmS * 0.1 * KK));
      ctx.strokeStyle = C.shirtRim; ctx.globalAlpha = 0.55; ctx.lineWidth = S(0.03);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // номер: крупно на спине, мелко на груди
    const back = frontFace < -0.15;
    const fs = S(back ? 0.2 : 0.085);
    if (fs > 4.5) {
      const nc = back ? P(V.madd(V.lerp(chest, waist, 0.35), k.FU, -0.13 * KK)) : P(V.madd(V.madd(chest, k.FU, 0.125 * KK), k.RU, -0.08 * KK));
      let dx = q.shR.x - q.shL.x, dy = q.shR.y - q.shL.y;
      if (dx < 0) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy), exp = S(2 * D.shoulderW);
      const sx = clamp(len / exp, 0.25, 1);
      ctx.translate(nc.x, nc.y); ctx.rotate(Math.atan2(dy, dx)); ctx.scale(sx, 1);
      ctx.font = `900 ${fs.toFixed(1)}px ${NUM_FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const t = String(look.number || p.id + 1);
      ctx.lineWidth = Math.max(1, fs * 0.18); ctx.strokeStyle = C.accent; ctx.strokeText(t, 0, 0);
      ctx.fillStyle = '#ffffff'; ctx.fillText(t, 0, 0);
    }
    ctx.restore();
    // внутренний контур подола
    // воротник
    const nb = k.neckB;
    const col = [];
    const cd = k.chestDir;
    const cr = V.norm(V.madd(k.RU, cd, -V.dot(k.RU, cd)));
    const cf = V.norm(V.cross(cr, cd));
    for (let i = 0; i <= 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const vdip = Math.cos(a) > 0.7 ? -0.05 * KK * (Math.cos(a) - 0.7) / 0.3 : 0; // V-вырез спереди
      col.push(P(V.madd(V.madd(V.madd(nb, cr, Math.sin(a) * 0.085 * KK), cf, Math.cos(a) * 0.075 * KK * Math.sign(V.dot(cf, k.FU) || 1)), cd, vdip - 0.01 * KK)));
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = S(0.04) + ol;
    ctx.beginPath(); col.forEach((c, i) => i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)); ctx.stroke();
    ctx.strokeStyle = C.accent; ctx.lineWidth = S(0.04);
    ctx.stroke();
  }

  // ---------------------------------------------------------- руки
  function drawArm(k, q, side, S, ol, C, look) {
    const sh = q['sh' + side], el = q['elbow' + side], hd = q['hand' + side];
    const big = S(0.09) > 5;
    celCapsule(ctx, [sh, el, hd], [S(0.088), S(0.078)], C.skin, C.skinSh, ol, big ? C.skinRim : null);
    // рукав с окантовкой
    const sl = lerp2(sh, el, 0.46);
    celCapsule(ctx, [lerp2(sh, el, 0.08), sl], S(0.12), C.shirt, C.shirtSh, ol, null);
    const s2 = lerp2(sh, el, 0.43);
    celCapsule(ctx, [s2, sl], S(0.115), C.accent, null, 0, null);
    // напульсник
    celCapsule(ctx, [lerp2(el, hd, 0.7), lerp2(el, hd, 0.86)], S(0.095), side === 'R' ? C.shirt : '#f4f5fb', null, ol * 0.7, null);
    // кисть
    const r = Math.max(1.3, S(0.052));
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(hd.x, hd.y, r + ol * 0.8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.skin; ctx.beginPath(); ctx.arc(hd.x, hd.y, r, 0, Math.PI * 2); ctx.fill();
    void look;
  }

  // ---------------------------------------------------------- голова
  /** Экранный базис головы для head.js (без вертикальной растяжки — голова круглая). */
  function headBasisOf(k) {
    const c3 = [k.headC[0], k.headC[1], k.headC[2] * ZSd];
    const c = project(c3[0], c3[1], c3[2]);
    const rw = D.headR * K;
    const tc = toCam(k.headC);
    const ax = (a) => { const e = project(c3[0] + a[0] * rw, c3[1] + a[1] * rw, c3[2] + a[2] * rw); return { x: e.x - c.x, y: e.y - c.y, t: V.dot(a, tc) }; };
    return { x: c.x, y: c.y, r: rw * c.s, R: ax(k.Rh), U: ax(k.Uh), F: ax(k.Fh) };
  }

  function drawHeadPart(st, k, q, S, ol, look) {
    // шея
    const nb = q.neckB, nt = P(V.madd(k.neckB, k.headDir, (D.neck + D.headR * 0.6) * K));
    celCapsule(ctx, [nb, nt], S(0.085), tone(look.skin, 'skinShadow'), tone(tone(look.skin, 'skinShadow'), 'skinShadow'), ol, null);
    const H = headBasisOf(k);
    const lod = isLite() ? 0 : H.r >= 16 ? 2 : H.r >= 3.5 ? 1 : 0;
    st.headScr = { x: H.x, y: H.y, r: H.r };
    drawHead(ctx, H, look, { mood: st.mood, blink: st.blink, gaze: k.gaze, sweat: st.sweat }, { lag: k.lag, tail: k.tailL, ribbons: k.ribL }, { ol: clamp(ol * 0.9, 0.8, 2), lod });
  }

  // ---------------------------------------------------------- ракетка
  function drawRacket(k, q, S, ol, look) {
    const throat = P(V.madd(k.rHead, k.rdW, -D.racketA * K));
    const tj = P(V.madd(k.rHead, k.rdW, -D.racketA * K * 1.25));
    ctx.lineCap = 'round';
    // рукоять: обмотка цвета героя, торец
    const gw = Math.max(1.8, S(0.038));
    ctx.strokeStyle = INK; ctx.lineWidth = gw + ol * 1.4;
    ctx.beginPath(); ctx.moveTo(q.butt.x, q.butt.y); ctx.lineTo(q.grip.x, q.grip.y); ctx.stroke();
    ctx.strokeStyle = look.grip || k.accent; ctx.lineWidth = gw;
    ctx.beginPath(); ctx.moveTo(q.butt.x, q.butt.y); ctx.lineTo(q.grip.x, q.grip.y); ctx.stroke();
    // стержень
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.4, S(0.02)) + ol * 0.8;
    ctx.beginPath(); ctx.moveTo(q.grip.x, q.grip.y); ctx.lineTo(tj.x, tj.y); ctx.stroke();
    ctx.strokeStyle = '#dfe4f2'; ctx.lineWidth = Math.max(0.8, S(0.014));
    ctx.beginPath(); ctx.moveTo(q.grip.x, q.grip.y); ctx.lineTo(tj.x, tj.y); ctx.stroke();
    // обод: эллипс в плоскости ракетки
    const n = 16, pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      pts.push(P(V.madd(V.madd(k.rHead, k.rdW, Math.cos(a) * D.racketA * K), k.across, Math.sin(a) * D.racketB * K)));
    }
    const path = () => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); };
    path(); ctx.fillStyle = 'rgba(235,242,255,0.2)'; ctx.fill();
    const sz = Math.hypot(pts[0].x - pts[8].x, pts[0].y - pts[8].y);
    if (sz > 10) {
      // струны: сетка внутри обода
      ctx.save(); path(); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 0.6; ctx.beginPath();
      const m = sz > 26 ? 6 : 3;
      for (let i = 1; i < m; i++) {
        const t = -1 + 2 * i / m;
        const a = P(V.madd(V.madd(k.rHead, k.across, t * D.racketB * K), k.rdW, -D.racketA * K));
        const b = P(V.madd(V.madd(k.rHead, k.across, t * D.racketB * K), k.rdW, D.racketA * K));
        const c = P(V.madd(V.madd(k.rHead, k.rdW, t * D.racketA * K), k.across, -D.racketB * K));
        const d = P(V.madd(V.madd(k.rHead, k.rdW, t * D.racketA * K), k.across, D.racketB * K));
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      }
      ctx.stroke(); ctx.restore();
    }
    const fw = Math.max(1.4, S(0.024));
    path(); ctx.lineJoin = 'round';
    ctx.strokeStyle = INK; ctx.lineWidth = fw + ol * 1.6; ctx.stroke();
    ctx.strokeStyle = k.color; ctx.lineWidth = fw; ctx.stroke();
    if (fw > 2) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = fw * 0.3;
      ctx.beginPath(); for (let i = 9; i <= 13; i++) { const p = pts[i]; i === 9 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); } ctx.stroke();
    }
    // горло
    ctx.strokeStyle = INK; ctx.lineWidth = fw + ol; ctx.beginPath(); ctx.moveTo(tj.x, tj.y); ctx.lineTo(throat.x, throat.y); ctx.stroke();
    ctx.strokeStyle = k.color; ctx.lineWidth = fw; ctx.stroke();
  }

  /** Аниме-дуга замаха: сужающийся след обода, белое ядро с кромкой цвета героя. */
  function drawSwoosh(st, k) {
    const tr = st.trail;
    if (tr.length < 3 || !k.swinging) return;
    let maxV = 0;
    for (let i = 1; i < tr.length; i++) maxV = Math.max(maxV, V.len(V.sub(tr[i].tip, tr[i - 1].tip)));
    const a0 = clamp((maxV - 0.06) / 0.2, 0, 0.85);
    if (a0 < 0.05) return;
    const n = tr.length;
    const pts = tr.map(t => { const a = P(t.tip), b = P(t.throat); return { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, w: Math.hypot(a.x - b.x, a.y - b.y) }; });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [col, kw, al] of [[k.color, 0.75, 0.6], ['#ffffff', 0.32, 1]]) {
      ctx.strokeStyle = col;
      for (let i = 1; i < n; i++) {
        const t = i / (n - 1);
        ctx.globalAlpha = a0 * al * t;
        ctx.lineWidth = Math.max(0.8, pts[i].w * kw * t);
        ctx.beginPath(); ctx.moveTo(pts[i - 1].x, pts[i - 1].y); ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function depth(p) {
    const st = states.get(p);
    if (!st || !st.sk) return project(p.x, p.y, 0.9).d;
    return P(st.sk.pelvis).d;
  }

  // ---------------------------------------------------------- бюст для кат-инов
  /**
   * Бюст героя крупным планом (для «аниме-вставки» на смэше, экрана очка и т.п.).
   * who — игрок или id героя; (x, y) — центр головы, r — радиус головы (px);
   * mood — 'shout' | 'happy' | 'sad' | 'focus' | 'calm'; opts {yaw, color, accent, flip}.
   */
  function drawBust(who, x, y, r, mood = 'shout', opts = {}) {
    const id = typeof who === 'string' ? who : who && who.character;
    const look = lookOf(id);
    const color = opts.color || (who && who.color) || '#ffb300', accent = opts.accent || (who && who.accent) || '#333';
    const yaw = opts.yaw != null ? opts.yaw : 0.38;
    const flip = opts.flip ? -1 : 1;
    const ol = clamp(r * 0.06, 1.2, 4);
    ctx.save();
    ctx.translate(x, y); ctx.scale(flip, 1); ctx.translate(-x, -y);
    // плечи и майка
    const sy = y + r * 1.55, sw = r * (look.build === 'f' ? 1.7 : 1.95);
    const torso = () => {
      ctx.beginPath();
      ctx.moveTo(x - sw, y + r * 3.2);
      ctx.quadraticCurveTo(x - sw * 1.02, sy, x - sw * 0.45, sy - r * 0.2);
      ctx.lineTo(x + sw * 0.45, sy - r * 0.2);
      ctx.quadraticCurveTo(x + sw * 1.02, sy, x + sw, y + r * 3.2);
      ctx.closePath();
    };
    celFill(ctx, torso, color, tone(color, 'shadow'), r * 0.35, ol);
    ctx.save(); torso(); ctx.clip();
    ctx.strokeStyle = accent; ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.moveTo(x - sw * 0.98, sy + r * 0.4); ctx.lineTo(x - sw * 0.8, y + r * 3.3); ctx.moveTo(x + sw * 0.98, sy + r * 0.4); ctx.lineTo(x + sw * 0.8, y + r * 3.3); ctx.stroke();
    ctx.font = `900 ${(r * 0.7).toFixed(1)}px ${NUM_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = r * 0.12; ctx.strokeStyle = accent; ctx.strokeText(String(look.number || ''), x + sw * 0.42, sy + r * 0.85);
    ctx.fillStyle = '#fff'; ctx.fillText(String(look.number || ''), x + sw * 0.42, sy + r * 0.85);
    ctx.restore();
    // шея и воротник
    const neck = () => { ctx.beginPath(); ctx.rect(x - r * 0.36, y + r * 0.5, r * 0.72, r * 1.05); };
    celFill(ctx, neck, tone(look.skin, 'skinShadow'), tone(tone(look.skin, 'skinShadow'), 'skinShadow'), r * 0.2, ol);
    ctx.strokeStyle = INK; ctx.lineWidth = r * 0.22 + ol; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - r * 0.6, sy - r * 0.15); ctx.lineTo(x, sy + r * 0.35); ctx.lineTo(x + r * 0.6, sy - r * 0.15); ctx.stroke();
    ctx.strokeStyle = accent; ctx.lineWidth = r * 0.22; ctx.stroke();
    // голова
    const H = headBasis(x, y, r, yaw, 0.06);
    const tail = look.tail ? (() => { const out = [look.tail.root]; let pnt = look.tail.root; for (let i = 0; i < look.tail.n; i++) { const d = i === 0 ? [0, 0.4, -0.9] : [-0.1 * i, -0.85, -0.5]; const l = Math.hypot(...d); pnt = [pnt[0] + d[0] / l * 0.65, pnt[1] + d[1] / l * 0.65, pnt[2] + d[2] / l * 0.65]; out.push(pnt); } return out; })() : null;
    const ribbons = look.band ? [-1, 1].map(sg => [[0, 0.15, -1.07], [0.25 * sg, -0.1, -1.6], [0.45 * sg, -0.45, -2.0], [0.6 * sg, -0.8, -2.3]]) : null;
    drawHead(ctx, H, look, { mood, blink: 0, gaze: [0.4, -0.1], sweat: mood === 'sad' ? 0.5 : 0 }, { lag: [-0.15, 0.05, -0.1], tail, ribbons }, { ol, lod: 2 });
    ctx.restore();
  }

  function headScreen(p) { const st = states.get(p); return st && st.headScr ? { ...st.headScr } : null; }

  return {
    prepare, draw, depth, onHit, onPoint, drawBust, headScreen, _state: p => states.get(p),
    /** Качество отрисовки: 'auto' (по частоте кадров), 'full', 'lite'. */
    get quality() { return perf.quality; }, set quality(q) { perf.quality = q; },
    get lite() { return isLite(); },
  };
}

export { HERO_LOOKS as LOOKS };
