/**
 * audio/bank.js — рецепты всех звуков «Волана» (синтез на чистом JS, без файлов и сети).
 *
 * Стиль — спортивное аниме: реалистичные ракетка/волан/кроссовки/зал, но
 * «подкрученные»: плотнее транзиент, громче удар смэша с суб-бумом, блёстка
 * «шинь» на идеальном ударе, драматичные стингеры и джинглы (оригинальные мелодии).
 *
 * API:
 *   RECIPES[name] = { cat, variants, sr?, render(sr, variant) -> Float32Array[] (каналы) }
 *     cat: 'sfx' (короткие, можно синтезировать на лету) | 'amb' (петли) | 'crowd' | 'music' | 'ir'
 *     sr — предпочтительная частота дискретизации (толпа/фон — 22050, экономия CPU)
 *   renderSound(name, sr, variant) — то же с кэш-ключом по умолчанию
 *   HIT_TYPES — типы ударов, у которых есть звук
 */
import {
  rng32, TAU, clamp, lerp, midi, buf, noise, pink, biquad, onepole, shape, ad, mix, mode,
  saturate, normalize, fades, trim, trimAll, loopable, saw,
} from './dsp.js';

// ------------------------------------------------------------------ удары ракеткой

/**
 * Удар = щелчок контакта (транзиент) + «пинь» струнной сетки (затухающие моды)
 * + стук обода/рукоятки (низкая мода) + «ток» пробки волана (узкий шум).
 */
const HIT = {
  clear: { ping: [1180, 1735, 2510, 3420], pa: [1, 0.55, 0.35, 0.2], pd: [0.11, 0.08, 0.06, 0.04], pAmp: 0.55,
    body: 360, bAmp: 0.45, bDec: 0.028, click: ['bp', 3800, 0.8], cAmp: 0.9, cDec: 0.0025, cork: 1500, kAmp: 0.5, drive: 1.2, level: 0.85, len: 0.45 },
  lift: { ping: [1210, 1770, 2560, 3500], pa: [1, 0.5, 0.3, 0.15], pd: [0.09, 0.065, 0.05, 0.035], pAmp: 0.5,
    body: 380, bAmp: 0.4, bDec: 0.025, click: ['bp', 3400, 0.8], cAmp: 0.75, cDec: 0.0022, cork: 1450, kAmp: 0.45, drive: 1.1, level: 0.72, len: 0.38 },
  drive: { ping: [1320, 1980, 2850], pa: [1, 0.5, 0.3], pd: [0.06, 0.045, 0.03], pAmp: 0.5,
    body: 300, bAmp: 0.5, bDec: 0.022, click: ['hp', 2500, 0.7], cAmp: 1.25, cDec: 0.0018, cork: 1700, kAmp: 0.55, drive: 1.7, level: 0.88, len: 0.3 },
  smash: { ping: [1050, 1590, 2300, 3300], pa: [1, 0.6, 0.4, 0.25], pd: [0.09, 0.07, 0.05, 0.035], pAmp: 0.6,
    body: 230, bAmp: 0.95, bDec: 0.05, click: ['lp', 9000, 0.6], cAmp: 1.7, cDec: 0.005, cork: 1300, kAmp: 0.6, drive: 2.4, level: 1, len: 0.5, tail: 0.5 },
  drop: { ping: [1250, 1900], pa: [1, 0.4], pd: [0.045, 0.03], pAmp: 0.25,
    body: 420, bAmp: 0.35, bDec: 0.02, click: ['lp', 2200, 0.7], cAmp: 0.45, cDec: 0.002, cork: 1350, kAmp: 0.4, drive: 1, level: 0.5, len: 0.22 },
  net: { ping: [1300, 1960], pa: [1, 0.35], pd: [0.035, 0.025], pAmp: 0.18,
    body: 480, bAmp: 0.3, bDec: 0.016, click: ['lp', 1800, 0.7], cAmp: 0.35, cDec: 0.0018, cork: 1400, kAmp: 0.4, drive: 1, level: 0.42, len: 0.18 },
};
HIT.serveShort = { ...HIT.net, level: 0.46, pAmp: 0.22 };
HIT.serveLong = { ...HIT.clear, level: 0.75 };
export const HIT_TYPES = Object.keys(HIT);

function renderHit(sr, variant, P) {
  const r = rng32(1000 + variant * 7919 + P.body);
  const jit = (a) => 1 + (r() - 0.5) * a;
  const out = buf(sr, P.len);
  // струны
  for (let i = 0; i < P.ping.length; i++) {
    mode(out, sr, P.ping[i] * jit(0.06), P.pAmp * P.pa[i] * jit(0.2), P.pd[i] * jit(0.25), { att: 0.0004, phase: r() * TAU });
  }
  // обод/рукоятка — «тук»
  mode(out, sr, t => P.body * (1 + 0.15 * Math.exp(-t * 60)), P.bAmp, P.bDec * jit(0.2), { att: 0.0008 });
  // транзиент контакта
  const cl = noise(Math.ceil(sr * P.cDec * 8), r);
  biquad(cl, sr, P.click[0], P.click[1] * jit(0.1), P.click[2]);
  shape(cl, sr, ad(0.0002, P.cDec));
  mix(out, cl, 0, P.cAmp);
  // пробка волана
  const ck = noise(Math.ceil(sr * 0.06), r);
  biquad(ck, sr, 'bp', P.cork * jit(0.1), 1.6);
  shape(ck, sr, ad(0.0005, 0.012));
  mix(out, ck, Math.round(sr * 0.0006), P.kAmp);
  // смэш: шумовой «хвост» трескучего удара
  if (P.tail) {
    const tl = noise(Math.ceil(sr * 0.2), r);
    biquad(tl, sr, 'lp', 3200, 0.7);
    shape(tl, sr, ad(0.001, 0.03));
    mix(out, tl, 0, P.tail);
  }
  saturate(out, P.drive);
  normalize(out, P.level * 0.95);
  return [trim(fades(out, sr, 0.0002, 0.01), sr)];
}

// ------------------------------------------------------------------ аниме-эффекты

/** Бум удара смэша: суб-удар + шумовой взрыв (ревер добавляет движок). */
function renderBoom(sr, v) {
  const r = rng32(77 + v);
  const out = buf(sr, 1.0);
  mode(out, sr, t => 38 + 52 * Math.exp(-t * 14), 1, 0.28, { att: 0.003 });
  mode(out, sr, t => 95 + 90 * Math.exp(-t * 30), 0.55, 0.09, { att: 0.002 });
  const n = noise(out.length, r);
  onepole(n, sr, t => 2600 * Math.exp(-t * 9) + 250);
  shape(n, sr, ad(0.002, 0.11));
  mix(out, n, 0, 0.75);
  saturate(out, 1.8);
  normalize(out, 0.9);
  return [trim(out, sr)];
}

/** Нарастающий свист перед смэшем (заканчивается в момент контакта). */
function renderRiser(sr, v) {
  const r = rng32(301 + v);
  const L = 0.3;
  const n = noise(buf(sr, L).length, r);
  const a = n.slice();
  biquad(a, sr, 'bp', t => 500 * Math.pow(9, t / L), 2.4);
  biquad(n, sr, 'bp', t => 900 * Math.pow(6, t / L), 1.4);
  const out = buf(sr, L);
  mix(out, a, 0, 1); mix(out, n, 0, 0.5);
  mode(out, sr, t => 320 * Math.pow(4, t / L), 0.12, 99, { att: 0.01 });
  shape(out, sr, t => Math.pow(t / L, 2.2) * (t > L - 0.006 ? (L - t) / 0.006 : 1));
  normalize(out, 0.7);
  return [out];
}

/** «Шинь» — блёстка идеального удара (колокольные частичные + искра). */
function renderShing(sr, v) {
  const r = rng32(555 + v);
  const out = buf(sr, 1.1);
  const parts = [2349, 3136, 3951, 4699, 6272];
  const amps = [1, 0.7, 0.5, 0.35, 0.22];
  const decs = [0.55, 0.45, 0.35, 0.28, 0.18];
  for (let i = 0; i < parts.length; i++) {
    mode(out, sr, parts[i], amps[i] * 0.5, decs[i], { att: 0.003, at: 0.012, phase: r() * TAU });
    mode(out, sr, parts[i] + 3.5 + i, amps[i] * 0.35, decs[i] * 0.9, { att: 0.003, at: 0.012 }); // биения = мерцание
  }
  mode(out, sr, t => 1800 * Math.pow(2.4, Math.min(1, t / 0.05)), 0.4, 0.05, { att: 0.001 });
  const sh = noise(Math.ceil(sr * 0.3), r);
  biquad(sh, sr, 'hp', 5200, 0.7);
  biquad(sh, sr, 'lp', 11000, 0.7);
  shape(sh, sr, ad(0.002, 0.06));
  mix(out, sh, 0, 0.5);
  normalize(out, 0.6);
  return [trim(out, sr)];
}

/** Свист промаха. */
function renderWhiff(sr, v) {
  const r = rng32(911 + v);
  const L = 0.32;
  const out = noise(buf(sr, L).length, r);
  biquad(out, sr, 'bp', t => 2600 * Math.exp(-t * 7) + 450 + v * 120, 1.3);
  shape(out, sr, t => Math.pow(Math.sin(Math.PI * clamp(t / (L - 0.01), 0, 1)), 2));
  normalize(out, 0.55);
  return [fades(out, sr)];
}

// ------------------------------------------------------------------ волан, сетка, пол

/** Касание сетки: «фьють» + дребезг сетки и ленты. */
function renderNet(sr, v) {
  const r = rng32(1201 + v);
  const out = buf(sr, 0.45);
  const n = noise(Math.ceil(sr * 0.12), r);
  biquad(n, sr, 'bp', t => 3200 * Math.exp(-t * 25) + 900, 1.8);
  shape(n, sr, ad(0.001, 0.02));
  mix(out, n, 0, 0.9);
  const mesh = buf(sr, 0.45);
  mode(mesh, sr, 140 + v * 6, 0.4, 0.09);
  mode(mesh, sr, 233 + v * 9, 0.3, 0.07);
  mode(mesh, sr, 310, 0.2, 0.05);
  shape(mesh, sr, t => 1 + 0.6 * Math.sin(TAU * 38 * t));
  mix(out, mesh, Math.round(sr * 0.004), 1);
  mode(out, sr, 260, 0.5, 0.03, { at: 0.003 });
  normalize(out, 0.7);
  return [trim(out, sr)];
}

/** Приземление: «туп» на мат (in) или глуше на пол (out). */
function renderLand(sr, v, out_) {
  const r = rng32(1500 + v + (out_ ? 50 : 0));
  const f = out_ ? 165 : 230;
  const out = buf(sr, 0.28);
  const once = (at, g) => {
    mode(out, sr, f * (1 + (r() - 0.5) * 0.08), g, out_ ? 0.03 : 0.022, { at, att: 0.0005 });
    mode(out, sr, f * 2.05, g * (out_ ? 0.3 : 0.4), 0.012, { at });
    const c = noise(Math.ceil(sr * 0.04), r);
    biquad(c, sr, 'lp', out_ ? 1100 : 2800, 0.7);
    shape(c, sr, ad(0.0003, 0.004));
    mix(out, c, Math.round(at * sr), g * (out_ ? 0.4 : 0.5));
  };
  once(0, 1);
  once(out_ ? 0.085 : 0.07, out_ ? 0.2 : 0.25); // маленький отскок
  normalize(out, out_ ? 0.5 : 0.6);
  return [trim(out, sr)];
}

/** Писк резиновой подошвы (stick-slip: гармоники + рваная АМ). */
function renderSqueak(sr, v) {
  const r = rng32(2100 + v * 31);
  const L = 0.09 + r() * 0.1;
  const f0 = 1500 + r() * 1100;
  const dir = r() < 0.5 ? 1 : -1;
  const fm = 45 + r() * 40;
  const out = buf(sr, L + 0.02);
  let ph = 0, jit = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    jit += ((r() - 0.5) * 0.4 - jit) * 0.02;
    const f = f0 * (1 + 0.22 * dir * Math.sin(Math.PI * clamp(t / L, 0, 1)) + 0.03 * jit);
    ph += TAU * f / sr;
    const s = Math.sin(ph) + 0.45 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) + 0.12 * Math.sin(4 * ph);
    const am = 0.6 + 0.4 * Math.sin(TAU * fm * t + jit * 3);
    const e = t < 0.008 ? t / 0.008 : t > L ? Math.max(0, 1 - (t - L) / 0.015) : 1 - 0.3 * (t / L);
    out[i] = s * am * e;
  }
  biquad(out, sr, 'bp', f0 * 1.4, 0.6);
  normalize(out, 0.45);
  return [fades(out, sr)];
}

/** Лёгкий шаг. */
function renderStep(sr, v) {
  const r = rng32(2600 + v * 13);
  const out = buf(sr, 0.12);
  const n = noise(out.length, r);
  biquad(n, sr, 'lp', 650 + r() * 300, 0.8);
  shape(n, sr, ad(0.0008, 0.012));
  mix(out, n, 0, 0.7);
  mode(out, sr, 105 + r() * 30, 0.6, 0.03, { att: 0.001 });
  mode(out, sr, 250 + r() * 60, 0.3, 0.012);
  // короткий «тик» подошвы — чтобы шаг был слышен и на динамике телефона
  const tk = noise(Math.ceil(sr * 0.02), r);
  biquad(tk, sr, 'bp', 1600 + r() * 800, 1.2);
  shape(tk, sr, ad(0.0003, 0.003));
  mix(out, tk, 0, 0.35);
  normalize(out, 0.42);
  return [trim(out, sr)];
}

/** Приземление после прыжка — тяжёлый «бух». */
function renderThud(sr, v) {
  const r = rng32(2900 + v);
  const out = buf(sr, 0.38);
  const once = (at, g) => {
    mode(out, sr, t => 78 - 20 * Math.min(1, t * 8), g, 0.08, { at, att: 0.002 });
    mode(out, sr, 140, g * 0.5, 0.03, { at });
    const n = noise(Math.ceil(sr * 0.2), r);
    biquad(n, sr, 'lp', 450, 0.7);
    shape(n, sr, ad(0.001, 0.045));
    mix(out, n, Math.round(at * sr), g * 0.6);
  };
  once(0, 1); once(0.028, 0.4);
  saturate(out, 1.3);
  normalize(out, 0.7);
  return [trim(out, sr)];
}

/** Щелчок интерфейса. */
function renderClick(sr, v) {
  const r = rng32(3100 + v);
  const out = buf(sr, 0.07);
  mode(out, sr, 1900 + v * 200, 1, 0.008);
  mode(out, sr, 950 + v * 100, 0.5, 0.015);
  const n = noise(Math.ceil(sr * 0.01), r);
  biquad(n, sr, 'hp', 4000, 0.7);
  shape(n, sr, ad(0.0002, 0.002));
  mix(out, n, 0, 0.3);
  normalize(out, 0.4);
  return [fades(out, sr)];
}

/** Воздух вокруг летящего волана — петля шума (фильтр и громкость меняет движок по скорости). */
function renderAir(sr) {
  const r = rng32(4242);
  const n = pink(Math.ceil(sr * 2.25), r);
  // перья «шуршат» — лёгкая быстрая АМ
  shape(n, sr, t => 0.8 + 0.2 * Math.sin(TAU * 23 * t) * Math.sin(TAU * 3.1 * t));
  const o = loopable(n, sr, 0.25);
  normalize(o, 0.8);
  return [o];
}

// ------------------------------------------------------------------ зал и трибуны

function stereoDecor(sr, dur, r, fn) {
  return [fn(pink(Math.ceil(sr * dur), r)), fn(pink(Math.ceil(sr * dur), r))];
}

/** Тон помещения спортзала: низкий гул вентиляции + воздух. */
function renderRoom(sr) {
  const r = rng32(5151);
  const chs = stereoDecor(sr, 6.25, r, x => {
    const lo = x.slice(); onepole(lo, sr, 300);
    const hi = x; biquad(hi, sr, 'bp', 1300, 0.5);
    for (let i = 0; i < lo.length; i++) lo[i] = lo[i] * 2.5 + hi[i] * 0.08;
    return loopable(lo, sr, 0.25);
  });
  normalize(chs, 0.5);
  return chs;
}

/**
 * Один «голос» толпы: импульсный источник (пила) + шум через две форманты.
 * o: {dur, at, f0, f0fn(t), vowels:[[F1,F2]...] | fn(t)->[F1,F2], syl, env(t), breath}
 */
function crowdVoice(sr, r, o) {
  const x = buf(sr, o.dur);
  const f0 = o.f0;
  const wob = r() * TAU;
  saw(x, sr, t => f0 * (o.f0fn ? o.f0fn(t) : 1) * (1 + 0.02 * Math.sin(TAU * 4.5 * t + wob)), 1, () => 1);
  const br = o.breath ?? 0.25;
  if (br) for (let i = 0; i < x.length; i++) x[i] = x[i] * (1 - br) + (r() * 2 - 1) * br * 1.5;
  const vf = typeof o.vowels === 'function' ? o.vowels : (() => {
    // смена гласных по слогам (бормотание)
    const syl = o.syl || 0.2;
    const seq = [];
    for (let t = 0; t < o.dur + syl; t += syl * (0.6 + r() * 0.8)) seq.push([t, o.vowels[(r() * o.vowels.length) | 0]]);
    return t => {
      let k = 0; while (k + 1 < seq.length && seq[k + 1][0] <= t) k++;
      const a = seq[k][1], b = (seq[k + 1] || seq[k])[1];
      const span = (seq[k + 1] ? seq[k + 1][0] : t + 1) - seq[k][0];
      const u = clamp((t - seq[k][0]) / Math.max(0.01, span), 0, 1);
      return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
    };
  })();
  const a = x.slice(), b = x;
  biquad(a, sr, 'bp', t => vf(t)[0], 5);
  biquad(b, sr, 'bp', t => vf(t)[1], 7);
  for (let i = 0; i < a.length; i++) a[i] = a[i] + b[i] * 0.6;
  shape(a, sr, o.env);
  return a;
}

function placeVoices(sr, dur, chs, voices) {
  const [L, R] = chs;
  for (const { x, at, pan, g } of voices) {
    const off = Math.round(at * sr);
    const gl = g * Math.cos((pan + 1) * Math.PI / 4), gr = g * Math.sin((pan + 1) * Math.PI / 4);
    mix(L, x, off, gl); mix(R, x, off, gr);
  }
}

const MURMUR_VOWELS = [[350, 900], [500, 1500], [650, 1100], [400, 2000], [300, 2300], [600, 1700], [450, 1000]];

/** Гул трибун (петля 8 с): много далёких бормочущих голосов. */
function* renderMurmur(sr) {
  const r = rng32(6161);
  const dur = 8.25;
  const chs = [buf(sr, dur), buf(sr, dur)];
  const voices = [];
  for (let k = 0; k < 22; k++) {
    const male = r() < 0.55;
    const d = 1.2 + r() * 2.8;
    const at = r() * (dur - 0.4);
    const len = Math.min(d, dur - at);
    const x = crowdVoice(sr, r, {
      dur: len, f0: male ? 100 + r() * 50 : 180 + r() * 70, vowels: MURMUR_VOWELS, syl: 0.14 + r() * 0.1, breath: 0.35,
      env: t => Math.min(1, t / 0.1, (len - t) / 0.15) * (0.55 + 0.45 * Math.abs(Math.sin(TAU * (2.5 + k % 3) * t))),
    });
    voices.push({ x, at, pan: r() * 1.8 - 0.9, g: 0.4 + r() * 0.6 });
    yield;
  }
  placeVoices(sr, dur, chs, voices);
  const bed = stereoDecor(sr, dur, r, x => { biquad(x, sr, 'bp', 600, 0.6); return x; });
  for (let c = 0; c < 2; c++) {
    mix(chs[c], bed[c], 0, 0.6);
    biquad(chs[c], sr, 'lp', 2600, 0.7);
    biquad(chs[c], sr, 'hp', 150, 0.7);
    chs[c] = loopable(chs[c], sr, 0.25);
    yield;
  }
  normalize(chs, 0.6);
  return chs;
}

/** Аплодисменты: сотни коротких хлопков с огибающей плотности. */
function* applause(sr, chs, r, { dur, rate, at = 0, g = 1 }) {
  const [L, R] = chs;
  const clapLen = Math.ceil(sr * 0.03);
  const att = 0.12, rel = dur * 0.55;
  let nClaps = 0;
  for (let t = 0; t < dur; ) {
    const dens = rate * Math.min(1, t / att) * (t > dur - rel ? Math.max(0.03, (dur - t) / rel) : 1);
    t += -Math.log(1 - r() * 0.999) / Math.max(1, dens);
    if (t >= dur) break;
    if ((++nClaps & 63) === 0) yield;
    const off = Math.round((at + t) * sr);
    const amp = (0.3 + r() * 0.7) * g;
    const dec = sr * (0.003 + r() * 0.004);
    const pan = r() * 2 - 1;
    const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
    // хлопок: шум с резонансом ладоней
    const f = 900 + r() * 1700;
    const w = TAU * f / sr;
    let p = r() * TAU;
    for (let i = 0; i < clapLen && off + i < L.length; i++) {
      const e = Math.exp(-i / dec);
      const s = ((r() * 2 - 1) * 0.7 + Math.sin(p) * 0.6) * e;
      p += w;
      L[off + i] += s * gl; R[off + i] += s * gr;
    }
  }
}

function whistle(sr, ch, r, at, g) {
  const x = buf(sr, 0.9);
  const f0 = 2100 + r() * 600;
  mode(x, sr, t => f0 * (1 + 0.28 * Math.sin(Math.PI * Math.min(1, t / 0.7))) * (1 + 0.012 * Math.sin(TAU * 6 * t)), 1, 99,
    { att: 0.04, len: 0.8 });
  shape(x, sr, t => (t > 0.65 ? Math.max(0, 1 - (t - 0.65) / 0.12) : 1));
  mix(ch, x, Math.round(at * sr), g);
}

/** «О-о-ох» трибун — почти попал. */
function* renderOoh(sr, v) {
  const r = rng32(7171 + v);
  const dur = 1.9;
  const chs = [buf(sr, dur), buf(sr, dur)];
  const voices = [];
  for (let k = 0; k < 26; k++) {
    const male = r() < 0.55;
    const on = r() * 0.12, len = dur - on - 0.05 - r() * 0.3;
    const rise = 0.35 + r() * 0.15;
    const x = crowdVoice(sr, r, {
      dur: len, f0: male ? 110 + r() * 50 : 200 + r() * 80, breath: 0.2,
      f0fn: t => 1 + 0.16 * Math.sin(Math.PI * clamp(t / (rise * 2), 0, 1)) - 0.12 * clamp((t - rise) / 1, 0, 1),
      vowels: t => { const u = clamp(t / 0.9, 0, 1); return [lerp(320, 480, u), lerp(800, 920, u)]; },
      env: t => Math.min(1, t / 0.18) * Math.max(0, Math.min(1, (len - t) / 0.7)),
    });
    voices.push({ x, at: on, pan: r() * 1.8 - 0.9, g: 0.5 + r() * 0.5 });
    yield;
  }
  placeVoices(sr, dur, chs, voices);
  for (const c of chs) { biquad(c, sr, 'lp', 2400, 0.7); biquad(c, sr, 'hp', 120, 0.7); }
  normalize(chs, 0.7);
  return trimAll(chs, sr);
}

/** Овации: size 0 — короткие аплодисменты, 1 — громкие с криками, 2 — рёв (гейм/матч). */
function* renderCheer(sr, v, size) {
  const r = rng32(8181 + v * 17 + size * 1000);
  const dur = [2.0, 2.9, 4.6][size];
  const chs = [buf(sr, dur), buf(sr, dur)];
  const nVoices = [8, 26, 46][size];
  const voices = [];
  const YEAH = [[700, 1200], [760, 1700], [650, 1100], [300, 2200]];
  for (let k = 0; k < nVoices; k++) {
    const male = r() < 0.55;
    const on = r() * (size === 2 ? 0.5 : 0.25);
    const len = Math.min(dur - on, 0.6 + r() * (dur * 0.6));
    const vw = YEAH[(r() * YEAH.length) | 0];
    const vw2 = YEAH[(r() * YEAH.length) | 0];
    const x = crowdVoice(sr, r, {
      dur: len, f0: male ? 140 + r() * 70 : 260 + r() * 110, breath: 0.3,
      f0fn: t => 1 + 0.25 * Math.min(1, t / 0.15) - 0.15 * clamp(t / len, 0, 1),
      vowels: t => { const u = clamp(t / len, 0, 1); return [lerp(vw[0], vw2[0], u), lerp(vw[1], vw2[1], u)]; },
      env: t => Math.min(1, t / 0.06) * Math.max(0, Math.min(1, (len - t) / (len * 0.6))),
    });
    voices.push({ x, at: on, pan: r() * 1.8 - 0.9, g: 0.35 + r() * 0.45 });
    yield;
  }
  placeVoices(sr, dur, chs, voices);
  yield* applause(sr, chs, r, { dur: dur - 0.05, rate: [90, 180, 320][size], at: 0.03, g: [1.1, 0.9, 0.8][size] });
  if (size === 2) { whistle(sr, chs[0], r, 0.4, 0.25); whistle(sr, chs[1], r, 1.3, 0.2); }
  for (const c of chs) { biquad(c, sr, 'hp', 140, 0.7); biquad(c, sr, 'lp', 7000, 0.7); }
  normalize(chs, 0.75);
  return trimAll(chs, sr);
}

// ------------------------------------------------------------------ музыка (оригинальные короткие мотивы)

function brass(dst, sr, note, at, len, amp, bright = 1) {
  const f = midi(note);
  const x = buf(sr, len + 0.15);
  const env = t => (t < 0.015 ? t / 0.015 : 1) * (t > len ? Math.max(0, 1 - (t - len) / 0.12) : 1 - 0.15 * Math.min(1, t / len));
  saw(x, sr, f, 0.5, env);
  saw(x, sr, f * 1.004, 0.5, env);
  biquad(x, sr, 'lp', t => f * (2 + 4 * bright * Math.exp(-t * 6)) + 300, 0.9);
  mix(dst, x, Math.round(at * sr), amp);
}

function bell(dst, sr, note, at, amp, dec = 0.6) {
  const f = midi(note);
  const s0 = Math.round(at * sr);
  const n = Math.min(dst.length - s0, Math.ceil(sr * dec * 5));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const I = 2.2 * Math.exp(-t * 6);
    dst[s0 + i] += amp * Math.exp(-t / dec) * Math.min(1, t / 0.002) * Math.sin(TAU * f * t + I * Math.sin(TAU * f * 3.5 * t));
  }
}

function soft(dst, sr, note, at, len, amp) {
  const f = midi(note);
  const s0 = Math.round(at * sr);
  const n = Math.min(dst.length - s0, Math.ceil(sr * (len + 0.4)));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const e = Math.min(1, t / 0.03) * (t > len ? Math.exp(-(t - len) / 0.12) : 1) * (1 + 0.08 * Math.sin(TAU * 5 * t));
    const ph = TAU * f * t;
    dst[s0 + i] += amp * e * (Math.sin(ph) + 0.18 * Math.sin(3 * ph) + 0.06 * Math.sin(5 * ph));
  }
}

function taiko(dst, sr, at, amp, r) {
  mode(dst, sr, t => 66 + 80 * Math.exp(-t * 35), amp * 0.85, 0.2, { at, att: 0.002 });
  mode(dst, sr, 190, amp * 0.35, 0.05, { at });
  mode(dst, sr, 410, amp * 0.15, 0.025, { at });
  const n = noise(Math.ceil(sr * 0.15), r);
  biquad(n, sr, 'lp', 700, 0.7);
  shape(n, sr, ad(0.001, 0.025));
  mix(dst, n, Math.round(at * sr), amp * 0.5);
}

function cymbal(dst, sr, at, amp, r, dec = 0.9, swell = 0) {
  const len = dec * 4 + swell;
  const n = noise(Math.ceil(sr * len), r);
  biquad(n, sr, 'hp', 4500, 0.7);
  biquad(n, sr, 'peak', 7500, 1.5, 4);
  shape(n, sr, t => (t < swell ? Math.pow(t / swell, 3) : Math.exp(-(t - swell) / dec)));
  mix(dst, n, Math.round((at - swell) * sr), amp);
}

function finishMusic(x, sr, level) {
  biquad(x, sr, 'hp', 45, 0.7);
  normalize(x, level);
  return [trim(fades(x, sr, 0.001, 0.05), sr)];
}

/** Стингер выигранного очка: взлёт фанфары + блеск. */
function* renderStingerWin(sr) {
  const r = rng32(9101);
  const x = buf(sr, 1.5);
  [67, 72, 76, 79].forEach((n, i) => brass(x, sr, n, i * 0.065, 0.09, 0.32));
  yield;
  [72, 76, 79].forEach(n => brass(x, sr, n, 0.27, 0.42, 0.24, 1.3));
  yield;
  bell(x, sr, 84, 0.27, 0.32, 0.45);
  bell(x, sr, 91, 0.3, 0.12, 0.3);
  taiko(x, sr, 0.27, 0.6, r);
  cymbal(x, sr, 0.27, 0.12, r, 0.35);
  return finishMusic(x, sr, 0.62);
}

/** Стингер проигранного очка: «дун-дун» вниз. */
function renderStingerLose(sr) {
  const r = rng32(9202);
  const x = buf(sr, 1.4);
  brass(x, sr, 63, 0, 0.2, 0.3, 0.5); brass(x, sr, 51, 0, 0.2, 0.3, 0.4);
  brass(x, sr, 62, 0.3, 0.5, 0.3, 0.4); brass(x, sr, 50, 0.3, 0.5, 0.3, 0.3);
  taiko(x, sr, 0, 0.55, r); taiko(x, sr, 0.3, 0.7, r);
  return finishMusic(x, sr, 0.5);
}

/** Матчбол: учащающееся «сердцебиение» тайко, восходящий кластер и шумовой подъём. */
function* renderTension(sr) {
  const r = rng32(9303);
  const L = 2.6;
  const x = buf(sr, L + 0.4);
  const hits = [0, 0.55, 1.0, 1.35, 1.62, 1.84, 2.0, 2.13, 2.24, 2.33, 2.41];
  hits.forEach((t, i) => taiko(x, sr, t, 0.35 + 0.45 * i / hits.length, r));
  const pad = buf(sr, L);
  const env = t => Math.pow(clamp(t / L, 0, 1), 1.5) * (t > L - 0.03 ? Math.max(0, (L - t) / 0.03) : 1);
  for (const [n, g] of [[45, 0.5], [52, 0.35], [57, 0.3], [58, 0.15]]) {
    saw(pad, sr, t => midi(n) * Math.pow(2, t / L), g, env);
    yield;
  }
  biquad(pad, sr, 'lp', t => 300 + 2800 * Math.pow(t / L, 2), 1.2);
  mix(x, pad, 0, 0.6);
  yield;
  const ns = noise(Math.ceil(sr * L), r);
  biquad(ns, sr, 'bp', t => 400 * Math.pow(14, t / L), 1.6);
  shape(ns, sr, env);
  mix(x, ns, 0, 0.35);
  bell(x, sr, 93, L - 0.02, 0.18, 0.5);
  return finishMusic(x, sr, 0.6);
}

/** Победный джингл (оригинальная мелодия, до мажор, ~3 с). */
function* renderVictory(sr) {
  const r = rng32(9404);
  const e = 0.15; // восьмая
  const x = buf(sr, 18 * e + 1.4);
  const mel = [[0, 67, 1], [1, 72, 1], [2, 74, 1], [3, 76, 2], [5, 74, 1], [6, 76, 1], [7, 79, 3], [10, 77, 1], [11, 79, 1], [12, 84, 6]];
  for (const [s, n, d] of mel) { brass(x, sr, n, s * e, d * e * 0.92, 0.3, 1.2); bell(x, sr, n + 12, s * e, 0.07, 0.25); yield; }
  const bass = [[0, 48, 3], [3, 53, 4], [7, 55, 3], [10, 55, 2], [12, 48, 6]];
  for (const [s, n, d] of bass) { brass(x, sr, n, s * e, d * e * 0.95, 0.28, 0.5); yield; }
  for (const n of [60, 64, 67, 72]) { brass(x, sr, n, 12 * e, 6 * e, 0.14, 0.9); yield; }
  bell(x, sr, 96, 12 * e, 0.12, 0.6);
  for (const s of [0, 3, 7, 10, 12]) taiko(x, sr, s * e, s === 12 ? 0.8 : 0.5, r);
  cymbal(x, sr, 12 * e, 0.18, r, 0.8, 0.35);
  return finishMusic(x, sr, 0.68);
}

/** Джингл поражения: мягкое нисходящее ля минор. */
function* renderDefeat(sr) {
  const e = 0.22;
  const x = buf(sr, 14 * e + 1.2);
  const mel = [[0, 76, 2], [2, 74, 2], [4, 72, 2], [6, 71, 2], [8, 69, 6]];
  for (const [s, n, d] of mel) { soft(x, sr, n, s * e, d * e * 0.95, 0.32); yield; }
  const pad = [[0, [57, 60, 64], 4], [4, [53, 57, 60], 4], [8, [52, 56, 59], 2], [10, [45, 57, 60, 64], 4]];
  for (const [s, ns, d] of pad) { for (const n of ns) soft(x, sr, n - 12, s * e, d * e, 0.12); yield; }
  bell(x, sr, 81, 8 * e, 0.06, 0.8);
  return finishMusic(x, sr, 0.5);
}

// ------------------------------------------------------------------ импульс зала для свёртки

/** Синтетический импульс спортзала: ранние отражения + хвост ~1.7 с, темнеющий со временем. */
function* renderHallIR(sr) {
  const r = rng32(1234567);
  const L = 2.4;
  const chs = [];
  for (let c = 0; c < 2; c++) {
    const x = buf(sr, L);
    const early = [0.011, 0.017, 0.023, 0.031, 0.038, 0.047, 0.059, 0.072, 0.086];
    for (const t of early) {
      const i = Math.round((t + (r() - 0.5) * 0.004) * sr);
      x[i] += (r() < 0.5 ? -1 : 1) * (0.25 + r() * 0.45) * Math.exp(-t / 0.08);
    }
    const tail = noise(x.length, r);
    const tau = 1.7 / 6.91;
    shape(tail, sr, t => (t < 0.02 ? 0 : Math.min(1, (t - 0.02) / 0.03)) * Math.exp(-t / tau) * 0.5);
    onepole(tail, sr, t => 9000 * Math.exp(-t * 1.4) + 1400);
    mix(x, tail, 0, 1);
    biquad(x, sr, 'hp', 140, 0.7);
    chs.push(fades(x, sr, 0, 0.1));
    yield;
  }
  // нормировка по энергии
  let e = 0; for (const c of chs) for (let i = 0; i < c.length; i++) e += c[i] * c[i];
  const k = 1 / Math.sqrt(e / 2 + 1e-9) * 2.2;
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= k;
  return chs;
}

// ------------------------------------------------------------------ реестр

const CROWD_SR = 22050;

export const RECIPES = {
  boom:        { cat: 'sfx', variants: 2, render: renderBoom },
  riser:       { cat: 'sfx', variants: 2, render: renderRiser },
  shing:       { cat: 'sfx', variants: 2, render: renderShing },
  whiff:       { cat: 'sfx', variants: 3, render: renderWhiff },
  net:         { cat: 'sfx', variants: 2, render: renderNet },
  land:        { cat: 'sfx', variants: 3, render: (sr, v) => renderLand(sr, v, false) },
  landOut:     { cat: 'sfx', variants: 2, render: (sr, v) => renderLand(sr, v, true) },
  squeak:      { cat: 'sfx', variants: 5, render: renderSqueak },
  step:        { cat: 'sfx', variants: 4, render: renderStep },
  thud:        { cat: 'sfx', variants: 2, render: renderThud },
  click:       { cat: 'sfx', variants: 2, render: renderClick },
  air:         { cat: 'amb', variants: 1, render: renderAir },
  room:        { cat: 'amb', variants: 1, sr: CROWD_SR, render: renderRoom },
  murmur:      { cat: 'amb', variants: 1, sr: CROWD_SR, render: renderMurmur },
  ooh:         { cat: 'crowd', variants: 2, sr: CROWD_SR, render: renderOoh },
  applause:    { cat: 'crowd', variants: 2, sr: CROWD_SR, render: (sr, v) => renderCheer(sr, v, 0) },
  cheer:       { cat: 'crowd', variants: 2, sr: CROWD_SR, render: (sr, v) => renderCheer(sr, v, 1) },
  roar:        { cat: 'crowd', variants: 1, sr: CROWD_SR, render: (sr, v) => renderCheer(sr, v, 2) },
  stingerWin:  { cat: 'music', variants: 1, render: renderStingerWin },
  stingerLose: { cat: 'music', variants: 1, render: renderStingerLose },
  tension:     { cat: 'music', variants: 1, render: renderTension },
  victory:     { cat: 'music', variants: 1, render: renderVictory },
  defeat:      { cat: 'music', variants: 1, render: renderDefeat },
  hallIR:      { cat: 'ir', variants: 1, render: renderHallIR },
};
for (const t of HIT_TYPES) RECIPES['hit_' + t] = { cat: 'sfx', variants: 3, render: (sr, v) => renderHit(sr, v, HIT[t]) };

/** Частота дискретизации, с которой рецепт будет синтезирован при частоте контекста sr. */
export function rateFor(name, sr = 48000) {
  const R = RECIPES[name];
  return R && R.sr ? Math.min(R.sr, sr) : sr;
}

/**
 * Начать синтез: возвращает итератор (тяжёлые рецепты — генераторы, их можно
 * выполнять порциями между кадрами). Итог — в value последнего next().
 */
export function startSound(name, sr = 48000, variant = 0) {
  const R = RECIPES[name];
  if (!R) throw new Error('unknown sound ' + name);
  const res = R.render(rateFor(name, sr), variant % R.variants);
  if (res && typeof res.next === 'function') return res;
  return { next: () => ({ done: true, value: res }) };
}

/** Синтезировать звук целиком (синхронно): каналы Float32Array. */
export function renderSound(name, sr = 48000, variant = 0) {
  const it = startSound(name, sr, variant);
  for (;;) { const s = it.next(); if (s.done) return s.value; }
}
