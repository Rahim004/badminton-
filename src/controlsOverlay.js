/**
 * controlsOverlay.js — экранные элементы управления поверх корта:
 *   плавающий джойстик (и подсказка, где он появится);
 *   кнопки ударов «Удар», «Клир», «Смэш/Дроп», «Сетка» (режим «Кнопки»),
 *     с подписями на подаче («короткая» / «длинная»), нажатием и вспышкой при контакте;
 *   след свайпа (режим «Свайпы»);
 *   индикатор тайминга на волане: внешнее кольцо сходится к внутреннему —
 *     в момент совпадения жать «Удар» (зелёное — идеальный момент);
 *   компактная легенда клавиш на ПК;
 *   вибрация при контакте (navigator.vibrate, если включена).
 *
 * Только читает состояние игры/ввода. Вызывается из render.js одной строкой.
 *
 * API:
 *   drawControlsOverlay(ctx, input, view)
 *     view: {w, h, game, project(x,y,z)->{x,y,s}, dt}
 */
import { TIMING } from './config.js';
import { t as tl } from './platform/i18n.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ACCENT = '255,210,63';     // жёлтый — основная кнопка
const GOOD = '124,242,156';      // зелёный — идеально
const READY = '120,210,255';     // голубой — нажатие в буфере

const attached = new WeakSet();
const fx = { hits: [], lastHit: null };

function attach(game, input) {
  if (attached.has(game)) return;
  attached.add(game);
  game.on('hit', e => {
    if (!e.player || e.player.controller !== 'human' || game.aiControlsHuman) return;
    fx.hits.push({ age: 0, perfect: e.timing === 'perfect', serve: !!e.serve });
    if (fx.hits.length > 3) fx.hits.shift();
    input.haptic && input.haptic(e.timing === 'perfect' ? [14, 40, 22] : 18);
  });
  game.on('whiff', e => {
    if (!e.player || e.player.controller !== 'human' || game.aiControlsHuman) return;
    fx.hits.push({ age: 0, whiff: true });
    input.haptic && input.haptic(40);
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function drawControlsOverlay(ctx, input, view) {
  if (!input || !input.state || !view) return;
  const { game } = view;
  const dt = view.dt || 1 / 60;
  const st = input.state;
  if (game) attach(game, input);
  for (const h of fx.hits) h.age += dt;
  fx.hits = fx.hits.filter(h => h.age < 0.45);
  const humanPlays = !!(game && game.human && !game.aiControlsHuman && game.phase !== 'idle' && game.phase !== 'over');
  ctx.save();
  if (humanPlays) drawTimingRing(ctx, game, view);
  drawJoystick(ctx, input, view, humanPlays);
  if (humanPlays && input.buttonsVisible && input.buttonsVisible()) drawButtons(ctx, input, game);
  drawGestures(ctx, st);
  if (humanPlays && !st.touchSeen && !isCoarse()) drawLegend(ctx, view, game);
  ctx.restore();
}

let mq = null;
function isCoarse() { try { mq = mq || matchMedia('(pointer: coarse)'); return mq.matches; } catch (_) { return false; } }

// ---------------------------------------------------------------- джойстик
function drawJoystick(ctx, input, view, humanPlays) {
  const st = input.state, j = st.joystick;
  if (j.active) {
    const r = j.radius;
    // База: стеклянный круг + метка направления.
    const g = ctx.createRadialGradient(j.bx, j.by, r * 0.2, j.bx, j.by, r);
    g.addColorStop(0, 'rgba(255,255,255,0.04)'); g.addColorStop(1, 'rgba(255,255,255,0.13)');
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(j.bx, j.by, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Мёртвая зона.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(j.bx, j.by, r * 0.14, 0, Math.PI * 2); ctx.stroke();
    const dx = j.kx - j.bx, dy = j.ky - j.by;
    const d = Math.hypot(dx, dy);
    if (d > r * 0.14) {
      const a = Math.atan2(dy, dx);
      ctx.strokeStyle = `rgba(${ACCENT},${0.35 + 0.5 * (j.mag || 0)})`; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(j.bx, j.by, r - 3, a - 0.45, a + 0.45); ctx.stroke();
    }
    // Ручка.
    const kr = r * 0.42;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(j.kx, j.ky + 2, kr, 0, Math.PI * 2); ctx.fill();
    const kg = ctx.createLinearGradient(j.kx, j.ky - kr, j.kx, j.ky + kr);
    kg.addColorStop(0, 'rgba(255,255,255,0.85)'); kg.addColorStop(1, 'rgba(225,232,245,0.6)');
    ctx.fillStyle = kg;
    ctx.beginPath(); ctx.arc(j.kx, j.ky, kr, 0, Math.PI * 2); ctx.fill();
    return;
  }
  if (!humanPlays || !(st.touchSeen || isCoarse())) return;
  // Подсказка: где появится джойстик (появляется там, где коснулся палец).
  const L = input.layout;
  const r = Math.max(40, Math.min(58, Math.min(view.w, view.h) * 0.13));
  const bx = L.joySide === 'left' ? r + 28 : view.w - r - 28;
  const by = view.h - r - (view.h > view.w ? 64 : 26);
  ctx.setLineDash([5, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  ctx.beginPath(); ctx.arc(bx, by, r * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `600 11px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(tl('бег'), bx, by + r + 6);
}

// ---------------------------------------------------------------- кнопки
function drawButtons(ctx, input, game) {
  const L = input.layout;
  const now = performance.now();
  const h = game.human;
  const serving = game.phase === 'serve' && game.serveInfo && game.serveInfo.serverTeam === h.team && game.serveInfo.serverIdx === h.idx;
  const armed = !!game.pendingShot && game.phase === 'rally';
  const reach = game.humanReach;
  const ready = !!reach && reach.t - (game.time - reach.at) <= TIMING.WINDUP + 0.08;
  const lastHit = fx.hits[fx.hits.length - 1];
  for (const b of L.buttons) {
    const pr = input.state.pressed[b.id];
    const since = pr ? (now - pr.t) / 1000 : 9;
    const down = pr && (pr.held || since < 0.12);
    const k = down ? 0.93 : 1;
    const r = b.r * k;
    const alpha = serving && b.id === 'smashdrop' ? 0.55 : 1;
    ctx.globalAlpha = alpha;
    // Тень.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.arc(b.x, b.y + 3, r, 0, Math.PI * 2); ctx.fill();
    // Стеклянная заливка.
    const g = ctx.createLinearGradient(b.x, b.y - r, b.x, b.y + r);
    if (b.main) {
      g.addColorStop(0, down ? 'rgba(255,214,80,0.62)' : 'rgba(255,214,80,0.30)');
      g.addColorStop(1, down ? 'rgba(200,140,20,0.62)' : 'rgba(120,80,10,0.32)');
    } else {
      g.addColorStop(0, down ? 'rgba(255,255,255,0.42)' : 'rgba(30,44,70,0.46)');
      g.addColorStop(1, down ? 'rgba(200,215,240,0.32)' : 'rgba(8,14,26,0.52)');
    }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2); ctx.fill();
    // Обводка.
    ctx.lineWidth = b.main ? 2.5 : 1.5;
    ctx.strokeStyle = b.main ? `rgba(${ACCENT},${down ? 0.95 : 0.75})` : `rgba(255,255,255,${down ? 0.7 : 0.3})`;
    ctx.stroke();
    // Блик сверху.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(b.x, b.y, r - 3, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    // Основная кнопка: волан в досягаемости — пульс; нажатие в буфере — голубое кольцо.
    if (b.main && ready && !armed) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 70);
      ctx.strokeStyle = `rgba(${GOOD},${0.45 + 0.4 * pulse})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 5 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
    }
    if (armed && pr && since < 0.8) {
      ctx.strokeStyle = `rgba(${READY},0.85)`; ctx.lineWidth = 3;
      ctx.setLineDash([6, 5]); ctx.lineDashOffset = -now / 30;
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    // Вспышка контакта на последней нажатой кнопке.
    if (lastHit && pr && pr.t >= now - 1200 && isLatestPressed(input.state.pressed, b.id)) {
      const q = lastHit.age / 0.45;
      const col = lastHit.whiff ? '255,140,120' : lastHit.perfect ? GOOD : '255,255,255';
      ctx.strokeStyle = `rgba(${col},${0.9 * (1 - q)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, r + 4 + q * 18, 0, Math.PI * 2); ctx.stroke();
    }
    // Иконка + подпись.
    const fs = Math.round(Math.max(11, Math.min(17, r * (b.main ? 0.36 : 0.4))));
    const sub = serving && b.id !== 'smashdrop' ? b.serve : null;
    const twoLine = !!b.label2 && !serving;
    const iconY = b.y - r * (b.main ? 0.28 : 0.3);
    drawGlyph(ctx, b.id, b.x, iconY, r * (b.main ? 0.22 : 0.24));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = `800 ${fs}px ${FONT}`;
    const ly = b.y + r * (b.main ? 0.16 : 0.2);
    if (twoLine) {
      ctx.font = `800 ${Math.round(fs * 0.86)}px ${FONT}`;
      ctx.fillText(tl(b.label) + '/', b.x, ly - fs * 0.38);
      ctx.fillText(tl(b.label2), b.x, ly + fs * 0.5);
    } else {
      ctx.fillText(tl(b.label), b.x, ly);
      if (sub) {
        ctx.font = `600 ${Math.max(9, Math.round(fs * 0.66))}px ${FONT}`;
        ctx.fillStyle = `rgba(${ACCENT},0.95)`;
        ctx.fillText(tl(sub), b.x, ly + fs * 0.95);
      }
    }
    ctx.globalAlpha = 1;
  }
  // Ряби касаний.
  for (const rp of input.state.ripples) {
    const q = rp.age / 0.5;
    ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - q)})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(rp.x, rp.y, rp.r * (rp.kind === 'tap' ? 1 + q * 1.6 : 1 + q * 0.35), 0, Math.PI * 2); ctx.stroke();
  }
}

function isLatestPressed(pressed, id) {
  let best = null, bt = -1;
  for (const k in pressed) if (pressed[k].t > bt) { bt = pressed[k].t; best = k; }
  return best === id;
}

/** Мини-иконки траекторий ударов. */
function drawGlyph(ctx, id, x, y, s) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = Math.max(1.6, s * 0.22); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (id === 'smart') {
    // ракетка
    ctx.ellipse(x - s * 0.15, y - s * 0.15, s * 0.62, s * 0.78, -0.6, 0, Math.PI * 2);
    ctx.moveTo(x + s * 0.3, y + s * 0.45); ctx.lineTo(x + s * 0.95, y + s * 1.05);
    ctx.stroke();
  } else if (id === 'clear') {
    // высокая дуга назад
    ctx.moveTo(x - s, y + s * 0.6); ctx.quadraticCurveTo(x, y - s * 1.5, x + s, y + s * 0.6); ctx.stroke();
    arrowHead(ctx, x + s, y + s * 0.6, 1.15, s);
  } else if (id === 'smashdrop') {
    // крутой удар вниз
    ctx.moveTo(x - s, y - s * 0.8); ctx.lineTo(x + s * 0.8, y + s * 0.7); ctx.stroke();
    arrowHead(ctx, x + s * 0.8, y + s * 0.7, Math.atan2(1.5, 1.8), s);
  } else if (id === 'net') {
    // короткая подставка через сетку
    ctx.moveTo(x - s, y + s * 0.6); ctx.quadraticCurveTo(x - s * 0.1, y - s * 0.7, x + s * 0.7, y + s * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.moveTo(x - s * 0.1, y + s * 0.05); ctx.lineTo(x - s * 0.1, y + s * 0.9); ctx.stroke();
  }
  ctx.restore();
}
function arrowHead(ctx, x, y, a, s) {
  const l = s * 0.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(a - 0.5) * l, y - Math.sin(a - 0.5) * l);
  ctx.lineTo(x - Math.cos(a + 0.5) * l, y - Math.sin(a + 0.5) * l);
  ctx.closePath(); ctx.fill();
}

// ---------------------------------------------------------------- индикатор тайминга
function drawTimingRing(ctx, game, view) {
  const reach = game.humanReach;
  const sh = game.shuttle;
  if (!reach || game.phase !== 'rally' || sh.state !== 'flight' || !view.project) return;
  const tLeft = reach.t - (game.time - reach.at);   // до контакта, с
  const toPress = tLeft - TIMING.WINDUP;             // до идеального нажатия
  if (tLeft < 0 || toPress > 0.55) return;
  const p = view.project(sh.x, sh.y, sh.z);
  const r0 = Math.max(12, Math.min(22, 0.24 * p.s));
  const perfect = Math.abs(toPress) <= TIMING.PERFECT_WINDOW;
  const armed = reach.armed;
  const appear = Math.min(1, (0.55 - toPress) / 0.12);
  const col = armed ? READY : perfect ? GOOD : toPress < 0 ? '255,170,120' : '255,255,255';
  // Внутреннее кольцо — «цель».
  ctx.globalAlpha = appear;
  ctx.strokeStyle = `rgba(${col},${perfect ? 0.95 : 0.55})`; ctx.lineWidth = perfect ? 3 : 2;
  ctx.beginPath(); ctx.arc(p.x, p.y, r0, 0, Math.PI * 2); ctx.stroke();
  if (perfect) {
    ctx.fillStyle = `rgba(${GOOD},0.18)`;
    ctx.beginPath(); ctx.arc(p.x, p.y, r0, 0, Math.PI * 2); ctx.fill();
  }
  // Сходящееся кольцо.
  if (toPress > 0) {
    const R = r0 + toPress * 110;
    ctx.strokeStyle = `rgba(${col},${0.35 + 0.5 * (1 - toPress / 0.55)})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- свайпы и легенда
function drawGestures(ctx, st) {
  for (const g of st.gestures) {
    const k = 1 - g.age / 0.35;
    if (k <= 0) continue;
    ctx.strokeStyle = `rgba(${ACCENT},${0.7 * k})`; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x1, g.y1); ctx.stroke();
    ctx.fillStyle = `rgba(${ACCENT},${0.5 * k})`;
    ctx.beginPath(); ctx.arc(g.x1, g.y1, 10 + 14 * (1 - k), 0, Math.PI * 2); ctx.fill();
  }
}

const LEGEND = [
  ['WASD / ← ↑ → ↓', 'бег'],
  ['Пробел / Shift', 'удар'],
  ['J / Z', 'клир'],
  ['K / X', 'смэш/дроп'],
  ['L / C', 'сетка'],
  ['Esc', 'пауза'],
];
function drawLegend(ctx, view, game) {
  const quiet = game.phase === 'rally';
  const fs = 11, lh = 16, pad = 9;
  ctx.font = `600 ${fs}px ${FONT}`;
  let kw = 0, vw = 0;
  for (const [k, v] of LEGEND) { kw = Math.max(kw, ctx.measureText(tl(k)).width); vw = Math.max(vw, ctx.measureText(tl(v)).width); }
  const w = pad * 2 + kw + 10 + vw, h = pad * 2 + LEGEND.length * lh - 4;
  const x = 12, y = view.h - h - 12;
  ctx.globalAlpha = quiet ? 0.45 : 0.9;
  ctx.fillStyle = 'rgba(8,14,26,0.62)';
  roundRect(ctx, x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.textBaseline = 'middle';
  LEGEND.forEach(([k, v], i) => {
    const yy = y + pad + i * lh + 5;
    ctx.textAlign = 'right'; ctx.fillStyle = `rgba(${ACCENT},0.95)`;
    ctx.fillText(tl(k), x + pad + kw, yy);
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(tl(v), x + pad + kw + 10, yy);
  });
  ctx.globalAlpha = 1;
}
