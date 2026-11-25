/**
 * render/arena.js — спортивный зал в стиле аниме-спортивных сериалов (оригинальная графика).
 *
 * Слои:
 *   статический кеш (offscreen-canvas, перерисовывается только при смене размера/камеры):
 *     фон-«дымка», стены, трибуны-ступени, пол-паркет, глянцевый зелёный корт с текстурой
 *     и отражениями ламп, линии, рамки рекламных бортов;
 *   «свечение» (canvas в половинном разрешении): световые столбы от ламп, бликовая дымка;
 *   динамика каждого кадра: зрители (cel-заливка, машут/прыгают/световые палочки, «волна»),
 *     светодиодные борта с бегущей рекламой и реакцией на события, судейская вышка и табло.
 *
 * Все бренды — вымышленные.
 *
 * API:
 *   createArena() -> {
 *     build(view)                — view: {w, h, dpr, cam, humanSide, portrait, margin:{x,y}}
 *     drawBack(ctx, V, t, game)  — кеш + зрители + борта (V — вид: {k, tx, ty, dpr})
 *     drawGlow(ctx, V)           — световые столбы поверх сцены
 *     courtItems(project, game)  — объекты корта для сортировки по глубине [{d, draw}]
 *     cheer(level, opts)         — реакция трибун (0..1), opts: {team, wave, text, color}
 *     update(dt)
 *   }
 */
import { COURT } from '../config.js';
import { t as tl } from '../platform/i18n.js';

export const FONT_DISPLAY = '"Unbounded", "Arial Black", "Segoe UI Black", system-ui, sans-serif';

/** Геометрия зала, м. */
const HALL = {
  XB: 9.7, YB: 5.5,          // рекламные борта (прямоугольник вокруг площадки)
  BOARD_H: 0.85,
  GAP: 1.1,                  // проход между бортом и первой ступенью
  ROWS: 8, ROW_D: 0.95, ROW_H: 0.55, ROW0: 0.6,
  WALL_H: 16,
};

const PAL = {
  night: '#16123a', wall: '#2a2768', wallHi: '#4b3f96', haze: '#a796ea', warm: '#ffe7b8',
  tread: '#3b3680', riser: '#262260', seatA: '#3d64d8', seatB: '#e2537f',
  wood: '#d79552', woodB: '#c9843f', woodC: '#e4a865', woodLine: 'rgba(92,44,12,0.22)',
  mat: '#1c9a6b', matDeep: '#127650', matEdge: '#0d5a3c', line: '#f8fcff',
  board: '#12102a', boardTop: '#2c2a52',
};

const SHIRTS = ['#ff5d8f', '#ffd23f', '#4fd8ff', '#ffffff', '#9b7bff', '#ff8a3d', '#5ee39a', '#2f6bff', '#ff4b5c', '#f2f2f2'];
const SKINS = ['#f3d0b5', '#e8b48f', '#c98e66', '#a8714f', '#f6dcc8'];
const HAIRS = ['#1c1426', '#2b1a14', '#4a2e1f', '#d9b36a', '#ff7aa8', '#5a7cff', '#101010', '#7b4a2a'];

/** Внешности зрителей (детерминированно смешанные). */
const CROWD_LOOKS = (() => {
  const out = [];
  for (let i = 0; i < 16; i++) out.push({ shirt: SHIRTS[i % SHIRTS.length], skin: SKINS[(i * 3 + 1) % SKINS.length], hair: HAIRS[(i * 5 + 2) % HAIRS.length] });
  return out;
})();

const BRANDS = [
  { t: 'ЛЁТ', s: 'спорт', bg: '#ff3d6e', fg: '#ffffff' },
  { t: 'Облако', s: 'сода', bg: '#2fc4ff', fg: '#0b1b4a' },
  { t: 'НОВА', s: 'грип', bg: '#ffd23f', fg: '#1a1240' },
  { t: 'Перо 7', s: 'воланы', bg: '#ffffff', fg: '#1d1650' },
  { t: 'Сорока', s: 'кроссовки', bg: '#7a5cff', fg: '#ffffff' },
  { t: 'Ясно FM', s: '101.7', bg: '#28d67f', fg: '#0b2a1a' },
];

const FAN_BANNERS = ['ВОЛАН!', 'ЛЕТИ ВЫШЕ!', 'ДАВАЙ-ДАВАЙ!', '★ 21 ★', 'ЖМИ!', 'МЫ С ТОБОЙ'];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
}

export function createArena() {
  const A = {
    key: '', cache: null, glow: null, glowScale: 0.5,
    w: 1, h: 1, dpr: 1, M: { x: 0, y: 0 },
    cam: null, s: -1, portrait: true, farY: 1,
    rows: [],          // [{people:[...], banners:[...]}] — от дальних к ближним
    boards: [],        // сегменты бортов [{p0,p1,p2,u}]
    hype: 0, hypeTeam: -1, wave: 0, waveT: 0, jumpT: 0,
    led: { mode: 'ads', text: '', color: '#fff', t: 0, life: 0, scroll: 0 },
    ledTex: null, ledEvTex: null, ledEvKey: '',
    chair: null,
  };

  // ------------------------------------------------------------ проекция (база камеры)
  function makeProject(cam, ox, oy) {
    const e = cam.eye, r = cam.r, u = cam.u, f = cam.f, F = cam.F;
    return function (x, y, z) {
      const dx = x - e[0], dy = y - e[1], dz = z - e[2];
      const cz = dx * f[0] + dy * f[1] + dz * f[2];
      const c = Math.max(0.1, cz);
      return { x: ox + cam.ox + F * (dx * r[0] + dy * r[1] + dz * r[2]) / c, y: oy + cam.oy - F * (dx * u[0] + dy * u[1] + dz * u[2]) / c, s: F / c, d: cz };
    };
  }

  // ------------------------------------------------------------ сборка
  A.build = function (view) {
    const { w, h, dpr, cam, humanSide, portrait, margin } = view;
    const key = [w, h, dpr, humanSide, portrait, margin.x, margin.y, cam.F.toFixed(3)].join('|');
    if (key === A.key) return;
    A.key = key; A.w = w; A.h = h; A.dpr = dpr; A.M = margin; A.cam = cam; A.s = humanSide; A.portrait = portrait;
    A.farY = -humanSide;   // в альбоме дальняя боковая — y = −s; в портрете — тоже (судья слева/справа)
    const Mx = margin.x, My = margin.y;
    const CW = w + 2 * Mx, CH = h + 2 * My;
    if (!A.cache) A.cache = makeCanvas(1, 1);
    A.cache.width = Math.ceil(CW * dpr); A.cache.height = Math.ceil(CH * dpr);
    const c = A.cache.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const P = makeProject(cam, Mx, My);
    const base = makeProject(cam, 0, 0);
    A.base = base;
    drawStatic(c, P, CW, CH);
    buildCrowd(base);
    buildBoards(base);
    // Свечение в половинном разрешении.
    const gs = A.glowScale;
    if (!A.glow) A.glow = makeCanvas(1, 1);
    A.glow.width = Math.ceil(CW * gs); A.glow.height = Math.ceil(CH * gs);
    const g = A.glow.getContext('2d');
    g.setTransform(gs, 0, 0, gs, 0, 0);
    drawGlowLayer(g, P, CW, CH);
    c.save();
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = 0.85;
    c.drawImage(A.glow, 0, 0, CW, CH);
    c.restore();
    if (!A.ledTex) A.ledTex = buildLedAds();
    buildCrowdCache();
  };

  /** Видима ли сторона трибун (камера не за ней). */
  function sideVisible(axis, sg) {
    const e = A.cam.eye;
    const lim = axis === 'x' ? HALL.XB : HALL.YB;
    return (axis === 'x' ? e[0] : e[1]) * sg < lim;
  }

  /** Стороны трибун: axis — ось нормали, sg — знак; tangent-диапазон. */
  function sides() {
    const out = [];
    const ext = HALL.ROWS * HALL.ROW_D + HALL.GAP;
    for (const sg of [-1, 1]) {
      out.push({ axis: 'x', sg, d0: HALL.XB, t0: -(HALL.YB + ext), t1: HALL.YB + ext });
      out.push({ axis: 'y', sg, d0: HALL.YB, t0: -(HALL.XB + HALL.GAP), t1: HALL.XB + HALL.GAP });
    }
    // От дальних к ближним (по глубине центра).
    const e = A.cam.eye, f = A.cam.f;
    for (const sd of out) {
      const c = sd.axis === 'x' ? [sd.sg * (sd.d0 + 4), 0, 2] : [0, sd.sg * (sd.d0 + 4), 2];
      sd.depth = (c[0] - e[0]) * f[0] + (c[1] - e[1]) * f[1] + (c[2] - e[2]) * f[2];
      sd.visible = sideVisible(sd.axis, sd.sg);
    }
    return out.sort((a, b) => b.depth - a.depth);
  }
  function W(sd, d, t, z) { return sd.axis === 'x' ? [sd.sg * d, t, z] : [t, sd.sg * d, z]; }

  function quad(c, P, pts, fill, minDepth = 0.6) {
    const q = pts.map(p => P(p[0], p[1], p[2]));
    for (const v of q) if (v.d < minDepth) return false;
    c.beginPath(); c.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < q.length; i++) c.lineTo(q[i].x, q[i].y);
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    return true;
  }

  function drawStatic(c, P, CW, CH) {
    // Фон: ночная дымка зала, к верху теплеет (свет ламп).
    const g = c.createLinearGradient(0, 0, 0, CH);
    g.addColorStop(0, '#3a2f7a'); g.addColorStop(0.35, PAL.wall); g.addColorStop(1, PAL.night);
    c.fillStyle = g; c.fillRect(0, 0, CW, CH);
    const sds = sides();
    // Пол зала за бортами (тёмный проход) — большой прямоугольник.
    const FL = HALL.XB + HALL.GAP + 0.01, FW = HALL.YB + HALL.GAP + 0.01;
    quad(c, P, [[-FL, -FW, 0], [FL, -FW, 0], [FL, FW, 0], [-FL, FW, 0]], '#231d4a', 0.2);
    for (const sd of sds) if (sd.visible) drawStand(c, P, sd);
    drawWood(c, P);
    drawCourt(c, P);
    for (const sd of sds) if (sd.visible) drawBoardFrame(c, P, sd);
    // Мягкая живописная виньетка.
    const vg = c.createRadialGradient(CW / 2, CH * 0.55, Math.min(CW, CH) * 0.35, CW / 2, CH * 0.55, Math.max(CW, CH) * 0.75);
    vg.addColorStop(0, 'rgba(20,12,50,0)'); vg.addColorStop(1, 'rgba(20,12,50,0.42)');
    c.fillStyle = vg; c.fillRect(0, 0, CW, CH);
  }

  function drawStand(c, P, sd) {
    const { d0, t0, t1 } = sd;
    const D0 = d0 + HALL.GAP;
    const top = HALL.ROW0 + (HALL.ROWS - 1) * HALL.ROW_H;
    const dEnd = D0 + HALL.ROWS * HALL.ROW_D;
    // Задняя стена (дымка вверху светлее — «воздушная перспектива»).
    const a = P(...W(sd, dEnd, 0, top)), b = P(...W(sd, dEnd, 0, HALL.WALL_H));
    if (a.d > 0.6 && b.d > 0.6) {
      const wg = c.createLinearGradient(0, a.y, 0, b.y);
      wg.addColorStop(0, '#3a3488'); wg.addColorStop(0.5, '#5a4aa8'); wg.addColorStop(1, '#8a76d0');
      quad(c, P, [W(sd, dEnd, t0, top), W(sd, dEnd, t1, top), W(sd, dEnd, t1, HALL.WALL_H), W(sd, dEnd, t0, HALL.WALL_H)], wg);
      // Окна-полосы под потолком и вымпелы.
      for (let t = t0 + 1.5; t < t1 - 1; t += 3.2) {
        quad(c, P, [W(sd, dEnd - 0.01, t, top + 3.2), W(sd, dEnd - 0.01, t + 2.2, top + 3.2), W(sd, dEnd - 0.01, t + 2.2, top + 6.5), W(sd, dEnd - 0.01, t, top + 6.5)], 'rgba(255,236,200,0.16)');
      }
      // Перила верхнего яруса.
      quad(c, P, [W(sd, dEnd - 0.02, t0, top + 0.95), W(sd, dEnd - 0.02, t1, top + 0.95), W(sd, dEnd - 0.02, t1, top + 1.05), W(sd, dEnd - 0.02, t0, top + 1.05)], 'rgba(255,255,255,0.35)');
      // Вымпелы с цветами (висят с потолка над трибуной).
      const flagCols = ['#ff5d8f', '#ffd23f', '#4fd8ff', '#9b7bff', '#5ee39a'];
      let i = 0;
      for (let t = t0 + 1; t < t1; t += 1.6, i++) {
        const z0 = top + 2.4 + (i % 2) * 0.2;
        quad(c, P, [W(sd, dEnd - 0.3, t, z0), W(sd, dEnd - 0.3, t + 0.9, z0), W(sd, dEnd - 0.3, t + 0.45, z0 - 1.3)], flagCols[i % flagCols.length]);
      }
      quad(c, P, [W(sd, dEnd - 0.31, t0, top + 2.46), W(sd, dEnd - 0.31, t1, top + 2.46), W(sd, dEnd - 0.31, t1, top + 2.5), W(sd, dEnd - 0.31, t0, top + 2.5)], 'rgba(255,255,255,0.5)');
    }
    // Ступени: от верхнего (дальнего) ряда к нижнему.
    for (let i = HALL.ROWS - 1; i >= 0; i--) {
      const z = HALL.ROW0 + i * HALL.ROW_H, zPrev = i ? HALL.ROW0 + (i - 1) * HALL.ROW_H : 0;
      const dA = D0 + i * HALL.ROW_D, dB = dA + HALL.ROW_D;
      const haze = i / (HALL.ROWS - 1);
      quad(c, P, [W(sd, dA, t0, z), W(sd, dA, t1, z), W(sd, dB, t1, z), W(sd, dB, t0, z)], mix(PAL.tread, PAL.wallHi, haze * 0.45));
      // Кресла: цветной ряд (виден между зрителями).
      quad(c, P, [W(sd, dA + 0.45, t0, z), W(sd, dA + 0.45, t1, z), W(sd, dA + 0.5, t1, z + 0.42), W(sd, dA + 0.5, t0, z + 0.42)], mix(i % 2 ? PAL.seatA : PAL.seatB, PAL.haze, 0.2 + haze * 0.35));
      quad(c, P, [W(sd, dA, t0, zPrev), W(sd, dA, t1, zPrev), W(sd, dA, t1, z), W(sd, dA, t0, z)], mix(PAL.riser, PAL.wall, haze * 0.5));
      // Кромка ступени — светлая линия (cel-акцент).
      quad(c, P, [W(sd, dA, t0, z), W(sd, dA, t1, z), W(sd, dA + 0.05, t1, z), W(sd, dA + 0.05, t0, z)], 'rgba(255,240,220,0.28)');
    }
  }

  function drawWood(c, P) {
    const XB = HALL.XB, YB = HALL.YB;
    quad(c, P, [[-XB, -YB, 0], [XB, -YB, 0], [XB, YB, 0], [-XB, YB, 0]], PAL.wood, 0.2);
    // Доски вдоль корта: чередование оттенков + стыки.
    const rnd = mulberry(11);
    const pw = 0.42;
    for (let y = -YB, i = 0; y < YB - 1e-6; y += pw, i++) {
      const y1 = Math.min(YB, y + pw);
      let x = -XB - rnd() * 2;
      while (x < XB) {
        const len = 1.6 + rnd() * 2.4;
        const xa = Math.max(-XB, x), xb = Math.min(XB, x + len);
        const tone = rnd();
        if (tone > 0.55) quad(c, P, [[xa, y, 0], [xb, y, 0], [xb, y1, 0], [xa, y1, 0]], tone > 0.8 ? PAL.woodC : PAL.woodB, 0.2);
        x += len;
      }
    }
    c.strokeStyle = PAL.woodLine; c.lineWidth = 0.8;
    c.beginPath();
    for (let y = -YB; y <= YB + 1e-6; y += pw) {
      const a = P(-XB, y, 0), b = P(XB, y, 0);
      c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
    }
    c.stroke();
    // Лак: широкий тёплый блик.
    const a = P(0, 0, 0);
    const lg = c.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(A.w, A.h) * 0.8);
    lg.addColorStop(0, 'rgba(255,230,180,0.18)'); lg.addColorStop(1, 'rgba(255,230,180,0)');
    quad(c, P, [[-XB, -YB, 0], [XB, -YB, 0], [XB, YB, 0], [-XB, YB, 0]], lg, 0.2);
  }

  function lamps() {
    const out = [];
    for (const lx of [-6, -2, 2, 6]) for (const ly of [-2.6, 2.6]) out.push([lx, ly, 10.5]);
    return out;
  }

  function drawCourt(c, P) {
    const L = COURT.HALF_LENGTH, Wd = COURT.HALF_WIDTH_DOUBLES;
    const RL = L + 1.0, RW = Wd + 0.8;
    // Обвод мата (тёмная кромка, чуть выше пола — толщина).
    quad(c, P, [[-RL - 0.06, -RW - 0.06, 0], [RL + 0.06, -RW - 0.06, 0], [RL + 0.06, RW + 0.06, 0], [-RL - 0.06, RW + 0.06, 0]], PAL.matEdge, 0.2);
    // Мат: градиент дальний→ближний (глянец).
    const n = P(0, 0, 0), far = P(-A.s * RL, 0, 0), near = P(A.s * RL, 0, 0);
    const lin = A.portrait ? c.createLinearGradient(0, far.y, 0, near.y) : c.createLinearGradient(0, P(0, -A.s * RW * -1, 0).y, 0, P(0, A.s * RW * -1, 0).y);
    lin.addColorStop(0, '#26b07c'); lin.addColorStop(0.5, PAL.mat); lin.addColorStop(1, PAL.matDeep);
    quad(c, P, [[-RL, -RW, 0], [RL, -RW, 0], [RL, RW, 0], [-RL, RW, 0]], lin, 0.2);
    // Текстура: мелкая «зернистость» покрытия.
    c.save();
    quad(c, P, [[-RL, -RW, 0], [RL, -RW, 0], [RL, RW, 0], [-RL, RW, 0]], null, 0.2);
    c.clip();
    const rnd = mulberry(5);
    c.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < 1400; i++) {
      const p = P(-RL + rnd() * 2 * RL, -RW + rnd() * 2 * RW, 0);
      const r = Math.max(0.5, p.s * 0.018);
      c.fillRect(p.x, p.y, r, r * 0.6);
    }
    c.fillStyle = 'rgba(0,30,20,0.07)';
    for (let i = 0; i < 1200; i++) {
      const p = P(-RL + rnd() * 2 * RL, -RW + rnd() * 2 * RW, 0);
      const r = Math.max(0.5, p.s * 0.02);
      c.fillRect(p.x, p.y, r, r * 0.6);
    }
    // Диагональный аниме-блик по покрытию.
    const sweep = c.createLinearGradient(P(-RL, -RW, 0).x, P(-RL, -RW, 0).y, P(RL, RW, 0).x, P(RL, RW, 0).y);
    sweep.addColorStop(0.0, 'rgba(255,255,255,0)'); sweep.addColorStop(0.34, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.4, 'rgba(220,255,240,0.09)'); sweep.addColorStop(0.47, 'rgba(255,255,255,0)');
    sweep.addColorStop(0.52, 'rgba(220,255,240,0.05)'); sweep.addColorStop(0.56, 'rgba(255,255,255,0)');
    c.fillStyle = sweep; c.fillRect(0, 0, A.cache.width, A.cache.height);
    c.restore();
    void n; void near;
    // Линии.
    const lw = COURT.LINE_WIDTH * 1.25;
    const S = COURT.HALF_WIDTH_SINGLES, SS = COURT.SHORT_SERVICE, DL = COURT.DOUBLES_LONG_SERVICE;
    const hl = lw / 2;
    const line = (x0, y0, x1, y1) => {
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l * lw / 2, ny = dx / l * lw / 2;
      quad(c, P, [[x0 + nx, y0 + ny, 0], [x1 + nx, y1 + ny, 0], [x1 - nx, y1 - ny, 0], [x0 - nx, y0 - ny, 0]], PAL.line, 0.2);
    };
    line(-L + hl, -Wd, -L + hl, Wd); line(L - hl, -Wd, L - hl, Wd);
    line(-L, -Wd + hl, L, -Wd + hl); line(-L, Wd - hl, L, Wd - hl);
    line(-L, -S + hl, L, -S + hl); line(-L, S - hl, L, S - hl);
    for (const s of [-1, 1]) { line(s * SS, -Wd, s * SS, Wd); line(s * DL, -Wd, s * DL, Wd); line(s * SS, 0, s * L, 0); }
    // Отражения ламп в глянце: точка зеркального отражения на полу.
    const e = A.cam.eye;
    c.save();
    quad(c, P, [[-RL, -RW, 0], [RL, -RW, 0], [RL, RW, 0], [-RL, RW, 0]], null, 0.2);
    c.clip();
    c.globalCompositeOperation = 'lighter';
    for (const Lm of lamps()) {
      const t = e[2] / (e[2] + Lm[2]);
      const rx = e[0] + t * (Lm[0] - e[0]), ry = e[1] + t * (Lm[1] - e[1]);
      if (Math.abs(rx) > RL || Math.abs(ry) > RW) continue;
      const p = P(rx, ry, 0);
      const r = p.s * 1.5;
      // Вытянутый к камере блик.
      c.save();
      c.translate(p.x, p.y);
      const toward = P(rx + (e[0] - rx) * 0.05, ry + (e[1] - ry) * 0.05, 0);
      c.rotate(Math.atan2(toward.y - p.y, toward.x - p.x) - Math.PI / 2);
      c.scale(0.5, 1.9);
      const rg = c.createRadialGradient(0, 0, 0, 0, 0, r);
      rg.addColorStop(0, 'rgba(255,248,225,0.17)'); rg.addColorStop(0.3, 'rgba(255,248,225,0.07)'); rg.addColorStop(1, 'rgba(255,248,225,0)');
      c.fillStyle = rg; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
      c.restore();
    }
    c.restore();
  }

  function drawBoardFrame(c, P, sd) {
    const d = sd.d0, H = HALL.BOARD_H;
    const t0 = sd.axis === 'x' ? -HALL.YB : -HALL.XB, t1 = -t0;
    // Задняя (тёмная) плоскость и верхняя кромка — лицевая сторона светодиодная (динамика).
    quad(c, P, [W(sd, d + 0.25, t0, 0), W(sd, d + 0.25, t1, 0), W(sd, d + 0.25, t1, H), W(sd, d + 0.25, t0, H)], '#0d0b22', 0.6);
    quad(c, P, [W(sd, d, t0, H), W(sd, d, t1, H), W(sd, d + 0.25, t1, H), W(sd, d + 0.25, t0, H)], PAL.boardTop, 0.6);
    quad(c, P, [W(sd, d, t0, 0), W(sd, d, t1, 0), W(sd, d, t1, H), W(sd, d, t0, H)], PAL.board, 0.6);
  }

  // ------------------------------------------------------------ зрители
  function buildCrowd(P) {
    const rnd = mulberry(20261124);
    const rows = [];
    for (const sd of sides()) {
      if (!sd.visible) continue;
      const D0 = sd.d0 + HALL.GAP;
      for (let i = HALL.ROWS - 1; i >= 0; i--) {
        const z = HALL.ROW0 + i * HALL.ROW_H;
        const d = D0 + i * HALL.ROW_D + 0.42;
        const haze = 0.12 + 0.5 * (i / (HALL.ROWS - 1));
        const row = { people: [], banners: [], depth: 0 };
        let t = sd.t0 + 0.3 + rnd() * 0.3;
        const people = [];
        while (t < sd.t1 - 0.3) {
          const w = W(sd, d, t, z);
          const p = P(w[0], w[1], w[2]);
          const onScreen = p.d > 1 && p.x > -60 && p.x < A.w + 60 && p.y > -80 && p.y < A.h + 40;
          if (onScreen && rnd() > 0.06) {
            const fanOf = t * (sd.axis === 'x' ? 1 : sd.sg) > 0 ? 1 : 0;
            people.push({
              x: p.x, y: p.y, s: p.s, t, d: p.d, look: (rnd() * CROWD_LOOKS.length) | 0, lv: i, haze,
              ph: rnd() * Math.PI * 2, react: 0.5 + rnd() * 0.5,
              stick: rnd() < 0.22, fan: fanOf, flag: rnd() < 0.035, tall: 0.92 + rnd() * 0.16,
              wavePos: (sd.axis === 'x' ? t : sd.sg * t) * 0.35,
            });
          }
          t += 0.56 + rnd() * 0.12;
        }
        if (!people.length) continue;
        row.people = people;
        row.depth = people.reduce((a, b) => a + b.d, 0) / people.length;
        // Баннер фанатов в некоторых рядах (держат над головами).
        const horiz = people.length > 8 && Math.abs(people[people.length - 1].x - people[0].x) > Math.abs(people[people.length - 1].y - people[0].y) * 3;
        if (horiz && i >= 1 && i <= 5 && rnd() < 0.5) {
          const k0 = 1 + ((rnd() * (people.length - 7)) | 0);
          const a = people[k0], b = people[k0 + 4];
          const text = tl(FAN_BANNERS[(rnd() * FAN_BANNERS.length) | 0]);
          const col = ['#ff3d6e', '#ffd23f', '#2fc4ff', '#ffffff', '#7a5cff'][(rnd() * 5) | 0];
          row.banners.push({ a, b, text, col, tex: bannerTex(text, col), ph: rnd() * 6 });
        }
        rows.push(row);
      }
    }
    rows.sort((a, b) => b.depth - a.depth);
    A.rows = rows;
    A.crowdCount = rows.reduce((n, r) => n + r.people.length, 0);
    buildAtlas();
  }

  /**
   * Атлас спрайтов зрителей: для каждой пары (внешность, ряд) — сидит / руки вверх.
   * Один drawImage на зрителя — в разы дешевле сотен мелких контуров.
   */
  function buildAtlas() {
    const umax = new Map();
    for (const row of A.rows) for (const p of row.people) umax.set(p.lv, Math.max(umax.get(p.lv) || 0, p.s * p.tall));
    const used = new Map();
    for (const row of A.rows) for (const p of row.people) {
      const key = p.look + ':' + p.lv;
      if (!used.has(key)) used.set(key, { look: p.look, lv: p.lv, haze: p.haze });
    }
    const dpr = A.dpr, OVER = 1.12;
    const cells = [];
    for (const [key, u] of used) {
      const U = umax.get(u.lv) * OVER;
      cells.push({ key, ...u, U, w: Math.ceil(0.95 * U * dpr) + 2, h: Math.ceil(1.0 * U * dpr) + 2 });
    }
    // Простая упаковка по полкам.
    const MAXW = 2048;
    let x = 0, y = 0, shelf = 0;
    for (const c of cells) {
      if (x + c.w * 2 > MAXW) { x = 0; y += shelf; shelf = 0; }
      c.x = x; c.y = y; x += c.w * 2; shelf = Math.max(shelf, c.h);
    }
    const AW = MAXW, AH = Math.max(1, y + shelf);
    if (!A.atlas) A.atlas = makeCanvas(1, 1);
    A.atlas.width = AW; A.atlas.height = AH;
    const c = A.atlas.getContext('2d');
    c.clearRect(0, 0, AW, AH);
    const map = new Map();
    for (const cell of cells) {
      const L = CROWD_LOOKS[cell.look], hz = cell.haze;
      const col = {
        shirt: mix(L.shirt, PAL.haze, hz), shade: mix(mix(L.shirt, '#2a1f5a', 0.35), PAL.haze, hz),
        skin: mix(L.skin, PAL.haze, hz * 0.8), hair: mix(L.hair, PAL.haze, hz * 0.8),
      };
      const uPx = cell.U * dpr;
      for (let pose = 0; pose < 2; pose++) {
        const ox = cell.x + pose * cell.w;
        c.setTransform(1, 0, 0, 1, 0, 0);
        drawPerson(c, ox + cell.w / 2, cell.y + cell.h - 1 - 0.03 * uPx, uPx, col, pose === 1);
      }
      map.set(cell.key, { x: cell.x, y: cell.y, w: cell.w, h: cell.h, U: cell.U });
    }
    for (const row of A.rows) for (const p of row.people) p.spr = map.get(p.look + ':' + p.lv);
  }

  /** Один зритель (cel: цвет + тень справа), опорная точка — сиденье. */
  function drawPerson(c, x, y, u, col, armsUp) {
    c.lineCap = 'round';
    if (armsUp) {
      c.strokeStyle = col.skin; c.lineWidth = Math.max(1, u * 0.08);
      c.beginPath();
      c.moveTo(x - 0.16 * u, y - 0.42 * u); c.lineTo(x - 0.27 * u, y - 0.84 * u);
      c.moveTo(x + 0.16 * u, y - 0.42 * u); c.lineTo(x + 0.27 * u, y - 0.84 * u);
      c.stroke();
    }
    c.fillStyle = col.shirt;
    c.beginPath();
    c.moveTo(x - 0.22 * u, y); c.lineTo(x - 0.2 * u, y - 0.38 * u);
    c.quadraticCurveTo(x - 0.19 * u, y - 0.47 * u, x - 0.1 * u, y - 0.47 * u);
    c.lineTo(x + 0.1 * u, y - 0.47 * u);
    c.quadraticCurveTo(x + 0.19 * u, y - 0.47 * u, x + 0.2 * u, y - 0.38 * u);
    c.lineTo(x + 0.22 * u, y); c.closePath(); c.fill();
    c.fillStyle = col.shade;
    c.beginPath();
    c.moveTo(x + 0.07 * u, y); c.lineTo(x + 0.09 * u, y - 0.47 * u); c.lineTo(x + 0.1 * u, y - 0.47 * u);
    c.quadraticCurveTo(x + 0.19 * u, y - 0.47 * u, x + 0.2 * u, y - 0.38 * u); c.lineTo(x + 0.22 * u, y); c.closePath(); c.fill();
    // Голова, волосы.
    c.fillStyle = col.skin;
    c.beginPath(); c.arc(x, y - 0.6 * u, 0.12 * u, 0, Math.PI * 2); c.fill();
    c.fillStyle = col.hair;
    c.beginPath(); c.arc(x, y - 0.62 * u, 0.13 * u, Math.PI, 0); c.closePath(); c.fill();
    c.beginPath(); c.arc(x - 0.1 * u, y - 0.6 * u, 0.045 * u, 0, Math.PI * 2); c.arc(x + 0.1 * u, y - 0.6 * u, 0.045 * u, 0, Math.PI * 2); c.fill();
  }

  function bannerTex(text, col) {
    const cw = 256, ch = 56;
    const cv = makeCanvas(cw, ch);
    const c = cv.getContext('2d');
    c.fillStyle = col; c.fillRect(0, 0, cw, ch);
    c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, ch - 8, cw, 8);
    const dark = col === '#ffffff' || col === '#ffd23f';
    c.font = `900 ${Math.round(ch * 0.56)}px ${FONT_DISPLAY}`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    let fs = ch * 0.56;
    while (c.measureText(text).width > cw - 16 && fs > 10) { fs -= 2; c.font = `900 ${Math.round(fs)}px ${FONT_DISPLAY}`; }
    c.lineWidth = 5; c.strokeStyle = dark ? '#ffffff' : '#1b1340'; c.lineJoin = 'round';
    c.strokeText(text, cw / 2, ch / 2 + 1);
    c.fillStyle = dark ? '#1b1340' : '#ffffff';
    c.fillText(text, cw / 2, ch / 2 + 1);
    return cv;
  }

  /** Спокойная толпа — в отдельном кеше (только её прямоугольник). */
  function buildCrowdCache() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const row of A.rows) for (const p of row.people) {
      x0 = Math.min(x0, p.x - p.s * 0.8); x1 = Math.max(x1, p.x + p.s * 0.8);
      y0 = Math.min(y0, p.y - p.s * 1.3); y1 = Math.max(y1, p.y + 2);
    }
    if (!isFinite(x0)) { A.crowdCache = null; return; }
    const dpr = A.dpr;
    const cw = Math.ceil((x1 - x0) * dpr), ch = Math.ceil((y1 - y0) * dpr);
    if (!A.crowdCache) A.crowdCache = makeCanvas(1, 1);
    A.crowdCache.width = Math.max(1, cw); A.crowdCache.height = Math.max(1, ch);
    const c = A.crowdCache.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const hype = A.hype, wave = A.wave;
    A.hype = 0; A.wave = 0;
    drawCrowd(c, { k: 1, tx: -x0, ty: -y0, dpr }, 0, null, true);
    A.hype = hype; A.wave = wave;
    A.crowdBox = { x: x0, y: y0, w: cw / dpr, h: ch / dpr };
    // Свечение/дымка поверх толпы: отдельный маленький слой (для «живой» толпы)
    // и сразу запекаем его в спокойную толпу.
    const gs = A.glowScale;
    const gw = Math.max(1, Math.ceil(A.crowdBox.w * gs)), gh = Math.max(1, Math.ceil(A.crowdBox.h * gs));
    if (!A.crowdGlow) A.crowdGlow = makeCanvas(1, 1);
    A.crowdGlow.width = gw; A.crowdGlow.height = gh;
    const gc = A.crowdGlow.getContext('2d');
    gc.drawImage(A.glow, (x0 + A.M.x) * gs, (y0 + A.M.y) * gs, gw, gh, 0, 0, gw, gh);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'screen';
    c.drawImage(A.crowdGlow, 0, 0, gw, gh, 0, 0, cw, ch);
    c.globalCompositeOperation = 'source-over';
  }
  function crowdLive() { return A.hype > 0.12 || A.wave || A.jumpT > 0; }

  A.cheer = function (level, opts = {}) {
    A.hype = Math.max(A.hype, clamp(level, 0, 1));
    if (opts.team != null) A.hypeTeam = opts.team;
    if (opts.jump) A.jumpT = Math.max(A.jumpT, opts.jump);
    if (opts.wave) { A.wave = 1; A.waveT = 0; }
    if (opts.text) ledEvent(opts.text, opts.color || '#ffd23f', opts.life || 2.2);
  };

  A.update = function (dt) {
    A.hype = Math.max(0, A.hype - dt * 0.28);
    A.jumpT = Math.max(0, A.jumpT - dt);
    if (A.wave) { A.waveT += dt; if (A.waveT > 5) A.wave = 0; }
    const led = A.led;
    // Реклама листается «страницами» (короткий сдвиг раз в несколько секунд) — слой бортов
    // перерисовывается только во время сдвига; событие — бегущая строка.
    if (led.mode === 'ads') {
      led.pt = (led.pt || 0) + dt;
      const PAGE = LED_CYCLE / BRANDS.length, HOLD = 3.6, SLIDE = 0.45;
      if (led.pt > HOLD + SLIDE) { led.pt = 0; led.page = ((led.page || 0) + 1) % BRANDS.length; }
      const k = led.pt > HOLD ? (led.pt - HOLD) / SLIDE : 0;
      const e = k * k * (3 - 2 * k);
      led.scroll = ((led.page || 0) + e) * PAGE;
    } else {
      led.scroll += dt * 3.2;
      if ((led.t += dt) > led.life) { led.mode = 'ads'; led.pt = 0; led.scroll = (led.page || 0) * LED_CYCLE / BRANDS.length; }
    }
  };

  function drawCrowd(ctx, V, time, game, reduced) {
    const k = V.k, tx = V.tx, ty = V.ty;
    const hype = A.hype;
    const jumpAmp = reduced ? 0.25 : 1;
    const colors = game && game.players ? teamColors(game) : ['#ffd23f', '#4fd8ff'];
    const waveX = A.wave ? (A.waveT * 2.6 - 3.5) : -99;
    for (const row of A.rows) {
      // Позиция/поза каждого (одна формула на кадр).
      for (const p of row.people) {
        const u = p.s * k;
        const cheer = hype * p.react;
        let lift = 0;
        if (cheer > 0.15) lift = Math.abs(Math.sin(time * (5 + p.react * 3) + p.ph)) * cheer * 0.22 * jumpAmp * (A.jumpT > 0 ? 1.6 : 1);
        let stand = 0;
        if (waveX > -90) { const dw = p.wavePos - waveX; stand = Math.exp(-dw * dw * 2.5); }
        p._u = u; p._x = p.x * k + tx; p._y = p.y * k + ty - (lift + stand * 0.28) * u;
        p._arms = Math.max(cheer > 0.25 ? 1 : 0, stand > 0.4 ? 1 : 0);
        p._sway = Math.sin(time * 2.2 + p.ph) * (0.15 + cheer * 0.6);
      }
      // Спрайты зрителей.
      const atlas = A.atlas, dprA = A.dpr;
      for (const p of row.people) {
        const sp = p.spr; if (!sp) continue;
        const sc = (p._u * p.tall) / sp.U / dprA;   // спрайт → экран
        const sw = sp.w * sc, sh = sp.h * sc;
        const sway = p._arms ? p._sway * 0.05 * p._u : 0;
        ctx.drawImage(atlas, sp.x + (p._arms ? sp.w : 0), sp.y, sp.w, sp.h, p._x - sw / 2 + sway, p._y - sh + 0.03 * sp.U * sc * dprA + sc, sw, sh);
      }
      // Световые палочки (цвет «своего» игрока) и флажки — пакетами по цвету.
      const glowOn = hype > 0.12 || A.wave;
      for (let fan = 0; fan < 2; fan++) {
        ctx.strokeStyle = colors[fan]; ctx.fillStyle = colors[fan];
        ctx.lineWidth = Math.max(1.2, row.people[0]._u * 0.07);
        if (glowOn) {
          ctx.beginPath();
          for (const p of row.people) {
            if (!p.stick || p.fan !== fan) continue;
            const u = p._u * p.tall, x = p._x + 0.2 * u, y = p._y - 0.4 * u, ang = -1.2 + p._sway * 1.4;
            ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * 0.5 * u, y + Math.sin(ang) * 0.5 * u);
          }
          ctx.stroke();
        }
        ctx.beginPath();
        for (const p of row.people) {
          if (!p.flag || p.fan !== fan) continue;
          const u = p._u * p.tall, x = p._x + 0.2 * u, y = p._y - 0.4 * u, ang = -1.2 + p._sway * (glowOn ? 1.4 : 0.4);
          const ex = x + Math.cos(ang) * 0.5 * u, ey = y + Math.sin(ang) * 0.5 * u;
          const fw = Math.sin(time * 6 + p.ph) * 0.06 * u;
          ctx.moveTo(ex, ey); ctx.lineTo(ex + 0.42 * u, ey + 0.08 * u + fw); ctx.lineTo(ex, ey + 0.26 * u); ctx.closePath();
        }
        ctx.fill();
      }
      ctx.strokeStyle = '#e8e4ff'; ctx.lineWidth = Math.max(1, row.people[0]._u * 0.04);
      ctx.beginPath();
      for (const p of row.people) {
        if (!p.flag) continue;
        const u = p._u * p.tall, x = p._x + 0.2 * u, y = p._y - 0.4 * u, ang = -1.2 + p._sway * (glowOn ? 1.4 : 0.4);
        ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * 0.5 * u, y + Math.sin(ang) * 0.5 * u);
      }
      ctx.stroke();
      // Баннеры фанатов.
      for (const bn of row.banners) {
        const a = bn.a, b = bn.b;
        const u = (a._u + b._u) / 2;
        const ya = Math.min(a._y, b._y) - 0.78 * u, h = 0.36 * u;
        const x0 = Math.min(a._x, b._x) - 0.1 * u, x1 = Math.max(a._x, b._x) + 0.1 * u;
        const wob = 0.03 * u * (1 + hype * 1.5);
        // Полосы с плавно меняющейся высотой — ткань колышется без разрывов.
        const N = 8, tw = bn.tex.width, th = bn.tex.height;
        for (let j = 0; j < N; j++) {
          const sx = (tw / N) * j, dx = x0 + (x1 - x0) * j / N;
          const off = Math.sin(time * 3 + bn.ph + j * 0.45) * wob;
          ctx.drawImage(bn.tex, sx, 0, tw / N, th, dx, ya + off, (x1 - x0) / N + 0.6, h);
        }
      }
    }
    // Свечение палочек на пике.
    if (hype > 0.3 && !reduced) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, hype * 0.5);
      for (let fan = 0; fan < 2; fan++) {
        ctx.fillStyle = colors[fan];
        ctx.beginPath();
        for (const row of A.rows) for (const p of row.people) {
          if (!p.stick || p.fan !== fan) continue;
          const x = p._x + 0.32 * p._u, y = p._y - 0.82 * p._u, r = 0.2 * p._u;
          ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function teamColors(game) {
    // Дальняя половина трибун «болеет» за соперника, ближняя — за человека (по цвету героя).
    const humanTeam = game.human ? game.human.team : 0;
    const a = game.players.find(p => p.team === humanTeam), b = game.players.find(p => p.team !== humanTeam);
    return [(b && b.color) || '#4fd8ff', (a && a.color) || '#ffd23f'];
  }

  // ------------------------------------------------------------ LED-борта
  const LED_PX = 48;   // пикселей текстуры на метр
  const LED_CYCLE = 24; // м — период рекламы
  function buildLedAds() {
    const cw = (LED_CYCLE + 2) * LED_PX, ch = Math.round(HALL.BOARD_H * LED_PX);
    const cv = makeCanvas(cw, ch);
    const c = cv.getContext('2d');
    const seg = LED_CYCLE / BRANDS.length;
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < BRANDS.length; i++) {
        const x = (rep * LED_CYCLE + i * seg) * LED_PX;
        if (x > cw) break;
        drawBrand(c, BRANDS[i], x, seg * LED_PX, ch);
      }
    }
    return cv;
  }
  function drawBrand(c, b, x, w, h) {
    c.fillStyle = b.bg; c.fillRect(x, 0, w, h);
    // Косой акцент.
    c.fillStyle = 'rgba(255,255,255,0.16)';
    c.beginPath(); c.moveTo(x + w * 0.72, 0); c.lineTo(x + w * 0.86, 0); c.lineTo(x + w * 0.78, h); c.lineTo(x + w * 0.64, h); c.closePath(); c.fill();
    c.fillStyle = b.fg; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = `900 ${Math.round(h * 0.5)}px ${FONT_DISPLAY}`;
    const tw = c.measureText(b.t).width;
    c.font = `600 ${Math.round(h * 0.24)}px ${FONT_DISPLAY}`;
    const sw = c.measureText(b.s).width;
    const total = tw + 10 + sw;
    let cx = x + (w - total) / 2;
    c.font = `900 ${Math.round(h * 0.5)}px ${FONT_DISPLAY}`;
    c.fillText(b.t, cx, h * 0.54);
    c.font = `600 ${Math.round(h * 0.24)}px ${FONT_DISPLAY}`;
    c.globalAlpha = 0.85; c.fillText(b.s, cx + tw + 10, h * 0.6); c.globalAlpha = 1;
    // Разделитель между рекламами.
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x, 0, 2, h);
  }
  function ledEvent(text, color, life) {
    text = tl(text);
    const key = text + color;
    if (A.ledEvKey !== key) {
      const cw = (LED_CYCLE + 2) * LED_PX, ch = Math.round(HALL.BOARD_H * LED_PX);
      const cv = A.ledEvTex && A.ledEvTex.width === cw ? A.ledEvTex : makeCanvas(cw, ch);
      const c = cv.getContext('2d');
      c.clearRect(0, 0, cw, ch);
      c.fillStyle = '#0c0920'; c.fillRect(0, 0, cw, ch);
      c.font = `900 ${Math.round(ch * 0.62)}px ${FONT_DISPLAY}`;
      c.textBaseline = 'middle'; c.textAlign = 'center';
      const step = 6 * LED_PX;
      for (let x = step / 2; x < cw; x += step) {
        c.fillStyle = color; c.fillText(text, x, ch * 0.54);
        c.fillStyle = 'rgba(255,255,255,0.5)';
        c.beginPath(); c.moveTo(x + step / 2 - 8, ch / 2); c.lineTo(x + step / 2, ch * 0.2); c.lineTo(x + step / 2 + 8, ch / 2); c.lineTo(x + step / 2, ch * 0.8); c.closePath(); c.fill();
      }
      // LED-сетка (точечная структура).
      c.fillStyle = 'rgba(0,0,0,0.28)';
      for (let y = 0; y < ch; y += 4) c.fillRect(0, y, cw, 1);
      A.ledEvTex = cv; A.ledEvKey = key;
    }
    A.led.mode = 'event'; A.led.t = 0; A.led.life = life;
  }

  function buildBoards(P) {
    // Сегменты по 2 м: на каждом своя аффинная проекция текстуры.
    const segs = [];
    let u = 0;
    const SEG = 2;
    for (const sd of sides()) {
      const d = sd.d0, H = HALL.BOARD_H;
      const t0 = sd.axis === 'x' ? -HALL.YB : -HALL.XB, t1 = -t0;
      if (!sd.visible) { u += t1 - t0; continue; }
      // Текст должен идти слева направо на экране: если ось борта идёт справа налево — отражаем выборку.
      const pa = P(...W(sd, d, t0, 0)), pb = P(...W(sd, d, t1, 0));
      const flip = pb.x < pa.x;
      for (let t = t0; t < t1 - 1e-6; t += SEG) {
        const te = Math.min(t1, t + SEG);
        const w0 = W(sd, d, t, 0), w1 = W(sd, d, te, 0), w2 = W(sd, d, t, H), w3 = W(sd, d, te, H);
        const p0 = P(...w0), p1 = P(...w1), p2 = P(...w2), p3 = P(...w3);
        if (p0.d < 0.8 || p1.d < 0.8 || p2.d < 0.8) continue;
        const minx = Math.min(p0.x, p1.x, p2.x), maxx = Math.max(p0.x, p1.x, p2.x);
        const miny = Math.min(p0.y, p1.y, p2.y), maxy = Math.max(p0.y, p1.y, p2.y);
        if (maxx < -40 || minx > A.w + 40 || maxy < -40 || miny > A.h + 40) continue;
        segs.push(flip
          ? { p0: p1, p1: p0, p2: p3, len: te - t, u: u + (t1 - te) }
          : { p0, p1, p2, len: te - t, u: u + (t - t0) });
      }
      u += t1 - t0;
    }
    A.boards = segs;
  }

  /** Статичная реклама (между перелистываниями) — запекаем в копию фонового кеша. */
  function ledStatic() { return A.led.mode === 'ads' && !(A.led.pt > 3.6); }
  function compCache() {
    const sig = A.key + '|' + (A.led.page || 0);
    if (A.comp && A.compSig === sig) return A.comp;
    if (!A.comp) A.comp = makeCanvas(1, 1);
    if (A.comp.width !== A.cache.width || A.comp.height !== A.cache.height) { A.comp.width = A.cache.width; A.comp.height = A.cache.height; }
    const c = A.comp.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(A.cache, 0, 0);
    if (A.ledTex) paintBoards(c, A.ledTex, 1, A.M.x, A.M.y, A.dpr);
    c.setTransform(1, 0, 0, 1, 0, 0);
    A.compSig = sig;
    return A.comp;
  }

  function paintBoards(ctx, tex, k, tx, ty, dpr) {
    const th = tex.height;
    for (const s of A.boards) {
      let u = (s.u + A.led.scroll) % LED_CYCLE; if (u < 0) u += LED_CYCLE;
      const ax = s.p0.x * k + tx, ay = s.p0.y * k + ty;
      const bx = s.p1.x * k + tx, by = s.p1.y * k + ty;
      const cx = s.p2.x * k + tx, cy = s.p2.y * k + ty;
      const sw = s.len * LED_PX;
      // (0,0) текстуры → верх-лево борта C; ось x → вдоль A→B; ось y (вниз) → от C к A.
      const m11 = (bx - ax) / sw, m12 = (by - ay) / sw;
      const m21 = (ax - cx) / th, m22 = (ay - cy) / th;
      ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22, dpr * cx, dpr * cy);
      ctx.drawImage(tex, u * LED_PX, 0, sw + 0.6, th, 0, 0, sw + 0.6, th);
    }
  }

  function drawBoards(ctx, V, reduced) {
    if (ledStatic()) return;   // уже в composite-кеше
    const tex = A.led.mode === 'event' ? A.ledEvTex : A.ledTex;
    if (!tex) return;
    const flash = A.led.mode === 'event' && !reduced ? 0.75 + 0.25 * Math.sin(A.led.t * 18) : 1;
    ctx.save();
    ctx.globalAlpha = flash;
    paintBoards(ctx, tex, V.k, V.tx, V.ty, V.dpr);
    ctx.restore();
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  }


  // ------------------------------------------------------------ свечение
  function drawGlowLayer(g, P, CW, CH) {
    g.clearRect(0, 0, CW, CH);
    // Яркая «засветка» сверху (лампы за кадром) — живописная дымка.
    const top = g.createLinearGradient(0, 0, 0, CH * 0.55);
    top.addColorStop(0, 'rgba(255,236,200,0.55)'); top.addColorStop(0.35, 'rgba(200,180,255,0.16)'); top.addColorStop(1, 'rgba(200,180,255,0)');
    g.fillStyle = top; g.fillRect(0, 0, CW, CH * 0.55);
    // Световые столбы: от ламп (выше кадра) к полу.
    const e = A.cam.eye;
    g.globalCompositeOperation = 'lighter';
    for (const Lm of lamps()) {
      const p = P(Lm[0], Lm[1], Lm[2]);
      const f = P(Lm[0] * 1.08, Lm[1] * 1.15, 0);
      if (p.d < 0.6 || f.d < 0.6) continue;
      // Если лампа ниже экрана (за камерой) — берём верх экрана.
      let lx = p.x, ly = Math.min(p.y, -CH * 0.05);
      if (p.d < 2) { lx = f.x + (f.x - CW / 2) * 0.2; ly = -CH * 0.1; }
      const fw = f.s * 1.6, lw = f.s * 0.25;
      const grad = g.createLinearGradient(lx, ly, f.x, f.y);
      grad.addColorStop(0, 'rgba(255,240,205,0.34)'); grad.addColorStop(0.55, 'rgba(255,240,205,0.11)'); grad.addColorStop(1, 'rgba(255,240,205,0)');
      g.fillStyle = grad;
      g.beginPath(); g.moveTo(lx - lw, ly); g.lineTo(lx + lw, ly); g.lineTo(f.x + fw, f.y); g.lineTo(f.x - fw, f.y); g.closePath(); g.fill();
      void e;
    }
    // Мягкие блики-«боке» над трибунами.
    const rnd = mulberry(3);
    for (let i = 0; i < 14; i++) {
      const x = rnd() * CW, y = rnd() * CH * 0.3, r = 10 + rnd() * 26;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      const col = rnd() < 0.5 ? '255,220,170' : '190,170,255';
      rg.addColorStop(0, `rgba(${col},0.22)`); rg.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ отрисовка
  A.drawBack = function (ctx, V, time, game, reduced) {
    if (!A.cache) return;
    const { k, tx, ty, dpr } = V;
    ctx.save();
    let ox = tx - A.M.x * k, oy = ty - A.M.y * k;
    if (Math.abs(k - 1) < 1e-4) { ox = Math.round(ox * dpr) / dpr; oy = Math.round(oy * dpr) / dpr; }
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    const bg = ledStatic() ? compCache() : A.cache;
    ctx.drawImage(bg, 0, 0, A.cache.width / dpr, A.cache.height / dpr);
    if (A.crowdCache && !crowdLive()) {
      const b = A.crowdBox;
      ctx.drawImage(A.crowdCache, b.x + A.M.x, b.y + A.M.y, b.w, b.h);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCrowd(ctx, V, time, game, reduced);
      if (A.crowdGlow) {
        const b = A.crowdBox;
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(A.crowdGlow, b.x * k + tx, b.y * k + ty, b.w * k, b.h * k);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    drawBoards(ctx, V, reduced);
    ctx.restore();
  };

  /** Свечение запечено в кеш; оставлено для совместимости (ничего не делает). */
  A.drawGlow = function () {};
  A._drawGlowLive = function (ctx, V, alpha = 1) {
    if (!A.glow) return;
    const { k, tx, ty, dpr } = V;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.85 * alpha;
    const ox = tx - A.M.x * k, oy = ty - A.M.y * k;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.drawImage(A.glow, 0, 0, A.glow.width / A.glowScale, A.glow.height / A.glowScale);
    ctx.restore();
  };

  // ------------------------------------------------------------ судейская вышка и табло
  /** Объекты у корта, которые нужно сортировать с игроками по глубине. */
  A.courtItems = function (ctx, project, game) {
    const fy = A.farY;
    const items = [];
    const chairY = fy * 4.35;
    items.push({ d: project(0, chairY, 1).d, draw: () => drawChair(ctx, project, chairY, game) });
    const sbX = A.portrait ? -A.s * 1.4 : A.s * 1.7, sbY = A.portrait ? fy * 3.9 : fy * 4.25;
    items.push({ d: project(sbX, sbY, 0.5).d, draw: () => drawScoreTablet(ctx, project, sbX, sbY, game) });
    return items;
  };

  function poly(ctx, project, pts, fill) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { const q = project(pts[i][0], pts[i][1], pts[i][2]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  function bar(ctx, project, a, b, w, col) {
    const p = project(...a), q = project(...b);
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, w * (p.s + q.s) / 2);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  function drawChair(ctx, project, y0, game) {
    const sy = Math.sign(y0);
    const out = sy * 0.3;   // ножки шире наружу
    const legCol = '#e8ecf6', dark = '#2b2860';
    ctx.lineCap = 'round';
    // Тень.
    const sp = project(0, y0, 0);
    ctx.fillStyle = 'rgba(10,20,30,0.28)';
    ctx.beginPath(); ctx.ellipse(sp.x, sp.y, 0.6 * sp.s, 0.25 * sp.s, 0, 0, Math.PI * 2); ctx.fill();
    // Ножки (стремянка).
    for (const dx of [-0.32, 0.32]) {
      bar(ctx, project, [dx, y0 - out, 0], [dx * 0.8, y0, 1.55], 0.05, legCol);
      bar(ctx, project, [dx, y0 + out + sy * 0.25, 0], [dx * 0.8, y0 + sy * 0.25, 1.55], 0.05, legCol);
    }
    for (const z of [0.5, 1.0]) bar(ctx, project, [-0.3, y0 - out * (1 - z / 1.6), z], [0.3, y0 - out * (1 - z / 1.6), z], 0.04, legCol);
    // Сиденье + спинка.
    poly(ctx, project, [[-0.3, y0 - 0.05, 1.55], [0.3, y0 - 0.05, 1.55], [0.3, y0 + sy * 0.35, 1.55], [-0.3, y0 + sy * 0.35, 1.55]], '#3d64d8');
    poly(ctx, project, [[-0.3, y0 + sy * 0.35, 1.55], [0.3, y0 + sy * 0.35, 1.55], [0.3, y0 + sy * 0.35, 2.1], [-0.3, y0 + sy * 0.35, 2.1]], '#2f4fb4');
    // Судья: сидящий силуэт (пиджак, голова) — смотрит на корт.
    const hip = project(0, y0 + sy * 0.15, 1.62), sh = project(0, y0 + sy * 0.12, 2.12), head = project(0, y0 + sy * 0.1, 2.3);
    ctx.strokeStyle = dark; ctx.lineWidth = Math.max(3, 0.34 * hip.s);
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(sh.x, sh.y); ctx.stroke();
    // Ноги вниз-вперёд.
    const knee = project(0, y0 - sy * 0.25, 1.6), foot = project(0, y0 - sy * 0.3, 1.15);
    ctx.lineWidth = Math.max(2, 0.14 * hip.s); ctx.strokeStyle = '#1d1b45';
    ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(knee.x, knee.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
    ctx.fillStyle = '#f0c9a4';
    ctx.beginPath(); ctx.arc(head.x, head.y, Math.max(2, 0.12 * head.s), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a1d16';
    ctx.beginPath(); ctx.arc(head.x, head.y - 0.03 * head.s, Math.max(2, 0.12 * head.s), Math.PI, 0); ctx.fill();
    // Галстук-акцент.
    ctx.fillStyle = '#ff3d6e';
    ctx.beginPath(); ctx.arc(sh.x, sh.y + 0.06 * sh.s, Math.max(1, 0.035 * sh.s), 0, Math.PI * 2); ctx.fill();
    void game;
  }

  function drawScoreTablet(ctx, project, x0, y0, game) {
    const m = game && game.match;
    const H = 1.05, hw = 0.55;
    const sy = Math.sign(y0);
    // Стойка.
    bar(ctx, project, [x0, y0 + sy * 0.1, 0], [x0, y0 + sy * 0.1, H - 0.3], 0.06, '#d8dcef');
    // Панель: лицом к камере (плоскость y = const), чуть наклонена.
    // Панель лицом к камере: в альбоме — вдоль x, в портрете — вдоль y.
    const pt = (a, up) => A.portrait
      ? project(x0 + A.s * 0.08 * up, y0 + a, H - 0.32 + 0.5 * up)
      : project(x0 + a, y0 + sy * 0.08 * up, H - 0.32 + 0.5 * up);
    const c0 = pt(-hw, 0), c1 = pt(hw, 0), c2 = pt(-hw, 1);
    const flip = c1.x < c0.x;
    const L = flip ? c1 : c0, R = flip ? c0 : c1;
    const T = flip ? pt(hw, 1) : c2;
    ctx.save();
    const sw = 200, sh = 92;
    ctx.transform((R.x - L.x) / sw, (R.y - L.y) / sw, (T.x - L.x) / sh, (T.y - L.y) / sh, L.x, L.y);
    // Локальные координаты: (0,0) — низ-лево, y вверх отрицательный → переворачиваем.
    ctx.scale(1, -1);
    ctx.translate(0, -sh);
    ctx.fillStyle = '#141233'; roundRect(ctx, 0, 0, sw, sh, 10); ctx.fill();
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 4; roundRect(ctx, 2, 2, sw - 4, sh - 4, 9); ctx.stroke();
    if (m) {
      const humanTeam = game.human ? game.human.team : 0;
      // Человек — со своей стороны (слева/справа по экрану).
      const hx = project(game.human ? game.human.side * 3 : -3, 0, 0).x;
      const ox = project((game.human ? -game.human.side : 3) * 3, 0, 0).x;
      const leftTeam = A.portrait || hx < ox ? humanTeam : 1 - humanTeam;
      const teams = [leftTeam, 1 - leftTeam];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `900 54px ${FONT_DISPLAY}`;
      for (let i = 0; i < 2; i++) {
        const t = teams[i];
        const pl = game.players.find(p => p.team === t);
        ctx.fillStyle = (pl && pl.color) || '#fff';
        ctx.fillRect(i ? sw / 2 + 8 : 12, 12, sw / 2 - 20, 8);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(m.score[t]), i ? sw * 0.75 : sw * 0.25, sh * 0.58);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(sw / 2 - 1.5, 26, 3, sh - 40);
    }
    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  return A;
}
