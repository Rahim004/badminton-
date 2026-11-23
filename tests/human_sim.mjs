/**
 * Эмуляция живого игрока (Node): автобег включён, «человек» жмёт умный удар
 * с человеческим разбросом тайминга. Проверяет, что путь ввода человека
 * работает и что игра проходима/интересна на разных уровнях.
 *   node tests/human_sim.mjs [--sigma 0.07] [--matches 3]
 */
import { createGame } from '../src/game.js';
import { findContact } from '../src/player.js';
import { PHYSICS } from '../src/config.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.push([v.slice(2), arr[i + 1]]) : 0, a), []));
const sigma = +(args.sigma || 0.07);
const N = +(args.matches || 3);
const shotsPool = ['smart', 'smart', 'smart', 'clear', 'net', 'smash'];

for (const diff of ['novice', 'amateur', 'pro', 'legend']) {
  let won = 0, pts = [0, 0], rallies = [], perfect = 0, hits = 0, whiffs = 0, partnerHits = 0;
  for (let i = 0; i < N; i++) {
    const g = createGame();
    g.startMatch({ mode: args.mode || 'singles', difficulty: diff, format: 'short', humans: 1, assist: true, seed: 77 + i * 31 });
    const h = g.human;
    let rnd = (() => { let s = 99 + i; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    let planned = null;
    g.on('hit', e => { if (e.player === h) { hits++; if (e.timing === 'perfect') perfect++; } else if (e.player.team === h.team) partnerHits++; planned = null; });
    g.on('whiff', e => { if (e.player === h) whiffs++; });
    let steps = 0;
    while (g.phase !== 'over' && steps++ < 120 * 60 * 40) {
      if (g.phase === 'serve' && g.serveInfo.serverTeam === h.team && g.phaseTimer < 5) g.humanShot(rnd() < 0.5 ? 'smart' : 'net', null);
      const sh = g.shuttle;
      if (g.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== h.team && !h.swing) {
        if (!planned) {
          // нормальное распределение тайминга
          const u = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
          planned = { delay: 0.12 + u * sigma, type: shotsPool[Math.floor(rnd() * shotsPool.length)] };
        }
        const c = findContact(h, sh, 0.42);
        if (c && c.t <= Math.max(0.03, planned.delay)) { g.humanShot(planned.type, rnd() < 0.5 ? null : (rnd() < 0.5 ? -1 : 1)); planned.delay = -1; }
      }
      g.step(PHYSICS.DT);
    }
    if (g.match.winner === h.team) won++;
    pts[0] += g.stats.points[0]; pts[1] += g.stats.points[1];
    rallies.push(...g.stats.rallies);
  }
  const avg = rallies.reduce((a, b) => a + b, 0) / rallies.length;
  console.log(JSON.stringify({ diff, sigma, humanWins: `${won}/${N}`, points: pts, avgRally: +avg.toFixed(2), humanHits: hits, partnerHits, perfectPct: Math.round(100 * perfect / Math.max(1, hits)), whiffs }));
}
