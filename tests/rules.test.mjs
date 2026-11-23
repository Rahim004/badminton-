// Юнит-тесты правил BWF: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, servingInfo, awardRally, judgeLanding, isInCourt, inServiceBox } from '../src/rules.js';

const fmt21 = { games: 1, points: 21, cap: 30 };
const fmt3 = { games: 3, points: 21, cap: 30 };

function play(m, seq) { let r; for (const w of seq) r = awardRally(m, w); return r; }

test('singles: server court follows server score parity', () => {
  const m = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  let s = servingInfo(m);
  assert.equal(s.serverTeam, 0); assert.equal(s.court, 'right');
  awardRally(m, 0); // 1-0
  s = servingInfo(m); assert.equal(s.serverTeam, 0); assert.equal(s.court, 'left');
  awardRally(m, 1); // 1-1, team1 serves from left (1 odd)
  s = servingInfo(m); assert.equal(s.serverTeam, 1); assert.equal(s.court, 'left');
  awardRally(m, 1); // 1-2
  s = servingInfo(m); assert.equal(s.court, 'right');
});

test('right court y-sign equals side sign; receiver is diagonal', () => {
  const m = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  const s = servingInfo(m);
  const side0 = m.teamSides[0];
  assert.equal(Math.sign(s.serverPos.y), side0);       // right court of side -1 => y<0
  assert.equal(Math.sign(s.serverPos.x), side0);
  assert.equal(Math.sign(s.receiverPos.x), -side0);
  assert.equal(Math.sign(s.receiverPos.y), -side0);    // receiver's right court => diagonal
  // box is on receiver side, on receiver's right
  assert.ok(inServiceBox(m, s, { x: -side0 * 3, y: -side0 * 1 }));
  assert.ok(!inServiceBox(m, s, { x: -side0 * 3, y: side0 * 1 }));     // wrong half
  assert.ok(!inServiceBox(m, s, { x: -side0 * 1.5, y: -side0 * 1 }));  // short of short service line
  assert.ok(inServiceBox(m, s, { x: -side0 * 6.6, y: -side0 * 1 }));   // singles long OK
});

test('doubles long service line and wide sidelines', () => {
  const m = createMatch({ mode: 'doubles', format: fmt21, firstServer: 0 });
  const s = servingInfo(m);
  const r = -m.teamSides[0];
  assert.ok(!inServiceBox(m, s, { x: r * 6.3, y: r * 1 }));  // beyond doubles long service line
  assert.ok(inServiceBox(m, s, { x: r * 5.9, y: r * 2.9 })); // wide is fine in doubles
  assert.ok(isInCourt(m, { x: r * 6.6, y: 3.0 }, r));         // rally: long line & wide side
  const ms = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  assert.ok(!isInCourt(ms, { x: r * 3, y: 2.8 }, r));        // singles side line 2.59
});

test('doubles: server switches court only when serving side wins', () => {
  const m = createMatch({ mode: 'doubles', format: fmt21, firstServer: 0 });
  let s = servingInfo(m);
  const firstServer = s.serverIdx;
  assert.equal(s.court, 'right');
  awardRally(m, 0); // 1-0 same server, now in left
  s = servingInfo(m);
  assert.equal(s.serverIdx, firstServer); assert.equal(s.court, 'left');
  const recvRightBefore = m.rightPlayer[1];
  awardRally(m, 1); // 1-1 team1 serves from left: player in left court
  s = servingInfo(m);
  assert.equal(s.serverTeam, 1); assert.equal(s.court, 'left');
  assert.equal(m.rightPlayer[1], recvRightBefore, 'receivers do not switch');
  assert.equal(s.serverIdx, 1 - recvRightBefore);
  awardRally(m, 0); // 2-1, team0 serves from right; occupant of right court of team0
  s = servingInfo(m);
  assert.equal(s.serverTeam, 0); assert.equal(s.court, 'right');
  assert.equal(s.serverIdx, m.rightPlayer[0]);
  assert.equal(s.serverIdx, 1 - firstServer, 'partner now in right court serves');
});

test('game to 21 needs 2-point lead, capped at 30', () => {
  const m = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  for (let i = 0; i < 20; i++) { awardRally(m, 0); awardRally(m, 1); } // 20-20
  let r = awardRally(m, 0); assert.equal(r.gameWon, false); // 21-20
  r = awardRally(m, 1); assert.equal(r.gameWon, false);     // 21-21
  for (let i = 0; i < 8; i++) { awardRally(m, 0); awardRally(m, 1); } // 29-29
  r = awardRally(m, 1); // 29-30
  assert.equal(r.gameWon, true); assert.equal(r.matchWon, true); assert.equal(m.winner, 1);
});

test('21-19 wins, 21-20 does not', () => {
  const m = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  for (let i = 0; i < 19; i++) { awardRally(m, 0); awardRally(m, 1); }
  awardRally(m, 0); // 20-19
  const r = awardRally(m, 0); // 21-19
  assert.equal(r.gameWon, true); assert.equal(m.over, true);
});

test('best of 3: sides switch between games, winner serves next, interval switch at 11 in decider', () => {
  const m = createMatch({ mode: 'singles', format: fmt3, firstServer: 0 });
  const side0 = m.teamSides[0];
  let r = play(m, Array(21).fill(1));
  assert.equal(r.gameWon, true); assert.equal(r.matchWon, false); assert.equal(r.switchSides, true);
  assert.equal(m.teamSides[0], -side0);
  assert.deepEqual(m.score, [0, 0]); assert.deepEqual(m.games, [0, 1]);
  assert.equal(servingInfo(m).serverTeam, 1);
  r = play(m, Array(21).fill(0));
  assert.deepEqual(m.games, [1, 1]); assert.equal(m.teamSides[0], side0);
  r = play(m, Array(10).fill(0));
  assert.equal(r.switchSides, false);
  r = awardRally(m, 0); // 11-0 in decider
  assert.equal(r.switchSides, true); assert.equal(r.interval, true);
  assert.equal(m.teamSides[0], -side0);
  r = play(m, Array(10).fill(0));
  assert.equal(m.over, true); assert.equal(m.winner, 0);
});

test('judgeLanding: in, out, net, serve fault', () => {
  const m = createMatch({ mode: 'singles', format: fmt21, firstServer: 0 });
  const s0 = m.teamSides[0];
  const opp = -s0;
  assert.deepEqual(judgeLanding(m, { x: opp * 3, y: 0 }, 0, false, false), { winner: 0, reason: 'in' });
  assert.deepEqual(judgeLanding(m, { x: opp * 6.9, y: 0 }, 0, false, false), { winner: 1, reason: 'out' });
  assert.deepEqual(judgeLanding(m, { x: s0 * 0.1, y: 0 }, 0, false, true), { winner: 1, reason: 'net' });
  const s = servingInfo(m);
  assert.deepEqual(judgeLanding(m, { x: opp * 3, y: s0 * 1 }, 0, true, false, s), { winner: 1, reason: 'serveFault' });
  assert.deepEqual(judgeLanding(m, { x: opp * 3, y: opp * 1 }, 0, true, false, s), { winner: 0, reason: 'in' });
  // line is in
  assert.equal(judgeLanding(m, { x: opp * 6.7, y: 2.59 }, 0, false, false).reason, 'in');
});
