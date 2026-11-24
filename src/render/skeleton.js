/**
 * render/skeleton.js — математика для процедурной анимации персонажей:
 * 3D-векторы (массивы [x, y, z]), критически демпфированные пружины,
 * двухзвенная IK, сплайн по ключам, функции сглаживания.
 *
 * Чистые функции без DOM — можно тестировать в Node.
 *
 * API:
 *   V.add/sub/scale/dot/cross/len/norm/lerp/madd
 *   Spring(x0)  .step(target, omega, dt) .snap(x) .kick(dv)   — скалярная пружина
 *   Spring3(v0) .step(target3, omega, dt) .snap(v3)           — векторная пружина
 *   Wobble(x0, omega, zeta) / Wobble3 — недодемпфированные пружины (вторичная динамика)
 *   Chain(n, seg)  .step(root, rest, dt)                      — цепочка (хвост, ленты)
 *   hull2(pts) -> pts                                         — выпуклая оболочка на экране
 *   ik2(S, T, a, b, pole) -> {mid, end}                       — локоть/колено
 *   sampleKeys(times, values, t) -> number[]                  — эрмитов сплайн по ключам
 *   clamp, lerp, smoothstep, easeOutCubic, easeInQuad, easeInOutSine, angleWrap
 */

export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  madd: (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
export function easeOutCubic(t) { t = clamp(t, 0, 1); const u = 1 - t; return 1 - u * u * u; }
export function easeInQuad(t) { t = clamp(t, 0, 1); return t * t; }
export function easeInOutSine(t) { t = clamp(t, 0, 1); return 0.5 - 0.5 * Math.cos(Math.PI * t); }
export function angleWrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

/**
 * Критически демпфированная пружина (точное решение, устойчиво при любом dt).
 * omega — «жёсткость» (рад/с): время установления ≈ 4/omega.
 */
export class Spring {
  constructor(x = 0) { this.x = x; this.v = 0; }
  step(target, omega, dt) {
    if (!(dt > 0)) return this.x;
    const k = omega * dt;
    const e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const c = this.x - target;
    const tmp = (this.v + omega * c) * dt;
    this.v = (this.v - omega * tmp) * e;
    this.x = target + (c + tmp) * e;
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
  kick(dv) { this.v += dv; }
}

export class Spring3 {
  constructor(v = [0, 0, 0]) { this.s = [new Spring(v[0]), new Spring(v[1]), new Spring(v[2])]; }
  step(t, omega, dt) { return [this.s[0].step(t[0], omega, dt), this.s[1].step(t[1], omega, dt), this.s[2].step(t[2], omega, dt)]; }
  get x() { return [this.s[0].x, this.s[1].x, this.s[2].x]; }
  snap(v) { for (let i = 0; i < 3; i++) this.s[i].snap(v[i]); }
}

/**
 * Недодемпфированная пружина (вторичная динамика: волосы, ленты, подол).
 * omega — собственная частота (рад/с), zeta < 1 — покачивание с затуханием.
 * Полунеявный Эйлер с подшагами — устойчиво при dt до 0.1 с.
 */
export class Wobble {
  constructor(x = 0, omega = 14, zeta = 0.35) { this.x = x; this.v = 0; this.omega = omega; this.zeta = zeta; }
  step(target, dt) {
    if (!(dt > 0)) return this.x;
    const n = Math.min(8, Math.ceil(dt / 0.012));
    const h = dt / n, w = this.omega, z = this.zeta;
    for (let i = 0; i < n; i++) {
      this.v += (-(w * w) * (this.x - target) - 2 * z * w * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
  kick(dv) { this.v += dv; }
}

export class Wobble3 {
  constructor(v = [0, 0, 0], omega = 14, zeta = 0.35) { this.s = [0, 1, 2].map(i => new Wobble(v[i], omega, zeta)); this.init = false; }
  step(t, dt) {
    if (!this.init) { this.snap(t); this.init = true; }
    return [this.s[0].step(t[0], dt), this.s[1].step(t[1], dt), this.s[2].step(t[2], dt)];
  }
  get x() { return [this.s[0].x, this.s[1].x, this.s[2].x]; }
  snap(v) { for (let i = 0; i < 3; i++) this.s[i].snap(v[i]); }
}

/**
 * Цепочка с вторичной динамикой (хвост, ленты повязки): узлы тянутся пружинами
 * к «позе покоя» относительно предыдущего узла, длина звеньев сохраняется.
 * rest(i, prev) -> [x,y,z] — целевая точка узла i при родителе prev.
 */
export class Chain {
  constructor(n, seg, omega = 16, zeta = 0.3) { this.n = n; this.seg = seg; this.nodes = Array.from({ length: n }, () => new Wobble3([0, 0, 0], omega, zeta)); this.pts = []; }
  step(root, rest, dt, maxLag = 1) {
    const out = [root];
    let prev = root;
    for (let i = 0; i < this.n; i++) {
      const target = rest(i, prev);
      let p = this.nodes[i].step(target, dt);
      // жёсткость: не дальше maxLag*seg от цели и ровно seg от родителя
      let d = V.sub(p, target), dl = V.len(d);
      if (dl > maxLag * this.seg) { p = V.madd(target, d, maxLag * this.seg / dl); this.nodes[i].snap(p); }
      const e = V.sub(p, prev), el = V.len(e) || 1;
      p = V.madd(prev, e, this.seg / el);
      for (let k = 0; k < 3; k++) this.nodes[i].s[k].x = p[k];
      out.push(p); prev = p;
    }
    this.pts = out;
    return out;
  }
}

/** Выпуклая оболочка точек {x,y} (монотонная цепь Эндрю), против часовой. */
export function hull2(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/**
 * Двухзвенная IK: от корня S к цели T звеньями a и b, сгиб в сторону pole.
 * Цель за пределами досягаемости притягивается к сфере (рука выпрямляется).
 */
export function ik2(S, T, a, b, pole) {
  const d = V.sub(T, S);
  let L = V.len(d);
  const dn = L > 1e-6 ? V.scale(d, 1 / L) : [0, 0, -1];
  L = clamp(L, Math.abs(a - b) + 1e-3, (a + b) * 0.999);
  const ca = clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1);
  const sa = Math.sqrt(1 - ca * ca);
  let pp = V.sub(pole, V.scale(dn, V.dot(pole, dn)));
  const pl = V.len(pp);
  pp = pl > 1e-6 ? V.scale(pp, 1 / pl) : [0, 0, 1];
  const mid = [S[0] + dn[0] * a * ca + pp[0] * a * sa, S[1] + dn[1] * a * ca + pp[1] * a * sa, S[2] + dn[2] * a * ca + pp[2] * a * sa];
  const end = V.madd(S, dn, L);
  return { mid, end };
}

/**
 * Кубический эрмитов сплайн (касательные Катмулла–Рома) по неравномерным ключам.
 * values[i] — массив чисел одинаковой длины. Плавный (C1) и проходит через ключи.
 */
export function sampleKeys(times, values, t) {
  const n = times.length;
  if (t <= times[0]) return values[0].slice();
  if (t >= times[n - 1]) return values[n - 1].slice();
  let i = 0;
  while (i < n - 2 && t > times[i + 1]) i++;
  const t0 = times[i], t1 = times[i + 1], h = t1 - t0;
  const u = (t - t0) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const p0 = values[i], p1 = values[i + 1];
  const pm = values[Math.max(0, i - 1)], pn = values[Math.min(n - 1, i + 2)];
  const tm = times[Math.max(0, i - 1)], tn = times[Math.min(n - 1, i + 2)];
  const out = new Array(p0.length);
  for (let k = 0; k < p0.length; k++) {
    // касательные (в единицах «на сегмент»)
    const m0 = i > 0 ? (p1[k] - pm[k]) / (t1 - tm) * h : (p1[k] - p0[k]);
    const m1 = i + 2 < n ? (pn[k] - p0[k]) / (tn - t0) * h : (p1[k] - p0[k]);
    out[k] = h00 * p0[k] + h10 * m0 + h01 * p1[k] + h11 * m1;
  }
  return out;
}
