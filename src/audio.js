/**
 * audio.js — звук «Волана» в стиле спортивного аниме. Всё синтезируется
 * в рантайме (src/audio/bank.js), без файлов и сети: реалистичные «пинь/ток»
 * ракетки, шуршание перьев волана, писк кроссовок, шаги, гул и овации зала
 * в синтетической свёртке спортзала + аниме-акценты (бум смэша, «шинь»
 * идеального удара, стингеры очков, напряжение матчбола, джинглы победы/поражения).
 *
 * Публичный API (не менять сигнатуры):
 *   createAudio() -> Audio
 *   audio.unlock()                 — вызвать по первому жесту пользователя (политика автоплея);
 *                                    модуль и сам ловит первый pointerdown/keydown/touchend
 *   audio.playHit(type, power)     — type: ключ SHOTS; power 0..1
 *   audio.playEvent(name)          — 'point' | 'fault' | 'net' | 'land' | 'serve' | 'whiff' | 'win' | 'lose' | 'ui'
 *                                    (а также любое имя из банка: 'cheer', 'ooh', 'tension', …)
 *   audio.setMuted(bool), audio.muted
 *   audio.attach(game)             — подписка на события игры + покадровое чтение состояния
 * Дополнительно:
 *   audio.setVolume(0..1), audio.volume
 *   audio.update(dt)               — покадровое обновление (attach сам крутит rAF; можно звать вручную)
 *   audio.debug                    — счётчики для тестов: events, played, dropped, scheduled, errors, peakVoices, ready
 *   audio.renderOffline(spec)      — Promise<AudioBuffer>: та же цепочка (ревер, компрессор, лимитер)
 *                                    в OfflineAudioContext. spec: {duration, sampleRate?, sounds:[{name, at, gain?, pan?, rate?, variant?, wet?}]}
 * Настройки: localStorage['volan.settings'] {sound, volume} + событие window 'volan:settings'.
 */
import { RECIPES, HIT_TYPES, startSound, renderSound, rateFor } from './audio/bank.js';
import { SHOTS, COURT } from './config.js';
import { resolveShotType } from './player.js';

const SETTINGS_KEY = 'volan.settings';
const MAX_VOICES = 24;
const SLICE_MS = 6;          // бюджет фонового синтеза за один тик
const FF_RATIO = 6;          // игра идёт в N раз быстрее реального времени → не озвучиваем (тесты/перемотка)

/** Параметры воспроизведения: шина, громкость, мин. интервал (мс), приоритет, посыл в ревер. */
const SPEC = {
  boom:        { bus: 'sfx', gain: 0.62, gap: 120, pri: 4, wet: 0.5 },
  riser:       { bus: 'sfx', gain: 0.42, gap: 150, pri: 3, wet: 0.2 },
  shing:       { bus: 'sfx', gain: 0.4, gap: 200, pri: 4, wet: 0.4 },
  whiff:       { bus: 'sfx', gain: 0.55, gap: 100, pri: 3, wet: 0.15 },
  net:         { bus: 'sfx', gain: 0.62, gap: 80, pri: 3, wet: 0.22 },
  land:        { bus: 'sfx', gain: 0.62, gap: 80, pri: 3, wet: 0.22 },
  landOut:     { bus: 'sfx', gain: 0.55, gap: 80, pri: 3, wet: 0.25 },
  squeak:      { bus: 'sfx', gain: 0.26, gap: 70, pri: 1, wet: 0.28 },
  step:        { bus: 'sfx', gain: 0.3, gap: 20, pri: 0, wet: 0.12 },
  thud:        { bus: 'sfx', gain: 0.5, gap: 80, pri: 2, wet: 0.2 },
  click:       { bus: 'ui', gain: 0.5, gap: 30, pri: 2, wet: 0 },
  ooh:         { bus: 'crowd', gain: 0.5, gap: 1500, pri: 2, wet: 0.45 },
  applause:    { bus: 'crowd', gain: 0.45, gap: 800, pri: 2, wet: 0.4 },
  cheer:       { bus: 'crowd', gain: 0.55, gap: 800, pri: 2, wet: 0.4 },
  roar:        { bus: 'crowd', gain: 0.65, gap: 1500, pri: 3, wet: 0.4 },
  stingerWin:  { bus: 'music', gain: 0.42, gap: 400, pri: 5, wet: 0.18 },
  stingerLose: { bus: 'music', gain: 0.4, gap: 400, pri: 5, wet: 0.18 },
  tension:     { bus: 'music', gain: 0.4, gap: 1500, pri: 5, wet: 0.2 },
  victory:     { bus: 'music', gain: 0.5, gap: 2000, pri: 5, wet: 0.2 },
  defeat:      { bus: 'music', gain: 0.45, gap: 2000, pri: 5, wet: 0.2 },
};
for (const t of HIT_TYPES) SPEC['hit_' + t] = { bus: 'sfx', gain: 0.8, gap: 25, pri: 4, wet: 0.16 };

const BUS_GAIN = { sfx: 1, crowd: 0.75, music: 0.7, ui: 0.6, amb: 0.5 };

/** Порядок фонового синтеза: сначала то, что звучит в первой же секунде. */
const QUEUE = (() => {
  const q = [];
  const all = n => { for (let v = 0; v < RECIPES[n].variants; v++) q.push([n, v]); };
  for (const t of ['clear', 'smash', 'drive', 'drop', 'net', 'lift', 'serveShort', 'serveLong']) all('hit_' + t);
  for (const n of ['land', 'landOut', 'whiff', 'net', 'step', 'squeak', 'boom', 'riser', 'shing', 'thud', 'click']) all(n);
  q.push(['hallIR', 0], ['air', 0], ['room', 0], ['murmur', 0], ['applause', 0], ['stingerWin', 0], ['stingerLose', 0],
    ['cheer', 0], ['ooh', 0], ['tension', 0], ['roar', 0], ['victory', 0], ['defeat', 0], ['applause', 1], ['cheer', 1], ['ooh', 1]);
  return q;
})();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const now = () => (globalThis.performance ? performance.now() : Date.now());

function readSettings() {
  try {
    const s = JSON.parse(globalThis.localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && typeof s === 'object') {
      return { sound: s.sound !== false, volume: Number.isFinite(+s.volume) && s.volume !== null && s.volume !== '' ? clamp(+s.volume, 0, 1) : 0.8 };
    }
  } catch (_) { /* приватный режим / песочница */ }
  return { sound: true, volume: 0.8 };
}

/**
 * Микшер: шины → посыл в свёртку зала → компрессор → лимитер → громкость → выход.
 * Общий для живого и офлайн-контекста (тесты рендерят ту же цепочку).
 */
function buildGraph(ctx) {
  const g = {};
  g.mix = ctx.createGain();
  g.comp = ctx.createDynamicsCompressor();
  g.comp.threshold.value = -16; g.comp.knee.value = 10; g.comp.ratio.value = 3.5;
  g.comp.attack.value = 0.004; g.comp.release.value = 0.2;
  // Телефонные динамики: суб не воспроизводят (только съедает запас) и режут слух на ~3–4 кГц.
  g.hp = ctx.createBiquadFilter(); g.hp.type = 'highpass'; g.hp.frequency.value = 38; g.hp.Q.value = 0.7;
  g.tame = ctx.createBiquadFilter(); g.tame.type = 'peaking'; g.tame.frequency.value = 3600; g.tame.Q.value = 1.1; g.tame.gain.value = -2;
  g.shelf = ctx.createBiquadFilter(); g.shelf.type = 'highshelf'; g.shelf.frequency.value = 9000; g.shelf.gain.value = -3;
  g.limiter = ctx.createDynamicsCompressor();
  g.limiter.threshold.value = -3; g.limiter.knee.value = 0; g.limiter.ratio.value = 20;
  g.limiter.attack.value = 0.001; g.limiter.release.value = 0.08;
  g.trim = ctx.createGain(); g.trim.gain.value = 0.92; // запас после лимитера (межсэмпловые пики)
  g.volume = ctx.createGain();
  g.mix.connect(g.comp).connect(g.hp).connect(g.tame).connect(g.shelf).connect(g.limiter).connect(g.trim).connect(g.volume).connect(ctx.destination);
  g.reverbIn = ctx.createGain();
  g.convolver = ctx.createConvolver(); g.convolver.normalize = false;
  g.reverbOut = ctx.createGain(); g.reverbOut.gain.value = 0.55;
  g.reverbIn.connect(g.convolver).connect(g.reverbOut).connect(g.mix);
  g.bus = {};
  for (const [k, v] of Object.entries(BUS_GAIN)) { const b = ctx.createGain(); b.gain.value = v; b.connect(g.mix); g.bus[k] = b; }
  return g;
}

function toBuffer(ctx, chs, rate) {
  const b = ctx.createBuffer(chs.length, chs[0].length, rate);
  for (let c = 0; c < chs.length; c++) {
    if (b.copyToChannel) b.copyToChannel(chs[c], c); else b.getChannelData(c).set(chs[c]);
  }
  return b;
}

function makePanner(ctx) {
  if (ctx.createStereoPanner) return ctx.createStereoPanner();
  const g = ctx.createGain(); g.pan = { value: 0, setValueAtTime() {}, setTargetAtTime() {} }; return g; // старые Safari
}

export function createAudio() {
  let ctx = null, G = null;
  let game = null;
  const settings = readSettings();
  const buffers = new Map();            // 'name#v' → AudioBuffer
  const strips = [];                    // пул каналов {gain, pan, send, bus, src, until, pri, start}
  const lastAt = new Map();             // name → performance.now() последнего запуска
  const loops = {};                     // постоянные петли: air, room, murmur
  let queueIdx = 0, cur = null, pumping = false;
  let ffW = 0, ffG = null, ffUntil = 0;
  let rafId = 0;
  const seenSwings = new WeakSet();
  const pstate = new Map();
  let lastGT = -1;
  const mood = { rallyHits: 0, hush: 0, lastLand: null };

  const debug = {
    events: {}, played: {}, dropped: {}, scheduled: 0, errors: 0, lastError: null,
    peakVoices: 0, voices: 0, loops: [], ready: { done: 0, total: QUEUE.length }, synthMs: 0,
  };
  const drop = (why) => { debug.dropped[why] = (debug.dropped[why] || 0) + 1; return false; };

  const A = {
    muted: !settings.sound,
    volume: settings.volume,
    debug,
    get context() { return ctx; },

    unlock() {
      try {
        if (!ctx) {
          const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
          if (!AC) return;
          try { ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { ctx = new AC(); }
          G = buildGraph(ctx);
          for (let i = 0; i < MAX_VOICES; i++) {
            const s = { gain: ctx.createGain(), pan: makePanner(ctx), send: ctx.createGain(), bus: null, src: null, until: 0, pri: -1, start: 0 };
            s.gain.connect(s.pan); s.send.connect(G.reverbIn);
            strips.push(s);
          }
          applyVolume(true);
          // iOS: короткий тихий буфер «будит» вывод.
          const sb = ctx.createBufferSource(); sb.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); sb.connect(ctx.destination); sb.start(0);
          pump();
        }
        if (ctx.state === 'suspended' && !A.muted && !(globalThis.document && document.hidden)) ctx.resume().catch(() => {});
      } catch (e) { fail(e); }
    },

    setMuted(b) { A.muted = !!b; applyVolume(); },
    setVolume(v) { A.volume = clamp(+v || 0, 0, 1); applyVolume(); },

    playHit(type, power = 0.5, info = {}) {
      if (!HIT_TYPES.includes(type)) type = type === 'smashdrop' ? 'smash' : type === 'smart' ? 'clear' : 'clear';
      power = clamp(+power || 0, 0, 1);
      const pl = info.pos || placeAt(0, 0, 1, true);
      const g = (0.5 + 0.5 * power) * pl.gain;
      const rate = (1 + (Math.random() - 0.5) * 0.05) * (type === 'smash' ? 1 - 0.05 * power : 1);
      const ok = play('hit_' + type, { gain: g, pan: pl.pan, rate, wet: pl.wet });
      if (type === 'smash') play('boom', { gain: (0.35 + 0.65 * power) * pl.gain, pan: pl.pan * 0.5, delay: 0.004, wet: pl.wet });
      if (info.perfect) play('shing', { gain: 0.8, pan: pl.pan * 0.6, delay: 0.025, rate: 1 + (Math.random() - 0.5) * 0.04 });
      return ok;
    },

    playEvent(name, opts = {}) {
      const alias = { point: 'stingerWin', fault: 'stingerLose', win: 'victory', lose: 'defeat', ui: 'click' }[name];
      if (name === 'serve') return A.playHit('serveShort', 0.5);
      return play(alias || name, opts);
    },

    attach(g) {
      game = g;
      const on = (n, fn) => g.on(n, e => { debug.events[n] = (debug.events[n] || 0) + 1; try { fn(e || {}); } catch (err) { fail(err); } });
      on('hit', onHit);
      on('whiff', e => { const p = e.player; const pl = p ? placeAt(p.x, p.y, 1.2, p.team === humanTeam()) : placeAt(0, 0, 1, true); play('whiff', { gain: pl.gain, pan: pl.pan, wet: pl.wet }); });
      on('net', e => { const pl = placeAt(e.x ?? 0, e.y ?? 0, e.z ?? 1.5); play('net', { gain: pl.gain, pan: pl.pan, wet: pl.wet }); });
      on('land', onLand);
      on('point', onPoint);
      on('game', () => { play('roar', { delay: 0.2 }); });
      on('matchOver', e => {
        if (!game.human) return;
        play(e.winner === humanTeam() ? 'victory' : 'defeat', { delay: 0.55 });
      });
      on('serveReady', onServeReady);
      on('serve', () => { mood.hush = Math.max(0, mood.hush - 0.5); });
      startLoop();
    },

    update(dt = 1 / 60) {
      if (!ctx || !game || ctx.state !== 'running') return;
      try { frame(dt); } catch (e) { fail(e); }
    },

    /** Офлайн-рендер той же цепочки — для проверки уровней/спектра в тестах. */
    async renderOffline(spec = {}) {
      const sr = spec.sampleRate || 48000;
      const dur = spec.duration || 2;
      const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      const oc = new OAC(2, Math.ceil(sr * dur), sr);
      const og = buildGraph(oc);
      og.volume.gain.value = spec.volume ?? 1;
      og.convolver.buffer = toBuffer(oc, renderSound('hallIR', sr), sr);
      for (const s of spec.sounds || []) {
        const R = RECIPES[s.name];
        if (!R) throw new Error('unknown sound ' + s.name);
        const sp = SPEC[s.name] || { bus: 'sfx', gain: 0.6, wet: 0.2 };
        const src = oc.createBufferSource();
        src.buffer = toBuffer(oc, renderSound(s.name, sr, s.variant || 0), rateFor(s.name, sr));
        src.playbackRate.value = s.rate || 1;
        if (s.loop) src.loop = true;
        const gn = oc.createGain(); gn.gain.value = (s.gain ?? 1) * sp.gain;
        const pn = makePanner(oc); pn.pan.value = s.pan || 0;
        const sd = oc.createGain(); sd.gain.value = s.wet ?? sp.wet;
        src.connect(gn).connect(pn); pn.connect(og.bus[sp.bus]); pn.connect(sd).connect(og.reverbIn);
        src.start(s.at || 0);
        if (s.stopAt) src.stop(s.stopAt);
      }
      return oc.startRendering();
    },
  };

  // ------------------------------------------------------------ служебное

  function fail(e) { debug.errors++; debug.lastError = String(e && e.stack || e); }

  function applyVolume(instant) {
    if (!ctx) return;
    const v = A.muted ? 0 : Math.pow(A.volume, 1.6); // ближе к слуховой шкале
    const t = ctx.currentTime;
    G.volume.gain.cancelScheduledValues(t);
    if (instant) G.volume.gain.setValueAtTime(v, t); else G.volume.gain.setTargetAtTime(v, t, 0.04);
    if (A.muted) {
      setTimeout(() => { if (A.muted && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 200);
    } else if (ctx.state === 'suspended' && !(globalThis.document && document.hidden)) ctx.resume().catch(() => {});
  }

  /** Фоновый синтез банка порциями (не блокирует кадры). */
  function pump() {
    if (pumping) return;
    pumping = true;
    const tick = () => {
      const t0 = now();
      try {
        while (now() - t0 < SLICE_MS) {
          if (!cur) {
            while (queueIdx < QUEUE.length && buffers.has(QUEUE[queueIdx].join('#'))) { queueIdx++; debug.ready.done++; }
            if (queueIdx >= QUEUE.length) { pumping = false; return; }
            const [n, v] = QUEUE[queueIdx++];
            cur = { n, v, it: startSound(n, ctx.sampleRate, v) };
          }
          const s = cur.it.next();
          if (s.done) { store(cur.n, cur.v, s.value); debug.ready.done++; cur = null; }
        }
      } catch (e) { fail(e); cur = null; }
      debug.synthMs += now() - t0;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  }

  function store(n, v, chs) {
    const key = n + '#' + v;
    if (buffers.has(key)) return buffers.get(key);
    const b = toBuffer(ctx, chs, rateFor(n, ctx.sampleRate));
    buffers.set(key, b);
    if (n === 'hallIR') G.convolver.buffer = b;
    if (n === 'air' || n === 'room' || n === 'murmur') startAmbience(n, b);
    return b;
  }

  /** Буфер звука: короткие синтезируются сразу по требованию, длинные ждут фон. */
  function getBuffer(n, variant) {
    const R = RECIPES[n];
    if (!R) return null;
    let v = variant;
    if (v == null) {
      // случайный из уже готовых вариантов (для толпы/музыки), для sfx — любой
      const ready = [];
      for (let i = 0; i < R.variants; i++) if (buffers.has(n + '#' + i)) ready.push(i);
      v = R.cat === 'sfx' ? (Math.random() * R.variants) | 0 : ready.length ? ready[(Math.random() * ready.length) | 0] : 0;
    }
    const key = n + '#' + v;
    if (buffers.has(key)) return buffers.get(key);
    if (R.cat !== 'sfx') return null;
    const t0 = now();
    const b = store(n, v, renderSound(n, ctx.sampleRate, v));
    debug.synthMs += now() - t0;
    return b;
  }

  /** Игра «перематывается» (runUntil в тестах) — пачки событий не озвучиваем. */
  function fastForward() {
    if (!game) return false;
    const w = now() / 1000, g = game.time;
    if (ffG != null && g > ffG && g - ffG > (w - ffW) * FF_RATIO + 0.1) ffUntil = w + 0.2;
    if (ffG == null || g < ffG || w - ffW > 0.02) { ffG = g; ffW = w; }
    return w < ffUntil;
  }

  function allocStrip(pri, t) {
    let free = null, worst = null;
    let active = 0;
    for (const s of strips) {
      if (s.until <= t) { if (!free) free = s; continue; }
      active++;
      if (!worst || s.pri < worst.pri || (s.pri === worst.pri && s.start < worst.start)) worst = s;
    }
    debug.voices = active;
    if (active + 1 > debug.peakVoices) debug.peakVoices = Math.min(MAX_VOICES, active + 1);
    if (free) return { s: free, steal: false };
    if (worst && worst.pri <= pri) return { s: worst, steal: true };
    return null;
  }

  /**
   * Запустить звук. o: {gain, pan, rate, wet, delay, offset, variant}
   * Возвращает true, если звук поставлен в очередь воспроизведения.
   */
  function play(name, o = {}) {
    if (!ctx) return drop('locked');
    if (A.muted) return drop('muted');
    if (ctx.state !== 'running') return drop('suspended');
    const sp = SPEC[name];
    if (!sp) return drop('unknown');
    if (fastForward()) return drop('fastforward');
    if (demoDuck(sp.bus) === 0) return drop('demo');
    const w = now();
    if (w - (lastAt.get(name) ?? -1e9) < sp.gap) return drop('ratelimit');
    const b = getBuffer(name, o.variant);
    if (!b) return drop('notready');
    let t = ctx.currentTime + 0.005 + (o.delay || 0);
    const slot = allocStrip(sp.pri, t);
    if (!slot) return drop('voices');
    const s = slot.s;
    try {
      if (slot.steal && s.src) {
        // мягко гасим вытесняемый голос
        const tc = ctx.currentTime;
        s.gain.gain.cancelScheduledValues(tc);
        s.gain.gain.setValueAtTime(s.gain.gain.value, tc);
        s.gain.gain.linearRampToValueAtTime(0, tc + 0.012);
        try { s.src.stop(tc + 0.014); } catch (_) { /* уже остановлен */ }
        t = Math.max(t, tc + 0.015);
      }
      const bus = G.bus[sp.bus];
      if (s.bus !== bus) {
        s.pan.disconnect();
        s.pan.connect(bus); s.pan.connect(s.send);
        s.bus = bus;
      }
      const src = ctx.createBufferSource();
      src.buffer = b;
      const rate = clamp(o.rate || 1, 0.25, 4);
      src.playbackRate.value = rate;
      src.connect(s.gain);
      const gain = clamp((o.gain ?? 1) * sp.gain * demoDuck(sp.bus), 0, 2);
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setValueAtTime(gain, t);
      s.pan.pan.setValueAtTime(clamp(o.pan || 0, -1, 1), t);
      s.send.gain.setValueAtTime(clamp(sp.wet + (o.wet || 0), 0, 1), t);
      const off = clamp(o.offset || 0, 0, b.duration - 0.001);
      src.start(t, off);
      s.src = src; s.pri = sp.pri; s.start = t;
      s.until = t + (b.duration - off) / rate + 0.02;
      src.onended = () => { if (s.src === src) { s.src = null; s.until = 0; } try { src.disconnect(); } catch (_) { /* */ } };
      lastAt.set(name, w);
      debug.scheduled++;
      debug.played[name] = (debug.played[name] || 0) + 1;
      return true;
    } catch (e) { fail(e); return false; }
  }

  /** Демо-матч в меню (без человека) — тише, без музыки. */
  function demoDuck(bus) {
    if (!game || game.human) return 1;
    return bus === 'music' ? 0 : bus === 'ui' ? 1 : 0.45;
  }

  // ------------------------------------------------------------ пространство

  function humanTeam() { return game && game.human ? game.human.team : 0; }
  function humanSide() {
    try { return game.match.teamSides[humanTeam()]; } catch (_) { return -1; }
  }

  /** Панорама по экранной проекции (если есть рендер), близость — по половине корта. */
  function placeAt(x, y, z = 1, near = null) {
    let pan = 0;
    const R = A.renderer || (globalThis.__game && globalThis.__game.renderer);
    try {
      if (R && R.project && R.w > 0) {
        const q = R.project(x, y, z);
        if (Number.isFinite(q.x)) pan = clamp((q.x / R.w) * 2 - 1, -1, 1) * 0.6;
      }
    } catch (_) { /* рендер мог смениться */ }
    if (near == null) near = Math.sign(x || -1e-6) === humanSide();
    return { pan, gain: near ? 1 : 0.62, wet: near ? 0 : 0.15 };
  }

  // ------------------------------------------------------------ события игры

  function onHit(e) {
    const p = e.player || {};
    let type = e.type in SHOTS ? e.type : 'clear';
    const max = SHOTS[type] ? SHOTS[type].maxSpeed : 50;
    const power = clamp((e.speed || 10) / (max * 0.8), 0, 1);
    const near = p.team === humanTeam();
    const pl = placeAt(p.x ?? 0, p.y ?? 0, 1.6, near);
    const humanSlot = game.human && p === game.human;
    A.playHit(type, power, { pos: pl, perfect: e.timing === 'perfect' && !e.serve && humanSlot });
    if (e.lunge) {
      play('squeak', { gain: 0.9 * pl.gain, pan: pl.pan, rate: 0.95 + Math.random() * 0.1 });
      play('step', { gain: pl.gain, pan: pl.pan, delay: 0.01 });
    }
    mood.rallyHits = (game.shuttle && game.shuttle.hits) || mood.rallyHits + 1;
  }

  function onLand(e) {
    const pl = placeAt(e.x ?? 0, e.y ?? 0, 0);
    play(e.in ? 'land' : 'landOut', { gain: pl.gain, pan: pl.pan, wet: pl.wet, rate: 0.96 + Math.random() * 0.08 });
    // почти попал — трибуны «о-ох»
    let miss = Infinity;
    if (!e.in) {
      const hw = game.match && game.match.mode === 'doubles' ? COURT.HALF_WIDTH_DOUBLES : COURT.HALF_WIDTH_SINGLES;
      const dx = Math.abs(e.x) - COURT.HALF_LENGTH, dy = Math.abs(e.y) - hw;
      miss = Math.max(dx, dy);
      if (miss > 0 && miss < 0.4) play('ooh', { delay: 0.12 });
    }
    mood.lastLand = { in: !!e.in, miss };
  }

  function onPoint(e) {
    const hits = e.rallyLength || mood.rallyHits || 0;
    const smashWinner = e.reason === 'in' && game.rally && game.rally.lastType === 'smash';
    const result = e.result || {};
    if (game.human) {
      const won = e.winner === humanTeam();
      play(won ? 'stingerWin' : 'stingerLose', { delay: 0.04 });
    }
    if (!result.gameWon) {
      const score = hits + (smashWinner ? 7 : 0);
      const delay = mood.lastLand && mood.lastLand.miss < 0.4 ? 0.7 : 0.25;
      if (score >= 14) play('cheer', { delay, gain: 1 });
      else if (score >= 7) play('cheer', { delay, gain: 0.7 });
      else play('applause', { delay, gain: 0.55 + 0.05 * score });
      if (hits >= 12 && e.reason !== 'in' && !(mood.lastLand && mood.lastLand.miss < 0.4)) play('ooh', { delay: 0.1, gain: 0.8 });
    }
    mood.rallyHits = 0;
  }

  function onServeReady() {
    const m = game.match;
    mood.rallyHits = 0;
    if (!m || !m.format) return;
    const f = m.format, need = Math.ceil(f.games / 2);
    let matchPoint = false;
    for (let t = 0; t < 2; t++) {
      const s = m.score[t], o = m.score[1 - t];
      const gp = (s >= f.points - 1 && s > o) || s === f.cap - 1;
      if (gp && m.games[t] === need - 1) matchPoint = true;
    }
    if (matchPoint) {
      mood.hush = 1;
      if (game.human) play('tension', { delay: 0.2 });
    }
  }

  // ------------------------------------------------------------ покадрово: шаги, писк, воздух, трибуны

  function startLoop() {
    if (rafId || typeof globalThis.requestAnimationFrame !== 'function') return;
    let last = now();
    const tick = () => {
      const t = now();
      A.update(Math.min(0.1, (t - last) / 1000));
      last = t;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function startAmbience(n, b) {
    if (loops[n]) return;
    const src = ctx.createBufferSource();
    src.buffer = b; src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const L = { src, gain };
    if (n === 'air') {
      L.filter = ctx.createBiquadFilter(); L.filter.type = 'bandpass'; L.filter.Q.value = 0.9; L.filter.frequency.value = 800;
      L.pan = makePanner(ctx);
      src.connect(L.filter).connect(gain).connect(L.pan);
      L.pan.connect(G.bus.sfx);
      L.send = ctx.createGain(); L.send.gain.value = 0.15; L.pan.connect(L.send).connect(G.reverbIn);
    } else {
      src.connect(gain).connect(n === 'room' ? G.bus.amb : G.bus.crowd);
      if (n === 'murmur') { L.send = ctx.createGain(); L.send.gain.value = 0.35; gain.connect(L.send).connect(G.reverbIn); }
      if (n === 'room') gain.gain.value = 0.0001;
    }
    src.start(ctx.currentTime + 0.05, Math.random() * b.duration * 0.9);
    loops[n] = L;
    debug.loops = Object.keys(loops);
  }

  function frame(dt) {
    const t = ctx.currentTime;
    const gt = game.time || 0;
    const jumped = gt < lastGT || gt - lastGT > 0.3;   // перемотка/новый матч — только синхронизируем
    lastGT = gt;
    const active = game.phase === 'rally' || game.phase === 'serve' || game.phase === 'point';
    const paused = game.paused;

    for (const p of game.players || []) {
      let st = pstate.get(p);
      const sp = Math.hypot(p.vx, p.vy);
      if (!st || jumped) {
        st = { step: Math.floor(p.anim / Math.PI), z: p.z, hvx: p.vx, hvy: p.vy, ht: gt, sq: -9 };
        pstate.set(p, st);
        continue;
      }
      if (paused || !active) { st.step = Math.floor(p.anim / Math.PI); st.z = p.z; continue; }
      const near = p.team === humanTeam();
      // шаги
      const ph = Math.floor(p.anim / Math.PI);
      if (ph !== st.step) {
        st.step = ph;
        if (sp > 0.9 && p.z < 0.02) {
          const pl = placeAt(p.x, p.y, 0, near);
          play('step', { gain: (0.35 + 0.5 * clamp(sp / 5, 0, 1)) * pl.gain, pan: pl.pan, wet: pl.wet, rate: 0.9 + Math.random() * 0.2 });
        }
      }
      // писк подошвы: резкая смена направления или торможение (сравнение со скоростью ~0.1 с назад)
      if (gt - st.ht >= 0.09) {
        const hs = Math.hypot(st.hvx, st.hvy);
        if (hs > 2.6 && p.z < 0.02 && gt - st.sq > 0.45) {
          const cos = sp > 0.05 ? (p.vx * st.hvx + p.vy * st.hvy) / (sp * hs) : -1;
          if (cos < 0.2 || sp < hs * 0.4) {
            st.sq = gt;
            const pl = placeAt(p.x, p.y, 0, near);
            play('squeak', { gain: (0.5 + 0.5 * clamp(hs / 5, 0, 1)) * pl.gain, pan: pl.pan, wet: pl.wet, rate: 0.92 + Math.random() * 0.16 });
          }
        }
        st.hvx = p.vx; st.hvy = p.vy; st.ht = gt;
      }
      // приземление после прыжка
      if (st.z > 0.1 && p.z <= 0.001) {
        const pl = placeAt(p.x, p.y, 0, near);
        play('thud', { gain: pl.gain, pan: pl.pan, wet: pl.wet });
      }
      st.z = p.z;
      // свист перед смэшем: заканчивается ровно в момент контакта
      const w = p.swing;
      if (w && !w.done && !seenSwings.has(w)) {
        seenSwings.add(w);
        let type = w.type;
        try { type = resolveShotType(w.type, w.contact || { x: p.x, y: p.y, z: 2.6 }, p.side); } catch (_) { /* */ }
        const T = (w.contactAt || 0) - (w.t || 0);
        if (type === 'smash' && T > 0.05) {
          const pl = placeAt(p.x, p.y, 2, near);
          const L = 0.3;
          play('riser', { gain: pl.gain, pan: pl.pan, delay: Math.max(0, T - L), offset: Math.max(0, L - T) });
        }
      }
    }

    // воздух вокруг волана
    const sh = game.shuttle;
    const air = loops.air;
    if (air) {
      const v = sh && sh.state === 'flight' && !paused ? Math.hypot(sh.vx, sh.vy, sh.vz) : 0;
      const k = Math.pow(clamp((v - 7) / 38, 0, 1), 1.4);
      const pl = sh ? placeAt(sh.x, sh.y, sh.z) : { pan: 0, gain: 1 };
      air.gain.gain.setTargetAtTime(A.muted ? 0 : k * 0.42 * pl.gain * demoDuck('sfx'), t, 0.025);
      air.filter.frequency.setTargetAtTime(450 + v * 55, t, 0.03);
      air.pan.pan.setTargetAtTime(pl.pan, t, 0.05);
    }
    // гул трибун растёт с длиной розыгрыша; перед матчболом — затишье
    mood.hush = Math.max(0, mood.hush - dt * (game.phase === 'rally' ? 0.25 : 0.02));
    const hits = game.phase === 'rally' ? ((sh && sh.hits) || 0) : mood.rallyHits;
    let crowd = active ? 0.3 + 0.7 * clamp(hits / 18, 0, 1) : 0.25;
    if (game.phase === 'point') crowd = 0.45;
    if (paused) crowd = 0.15;
    crowd *= 1 - 0.65 * mood.hush;
    if (loops.murmur) loops.murmur.gain.gain.setTargetAtTime(crowd * 0.35 * demoDuck('crowd'), t, 0.6);
    if (loops.room) loops.room.gain.gain.setTargetAtTime(0.35, t, 0.5);
  }

  // ------------------------------------------------------------ окружение

  if (typeof globalThis.addEventListener === 'function') {
    const gesture = () => { A.unlock(); if (ctx && ctx.state === 'running') for (const n of ['pointerdown', 'keydown', 'touchend', 'mousedown']) globalThis.removeEventListener(n, gesture, true); };
    for (const n of ['pointerdown', 'keydown', 'touchend', 'mousedown']) globalThis.addEventListener(n, gesture, true);
    globalThis.addEventListener('volan:settings', ev => {
      const s = ev && ev.detail;
      if (!s) return;
      if ('sound' in s) A.muted = s.sound === false;
      if ('volume' in s && Number.isFinite(+s.volume)) A.volume = clamp(+s.volume, 0, 1);
      applyVolume();
    });
    globalThis.addEventListener('storage', ev => {
      if (ev.key !== SETTINGS_KEY) return;
      const s = readSettings(); A.muted = !s.sound; A.volume = s.volume; applyVolume();
    });
  }
  if (globalThis.document && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend().catch(() => {});
      else if (!A.muted) ctx.resume().catch(() => {});
    });
    // щелчки интерфейса
    document.addEventListener('click', ev => {
      const el = ev.target && ev.target.closest && ev.target.closest('button, [role="button"], .seg-btn, input[type="checkbox"], input[type="range"], select');
      if (el) play('click', { variant: el.classList && el.classList.contains('primary') ? 1 : 0 });
    }, true);
  }

  return A;
}
