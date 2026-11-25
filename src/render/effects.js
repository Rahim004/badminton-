/**
 * render/effects.js — аниме-эффекты, управляемые событиями игры.
 *
 *   • кадр удара (impact frame) на мощном смэше: инверсия кадра + концентрированные линии,
 *     вспышка, тряска камеры, короткая «стоп-кадр» пауза (hit-stop);
 *   • след волана, окрашенный по типу удара, + линии скорости на быстром полёте;
 *   • искры и перья при ударе, пыль/пот на выпадах и приземлениях, конфетти на важных очках;
 *   • ономатопея («БАХ!», «ВЖУХ!», «СМЭШ!», «Идеально!», «Аут», «Сетка») — жирный текст
 *     с обводкой и «поп»-анимацией; крупные баннеры («Очко!», «Гейм!»);
 *   • напряжение матчбола: виньетка, лёгкий наезд камеры, линии напряжения по краям.
 *
 * Уважает reducedMotion из localStorage['volan.settings'] (без тряски, инверсии, стоп-кадра).
 *
 * API:
 *   createEffects() -> FX
 *   fx.attach(game, R)          — R: рендер ({project, camera, w, h, arena?})
 *   fx.update(dt, game)
 *   fx.trailColor               — цвет текущего следа
 *   fx.drawTrail(ctx, project, sh)       — внутри элемента волана (с сортировкой)
 *   fx.drawWorld(ctx, project)           — частицы поверх сцены
 *   fx.drawScreen(ctx, w, h, project)    — инверсия, линии, виньетка, тексты
 *   fx.view                     — {shake:{x,y}, zoom, lag} для камеры
 *   fx.reduced
 */
import { FONT_DISPLAY } from './arena.js';
// Размер надписей «БАХ!», «СМЭШ!» и т. п. — доля меньшей стороны экрана (было 0.12 — мешало игре).
const CALLOUT_K = 0.062;

export const SHOT_COLORS = {
  smash: '#ff4b3a', clear: '#4fd8ff', lift: '#8fe6ff', drop: '#c08cff', net: '#7cf29c',
  drive: '#ffd23f', serveShort: '#ffffff', serveLong: '#bfe9ff',
};
const INK = '#1b0f3a';

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function easeOutBack(t) { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }

export function readReducedMotion() {
  try {
    const s = JSON.parse(globalThis.localStorage.getItem('volan.settings') || 'null');
    if (s && typeof s.reducedMotion === 'boolean') return s.reducedMotion;
  } catch (_) { /* приватный режим / нет storage */ }
  try { return !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
}

export function createEffects() {
  const FX = {
    reduced: readReducedMotion(),
    trail: [], trailColor: '#ffffff', trailType: null,
    parts: [], callouts: [], banners: [], impact: null,
    shakeAmp: 0, shakeT: 0, hitStop: 0, lagMax: 0, lag: 0, lagPhase: 0, hitGameTime: -1,
    zoom: 1, zoomPunch: 0, matchPoint: false, gamePoint: false, tension: 0,
    view: { shake: { x: 0, y: 0 }, zoom: 1, lag: 0 },
    netHit: null, smallCd: 0, time: 0,
    R: null, game: null, prevZ: new Map(),
  };
  try {
    globalThis.addEventListener && globalThis.addEventListener('volan:settings', e => {
      try { if (e.detail && typeof e.detail.reducedMotion === 'boolean') FX.reduced = e.detail.reducedMotion; } catch (_) { /* */ }
    });
  } catch (_) { /* не браузер */ }

  // ------------------------------------------------------------ события
  FX.attach = function (game, R) {
    FX.R = R; FX.game = game;
    const P = (x, y, z) => R.project(x, y, z);
    const humanTeam = () => (game.human ? game.human.team : 0);

    game.on('hit', e => {
      const sh = game.shuttle;
      const human = e.player.controller === 'human' && !game.aiControlsHuman;
      const type = e.serve ? (e.type === 'serveLong' || e.type === 'serveShort' ? e.type : 'serveShort') : e.type;
      FX.trailType = type; FX.trailColor = SHOT_COLORS[type] || '#ffffff';
      FX.trail.length = 0;
      FX.hitGameTime = game.time;
      const p = P(sh.x, sh.y, sh.z);
      const power = clamp((e.speed - 10) / 40, 0, 1);
      const perfect = e.timing === 'perfect' && !e.serve;
      sparks(p.x, p.y, Math.round(4 + power * 10 + (perfect ? 6 : 0)), perfect ? '#fff3a0' : '#ffffff', 60 + power * 220);
      if (e.type === 'smash' && e.speed > 36) {
        const strong = e.speed > 46 || perfect;
        impact(sh.x, sh.y, sh.z, strong ? 1 : 0.65, FX.trailColor);
        feathers(sh.x, sh.y, sh.z, strong ? 4 : 2);
        const hp = P(e.player.x, e.player.y, 2.9);
        if (human) callout('СМЭШ!', hp.x, hp.y, { color: '#ff5a3c', size: 1.25, burst: true, rot: -0.12 });
        else callout('БАХ!', hp.x, hp.y, { color: '#ffd23f', size: 1.1, burst: true, rot: 0.1 });
        if (R.arena) R.arena.cheer(0.55, { text: strong ? 'СМЭШ!' : null, color: '#ff5a3c', life: 1.6 });
      } else if (perfect && human) {
        callout('Идеально!', p.x, p.y, { color: '#7cf29c', size: 0.8, rot: -0.06, stars: true });
        feathers(sh.x, sh.y, sh.z, 1);
      } else if (!e.serve && (e.type === 'drive' && e.speed > 26 || (e.type === 'clear' && perfect)) && FX.smallCd <= 0) {
        callout('ВЖУХ!', p.x, p.y, { color: '#4fd8ff', size: 0.75, rot: 0.08 });
        FX.smallCd = 1.2;
      } else if (human && !e.serve && e.quality < 0.45) {
        callout(e.timing === 'early' ? 'Рано' : 'Поздно', p.x, p.y, { color: '#ffb4a2', size: 0.55, plain: true });
      }
      if (e.lunge) dust(e.player.x, e.player.y, 0.8, 7);
      if (e.jump) sweat(e.player.x, e.player.y, 2.0 + (e.player.z || 0), 5);
    });
    game.on('whiff', e => {
      if (e.player.controller !== 'human' || game.aiControlsHuman) return;
      const q = P(e.player.x, e.player.y, 1.8);
      callout('Мимо!', q.x, q.y - 20, { color: '#b9c6ff', size: 0.6, plain: true });
    });
    game.on('net', e => {
      FX.netHit = { y: e.y, z: e.z, t: 0, amp: 1 };
      feathers(e.x, e.y, e.z, 1);
    });
    game.on('land', e => {
      FX.lastLand = { x: e.x, y: e.y, in: e.in };
      dust(e.x, e.y, 0.5, 5);
    });
    game.on('point', e => {
      const ht = humanTeam();
      const humanWon = e.winner === ht;
      const lp = FX.lastLand;
      if (e.reason === 'out' && lp) {
        const q = P(lp.x, lp.y, 0.2);
        callout('Аут', q.x, q.y - 16, { color: '#ff6b6b', size: 0.85, rot: -0.08, stamp: true });
      } else if (e.reason === 'net') {
        const q = P(0, FX.netHit ? FX.netHit.y : 0, 1.6);
        callout('Сетка', q.x, q.y - 14, { color: '#ffb84d', size: 0.85, rot: 0.06, stamp: true });
      }
      const long = (e.rallyLength || 0) >= 10;
      const big = long || (e.result && e.result.gameWon);
      const col = humanWon ? '#7cf29c' : '#ff8a80';
      const txt = { in: 'Очко!', out: 'Очко!', net: 'Очко!', serveFault: 'Ошибка подачи' }[e.reason] || 'Очко!';
      banner(txt, FX.teamName ? 'Очко: ' + FX.teamName(e.winner) : null, col, 1.3, true);
      if (R.arena) R.arena.cheer(big ? 1 : 0.65, { jump: big ? 1.6 : 0.8, team: e.winner, text: big ? 'ВОТ ЭТО РОЗЫГРЫШ!' : null, color: '#ffd23f', life: 2.4 });
      if (big) confetti(long ? 70 : 40, humanWon ? ['#ffd23f', '#7cf29c', '#4fd8ff', '#ff5d8f', '#ffffff'] : ['#ff8a80', '#ffd23f', '#ffffff', '#9b7bff']);
      FX.zoomPunch = Math.max(FX.zoomPunch, big ? 0.05 : 0.025);
    });
    game.on('game', e => {
      if (!game.match.over) banner('Гейм!', (FX.teamName ? FX.teamName(e.winner) + ' — ' : '') + e.games.join(':'), '#ffd23f', 2.4, true);
      confetti(110, ['#ffd23f', '#ff5d8f', '#4fd8ff', '#7cf29c', '#ffffff', '#9b7bff']);
      if (R.arena) R.arena.cheer(1, { jump: 2.5, wave: true, text: 'ГЕЙМ!', color: '#ffd23f', life: 3 });
    });
    game.on('matchOver', e => {
      const ht = humanTeam();
      const humanPlays = game.human && !game.aiControlsHuman;
      if (humanPlays) banner(e.winner === ht ? 'ПОБЕДА!' : 'Матч', null, e.winner === ht ? '#ffd23f' : '#c9d2ff', 2.6, true);
      else banner('Матч!', null, '#ffd23f', 2.2, true);
      confetti(150, ['#ffd23f', '#ff5d8f', '#4fd8ff', '#7cf29c', '#ffffff']);
      if (R.arena) R.arena.cheer(1, { jump: 3, wave: true, text: 'МАТЧ!', color: '#ffd23f', life: 4 });
    });
    game.on('sides', () => banner('Смена сторон', null, '#9ad1ff', 1.6, false));
    game.on('serveReady', () => {
      const st = pointState(game.match);
      if (st.match) { callout('МАТЧБОЛ', R.w / 2, R.h * 0.32, { color: '#ff3d6e', size: 1.15, burst: true, center: true, life: 1.6 }); if (R.arena) R.arena.cheer(0.5, { text: 'МАТЧБОЛ', color: '#ff3d6e', life: 3 }); }
      else if (st.game) { callout('Геймбол', R.w / 2, R.h * 0.32, { color: '#ffd23f', size: 0.9, center: true, life: 1.3 }); if (R.arena) R.arena.cheer(0.35, { text: 'ГЕЙМБОЛ', color: '#ffd23f', life: 2.5 }); }
    });
    game.on('serve', () => { FX.trail.length = 0; });
  };

  /** Матчбол/геймбол: следующее очко может закончить гейм/матч. */
  function pointState(m) {
    if (!m || m.over) return { match: false, game: false };
    const { points, cap, games } = m.format;
    const need = Math.ceil(games / 2);
    let g = false, mt = false;
    for (const t of [0, 1]) {
      const a = m.score[t] + 1, b = m.score[1 - t];
      if (a >= cap || (a >= points && a - b >= 2)) { g = true; if (m.games[t] === need - 1) mt = true; }
    }
    return { match: mt, game: g };
  }
  FX.pointState = pointState;

  // ------------------------------------------------------------ спавн
  function cap() { if (FX.parts.length > 260) FX.parts.splice(0, FX.parts.length - 260); }
  function sparks(x, y, n, color, speed) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      FX.parts.push({ k: 'spark', sx: x, sy: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.22 + Math.random() * 0.18, color, w: 1.5 + Math.random() * 1.5 });
    }
    cap();
  }
  function feathers(x, y, z, n) {
    for (let i = 0; i < n; i++) {
      FX.parts.push({ k: 'feather', x, y, z, vx: (Math.random() - 0.5) * 2.2, vy: (Math.random() - 0.5) * 2.2, vz: 0.6 + Math.random() * 1.4, t: 0, life: 1.6 + Math.random() * 0.8, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 8, ph: Math.random() * 6 });
    }
    cap();
  }
  function dust(x, y, size, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 0.4 + Math.random() * 0.9;
      FX.parts.push({ k: 'dust', x, y, z: 0.05, vx: Math.cos(a) * v * size, vy: Math.sin(a) * v * size, vz: 0.25 + Math.random() * 0.4, t: 0, life: 0.45 + Math.random() * 0.3, r: 0.1 + Math.random() * 0.12 * size });
    }
    cap();
  }
  function sweat(x, y, z, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 1 + Math.random() * 1.5;
      FX.parts.push({ k: 'sweat', x, y, z, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 1 + Math.random() * 1.5, t: 0, life: 0.5 + Math.random() * 0.2 });
    }
    cap();
  }
  function confetti(n, colors) {
    const R = FX.R; if (!R) return;
    const nn = FX.reduced ? Math.round(n * 0.3) : n;
    for (let i = 0; i < nn; i++) {
      FX.parts.push({ k: 'conf', sx: Math.random() * R.w, sy: -20 - Math.random() * R.h * 0.5, vx: (Math.random() - 0.5) * 60, vy: 60 + Math.random() * 90, t: 0, life: 3.2 + Math.random() * 1.2, color: colors[i % colors.length], rot: Math.random() * 6, spin: (Math.random() - 0.5) * 12, w: 5 + Math.random() * 5, ph: Math.random() * 6 });
    }
    if (FX.parts.length > 420) FX.parts.splice(0, FX.parts.length - 420);
  }
  function impact(x, y, z, strength, color) {
    FX.impact = { x, y, z, t: 0, life: 0.2, strength, color, seed: Math.random() * 1000 };
    if (!FX.reduced) {
      FX.shakeAmp = Math.max(FX.shakeAmp, 7 * strength); FX.shakeT = 0;
      FX.hitStop = 0.05 + 0.03 * strength;
      FX.lagMax = FX.hitStop; FX.lagPhase = 0;
      FX.zoomPunch = Math.max(FX.zoomPunch, 0.035 * strength);
    }
  }
  function callout(text, x, y, o = {}) {
    const R = FX.R;
    const old = FX.callouts.findIndex(c => c.text === text);
    if (old >= 0) FX.callouts.splice(old, 1);
    // Мелкие реплики не перебивают крупные.
    if (o.plain || o.size < 0.8) { if (FX.callouts.some(c => !c.plain && c.t < 0.5 * c.life)) return; }
    const W = R ? R.w : 400, H = R ? R.h : 800;
    const yMin = (R ? R.hudRect.h : 60) + 40;
    const size = Math.min(W, H, 560) * CALLOUT_K * (o.size || 1);
    const bw = size * text.length * 0.62 + 20, bh = size * 1.25;
    const cx = o.center ? x : clamp(x + (o.plain ? 0 : 26), bw / 2 + 8, W - bw / 2 - 8);
    let cy = clamp(y - (o.plain ? 18 : 44), yMin, H * 0.72);
    // Не налезать на живые надписи: сдвигаем вверх/вниз.
    const hits = yy => FX.callouts.some(c => Math.abs(c.x - cx) < (c.bw + bw) / 2 && Math.abs(c.y - yy) < (c.bh + bh) / 2);
    for (let i = 1; i < 6 && hits(cy); i++) {
      const up = clamp(cy - bh * i * 0.9, yMin, H * 0.72), dn = clamp(cy + bh * i * 0.9, yMin, H * 0.72);
      if (!hits(up)) { cy = up; break; }
      if (!hits(dn)) { cy = dn; break; }
    }
    FX.callouts.push({ text, x: cx, y: cy, bw, bh, t: 0, life: o.life || (o.plain ? 0.8 : 1.0), color: o.color || '#fff', size: o.size || 1, rot: o.rot || 0, burst: !!o.burst, plain: !!o.plain, stamp: !!o.stamp, stars: !!o.stars, center: !!o.center });
    if (FX.callouts.length > 3) FX.callouts.shift();
  }
  function banner(text, sub, color, life, big) {
    FX.banners = FX.banners.filter(b => !(big && b.big) && b.text !== text);
    FX.banners.push({ text, sub, color, t: 0, life, big });
    if (FX.banners.length > 3) FX.banners.splice(0, FX.banners.length - 3);
  }
  FX.callout = callout; FX.banner = banner; FX.confetti = confetti; FX.dust = dust;

  // ------------------------------------------------------------ обновление
  FX.update = function (dt, game) {
    FX.time += dt;
    FX.smallCd = Math.max(0, FX.smallCd - dt);
    // Стоп-кадр: лаг растёт, пока идёт пауза, затем «догоняем» за ~2 длины паузы.
    if (FX.hitStop > 0) {
      FX.hitStop = Math.max(0, FX.hitStop - dt);
      FX.lag = Math.min(FX.lagMax, FX.lag + dt);
    } else if (FX.lag > 0) {
      FX.lag = Math.max(0, FX.lag - dt * 0.6);
    }
    // Тряска.
    if (FX.shakeAmp > 0) {
      FX.shakeT += dt;
      FX.shakeAmp = Math.max(0, FX.shakeAmp - dt * 30);
      const a = FX.shakeAmp;
      FX.view.shake.x = Math.sin(FX.shakeT * 95) * a; FX.view.shake.y = Math.cos(FX.shakeT * 73) * a * 0.8;
    } else { FX.view.shake.x = 0; FX.view.shake.y = 0; }
    // Матчбол: напряжение.
    const st = pointState(game.match);
    const tense = (st.match || st.game) && (game.phase === 'serve' || game.phase === 'rally');
    FX.matchPoint = st.match; FX.gamePoint = st.game;
    FX.tension += ((tense ? (st.match ? 1 : 0.5) : 0) - FX.tension) * Math.min(1, dt * 3);
    FX.zoomPunch = Math.max(0, FX.zoomPunch - dt * 0.12);
    FX.view.zoom = FX.reduced ? 1 : 1 + FX.tension * 0.035 + FX.zoomPunch;
    FX.view.lag = FX.lag;
    // Пыль приземления после прыжка.
    if (game.players) for (const p of game.players) {
      const pz = FX.prevZ.get(p) || 0;
      if (pz > 0.12 && (p.z || 0) <= 0.02) dust(p.x, p.y, 1, 9);
      FX.prevZ.set(p, p.z || 0);
    }
    // Частицы.
    const g = 9.8;
    FX.parts = FX.parts.filter(q => (q.t += dt) < q.life);
    for (const q of FX.parts) {
      if (q.k === 'spark') { q.sx += q.vx * dt; q.sy += q.vy * dt; q.vx *= 0.9; q.vy *= 0.9; }
      else if (q.k === 'feather') {
        q.vz = Math.max(-0.55, q.vz - g * 0.25 * dt); q.vx *= 0.97; q.vy *= 0.97;
        q.x += (q.vx + Math.sin(q.t * 5 + q.ph) * 0.4) * dt; q.y += q.vy * dt; q.z = Math.max(0.01, q.z + q.vz * dt); q.rot += q.spin * dt;
      } else if (q.k === 'dust') { q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; q.vx *= 0.92; q.vy *= 0.92; }
      else if (q.k === 'sweat') { q.vz -= g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.z = Math.max(0, q.z + q.vz * dt); }
      else if (q.k === 'conf') { q.sx += (q.vx + Math.sin(q.t * 3 + q.ph) * 40) * dt; q.sy += q.vy * dt; q.rot += q.spin * dt; }
    }
    if (FX.impact && (FX.impact.t += dt) > FX.impact.life) FX.impact = null;
    if (FX.netHit && (FX.netHit.t += dt) > 1.2) FX.netHit = null;
    FX.callouts = FX.callouts.filter(c => (c.t += dt) < c.life);
    FX.banners = FX.banners.filter(b => (b.t += dt) < b.life);
  };

  /** Смещение сетки при попадании (для отрисовки сетки), м по x. */
  FX.netOffset = function (y, z) {
    const n = FX.netHit; if (!n) return 0;
    const fall = Math.exp(-n.t * 5) * Math.sin(n.t * 26);
    const dy = y - n.y, dz = z - n.z;
    return 0.09 * fall * Math.exp(-(dy * dy) / 0.6 - (dz * dz) / 0.25);
  };

  // ------------------------------------------------------------ след волана
  FX.pushTrail = function (sh) {
    if (sh.state === 'flight') {
      const sp = Math.hypot(sh.vx, sh.vy, sh.vz);
      FX.trail.push({ x: sh.x, y: sh.y, z: sh.z, sp });
      if (FX.trail.length > 26) FX.trail.shift();
    } else if (FX.trail.length) FX.trail.splice(0, 2);
  };

  FX.drawTrail = function (ctx, project, sh) {
    const t = FX.trail;
    if (t.length < 2) return;
    const pts = t.map(q => project(q.x, q.y, q.z));
    // Последняя точка — текущее отрисованное положение (без рывка при стоп-кадре).
    const head = project(sh.x, sh.y, sh.z);
    const n = pts.length;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const col = FX.trailColor;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) {
        const a = pts[i - 1], b = i === n - 1 ? head : pts[i];
        const k = i / n;
        const sp = t[i].sp;
        const fast = clamp(sp / 30, 0.25, 1);
        ctx.globalAlpha = (pass ? 0.8 : 0.55) * k * fast;
        ctx.strokeStyle = pass ? '#ffffff' : col;
        ctx.lineWidth = Math.max(pass ? 1 : 2.5, (pass ? 0.04 : 0.2) * b.s * k * (0.6 + fast * 0.6));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // Линии скорости вдоль полёта (мерцают как в аниме).
    const sp = Math.hypot(sh.vx, sh.vy, sh.vz);
    if (sp > 20 && sh.state === 'flight') {
      const back = project(sh.x - sh.vx * 0.05, sh.y - sh.vy * 0.05, sh.z - sh.vz * 0.05);
      let dx = head.x - back.x, dy = head.y - back.y;
      const len = Math.hypot(dx, dy);
      if (len > 2) {
        dx /= len; dy /= len;
        const nx = -dy, ny = dx;
        const k = clamp((sp - 20) / 30, 0, 1);
        const L = (40 + 120 * k) * (head.s / 40);
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = '#ffffff';
        const seed = Math.floor(FX.time * 30);
        for (let i = 0; i < 9; i++) {
          const r1 = frac(Math.sin((seed + i * 13.7) * 91.3) * 437.5), r2 = frac(Math.sin((seed + i * 7.1) * 51.7) * 237.1);
          const off = (r1 - 0.5) * 0.9 * head.s * 0.5;
          const st = 6 + r2 * 14, ln = L * (0.4 + r2 * 0.6);
          ctx.globalAlpha = (0.25 + 0.45 * k) * (0.5 + r1 * 0.5);
          ctx.lineWidth = 1 + r2 * 1.6 * k;
          const sx = head.x + nx * off - dx * st, sy = head.y + ny * off - dy * st;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx - dx * ln, sy - dy * ln); ctx.stroke();
        }
      }
    }
    ctx.restore();
  };
  function frac(v) { return v - Math.floor(v); }

  // ------------------------------------------------------------ мир
  FX.drawWorld = function (ctx, project) {
    if (!FX.parts.length) return;
    ctx.save();
    for (const q of FX.parts) {
      const k = q.t / q.life;
      if (q.k === 'feather') {
        const p = project(q.x, q.y, q.z);
        const s = Math.max(3, 0.09 * p.s);
        ctx.globalAlpha = 1 - k * k;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(q.rot);
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = INK; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.32, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
        ctx.restore();
      } else if (q.k === 'dust') {
        const p = project(q.x, q.y, q.z);
        const r = Math.max(2, q.r * p.s * (0.6 + k * 1.2));
        ctx.globalAlpha = 0.5 * (1 - k);
        ctx.fillStyle = '#f4ead8';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      } else if (q.k === 'sweat') {
        const p = project(q.x, q.y, q.z);
        const r = Math.max(1.5, 0.03 * p.s);
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#bfefff'; ctx.strokeStyle = INK; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - r * 2.2); ctx.quadraticCurveTo(p.x + r * 1.3, p.y, p.x, p.y + r); ctx.quadraticCurveTo(p.x - r * 1.3, p.y, p.x, p.y - r * 2.2); ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  };

  // ------------------------------------------------------------ экран
  FX.drawScreen = function (ctx, w, h, project) {
    const red = FX.reduced;
    // Матчбол: виньетка и линии напряжения.
    if (FX.tension > 0.02) {
      const pulse = red ? 0.8 : 0.75 + 0.25 * Math.sin(FX.time * 4);
      const a = FX.tension * pulse;
      const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.6);
      vg.addColorStop(0, 'rgba(60,0,30,0)'); vg.addColorStop(1, `rgba(90,0,40,${0.55 * a})`);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
      if (!red) focusLines(ctx, w / 2, h / 2, w, h, Math.hypot(w, h) * 0.42, 40, `rgba(255,255,255,${0.12 * a})`, Math.floor(FX.time * 12));
    }
    // Кадр удара.
    const im = FX.impact;
    if (im) {
      const p = project(im.x, im.y, im.z);
      const k = im.t / im.life;
      ctx.save();
      if (!red && im.t < 0.065) {
        // Манга-кадр: обесцветить → инвертировать → тёплый тон, чёрные концентрированные линии.
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = im.strength > 0.8 ? '#ffd2c2' : '#ffe9c9'; ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
        focusLines(ctx, p.x, p.y, w, h, Math.min(w, h) * 0.1, 70, INK, Math.floor(im.seed + FX.time * 60));
        ctx.fillStyle = '#ff3d3d';
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(8, 0.35 * p.s), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, 0.18 * p.s), 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'lighter';
        const r = (0.6 + k * 2.2) * p.s * im.strength;
        const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(4, r));
        rg.addColorStop(0, `rgba(255,255,255,${0.9 * (1 - k)})`); rg.addColorStop(0.4, hexA(im.color, 0.5 * (1 - k))); rg.addColorStop(1, hexA(im.color, 0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, r), 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        if (!red) focusLines(ctx, p.x, p.y, w, h, Math.min(w, h) * (0.14 + k * 0.2), 48, `rgba(255,255,255,${0.7 * (1 - k)})`, Math.floor(im.seed + FX.time * 40));
        // Ударное кольцо.
        ctx.strokeStyle = hexA('#ffffff', 0.9 * (1 - k)); ctx.lineWidth = 3 * (1 - k) + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, (0.2 + k * 1.3) * p.s, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    // Искры и конфетти (экранные).
    ctx.save();
    ctx.lineCap = 'round';
    for (const q of FX.parts) {
      if (q.k === 'spark') {
        const k = q.t / q.life;
        ctx.globalAlpha = 1 - k;
        ctx.strokeStyle = q.color; ctx.lineWidth = q.w * (1 - k * 0.6);
        ctx.beginPath(); ctx.moveTo(q.sx, q.sy); ctx.lineTo(q.sx - q.vx * 0.05, q.sy - q.vy * 0.05); ctx.stroke();
      } else if (q.k === 'conf') {
        const k = q.t / q.life;
        ctx.globalAlpha = k > 0.8 ? (1 - k) / 0.2 : 1;
        ctx.fillStyle = q.color;
        const sw = q.w * Math.abs(Math.cos(q.t * 6 + q.ph)) + 1, sh = q.w * 0.5;
        ctx.save(); ctx.translate(q.sx, q.sy); ctx.rotate(q.rot);
        ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
        ctx.restore();
      }
    }
    ctx.restore();
    // Ономатопея.
    for (const c of FX.callouts) drawCallout(ctx, c);
    // Баннеры по центру.
    drawBanners(ctx, w, h);
  };

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1).toFixed(3)})`;
  }

  /** Концентрированные линии (集中線): клинья от края экрана к центру. */
  function focusLines(ctx, cx, cy, w, h, r0, n, color, seed) {
    const R = Math.hypot(w, h);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r1 = frac(Math.sin((seed + i) * 12.9898) * 43758.5453);
      const r2 = frac(Math.sin((seed + i) * 78.233) * 12543.123);
      const a = (i + r1 * 0.8) / n * Math.PI * 2;
      const wa = 0.006 + r2 * 0.016;
      const inner = r0 * (1 + r2 * 0.8);
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a - wa) * R, cy + Math.sin(a - wa) * R);
      ctx.lineTo(cx + Math.cos(a + wa) * R, cy + Math.sin(a + wa) * R);
      ctx.closePath();
    }
    ctx.fill();
  }

  /** Звёздный «взрыв» под текстом. */
  function burst(ctx, r, color, spikes, seed) {
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = i / (spikes * 2) * Math.PI * 2;
      const jitter = frac(Math.sin((seed + i) * 33.3) * 999) * 0.25;
      const rr = i % 2 ? r * 0.55 : r * (0.9 + jitter);
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.72) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr * 0.72);
    }
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.stroke();
  }

  function popScale(t, reduced) {
    if (reduced) return 1;
    if (t < 0.16) return 0.3 + 0.7 * easeOutBack(t / 0.16);
    return 1;
  }

  function drawStyledText(ctx, text, size, color, opts = {}) {
    ctx.font = `900 ${Math.round(size)}px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    // Тень-смещение (цветная плашка позади).
    ctx.fillStyle = INK;
    ctx.lineWidth = size * 0.26; ctx.strokeStyle = INK;
    ctx.strokeText(text, size * 0.07, size * 0.09);
    ctx.fillText(text, size * 0.07, size * 0.09);
    // Основная обводка.
    ctx.lineWidth = size * 0.24;
    ctx.strokeText(text, 0, 0);
    // Белый «кант».
    ctx.lineWidth = size * 0.08; ctx.strokeStyle = opts.edge || '#ffffff';
    ctx.strokeText(text, 0, 0);
    // Заливка: светлый верх → цвет (аниме-титр).
    const g = ctx.createLinearGradient(0, -size * 0.5, 0, size * 0.5);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.42, mixHex(color, '#ffffff', 0.35)); g.addColorStop(0.5, color); g.addColorStop(1, mixHex(color, INK, 0.25));
    ctx.fillStyle = g;
    ctx.fillText(text, 0, 0);
  }
  function mixHex(a, b, t) {
    const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16);
    const r = ((A >> 16) & 255) + ((((B >> 16) & 255) - ((A >> 16) & 255)) * t);
    const g = ((A >> 8) & 255) + ((((B >> 8) & 255) - ((A >> 8) & 255)) * t);
    const bl = (A & 255) + (((B & 255) - (A & 255)) * t);
    return `rgb(${r | 0},${g | 0},${bl | 0})`;
  }

  function drawCallout(ctx, c) {
    const red = FX.reduced;
    const k = c.t / c.life;
    const base = Math.min(FX.R ? FX.R.w : 400, FX.R ? FX.R.h : 800, 560) * CALLOUT_K;
    const size = base * c.size;
    const a = k > 0.72 ? (1 - k) / 0.28 : 1;
    const sc = popScale(c.t, red) * (c.stamp && !red && c.t < 0.1 ? 1.6 - c.t * 6 : 1);
    const rise = red ? 0 : -k * 8;
    const jit = !red && c.burst && c.t < 0.22 ? (Math.random() - 0.5) * 4 : 0;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(c.x + jit, c.y + rise + jit);
    ctx.rotate(c.rot);
    ctx.scale(sc, sc);
    if (c.burst) {
      ctx.save();
      ctx.rotate(-c.rot * 0.5 + (red ? 0 : c.t * 0.6));
      ctx.font = `900 ${Math.round(size)}px ${FONT_DISPLAY}`;
      const tw = ctx.measureText(c.text).width;
      burst(ctx, c.center ? Math.max(tw * 0.4, size * 0.8) : Math.max(tw * 0.5, size * 0.85), c.color === '#ffd23f' ? '#ff4b3a' : '#ffd23f', 11, Math.floor(c.x));
      ctx.restore();
    }
    if (c.stars && !red) {
      ctx.fillStyle = '#fff6b0';
      for (let i = 0; i < 4; i++) {
        const ang = i * 1.7 + c.t * 3, rr = size * (1.3 + 0.2 * i);
        star(ctx, Math.cos(ang) * rr, Math.sin(ang) * rr * 0.5, size * 0.16 * (1 - k));
      }
    }
    ctx.transform(1, 0, -0.18, 1, 0, 0);   // курсив-наклон
    if (c.plain) {
      ctx.font = `800 ${Math.round(size)}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.lineWidth = size * 0.22; ctx.strokeStyle = INK; ctx.strokeText(c.text, 0, 0);
      ctx.fillStyle = c.color; ctx.fillText(c.text, 0, 0);
    } else drawStyledText(ctx, c.text, size, c.color);
    ctx.restore();
  }
  function star(ctx, x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, rr = i % 2 ? r * 0.35 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill();
  }

  function drawBanners(ctx, w, h) {
    const R = FX.R;
    const portrait = h > w * 1.05;
    let y = h * (portrait ? 0.2 : 0.22);
    for (const b of FX.banners) {
      const k = b.t / b.life;
      const a = k < 0.1 ? k / 0.1 : k > 0.78 ? (1 - k) / 0.22 : 1;
      const fs = b.big ? Math.min(w * 0.065, portrait ? 26 : 24) : 16;
      // Плашка-полоса через экран (влетает слева).
      const slide = FX.reduced ? 1 : clamp(b.t / 0.18, 0, 1);
      ctx.save();
      ctx.globalAlpha = a;
      if (b.big) {
        const bh = fs * (b.sub ? 1.9 : 1.35);
        const x0 = -w * (1 - easeOut(slide));
        ctx.translate(x0, 0);
        ctx.fillStyle = 'rgba(27,15,58,0.78)';
        ctx.beginPath(); ctx.moveTo(0, y - bh * 0.55); ctx.lineTo(w, y - bh * 0.7); ctx.lineTo(w, y + bh * 0.55); ctx.lineTo(0, y + bh * 0.7); ctx.closePath(); ctx.fill();
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.moveTo(0, y - bh * 0.55); ctx.lineTo(w, y - bh * 0.7); ctx.lineTo(w, y - bh * 0.62); ctx.lineTo(0, y - bh * 0.47); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(0, y + bh * 0.62); ctx.lineTo(w, y + bh * 0.47); ctx.lineTo(w, y + bh * 0.55); ctx.lineTo(0, y + bh * 0.7); ctx.closePath(); ctx.fill();
        ctx.translate(w / 2, y - (b.sub ? fs * 0.22 : 0));
        const sc = FX.reduced ? 1 : 1 + 0.2 * Math.max(0, 1 - b.t / 0.2);
        ctx.scale(sc, sc);
        ctx.transform(1, 0, -0.16, 1, 0, 0);
        drawStyledText(ctx, b.text, fs, b.color);
        if (b.sub) {
          ctx.font = `700 ${Math.round(fs * 0.36)}px ${FONT_DISPLAY}`;
          ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.strokeText(b.sub, 0, fs * 0.78);
          ctx.fillStyle = '#ffffff'; ctx.fillText(b.sub, 0, fs * 0.78);
        }
      } else {
        ctx.translate(w / 2, y);
        ctx.transform(1, 0, -0.16, 1, 0, 0);
        ctx.font = `800 ${fs}px ${FONT_DISPLAY}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.strokeText(b.text, 0, 0);
        ctx.fillStyle = b.color; ctx.fillText(b.text, 0, 0);
      }
      ctx.restore();
      y += b.big ? fs * 2.3 : 26;
    }
    void R;
  }
  function easeOut(t) { return 1 - (1 - t) * (1 - t) * (1 - t); }

  return FX;
}
