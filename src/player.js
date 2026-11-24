/**
 * player.js — игрок: движение с ускорением, досягаемость, замах, прыжок-смэш,
 * выпад, тайминг контакта (рано / идеально / поздно).
 *
 * Игрок не знает о правилах и об ИИ. Управление приходит через p.input:
 *   p.input.mx, p.input.my — желаемое направление в МИРОВЫХ координатах (|v| ≤ 1);
 *   requestSwing(p, shuttle, type, aimY) — начать удар (контакт будет запланирован).
 * Сам удар (вылет волана) выполняет game.js, когда p.swing.contactAt наступает.
 *
 * Публичный API (не менять сигнатуры):
 *   createPlayer({id, team, idx, character, controller}) -> Player
 *   updatePlayer(p, dt, ctx) -> 'contact' | null     ctx: {mode, halfWidth}
 *   requestSwing(p, shuttle, type, aimY, opts?) -> {ok, delay?, quality?, timing?, reason?}
 *     opts: {buffer, traj, timingNoise, pressure, human, pressAge}
 *     type может быть и 'smashdrop' (кнопка: высоко — смэш, иначе дроп/сетка)
 *   findContact(p, shuttle, maxT?) -> Contact | null
 *   steerTo(p, tx, ty, opts?) — выставляет p.input для движения к точке
 *   resolveShotType(requested, contact, side) -> string
 *   maxSpeed(p) -> number
 *   placePlayer(p, x, y)
 */
import { PLAYER, TIMING, COURT, CHARACTERS } from './config.js';
import { predictTrajectory } from './physics.js';

/**
 * @param {{id:number, team:number, idx:number, character?:string, controller?:'human'|'ai'}} o
 */
export function createPlayer(o) {
  const ch = CHARACTERS[o.character] || CHARACTERS.timur;
  return {
    id: o.id, team: o.team, idx: o.idx,
    character: o.character || 'timur',
    name: ch.name, color: ch.color, accent: ch.accent,
    stats: { ...ch.stats },
    controller: o.controller || 'ai',
    side: -1,
    x: 0, y: 0, vx: 0, vy: 0, z: 0,
    facing: 1,                 // знак x направления «к сетке»
    input: { mx: 0, my: 0 },
    speedMul: 1,               // множитель скорости (сложность ИИ)
    action: 'idle',            // idle | run | swing | recover | whiff | serve
    actionTimer: 0,
    swing: null,               // см. requestSwing
    lastSwing: null,           // последняя завершённая (для рендера/звука)
    anim: 0,                   // фаза анимации бега
    frozen: false,             // во время подготовки подачи
  };
}

export function placePlayer(p, x, y) {
  p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.z = 0;
}

export function maxSpeed(p) {
  return PLAYER.BASE_SPEED * (0.72 + 0.36 * p.stats.speed) * p.speedMul;
}

/**
 * Движение к точке с торможением «прибытия». Пишет p.input.
 * opts.urgency 0..1 — доля максимальной скорости.
 */
export function steerTo(p, tx, ty, opts = {}) {
  const dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  const urgency = opts.urgency ?? 1;
  if (d < 0.04) { p.input.mx = 0; p.input.my = 0; return d; }
  const vmax = maxSpeed(p);
  // Скорость, с которой ещё успеем затормозить.
  const vArrive = Math.sqrt(2 * PLAYER.DECEL * 0.8 * d);
  const want = Math.min(1, vArrive / vmax) * urgency;
  p.input.mx = dx / d * want;
  p.input.my = dy / d * want;
  return d;
}

/** Горизонтальная позиция игрока через t секунд (грубая экстраполяция). */
function futurePos(p, t) {
  const tt = Math.min(t, 0.18);
  return { x: p.x + p.vx * tt, y: p.y + p.vy * tt };
}

/**
 * @typedef {{t:number, x:number, y:number, z:number, dist:number, lunge:boolean, jump:boolean}} Contact
 * Ищет момент контакта: точку траектории в зоне досягаемости, ближайшую
 * по времени к идеальной задержке WINDUP.
 */
export function findContact(p, shuttle, maxT = TIMING.BUFFER, traj = null) {
  if (shuttle.state !== 'flight') return null;
  const tr = traj || predictTrajectory(shuttle, maxT + 0.02, 1);
  let best = null, bestScore = Infinity;
  const reachH = PLAYER.REACH, reachL = PLAYER.REACH + PLAYER.LUNGE_REACH;
  let prevX = shuttle.x;
  for (const s of tr) {
    const px = prevX; prevX = s.x;
    if (s.t > maxT) break;
    if (s.t < TIMING.MIN_DELAY) continue;
    if (s.net) break;
    if (Math.sign(s.x) !== p.side) continue;
    // Контакт исполняется на тик раньше точки прогноза (игрок обновляется до волана):
    // у самой сетки волан в этот момент ещё над чужой половиной — такой контакт был бы промахом.
    if (Math.sign(px) !== p.side) continue;
    if (s.z < PLAYER.REACH_LOW || s.z > PLAYER.REACH_HIGH + PLAYER.JUMP_REACH) continue;
    const fp = futurePos(p, s.t);
    const dist = Math.hypot(s.x - fp.x, s.y - fp.y);
    // Над головой досягаемость по горизонтали меньше (рука вверх).
    const hFactor = s.z > 2.2 ? 0.8 : 1;
    if (dist > reachL * hFactor) continue;
    const lunge = dist > reachH * hFactor;
    const jump = s.z > PLAYER.REACH_HIGH;
    const score = Math.abs(s.t - TIMING.WINDUP) + (lunge ? 0.08 : 0) + (jump ? 0.03 : 0);
    if (score < bestScore) { bestScore = score; best = { t: s.t, x: s.x, y: s.y, z: s.z, dist, lunge, jump }; }
  }
  return best;
}

/** Корректирует тип удара под высоту/позицию контакта. */
export function resolveShotType(req, c, side) {
  const depth = Math.abs(c.x);       // от сетки
  const z = c.z;
  let t = req;
  // Кнопка «Смэш/Дроп»: высоко — смэш, иначе укороченный (у сетки — сетка).
  if (t === 'smashdrop') t = (z >= PLAYER.SMASH_MIN_Z || (depth < 2.4 && z > 1.5)) ? 'smash' : 'drop';
  if (t === 'smart') {
    if (z >= 2.3 && depth < 5.2) t = 'smash';
    else if (z >= 2.0) t = depth > 4.8 ? 'clear' : 'smash';
    else if (depth < 2.2) t = z > 1.45 ? 'smash' : 'net';
    else if (z >= 1.0) t = 'drive';
    else t = 'lift';
  }
  if (t === 'smash' && z < PLAYER.SMASH_MIN_Z && !(depth < 2.4 && z > 1.5)) t = z > 1.0 ? 'drive' : 'lift';
  if (t === 'clear' && z < 1.4) t = 'lift';
  if (t === 'lift' && z > 2.0) t = 'clear';
  if (t === 'net' && depth > 3.2) t = 'drop';
  if (t === 'drop' && depth < 1.6 && z < 1.5) t = 'net';
  return t;
}

/**
 * Начать замах. Если в окне BUFFER волан пройдёт через зону досягаемости —
 * контакт планируется; иначе — промах (замах в пустоту).
 * @returns {{ok:boolean, delay?:number, quality?:number, timing?:'early'|'perfect'|'late', reason?:string}}
 */
export function requestSwing(p, shuttle, type, aimY, opts = {}) {
  if (p.swing || p.action === 'recover' || p.action === 'whiff') return { ok: false, reason: 'busy' };
  if (shuttle.lastHitTeam === p.team && shuttle.state === 'flight') return { ok: false, reason: 'own' };
  const c = findContact(p, shuttle, opts.buffer ?? TIMING.BUFFER, opts.traj);
  if (!c) {
    p.action = 'whiff';
    p.actionTimer = TIMING.WHIFF_RECOVER;
    p.lastSwing = { type, kind: 'overhead', t: 0, whiff: true };
    return { ok: false, reason: 'whiff' };
  }
  // pressAge (только человек): сколько секунд нажатие ждало в буфере.
  const off = c.t - TIMING.WINDUP + (opts.timingNoise || 0) + (opts.pressAge || 0);
  const err = Math.max(0, Math.abs(off) - TIMING.PERFECT_WINDOW);
  // Человеку раннее нажатие прощается мягче (буфер), позднее — как раньше.
  let quality = opts.human && off > 0 ? Math.max(0.3, 1 - err / 0.4) : Math.max(0.15, 1 - err / 0.22);
  if (c.lunge) quality *= 0.85;
  const timing = err === 0 ? 'perfect' : off > 0 ? 'early' : 'late';
  const kind = c.z > 1.9 ? 'overhead' : c.z < 1.0 ? 'underhand' : 'side';
  p.swing = {
    type, aimY, t: 0, contactAt: c.t, contact: c, quality, timing, kind,
    jump: c.jump || (type === 'smash' && c.z > 2.45), lunge: c.lunge, done: false,
    pressure: opts.pressure ?? 1,
  };
  p.action = 'swing';
  return { ok: true, delay: c.t, quality, timing };
}

/**
 * Шаг игрока. Возвращает 'contact', когда наступил момент удара
 * (game.js должен выполнить удар и затем вызвать finishSwing).
 */
export function updatePlayer(p, dt, ctx) {
  // --- движение ---
  let mx = p.input.mx || 0, my = p.input.my || 0;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; }
  let vmax = maxSpeed(p);
  if (p.action === 'swing') vmax *= p.swing && p.swing.lunge ? 0.9 : 0.45;
  if (p.action === 'recover') vmax *= 0.6;
  if (p.frozen) vmax = 0;
  const tvx = mx * vmax, tvy = my * vmax;
  const dvx = tvx - p.vx, dvy = tvy - p.vy;
  const dv = Math.hypot(dvx, dvy);
  if (dv > 0) {
    // Разгон медленнее торможения/смены направления.
    const braking = (tvx * p.vx + tvy * p.vy) < (p.vx * p.vx + p.vy * p.vy) * 0.5;
    let a = (braking ? PLAYER.DECEL : PLAYER.ACCEL) * dt;
    // Человек отпустил джойстик — останавливаемся чётче, без «скольжения по льду».
    if ((p.controller === 'human' || p.controller === 'remote') && m < 0.05) a *= 1.35;
    const k = Math.min(1, a / dv);
    p.vx += dvx * k; p.vy += dvy * k;
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  // --- ограничения половины корта ---
  const s = p.side;
  const ax = p.x * s;
  const minX = COURT.NET_GAP, maxX = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;
  if (ax < minX) { p.x = s * minX; if (p.vx * s < 0) p.vx = 0; }
  if (ax > maxX) { p.x = s * maxX; if (p.vx * s > 0) p.vx = 0; }
  const maxY = (ctx?.halfWidth ?? COURT.HALF_WIDTH_DOUBLES) + COURT.RUNOFF_SIDE;
  if (Math.abs(p.y) > maxY) { p.y = Math.sign(p.y) * maxY; p.vy = 0; }
  p.facing = -s;
  const sp = Math.hypot(p.vx, p.vy);
  p.anim += sp * dt * 2.2;

  // --- состояния ---
  let ev = null;
  if (p.swing) {
    const w = p.swing;
    w.t += dt;
    if (w.jump) {
      // Взлёт от пола к контакту (не телепорт на высоту при коротком замахе), затем падение.
      if (w.t < w.contactAt) {
        const up = Math.min(w.contactAt, 0.28);
        const k = Math.max(0, 1 - (w.contactAt - w.t) / up);
        p.z = 0.45 * (1 - (1 - k) * (1 - k));
      } else {
        const u = (w.t - w.contactAt) / 0.28;
        p.z = Math.max(0, 0.45 * (1 - u * u));
      }
    }
    if (!w.done && w.t >= w.contactAt - 1e-9) {
      w.done = true;
      ev = 'contact';
    }
    if (w.done && w.t >= w.contactAt + 0.05) {
      p.lastSwing = { ...w };
      p.swing = null;
      p.action = 'recover';
      p.actionTimer = TIMING.SWING_RECOVER * (w.lunge ? 1.4 : 1);
    }
  } else {
    if (p.z > 0) p.z = Math.max(0, p.z - dt * 2.5);
    if (p.actionTimer > 0) {
      p.actionTimer -= dt;
      if (p.actionTimer <= 0) p.action = 'idle';
    } else if (p.action !== 'serve') {
      p.action = sp > 0.4 ? 'run' : 'idle';
    }
  }
  return ev;
}

/** Отменить текущий замах (например, розыгрыш закончился). */
export function cancelSwing(p) {
  p.swing = null;
  p.action = 'idle';
  p.actionTimer = 0;
  p.z = 0;
}
