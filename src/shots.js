/**
 * shots.js — типы ударов и солвер начальной скорости.
 *
 * Траектория волана без ветра лежит в вертикальной плоскости, содержащей
 * начальную скорость, поэтому задача сводится к 2D: по горизонтальной
 * дистанции D до цели и высоте цели найти (скорость, угол возвышения).
 * Для каждого угла из диапазона типа удара бинарным поиском ищется скорость,
 * затем из кандидатов выбирается лучший по «стоимости» (запас над сеткой,
 * высота апекса, скорость) — см. COSTS.
 *
 * Публичный API (не менять сигнатуры):
 *   SHOT_TYPES: string[]
 *   SHOT_LABELS: Record<type, string>   — русские названия
 *   solveLaunch(from, target, type, opts?) -> Launch | null
 *   chooseTarget(type, hitterSide, aimY, mode, opts?) -> {x, y}
 *   planShot(params) -> { type, target, launch, quality } | null
 *   simulateFlat(speed, angleDeg, z0, zt, dNet) — 2D-симуляция (для тестов)
 */
import { SHOTS, COURT, PHYSICS } from './config.js';
import { integrateStep } from './physics.js';

export const SHOT_TYPES = ['clear', 'lift', 'drop', 'smash', 'drive', 'net', 'serveShort', 'serveLong'];
export const SHOT_LABELS = {
  clear: 'Клир', lift: 'Подъём', drop: 'Укороченный', smash: 'Смэш', drive: 'Драйв',
  net: 'Сетка', serveShort: 'Короткая подача', serveLong: 'Длинная подача',
};

const DEG = Math.PI / 180;

/**
 * 2D-полёт: старт на высоте z0, скорость speed под углом angleDeg.
 * Возвращает дальность (по горизонтали) в момент, когда волан опустился
 * до высоты zt на нисходящей ветви, высоту над сеткой на дистанции dNet,
 * апекс и время полёта.
 */
export function simulateFlat(speed, angleDeg, z0, zt, dNet, drag = PHYSICS.DRAG) {
  const s = { x: 0, y: 0, z: z0, vx: speed * Math.cos(angleDeg * DEG), vy: 0, vz: speed * Math.sin(angleDeg * DEG) };
  const dt = PHYSICS.DT;
  let t = 0, apex = z0, zNet = null, px = 0, pz = z0;
  while (t < 8) {
    px = s.x; pz = s.z;
    integrateStep(s, dt, drag);
    t += dt;
    if (s.z > apex) apex = s.z;
    if (zNet === null && s.x >= dNet) {
      const f = (dNet - px) / (s.x - px || 1e-9);
      zNet = pz + (s.z - pz) * f;
    }
    if (s.vz < 0 && s.z <= zt) {
      const f = (pz - zt) / (pz - s.z || 1e-9);
      const range = px + (s.x - px) * f;
      return { range, apex, zNet: zNet ?? -1, t: t - dt * (1 - f), vx: s.vx, vz: s.vz };
    }
  }
  return { range: s.x, apex, zNet: zNet ?? -1, t, vx: s.vx, vz: s.vz };
}

/** Цели стоимости для выбора лучшего кандидата. */
const COSTS = {
  high: (c, o) => Math.abs(c.apex - (o.apex ?? 6.5)) + (c.zNet - COURT.NET_HEIGHT < 1.2 ? 5 : 0),
  low:  (c, o) => Math.abs((c.zNet - COURT.NET_HEIGHT) - (o.netClear ?? 0.2)) * 4 + c.apex * 0.05,
  fast: (c, o) => Math.abs(c.speed - (o.speed ?? 40)) * 0.2 + Math.max(0, (o.netClear ?? 0.3) - (c.zNet - COURT.NET_HEIGHT)) * 10,
  flat: (c, o) => Math.abs((c.zNet - COURT.NET_HEIGHT) - (o.netClear ?? 0.3)) * 2 + Math.max(0, c.apex - 2.6) * 2 + c.t * 0.5,
};

/**
 * @typedef {{vx:number,vy:number,vz:number,speed:number,angle:number,apex:number,netClear:number,time:number}} Launch
 * @param {{x,y,z}} from  точка контакта
 * @param {{x,y,z?}} target  точка приземления (z цели по умолчанию 0)
 * @param {string} type   ключ SHOTS
 * @param {{apex?:number, netClear?:number, speed?:number, maxSpeed?:number}} opts
 * @returns {Launch|null}
 */
export function solveLaunch(from, target, type, opts = {}) {
  const spec = SHOTS[type];
  if (!spec) throw new Error('unknown shot ' + type);
  const dx = target.x - from.x, dy = target.y - from.y;
  const D = Math.hypot(dx, dy);
  if (D < 0.05) return null;
  const ux = dx / D, uy = dy / D;
  const zt = target.z ?? 0;
  // Дистанция до сетки по направлению удара.
  let dNet = Infinity;
  if (Math.sign(from.x) !== Math.sign(target.x) && Math.abs(ux) > 1e-6) dNet = -from.x / ux;
  const maxSpeed = Math.min(spec.maxSpeed, opts.maxSpeed ?? spec.maxSpeed);
  const minNet = COURT.NET_HEIGHT + spec.minNetClear;
  const costFn = COSTS[spec.apex];
  let best = null, bestCost = Infinity;
  const [a0, a1] = spec.angles;
  for (let a = a0; a <= a1 + 1e-9; a += 2) {
    let lo = spec.minSpeed, hi = maxSpeed;
    const rHi = simulateFlat(hi, a, from.z, zt, dNet);
    if (rHi.range < D) continue;
    const rLo = simulateFlat(lo, a, from.z, zt, dNet);
    if (rLo.range > D) continue;
    let r = rHi;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      r = simulateFlat(mid, a, from.z, zt, dNet);
      if (r.range < D) lo = mid; else hi = mid;
    }
    const speed = (lo + hi) / 2;
    const zNet = dNet === Infinity ? 99 : r.zNet;
    if (zNet < minNet) continue;
    const cand = { speed, angle: a, apex: r.apex, zNet, t: r.t };
    const cost = costFn(cand, opts);
    if (cost < bestCost) { bestCost = cost; best = cand; }
  }
  if (!best) return null;
  const h = best.speed * Math.cos(best.angle * DEG);
  return {
    vx: h * ux, vy: h * uy, vz: best.speed * Math.sin(best.angle * DEG),
    speed: best.speed, angle: best.angle, apex: best.apex,
    netClear: best.zNet - COURT.NET_HEIGHT, time: best.t,
  };
}

/** Глубина цели (|x| от сетки) по типу удара. */
const DEPTH = {
  clear: 6.05, lift: 5.95, drop: 1.75, smash: 3.9, drive: 4.6, net: 0.85,
  serveShort: 2.25, serveLongSingles: 6.15, serveLongDoubles: 5.6,
};

/**
 * Выбор точки цели на половине соперника.
 * @param {string} type
 * @param {number} hitterSide  знак x половины бьющего
 * @param {number} aimY  -1..1 — доля полуширины корта (мировая ось y)
 * @param {'singles'|'doubles'} mode
 * @param {{depth?:number}} opts
 */
export function chooseTarget(type, hitterSide, aimY, mode, opts = {}) {
  const halfW = mode === 'doubles' ? COURT.HALF_WIDTH_DOUBLES : COURT.HALF_WIDTH_SINGLES;
  let depth = opts.depth;
  if (depth == null) {
    if (type === 'serveLong') depth = mode === 'doubles' ? DEPTH.serveLongDoubles : DEPTH.serveLongSingles;
    else depth = DEPTH[type];
  }
  const y = Math.max(-1, Math.min(1, aimY)) * halfW * 0.78;
  return { x: -hitterSide * depth, y };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Подходящая замена, если удар физически невозможен из этой точки. */
const FALLBACK = {
  smash: ['drive', 'drop', 'clear', 'lift'],
  clear: ['lift', 'drive', 'drop'],
  drop: ['net', 'drive', 'lift'],
  drive: ['lift', 'drop', 'clear', 'net'],
  net: ['drop', 'lift'],
  lift: ['clear', 'drive', 'net'],
  serveShort: ['serveLong'],
  serveLong: ['serveShort'],
};

/**
 * Полный план удара: цель + ошибка + решение.
 * @param {object} p
 * @param {string} p.type
 * @param {{x,y,z}} p.from
 * @param {number} p.side         сторона бьющего
 * @param {{x,y}} [p.target]      явная цель (иначе chooseTarget по aimY)
 * @param {number} [p.aimY]
 * @param {'singles'|'doubles'} p.mode
 * @param {number} [p.quality]    0..1 качество контакта (1 — идеально)
 * @param {{power:number,control:number}} [p.stats]
 * @param {number} [p.aimError]   σ разброса, м (до учёта качества)
 * @param {number} [p.netClear]   желаемый запас над сеткой
 * @param {()=>number} [p.rng]
 */
export function planShot(p) {
  const rng = p.rng || Math.random;
  const stats = p.stats || { power: 0.8, control: 0.8 };
  const q = p.quality ?? 1;
  let type = p.type;
  const tried = new Set();
  const order = [type, ...(FALLBACK[type] || [])];
  for (const t of order) {
    if (tried.has(t)) continue;
    tried.add(t);
    let target = (t === type && p.target) ? { ...p.target } : chooseTarget(t, p.side, p.aimY ?? 0, p.mode, {});
    // Ошибка: базовая σ × (1.6 − control) × (1.8 − качество).
    const sigma = (p.aimError ?? 0.25) * (1.6 - stats.control) * (1.8 - q);
    const ex = gauss(rng) * sigma, ey = gauss(rng) * sigma;
    // Ошибка по глубине у коротких ударов меньше, у длинных — больше.
    const depthScale = (t === 'net' || t === 'drop' || t === 'serveShort') ? 0.45 : 1;
    target.x += ex * depthScale;
    target.y += ey;
    // Не позволяем цели переехать на свою сторону.
    if (Math.sign(target.x) !== -p.side) target.x = -p.side * 0.3;
    const opts = {};
    if (t === 'smash') opts.speed = SHOTS.smash.maxSpeed * (0.62 + 0.3 * stats.power) * (0.75 + 0.25 * q);
    if (t === 'clear') opts.apex = p.apex ?? 6.2;
    if (t === 'lift' || t === 'serveLong') opts.apex = p.apex ?? 6.6;
    if (t === 'drop') opts.netClear = p.netClear ?? 0.25;
    if (t === 'net') opts.netClear = p.netClear ?? 0.1;
    if (t === 'serveShort') opts.netClear = p.netClear ?? 0.15;
    if (t === 'drive') opts.netClear = p.netClear ?? 0.3;
    if (t === 'clear' || t === 'lift') opts.maxSpeed = SHOTS[t].maxSpeed * (0.75 + 0.25 * stats.power);
    const launch = solveLaunch(p.from, target, t, opts);
    if (launch) return { type: t, target, launch, quality: q };
  }
  return null;
}
