/**
 * net/guest.js — гость: показывает матч хоста без своей авторитетной симуляции.
 *
 * Объект game у гостя — «зеркало» (создан game.startMatch с теми же настройками);
 * game.step() не вызывается — каждый кадр frame(dt) переписывает состояние, которое
 * читают render/audio/ui, и испускает пересланные события теми же game.emit(...).
 *
 *  • Чужие игроки — интерполяция снимков во времени V = E − delay (delay адаптивный).
 *  • Свой игрок — предсказание во времени R = E + lead теми же player.js/ai.js (автобег),
 *    что у хоста; ввод с меткой тика уходит хосту и применяется там к тому же тику.
 *    Расхождение со снимком хоста гасится мягко (смещение отображения затухает).
 *  • Волан — по отрезкам полёта (shuttleline.js): «часы волана» τ идут к R, когда волан
 *    летит к нам (видим его там, где он будет, когда наш удар дойдёт до хоста), и к V,
 *    когда летит к сопернику (синхронно с его показом). Свой удар/подача предсказываются
 *    сразу (звук, полёт), авторитетный отрезок хоста их затем уточняет.
 *  • Звуки/эффекты — события хоста по порядку: «волановые» по τ, остальные по V.
 */
import { PHYSICS, TIMING, PLAYER, COURT } from '../config.js';
import { updatePlayer, requestSwing, findContact, resolveShotType } from '../player.js';
import { planShot } from '../shots.js';
import { servingInfo, judgeLanding, halfWidth, serviceBox } from '../rules.js';
import { createBrain, updateBrain } from '../ai.js';
import { createClock, createSnapBuffer, lerpPlayer, targetDelay, slew, advanceShuttleClock, clamp } from './timing.js';
import { createTimeline, makeSeg, sampleSeg, segEventTime, timeToSide } from './shuttleline.js';
import { applyMatch, q100, SHOT_TYPES } from './codec.js';

const DT = PHYSICS.DT;
const HUMAN_HOLD = 0.36;            // как в game.js
const REACH_HORIZON = 0.75;
const SERVE_WINDUP = 0.16;
const ASSIST_LEVELS = { off: [0, 0], light: [0.75, 0.22], strong: [1, 0.45] };
const HIST = 512;

/** ГПСЧ «без ошибки»: gauss() из shots.js даёт 0 (u=0.5, v=0.25). */
function zeroRng() { let k = 0; return () => (k++ % 2 === 0 ? 0.5 : 0.25); }

/**
 * @param game  зеркальная игра (startMatch уже вызван)
 * @param o     {myId, send(msg), route:'p2p'|'server'|'bc', onPause(bool)}
 */
export function createGuestView(game, o) {
  const myId = o.myId;
  const me = game.players[myId];
  const G = {
    clock: createClock(), buf: createSnapBuffer(), tl: createTimeline(),
    delay: 0.1, lead: 0.18, R: null, V: 0, tau: null, lastTick: -1,
    hist: new Array(HIST), off: { x: 0, y: 0 },
    sim: null, brain: null,
    evQ: new Map(), evDone: 0, evMax: 0, emitted: new Set(), predicted: new Map(),
    shotSeq: 0, shotsOut: [], samples: [], lastSample: null, sent: { ps: null, type: null, aimY: null, sw: null },
    sendAcc: 0, q: 0, mid: o.mid | 0, lastSnapAt: 0, paused: false,
    shOff: { x: 0, y: 0, z: 0 }, shLast: null, shSegRef: null,
    stats: { snaps: 0, bad: 0, reconcile: 0, snapsTo: 0, maxErr: 0, predHits: 0, mispred: 0, lateMs: 0 },
    dmin: 0.08, dmax: 0.45, mv: 0, over: false, started: false,
  };
  G.route = o.route || 'server';
  G.setRoute = r => { G.route = r; G.dmin = r === 'p2p' ? 0.05 : r === 'bc' ? 0.05 : 0.08; };
  G.setRoute(G.route);

  // Своя «модель» игрока: копия, которую двигает предсказание (game.players[myId] — только отображение).
  G.sim = { ...me, input: { mx: 0, my: 0 }, stats: { ...me.stats } };
  G.sim.swing = null; G.sim.lastSwing = null;
  G.brain = createBrain(G.sim, { difficulty: 'legend', role: 'assist' });
  game.human = me;
  game.paused = false;

  const localSec = o.now || (() => (globalThis.performance ? performance.now() : Date.now()) / 1000);

  /* ---------------------------------------------------------------- приём снимка */
  G.onSnap = function (s) {
    if (s.mid && G.mid && s.mid !== G.mid) return;           // снимок прошлого матча
    if (!G.buf.push(s)) return;
    const now = localSec();
    G.lastSnapAt = now;
    G.stats.snaps++;
    if (G.clock.off != null && s.T - now - G.clock.off < -0.7) G.clock.reset();   // хост стоял (пауза/обрыв) — пересинхронизация
    G.clock.sample(s.T, now);
    for (const e of s.ev) if (e.seq > G.evDone && !G.evQ.has(e.seq)) { G.evQ.set(e.seq, e); G.evMax = Math.max(G.evMax, e.seq); }
    // Отрезок волана.
    const seg = makeSeg(s.seg.id, s.seg.t0, s.seg.st);
    const res = G.tl.put(seg);
    if (res !== 'same') {
      const pr = G.predicted.get(seg.id);
      if (pr) { G.predicted.delete(seg.id); }
    }
    // Предсказанный удар не подтвердился: хост ушёл дальше, а отрезка с этим id нет.
    for (const [id, p] of G.predicted) {
      if (s.T > p.t0 + 0.08 && s.seg.id < id && Math.floor(s.seg.id / 64) === Math.floor(id / 64)) { G.tl.drop(id); G.predicted.delete(id); G.stats.mispred++; }
      else if (Math.floor(s.seg.id / 64) > Math.floor(id / 64)) { G.tl.drop(id); G.predicted.delete(id); }
    }
    // Лид ввода по отзыву хоста.
    if (s.ak && s.ak.mid === G.mid) {
      // Опоздание ввода измерено при действовавшем лиде (R − E): целевой лид = он + опоздание + запас.
      G.stats.lateMs = s.ak.late;
      if (G.appliedLead != null && s.phase !== 'over' && !s.paused && now - (G.leadAt || 0) > 0.35) {
        G.leadAt = now;
        const want = clamp(G.appliedLead + s.ak.late / 1000 + 0.016, 0.02, 0.9);
        G.lead += (want - G.lead) * 0.5;
      }
    }
    if (s.paused !== G.paused) { G.paused = s.paused; game.paused = s.paused; if (!s.paused) G.clock.reset(); try { o.onPause && o.onPause(s.paused); } catch (_) {} }
    if (s.m) {   // самое свежее состояние матча — для своего предсказания (подача, стороны)
      if (!G.mLat) G.mLat = JSON.parse(JSON.stringify(game.match));
      applyMatch(G.mLat, s.m); G.srvLat = servingInfo(G.mLat);
    }
    reconcile(s);
    if (!G.started) init(s);
  };

  G.setRtt = function (rttSec) {
    if (!G.started && rttSec > 0) G.lead = clamp(rttSec + 0.03, 0.03, 0.9);
  };

  function init(s) {
    G.started = true;
    const r = s.players[myId];
    Object.assign(G.sim, { x: r.x, y: r.y, z: 0, vx: r.vx, vy: r.vy });
    G.R = s.T + G.lead; G.V = s.T - G.delay; G.tau = s.T;
    G.lastTick = Math.round(s.T / DT);
    if (s.m) { applyMatch(game.match, s.m); game.serveInfo = servingInfo(game.match); G.mv = s.mv; }
  }

  /* ---------------------------------------------------------------- сверка своего игрока */
  function reconcile(s) {
    if (!G.started) return;
    const auth = s.players[myId];
    const k = Math.round(s.T / DT);
    const h = G.hist[k % HIST];
    const sim = G.sim;
    if (!h || h.tick !== k || k > G.lastTick) {
      if (k > G.lastTick) { Object.assign(sim, { x: auth.x, y: auth.y, vx: auth.vx, vy: auth.vy }); G.lastTick = k; }
      return;
    }
    const ex = auth.x - h.x, ey = auth.y - h.y, e = Math.hypot(ex, ey);
    G.stats.maxErr = Math.max(G.stats.maxErr * 0.995, e);
    if (e < 0.004 && Math.hypot(auth.vx - h.vx, auth.vy - h.vy) < 0.02) return;
    G.stats.reconcile++;
    if (e > 1.0) {      // телепорт (подача) или долгий обрыв — сразу
      G.stats.snapsTo++;
      sim.x = auth.x; sim.y = auth.y; sim.vx = auth.vx; sim.vy = auth.vy;
      G.off.x = G.off.y = 0;
      for (let t = k + 1; t <= G.lastTick; t++) { const q = G.hist[t % HIST]; if (q && q.tick === t) { q.x = auth.x; q.y = auth.y; } }
      h.x = auth.x; h.y = auth.y; h.vx = auth.vx; h.vy = auth.vy;
      return;
    }
    const evx = auth.vx - h.vx, evy = auth.vy - h.vy;
    sim.x += ex; sim.y += ey; sim.vx += evx; sim.vy += evy;
    G.off.x -= ex; G.off.y -= ey;                     // на экране — без скачка, догонит плавно
    for (let t = k; t <= G.lastTick; t++) { const q = G.hist[t % HIST]; if (q && q.tick === t) { q.x += ex; q.y += ey; q.vx += evx; q.vy += evy; } }
  }

  /* ---------------------------------------------------------------- состояние волана во времени t */
  function shuttleAt(t) {
    const seg = G.tl.at(t);
    if (!seg) return null;
    const s = sampleSeg(seg, t);
    const st = seg.st;
    return { ...s, lastHitTeam: st.lastHitTeam, lastHitter: st.lastHitter, hits: st.hits, isServe: st.isServe, seg, held: st.state === 'held', drag: PHYSICS.DRAG };
  }

  function teamSide(team) { return game.match.teamSides[team]; }

  /* ---------------------------------------------------------------- шаг своего игрока (тик хоста) */
  function steer(sim, world, dt, phase) {
    const hi = game.humanInput || { mx: 0, my: 0, active: false };
    let lvlKey = game.cfg.assistStrength || 'auto';
    if (lvlKey === 'auto') lvlKey = game.cfg.difficulty === 'novice' ? 'strong' : 'light';
    const lvl = ASSIST_LEVELS[lvlKey] || ASSIST_LEVELS.light;
    if (!game.cfg.assist || (lvl[0] === 0 && lvl[1] === 0) || phase !== 'rally') return { mx: hi.mx || 0, my: hi.my || 0, sm: 1 };
    updateBrain(G.brain, world, dt);
    let mx = sim.input.mx, my = sim.input.my, sm = sim.speedMul;
    if (!hi.active) return { mx: mx * lvl[0], my: my * lvl[0], sm };
    const mag = Math.min(1, Math.hypot(hi.mx, hi.my));
    const w = lvl[1] * (1 - mag) * (1 - mag);
    return { mx: hi.mx + (mx - hi.mx) * w, my: hi.my + (my - hi.my) * w, sm: 1 };
  }

  function worldAt(t, sh, phase) {
    const w = Object.create(game);
    w.shuttle = sh; w.time = t; w.phase = phase;
    w.players = game.players.map(p => (p.id === myId ? G.sim : p));
    w.rng = Math.random;
    return w;
  }

  function sendShot(tick, type, aimY, retype) {
    G.shotsOut.push([++G.shotSeq, tick, Math.max(0, SHOT_TYPES.indexOf(type)), aimY == null ? null : q100(aimY), retype ? 1 : 0]);
    if (G.shotsOut.length > 12) G.shotsOut.shift();
    G.sendAcc = 1e9;   // нажатие — отправить сразу
  }

  /** Новые нажатия/уточнения от main.js (game.humanShot / retypeHumanShot) → хосту. */
  function trackPresses(tick) {
    const ps = game._lc.pendingShot, S = G.sent;
    if (ps && ps !== S.ps) { S.ps = ps; S.type = ps.type; S.aimY = ps.aimY; sendShot(Math.max(0, Math.round(ps.at / DT)), ps.type, ps.aimY, false); }
    else if (ps && (ps.type !== S.type || ps.aimY !== S.aimY)) { S.type = ps.type; S.aimY = ps.aimY; sendShot(tick, ps.type, ps.aimY, true); }
    const w = G.sim.swing;
    if (!ps && w && !w.done && !w.serve && S.sw === w && (w.type !== S.type || w.aimY !== S.aimY)) { S.type = w.type; S.aimY = w.aimY; sendShot(tick, w.type, w.aimY, true); }
    if (w && S.sw !== w) S.sw = w;
  }

  function localWhiff(sim, ps) {
    game._lc.pendingShot = null;
    sim.action = 'whiff'; sim.actionTimer = TIMING.WHIFF_RECOVER;
    sim.lastSwing = { type: ps.type, kind: 'overhead', t: 0, whiff: true };
    G.emitWhiff = true;
  }

  function shotLogic(sim, sh, t) {
    const ctl = game._lc;
    const incoming = sh.state === 'flight' && sh.lastHitTeam !== sim.team;
    const ps = ctl.pendingShot;
    if (incoming && !sim.swing) {
      const c = findContact(sim, sh, REACH_HORIZON);
      ctl.reach = c ? { t: c.t, x: c.x, y: c.y, z: c.z, at: t, armed: !!ps } : null;
    } else ctl.reach = null;
    if (!ps) return;
    const age = t - ps.at;
    const busy = sim.swing || sim.action === 'recover' || sim.action === 'whiff';
    if (busy) { if (age > HUMAN_HOLD + TIMING.BUFFER) ctl.pendingShot = null; return; }
    if (!incoming) {
      if (sh.lastHitter === myId && t - (G.lastOwnHitAt ?? -9) < 0.45) { ctl.pendingShot = null; return; }
      if (sh.state === 'flight' || age > 0.15) localWhiff(sim, ps);
      return;
    }
    const c = findContact(sim, sh, TIMING.BUFFER);
    const expired = age >= HUMAN_HOLD;
    if (c && (c.t <= TIMING.WINDUP + 0.005 || expired)) {
      ctl.pendingShot = null;
      requestSwing(sim, sh, ps.type, ps.aimY, { pressure: ctl.pressure ?? 1, human: true, pressAge: age });
      return;
    }
    if (!c && expired) localWhiff(sim, ps);
  }

  /** Как smartAim у хоста для удалённого игрока (game.js): без случайности. */
  function smartAim(sim, sh) {
    const opp = game.players.filter(q => q.team !== sim.team);
    const hw = halfWidth(game.match);
    const oy = opp.reduce((a, q) => a + q.y, 0) / opp.length;
    if (Math.abs(oy) < 0.3) return Math.abs(oy) > 0.05 ? -Math.sign(oy) * 0.7 : ((sh.hits | 0) & 1 ? -0.7 : 0.7);
    return -Math.sign(oy) * Math.min(1, 0.55 + Math.abs(oy) / hw * 0.4);
  }

  /** Предсказанный удар: тот же расчёт, что doHit у хоста, но без случайной ошибки. */
  function predictHit(sim, sh, t) {
    const w = sim.swing; const side = sim.side;
    const dist = Math.hypot(sh.x - sim.x, sh.y - sim.y);
    const okState = sh.state === 'flight' && sh.lastHitTeam !== sim.team && Math.sign(sh.x) === side;
    const okReach = dist <= (PLAYER.REACH + PLAYER.LUNGE_REACH) * 1.15 + 0.15 && sh.z >= PLAYER.REACH_LOW * 0.5 && sh.z <= PLAYER.REACH_HIGH + PLAYER.JUMP_REACH + 0.15;
    if (!okState || !okReach) { w.whiff = true; G.emitWhiff = true; return; }
    const c = { x: sh.x, y: sh.y, z: sh.z };
    const type = resolveShotType(w.type, c, side);
    const vin = Math.hypot(sh.vx, sh.vy, sh.vz), pv = Math.hypot(sim.vx, sim.vy);
    let q = w.quality * (w.pressure ?? 1);
    q *= 1 - clamp((vin - 9) / 40, 0, 0.45);
    q *= 1 - clamp((pv - 2.2) / 8, 0, 0.25);
    if (c.z < 0.45) q *= 0.85;
    const plan = planShot({ type, from: c, side, aimY: w.aimY ?? smartAim(sim, sh), mode: game.match.mode, quality: q, stats: sim.stats, aimError: 0.2, rng: zeroRng() });
    if (!plan) { w.whiff = true; G.emitWhiff = true; return; }
    const rally = Math.floor(sh.seg.id / 64), hits = (sh.hits | 0) + 1;
    const id = rally * 64 + Math.min(63, hits);
    const st = { x: c.x, y: c.y, z: c.z, vx: plan.launch.vx, vy: plan.launch.vy, vz: plan.launch.vz, state: 'flight', lastHitTeam: sim.team, lastHitter: myId, netHit: false, isServe: false, hits };
    addPredicted(id, t - DT, st);
    w.resolvedType = plan.type;
    G.lastOwnHitAt = t;
    G.pendingHitEv = { type: plan.type, quality: q, timing: w.timing, speed: plan.launch.speed, jump: w.jump, lunge: w.lunge, target: plan.target, sg: id };
  }

  function addPredicted(id, t0, st) {
    G.emitted.add(id + ':hit');                                       // звук удара — сразу, повтор от хоста не нужен
    if (G.tl.segs.some(s => s.id === id && !s.predicted)) return;    // хост уже прислал
    const seg = makeSeg(id, t0, st, true);
    G.tl.put(seg);
    G.predicted.set(id, { t0 });
    G.stats.predHits++;
    G.emitted.add(id + ':hit');
  }

  /** Предсказанная подача (как doServe у хоста, без случайной ошибки). */
  function predictServe(sim, type, aimY, t, sh) {
    const s = G.srvLat || game.serveInfo; if (!s) return;
    const M = G.mLat || game.match;
    const box = serviceBox(M, s);
    const r = s.receiverSide;
    const ySign = Math.sign(box.yMin + box.yMax);
    const hw = halfWidth(game.match);
    const lerp = (a, b, k) => a + (b - a) * k;
    let ty;
    if (aimY != null) ty = ySign * lerp(0.3, hw - 0.35, Math.min(1, Math.abs(aimY)));
    else ty = type === 'serveShort' ? ySign * 0.45 : ySign * hw * 0.45;
    const depth = type === 'serveShort' ? COURT.SHORT_SERVICE + 0.3 : (game.match.mode === 'doubles' ? COURT.DOUBLES_LONG_SERVICE - 0.3 : COURT.HALF_LENGTH - 0.45);
    const from = { x: sh.x, y: sh.y, z: sh.z };
    const plan = planShot({ type, from, side: sim.side, target: { x: r * depth, y: ty }, mode: game.match.mode, quality: 0.9, stats: sim.stats, aimError: 0.12, rng: zeroRng(), netClear: type === 'serveShort' ? 0.17 : undefined });
    if (!plan) return;
    const rally = Math.floor(sh.seg.id / 64);
    const st = { ...from, vx: plan.launch.vx, vy: plan.launch.vy, vz: plan.launch.vz, state: 'flight', lastHitTeam: sim.team, lastHitter: myId, netHit: false, isServe: true, hits: 1 };
    addPredicted(rally * 64 + 1, t, st);
    sim.frozen = false;
    sim.action = 'recover'; sim.actionTimer = 0.25;
    sim.lastSwing = { type: plan.type, kind: 'underhand', t: 0, quality: 0.9, timing: 'perfect' };
    G.lastOwnHitAt = t;
    G.pendingHitEv = { type: plan.type, quality: 0.9, timing: 'perfect', speed: plan.launch.speed, target: plan.target, serve: true, sg: rally * 64 + 1 };
  }

  function heldPos(p) { return { x: p.x - p.side * 0.35, y: p.y + 0.15 * p.side, z: PLAYER.SERVE_Z }; }

  function simTick(k) {
    const t = k * DT;
    const sim = G.sim;
    const sh = shuttleAt(t - DT);
    if (!sh) return;
    sim.side = (G.mLat || game.match).teamSides[sim.team];
    const si = G.srvLat || game.serveInfo;
    const iServe = sh.held && si && si.serverTeam === sim.team && si.serverIdx === sim.idx;
    if (sh.held && iServe) Object.assign(sh, heldPos(sim));
    const phase = sh.held ? 'serve' : (sh.state === 'ground' ? 'point' : 'rally');
    const world = worldAt(t, sh, phase);
    const inp = steer(sim, world, DT, phase);
    const qs = [k, q100(inp.mx), q100(inp.my), Math.max(0, Math.min(200, Math.round((inp.sm ?? 1) * 100)))];
    const L = G.lastSample;
    if (!L || L[1] !== qs[1] || L[2] !== qs[2] || L[3] !== qs[3]) { G.samples.push(qs); G.lastSample = qs; }
    G.curSample = qs;
    trackPresses(k);
    if (phase === 'rally') {
      sim.frozen = false;
      sim.input.mx = qs[1] / 100; sim.input.my = qs[2] / 100; sim.speedMul = qs[3] / 100;
      shotLogic(sim, sh, t);
    } else if (phase === 'serve') {
      sim.frozen = true;
      sim.input.mx = sim.input.my = 0;
      const ps = game._lc.pendingShot;
      if (iServe && !G.serveQueued && ps && !sim.swing) {
        const tt = ps.type;
        const type = tt === 'clear' || tt === 'lift' || tt === 'smash' || tt === 'smashdrop' ? 'serveLong' : 'serveShort';
        G.serveQueued = { type, aimY: ps.aimY };
        sim.swing = { type, aimY: ps.aimY, t: 0, contactAt: SERVE_WINDUP, contact: null, quality: 0.9, timing: 'perfect', kind: 'underhand', jump: false, lunge: false, done: false, serve: true, pressure: 1 };
        sim.action = 'swing';
      }
      game._lc.pendingShot = null;
      game._lc.reach = null;
    } else {
      sim.input.mx *= 0.9; sim.input.my *= 0.9;
      game._lc.pendingShot = null; game._lc.reach = null;
    }
    const ctx = { mode: game.cfg.mode, halfWidth: halfWidth(game.match) };
    const ev = updatePlayer(sim, DT, ctx);
    if (ev === 'contact') {
      if (sim.swing && sim.swing.serve) {
        const q = G.serveQueued; G.serveQueued = null;
        if (q && sh.held) predictServe(sim, q.type, q.aimY, t, sh);
      } else if (phase === 'rally') predictHit(sim, sh, t);
    }
    if (!sh.held) G.serveQueued = null;
    G.hist[k % HIST] = { tick: k, x: sim.x, y: sim.y, vx: sim.vx, vy: sim.vy };
  }

  /* ---------------------------------------------------------------- события хоста */
  function emitEv(e) {
    const P = { ...e.payload };
    if (e.pid >= 0) P.player = game.players[e.pid];
    if (e.name === 'point') {
      if (e.m) { applyMatch(game.match, e.m); G.mvApplied = true; }
      game.lastPoint = { winner: P.winner, reason: P.reason, rallyLength: P.rallyLength, x: game.shuttle.x, y: game.shuttle.y };
      if (game.stats) { game.stats.rallies.push(P.rallyLength); game.stats.points[P.winner]++; }
      P.score = game.match.score.slice(); P.games = game.match.games.slice();
    }
    if (e.name === 'matchOver') { if (e.stats && game.stats) Object.assign(game.stats, e.stats); game.match.over = true; game.match.winner = P.winner; game.phase = 'over'; G.over = true; }
    if (e.name === 'serveReady') {
      game.serveInfo = servingInfo(game.match);
      game.rally = { lastType: null, lastTarget: null, lastHitter: -1, shots: [] };
      P.human = P.serverId === myId;
    }
    if (e.name === 'hit') { game.rally.lastType = P.type; game.rally.lastTarget = P.target; game.rally.lastHitter = e.pid; game.rally.shots.push(P.type); if (P.serve) game.emit('serve', { player: P.player, type: P.type }); }
    if (e.name === 'sides') game.match.teamSides = P.teamSides.slice();
    game.emit(e.name, P);
  }

  function processEvents() {
    for (;;) {
      const seq = G.evDone + 1;
      let e = G.evQ.get(seq);
      if (!e) {
        // Пропуск (событие потерялось и вышло из окна повтора) — не стоим вечно.
        const any = [...G.evQ.keys()].filter(s => s > seq);
        if (any.length && G.V - Math.min(...any.map(s => G.evQ.get(s).T)) > 1.0) { G.evDone = seq; continue; }
        return;
      }
      const key = e.sg + ':' + e.name;
      let ready, drop = false;
      switch (e.name) {
        case 'hit':
          if (G.emitted.has(key)) drop = true;
          ready = G.tau >= e.T - DT * 1.5;
          break;
        case 'net': case 'land':
          if (G.emitted.has(key)) drop = true;
          ready = G.tau >= e.T - DT * 1.5;
          break;
        case 'whiff':
          if (e.pid === myId) drop = true;
          ready = G.V >= e.T;
          break;
        default:
          ready = G.V >= e.T || (e.name !== 'serveReady' && G.emitted.has(e.sg + ':land')) || G.V >= e.T - 0.02;
      }
      if (!drop && !ready) return;
      G.evQ.delete(seq); G.evDone = seq;
      if (drop) continue;
      G.emitted.add(key);
      try { emitEv(e); } catch (err) { console.error(err); }
    }
  }

  /* ---------------------------------------------------------------- показ */
  function showPlayers() {
    const pr = G.buf.at(G.V);
    if (!pr) return;
    for (const p of game.players) {
      p.side = teamSide(p.team); p.facing = -p.side;
      if (p.id === myId) continue;
      const ra = pr.a.players[p.id], rb = pr.b.players[p.id];
      if (!ra || !rb) continue;
      const r = lerpPlayer(ra, rb, pr.k);
      p.x = r.x; p.y = r.y; p.z = r.z; p.vx = r.vx; p.vy = r.vy; p.action = r.action;
      const sw = pr.k < 0.5 ? r.swingA : (r.swingB || null);
      if (sw) {
        if (!p.swing || p._swid !== sw.id) { p.swing = { ...sw, quality: 1, timing: 'perfect', aimY: null }; p._swid = sw.id; }
        const base = pr.k < 0.5 ? pr.a : pr.b;
        p.swing.t = Math.min(sw.contactAt + 0.05, sw.t + Math.max(0, G.V - base.T));
        p.swing.done = p.swing.t >= sw.contactAt;
      } else if (p.swing) { p.lastSwing = { ...p.swing }; p.swing = null; p._swid = 0; }
      if ((r.whiffN | 0) > (p._whiffSeen | 0)) { p._whiffSeen = r.whiffN; p.lastSwing = { type: 'smart', kind: 'overhead', t: 0, whiff: true }; }
      p.anim = (p.anim || 0) + Math.hypot(p.vx, p.vy) * G.frameDt * 2.2;
    }
    // Свой — из предсказания + плавное гашение поправки.
    const s = G.sim;
    const k = Math.exp(-G.frameDt / 0.12);
    G.off.x *= k; G.off.y *= k;
    me.x = s.x + G.off.x; me.y = s.y + G.off.y; me.z = s.z; me.vx = s.vx; me.vy = s.vy;
    me.action = s.action; me.actionTimer = s.actionTimer; me.swing = s.swing; me.lastSwing = s.lastSwing;
    me.frozen = s.frozen; me.anim = s.anim; me.side = s.side; me.facing = -s.side; me.speedMul = s.speedMul;
    // Фаза: по снимку на V, но полёт волана у нас может уже начаться.
    const ph = pr.k < 0.5 ? pr.a.phase : pr.b.phase;
    if (!G.over) game.phase = ph;
  }

  function showShuttle() {
    const mySide = teamSide(me.team);
    const segT = G.tl.at(G.tau);
    if (!segT) return;
    const st = segT.st;
    const si = game.serveInfo;
    const iServe = si && si.serverTeam === me.team && si.serverIdx === me.idx;
    let target, Tc = 0.4;
    if (st.state === 'held') target = iServe ? G.R : G.V;
    else if (st.state === 'flight' && st.lastHitTeam !== me.team) {
      target = G.R;
      const tts = timeToSide(segT, G.tau, mySide);
      Tc = Math.max(0.12, (tts ?? 0.3) + 0.1);
    } else if (st.state === 'flight') {
      target = G.V;
      const tts = timeToSide(segT, G.tau, -mySide);
      Tc = Math.max(0.25, (tts ?? 0.3) + 0.35);
    } else target = G.V;
    const tau0 = G.tau;
    G.tau = advanceShuttleClock(G.tau, target, G.frameDt, Tc);
    G.tau = clamp(G.tau, G.V - 0.02, G.R);
    // Летит к сопернику и уже на его половине — не опережаем показ соперника (иначе волан
    // «пролетит сквозь» его ракетку до того, как придёт его удар).
    {
      const s2 = G.tl.at(G.tau);
      const known = G.buf.latest() ? G.buf.latest().T : G.V;   // дальше этого хост ещё ничего не сообщил
      const lim = Math.min(G.V + 0.03, known);
      if (s2 && s2.st.state === 'flight' && s2.st.lastHitTeam === me.team && G.tau > lim) {
        const p2 = sampleSeg(s2, G.tau);
        if (Math.sign(p2.x) === -mySide) G.tau = Math.max(tau0, lim);
      }
    }
    const seg = G.tl.at(G.tau);
    let pos;
    if (seg.st.state === 'held') {
      const srv = si ? game.players.find(p => p.team === si.serverTeam && p.idx === si.serverIdx) : null;
      pos = srv ? { ...heldPos(srv), vx: 0, vy: 0, vz: 0, state: 'held' } : { ...seg.st };
    } else pos = sampleSeg(seg, G.tau);
    // Смена отрезка «назад/вбок» (поправка хоста, ошибка предсказания) — плавно.
    if (G.shSegRef && G.shSegRef !== seg && G.shLast && seg.st.state !== 'held') {
      const d = { x: G.shLast.x - pos.x, y: G.shLast.y - pos.y, z: G.shLast.z - pos.z };
      const dl = Math.hypot(d.x, d.y, d.z);
      if (dl < 9) { G.shOff = d; G.shOffT = 0.07 + 0.025 * dl; } else G.shOff = { x: 0, y: 0, z: 0 };
    }
    if (seg.st.state === 'held') G.shOff = { x: 0, y: 0, z: 0 };
    G.shSegRef = seg;
    const k = Math.exp(-G.frameDt / (G.shOffT || 0.07));
    G.shOff.x *= k; G.shOff.y *= k; G.shOff.z *= k;
    const sh = game.shuttle;
    sh.x = pos.x + G.shOff.x; sh.y = pos.y + G.shOff.y; sh.z = Math.max(0, pos.z + G.shOff.z);
    sh.vx = pos.vx; sh.vy = pos.vy; sh.vz = pos.vz;
    sh.state = pos.state === 'held' ? 'held' : pos.state;
    sh.lastHitTeam = seg.st.lastHitTeam; sh.lastHitter = seg.st.lastHitter; sh.hits = seg.st.hits; sh.isServe = seg.st.isServe; sh.netHit = !!pos.netHit;
    G.shLast = { x: sh.x, y: sh.y, z: sh.z };
    if (seg.st.state === 'flight' && game.phase === 'serve') game.phase = 'rally';
    // Свои «волановые» события (сетка/пол) — сразу, когда τ их проходит.
    // Сетка/пол на воланах, летящих к нам, — сразу по своему времени; к сопернику — по событиям хоста.
    // В паре волан к нам может перехватить напарник (его удар считает хост) — тогда ждём хоста.
    const solo = game.cfg.mode !== 'doubles' || G.tau <= (G.buf.latest() ? G.buf.latest().T : G.V);
    if (seg.st.state === 'flight' && seg.st.lastHitTeam !== me.team && solo) {
      for (const kind of ['net', 'land']) {
        const key = seg.id + ':' + kind;
        if (G.emitted.has(key)) continue;
        const te = segEventTime(seg, kind);
        if (te == null || G.tau < te) continue;
        const p = sampleSeg(seg, te);
        G.emitted.add(key);
        if (kind === 'net') game.emit('net', { x: p.x, y: p.y, z: p.z });
        else {
          let inn = true;
          try { inn = judgeLanding(game.match, { x: p.x, y: p.y }, seg.st.lastHitTeam, seg.st.isServe || seg.st.hits === 1, !!p.netHit || segEventTime(seg, 'net') != null, game.serveInfo).reason === 'in'; } catch (_) {}
          game.emit('land', { x: p.x, y: p.y, in: inn });
        }
      }
    }
  }

  /* ---------------------------------------------------------------- отправка ввода */
  function sendInput(dt) {
    G.sendAcc += dt;
    const period = G.route === 'server' ? 1 / 25 : 1 / 45;
    if (G.sendAcc < period) return;
    G.sendAcc = 0;
    const minTick = G.lastTick - Math.round(0.3 / DT);
    G.samples = G.samples.filter(s => s[0] >= minTick);
    const s = G.samples.slice();
    if (G.curSample && (!s.length || s[s.length - 1][0] !== G.curSample[0])) s.push(G.curSample);   // «сердцебиение»: текущий тик
    if (s.length > 80) s.splice(0, s.length - 80);
    o.send({ t: 'i', q: ++G.q, mid: G.mid, ea: Math.max(G.evDone, G.evMax), s, sh: G.shotsOut.slice(-8) });
  }

  /* ---------------------------------------------------------------- кадр */
  G.frame = function (dt) {
    G.frameDt = dt;
    if (!G.started) return;
    const now = localSec();
    if (!G.paused) {
      const E = G.clock.est(now);
      G.delay = slew(G.delay, targetDelay(G.clock.jitterP(0.9), G.buf.interval, G.dmin, G.dmax), dt, 0.4, 0.05);
      G.V = Math.max(G.V, E - G.delay);
      G.appliedLead = G.R - E;
      const Rt = E + G.lead;
      if (Rt > G.R + 0.3) G.R = Rt;
      else G.R += dt * clamp(1 + (Rt - G.R) * 2, G.R > Rt + 0.25 ? 0 : 0.9, 1.1);   // сильно впереди — ждём (тики назад не отматываются)
      // Свой игрок: тики хоста до R.
      const target = Math.floor(G.R / DT);
      if (!G.over) {
        if (target - G.lastTick > 90) G.lastTick = target - 90;
        while (G.lastTick < target) { G.lastTick++; simTick(G.lastTick); }
      }
    }
    game.time = Math.max(game.time || 0, G.R);
    showPlayers();
    if (G.tau == null) G.tau = G.V;
    if (!G.paused) showShuttle();
    // Свои предсказанные события — после обновления волана (эффекты берут его позицию).
    if (G.pendingHitEv) {
      const e = G.pendingHitEv; G.pendingHitEv = null;
      game.rally.lastType = e.type; game.rally.shots.push(e.type);
      if (e.serve) game.emit('serve', { player: me, type: e.type });
      game.emit('hit', { player: me, type: e.type, quality: e.quality, timing: e.timing, speed: e.speed, jump: e.jump, lunge: e.lunge, target: e.target, serve: e.serve });
    }
    if (G.emitWhiff) { G.emitWhiff = false; game.emit('whiff', { player: me }); }
    processEvents();
    if (G.emitted.size > 400) G.emitted = new Set([...G.emitted].slice(-200));
    G.buf.trim(G.V);
    if (!G.paused) sendInput(dt);
  };

  /** Для автотестов/бота: волан в момент t (по отрезкам) и своя модель игрока. */
  G.shuttleAt = shuttleAt;
  G.info = () => ({ delay: G.delay, lead: G.lead, V: G.V, R: G.R, tau: G.tau, ...G.stats, jitter: G.clock.jitterP(0.9), bufN: G.buf.list.length });
  return G;
}
