/**
 * audio/dsp.js — крошечный набор DSP-примитивов на чистом JS (без WebAudio).
 * Звуки «Волана» синтезируются в Float32Array один раз (банк), затем
 * проигрываются через AudioBufferSourceNode — дёшево по CPU и детерминированно
 * (их можно проверять в Node: tests/audio.test.mjs).
 */

/** Детерминированный ГПСЧ (mulberry32). */
export function rng32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const midi = n => 440 * Math.pow(2, (n - 69) / 12);

export function buf(sr, sec) { return new Float32Array(Math.max(1, Math.ceil(sr * sec))); }

/** Белый шум [-1, 1]. */
export function noise(n, r) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = r() * 2 - 1;
  return o;
}

/** Розоватый шум (фильтр Пола Келлета, экономичная версия). */
export function pink(n, r) {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    o[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return o;
}

/**
 * Биквад RBJ на месте. freq — число или функция (t в секундах → Гц) для свипов
 * (коэффициенты пересчитываются каждые 16 сэмплов).
 * type: 'lp' | 'hp' | 'bp' | 'peak' | 'notch'
 */
export function biquad(x, sr, type, freq, q = 0.707, gainDb = 0) {
  let b0, b1, b2, a1, a2;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const dyn = typeof freq === 'function';
  const coefs = f => {
    f = clamp(f, 10, sr * 0.45);
    const w = TAU * f / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q);
    let n0, n1, n2, d0, d1, d2;
    if (type === 'lp') { n0 = (1 - cw) / 2; n1 = 1 - cw; n2 = n0; d0 = 1 + al; d1 = -2 * cw; d2 = 1 - al; }
    else if (type === 'hp') { n0 = (1 + cw) / 2; n1 = -(1 + cw); n2 = n0; d0 = 1 + al; d1 = -2 * cw; d2 = 1 - al; }
    else if (type === 'bp') { n0 = al; n1 = 0; n2 = -al; d0 = 1 + al; d1 = -2 * cw; d2 = 1 - al; }
    else if (type === 'notch') { n0 = 1; n1 = -2 * cw; n2 = 1; d0 = 1 + al; d1 = -2 * cw; d2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); n0 = 1 + al * A; n1 = -2 * cw; n2 = 1 - al * A; d0 = 1 + al / A; d1 = -2 * cw; d2 = 1 - al / A; }
    b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0; a1 = d1 / d0; a2 = d2 / d0;
  };
  coefs(dyn ? freq(0) : freq);
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 31) === 0) coefs(freq(i / sr));
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

/** Однополюсный ФНЧ на месте; fc — число или функция t → Гц. */
export function onepole(x, sr, fc) {
  const dyn = typeof fc === 'function';
  let a = Math.exp(-TAU * (dyn ? fc(0) : fc) / sr), y = 0;
  for (let i = 0; i < x.length; i++) {
    if (dyn && (i & 31) === 0) a = Math.exp(-TAU * clamp(fc(i / sr), 10, sr * 0.45) / sr);
    y = x[i] + a * (y - x[i]);
    x[i] = y;
  }
  return x;
}

/** Умножить на огибающую env(t) → 0..1. */
export function shape(x, sr, env) {
  for (let i = 0; i < x.length; i++) x[i] *= env(i / sr);
  return x;
}

/** Экспоненциальная атака-спад: быстрая атака att, спад с постоянной dec. */
export function ad(att, dec) {
  return t => (t < att ? t / att : Math.exp(-(t - att) / dec));
}

/** Сложить src в dst со сдвигом (сэмплов) и множителем. */
export function mix(dst, src, offset = 0, g = 1) {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = Math.max(0, -offset); i < n; i++) dst[i + offset] += src[i] * g;
  return dst;
}

/** Затухающая синусоида (мода): f — число или функция t → Гц. */
export function mode(dst, sr, f, amp, dec, opts = {}) {
  const att = opts.att ?? 0.0006;
  const start = Math.round((opts.at || 0) * sr);
  const len = Math.min(dst.length - start, Math.ceil(sr * Math.min(opts.len ?? dec * 7, 30)));
  const dyn = typeof f === 'function';
  const na = Math.max(1, Math.round(att * sr));
  const k = Math.exp(-1 / (dec * sr));
  // Синус рекуррентно (вращение комплексного числа), огибающая — умножением: без sin/exp на сэмпл.
  let c = Math.cos(opts.phase || 0), s = Math.sin(opts.phase || 0);
  let w = TAU * (dyn ? f(0) : f) / sr, cw = Math.cos(w), sw = Math.sin(w);
  let e = 1;
  for (let i = 0; i < len; i++) {
    if (dyn && (i & 15) === 0) { w = TAU * f(i / sr) / sr; cw = Math.cos(w); sw = Math.sin(w); }
    const c2 = c * cw - s * sw; s = s * cw + c * sw; c = c2;
    if ((i & 1023) === 0) { const m = 1 / Math.hypot(c, s); c *= m; s *= m; }
    let g;
    if (i < na) g = i / na; else { g = e; e *= k; }
    dst[start + i] += s * amp * g;
  }
  return dst;
}

/** Мягкое ограничение (tanh с нормировкой драйва). */
export function saturate(x, drive = 1) {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

export function peak(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}

/** Нормировать к пику p (по всем каналам вместе). */
export function normalize(chs, p = 0.9) {
  const arr = Array.isArray(chs) ? chs : [chs];
  let m = 0;
  for (const c of arr) m = Math.max(m, peak(c));
  if (m > 0) for (const c of arr) for (let i = 0; i < c.length; i++) c[i] *= p / m;
  return chs;
}

/** Короткие фейды на краях (без щелчков). */
export function fades(x, sr, fin = 0.0005, fout = 0.01) {
  const ni = Math.min(x.length, Math.round(fin * sr)), no = Math.min(x.length, Math.round(fout * sr));
  for (let i = 0; i < ni; i++) x[i] *= i / ni;
  for (let i = 0; i < no; i++) x[x.length - 1 - i] *= i / no;
  return x;
}

/** Обрезать хвост ниже порога (экономия памяти), оставив фейд. */
export function trim(x, sr, thr = 0.0008) {
  let end = x.length - 1;
  while (end > 0 && Math.abs(x[end]) < thr) end--;
  const n = Math.min(x.length, end + Math.round(0.02 * sr));
  return fades(x.slice(0, n), sr, 0, 0.012);
}

/** Обрезать хвост сразу у всех каналов (одинаковая длина). */
export function trimAll(chs, sr, thr = 0.0008) {
  let end = 0;
  for (const x of chs) { let e = x.length - 1; while (e > end && Math.abs(x[e]) < thr) e--; end = Math.max(end, e); }
  const n = Math.min(chs[0].length, end + Math.round(0.02 * sr));
  return chs.map(x => fades(x.slice(0, n), sr, 0, 0.012));
}

/** Сделать буфер бесшовно-зацикливаемым (кроссфейд хвоста в начало). */
export function loopable(x, sr, xf = 0.25) {
  const n = Math.round(xf * sr);
  const out = x.slice(0, x.length - n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] = out[i] * Math.sqrt(k) + x[x.length - n + i] * Math.sqrt(1 - k);
  }
  return out;
}

/** Пила с polyBLEP (без алиасинга) с частотой f(t). */
export function saw(dst, sr, f, amp, env, at = 0, len = null) {
  const s0 = Math.round(at * sr);
  const n = Math.min(dst.length - s0, len == null ? dst.length : Math.ceil(len * sr));
  const dyn = typeof f === 'function';
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const dt = (dyn ? f(t) : f) / sr;
    ph += dt; if (ph >= 1) ph -= 1;
    let v = 2 * ph - 1;
    if (ph < dt) { const u = ph / dt; v -= u + u - u * u - 1; }
    else if (ph > 1 - dt) { const u = (ph - 1) / dt; v -= u * u + u + u + 1; }
    dst[s0 + i] += v * amp * env(t);
  }
  return dst;
}

/** Модуль спектра (наивный DFT по сетке частот) — только для тестов/анализа. */
export function bandEnergy(x, sr, f0, f1, steps = 24) {
  let e = 0;
  const n = Math.min(x.length, 4096);
  for (let k = 0; k < steps; k++) {
    const f = f0 + (f1 - f0) * (k + 0.5) / steps;
    let re = 0, im = 0;
    const w = TAU * f / sr;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    e += re * re + im * im;
  }
  return e / steps;
}
