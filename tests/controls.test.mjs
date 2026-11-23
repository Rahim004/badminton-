/**
 * Управление человека (Node, без DOM): буфер нажатий, промахи, автобег, подача, типы ударов.
 *   node --test tests/controls.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/game.js';
import { findContact, resolveShotType, updatePlayer } from '../src/player.js';
import { planShot } from '../src/shots.js';
import { PHYSICS, TIMING } from '../src/config.js';

const DT = PHYSICS.DT;

function toRally(g) {
  for (let i = 0; i < 120 * 10 && g.phase !== 'rally'; i++) {
    if (g.phase === 'serve' && g.serveInfo.serverTeam === g.human.team) g.humanShot('smart');
    g.step(DT);
  }
  assert.equal(g.phase, 'rally');
}

/** Человек жмёт «Удар» за `lead` секунд до того, как волан станет досягаем. */
function playWithLead(lead, seeds = 4) {
  let presses = 0, hits = 0, whiffs = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const g = createGame(); g.startMatch({ difficulty: 'novice', format: 'short', seed, assist: true, assistStrength: 'strong' });
    const h = g.human; let pressedFor = -1;
    g.on('hit', e => { if (e.player === h && !e.serve) hits++; });
    g.on('whiff', e => { if (e.player === h) whiffs++; });
    for (let i = 0; i < 120 * 60 && g.phase !== 'over'; i++) {
      if (g.phase === 'serve' && g.serveInfo.serverTeam === h.team) g.humanShot('smart');
      const sh = g.shuttle;
      if (g.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== h.team && pressedFor !== g.match.score[0] * 1e6 + g.match.score[1] * 1e3 + sh.hits) {
        const c = findContact(h, sh, 2.0);
        if (c && c.t <= lead + TIMING.WINDUP) { g.humanShot('smart'); presses++; pressedFor = g.match.score[0] * 1e6 + g.match.score[1] * 1e3 + sh.hits; }
      }
      g.step(DT);
    }
  }
  return { presses, hits, whiffs };
}

test('раннее нажатие (0.5–0.6 с) не превращается в промах: буфер бьёт в нужный кадр', () => {
  for (const lead of [0.5, 0.6]) {
    const r = playWithLead(lead);
    assert.ok(r.presses > 20, `нажатий ${r.presses}`);
    assert.ok(r.hits / r.presses > 0.9, `lead ${lead}: попаданий ${r.hits}/${r.presses}`);
  }
});

test('буферизованное раннее нажатие — тайминг «рано», но удар нормальный', () => {
  const g = createGame(); g.startMatch({ difficulty: 'novice', seed: 5, assist: true, assistStrength: 'strong' });
  const h = g.human; let res = null;
  g.on('hit', e => { if (e.player === h && !e.serve && !res) res = e; });
  for (let i = 0; i < 120 * 30 && !res; i++) {
    if (g.phase === 'serve' && g.serveInfo.serverTeam === h.team) g.humanShot('smart');
    const sh = g.shuttle;
    if (g.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== h.team && !g.pendingShot && !h.swing) {
      const c = findContact(h, sh, 2.0);
      if (c && c.t <= 0.55 && c.t > 0.5) g.humanShot('smart');
    }
    g.step(DT);
  }
  assert.ok(res, 'удар состоялся');
  assert.equal(res.timing, 'early');
  assert.ok(res.quality >= 0.25, `качество ${res.quality}`);
});

test('нажатие, когда волан не летит к игроку, — промах с событием whiff', () => {
  const g = createGame(); g.startMatch({ difficulty: 'novice', seed: 2, assist: false });
  toRally(g);
  let whiff = 0;
  g.on('whiff', e => { if (e.player === g.human) whiff++; });
  // Ждём, пока волан летит от нас (только что подали/отбили).
  for (let i = 0; i < 600 && !(g.shuttle.lastHitTeam === g.human.team && g.human.action !== 'recover'); i++) g.step(DT);
  for (let i = 0; i < 60; i++) g.step(DT); // старше «окна двойного нажатия» (0.45 с)
  if (g.shuttle.lastHitTeam === g.human.team) {
    g.humanShot('smart');
    for (let i = 0; i < 30; i++) g.step(DT);
    assert.equal(whiff, 1);
  }
});

test('двойное нажатие сразу после своей подачи — без ложного «Мимо!»', () => {
  let seed = 1, g;
  do { g = createGame(); g.startMatch({ difficulty: 'novice', seed: seed++, firstServer: 0 }); } while (g.serveInfo.serverTeam !== g.human.team);
  let whiff = 0; g.on('whiff', e => { if (e.player === g.human) whiff++; });
  g.humanShot('smart');
  for (let i = 0; i < 40 && g.phase !== 'rally'; i++) g.step(DT);
  g.humanShot('smart');
  for (let i = 0; i < 20; i++) g.step(DT);
  assert.equal(whiff, 0);
});

test('ручной бег — полная скорость даже после автобега', () => {
  const g = createGame(); g.startMatch({ difficulty: 'novice', seed: 3, assist: true });
  toRally(g);
  for (let i = 0; i < 30; i++) g.step(DT);
  g.setHumanMove(0, 1, true);
  for (let i = 0; i < 60; i++) g.step(DT);
  assert.equal(g.human.speedMul, 1);
  assert.ok(Math.hypot(g.human.vx, g.human.vy) > 4.3);
});

test('джойстик до упора полностью перекрывает автобег; без джойстика ведёт автобег', () => {
  const g = createGame(); g.startMatch({ difficulty: 'novice', seed: 4, assist: true, assistStrength: 'strong' });
  toRally(g);
  g.setHumanMove(0.6, 0.8, true);
  g.step(DT);
  assert.ok(Math.abs(g.human.input.mx - 0.6) < 1e-9 && Math.abs(g.human.input.my - 0.8) < 1e-9);
  g.setHumanMove(0, 0, false);
  let moved = 0;
  for (let i = 0; i < 240; i++) { g.step(DT); moved += Math.hypot(g.human.input.mx, g.human.input.my); }
  assert.ok(moved > 1, 'автобег двигает игрока');
  // assistStrength off — не двигает.
  const g2 = createGame(); g2.startMatch({ difficulty: 'novice', seed: 4, assist: true, assistStrength: 'off' });
  toRally(g2); g2.setHumanMove(0, 0, false);
  for (let i = 0; i < 240; i++) { g2.step(DT); assert.equal(Math.hypot(g2.human.input.mx, g2.human.input.my), 0); }
});

test('подача: «Удар» — короткая, «Клир» — длинная', () => {
  for (const [type, want] of [['smart', 'serveShort'], ['clear', 'serveLong'], ['net', 'serveShort'], ['smashdrop', 'serveLong']]) {
    let seed = 1, got = null;
    while (!got && seed < 40) {
      const g = createGame(); g.startMatch({ difficulty: 'novice', seed: seed++, firstServer: 0 });
      if (g.serveInfo.serverTeam !== g.human.team) continue;
      g.on('serve', e => { got = e.type; });
      g.humanShot(type);
      for (let i = 0; i < 40 && !got; i++) g.step(DT);
    }
    assert.equal(got, want, type);
  }
});

test('подача: замах раньше вылета волана; прыжок начинается с пола', () => {
  let seed = 1, g;
  do { g = createGame(); g.startMatch({ difficulty: 'novice', seed: seed++, firstServer: 0 }); } while (g.serveInfo.serverTeam !== g.human.team);
  let served = false; g.on('serve', () => { served = true; });
  g.humanShot('smart'); g.step(DT);
  assert.ok(g.human.swing && g.human.swing.serve, 'замах подачи начался');
  assert.ok(!served, 'волан ещё в руке');
  for (let i = 0; i < 40 && !served; i++) g.step(DT);
  assert.ok(served);
  // Прыжок с коротким замахом: высота растёт от 0, без скачка.
  const p = g.players[1];
  p.swing = { type: 'smash', t: 0, contactAt: 0.1, jump: true, done: false, quality: 1 };
  updatePlayer(p, DT, {});
  assert.ok(p.z < 0.1, `первый кадр прыжка z=${p.z}`);
});

test('смэш/дроп: высоко — смэш, низко — дроп/сетка; удар всегда строится', () => {
  for (const z of [0.3, 0.8, 1.2, 1.6, 2.0, 2.4, 2.9]) for (const depth of [1.0, 2.5, 4.0, 6.0]) {
    const c = { x: -depth, y: 0.5, z };
    const t = resolveShotType('smashdrop', c, -1);
    if (z >= 2.05) assert.equal(t, 'smash');
    else assert.ok(['drop', 'net', 'smash'].includes(t), `${z}/${depth}: ${t}`);
    const plan = planShot({ type: t, from: c, side: -1, aimY: 0, mode: 'singles', quality: 0.8, stats: { speed: 0.8, power: 0.8, control: 0.8, stamina: 0.8 }, aimError: 0, rng: Math.random });
    assert.ok(plan, `план для ${t} z=${z} depth=${depth}`);
  }
});

test('повторные нажатия не сбрасывают время первого (нет выгоды от «долбёжки»), но меняют тип', () => {
  const g = createGame(); g.startMatch({ difficulty: 'novice', seed: 6, assist: true });
  toRally(g);
  g.humanShot('clear');
  const at = g.pendingShot.at;
  g.step(DT); g.step(DT);
  if (g.pendingShot) {
    g.humanShot('net');
    assert.equal(g.pendingShot.at, at);
    assert.equal(g.pendingShot.type, 'net');
    assert.ok(g.retypeHumanShot('smashdrop'));
    assert.equal(g.pendingShot.type, 'smashdrop');
  }
});
