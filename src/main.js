/**
 * main.js — запуск, главный цикл (фиксированная симуляция 120 Гц + отрисовка по rAF),
 * ресайз/DPR/поворот экрана, связка модулей и тест-хуки window.__game.
 *
 * Тест-хуки (window.__game):
 *   state                      — снимок состояния (game.snapshot())
 *   startMatch({mode, difficulty, format, assist, seed, humans}) — начать матч (скрывает меню)
 *   step(n=1)                  — n шагов симуляции синхронно
 *   forceAI(bool)              — ИИ управляет человеческим слотом
 *   freeze(bool)               — остановить авто-симуляцию в цикле (рендер продолжается)
 *   setSpeed(k)                — ускорение времени (1 — норма)
 *   runUntil(pred, maxSteps)   — шагать, пока pred(state) не станет true
 *   game, renderer, input, ui, audio — сами объекты
 */
import { PHYSICS } from './config.js';
import { createGame } from './game.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';

const canvas = document.getElementById('game');
const uiRoot = document.getElementById('ui');

const game = createGame();
const renderer = createRenderer(canvas);
const input = createInput(canvas);
const audio = createAudio();
renderer.attach(game);
audio.attach(game);

let running = false;    // идёт матч (не меню)
let paused = false;
let frozen = false;     // для тестов
let speed = 1;
let lastOpts = null;

const ui = createUI(uiRoot, {
  onStart(opts) { audio.unlock(); start(opts); },
  onPause() { setPaused(true); },
  onResume() { setPaused(false); },
  onRestart() { if (lastOpts) start(lastOpts); },
  onQuit() { running = false; paused = false; game.phase = 'idle'; ui.showMenu(); },
});
ui.attach(game);

function start(opts) {
  lastOpts = { ...opts };
  game.startMatch({ humans: 1, seed: (Math.random() * 2 ** 31) | 0, ...opts });
  running = true; paused = false; game.paused = false;
  ui.hideAll();
}

function setPaused(p) {
  if (!running) return;
  paused = p; game.paused = p;
  if (p) ui.showPause(); else ui.hideAll();
}

game.on('matchOver', e => {
  const team = game.human ? game.human.team : 0;
  const st = game.stats;
  const avg = st.rallies.length ? (st.rallies.reduce((a, b) => a + b, 0) / st.rallies.length).toFixed(1) : '0';
  setTimeout(() => {
    running = false;
    ui.showGameOver({ won: e.winner === team, team, gameScores: e.gameScores, statsText: `Розыгрышей: ${st.rallies.length} · средняя длина: ${avg} уд. · идеальных: ${st.perfect}` });
  }, 900);
});

// ------------------------------------------------------------ ввод → игра
function applyInput(frameDt) {
  const cmd = input.poll(frameDt);
  if (cmd.pause && running) setPaused(!paused);
  if (!running || paused) return;
  const w = renderer.screenDirToWorld(cmd.move.x, cmd.move.y);
  game.setHumanMove(w.x, w.y);
  for (const s of cmd.shots) {
    audio.unlock();
    // Направление удара: только поперечная (мировая y) составляющая.
    const d = renderer.screenDirToWorld(s.dirX || 0, s.key ? (s.dirY || 0) : 0);
    const aimY = Math.abs(d.y) > 0.3 ? Math.max(-1, Math.min(1, d.y * 1.2)) : null;
    game.humanShot(s.type, aimY);
  }
}

// ------------------------------------------------------------ размеры
function resize() {
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth);
  const h = Math.round(vv ? vv.height : window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(w, h, dpr);
  document.documentElement.classList.toggle('landscape', w > h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { if (document.hidden && running && !paused) setPaused(true); });
resize();

// ------------------------------------------------------------ цикл
const DT = PHYSICS.DT;
let acc = 0, last = performance.now();
function frame(now) {
  const frameDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  applyInput(frameDt);
  if (running && !paused && !frozen) {
    acc += frameDt * speed;
    let n = 0;
    while (acc >= DT && n < 40) { game.step(DT); acc -= DT; n++; }
    if (n >= 40) acc = 0;
  }
  renderer.render(game, input, frameDt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Демо-фон в меню: ИИ против ИИ.
game.startMatch({ mode: 'singles', difficulty: 'pro', humans: 0, seed: 7 });
const demoTimer = setInterval(() => {
  if (running) { clearInterval(demoTimer); return; }
  if (game.phase === 'over' || game.phase === 'idle') game.startMatch({ mode: 'singles', difficulty: 'pro', humans: 0, seed: (Math.random() * 1e9) | 0 });
  for (let i = 0; i < 2; i++) game.step(DT);
}, 16);
ui.showMenu();

// ------------------------------------------------------------ тест-хуки
window.__game = {
  get state() { return game.snapshot(); },
  startMatch(opts = {}) { clearInterval(demoTimer); start({ ...ui.settings, ...opts }); return game.snapshot(); },
  step(n = 1) { for (let i = 0; i < n; i++) game.step(DT); return game.snapshot(); },
  forceAI(b = true) { game.forceAI(b); },
  freeze(b = true) { frozen = !!b; },
  setSpeed(k = 1) { speed = k; },
  runUntil(pred, maxSteps = 120 * 600) {
    for (let i = 0; i < maxSteps; i++) { game.step(DT); if (pred(game.snapshot())) return true; }
    return false;
  },
  pause() { setPaused(true); },
  resume() { setPaused(false); },
  game, renderer, input, ui, audio,
};
