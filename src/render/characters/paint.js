/**
 * render/characters/paint.js — цвета и приёмы cel-shading для canvas 2D.
 *
 * Свет — экранный, сверху-слева (LX, LY). Тень — один жёсткий тон со сдвигом
 * к «тёмной» стороне; контур — тёмная линия: толще снаружи силуэта, тоньше внутри.
 *   tone(hex, kind)   — 'shadow' (холодная тень), 'skinShadow', 'light', 'rim', 'deep' (кэш строк)
 *   celCapsule(ctx, pts, w, base, shade, ol, rim) — конечность-полилиния с тенью и контуром
 *   celFill(ctx, path, base, shade, off, ol)      — залитая фигура с тенью «сдвигом»
 */
export const LX = -0.55, LY = -0.84;          // направление на свет (экран)
export const INK = '#17142a';                 // цвет линий
const cache = new Map();

function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const MUL = {
  shadow: [0.66, 0.62, 0.8], skinShadow: [0.88, 0.68, 0.7], deep: [0.45, 0.42, 0.58],
};
export function tone(hex, kind) {
  if (!hex || hex[0] !== '#') return hex;
  const key = hex + kind;
  let v = cache.get(key);
  if (v) return v;
  const c = rgb(hex);
  let o;
  if (MUL[kind]) o = c.map((x, i) => Math.round(x * MUL[kind][i]));
  else if (kind === 'light') o = c.map(x => Math.round(x + (255 - x) * 0.45));
  else if (kind === 'rim') o = c.map(x => Math.round(x + (255 - x) * 0.75));
  else o = c;
  v = `rgb(${o[0]},${o[1]},${o[2]})`;
  cache.set(key, v);
  return v;
}

/**
 * Конечность: полилиния pts [{x,y}], ширина w (число или массив по сегментам).
 * ol — толщина внешнего контура. rim — цвет контрового блика (или null).
 */
export function celCapsule(ctx, pts, w, base, shade, ol, rim) {
  const n = pts.length;
  const W = i => (typeof w === 'number' ? w : w[Math.min(i, w.length - 1)]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (!shade) {
    // плоская деталь: контур (если есть) + цвет одной полилинией
    for (let pass = ol > 0 ? 0 : 1; pass < 2; pass++) {
      ctx.strokeStyle = pass ? base : INK;
      for (let i = 0; i < n - 1; i++) {
        ctx.lineWidth = W(i) + (pass ? 0 : ol * 2);
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke();
      }
    }
    return;
  }
  // контур + тень (одной формой, тень — полный тон под базой)
  for (let pass = 0; pass < 2; pass++) {
    ctx.strokeStyle = pass ? shade : INK;
    for (let i = 0; i < n - 1; i++) {
      ctx.lineWidth = W(i) + (pass ? 0 : ol * 2);
      ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke();
    }
  }
  // база, сдвинутая к свету (по нормали сегмента)
  ctx.strokeStyle = base;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    if (nx * LX + ny * LY < 0) { nx = -nx; ny = -ny; }
    const ww = W(i), off = ww * 0.2;
    ctx.lineWidth = ww * 0.6;
    ctx.beginPath(); ctx.moveTo(a.x + nx * off, a.y + ny * off); ctx.lineTo(b.x + nx * off, b.y + ny * off); ctx.stroke();
    if (rim && ww > 4.5) {
      // тонкий контровой блик по тёмному краю
      ctx.strokeStyle = rim; ctx.lineWidth = Math.max(0.6, ww * 0.1);
      const ro = ww * 0.36;
      ctx.beginPath(); ctx.moveTo(a.x - nx * ro, a.y - ny * ro); ctx.lineTo(b.x - nx * ro, b.y - ny * ro); ctx.stroke();
      ctx.strokeStyle = base;
    }
  }
}

/** Фигура path() с жёсткой тенью: тень по всей фигуре, база — сдвинутая к свету копия в клипе. */
export function celFill(ctx, path, base, shade, off, ol) {
  ctx.lineJoin = 'round';
  path();
  if (ol > 0) { ctx.strokeStyle = INK; ctx.lineWidth = ol * 2; ctx.stroke(); }
  ctx.fillStyle = shade; ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.translate(LX * off, LY * off);
  path();
  ctx.fillStyle = base; ctx.fill();
  ctx.restore();
}

/** Путь-полигон по точкам {x,y}. */
export function polyPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** Сглаженный замкнутый путь через середины рёбер (мягкие углы). */
export function smoothPath(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  const m0 = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  ctx.closePath();
}

/**
 * Залитый многоугольник (выпуклая оболочка) с тенью без клипа: тень — вся фигура,
 * база — та же фигура, у которой вершины теневой стороны сдвинуты внутрь на off.
 */
export function celPoly(ctx, pts, base, shade, off, ol) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  polyPath(ctx, pts);
  if (ol > 0) { ctx.lineJoin = 'round'; ctx.strokeStyle = INK; ctx.lineWidth = ol * 2; ctx.stroke(); }
  if (!shade) { ctx.fillStyle = base; ctx.fill(); return; }
  ctx.fillStyle = shade; ctx.fill();
  const inner = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let nx = p.x - cx, ny = p.y - cy; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const d = nx * LX + ny * LY; // < 0 — теневая сторона
    const k = d < 0 ? Math.min(-d * 1.4, 1) * off : 0;
    inner[i] = { x: p.x - nx * k, y: p.y - ny * k };
  }
  polyPath(ctx, inner);
  ctx.fillStyle = base; ctx.fill();
}
