/**
 * Headless-симуляция матчей ИИ против ИИ (Node, без браузера).
 *   node tests/sim.mjs [--matches N] [--mode singles|doubles] [--diff pro] [--format quick]
 * Печатает среднюю длину розыгрыша, доли аутов/сетки/ошибок подачи,
 * проверяет, что матч завершается с корректным счётом по BWF.
 * Код выхода != 0, если проверки не пройдены.
 */
import { createGame } from '../src/game.js';
import { PHYSICS } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.push([v.slice(2), arr[i + 1]]) : 0, a), []));
const N = +(args.matches || 4);
const modes = args.mode ? [args.mode] : ['singles', 'doubles'];
const diffs = args.diff ? [args.diff] : ['novice', 'amateur', 'pro', 'legend'];
const format = args.format || 'quick';

function validGame(a, b, points = 21, cap = 30) {
  const w = Math.max(a, b), l = Math.min(a, b);
  if (w === cap) return l === cap - 1 || l <= cap - 2;
  return w >= points && w - l >= 2 && (w === points || w - l === 2);
}

let failed = false;
const summary = [];
for (const mode of modes) for (const diff of diffs) {
  let rallies = [], faults = { out: 0, net: 0, serveFault: 0 }, winners = 0, hits = 0, perfect = 0, whiffs = 0, simTime = 0, games = 0, bad = 0;
  const shots = {};
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const g = createGame();
    g.startMatch({ mode, difficulty: diff, format, humans: 0, seed: 1000 + i * 7919 });
    let steps = 0;
    while (g.phase !== 'over' && steps < 120 * 60 * 90) { g.step(PHYSICS.DT); steps++; }
    if (g.phase !== 'over') { console.error('match did not finish', mode, diff, i); failed = true; continue; }
    for (const [a, b] of g.match.gameScores) { games++; if (!validGame(a, b, g.match.format.points, g.match.format.cap)) { bad++; console.error('invalid game score', a, b); } }
    const s = g.stats;
    rallies.push(...s.rallies);
    for (const k in faults) faults[k] += s.faults[k];
    winners += s.winners; hits += s.hits; perfect += s.perfect; whiffs += s.whiffs;
    for (const k in s.shots) shots[k] = (shots[k] || 0) + s.shots[k];
    simTime += g.time;
  }
  const pts = rallies.length;
  const avg = rallies.reduce((a, b) => a + b, 0) / Math.max(1, pts);
  const row = {
    mode, diff, points: pts, avgRally: +avg.toFixed(2),
    longest: Math.max(...rallies),
    outPct: +(100 * faults.out / pts).toFixed(1), netPct: +(100 * faults.net / pts).toFixed(1),
    serveFaultPct: +(100 * faults.serveFault / pts).toFixed(1), winnerPct: +(100 * winners / pts).toFixed(1),
    whiffs, perfectPct: +(100 * perfect / Math.max(1, hits)).toFixed(0),
    games, invalidGames: bad, simMinPerMatch: +(simTime / 60 / N).toFixed(1), wallMs: Date.now() - t0,
  };
  summary.push(row);
  console.log(JSON.stringify(row), JSON.stringify(shots));
  if (bad) failed = true;
  if (diff === 'pro' && mode === 'singles' && avg < 6) { console.error('FAIL: pro singles avg rally < 6'); failed = true; }
}
process.exitCode = failed ? 1 : 0;
