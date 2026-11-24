/**
 * Онлайн: формат сообщений, интерполяция, часы, отрезки волана и полный «хост ↔ гость»
 * в одном процессе с имитацией сети (задержка, джиттер, потери).
 *   node --test tests/net.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game.js';
import { PHYSICS } from '../src/config.js';
import { stepShuttle, createShuttle } from '../src/physics.js';
import { findContact } from '../src/player.js';
import * as C from '../src/net/codec.js';
import { createClock, createSnapBuffer, lerpPlayer, targetDelay, advanceShuttleClock } from '../src/net/timing.js';
import { makeSeg, sampleSeg, segEventTime, createTimeline } from '../src/net/shuttleline.js';
import { createHostDriver } from '../src/net/host.js';
import { createGuestView } from '../src/net/guest.js';

const DT = PHYSICS.DT;
const J = o => JSON.parse(JSON.stringify(o));

test('codec: снимок хоста кодируется, проходит JSON и раскодируется', () => {
  const g = createGame({ mode: 'doubles', humans: 1, seed: 5, controllers: ['human', 'remote', 'ai', 'remote'] });
  const drv = createHostDriver(g); drv.reset();
  for (let i = 0; i < 120 * 4; i++) g.step(DT);
  const raw = J(drv.snapshot({ playerId: 1, ea: -1, mid: 3 }));
  const s = C.decodeSnap(raw);
  assert.ok(s, 'снимок валиден');
  assert.equal(s.players.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(s.players[i].x - g.players[i].x) < 0.006);
    assert.ok(Math.abs(s.players[i].y - g.players[i].y) < 0.006);
  }
  assert.equal(s.phase, g.phase);
  assert.ok(Math.abs(s.T - g.time) < 0.001);
  assert.ok(JSON.stringify(raw).length < 700, 'компактно: ' + JSON.stringify(raw).length + ' байт');
  // Мусор отбрасывается.
  assert.equal(C.decodeSnap({ ...raw, pl: [[1e9, 0, 0, 0, 0, 0, 0, 0], raw.pl[1]] }), null);
  assert.equal(C.decodeSnap({ ...raw, T: NaN }), null);
  assert.equal(C.decodeSnap({ ...raw, sg: [1, 2] }), null);
  assert.equal(C.decodeSnap(null), null);
});

test('codec: события и ввод', () => {
  const p = { id: 2 };
  const e = C.encodeEvent(7, 'hit', { player: p, type: 'smash', quality: 0.83, timing: 'perfect', speed: 41.27, jump: true, target: { x: 3.1, y: -1.2 } }, 12.3456, { sg: 130 });
  const d = C.decodeEvent(J(e));
  assert.equal(d.name, 'hit'); assert.equal(d.pid, 2); assert.equal(d.sg, 130); assert.equal(d.payload.type, 'smash');
  assert.equal(d.payload.timing, 'perfect'); assert.ok(d.payload.jump); assert.ok(Math.abs(d.T - 12.346) < 1e-9);
  const m = createGame({ humans: 1, seed: 1 }).match; m.score = [5, 3];
  const pe = C.decodeEvent(J(C.encodeEvent(8, 'point', { winner: 0, reason: 'out', rallyLength: 9, result: { gameWon: false } }, 1, { sg: 64, m: C.encodeMatch(m) })));
  assert.deepEqual(pe.m.slice(0, 2), [5, 3]);
  assert.equal(C.decodeEvent([1, 99, 0]), null);
  const inp = C.decodeInput(J({ t: 'i', q: 3, mid: 1, ea: 4, s: [[100, 50, -100, 100]], sh: [[1, 99, 1, null, 0]] }));
  assert.equal(inp.samples[0].my, -1); assert.equal(inp.shots[0].type, 'clear');
  assert.equal(C.decodeInput({ t: 'i', q: 3, mid: 1, ea: 4, s: [[100, 500, 0, 100]], sh: [] }), null);
  assert.equal(C.normCode(' ab-cd e1'), 'ABCDE');
  assert.match(C.newRoomCode(), /^[A-HJ-NP-Z]{5}$/);
  const pr = C.cleanProfile({ nick: '<b>Рахим</b>12345678901234567890', heroId: 'kai', color: 'red;x' });
  assert.ok(!/[<>]/.test(pr.nick) && pr.nick.length <= 16 && pr.color === '');
});

test('интерполяция: между снимками, без смешивания при телепорте', () => {
  const b = createSnapBuffer();
  b.push({ n: 1, T: 1.0 }); b.push({ n: 2, T: 1.05 }); b.push({ n: 3, T: 1.1 });
  assert.equal(b.push({ n: 2, T: 1.2 }), false, 'старый номер отброшен');
  const r = b.at(1.075); assert.equal(r.a.n, 2); assert.ok(Math.abs(r.k - 0.5) < 1e-9);
  const p = lerpPlayer({ x: 0, y: 0, z: 0, vx: 1, vy: 0, action: 'run' }, { x: 0.1, y: 0, z: 0, vx: 1, vy: 0, action: 'run' }, 0.5);
  assert.ok(Math.abs(p.x - 0.05) < 1e-9);
  const t = lerpPlayer({ x: -3, y: 0, z: 0, vx: 0, vy: 0 }, { x: 2.6, y: 0.6, z: 0, vx: 0, vy: 0 }, 0.3);
  assert.equal(t.x, -3, 'телепорт к подаче — без «проезда» через корт');
  assert.ok(targetDelay(0.2, 0.05, 0.08, 0.45) > 0.2);
  assert.equal(targetDelay(5, 0.05, 0.08, 0.45), 0.45);
});

test('часы: оценка смещения по самому быстрому снимку и джиттер', () => {
  const c = createClock();
  let jit = 0;
  for (let i = 0; i < 200; i++) {
    const T = i * 0.05, d = 0.1 + (i % 5 === 0 ? 0.08 : 0);   // каждый 5-й снимок опаздывает
    c.sample(T, 100 + T + d);
  }
  assert.ok(Math.abs(c.est(100 + 10 + 0.1) - 10) < 0.02, 'est ≈ время хоста с мин. задержкой');
  jit = c.jitterP(0.9);
  assert.ok(jit > 0.05 && jit < 0.1, 'p90 джиттера ' + jit);
  // Догоняющие часы волана: не перелетают цель, сходятся.
  let tau = 0, tgt = 0.4;
  for (let i = 0; i < 120; i++) { tau = advanceShuttleClock(tau, tgt, 1 / 60, 0.5); tgt += 1 / 60; assert.ok(tau <= tgt + 1e-9); }
  assert.ok(tgt - tau < 0.02);
});

test('отрезок волана у гостя совпадает с симуляцией хоста', () => {
  const st = { x: -5, y: 1, z: 1.1, vx: 18, vy: -2, vz: 9, state: 'flight', netHit: false };
  const seg = makeSeg(65, 2.0, st);
  const s = { ...createShuttle(), ...st };
  for (let i = 1; i <= 240; i++) {
    stepShuttle(s, DT);
    const g = sampleSeg(seg, 2.0 + i * DT);
    assert.ok(Math.abs(g.x - s.x) < 1e-9 && Math.abs(g.z - s.z) < 1e-9, 'шаг ' + i);
    if (s.state === 'ground') break;
  }
  assert.ok(segEventTime(seg, 'land') > 2.0);
  const tl = createTimeline();
  tl.put(makeSeg(64, 1, { ...st, state: 'held' })); tl.put(seg);
  assert.equal(tl.at(1.5).id, 64); assert.equal(tl.at(2.1).id, 65);
  const pred = makeSeg(66, 3, st, true); tl.put(pred);
  assert.equal(tl.put(makeSeg(66, 3.001, st)), 'replaced', 'авторитетный заменяет предсказанный');
  assert.equal(tl.at(3.1).predicted, false);
});

/* ---------------------------------------------------------------- хост ↔ гость в одном процессе */

function makeNet(lat, jit, loss, rnd) {
  const q = [];
  let lastAt = 0;
  return {
    send(now, msg, reliable) {
      if (!reliable && loss && rnd() < loss) return;
      const at = Math.max(lastAt, now + lat + rnd() * jit);   // порядок сохраняется (как у ретранслятора)
      lastAt = at;
      q.push({ at, msg: J(msg) });
    },
    due(now) { const out = []; while (q.length && q[0].at <= now) out.push(q.shift().msg); return out; },
  };
}

/** Бот «человека»: автобег + нажатие умного удара за ~WINDUP до контакта. */
function botPress(p, sh, rnd, st, press) {
  if (!sh || sh.state !== 'flight' || sh.lastHitTeam === p.team || p.swing) { st.planned = null; return; }
  if (!st.planned) st.planned = { delay: 0.12 + (rnd() - 0.5) * 0.04 };
  if (st.planned.delay < 0) return;
  const c = findContact(p, sh, 0.42);
  if (c && c.t <= Math.max(st.planned.delay, 0.125)) { press(); st.planned.delay = -1; }   // findContact держит c.t около WINDUP
}

function runOnline({ lat, jit, loss, seconds, mode = 'singles', seed = 11 }) {
  const rnd = (() => { let s = seed * 7919 + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const cfg = { mode, format: 'short', difficulty: 'amateur', seed, assist: true, assistStrength: 'strong', characters: mode === 'doubles' ? ['timur', 'kai', 'mira', 'leo'] : ['timur', 'mira'] };
  const hostCtl = mode === 'doubles' ? ['human', 'ai', 'remote', 'ai'] : ['human', 'remote'];
  const guestCtl = mode === 'doubles' ? ['remote', 'ai', 'human', 'ai'] : ['remote', 'human'];
  const gid = mode === 'doubles' ? 2 : 1;
  const host = createGame(); host.startMatch({ ...cfg, controllers: hostCtl });
  const drv = createHostDriver(host); drv.reset(); drv.addRemote(gid);
  const guest = createGame(); guest.startMatch({ ...cfg, controllers: guestCtl });
  let now = 0;
  const up = makeNet(lat, jit, loss, rnd), down = makeNet(lat, jit, loss, rnd);
  const view = createGuestView(guest, { myId: gid, mid: 1, route: 'p2p', now: () => now, send: m => up.send(now, m, false) });
  view.setRtt(2 * lat + jit / 2);
  const peer = { playerId: gid, ea: -1, mid: 1 };
  const hb = {}, gb = {};
  const gHits = { n: 0, perfect: 0, whiff: 0, local: 0 };
  host.on('hit', e => { if (e.player.id === gid && !e.serve) { gHits.n++; if (e.timing === 'perfect') gHits.perfect++; } });
  host.on('whiff', e => { if (e.player.id === gid) gHits.whiff++; });
  guest.on('hit', e => { if (e.player === guest.human && !e.serve) gHits.local++; });
  const gEvents = {}; for (const n of C.EVENTS) guest.on(n, () => { gEvents[n] = (gEvents[n] || 0) + 1; });
  let acc = 0, sendAcc = 0, maxJump = 0, maxShJump = 0, lastP = null, lastSh = null, lastPhase = '';
  const frame = 1 / 60;
  for (let f = 0; f < seconds * 60; f++) {
    now += frame;
    for (const m of up.due(now)) { const inp = C.decodeInput(m); if (inp) { peer.ea = Math.max(peer.ea, inp.ea); drv.input(gid, inp, now * 1000); } }
    // Хост: свой бот + шаги.
    const h = host.human;
    if (host.phase === 'serve' && host.serveInfo.serverTeam === h.team && host.serveInfo.serverIdx === h.idx && host.phaseTimer < 5.3) host.humanShot('smart', null);
    if (host.phase === 'rally') botPress(h, host.shuttle, rnd, hb, () => host.humanShot('smart', null));
    acc += frame;
    while (acc >= DT) { host.step(DT); acc -= DT; }
    sendAcc += frame;
    if (sendAcc >= 1 / 30) { sendAcc = 0; down.send(now, drv.snapshot(peer), false); }
    for (const m of down.due(now)) { const s = C.decodeSnap(m); if (s) view.onSnap(s); }
    // Гость: бот видит своё предсказанное время R.
    if (view.started) {
      const si = view.srvLat || guest.serveInfo;
      const R = view.R;
      const sh = view.shuttleAt(R);
      if (sh && sh.held && si && si.serverTeam === view.sim.team && si.serverIdx === view.sim.idx && rnd() < 0.02) guest.humanShot('smart', null);
      if (sh && !sh.held) botPress(view.sim, sh, rnd, gb, () => guest.humanShot('smart', null));
    }
    view.frame(frame);
    // Плавность своего игрока и волана на экране гостя.
    const me = guest.human;
    if (lastP && guest.phase === lastPhase && guest.phase === 'rally') maxJump = Math.max(maxJump, Math.hypot(me.x - lastP.x, me.y - lastP.y));
    if (lastSh && guest.shuttle.state === 'flight' && lastSh.state === 'flight') maxShJump = Math.max(maxShJump, Math.hypot(guest.shuttle.x - lastSh.x, guest.shuttle.y - lastSh.y, guest.shuttle.z - lastSh.z));
    lastP = { x: me.x, y: me.y }; lastSh = { ...guest.shuttle }; lastPhase = guest.phase;
    if (host.phase === 'over' && guest.phase === 'over') break;
  }
  // Догоняем хвост событий.
  for (let f = 0; f < 120; f++) { now += frame; for (const m of down.due(now)) { const s = C.decodeSnap(m); if (s) view.onSnap(s); } if (f % 2 === 0) down.send(now, drv.snapshot(peer), true); view.frame(frame); }
  return { host, guest, view, gHits, maxJump, maxShJump, gEvents };
}

test('онлайн 1×1 без задержки: счёт совпадает, удары гостя проходят', () => {
  const r = runOnline({ lat: 0.01, jit: 0, loss: 0, seconds: 150 });
  assert.deepEqual(r.guest.match.score, r.host.match.score, 'счёт у гостя = у хоста');
  assert.ok(r.host.stats.hits >= 20, 'сыграно ударов: ' + r.host.stats.hits);
  assert.ok(r.gHits.n >= 10, 'удары гостя: ' + JSON.stringify(r.gHits));
  console.log('  lat10', JSON.stringify({ score: r.host.match.score, gHits: r.gHits, info: r.view.info(), maxJump: r.maxJump, maxShJump: r.maxShJump }));
});

test('онлайн 1×1 при пинге 200 мс + джиттер + 5% потерь: удары гостя проходят, движение плавное', () => {
  const r = runOnline({ lat: 0.1, jit: 0.04, loss: 0.05, seconds: 150, seed: 23 });
  assert.deepEqual(r.guest.match.score, r.host.match.score, 'счёт у гостя = у хоста');
  const tot = r.gHits.n + r.gHits.whiff;
  assert.ok(r.gHits.n >= 10, 'удары гостя: ' + JSON.stringify(r.gHits));
  assert.ok(r.gHits.whiff / Math.max(1, tot) < 0.2, 'промахов мало: ' + JSON.stringify(r.gHits));
  assert.ok(r.gHits.perfect / Math.max(1, r.gHits.n) > 0.3, 'хорошо рассчитанное нажатие — «идеально» и у хоста: ' + JSON.stringify(r.gHits));
  assert.ok(r.maxJump < 0.2, 'свой игрок без рывков (макс. сдвиг за кадр ' + r.maxJump.toFixed(3) + ' м)');
  console.log('  lat100', JSON.stringify({ score: r.host.match.score, gHits: r.gHits, info: r.view.info(), maxJump: r.maxJump, maxShJump: r.maxShJump, ev: r.gEvents }));
});

test('онлайн 2×2 (2 человека + 2 ИИ) при пинге 300 мс: счёт совпадает', () => {
  const r = runOnline({ lat: 0.15, jit: 0.03, loss: 0.02, seconds: 120, mode: 'doubles', seed: 5 });
  assert.deepEqual(r.guest.match.score, r.host.match.score);
  assert.ok(r.gHits.n >= 4, 'удары гостя: ' + JSON.stringify(r.gHits));
  console.log('  2x2 lat150', JSON.stringify({ score: r.host.match.score, gHits: r.gHits, info: r.view.info(), maxJump: r.maxJump }));
});
