/**
 * render.js — 2.5D-отрисовка (canvas 2D, настоящая перспективная проекция).
 *
 * Камера всегда ставит команду человека «ближе к зрителю»:
 *   портрет  — камера за задней линией человека (корт вдоль экрана);
 *   альбом   — камера сбоку (человек слева, соперник справа).
 * Модуль только ЧИТАЕТ состояние игры и подписывается на события —
 * его можно целиком заменить (визуальный агент), сохранив API ниже.
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
import { SHOT_LABELS } from './shots.js';
import { createCharacters } from './render/character.js';

const C = {
  bgTop: '#0e1a2b', bgBot: '#1b2d45',
  wood: '#a86f3e', woodDark: '#8a5a32', woodLine: 'rgba(60,30,10,0.18)',
  mat: '#1f5fa8', matOut: '#17487f', line: '#f4f7fb',
  netMesh: 'rgba(235,240,250,0.33)', netTape: '#ffffff', post: '#d8dde6',
  shadow: 'rgba(0,0,0,0.28)',
  hud: 'rgba(8,14,26,0.72)', hudText: '#ffffff', hudDim: 'rgba(255,255,255,0.6)',
  skin: '#f1c7a5', hair: '#2b1c14', shorts: '#1c2433', shoe: '#f5f5f5',
  shuttleCork: '#f7f2e8', shuttleFeather: '#ffffff', trail: 'rgba(255,255,255,',
};

function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const R = {
    canvas, ctx, w: 1, h: 1, dpr: 1,
    camera: { orientation: 'portrait', humanSide: -1, eye: [0, 0, 0], r: [1, 0, 0], u: [0, 0, 1], f: [0, 1, 0], F: 1, ox: 0, oy: 0 },
    hudRect: { x: 0, y: 0, w: 0, h: 0 },
    trail: [],
    banners: [],      // {text, sub, color, t, life, big}
    flashes: [],      // вспышки удара {x,y,z,t,color}
    landMarks: [],    // {x,y,t,in}
    shake: 0,
    game: null,
    time: 0,
  };

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
  }

  function project(x, y, z) {
    const cam = R.camera;
    const d = [x - cam.eye[0], y - cam.eye[1], z - cam.eye[2]];
    const cz = Math.max(0.1, v3dot(d, cam.f));
    const sx = cam.ox + cam.F * v3dot(d, cam.r) / cz;
    const sy = cam.oy - cam.F * v3dot(d, cam.u) / cz;
    return { x: sx, y: sy, s: cam.F / cz, d: cz };
  }
  R.project = project;

  /** Экранное направление (x вправо, y вверх) → мировое направление на полу. */
  R.screenDirToWorld = function (sx, sy) {
    const cam = R.camera;
    // Правый вектор камеры и «вперёд по полу».
    const rx = cam.r[0], ry = cam.r[1];
    let fx = cam.f[0], fy = cam.f[1];
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    return { x: rx * sx + fx * sy, y: ry * sx + fy * sy };
  };

  R.resize = function (cssW, cssH, dpr) {
    R.w = cssW; R.h = cssH; R.dpr = dpr;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    setupCamera(R.camera.humanSide);
  };

  R.attach = function (game) {
    R.game = game;
    game.on('hit', e => {
      chars.onHit(e, game);
      const sh = game.shuttle;
      const human = e.player.controller === 'human';
      R.flashes.push({ x: sh.x, y: sh.y, z: sh.z, t: 0, perfect: e.timing === 'perfect', color: e.player.color });
      if (R.flashes.length > 4) R.flashes.shift();
      if (e.type === 'smash' && e.speed > 40) {
        R.shake = Math.min(1, 0.35 + (e.speed - 40) / 40);
        if (human || e.speed > 47) banner('СМЭШ!', null, '#ffd23f', 0.9, true);
      } else if (human && !e.serve && e.timing === 'perfect') {
        banner('Идеально!', SHOT_LABELS[e.type], '#7cf29c', 0.8, false);
      } else if (human && !e.serve && e.quality < 0.45) {
        banner(e.timing === 'early' ? 'Рано' : 'Поздно', null, '#ffb4a2', 0.6, false);
      }
    });
    game.on('whiff', e => { if (e.player.controller === 'human') banner('Мимо!', null, '#ffb4a2', 0.7, false); });
    game.on('land', e => { R.landMarks.push({ x: e.x, y: e.y, t: 0, in: e.in }); if (R.landMarks.length > 3) R.landMarks.shift(); });
    game.on('point', e => {
      const txt = { in: 'Очко!', out: 'Аут!', net: 'Сетка!', serveFault: 'Ошибка подачи' }[e.reason];
      const humanTeam = game.human ? game.human.team : 0;
      const col = e.winner === humanTeam ? '#7cf29c' : '#ff8a80';
      const who = teamName(game, e.winner);
      banner(txt, 'Очко: ' + who, col, 1.3, true);
    });
    game.on('game', e => {
      if (!game.match.over) banner('Гейм!', teamName(game, e.winner) + ' — ' + e.games.join(':'), '#ffd23f', 2.4, true);
    });
    game.on('sides', () => banner('Смена сторон', null, '#9ad1ff', 1.6, false));
  };

  function banner(text, sub, color, life, big) {
    R.banners = R.banners.filter(b => !(big && b.big) && b.text !== text);
    R.banners.push({ text, sub, color, t: 0, life, big });
    if (R.banners.length > 3) R.banners.splice(0, R.banners.length - 3);
  }

  function teamName(game, team) {
    const ps = game.players.filter(p => p.team === team);
    const hasHuman = ps.some(p => p.controller === 'human');
    if (hasHuman) return game.cfg.mode === 'doubles' ? 'Ваша пара' : 'Вы';
    return ps.map(p => p.name.split(' ')[0]).join(' и ');
  }

  // ---------------------------------------------------------------- сцена
  function poly(pts, fill) {
    ctx.beginPath();
    pts.forEach((p, i) => { const q = project(p[0], p[1], p[2] || 0); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }

  function lineQuad(x0, y0, x1, y1, w) {
    // Линия на полу как тонкий прямоугольник шириной w.
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l * w / 2, ny = dx / l * w / 2;
    poly([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], C.line);
  }

  function drawFloor(game) {
    const g = ctx.createLinearGradient(0, 0, 0, R.h);
    g.addColorStop(0, C.bgTop); g.addColorStop(1, C.bgBot);
    ctx.fillStyle = g; ctx.fillRect(0, 0, R.w, R.h);
    // Деревянный пол зала.
    const FL = 34, FW = 22;
    poly([[-FL, -FW], [FL, -FW], [FL, FW], [-FL, FW]], C.wood);
    ctx.strokeStyle = C.woodLine; ctx.lineWidth = 1;
    for (let y = -FW; y <= FW; y += 0.55) {
      const a = project(-FL, y, 0), b = project(FL, y, 0);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // Покрытие корта (с полосой вокруг).
    const L = COURT.HALF_LENGTH, W = COURT.HALF_WIDTH_DOUBLES;
    poly([[-L - 0.9, -W - 0.7], [L + 0.9, -W - 0.7], [L + 0.9, W + 0.7], [-L - 0.9, W + 0.7]], C.matOut);
    poly([[-L, -W], [L, -W], [L, W], [-L, W]], C.mat);
    // Линии.
    const lw = COURT.LINE_WIDTH;
    const S = COURT.HALF_WIDTH_SINGLES, SS = COURT.SHORT_SERVICE, DL = COURT.DOUBLES_LONG_SERVICE;
    const hl = lw / 2;
    lineQuad(-L + hl, -W, -L + hl, W, lw); lineQuad(L - hl, -W, L - hl, W, lw);          // задние
    lineQuad(-L, -W + hl, L, -W + hl, lw); lineQuad(-L, W - hl, L, W - hl, lw);          // боковые пар
    lineQuad(-L, -S + hl, L, -S + hl, lw); lineQuad(-L, S - hl, L, S - hl, lw);          // боковые одиночки
    for (const s of [-1, 1]) {
      lineQuad(s * SS, -W, s * SS, W, lw);                                                // короткая подачи
      lineQuad(s * DL, -W, s * DL, W, lw);                                                // длинная подачи пар
      lineQuad(s * SS, 0, s * L, 0, lw);                                                  // центральная
    }
    // Подсветка зоны приёма во время подачи.
    if (game.phase === 'serve' && game.serveInfo) {
      const s = game.serveInfo; const box = serviceBoxWorld(game, s);
      ctx.globalAlpha = 0.16 + 0.06 * Math.sin(R.time * 5);
      poly([[box.xMin, box.yMin], [box.xMax, box.yMin], [box.xMax, box.yMax], [box.xMin, box.yMax]], '#ffe27a');
      ctx.globalAlpha = 1;
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
    const W = COURT.NET_POST_Y, H = COURT.NET_HEIGHT;
    // Сетка (ячейки) — полупрозрачная полоса 0.76 м под лентой.
    poly([[0, -W, H - 0.76], [0, W, H - 0.76], [0, W, H], [0, -W, H]], 'rgba(20,24,32,0.35)');
    ctx.strokeStyle = C.netMesh; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = -W; y <= W + 1e-6; y += 0.18) {
      const a = project(0, y, H - 0.76), b = project(0, y, H);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let z = H - 0.76; z <= H; z += 0.12) {
      const a = project(0, -W, z), b = project(0, W, z);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    // Лента.
    const a = project(0, -W, H), b = project(0, W, H);
    ctx.strokeStyle = C.netTape; ctx.lineWidth = Math.max(2, 0.05 * (a.s + b.s) / 2);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    // Стойки.
    for (const y of [-W, W]) {
      const p0 = project(0, y, 0), p1 = project(0, y, H + 0.02);
      ctx.strokeStyle = C.post; ctx.lineWidth = Math.max(2, 0.05 * p0.s);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
  }

  function shadowAt(x, y, rx, alpha) {
    const p = project(x, y, 0);
    const q = project(x + rx, y, 0), q2 = project(x, y + rx, 0);
    const ax = Math.max(Math.abs(q.x - p.x), Math.abs(q2.x - p.x), 2);
    const ay = Math.max(Math.abs(q.y - p.y), Math.abs(q2.y - p.y), 1.2);
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
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
    ctx.save();
    ctx.translate(head.x, head.y);
    ctx.rotate(ang);
    const wid = Math.max(4, 0.055 * sc) * minScale;
    // Юбка из перьев (усечённый конус).
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.moveTo(1, -wid * 0.35); ctx.lineTo(len * 1.5, -wid); ctx.lineTo(len * 1.5, wid); ctx.lineTo(1, wid * 0.35);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(120,130,150,0.8)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(len * 0.6, -wid * 0.7); ctx.lineTo(len * 0.6, wid * 0.7); ctx.stroke();
    // Пробковая головка.
    ctx.fillStyle = '#e7d3b0';
    ctx.beginPath(); ctx.arc(0, 0, wid * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawTrail() {
    const t = R.trail;
    for (let i = 1; i < t.length; i++) {
      const a = project(t[i - 1].x, t[i - 1].y, t[i - 1].z), b = project(t[i].x, t[i].y, t[i].z);
      const k = i / t.length;
      ctx.strokeStyle = C.trail + (0.35 * k * t[i].alpha).toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, 0.04 * b.s * k);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- HUD
  function drawHUD(game) {
    const m = game.match; if (!m) return;
    const portrait = R.camera.orientation === 'portrait';
    const hr = R.hudRect;
    const humanTeam = game.human ? game.human.team : 0;
    const teams = [humanTeam, 1 - humanTeam];
    // Справа оставляем место под кнопку паузы (44px + отступы).
    const cw = Math.min(R.w - 12 - 66, 460), ch = portrait ? 56 : 44;
    const x0 = Math.max(12, Math.min((R.w - cw) / 2, R.w - 66 - cw)), y0 = portrait ? 10 : 6;
    ctx.fillStyle = C.hud;
    roundRect(x0, y0, cw, ch, 14); ctx.fill();
    ctx.textBaseline = 'middle';
    const mid = x0 + cw / 2;
    const fs = portrait ? 30 : 26;
    ctx.font = `800 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = 'right'; ctx.fillStyle = C.hudText;
    ctx.fillText(String(m.score[teams[0]]), mid - 14, y0 + ch / 2 + 1);
    ctx.textAlign = 'left';
    ctx.fillText(String(m.score[teams[1]]), mid + 14, y0 + ch / 2 + 1);
    ctx.textAlign = 'center'; ctx.fillStyle = C.hudDim; ctx.font = `700 ${fs * 0.7}px system-ui, sans-serif`;
    ctx.fillText(':', mid, y0 + ch / 2);
    // Имена + индикатор подачи.
    const nfs = portrait ? 13 : 12;
    ctx.font = `600 ${nfs}px system-ui, sans-serif`;
    const names = teams.map(t => teamName(game, t));
    const colors = teams.map(t => game.players.find(p => p.team === t).color);
    for (let i = 0; i < 2; i++) {
      const left = i === 0;
      const tx = left ? x0 + 14 : x0 + cw - 14;
      ctx.textAlign = left ? 'left' : 'right';
      ctx.fillStyle = colors[i];
      ctx.fillRect(left ? x0 + 6 : x0 + cw - 10, y0 + 10, 4, ch - 20);
      ctx.fillStyle = C.hudText;
      ctx.fillText(truncate(names[i], cw < 340 ? 9 : portrait ? 13 : 18), tx + (left ? 4 : -4), y0 + ch / 2 - (m.format.games > 1 ? 7 : 0));
      if (m.format.games > 1) {
        ctx.fillStyle = C.hudDim; ctx.font = `500 ${nfs - 2}px system-ui, sans-serif`;
        ctx.fillText('геймы: ' + m.games[teams[i]], tx + (left ? 4 : -4), y0 + ch / 2 + 9);
        ctx.font = `600 ${nfs}px system-ui, sans-serif`;
      }
      if (m.serverTeam === teams[i] && !m.over) {
        const sx = left ? mid - 14 - fs * 1.4 : mid + 14 + fs * 1.4;
        ctx.fillStyle = '#ffe27a';
        ctx.beginPath(); ctx.arc(sx, y0 + ch / 2, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawBanners(dt) {
    const portrait = R.camera.orientation === 'portrait';
    R.banners = R.banners.filter(b => (b.t += dt) < b.life);
    let y = R.h * (portrait ? 0.4 : 0.36);
    for (const b of R.banners) {
      const k = b.t / b.life;
      const a = k < 0.12 ? k / 0.12 : k > 0.75 ? (1 - k) / 0.25 : 1;
      const scale = b.big ? 1 + 0.25 * Math.max(0, 1 - b.t / 0.18) : 1;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(R.w / 2, y);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = b.big ? (portrait ? 40 : 36) : 22;
      ctx.font = `900 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.color; ctx.fillText(b.text, 0, 0);
      if (b.sub) {
        ctx.font = `700 ${Math.round(fs * 0.42)}px system-ui, sans-serif`;
        ctx.lineWidth = 4; ctx.strokeText(b.sub, 0, fs * 0.75);
        ctx.fillStyle = '#ffffff'; ctx.fillText(b.sub, 0, fs * 0.75);
      }
      ctx.restore();
      y += b.big ? 70 : 34;
    }
  }

  function drawTouchUI(input) {
    if (!input || !input.state) return;
    const st = input.state;
    const j = st.joystick;
    if (j.active) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(j.bx, j.by, j.radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(j.kx, j.ky, j.radius * 0.42, 0, Math.PI * 2); ctx.fill();
    } else if (st.touchSeen) {
      // Подсказка зоны джойстика.
      const r = Math.min(56, R.w * 0.12);
      const bx = r + 26, by = R.h - r - 30;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.arc(bx, by, r * 0.42, 0, Math.PI * 2); ctx.fill();
    }
    // След свайпа.
    for (const g of st.gestures) {
      const k = 1 - g.age / 0.35;
      if (k <= 0) continue;
      ctx.strokeStyle = `rgba(255,226,122,${0.7 * k})`; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(g.x0, g.y0); ctx.lineTo(g.x1, g.y1); ctx.stroke();
      ctx.fillStyle = `rgba(255,226,122,${0.5 * k})`;
      ctx.beginPath(); ctx.arc(g.x1, g.y1, 10 + 14 * (1 - k), 0, Math.PI * 2); ctx.fill();
    }
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
  R.clk = 0; R.clkGame = null; R.rate = 1; R.lastGT = 0; R.animDt = 0; R.lastHits = -1;
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
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    // Тряска камеры.
    if (R.shake > 0) {
      R.shake = Math.max(0, R.shake - dt * 3);
      const a = R.shake * 6;
      ctx.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
    }
    drawFloor(game);
    const tau = renderClock(game, dt);
    const animDt = Math.min(0.1, Math.max(R.animDt, game.phase === 'over' ? dt : 0));
    const sh = game.shuttle;
    // Метки приземления.
    R.landMarks = R.landMarks.filter(m => (m.t += dt) < 1.6);
    for (const m of R.landMarks) {
      const p = project(m.x, m.y, 0);
      ctx.strokeStyle = m.in ? `rgba(124,242,156,${1 - m.t / 1.6})` : `rgba(255,120,110,${1 - m.t / 1.6})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.25 * p.s, 0.25 * p.s * Math.abs(R.camera.f[2]) * 1.2 + 2, 0, 0, Math.PI * 2); ctx.stroke();
    }
    // Подсказка приземления для человека (помощник).
    if (game.cfg.assist && game.human && sh.state === 'flight' && sh.lastHitTeam !== game.human.team) {
      const L = predictLanding(sh);
      if (!L.netHit && Math.sign(L.x) === game.human.side) {
        const p = project(L.x, L.y, 0);
        ctx.strokeStyle = 'rgba(255,226,122,0.55)'; ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 0.22 * p.s, 0.22 * p.s * 0.45 + 1, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Тень волана.
    if (sh.state !== 'held' || game.phase === 'serve') shadowAt(sh.x, sh.y, 0.05 + Math.min(0.08, sh.z * 0.01), clamp(0.45 - sh.z * 0.04, 0.12, 0.45));
    // След.
    if (sh.state === 'flight') {
      const sp = Math.hypot(sh.vx, sh.vy, sh.vz);
      R.trail.push({ x: sh.x, y: sh.y, z: sh.z, alpha: clamp(sp / 20, 0.2, 1) });
      if (R.trail.length > 22) R.trail.shift();
    } else if (R.trail.length) R.trail.shift();

    // Сортировка объектов по глубине (дальние — первыми).
    const items = [];
    for (const p of game.players) {
      chars.prepare(p, game, { x: p.x + p.vx * tau, y: p.y + p.vy * tau }, animDt);
      items.push({ d: chars.depth(p), draw: () => chars.draw(p) });
    }
    items.push({ d: project(0, 0, 0.8).d + (R.camera.orientation === 'portrait' ? 0 : 50), draw: drawNet, net: true });
    // Волан тоже рисуем на рендер-времени (кроме кадра удара — скорость уже новая).
    const shTau = sh.state === 'flight' && R.lastHits === sh.hits ? tau : 0;
    R.lastHits = sh.hits;
    const shv = shTau ? { ...sh, x: sh.x + sh.vx * shTau, y: sh.y + sh.vy * shTau, z: Math.max(0.02, sh.z + sh.vz * shTau) } : sh;
    items.push({ d: project(shv.x, shv.y, shv.z).d - 0.05, draw: () => { drawTrail(); drawShuttle(shv); } });
    items.sort((a, b) => b.d - a.d);
    for (const it of items) it.draw();

    // Вспышки удара.
    R.flashes = R.flashes.filter(f => (f.t += dt) < 0.3);
    for (const f of R.flashes) {
      const p = project(f.x, f.y, f.z);
      const k = f.t / 0.3;
      ctx.strokeStyle = f.perfect ? `rgba(255,236,140,${1 - k})` : `rgba(255,255,255,${0.7 * (1 - k)})`;
      ctx.lineWidth = f.perfect ? 4 : 2.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, (0.15 + k * (f.perfect ? 0.7 : 0.4)) * p.s, 0, Math.PI * 2); ctx.stroke();
    }
    // Волан выше экрана — индикатор.
    const sp = project(sh.x, sh.y, sh.z);
    if (sh.state === 'flight' && sp.y < R.hudRect.h + 4) {
      const x = clamp(sp.x, 16, R.w - 16), y = R.hudRect.h + 14;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x - 7, y + 4); ctx.lineTo(x + 7, y + 4); ctx.closePath(); ctx.fill();
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(sh.z.toFixed(1) + ' м', x, y + 6);
    }
    ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    drawHUD(game);
    drawBanners(dt);
    drawTouchUI(input);
  };

  return R;
}
