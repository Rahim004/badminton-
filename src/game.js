/**
 * game.js — оркестратор матча (без DOM: работает и в браузере, и в Node).
 *
 * Связывает правила (rules.js), физику (physics.js), игроков (player.js),
 * удары (shots.js) и ИИ (ai.js). Рендер/звук/UI только подписываются
 * на события через game.on(name, fn) и читают состояние — ничего не меняют.
 *
 * Фазы: 'idle' → 'serve' → 'rally' → 'point' → ('gameBreak') → 'serve' … → 'over'.
 *
 * События (payload):
 *   'serveReady' {serverId}           — подающий готов (человек может подавать)
 *   'serve'      {player, type}
 *   'hit'        {player, type, quality, timing, speed, jump, lunge, target}
 *   'whiff'      {player}
 *   'net'        {x, y, z}              — волан ударился в сетку
 *   'land'       {x, y, in}
 *   'point'      {winner, reason, score, games, result}
 *   'game'       {winner, games, gameScores}
 *   'sides'      {teamSides}
 *   'matchOver'  {winner, games, gameScores}
 *
 * Публичный API (не менять сигнатуры):
 *   createGame(opts) -> Game
 *   game.startMatch(opts)       opts: {mode, difficulty, format, assist, characters, seed, humans}
 *   game.step(dt)               один тик симуляции (dt = PHYSICS.DT)
 *   game.setHumanMove(mx, my)   мировое направление движения человека (|v| ≤ 1)
 *   game.humanShot(type, aimY)  type: 'smart'|'clear'|'smash'|'drop'|'net'|'drive'|'lift'; aimY: -1..1 | null
 *   game.forceAI(bool)          ИИ управляет и человеческим слотом (для тестов/демо)
 *   game.on(name, fn) / game.off(name, fn)
 *   game.snapshot()             плоский объект состояния для тестов
 *   game.human                  игрок-человек (или null)
 */
import { PHYSICS, PLAYER, FLOW, TIMING, MATCH_FORMATS, DIFFICULTY, COURT, CHARACTER_ORDER, DOUBLES_MOD } from './config.js';
import { createShuttle, stepShuttle, predictLanding, predictTrajectory } from './physics.js';
import { createMatch, servingInfo, awardRally, judgeLanding, serviceBox, halfWidth } from './rules.js';
import { createPlayer, updatePlayer, placePlayer, cancelSwing, resolveShotType, requestSwing } from './player.js';
import { planShot } from './shots.js';
import { createBrain, updateBrain, chooseServe, interceptPlan } from './ai.js';

/** Базовая вероятность грубой ошибки человека (растёт при плохом тайминге/давлении). */
const HUMAN_BLUNDER = 0.06;

/** Детерминированный ГПСЧ (mulberry32). */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  mode: 'singles', difficulty: 'amateur', format: 'quick', assist: true,
  humans: 1, characters: null, seed: 0,
};

export function createGame(opts = {}) {
  const listeners = new Map();
  const game = {
    cfg: { ...DEFAULTS },
    match: null,
    players: [],
    brains: [],
    shuttle: createShuttle(),
    phase: 'idle',
    phaseTimer: 0,
    time: 0,
    paused: false,
    rally: { lastType: null, lastTarget: null, lastHitter: -1, shots: [] },
    stats: null,
    serveInfo: null,
    human: null,
    aiControlsHuman: false,
    humanInput: { mx: 0, my: 0, active: false },
    pendingShot: null,
    lastPoint: null,
    rng: Math.random,

    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => game.off(name, fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, payload) { const s = listeners.get(name); if (s) for (const fn of s) { try { fn(payload, game); } catch (e) { console.error(e); } } },

    startMatch(o = {}) { startMatch(game, o); return game; },
    step(dt = PHYSICS.DT) { step(game, dt); },
    setHumanMove(mx, my) { game.humanInput.mx = mx; game.humanInput.my = my; game.humanInput.active = Math.hypot(mx, my) > 0.12; },
    humanShot(type = 'smart', aimY = null) { game.pendingShot = { type, aimY, at: game.time }; },
    forceAI(on = true) {
      game.aiControlsHuman = !!on;
      for (const b of game.brains) if (b.player.controller === 'human') b.role = on ? 'ai' : 'assist';
    },
    snapshot() { return snapshot(game); },
  };
  if (opts && Object.keys(opts).length) startMatch(game, opts);
  return game;
}

function startMatch(game, o) {
  const cfg = game.cfg = { ...DEFAULTS, ...o };
  const fmt = typeof cfg.format === 'string' ? MATCH_FORMATS[cfg.format] : cfg.format;
  cfg.formatObj = fmt || MATCH_FORMATS.quick;
  if (!DIFFICULTY[cfg.difficulty]) cfg.difficulty = 'amateur';
  game.rng = makeRng(cfg.seed || (Date.now() & 0xffffffff));
  game.match = createMatch({ mode: cfg.mode, format: cfg.formatObj, firstServer: cfg.firstServer ?? 0 });
  const perTeam = cfg.mode === 'doubles' ? 2 : 1;
  const chars = cfg.characters || pickCharacters(game, perTeam * 2);
  game.players = [];
  let id = 0;
  for (let team = 0; team < 2; team++) {
    for (let idx = 0; idx < perTeam; idx++) {
      const human = team === 0 && idx === 0 && cfg.humans > 0;
      const p = createPlayer({ id, team, idx, character: chars[id], controller: human ? 'human' : 'ai' });
      game.players.push(p); id++;
    }
  }
  game.human = game.players.find(p => p.controller === 'human') || null;
  game.brains = game.players.map(p => createBrain(p, {
    difficulty: p.controller === 'human' ? 'legend' : p.team === 0 ? partnerDifficulty(cfg.difficulty) : cfg.difficulty,
    role: p.controller === 'human' ? (game.aiControlsHuman ? 'ai' : 'assist') : 'ai',
  }));
  if (cfg.mode === 'doubles') {
    for (const b of game.brains) b.diff = { ...b.diff, blunder: b.diff.blunder * DOUBLES_MOD.blunder, wrongFoot: b.diff.wrongFoot * DOUBLES_MOD.wrongFoot };
  }
  game.stats = { rallies: [], faults: { out: 0, net: 0, serveFault: 0 }, winners: 0, shots: {}, perfect: 0, hits: 0, whiffs: 0, points: [0, 0] };
  game.time = 0;
  game.lastPoint = null;
  game.humanPressure = 1;
  enterServe(game);
}

/** Напарник человека — на ступень сильнее выбранной сложности соперников не бывает слабее «Любителя». */
function partnerDifficulty(d) {
  return d === 'novice' ? 'amateur' : d;
}

function pickCharacters(game, n) {
  const arr = CHARACTER_ORDER.slice();
  // человек — первый в списке, соперники случайно
  const out = [arr.shift()];
  while (out.length < n) out.push(arr.splice(Math.floor(game.rng() * arr.length), 1)[0]);
  return out;
}

function enterServe(game) {
  const m = game.match;
  const s = servingInfo(m);
  game.serveInfo = s;
  game.phase = 'serve';
  game.pendingShot = null;
  game.rally = { lastType: null, lastTarget: null, lastHitter: -1, shots: [] };
  const sh = game.shuttle;
  Object.assign(sh, createShuttle());
  for (const p of game.players) {
    cancelSwing(p);
    p.side = m.teamSides[p.team];
    p.frozen = true;
    p.input.mx = p.input.my = 0;
  }
  for (const b of game.brains) { b.plan = null; b.seenHits = -1; b.reactLeft = 0; }
  const server = teamPlayer(game, s.serverTeam, s.serverIdx);
  const receiver = teamPlayer(game, s.receiverTeam, s.receiverIdx);
  placePlayer(server, s.serverPos.x, s.serverPos.y);
  placePlayer(receiver, s.receiverPos.x, s.receiverPos.y);
  if (m.mode === 'doubles') {
    const sp = teamPlayer(game, s.serverTeam, 1 - s.serverIdx);
    const rp = teamPlayer(game, s.receiverTeam, 1 - s.receiverIdx);
    placePlayer(sp, s.serverSide * 4.3, -s.serverPos.y * 1.6);
    placePlayer(rp, s.receiverSide * 4.4, -s.receiverPos.y * 1.1);
  }
  server.action = 'serve';
  holdShuttle(game, server);
  const humanServes = server.controller === 'human' && !game.aiControlsHuman;
  game.phaseTimer = humanServes ? TIMING.SERVE_CLOCK : lerp(FLOW.AI_SERVE_DELAY[0], FLOW.AI_SERVE_DELAY[1], game.rng());
  game.emit('serveReady', { serverId: server.id, human: humanServes });
}

function holdShuttle(game, p) {
  const sh = game.shuttle;
  sh.state = 'held';
  sh.x = p.x - p.side * 0.35;
  sh.y = p.y + 0.15 * p.side;
  sh.z = PLAYER.SERVE_Z;
  sh.vx = sh.vy = sh.vz = 0;
}

function teamPlayer(game, team, idx) {
  return game.players.find(p => p.team === team && p.idx === idx);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function brainOf(game, p) { return game.brains[p.id]; }

/** Подача: цель внутри диагональной зоны приёма. */
function doServe(game, type, aimY) {
  const s = game.serveInfo;
  const server = teamPlayer(game, s.serverTeam, s.serverIdx);
  const box = serviceBox(game.match, s);
  const sh = game.shuttle;
  const r = s.receiverSide;
  const ySign = Math.sign(box.yMin + box.yMax);
  const hw = halfWidth(game.match);
  if (type !== 'serveShort' && type !== 'serveLong') type = type === 'clear' || type === 'lift' ? 'serveLong' : 'serveShort';
  let ty;
  if (aimY != null) ty = ySign * lerp(0.3, hw - 0.35, Math.min(1, Math.abs(aimY)));
  else ty = type === 'serveShort' ? ySign * 0.45 : ySign * hw * 0.45;
  const depth = type === 'serveShort' ? COURT.SHORT_SERVICE + 0.3 : (game.match.mode === 'doubles' ? COURT.DOUBLES_LONG_SERVICE - 0.3 : COURT.HALF_LENGTH - 0.45);
  const target = { x: r * depth, y: ty };
  const brain = brainOf(game, server);
  const isAI = server.controller !== 'human' || game.aiControlsHuman;
  const aimError = isAI ? brain.diff.aimError * 0.5 : 0.12;
  const plan = planShot({
    type, from: { x: sh.x, y: sh.y, z: sh.z }, side: server.side, target, mode: game.match.mode,
    quality: 0.9, stats: server.stats, aimError, rng: game.rng,
    netClear: type === 'serveShort' ? 0.12 + (isAI ? brain.diff.netClearBonus * 0.5 : 0.05) : undefined,
  });
  if (!plan) return;
  let { vx, vy, vz } = plan.launch;
  if (isAI && game.rng() < brain.diff.blunder * 0.5) {
    const f = game.rng() < 0.5 ? 0.85 : 1.1; vx *= f; vy *= f; vz *= f;
  }
  launch(game, server, vx, vy, vz, plan.type, plan.target);
  sh.isServe = true;
  for (const p of game.players) p.frozen = false;
  server.action = 'recover'; server.actionTimer = 0.25;
  server.lastSwing = { type: plan.type, kind: 'underhand', t: 0, quality: 0.9, timing: 'perfect' };
  game.phase = 'rally';
  game.emit('serve', { player: server, type: plan.type });
  game.emit('hit', { player: server, type: plan.type, quality: 0.9, timing: 'perfect', speed: plan.launch.speed, target: plan.target, serve: true });
}

function launch(game, p, vx, vy, vz, type, target) {
  const sh = game.shuttle;
  sh.vx = vx; sh.vy = vy; sh.vz = vz;
  sh.state = 'flight';
  sh.netHit = false;
  sh.lastHitTeam = p.team;
  sh.lastHitter = p.id;
  sh.hits++;
  sh.isServe = false;
  game.rally.lastType = type;
  game.rally.lastTarget = target;
  game.rally.lastHitter = p.id;
  game.rally.shots.push(type);
  game.stats.shots[type] = (game.stats.shots[type] || 0) + 1;
}

/** Умное направление для человека, если не задано: подальше от соперника. */
function smartAim(game, p) {
  const opp = game.players.filter(q => q.team !== p.team);
  const hw = halfWidth(game.match);
  const oy = opp.reduce((a, q) => a + q.y, 0) / opp.length;
  return Math.abs(oy) < 0.3 ? (game.rng() < 0.5 ? -0.7 : 0.7) : -Math.sign(oy) * Math.min(1, 0.55 + Math.abs(oy) / hw * 0.4);
}

function doHit(game, p) {
  const sh = game.shuttle;
  const w = p.swing;
  const side = p.side;
  const dist = Math.hypot(sh.x - p.x, sh.y - p.y);
  const okState = sh.state === 'flight' && sh.lastHitTeam !== p.team && Math.sign(sh.x) === side;
  const okReach = dist <= (PLAYER.REACH + PLAYER.LUNGE_REACH) * 1.15 + 0.15 && sh.z >= PLAYER.REACH_LOW * 0.5 && sh.z <= PLAYER.REACH_HIGH + PLAYER.JUMP_REACH + 0.15;
  if (!okState || !okReach) {
    w.whiff = true;
    game.stats.whiffs++;
    game.emit('whiff', { player: p });
    return;
  }
  const isAI = p.controller !== 'human' || game.aiControlsHuman;
  const brain = brainOf(game, p);
  const c = { x: sh.x, y: sh.y, z: sh.z };
  const type = resolveShotType(w.type, c, side);
  const aimY = w.aimY ?? smartAim(game, p);
  const diff = brain.diff;
  // Давление: быстрый входящий волан, удар на бегу, низкий контакт — хуже качество.
  const vin = Math.hypot(sh.vx, sh.vy, sh.vz);
  const pv = Math.hypot(p.vx, p.vy);
  let q = w.quality * (w.pressure ?? 1);
  q *= 1 - clamp((vin - 9) / 40, 0, 0.45);
  q *= 1 - clamp((pv - 2.2) / 8, 0, 0.25);
  if (c.z < 0.45) q *= 0.85;
  w.pressureQuality = q;
  const plan = planShot({
    type, from: c, side, aimY, mode: game.match.mode,
    quality: q, stats: p.stats,
    aimError: isAI ? diff.aimError : 0.2,
    netClear: isAI ? netClearFor(type, diff) : undefined,
    rng: game.rng,
  });
  if (!plan) { w.whiff = true; game.stats.whiffs++; game.emit('whiff', { player: p }); return; }
  let { vx, vy, vz } = plan.launch;
  // Грубая ошибка: недобор (в сетку) или перебор (в аут). Чаще при плохом тайминге.
  const blunderP = (isAI ? diff.blunder : HUMAN_BLUNDER) * (0.4 + 2.5 * (1 - q));
  if (game.rng() < blunderP) {
    const short = plan.type === 'net' || plan.type === 'drop' || game.rng() < 0.5;
    const f = short ? 0.72 + game.rng() * 0.12 : 1.08 + game.rng() * 0.08;
    vx *= f; vy *= f; vz *= f;
    if (!short) vy += (game.rng() - 0.5) * 3;
  }
  launch(game, p, vx, vy, vz, plan.type, plan.target);
  updateHumanPressure(game);
  game.stats.hits++;
  if (w.timing === 'perfect') game.stats.perfect++;
  w.resolvedType = plan.type;
  game.emit('hit', { player: p, type: plan.type, quality: q, timing: w.timing, speed: plan.launch.speed, jump: w.jump, lunge: w.lunge, target: plan.target });
}

/**
 * Давление на человека считается так же, как у ИИ: запас времени до лучшей
 * точки перехвата при типичной реакции человека (0.2 с).
 */
function updateHumanPressure(game) {
  const h = game.human;
  if (!h || game.shuttle.lastHitTeam === h.team) return;
  const traj = predictTrajectory(game.shuttle, 4, 1);
  const pl = interceptPlan(h, traj, 0.2, game);
  game.humanPressure = Math.max(0.4, Math.min(1, 0.45 + (pl ? pl.maxSlack : 0) * 2.2));
}

function netClearFor(type, diff) {
  const base = { drop: 0.18, net: 0.07, drive: 0.22, smash: 0.18, serveShort: 0.12 }[type];
  return base == null ? undefined : base + diff.netClearBonus;
}

function endRally(game, landing) {
  const sh = game.shuttle;
  const m = game.match;
  const j = judgeLanding(m, landing, sh.lastHitTeam, sh.isServe || sh.hits === 1, sh.netHit, game.serveInfo);
  game.emit('land', { x: landing.x, y: landing.y, in: j.reason === 'in' });
  const len = sh.hits;
  game.stats.rallies.push(len);
  if (j.reason === 'in') game.stats.winners++; else game.stats.faults[j.reason]++;
  game.stats.points[j.winner]++;
  const result = awardRally(m, j.winner);
  game.lastPoint = { winner: j.winner, reason: j.reason, rallyLength: len, x: landing.x, y: landing.y };
  for (const p of game.players) { if (p.swing) cancelSwing(p); }
  game.emit('point', { winner: j.winner, reason: j.reason, score: m.score.slice(), games: m.games.slice(), result, rallyLength: len });
  if (result.gameWon) game.emit('game', { winner: result.gameWinner, games: m.games.slice(), gameScores: m.gameScores.slice() });
  if (result.switchSides) game.emit('sides', { teamSides: m.teamSides.slice() });
  game.phase = 'point';
  game.phaseTimer = FLOW.POINT_PAUSE + (result.gameWon && !result.matchWon ? FLOW.GAME_PAUSE : 0);
  game.pendingResult = result;
}

function step(game, dt) {
  if (game.paused || game.phase === 'idle' || game.phase === 'over') return;
  game.time += dt;
  const sh = game.shuttle;
  const ctx = { mode: game.cfg.mode, halfWidth: halfWidth(game.match) };

  if (game.phase === 'serve') {
    const s = game.serveInfo;
    const server = teamPlayer(game, s.serverTeam, s.serverIdx);
    const humanServes = server.controller === 'human' && !game.aiControlsHuman;
    game.phaseTimer -= dt;
    if (humanServes) {
      if (game.pendingShot) {
        const t = game.pendingShot.type;
        const type = t === 'clear' || t === 'lift' || t === 'smash' ? 'serveLong'
          : t === 'net' || t === 'drop' ? 'serveShort'
          : (game.cfg.mode === 'doubles' ? 'serveShort' : 'serveLong');
        doServe(game, type, game.pendingShot.aimY);
        game.pendingShot = null;
      } else if (game.phaseTimer <= 0) {
        doServe(game, game.cfg.mode === 'doubles' ? 'serveShort' : 'serveLong', null);
      }
    } else if (game.phaseTimer <= 0) {
      doServe(game, chooseServe(brainOf(game, server), game), null);
    }
    for (const p of game.players) updatePlayer(p, dt, ctx);
    if (sh.state === 'held') holdShuttle(game, server);
    return;
  }

  if (game.phase === 'point') {
    game.phaseTimer -= dt;
    for (const p of game.players) { p.input.mx *= 0.9; p.input.my *= 0.9; updatePlayer(p, dt, ctx); }
    stepShuttle(sh, dt);
    if (game.phaseTimer <= 0) {
      if (game.match.over) {
        game.phase = 'over';
        game.emit('matchOver', { winner: game.match.winner, games: game.match.games.slice(), gameScores: game.match.gameScores.slice() });
      } else enterServe(game);
    }
    return;
  }

  // --- rally ---
  for (const b of game.brains) {
    const p = b.player;
    if (p.controller === 'human' && !game.aiControlsHuman) {
      const hi = game.humanInput;
      if (hi.active || !game.cfg.assist) { p.input.mx = hi.mx; p.input.my = hi.my; }
      else updateBrain(b, game, dt); // автопередвижение
      if (game.pendingShot) {
        if (game.time - game.pendingShot.at > 0.12) game.pendingShot = null;
        else if (!p.swing && p.action !== 'recover' && p.action !== 'whiff') {
          const ps = game.pendingShot;
          game.pendingShot = null;
          requestSwing(p, sh, ps.type, ps.aimY, { pressure: game.humanPressure ?? 1 });
        }
      }
    } else {
      updateBrain(b, game, dt);
    }
  }
  for (const p of game.players) {
    const ev = updatePlayer(p, dt, ctx);
    if (ev === 'contact') doHit(game, p);
  }
  const ev = stepShuttle(sh, dt);
  if (ev === 'net') game.emit('net', { x: sh.x, y: sh.y, z: sh.z });
  if (sh.state === 'ground') endRally(game, { x: sh.x, y: sh.y });
}


function snapshot(game) {
  const m = game.match, sh = game.shuttle;
  return {
    phase: game.phase,
    time: +game.time.toFixed(3),
    mode: game.cfg.mode,
    difficulty: game.cfg.difficulty,
    score: m ? m.score.slice() : [0, 0],
    games: m ? m.games.slice() : [0, 0],
    gameScores: m ? m.gameScores.map(g => g.slice()) : [],
    serverTeam: m ? m.serverTeam : 0,
    teamSides: m ? m.teamSides.slice() : [-1, 1],
    over: m ? m.over : false,
    winner: m ? m.winner : null,
    rally: { hits: sh.hits, lastType: game.rally.lastType, shots: game.rally.shots.slice() },
    shuttle: { x: sh.x, y: sh.y, z: sh.z, vx: sh.vx, vy: sh.vy, vz: sh.vz, state: sh.state, lastHitTeam: sh.lastHitTeam },
    players: game.players.map(p => ({ id: p.id, team: p.team, idx: p.idx, name: p.name, controller: p.controller, x: p.x, y: p.y, z: p.z, action: p.action, side: p.side })),
    lastPoint: game.lastPoint,
    stats: game.stats ? JSON.parse(JSON.stringify(game.stats)) : null,
  };
}

export { predictLanding };
