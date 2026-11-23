/**
 * ai.js — ИИ игроков.
 *
 * Мозг (brain) привязан к одному игроку. Каждый тик updateBrain():
 *  1) после удара соперника ждёт время реакции (по сложности);
 *  2) интегрирует траекторию (predictTrajectory) и выбирает точку перехвата:
 *     достижимую по времени и как можно выше (для атаки);
 *  3) решает «аут — пропустить» с ошибкой оценки judge;
 *  4) бежит к точке и запускает замах за WINDUP до контакта (с шумом тайминга);
 *  5) выбирает удар (смэш/клир/дроп/драйв/сетка/подъём) и цель подальше от соперника;
 *  6) без волана возвращается в базовую точку (одиночка) или в формацию (пара:
 *     атака — спереди-сзади, защита — бок о бок).
 *
 * role 'ai'     — полный контроль (движение + удары);
 * role 'assist' — только автопередвижение для человека (удары жмёт человек).
 *
 * Публичный API (не менять сигнатуры):
 *   createBrain(player, {difficulty, role}) -> Brain
 *   updateBrain(brain, game, dt) -> void
 *   chooseServe(brain, game) -> 'serveShort' | 'serveLong'
 *   formationFor(game, team) -> 'front-back' | 'side-by-side'
 *   interceptPlan(player, traj, reactionLeft, game) -> Plan | null
 */
import { DIFFICULTY, PLAYER, TIMING, COURT } from './config.js';
import { predictTrajectory } from './physics.js';
import { steerTo, requestSwing, maxSpeed, resolveShotType } from './player.js';
import { chooseTarget } from './shots.js';
import { halfWidth, isInCourt } from './rules.js';

export function createBrain(player, o = {}) {
  const diffKey = o.difficulty || 'amateur';
  return {
    player,
    role: o.role || 'ai',
    diffKey,
    diff: DIFFICULTY[diffKey] || DIFFICULTY.amateur,
    seenHits: -1,        // shuttle.hits, на который уже отреагировали
    reactLeft: 0,
    plan: null,          // {t (abs), x, y, z, type, aimY, leave, standX, standY, swung}
    rePlanAt: 0,
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Формация пары: если наша команда только что атаковала вниз — спереди-сзади. */
export function formationFor(game, team) {
  const sh = game.shuttle;
  const t = game.rally.lastType;
  if (sh.lastHitTeam === team) return ['smash', 'drop', 'net', 'serveShort'].includes(t) ? 'front-back' : 'side-by-side';
  // Соперник поднял — мы атакуем; соперник атакует — защищаемся бок о бок.
  return ['smash', 'drive'].includes(t) ? 'side-by-side' : 'front-back';
}

/** Базовая точка игрока, пока волан не летит к нему. */
function basePoint(brain, game) {
  const p = brain.player, s = p.side;
  const sh = game.shuttle;
  if (game.cfg.mode !== 'doubles') {
    // Одиночка: центр, чуть смещаясь к стороне, куда улетел наш удар (биссектриса углов).
    let y = 0, x = s * 3.35;
    if (sh.lastHitTeam === p.team && game.rally.lastTarget) {
      y = game.rally.lastTarget.y * 0.22;
      const d = Math.abs(game.rally.lastTarget.x);
      if (d < 2.5) x = s * 2.9;      // после укоротка — ближе
      if (d > 5.5) x = s * 3.6;
    }
    return { x, y };
  }
  const mate = game.players.find(q => q.team === p.team && q !== p);
  const f = formationFor(game, p.team);
  if (f === 'front-back') {
    const iAmFront = !mate || Math.abs(p.x) < Math.abs(mate.x) || (Math.abs(p.x) === Math.abs(mate.x) && p.idx === 0);
    const ty = game.rally.lastTarget ? game.rally.lastTarget.y * 0.3 : 0;
    return iAmFront ? { x: s * 1.9, y: ty } : { x: s * 4.3, y: ty * 0.5 };
  }
  const left = !mate || p.y < mate.y || (p.y === mate.y && p.idx === 0);
  return { x: s * 3.4, y: left ? -1.35 : 1.35 };
}

/**
 * План перехвата: лучшая точка траектории, к которой игрок успевает.
 * @returns {{t:number,x:number,y:number,z:number,slack:number}|null}  t — время от «сейчас»
 */
export function interceptPlan(p, traj, reactionLeft, game) {
  const vmax = maxSpeed(p);
  let best = null, bestScore = -Infinity, fallback = null, fbSlack = -Infinity, maxSlack = -Infinity;
  for (let i = 0; i < traj.length; i += 2) {
    const s = traj[i];
    if (s.net) break;
    if (Math.sign(s.x) !== p.side || Math.abs(s.x) < COURT.NET_GAP + 0.05) continue;
    if (s.z < 0.18 || s.z > PLAYER.REACH_HIGH + PLAYER.JUMP_REACH * 0.8) continue;
    const reach = (s.z > 2.2 ? 0.8 : 1) * PLAYER.REACH * 0.55;
    const d = Math.max(0, Math.hypot(s.x - p.x, s.y - p.y) - reach);
    const need = reactionLeft + (d > 0.05 ? 0.12 + d / (vmax * 0.92) : 0) + TIMING.WINDUP * 0.5;
    const slack = s.t - need;
    if (slack > maxSlack) maxSlack = slack;
    if (slack < 0) {
      if (slack > fbSlack) { fbSlack = slack; fallback = { t: s.t, x: s.x, y: s.y, z: s.z, slack }; }
      continue;
    }
    // Выше — лучше (атака), но не слишком поздно; низкие точки опасны.
    const zc = Math.min(s.z, 2.7);
    let score = zc * 1.0 - s.t * 0.35;
    if (s.z < 0.5) score -= 0.6;
    if (s.z > PLAYER.REACH_HIGH) score -= 0.25; // прыжок — чуть хуже
    if (slack > 0.15) score += 0.1;
    if (score > bestScore) { bestScore = score; best = { t: s.t, x: s.x, y: s.y, z: s.z, slack }; }
  }
  const r = best || fallback;
  if (r) r.maxSlack = maxSlack;
  return r;
}

function opponents(game, team) { return game.players.filter(q => q.team !== team); }

/** Выбор удара ИИ по ситуации. */
function chooseShot(brain, game, c) {
  const p = brain.player, d = brain.diff, rng = game.rng;
  const depth = Math.abs(c.x), z = c.z;
  const incoming = game.rally.lastType;
  let type;
  const r = rng();
  if (z >= 2.1) {
    if (depth < 4.8) type = r < d.smashRate + 0.15 ? 'smash' : r < d.smashRate + 0.15 + d.dropRate ? 'drop' : 'clear';
    else type = r < d.smashRate * 0.45 ? 'smash' : r < d.smashRate * 0.45 + d.dropRate ? 'drop' : 'clear';
  } else if (depth < 2.3) {
    if (z > 1.65) type = 'smash';
    else if (z > 1.1) type = r < 0.5 ? 'drive' : 'net';
    else type = r < 0.55 ? 'net' : 'lift';
  } else if (z >= 0.95) {
    if (incoming === 'smash') type = r < 0.5 ? 'drop' : 'lift';
    else type = r < 0.42 ? 'drive' : r < 0.68 ? 'drop' : 'clear';
  } else {
    type = r < 0.72 ? 'lift' : 'drop';
  }
  // Учитываем позицию соперника: глубоко — укорачиваем, у сетки — перекидываем.
  const opp = opponents(game, p.team);
  const oppDepth = Math.min(...opp.map(o => Math.abs(o.x)));
  const r2 = rng();
  if (oppDepth > 4.3 && (type === 'clear' || type === 'lift' || type === 'drive') && r2 < 0.35 + d.anticipation * 0.3) type = depth < 2.4 ? 'net' : 'drop';
  else if (oppDepth < 2.6 && (type === 'drop' || type === 'net') && r2 < 0.4 + d.anticipation * 0.3) type = z > 2 ? 'clear' : 'lift';
  type = resolveShotType(type, c, p.side);
  // Цель — подальше от соперников.
  const hw = halfWidth(game.match);
  let aimY;
  if (game.cfg.mode === 'doubles') {
    // В пару: в «шов» между соперниками или в сторону более далёкого.
    const ys = opp.map(o => o.y).sort((a, b) => a - b);
    aimY = rng() < 0.35 ? ((ys[0] + ys[1]) / 2) / hw : (rng() < 0.5 ? -1 : 1) * (0.55 + rng() * 0.4);
  } else {
    const oy = opp[0] ? opp[0].y : 0;
    const away = oy > 0.25 ? -1 : oy < -0.25 ? 1 : (rng() < 0.5 ? -1 : 1);
    aimY = rng() < 0.2 ? (rng() - 0.5) * 0.6 : away * (0.45 + rng() * 0.55);
  }
  return { type, aimY };
}

/** Какие удары чаще обманывают: атакующие и укороченные. */
function wrongFootBias(type) {
  return { smash: 1, drop: 1.2, net: 0.9, drive: 0.8, clear: 0.5, lift: 0.4, serveShort: 0.3, serveLong: 0.3 }[type] ?? 0.5;
}

export function chooseServe(brain, game) {
  const r = game.rng();
  if (game.cfg.mode === 'doubles') return r < 0.8 ? 'serveShort' : 'serveLong';
  return r < 0.65 ? 'serveLong' : 'serveShort';
}

/** Должен ли этот игрок брать волан (для пар — делёж зон). */
function isMine(brain, game, plan, traj) {
  const p = brain.player;
  if (game.cfg.mode !== 'doubles') return true;
  const mate = game.players.find(q => q.team === p.team && q !== p);
  if (!mate) return true;
  const matePlan = interceptPlan(mate, traj, mate.controller === 'human' && !game.aiControlsHuman ? 0.15 : brain.reactLeft, game);
  if (!plan) return false;
  if (!matePlan) return true;
  // Зональный делёж + запас времени.
  const f = formationFor(game, p.team);
  let zoneMine;
  if (f === 'front-back') zoneMine = (Math.abs(plan.x) < 3.0) === (Math.abs(p.x) <= Math.abs(mate.x));
  else zoneMine = (plan.y < 0) === (p.y <= mate.y);
  const humanMate = mate.controller === 'human' && !game.aiControlsHuman;
  if (humanMate) {
    // Не мешаем человеку: берём только свою зону или если человек явно не успевает.
    return zoneMine ? matePlan.slack < plan.slack + 0.6 || plan.slack > 0 : (matePlan.slack < -0.15 && plan.slack > 0.05);
  }
  if (zoneMine) return plan.slack >= 0 || matePlan.slack < plan.slack;
  return matePlan.slack < 0 && plan.slack > matePlan.slack + 0.05;
}

/** Главный тик мозга. */
export function updateBrain(brain, game, dt) {
  const p = brain.player;
  const sh = game.shuttle;
  const d = brain.diff;
  p.speedMul = brain.role === 'ai' && p.controller !== 'human' ? d.speed : 1;
  if (game.phase !== 'rally') { p.input.mx = p.input.my = 0; brain.plan = null; return; }

  const incoming = sh.state === 'flight' && sh.lastHitTeam !== p.team;
  // Новый удар соперника → запуск реакции.
  if (incoming && sh.hits !== brain.seenHits) {
    brain.seenHits = sh.hits;
    brain.plan = null;
    const base = brain.role === 'assist' ? 0.05 : d.reaction;
    brain.reactLeft = Math.max(0.03, base * (0.8 + game.rng() * 0.4));
    brain.wrongFoot = null;
    // Обман: соперник «показал» другой удар — теряем время и шагаем не туда.
    if (brain.role === 'ai' && game.rng() < d.wrongFoot * wrongFootBias(game.rally.lastType)) {
      brain.reactLeft += 0.12 + game.rng() * 0.18;
      const s = p.side;
      const deep = ['drop', 'net'].includes(game.rally.lastType);
      brain.wrongFoot = { x: s * (deep ? 4.6 : 2.0), y: -Math.sign(game.rally.lastTarget?.y || 1) * 1.2 };
    }
  }
  if (!incoming) {
    brain.plan = null;
    const b = basePoint(brain, game);
    steerTo(p, b.x, b.y, { urgency: 0.75 + 0.25 * d.anticipation });
    return;
  }
  if (brain.reactLeft > 0) {
    brain.reactLeft -= dt;
    // Пока реагируем — по инерции к базе (или не туда, если купились на обман).
    const b = brain.wrongFoot || basePoint(brain, game);
    steerTo(p, b.x, b.y, { urgency: brain.wrongFoot ? 0.8 : 0.5 });
    return;
  }
  if (!brain.plan) {
    const traj = predictTrajectory(sh, 4, 1);
    const plan = interceptPlan(p, traj, 0, game);
    const landing = traj[traj.length - 1];
    // Решение «аут?» с ошибкой оценки.
    const jx = gauss(game.rng) * d.judge * 0.5, jy = gauss(game.rng) * d.judge * 0.5;
    const judged = { x: landing.x + jx, y: landing.y + jy };
    const willBeOut = !landing.net && !isInCourt(game.match, judged, p.side) && Math.sign(landing.x) === p.side;
    const mine = isMine(brain, game, plan, traj);
    if (!plan || !mine || landing.net) {
      brain.plan = { leave: true };
    } else if (willBeOut && brain.role === 'ai') {
      brain.plan = { leave: true, out: true };
    } else {
      const shot = chooseShot(brain, game, plan);
      // Встаём так, чтобы волан был сбоку-спереди (сторона ракетки).
      const s = p.side;
      const back = plan.z > 1.9 ? 0.25 : 0.05;
      brain.plan = {
        leave: false, t: game.time + plan.t, x: plan.x, y: plan.y, z: plan.z,
        // Ошибка восприятия: встаём чуть не туда (сильнее у слабых).
        standX: plan.x + s * back + gauss(game.rng) * d.posError,
        standY: plan.y + 0.21 * (plan.y > p.y ? -1 : 1) + gauss(game.rng) * d.posError,
        type: shot.type, aimY: shot.aimY, swung: false,
        timingNoise: gauss(game.rng) * d.timing,
        // Насколько «впритык» успеваем: меньше запас — хуже качество удара.
        pressure: Math.max(0.4, Math.min(1, 0.45 + (plan.maxSlack ?? 0.3) * 2.2)),
      };
    }
  }
  const pl = brain.plan;
  if (pl.leave) {
    // Уходим с траектории / держим позицию.
    const b = basePoint(brain, game);
    steerTo(p, b.x, b.y, { urgency: 0.6 });
    return;
  }
  const tLeft = pl.t - game.time;
  steerTo(p, pl.standX, pl.standY, { urgency: 1 });
  if (brain.role === 'ai' && !pl.swung && !p.swing && tLeft <= TIMING.WINDUP + pl.timingNoise + 0.004) {
    pl.swung = true;
    const miss = game.rng() < (d.whiff || 0) * (1.6 - pl.pressure);
    const res = requestSwing(p, sh, pl.type, pl.aimY, { timingNoise: pl.timingNoise, pressure: pl.pressure, buffer: miss ? 0 : undefined });
    if (!res.ok && res.reason === 'whiff') {
      brain.plan = { leave: true };
      game.stats.whiffs++;
      game.emit('whiff', { player: p });
    }
  }
  if (tLeft < -0.4) brain.plan = { leave: true };
}
