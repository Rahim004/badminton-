/**
 * render/characters/head.js — аниме-голова: череп с подбородком, причёска из «шапочек»
 * и прядей, лицо с эмоциями. Рисуется в локальной системе головы, отображённой на экран
 * ортографически (голова маленькая — перспективой внутри неё можно пренебречь).
 *
 * H — базис головы на экране:
 *   {x, y}  — центр черепа (px), r — радиус черепа (px),
 *   R, U, F — экранные образы единичных осей головы (вправо, вверх, вперёд), уже умноженные на r:
 *             {x, y} — смещение в px, t — компонента «к камере» (-1..1).
 * face  — {mood: 'calm'|'focus'|'shout'|'happy'|'sad'|'effort', blink: 0..1, gaze: [x,y]}
 * dyn   — вторичная динамика в локальных единицах: {lag:[x,y,z], tail:[[x,y,z]...], ribbons:[[...],[...]]}
 * o     — {ol, lod: 0|1|2, inkOnly}
 *
 * API: drawHead(ctx, H, look, face, dyn, o), headBasis(x, y, r, yaw, pitch) — базис для портретов.
 */
import { INK, LX, LY, tone } from './paint.js';

const v3 = {
  norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  madd: (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
};

/** Базис для портрета/кат-ина: yaw > 0 — поворот лица вправо по экрану, pitch > 0 — вниз. */
export function headBasis(x, y, r, yaw = 0.35, pitch = 0.08) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // мир портрета: экран x вправо, y вниз, t — к зрителю
  const R = { x: cy * r, y: 0, t: -sy };
  const F = { x: sy * cp * r, y: sp * r, t: cy * cp };
  const U = { x: sy * sp * r, y: -cp * r, t: cy * sp };
  return { x, y, r, R, U, F };
}

function mapP(H, p) {
  return { x: H.x + p[0] * H.R.x + p[1] * H.U.x + p[2] * H.F.x, y: H.y + p[0] * H.R.y + p[1] * H.U.y + p[2] * H.F.y, t: p[0] * H.R.t + p[1] * H.U.t + p[2] * H.F.t };
}
function mapV(H, p) { return { x: p[0] * H.R.x + p[1] * H.U.x + p[2] * H.F.x, y: p[0] * H.R.y + p[1] * H.U.y + p[2] * H.F.y }; }

// ------------------------------------------------------------------ формы
function headPath(ctx, H, chinK) {
  const C = mapP(H, [0, -1.08 * chinK, 0.5]);
  const dx = C.x - H.x, dy = C.y - H.y, d = Math.hypot(dx, dy);
  if (ctx.beginPath) ctx.beginPath();
  if (d <= H.r * 1.01) { ctx.arc(H.x, H.y, H.r, 0, Math.PI * 2); return; }
  const phi = Math.atan2(dy, dx), del = Math.acos(H.r / d);
  ctx.arc(H.x, H.y, H.r, phi + del, phi - del + Math.PI * 2);
  // мягкий подбородок
  const a = { x: H.x + Math.cos(phi - del) * H.r, y: H.y + Math.sin(phi - del) * H.r };
  const b = { x: H.x + Math.cos(phi + del) * H.r, y: H.y + Math.sin(phi + del) * H.r };
  ctx.quadraticCurveTo(a.x + (C.x - a.x) * 0.75, a.y + (C.y - a.y) * 0.75, C.x, C.y);
  ctx.quadraticCurveTo(b.x + (C.x - b.x) * 0.75, b.y + (C.y - b.y) * 0.75, b.x, b.y);
  ctx.closePath();
}

/** Широта линии роста волос на азимуте phi (0 — лоб, pi/2 — правый висок). */
function hairLat(cap, phi) { const c = Math.cos(phi); return cap.s + ((c >= 0 ? cap.f : cap.b) - cap.s) * c * c; }

/** Видимая часть массы волос (всё выше линии роста) на сфере радиуса sc. */
function capPath(ctx, H, v, cap, sc) {
  const N = 32, pts = [], fac = [];
  for (let k = 0; k < N; k++) {
    const phi = k / N * Math.PI * 2, lat = hairLat(cap, phi), cl = Math.cos(lat);
    const q = [cl * Math.sin(phi), Math.sin(lat), cl * Math.cos(phi)];
    pts.push(mapP(H, v3.scale(q, sc))); fac.push(v3.dot(q, v));
  }
  const inV = Math.asin(Math.max(-1, Math.min(1, v[1]))) > hairLat(cap, Math.atan2(v[0], v[2]));
  const vis = fac.filter(f => f > 0).length;
  const R = H.r * sc;
  if (ctx.beginPath) ctx.beginPath();
  if (vis === N || vis === 0) {
    if (vis === N) {
      if (!inV) ctx.arc(H.x, H.y, R, 0, Math.PI * 2);
      ctx.moveTo(pts[0].x, pts[0].y); for (let k = 1; k < N; k++) ctx.lineTo(pts[k].x, pts[k].y); ctx.closePath();
      return inV ? 'nonzero' : 'evenodd';
    }
    if (inV) { ctx.arc(H.x, H.y, R, 0, Math.PI * 2); return 'nonzero'; }
    return null;
  }
  // начало видимой дуги: переход из невидимого в видимое
  let k0 = 0;
  for (let k = 0; k < N; k++) if (fac[k] > 0 && fac[(k + N - 1) % N] <= 0) { k0 = k; break; }
  const cross = (i, j) => { const f = fac[i] / (fac[i] - fac[j]); return { x: pts[i].x + (pts[j].x - pts[i].x) * f, y: pts[i].y + (pts[j].y - pts[i].y) * f }; };
  const start = cross((k0 + N - 1) % N, k0);
  ctx.moveTo(start.x, start.y);
  let k = k0, guard = 0;
  while (fac[k] > 0 && guard++ < N) { ctx.lineTo(pts[k].x, pts[k].y); k = (k + 1) % N; }
  const end = cross((k + N - 1) % N, k);
  ctx.lineTo(end.x, end.y);
  // дуга силуэта через сторону макушки
  const a = [0, 1, 0];
  const w = v3.madd(a, v, -v3.dot(a, v));
  const wl = Math.hypot(w[0], w[1], w[2]) || 1;
  const W = mapV(H, v3.scale(w, (inV ? 1 : 1) / wl));
  const as = Math.atan2(start.y - H.y, start.x - H.x), ae = Math.atan2(end.y - H.y, end.x - H.x), aw = Math.atan2(W.y, W.x);
  const TAU = Math.PI * 2, md = x => ((x % TAU) + TAU) % TAU;
  const cw = md(aw - ae) < md(as - ae);
  ctx.arc(H.x, H.y, R, ae, as, !cw);
  ctx.closePath();
  return 'nonzero';
}

/** Чёлка: ряд прядей вдоль линии лба (генерируется один раз на внешность). */
function fringeLocks(look) {
  if (look._fringe) return look._fringe;
  const F = look.fringe, out = [];
  if (F) {
    const cap = look.caps[look.caps.length - 1];
    for (let i = 0; i < F.n; i++) {
      const phi = F.n === 1 ? 0 : -F.spread + 2 * F.spread * i / (F.n - 1);
      const lat = hairLat(cap, phi) + 0.2, cl = Math.cos(lat);
      const r = [cl * Math.sin(phi), Math.sin(lat), cl * Math.cos(phi)];
      const d = [F.sweep + 0.35 * Math.sin(phi), -1, 0.3];
      const k = F.n === 1 ? 1 : 1 - 0.3 * Math.abs(phi) / F.spread;
      out.push({ r, d, l: F.len * k * (i % 2 ? 0.82 : 1), w: F.w, b: F.sweep * 0.25, s: 0.9, blunt: F.blunt, fr: true });
    }
  }
  return (look._fringe = out.concat(look.locks || []));
}

/** Прядь: изогнутый сужающийся клин от корня к кончику. */
function lockGeom(H, L, lag) {
  const r = v3.norm(L.r), d = v3.norm(L.d);
  let side = v3.cross(d, r);
  if (Math.hypot(side[0], side[1], side[2]) < 0.15) side = [1, 0, 0];
  side = v3.norm(side);
  const root = v3.scale(r, 0.98);
  const sw = (L.s || 0.5) * L.l;
  const tip = [root[0] + d[0] * L.l + lag[0] * sw, root[1] + d[1] * L.l + lag[1] * sw, root[2] + d[2] * L.l + lag[2] * sw];
  const w = L.w, bend = (L.b || 0) * L.l;
  const b1 = v3.madd(root, side, w), b2 = v3.madd(root, side, -w);
  const inner = v3.scale(v3.norm([r[0], r[1] + 0.8, r[2] - 0.35]), 0.8);
  const mid = [(root[0] + tip[0]) / 2, (root[1] + tip[1]) / 2, (root[2] + tip[2]) / 2];
  const c1 = v3.madd(v3.madd(mid, side, w * 0.55 + bend), r, 0.06), c2 = v3.madd(v3.madd(mid, side, -w * 0.55 + bend), r, 0.06);
  const g = { b1: mapP(H, b1), b2: mapP(H, b2), c1: mapP(H, c1), c2: mapP(H, c2), in: mapP(H, inner), tip: mapP(H, tip), face: mapP(H, mid).t, blunt: L.blunt };
  if (L.blunt) { g.t1 = mapP(H, v3.madd(tip, side, w * 0.8)); g.t2 = mapP(H, v3.madd(tip, side, -w * 0.8)); g.tm = mapP(H, v3.madd(tip, d, -0.05)); }
  return g;
}
function lockPath(ctx, g) {
  if (ctx.beginPath) ctx.beginPath();
  // ломаная через середины кривых: дёшево растеризуется и даёт угловатые «аниме»-пряди
  const q = (a, c, b) => ({ x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y });
  ctx.moveTo(g.in.x, g.in.y);
  ctx.lineTo(g.b1.x, g.b1.y);
  if (g.blunt) {
    const m1 = q(g.b1, g.c1, g.t1), m2 = q(g.t2, g.c2, g.b2);
    ctx.lineTo(m1.x, m1.y); ctx.lineTo(g.t1.x, g.t1.y);
    ctx.lineTo(g.tm.x, g.tm.y); ctx.lineTo(g.t2.x, g.t2.y);
    ctx.lineTo(m2.x, m2.y); ctx.lineTo(g.b2.x, g.b2.y);
  } else {
    const m1 = q(g.b1, g.c1, g.tip), m2 = q(g.tip, g.c2, g.b2);
    ctx.lineTo(m1.x, m1.y); ctx.lineTo(g.tip.x, g.tip.y); ctx.lineTo(m2.x, m2.y); ctx.lineTo(g.b2.x, g.b2.y);
  }
  ctx.closePath();
}

/** Лента/хвост: сужающаяся полоса по точкам (экран). */
function ribbonPath(ctx, pts, w0, w1, bulge = 0) {
  const n = pts.length, L = [], Rr = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const t = i / (n - 1);
    const w = (w0 + (w1 - w0) * t) * (1 + bulge * Math.sin(Math.PI * Math.min(1, t * 1.6)));
    L.push({ x: pts[i].x + nx * w, y: pts[i].y + ny * w }); Rr.push({ x: pts[i].x - nx * w, y: pts[i].y - ny * w });
  }
  if (ctx.beginPath) ctx.beginPath();
  ctx.moveTo(L[0].x, L[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(L[i].x, L[i].y);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(Rr[i].x, Rr[i].y);
  ctx.closePath();
}

/** Повязка: видимая часть полосы на сфере. */
function bandStrip(H, v) {
  const N = 26, up = [], lo = [], fac = [];
  for (let k = 0; k < N; k++) {
    const t = k / N * Math.PI * 2;
    const lat = 0.3 + 0.16 * Math.cos(t);
    const pt = (h) => { const la = lat + h; return [Math.cos(la) * Math.sin(t) * 1.07, Math.sin(la) * 1.07, Math.cos(la) * Math.cos(t) * 1.07]; };
    const pu = pt(0.13), pl = pt(-0.1);
    up.push(mapP(H, pu)); lo.push(mapP(H, pl)); fac.push(v3.dot(v3.norm(pt(0)), v));
  }
  return { up, lo, fac, N };
}

// ------------------------------------------------------------------ лицо
/** Локальная рамка черты лица на сфере: центр, оси (в px на единицу r). */
function featureFrame(H, p) {
  const e = v3.norm(p);
  let tx = v3.cross([0, 1, 0], e); tx = v3.norm(tx);
  const ty = v3.cross(e, tx);
  const c = mapP(H, e), X = mapV(H, tx), Y = mapV(H, ty);
  return { c, X, Y, face: c.t };
}
function withFrame(ctx, fr, s, fn) {
  ctx.save();
  ctx.transform(fr.X.x * s, fr.X.y * s, -fr.Y.x, -fr.Y.y, fr.c.x, fr.c.y);
  fn();
  ctx.restore();
}

const EYE = {
  calm: { top: -0.155, slant: 0.0, low: 0.13, iris: 1 },
  focus: { top: -0.12, slant: 0.045, low: 0.12, iris: 0.95 },
  effort: { top: -0.1, slant: 0.06, low: 0.11, iris: 0.9 },
  shout: { top: -0.085, slant: 0.085, low: 0.095, iris: 0.8 },
  sad: { top: -0.07, slant: -0.05, low: 0.115, iris: 0.95, dy: 0.04 },
};

function drawEye(ctx, s, mood, blink, look, lod, gaze) {
  const P = EYE[mood] || EYE.calm;
  ctx.fillStyle = INK;
  if (mood === 'happy') {
    // «^» — закрытые от радости глаза
    ctx.beginPath();
    ctx.moveTo(-0.14, 0.07); ctx.quadraticCurveTo(0, -0.17, 0.15, 0.05);
    ctx.quadraticCurveTo(0.0, -0.08, -0.14, 0.07);
    ctx.fill();
    return;
  }
  const open = 1 - blink;
  if (open < 0.25) {
    ctx.beginPath(); ctx.moveTo(-0.13, 0.03); ctx.quadraticCurveTo(0.01, 0.1, 0.16, 0.0); ctx.quadraticCurveTo(0.01, 0.06, -0.13, 0.03); ctx.fill();
    return;
  }
  const top = P.top * open, inY = 0.0 + P.slant, low = P.low;
  // склера
  const sclera = () => {
    ctx.beginPath();
    ctx.moveTo(-0.125, inY);
    ctx.bezierCurveTo(-0.08, top - 0.02 + P.slant * 0.6, 0.08, top - 0.03, 0.15, -0.06 * open);
    ctx.bezierCurveTo(0.15, 0.04, 0.09, low, 0.01, low);
    ctx.bezierCurveTo(-0.07, low, -0.12, 0.06, -0.125, inY);
    ctx.closePath();
  };
  if (lod <= 0) { sclera(); ctx.fill(); return; }
  sclera(); ctx.fillStyle = '#fbfbff'; ctx.fill();
  if (lod < 2) {
    // мелкое лицо: радужка без клипа + блик
    const ix = 0.015, iy = 0.02;
    ctx.fillStyle = look.eyes; ctx.beginPath(); ctx.ellipse(ix, iy, 0.075 * P.iris, 0.1 * P.iris, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#120d1c'; ctx.beginPath(); ctx.ellipse(ix, iy, 0.04, 0.06, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(ix + 0.03, iy - 0.04, 0.034, 0, Math.PI * 2); ctx.fill();
  } else {
  ctx.save(); sclera(); ctx.clip();
  const ix = 0.015 + (gaze ? gaze[0] * 0.03 : 0), iy = 0.025 + (P.dy || 0) + (gaze ? gaze[1] * 0.03 : 0);
  const rx = 0.088 * P.iris, ry = 0.13 * P.iris;
  ctx.fillStyle = look.eyes;
  ctx.beginPath(); ctx.ellipse(ix, iy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = tone(look.eyes, 'deep');
  ctx.beginPath(); ctx.ellipse(ix, iy, rx, ry, 0, Math.PI, Math.PI * 2); ctx.fill();          // тень века на радужке
  ctx.fillStyle = tone(look.eyes, 'light');
  ctx.beginPath(); ctx.ellipse(ix, iy + ry * 0.55, rx * 0.7, ry * 0.32, 0, 0, Math.PI); ctx.fill(); // отражение снизу
  ctx.fillStyle = '#120d1c';
  ctx.beginPath(); ctx.ellipse(ix, iy + 0.005, rx * 0.42, ry * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(ix + 0.035, iy - 0.045, 0.036, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(ix - 0.03, iy + 0.06, 0.016, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  }
  // верхние ресницы — толстая линия с «хвостиком» наружу
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.moveTo(-0.14, inY + 0.01);
  ctx.bezierCurveTo(-0.08, top - 0.04 + P.slant * 0.6, 0.08, top - 0.055, 0.2, -0.1 * open + 0.0);
  ctx.lineTo(0.15, -0.035 * open);
  ctx.bezierCurveTo(0.08, top - 0.0, -0.07, top + 0.02 + P.slant * 0.6, -0.12, inY + 0.035);
  ctx.closePath(); ctx.fill();
  if (lod >= 2) {
    ctx.beginPath(); ctx.moveTo(-0.02, low + 0.0); ctx.quadraticCurveTo(0.07, low + 0.012, 0.12, low - 0.035); ctx.lineTo(0.115, low - 0.02); ctx.quadraticCurveTo(0.06, low - 0.005, -0.02, low + 0.0); ctx.fill();
  }
}

const BROW = { calm: [-0.01, -0.035], focus: [0.045, -0.04], effort: [0.055, -0.03], shout: [0.08, -0.05], happy: [-0.04, -0.03], sad: [-0.08, 0.02] };
function drawBrow(ctx, mood, col) {
  const b = BROW[mood] || BROW.calm;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-0.13, b[0]);
  ctx.quadraticCurveTo(0.0, b[0] + (b[1] - b[0]) * 0.5 - 0.035, 0.16, b[1]);
  ctx.quadraticCurveTo(0.0, b[0] + (b[1] - b[0]) * 0.5 - 0.0, -0.13, b[0] + 0.035);
  ctx.closePath(); ctx.fill();
}

function drawMouth(ctx, mood, lod, talk) {
  ctx.fillStyle = INK;
  const open = (w, h, smile) => {
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.2);
    ctx.quadraticCurveTo(0, -h * 0.35 + smile, w, -h * 0.2);
    ctx.quadraticCurveTo(w * 0.9, h, 0, h);
    ctx.quadraticCurveTo(-w * 0.9, h, -w, -h * 0.2);
    ctx.closePath();
    ctx.fill();
    if (lod >= 1) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#7a1626'; ctx.fillRect(-w, -h, w * 2, h * 2.2);
      ctx.fillStyle = '#ee7286'; ctx.beginPath(); ctx.ellipse(0, h * 0.85, w * 0.6, h * 0.42, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-w, -h * 0.5, w * 2, h * 0.32);
      ctx.restore();
    }
  };
  if (mood === 'shout') return open(0.12, 0.19, 0);
  if (mood === 'happy') return open(0.11, 0.12, 0.03);
  if (mood === 'effort' || talk > 0.3) return open(0.05, 0.07 + 0.03 * talk, 0);
  if (mood === 'sad') {
    // стиснутые зубы
    ctx.beginPath(); ctx.rect(-0.085, -0.035, 0.17, 0.07); ctx.fill();
    if (lod >= 1) { ctx.fillStyle = '#ffffff'; ctx.fillRect(-0.07, -0.022, 0.14, 0.044); ctx.fillStyle = INK; ctx.fillRect(-0.07, -0.004, 0.14, 0.009); }
    return;
  }
  const w = mood === 'focus' ? 0.055 : 0.07, c = mood === 'focus' ? 0.0 : 0.03;
  ctx.beginPath(); ctx.moveTo(-w, 0); ctx.quadraticCurveTo(0, c + 0.025, w, 0); ctx.quadraticCurveTo(0, c - 0.0, -w, 0); ctx.fill();
}

/**
 * Лицо для мелких голов (в игре): без трансформаций и клипов — по 1–2 заливки на слой
 * для обоих глаз сразу. Эмоции читаются по форме глаз, бровей и рта.
 */
function drawFaceSmall(ctx, H, look, face, lod) {
  const mood = face.mood || 'calm', k = 1.5;
  const blink = (face.blink || 0) > 0.6;
  const pInk = new Path2D(), pIris = new Path2D(), pHi = new Path2D(), pBrow = new Path2D(), pLine = new Path2D();
  const at = (fr, s, x, y) => ({ x: fr.c.x + x * s * fr.X.x * k - y * fr.Y.x * k, y: fr.c.y + x * s * fr.X.y * k - y * fr.Y.y * k });
  const open = mood === 'shout' ? 0.55 : mood === 'sad' ? 0.62 : mood === 'focus' || mood === 'effort' ? 0.8 : 1;
  for (const s of [1, -1]) {
    const fr = featureFrame(H, [0.4 * s, -0.16, 0.9]);
    if (fr.face < 0.06) continue;
    const xl = Math.hypot(fr.X.x, fr.X.y) * k, yl = Math.hypot(fr.Y.x, fr.Y.y) * k, rot = Math.atan2(fr.X.y, fr.X.x);
    if (mood === 'happy' || blink) {
      const a = at(fr, s, -0.13, mood === 'happy' ? 0.02 : 0.0), b = at(fr, s, 0.0, mood === 'happy' ? 0.1 : -0.03), c = at(fr, s, 0.14, 0.0);
      pLine.moveTo(a.x, a.y); pLine.quadraticCurveTo(b.x, b.y, c.x, c.y);
    } else {
      const c = at(fr, s, 0.01, 0.0);
      pInk.moveTo(c.x + xl * 0.14, c.y); pInk.ellipse(c.x, c.y, xl * 0.14, yl * 0.15 * open, rot, 0, Math.PI * 2);
      const ci = at(fr, s, 0.015, -0.02 * open);
      pIris.moveTo(ci.x + xl * 0.085, ci.y); pIris.ellipse(ci.x, ci.y, xl * 0.085, yl * 0.1 * open, rot, 0, Math.PI * 2);
      const h = at(fr, s, 0.05, 0.05 * open);
      const hr = Math.max(0.45, xl * 0.04);
      pHi.moveTo(h.x + hr, h.y); pHi.arc(h.x, h.y, hr, 0, Math.PI * 2);
    }
    const fb = featureFrame(H, [0.4 * s, 0.24, 0.88]);
    if (fb.face > 0.06) {
      const B = BROW[mood] || BROW.calm;
      const a = { x: fb.c.x - 0.13 * s * fb.X.x * k - (-B[0]) * fb.Y.x * k, y: fb.c.y - 0.13 * s * fb.X.y * k - (-B[0]) * fb.Y.y * k };
      const b = { x: fb.c.x + 0.16 * s * fb.X.x * k - (-B[1]) * fb.Y.x * k, y: fb.c.y + 0.16 * s * fb.X.y * k - (-B[1]) * fb.Y.y * k };
      pBrow.moveTo(a.x, a.y); pBrow.lineTo(b.x, b.y);
    }
  }
  ctx.fillStyle = INK; ctx.fill(pInk);
  ctx.fillStyle = look.eyes; ctx.fill(pIris);
  ctx.fillStyle = '#ffffff'; ctx.fill(pHi);
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.7, H.r * 0.075); ctx.stroke(pLine);
  ctx.strokeStyle = look.hair.shadow; ctx.lineWidth = Math.max(0.6, H.r * 0.06); ctx.stroke(pBrow);
  // рот
  const fm = featureFrame(H, [0, -0.66, 0.75]);
  if (fm.face > 0.08) {
    const xl = Math.hypot(fm.X.x, fm.X.y) * k, yl = Math.hypot(fm.Y.x, fm.Y.y) * k, rot = Math.atan2(fm.X.y, fm.X.x);
    if (mood === 'shout' || mood === 'happy' || mood === 'effort') {
      const big = mood === 'shout' ? 1 : mood === 'happy' ? 0.75 : 0.45;
      ctx.fillStyle = '#7a1626'; ctx.beginPath();
      if (mood === 'happy') ctx.ellipse(fm.c.x, fm.c.y, xl * 0.11, yl * 0.1, rot, 0, Math.PI);
      else ctx.ellipse(fm.c.x, fm.c.y, xl * 0.1 * big, yl * 0.15 * big, rot, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.5, H.r * 0.04); ctx.stroke();
    } else {
      const w = mood === 'sad' ? 0.08 : 0.06;
      const a = { x: fm.c.x - fm.X.x * w * k, y: fm.c.y - fm.X.y * w * k }, b = { x: fm.c.x + fm.X.x * w * k, y: fm.c.y + fm.X.y * w * k };
      const dy = mood === 'sad' ? -0.04 : 0.03;
      ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.6, H.r * 0.055);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(fm.c.x - fm.Y.x * dy * k * 2, fm.c.y - fm.Y.y * dy * k * 2, b.x, b.y); ctx.stroke();
    }
  }
  void lod;
}

// ------------------------------------------------------------------ голова целиком
export function drawHead(ctx, H, look, face, dyn, o) {
  const v = v3.norm([H.R.t, H.U.t, H.F.t]);
  const ol = o.ol, olIn = Math.max(0.5, ol * 0.5), lod = o.lod;
  const hair = look.hair, skin = look.skin;
  const lag = dyn.lag || [0, 0, 0];
  const chinK = look.build === 'f' ? 0.94 : 1;
  const HS = 1.07; // объём волос над черепом

  // --- геометрия прядей, хвоста, лент
  const locks = fringeLocks(look).map(L => lockGeom(H, L, lag));
  const back = [], front = [];
  for (const g of locks) (g.face < -0.12 ? back : front).push(g);
  front.sort((a, b) => a.face - b.face);
  let tail = null;
  if (look.tail && dyn.tail && dyn.tail.length > 1) {
    const pts = dyn.tail.map(p => mapP(H, p));
    tail = { pts, back: pts[0].t < 0.1, w0: look.tail.w * H.r, w1: look.tail.w * H.r * 0.25 };
  }
  const ribbons = [];
  if (look.band && dyn.ribbons) for (const rb of dyn.ribbons) {
    const pts = rb.map(p => mapP(H, p));
    ribbons.push({ pts, back: pts[0].t < 0.05 });
  }

  // --- пути (Path2D): строим один раз, используем для контура, заливки, тени
  const pBack = new Path2D(), pFront = new Path2D(), pFringe = new Path2D();
  for (const g of back) lockPath(pBack, g);
  for (const g of front) { lockPath(pFront, g); if (g.fr) lockPath(pFringe, g); }
  const pHead = new Path2D(); headPath(pHead, H, chinK);
  const caps = [];
  for (const cp of look.caps) { const p2 = new Path2D(); const rule = capPath(p2, H, v, cp, HS); if (rule) caps.push({ cp, p: p2, rule }); }
  let pTail = null;
  if (tail) { pTail = new Path2D(); ribbonPath(pTail, tail.pts, tail.w0, tail.w1, 0.35); }
  const pRib = ribbons.map(rb => { const p2 = new Path2D(); ribbonPath(p2, rb.pts, H.r * 0.13, H.r * 0.1, 0); return p2; });

  // --- 1) внешний контур силуэта (толстая линия, под всем)
  // один вызов stroke на весь силуэт головы
  const pSil = new Path2D();
  for (const g of locks) lockPath(pSil, g);
  if (tail) ribbonPath(pSil, tail.pts, tail.w0, tail.w1, 0.35);
  for (const rb of ribbons) ribbonPath(pSil, rb.pts, H.r * 0.13, H.r * 0.1, 0);
  headPath(pSil, H, chinK);
  for (const c of caps) capPath(pSil, H, v, c.cp, HS);
  ctx.strokeStyle = INK; ctx.lineWidth = ol * 2; ctx.lineJoin = 'miter'; ctx.miterLimit = 3;
  ctx.stroke(pSil);
  ctx.lineJoin = 'round';

  // --- 2) задний слой: хвост и ленты за головой, задние пряди
  const drawTail = () => {
    ctx.fillStyle = hair.base; ctx.fill(pTail);
    if (lod >= 1) {
      ctx.save(); ctx.translate(-LX * H.r * 0.08, -LY * H.r * 0.08);
      ribbonPath(ctx, tail.pts, tail.w0 * 0.45, tail.w1 * 0.4, 0.35); ctx.fillStyle = hair.shadow; ctx.fill(); ctx.restore();
    }
    // резинка
    const p0 = tail.pts[0], p1 = tail.pts[1];
    const tx = p0.x + (p1.x - p0.x) * 0.18, ty = p0.y + (p1.y - p0.y) * 0.18;
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(tx, ty, H.r * 0.2 + olIn, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = look.tail.tie; ctx.beginPath(); ctx.arc(tx, ty, H.r * 0.2, 0, Math.PI * 2); ctx.fill();
  };
  const drawRibbon = (i) => { ctx.fillStyle = look.band.color; ctx.fill(pRib[i]); ctx.strokeStyle = INK; ctx.lineWidth = olIn; ctx.stroke(pRib[i]); };
  ribbons.forEach((rb, i) => { if (rb.back) drawRibbon(i); });
  if (tail && tail.back) drawTail();
  if (back.length) { ctx.fillStyle = hair.shadow; ctx.fill(pBack); }

  // --- 3) лицо и череп
  const face3 = H.F.t; // > 0 — лицо к камере
  {
    if (lod >= 2) {
      ctx.fillStyle = tone(skin, 'skinShadow'); ctx.fill(pHead);
      ctx.save(); ctx.clip(pHead);
      ctx.translate(LX * H.r * 0.16, LY * H.r * 0.16); ctx.fillStyle = skin; ctx.fill(pHead);
      ctx.translate(-LX * H.r * 0.16, -LY * H.r * 0.16);
    } else { ctx.fillStyle = skin; ctx.fill(pHead); ctx.save(); }
    // тень от волос на лбу (классический приём аниме)
    if (lod >= 2) {
      ctx.translate(-H.U.x * 0.16 + LX * -0.04 * H.r, -H.U.y * 0.16 + LY * -0.04 * H.r);
      ctx.fillStyle = tone(skin, 'skinShadow');
      for (const c of caps) if (!c.cp.buzz) ctx.fill(c.p, c.rule);
      ctx.fill(pFringe);
    }
    ctx.restore();
    if (look.beard && face3 > -0.1 && lod >= 1) {
      const a = mapP(H, [-0.3, -0.82, 0.66]), b = mapP(H, [0.3, -0.82, 0.66]), c = mapP(H, [0, -1.12, 0.52]), m = mapP(H, [0, -0.78, 0.7]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(m.x, m.y + (c.y - m.y) * 0.3, b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      ctx.fillStyle = hair.shadow; ctx.fill();
    }
  }
  if (face3 > -0.25 && !o.inkOnly && lod < 2) drawFaceSmall(ctx, H, look, face, lod);
  else if (face3 > -0.25 && !o.inkOnly) {
    const mood = face.mood || 'calm';
    const fs = lod >= 2 ? 1.28 : 1.45; // мелкие лица — черты крупнее
    for (const s of [1, -1]) {
      const fr = featureFrame(H, [0.4 * s, -0.16, 0.9]);
      if (fr.face < 0.06) continue;
      withFrame(ctx, fr, s, () => { ctx.scale(fs, fs); drawEye(ctx, s, mood, face.blink || 0, look, lod, face.gaze ? [face.gaze[0] * s, face.gaze[1]] : null); });
      if (lod >= 1) {
        const fb = featureFrame(H, [0.4 * s, 0.24, 0.88]);
        if (fb.face > 0.06) withFrame(ctx, fb, s, () => { ctx.scale(fs, fs); drawBrow(ctx, mood, hair.shadow); });
      }
      if (mood === 'happy' && lod >= 1) {
        const fc = featureFrame(H, [0.5 * s, -0.42, 0.76]);
        if (fc.face > 0.1) withFrame(ctx, fc, s, () => { ctx.fillStyle = 'rgba(255,92,120,0.45)'; ctx.beginPath(); ctx.ellipse(0, 0, 0.13, 0.06, 0, 0, Math.PI * 2); ctx.fill(); });
      }
    }
    if (lod >= 1) {
      const fn = featureFrame(H, [0, -0.36, 0.93]);
      if (fn.face > 0.1) withFrame(ctx, fn, 1, () => { ctx.fillStyle = tone(skin, 'deep'); ctx.beginPath(); ctx.moveTo(0.0, -0.04); ctx.lineTo(0.03, 0.035); ctx.lineTo(-0.01, 0.03); ctx.closePath(); ctx.fill(); });
    }
    const fm = featureFrame(H, [0, -0.66, 0.75]);
    if (fm.face > 0.08 && lod >= 1) withFrame(ctx, fm, 1, () => { ctx.scale(fs, fs); drawMouth(ctx, mood, lod, face.talk || 0); });
  }

  // --- 4) волосы: шапочки с жёсткой тенью и бликом
  for (const { cp, p: pc, rule: fr } of caps) {
    const col = cp.buzz ? tone(skin, 'deep') : hair.base, sh = cp.buzz ? tone(tone(skin, 'deep'), 'shadow') : hair.shadow;
    if (lod < 2) {
      // мелкая голова: без клипа — заливка и зубчатый блик внутри круга
      ctx.fillStyle = col; ctx.fill(pc, fr);
      if (!cp.buzz && lod >= 1 && face3 < 0.75) {
        const al = Math.atan2(LY, LX), R0 = H.r;
        ctx.fillStyle = hair.shine; ctx.beginPath();
        for (let i = 0; i <= 3; i++) { const a = al - 0.6 + 1.2 * i / 3; ctx.lineTo(H.x + Math.cos(a) * R0 * 0.86, H.y + Math.sin(a) * R0 * 0.86); }
        for (let i = 4; i >= 0; i--) { const a = al - 0.6 + 1.2 * i / 4; const rr = R0 * (i % 2 ? 0.5 : 0.66); ctx.lineTo(H.x + Math.cos(a) * rr, H.y + Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill();
      }
      continue;
    }
    ctx.fillStyle = sh; ctx.fill(pc, fr);
    ctx.save(); ctx.clip(pc, fr);
    ctx.translate(LX * H.r * 0.26, LY * H.r * 0.26);
    ctx.fillStyle = col; ctx.fill(pc, fr);
    ctx.translate(-LX * H.r * 0.26, -LY * H.r * 0.26);
    if (!cp.buzz) {
      // блик: зубчатая дуга со стороны света
      const al = Math.atan2(LY, LX), R0 = H.r * HS;
      ctx.fillStyle = hair.shine; ctx.beginPath();
      const n = 7;
      for (let i = 0; i <= n; i++) { const a = al - 0.85 + 1.7 * i / n; ctx.lineTo(H.x + Math.cos(a) * R0 * 0.82, H.y + Math.sin(a) * R0 * 0.82); }
      for (let i = n; i >= 0; i--) { const a = al - 0.85 + 1.7 * i / n; const rr = R0 * (i % 2 ? 0.6 : 0.7); ctx.lineTo(H.x + Math.cos(a) * rr, H.y + Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill();
      // линии прядей по меридианам (видны со спины и сбоку)
      ctx.strokeStyle = hair.shadow; ctx.lineWidth = Math.max(0.6, olIn * 1.1); ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const phi = Math.PI * (0.45 + i * 0.18), top = 1.15 - (i % 2) * 0.2, bot = hairLat(cp, phi) + 0.12;
        let started = false;
        for (let j = 0; j <= 4; j++) {
          const lat = top + (bot - top) * j / 4, cl = Math.cos(lat);
          const qd = [cl * Math.sin(phi + 0.12 * j / 4), Math.sin(lat), cl * Math.cos(phi + 0.12 * j / 4)];
          if (v3.dot(qd, v) < 0.15) { started = false; continue; }
          const pp = mapP(H, v3.scale(qd, HS));
          if (started) ctx.lineTo(pp.x, pp.y); else { ctx.moveTo(pp.x, pp.y); started = true; }
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- 5) передние пряди: общий тонкий контур группы, затем заливка и линии прядей
  if (front.length) {
    ctx.strokeStyle = INK; ctx.lineWidth = olIn * 2; ctx.lineJoin = 'round';
    ctx.stroke(pFront);
    ctx.fillStyle = hair.base; ctx.fill(pFront);
    if (lod >= 2) {
      const pSh = new Path2D(), pLn = new Path2D();
      for (const g of front) {
        if (g.blunt) continue;
        const m = { x: (g.b1.x + g.b2.x) / 2, y: (g.b1.y + g.b2.y) / 2 };
        // тень вдоль одной стороны пряди и линия-разделитель
        pSh.moveTo(g.tip.x, g.tip.y); pSh.quadraticCurveTo(g.c2.x, g.c2.y, g.b2.x, g.b2.y); pSh.lineTo(m.x, m.y); pSh.closePath();
        pLn.moveTo(g.tip.x, g.tip.y); pLn.lineTo(g.tip.x + (m.x - g.tip.x) * 0.55, g.tip.y + (m.y - g.tip.y) * 0.55);
      }
      ctx.fillStyle = hair.shadow; ctx.fill(pSh);
      ctx.lineCap = 'round'; ctx.strokeStyle = INK; ctx.lineWidth = olIn * 0.9; ctx.stroke(pLn);
    }
  }
  if (tail && !tail.back) drawTail();

  // --- 6) повязка
  if (look.band) {
    const B = bandStrip(H, v);
    const { up, lo, fac, N } = B;
    let k0 = -1;
    for (let k = 0; k < N; k++) if (fac[k] > 0 && fac[(k + N - 1) % N] <= 0) { k0 = k; break; }
    const idx = [];
    if (k0 < 0) { if (fac[0] > 0) for (let k = 0; k < N; k++) idx.push(k); }
    else for (let k = k0, g = 0; fac[k] > 0 && g < N; k = (k + 1) % N, g++) idx.push(k);
    if (idx.length > 1) {
      ctx.beginPath();
      ctx.moveTo(up[idx[0]].x, up[idx[0]].y);
      for (const k of idx) ctx.lineTo(up[k].x, up[k].y);
      for (let i = idx.length - 1; i >= 0; i--) ctx.lineTo(lo[idx[i]].x, lo[idx[i]].y);
      ctx.closePath();
      ctx.strokeStyle = INK; ctx.lineWidth = olIn * 2; ctx.stroke();
      ctx.fillStyle = look.band.color; ctx.fill();
      // эмблема спереди
      if (lod >= 1 && fac[0] > 0.3) {
        const c = { x: (up[0].x + lo[0].x) / 2, y: (up[0].y + lo[0].y) / 2 };
        ctx.fillStyle = look.band.mark; ctx.beginPath(); ctx.arc(c.x, c.y, H.r * 0.09, 0, Math.PI * 2); ctx.fill();
      }
    }
    ribbons.forEach((rb, i) => { if (!rb.back) drawRibbon(i); });
  }
  if (look.clip && lod >= 1) {
    const c = mapP(H, v3.scale(v3.norm(look.clip.pos), 1.05));
    if (c.t > -0.1) {
      const rr = H.r * 0.2;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? rr * 0.45 : rr; ctx.lineTo(c.x + Math.cos(a) * q, c.y + Math.sin(a) * q); }
      ctx.closePath(); ctx.strokeStyle = INK; ctx.lineWidth = olIn * 2; ctx.stroke(); ctx.fillStyle = look.clip.color; ctx.fill();
    }
  }
  // капля пота при досаде
  if (face.mood === 'sad' && lod >= 1 && face.sweat > 0) {
    const c = mapP(H, [0.95, 0.55, 0.35]);
    const rr = H.r * 0.2, dy = face.sweat * H.r * 0.4;
    ctx.beginPath(); ctx.moveTo(c.x, c.y - rr * 1.8 + dy); ctx.quadraticCurveTo(c.x + rr, c.y + dy, c.x, c.y + rr + dy); ctx.quadraticCurveTo(c.x - rr, c.y + dy, c.x, c.y - rr * 1.8 + dy);
    ctx.strokeStyle = INK; ctx.lineWidth = olIn * 2; ctx.stroke(); ctx.fillStyle = '#bfe8ff'; ctx.fill();
  }
}
