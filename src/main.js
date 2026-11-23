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
import { createInput, screenDirToWorldAt } from './input.js';
import { loadControls, onControlsChange } from './controlsSettings.js';
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

let controls = loadControls();
onControlsChange(c => { controls = c; input.setControls(c); if (game.cfg) game.cfg.assistStrength = c.assist; });

function start(opts) {
  lastOpts = { ...opts };
  game.startMatch({ humans: 1, seed: (Math.random() * 2 ** 31) | 0, assistStrength: controls.assist, ...opts });
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
  const h = game.human;
  // Направление считаем локально в точке игрока (перспектива!).
  const w = screenDirToWorldAt(renderer, cmd.move.x, cmd.move.y, h ? h.x : null, h ? h.y : null);
  game.setHumanMove(w.x, w.y, cmd.held);
  for (const s of cmd.shots) {
    audio.unlock();
    // Направление удара: поперечная (мировая y) составляющая джойстика/клавиш/свайпа.
    const sy = s.source === 'swipe' || s.source === 'tap' ? 0 : (s.dirY || 0);
    const d = screenDirToWorldAt(renderer, s.dirX || 0, sy, h ? h.x : null, h ? h.y : null);
    const thr = s.source === 'swipe' ? 0.3 : 0.45;
    const aimY = Math.abs(d.y) > thr ? Math.max(-1, Math.min(1, d.y * 1.2)) : null;
    if (s.phase === 'provisional') {
      // Тап в режиме свайпов: бьём сразу (без задержки), свайп потом уточнит.
      // На подаче ждём окончательного жеста (иначе свайп-клир стал бы короткой подачей).
      if (game.phase !== 'serve') { game.humanShot(s.type, aimY); sentGestures.add(s.gid); }
      continue;
    }
    if (s.gid != null && sentGestures.has(s.gid)) {
      sentGestures.delete(s.gid);
      if (s.type !== 'smart' || aimY != null) game.retypeHumanShot(s.type, aimY);
      continue;
    }
    game.humanShot(s.type, aimY);
  }
  if (sentGestures.size > 16) sentGestures.clear();
}
const sentGestures = new Set();

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
