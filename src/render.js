/**
 * render.js — 2.5D-отрисовка (canvas 2D, настоящая перспективная проекция) в стиле аниме-спортсериала.
 *
 * Камера всегда ставит команду человека «ближе к зрителю»:
 *   портрет  — камера за задней линией человека (корт вдоль экрана);
 *   альбом   — камера сбоку (человек слева, соперник справа).
 * Поверх базовой камеры — плавный «вид» (масштаб + сдвиг экрана): отъезд, чтобы высокий
 * волан оставался в кадре, наезд на матчболе, тряска на смэше. Это равномерное
 * масштабирование экрана, поэтому направления (screenDirToWorld) не меняются.
 *
 * Модуль только ЧИТАЕТ состояние игры и подписывается на события.
 *   render/arena.js    — зал: трибуны, зрители, борта, корт, свет;
 *   render/effects.js  — аниме-эффекты (кадры удара, линии скорости, ономатопея, частицы);
 *   render/character.js — персонажи.
 *
 * Публичный API (не менять сигнатуры):
 *   createRenderer(canvas) -> Renderer
 *   renderer.attach(game)                 — подписка на события игры
 *   renderer.resize(cssW, cssH, dpr)
 *   renderer.render(game, input?, dtFrame) — кадр
 *   renderer.screenDirToWorld(sx, sy) -> {x, y}  экранное направление (x вправо, y вверх) → мировое на полу
 *   renderer.project(x, y, z) -> {x, y, s, d}    s — пикселей на метр, d — глубина
 *   renderer.camera                       — {orientation, humanSide, ...}
 *   renderer.hudRect                      — {x,y,w,h} область табло (для UI)
 */
import { COURT } from './config.js';
import { predictLanding } from './physics.js';
import { createCharacters } from './render/character.js';
import { createArena, FONT_DISPLAY } from './render/arena.js';
import { createEffects } from './render/effects.js';
import { drawControlsOverlay } from './controlsOverlay.js';

const C = {
  netMesh: 'rgba(240,244,255,0.42)', netTape: '#ffffff', post: '#e9ecf6', postDark: '#8d93b5',
  hudInk: 'rgba(27,15,58,0.86)', hudText: '#ffffff', hudDim: 'rgba(255,255,255,0.62)',
};

function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Минимальный масштаб «отъезда» (чтобы видеть высокий волан). */
const K_MIN = { portrait: 0.86, landscape: 0.8 };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const R = {
    canvas, ctx, w: 1, h: 1, dpr: 1,
    camera: { orientation: 'portrait', humanSide: -1, eye: [0, 0, 0], r: [1, 0, 0], u: [0, 0, 1], f: [0, 1, 0], F: 1, ox: 0, oy: 0 },
    hudRect: { x: 0, y: 0, w: 0, h: 0 },
    view: { k: 1, tx: 0, ty: 0, dpr: 1, kHigh: 1 },
    landMarks: [],    // {x,y,t,in}
    game: null,
    time: 0,
  };
  const arena = createArena();
  const fx = createEffects();
  R.arena = arena; R.fx = fx;

  function setupCamera(humanSide) {
    const cam = R.camera;
    const portrait = R.h > R.w * 1.05;
    cam.orientation = portrait ? 'portrait' : 'landscape';
    cam.humanSide = humanSide;
    const s = humanSide;
    let eye, target;
    if (portrait) { eye = [s * 12.8, 0, 12.5]; target = [s * 0.4, 0, 0.3]; }
    else { eye = [s * 2.2, s * 13.5, 8.2]; target = [s * 0.3, 0, 0.5]; }
    const f = v3norm(v3sub(target, eye));
    const r = v3norm(v3cross(f, [0, 0, 1]));
    const u = v3cross(r, f);
    Object.assign(cam, { eye, f, r, u, F: 1, ox: 0, oy: 0 });
    // Подгонка масштаба: корт + сетка + головы игроков у задних линий.
    const pts = [];
    const L = COURT.HALF_LENGTH + 0.9, W = COURT.HALF_WIDTH_DOUBLES + 0.45;
    for (const x of [-L, L]) for (const y of [-W, W]) { pts.push([x, y, 0]); }
    pts.push([-L, 0, 2.1], [L, 0, 2.1], [0, -W, 1.7], [0, W, 1.7]);
    if (portrait) pts.push([-s * L, 0, 3.2]); // место над соперником для высоких воланов
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const d = v3sub(p, eye);
      const cz = v3dot(d, f);
      const sx = v3dot(d, r) / cz, sy = -v3dot(d, u) / cz;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    const hudH = portrait ? 74 : 56;
    const padX = 14, padTop = hudH + 8, padBot = portrait ? 18 : 10;
    const availW = R.w - padX * 2, availH = R.h - padTop - padBot;
    const F = Math.min(availW / (maxX - minX), availH / (maxY - minY));
    cam.F = F;
    cam.ox = padX + (availW - (maxX - minX) * F) / 2 - minX * F;
    cam.oy = padTop + (availH - (maxY - minY) * F) / 2 - minY * F;
    R.hudRect = { x: 0, y: 0, w: R.w, h: hudH };
    // Якоря вида: центр сетки (наезд) и ближняя кромка корта (отъезд к высокому волану).
    const nearEdge = portrait ? baseProject(s * COURT.HALF_LENGTH, 0, 0) : baseProject(0, s * COURT.HALF_WIDTH_DOUBLES, 0);
    R.anchor = { x: R.w / 2, yNet: baseProject(0, 0, 1).y, yLow: Math.min(R.h - 10, nearEdge.y) };
    const kmin = K_MIN[cam.orientation];
    arena.build({
      w: R.w, h: R.h, dpr: R.dpr, cam, humanSide: s, portrait,
      margin: { x: Math.ceil(R.w / 2 * (1 / kmin - 1)) + 14, y: Math.ceil(R.anchor.yLow * (1 / kmin - 1)) + 14 },
    });
  }

  /** Проекция базовой камеры (без «вида»). */
  function baseProject(x, y, z) {
    const cam = R.camera, e = cam.eye, f = cam.f, r = cam.r, u = cam.u;
    const dx = x - e[0], dy = y - e[1], dz = z - e[2];
    const cz = Math.max(0.1, dx * f[0] + dy * f[1] + dz * f[2]);
    return { x: cam.ox + cam.F * (dx * r[0] + dy * r[1] + dz * r[2]) / cz, y: cam.oy - cam.F * (dx * u[0] + dy * u[1] + dz * u[2]) / cz, s: cam.F / cz, d: cz };
  }

  function project(x, y, z) {
    const cam = R.camera, e = cam.eye, f = cam.f, r = cam.r, u = cam.u, V = R.view;
    const dx = x - e[0], dy = y - e[1], dz = z - e[2];
    const cz = Math.max(0.1, dx * f[0] + dy * f[1] + dz * f[2]);
    const F = cam.F * V.k;
    return { x: cam.ox * V.k + V.tx + F * (dx * r[0] + dy * r[1] + dz * r[2]) / cz, y: cam.oy * V.k + V.ty - F * (dx * u[0] + dy * u[1] + dz * u[2]) / cz, s: F / cz, d: cz };
  }
  R.project = project;

  /** Экранное направление (x вправо, y вверх) → мировое направление на полу. */
  R.screenDirToWorld = function (sx, sy) {
    const cam = R.camera;
    // Правый вектор камеры и «вперёд по полу».
    const rx = cam.r[0], ry = cam.r[1];
    let fx_ = cam.f[0], fy = cam.f[1];
    const fl = Math.hypot(fx_, fy) || 1; fx_ /= fl; fy /= fl;
    return { x: rx * sx + fx_ * sy, y: ry * sx + fy * sy };
  };

  R.resize = function (cssW, cssH, dpr) {
    R.w = cssW; R.h = cssH; R.dpr = dpr;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    R.view.dpr = dpr;
    setupCamera(R.camera.humanSide);
  };

  R.attach = function (game) {
    R.game = game;
    fx.teamName = t => teamName(game, t);
    game.on('hit', e => { chars.onHit(e, game); });
    game.on('land', e => { R.landMarks.push({ x: e.x, y: e.y, t: 0, in: e.in }); if (R.landMarks.length > 3) R.landMarks.shift(); });
    fx.attach(game, R);
  };

  function teamName(game, team) {
    const ps = game.players.filter(p => p.team === team);
    const hasHuman = ps.some(p => p.controller === 'human');
    if (hasHuman) return game.cfg.mode === 'doubles' ? 'Ваша пара' : 'Вы';
    return ps.map(p => p.name.split(' ')[0]).join(' и ');
  }

  // ---------------------------------------------------------------- вид (камера поверх базы)
  function updateView(game, dt) {
    const V = R.view, cam = R.camera, A = R.anchor;
    const kmin = K_MIN[cam.orientation];
    // Отъезд к высокому волану.
    const sh = game.shuttle;
    let kHighT = 1;
    if (sh && sh.state === 'flight' && game.phase === 'rally') {
      const b = baseProject(sh.x, sh.y, sh.z + 0.35);
      const target = R.hudRect.h + 30;
      if (b.y < target) kHighT = clamp((A.yLow - target) / Math.max(1, A.yLow - b.y), kmin, 1);
    }
    const rate = kHighT < V.kHigh ? 7 : 1.6;
    V.kHigh += (kHighT - V.kHigh) * Math.min(1, dt * rate);
    const kFx = fx.view.zoom;
    // Композиция: сначала наезд вокруг сетки, затем отъезд вокруг нижней кромки.
    const k = V.kHigh * kFx;
    const ax = A.x;
    // screen = Alow + (Anet + (b − Anet)·kFx − Alow)·kHigh
    const t1x = ax * (1 - kFx), t1y = A.yNet * (1 - kFx);
    V.k = k;
    V.tx = ax + (t1x - ax) * V.kHigh + fx.view.shake.x;
    V.ty = A.yLow + (t1y - A.yLow) * V.kHigh + fx.view.shake.y;
  }

  // ---------------------------------------------------------------- сцена
  function poly(pts, fill) {
    ctx.beginPath();
    pts.forEach((p, i) => { const q = project(p[0], p[1], p[2] || 0); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }

  function drawFloorDynamic(game, dt) {
    // Подсветка зоны приёма во время подачи.
    if (game.phase === 'serve' && game.serveInfo) {
      const s = game.serveInfo; const box = serviceBoxWorld(game, s);
      const pts = [[box.xMin, box.yMin], [box.xMax, box.yMin], [box.xMax, box.yMax], [box.xMin, box.yMax]];
      ctx.globalAlpha = 0.2 + 0.08 * Math.sin(R.time * 5);
      poly(pts, '#fff1a8');
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#fff1a8'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); ctx.lineDashOffset = -R.time * 20;
      ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      ctx.globalAlpha = 1;
    }
    // Метки приземления.
    R.landMarks = R.landMarks.filter(m => (m.t += dt) < 1.6);
    for (const m of R.landMarks) {
      const p = project(m.x, m.y, 0);
      const a = 1 - m.t / 1.6;
      const rr = 0.25 + 0.15 * Math.min(1, m.t * 4);
      ctx.strokeStyle = m.in ? `rgba(124,242,156,${a})` : `rgba(255,107,107,${a})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rr * p.s, rr * p.s * Math.abs(R.camera.f[2]) * 1.2 + 2, 0, 0, Math.PI * 2); ctx.stroke();
      if (!m.in) {   // крестик «аут»
        const d = 0.14 * p.s;
        ctx.beginPath(); ctx.moveTo(p.x - d, p.y - d * 0.5); ctx.lineTo(p.x + d, p.y + d * 0.5); ctx.moveTo(p.x + d, p.y - d * 0.5); ctx.lineTo(p.x - d, p.y + d * 0.5); ctx.stroke();
      }
    }
    // Подсказка приземления для человека (помощник).
    const sh = game.shuttle;
    if (game.cfg.assist && game.human && sh.state === 'flight' && sh.lastHitTeam !== game.human.team) {
      const L = predictLanding(sh);
      if (!L.netHit && Math.sign(L.x) === game.human.side) {
        const p = project(L.x, L.y, 0);
        ctx.strokeStyle = 'rgba(255,241,168,0.7)'; ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.22 * p.s, 0.22 * p.s * 0.45 + 1, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function serviceBoxWorld(game, s) {
    const r = s.receiverSide;
    const long = game.match.mode === 'doubles' ? COURT.DOUBLES_LONG_SERVICE : COURT.HALF_LENGTH;
    const hw = game.match.mode === 'doubles' ? COURT.HALF_WIDTH_DOUBLES : COURT.HALF_WIDTH_SINGLES;
    const ySign = s.court === 'right' ? r : -r;
    const xs = [r * COURT.SHORT_SERVICE, r * long], ys = [0, ySign * hw];
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
  }

  function drawNet() {
    const W = COURT.NET_POST_Y, H = COURT.NET_HEIGHT, B = H - 0.76;
    const wob = !!fx.netHit;
    const off = (y, z) => (wob ? fx.netOffset(y, z) : 0);
    // Полотно (затемнение за ячейками).
    poly([[0, -W, B], [0, W, B], [0, W, H], [0, -W, H]], 'rgba(16,12,40,0.30)');
    ctx.strokeStyle = C.netMesh; ctx.lineWidth = 0.8;
    ctx.beginPath();
    const zm = (B + H) / 2;
    for (let y = -W; y <= W + 1e-6; y += 0.1) {
      const a = project(off(y, B), y, B), m = project(off(y, zm), y, zm), b = project(off(y, H), y, H);
      ctx.moveTo(a.x, a.y); ctx.lineTo(m.x, m.y); ctx.lineTo(b.x, b.y);
    }
    for (let z = B; z <= H - 0.04; z += 0.08) {
      if (wob) {
        for (let i = 0; i <= 16; i++) { const y = -W + 2 * W * i / 16; const q = project(off(y, z), y, z); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
      } else {
        const a = project(0, -W, z), b = project(0, W, z);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
    // Лента сверху (белая полоса с толщиной) и нижний шнур.
    ctx.beginPath();
    for (let i = 0; i <= 16; i++) { const y = -W + 2 * W * i / 16; const q = project(off(y, H), y, H); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
    for (let i = 16; i >= 0; i--) { const y = -W + 2 * W * i / 16; const q = project(off(y, H - 0.075), y, H - 0.075); ctx.lineTo(q.x, q.y); }
    ctx.closePath(); ctx.fillStyle = C.netTape; ctx.fill();
    ctx.strokeStyle = 'rgba(27,15,58,0.55)'; ctx.lineWidth = 1; ctx.stroke();
    const b0 = project(0, -W, B), b1 = project(0, W, B);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y); ctx.stroke();
    // Стойки с утяжелённым основанием.
    ctx.lineCap = 'round';
    for (const y of [-W - 0.02, W + 0.02]) {
      const p0 = project(0, y, 0), p1 = project(0, y, H + 0.04);
      const base = project(0, y, 0.02);
      ctx.fillStyle = '#2b2860';
      ctx.beginPath(); ctx.ellipse(base.x, base.y, 0.22 * base.s, 0.09 * base.s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.postDark; ctx.lineWidth = Math.max(3, 0.07 * p0.s);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      ctx.strokeStyle = C.post; ctx.lineWidth = Math.max(1.5, 0.035 * p0.s);
      ctx.beginPath(); ctx.moveTo(p0.x - 0.012 * p0.s, p0.y); ctx.lineTo(p1.x - 0.012 * p1.s, p1.y); ctx.stroke();
      ctx.fillStyle = '#ff3d6e';
      ctx.beginPath(); ctx.arc(p1.x, p1.y, Math.max(2, 0.045 * p1.s), 0, Math.PI * 2); ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  function shadowAt(x, y, rx, alpha) {
    const p = project(x, y, 0);
    const q = project(x + rx, y, 0), q2 = project(x, y + rx, 0);
    const ax = Math.max(Math.abs(q.x - p.x), Math.abs(q2.x - p.x), 2);
    const ay = Math.max(Math.abs(q.y - p.y), Math.abs(q2.y - p.y), 1.2);
    ctx.fillStyle = `rgba(6,30,24,${alpha})`;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, ax, ay, 0, 0, Math.PI * 2); ctx.fill();
  }

  // ---------------------------------------------------------------- игрок
  // Персонажи (скелет, анимация, отрисовка) — в render/character.js.
  const chars = createCharacters(ctx, project, R.camera);
  R.characters = chars; // для тестов/отладки

  // ---------------------------------------------------------------- волан
  function drawShuttle(sh) {
    if (sh.state === 'held' && R.game && R.game.phase !== 'serve') return;
    const sp = Math.hypot(sh.vx, sh.vy, sh.vz);
    // Направление «головкой вперёд»: по скорости; на земле — лежит.
    let dx = 1, dy = 0, dz = 0;
    if (sp > 0.3) { dx = sh.vx / sp; dy = sh.vy / sp; dz = sh.vz / sp; }
    else if (sh.state === 'held') { dx = 0; dy = 0; dz = -1; }
    const L = 0.12; // визуально крупнее настоящего (7 см), чтобы было видно на телефоне
    const head = project(sh.x, sh.y, Math.max(0.02, sh.z));
    const tail = project(sh.x - dx * L, sh.y - dy * L, Math.max(0.02, sh.z - dz * L));
    const sc = head.s;
    const ang = Math.atan2(tail.y - head.y, tail.x - head.x);
    const len = Math.max(5, Math.hypot(tail.x - head.x, tail.y - head.y));
    const minScale = Math.max(1, 0.045 * sc / 3);
    const wid = Math.max(4, 0.055 * sc) * minScale;
    // Свечение быстрого волана (цвет удара).
    if (sh.state === 'flight' && sp > 14) {
      const a = clamp((sp - 14) / 30, 0, 1) * 0.55;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, wid * 3.2);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(head.x, head.y, wid * 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(ang);
    // Юбка из перьев (усечённый конус) с контуром (cel).
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1b0f3a'; ctx.lineWidth = 1.1; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(1, -wid * 0.35); ctx.lineTo(len * 1.5, -wid); ctx.lineTo(len * 1.5, wid); ctx.lineTo(1, wid * 0.35);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(110,120,160,0.85)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(len * 0.6, -wid * 0.7); ctx.lineTo(len * 0.6, wid * 0.7);
    ctx.moveTo(1, 0); ctx.lineTo(len * 1.5, 0);
    ctx.stroke();
    // Пробковая головка с цветным ободком.
    ctx.fillStyle = '#efd9b4'; ctx.strokeStyle = '#1b0f3a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, wid * 0.55, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = fx.trailColor || '#ff3d6e';
    ctx.fillRect(wid * 0.25, -wid * 0.5, wid * 0.18, wid);
    ctx.restore();
  }

  // ---------------------------------------------------------------- HUD (аниме-трансляция)
  function drawHUD(game) {
    const m = game.match; if (!m) return;
    const portrait = R.camera.orientation === 'portrait';
    const humanTeam = game.human ? game.human.team : 0;
    const teams = [humanTeam, 1 - humanTeam];
    // Справа оставляем место под кнопку паузы (44px + отступы).
    const cw = Math.min(R.w - 12 - 66, 460), ch = portrait ? 56 : 44;
    const x0 = Math.max(12, Math.min((R.w - cw) / 2, R.w - 66 - cw)), y0 = portrait ? 10 : 6;
    const mid = x0 + cw / 2;
    const sk = ch * 0.32;   // скос
    // Подложка: тёмная параллелограмм-плашка.
    ctx.fillStyle = C.hudInk;
    ctx.beginPath(); ctx.moveTo(x0 + sk, y0); ctx.lineTo(x0 + cw, y0); ctx.lineTo(x0 + cw - sk, y0 + ch); ctx.lineTo(x0, y0 + ch); ctx.closePath(); ctx.fill();
    // Центр счёта — светлый блок.
    const sw = Math.min(cw * 0.36, portrait ? 126 : 132);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(mid - sw / 2 + sk * 0.6, y0 + 4); ctx.lineTo(mid + sw / 2 + sk * 0.6, y0 + 4); ctx.lineTo(mid + sw / 2 - sk * 0.6, y0 + ch - 4); ctx.lineTo(mid - sw / 2 - sk * 0.6, y0 + ch - 4); ctx.closePath(); ctx.fill();
    const colors = teams.map(t => { const p = game.players.find(q => q.team === t); return (p && p.color) || '#fff'; });
    // Цветные полосы команд на краях плашки.
    ctx.fillStyle = colors[0];
    ctx.beginPath(); ctx.moveTo(x0 + sk, y0); ctx.lineTo(x0 + sk + 7, y0); ctx.lineTo(x0 + 7, y0 + ch); ctx.lineTo(x0, y0 + ch); ctx.closePath(); ctx.fill();
    ctx.fillStyle = colors[1];
    ctx.beginPath(); ctx.moveTo(x0 + cw - 7, y0); ctx.lineTo(x0 + cw, y0); ctx.lineTo(x0 + cw - sk, y0 + ch); ctx.lineTo(x0 + cw - sk - 7, y0 + ch); ctx.closePath(); ctx.fill();
    ctx.textBaseline = 'middle';
    const fs = portrait ? 27 : 23;
    ctx.font = `900 ${fs}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1b0f3a';
    ctx.textAlign = 'right';
    ctx.fillText(String(m.score[teams[0]]), mid - 10, y0 + ch / 2 + 1);
    ctx.textAlign = 'left';
    ctx.fillText(String(m.score[teams[1]]), mid + 10, y0 + ch / 2 + 1);
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(27,15,58,0.45)';
    ctx.fillRect(mid - 1.5, y0 + ch * 0.3, 3, ch * 0.4);
    // Имена + индикатор подачи.
    const nfs = portrait ? 12 : 11;
    const names = teams.map(t => teamName(game, t));
    const sideW = (cw - sw) / 2 - sk - 10;
    for (let i = 0; i < 2; i++) {
      const left = i === 0;
      const tx = left ? x0 + sk + 12 : x0 + cw - sk - 12;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillStyle = C.hudText;
      let nf = nfs;
      ctx.font = `700 ${nf}px ${FONT_DISPLAY}`;
      let name = names[i];
      const room = sideW - 18;
      while (nf > 7 && ctx.measureText(name).width > room) { nf--; ctx.font = `700 ${nf}px ${FONT_DISPLAY}`; }
      while (name.length > 2 && ctx.measureText(name).width > room) name = name.slice(0, -2) + '…';
      ctx.fillText(name, tx, y0 + ch / 2 - (m.format.games > 1 ? 7 : 0));
      if (m.format.games > 1) {
        // Геймы — точки.
        for (let g = 0; g < Math.ceil(m.format.games / 2); g++) {
          ctx.fillStyle = g < m.games[teams[i]] ? '#ffd23f' : 'rgba(255,255,255,0.25)';
          const gx = left ? tx + 4 + g * 11 : tx - 4 - g * 11;
          ctx.beginPath(); ctx.arc(gx, y0 + ch / 2 + 9, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (m.serverTeam === teams[i] && !m.over) {
        const sx = left ? mid - sw / 2 - sk * 0.6 - 2 : mid + sw / 2 + sk * 0.6 + 2;
        drawServeGlyph(sx, y0 + ch / 2, left);
      }
    }
    // Матчбол/геймбол — ярлык под табло.
    if (fx.matchPoint || fx.gamePoint) {
      const txt = fx.matchPoint ? 'МАТЧБОЛ' : 'ГЕЙМБОЛ';
      ctx.font = `800 10px ${FONT_DISPLAY}`;
      const tw = ctx.measureText(txt).width + 18;
      const pulse = fx.reduced ? 1 : 0.75 + 0.25 * Math.sin(R.time * 6);
      ctx.globalAlpha = pulse;
      ctx.fillStyle = fx.matchPoint ? '#ff3d6e' : '#ffd23f';
      ctx.beginPath(); ctx.moveTo(mid - tw / 2 + 4, y0 + ch); ctx.lineTo(mid + tw / 2 + 4, y0 + ch); ctx.lineTo(mid + tw / 2 - 4, y0 + ch + 15); ctx.lineTo(mid - tw / 2 - 4, y0 + ch + 15); ctx.closePath(); ctx.fill();
      ctx.fillStyle = fx.matchPoint ? '#ffffff' : '#1b0f3a'; ctx.textAlign = 'center';
      ctx.fillText(txt, mid, y0 + ch + 8);
      ctx.globalAlpha = 1;
    }
  }
  function drawServeGlyph(x, y, left) {
    // Маленький волан — «подаёт».
    ctx.save();
    ctx.translate(x, y); ctx.rotate(left ? Math.PI : 0);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9, -5); ctx.lineTo(9, 5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- кадр
  /**
   * Сглаженное «рендер-время». Симуляция 120 Гц шагает пачками (1–3 шага за кадр),
   * из-за чего позиции дёргаются. Рисуем на ровно идущих часах, отстающих от
   * симуляции не больше чем на ~2 шага, и сдвигаем объекты назад по скорости.
   * Возвращает tau = renderTime − game.time (≤ 0); R.animDt — шаг часов для анимации
   * (0 на паузе и в замороженных тестах).
   */
  const SIM_DT = 1 / 120;
  R.clk = 0; R.clkGame = null; R.rate = 1; R.lastGT = 0; R.animDt = 0;
  function renderClock(game, dt) {
    const gt = game.time || 0;
    const prev = R.clk;
    if (R.clkGame !== game || Math.abs(gt - R.clk) > 0.12) {
      R.clkGame = game; R.clk = gt; R.rate = 1; R.animDt = gt > R.lastGT && gt - R.lastGT < 0.12 ? gt - R.lastGT : 0;
    } else {
      const dg = gt - R.lastGT;
      R.rate += ((dt > 0 ? clamp(dg / dt, 0, 8) : 0) - R.rate) * 0.2;
      if (dg <= 0 && R.clk >= gt - 1e-6) R.rate *= 0.5;
      R.clk += dt * R.rate;
      R.clk += (gt - SIM_DT - R.clk) * 0.04;            // мягко держим отставание ≈ 1 шаг
      R.clk = clamp(R.clk, gt - 2.5 * SIM_DT, gt);
      R.animDt = Math.max(0, R.clk - prev);
    }
    R.lastGT = gt;
    return R.clk - gt;
  }

  R.render = function (game, input, dt = 1 / 60) {
    R.time += dt;
    const humanSide = game.human ? game.human.side : (game.players[0] ? game.players[0].side : -1);
    if (humanSide !== R.camera.humanSide) setupCamera(humanSide);
    fx.update(dt, game);
    arena.update(dt);
    updateView(game, dt);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    arena.drawBack(ctx, R.view, R.time, game, fx.reduced);
    drawFloorDynamic(game, dt);

    const tau = renderClock(game, dt);
    // Стоп-кадр (hit-stop): всё рисуется с дополнительным отставанием lag.
    const lag = fx.view.lag;
    const tauV = tau - lag;
    const frozen = fx.hitStop > 0;
    const animDt = frozen ? 0 : Math.min(0.1, Math.max(R.animDt, game.phase === 'over' ? dt : 0));
    const sh = game.shuttle;
    // Волан на рендер-времени, но не раньше последнего удара (скорость уже новая).
    let shTau = 0;
    if (sh.state === 'flight') {
      const since = fx.hitGameTime >= 0 && fx.hitGameTime <= game.time ? game.time - fx.hitGameTime : 0;
      shTau = Math.max(tauV, -since);
    }
    const shv = shTau ? { ...sh, x: sh.x + sh.vx * shTau, y: sh.y + sh.vy * shTau, z: Math.max(0.02, sh.z + sh.vz * shTau) } : sh;
    fx.pushTrail(shv);
    // Тень волана.
    if (sh.state !== 'held' || game.phase === 'serve') shadowAt(shv.x, shv.y, 0.05 + Math.min(0.08, shv.z * 0.01), clamp(0.45 - shv.z * 0.04, 0.12, 0.45));

    // Сортировка объектов по глубине (дальние — первыми).
    const items = [];
    for (const p of game.players) {
      chars.prepare(p, game, { x: p.x + p.vx * tauV, y: p.y + p.vy * tauV }, animDt);
      items.push({ d: chars.depth(p), draw: () => chars.draw(p) });
    }
    items.push({ d: project(0, 0, 0.8).d + (R.camera.orientation === 'portrait' ? 0 : 50), draw: drawNet, net: true });
    for (const it of arena.courtItems(ctx, project, game)) items.push(it);
    items.push({ d: project(shv.x, shv.y, shv.z).d - 0.05, draw: () => { fx.drawTrail(ctx, project, shv); drawShuttle(shv); } });
    items.sort((a, b) => b.d - a.d);
    for (const it of items) it.draw();

    fx.drawWorld(ctx, project);
    arena.drawGlow(ctx, R.view);

    // Волан выше экрана — индикатор.
    const sp = project(shv.x, shv.y, shv.z);
    if (sh.state === 'flight' && sp.y < R.hudRect.h + 4) {
      const x = clamp(sp.x, 16, R.w - 16), y = R.hudRect.h + 14;
      ctx.fillStyle = fx.trailColor || '#ffffff';
      ctx.strokeStyle = '#1b0f3a'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x - 7, y + 4); ctx.lineTo(x + 7, y + 4); ctx.closePath(); ctx.stroke(); ctx.fill();
      ctx.font = `700 10px ${FONT_DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.lineWidth = 3; ctx.strokeText(sh.z.toFixed(1) + ' м', x, y + 7);
      ctx.fillStyle = '#ffffff'; ctx.fillText(sh.z.toFixed(1) + ' м', x, y + 7);
    }
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    fx.drawScreen(ctx, R.w, R.h, project);
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    drawHUD(game);
    drawControlsOverlay(ctx, input, { w: R.w, h: R.h, game, project, dt });
  };

  return R;
}
