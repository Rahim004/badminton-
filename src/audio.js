/**
 * audio.js — звук (заглушка с минимальным процедурным «щелчком»).
 * Звуковой агент заменит реализацию, сохранив API.
 *
 * Публичный API (не менять сигнатуры):
 *   createAudio() -> Audio
 *   audio.unlock()                 — вызвать по первому жесту пользователя (политика автоплея)
 *   audio.playHit(type, power)     — type: ключ SHOTS; power 0..1
 *   audio.playEvent(name)          — 'point' | 'fault' | 'net' | 'land' | 'serve' | 'whiff' | 'win' | 'lose' | 'ui'
 *   audio.setMuted(bool), audio.muted
 *   audio.attach(game)             — подписка на события игры
 */
export function createAudio() {
  let ctx = null;
  const A = {
    muted: false,
    unlock() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC(); } catch (_) { ctx = null; }
    },
    setMuted(b) { A.muted = !!b; },
    playHit(type, power = 0.5) {
      if (!ctx || A.muted) return;
      const t = ctx.currentTime;
      const len = 0.06;
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass';
      f.frequency.value = type === 'smash' ? 2400 : type === 'net' || type === 'drop' ? 1200 : 1800;
      f.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.25 + 0.6 * Math.min(1, power), t);
      src.connect(f).connect(g).connect(ctx.destination);
      src.start(t);
    },
    playEvent(name) {
      if (!ctx || A.muted) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      const freq = { point: 660, win: 880, lose: 220, fault: 260, net: 180, ui: 520, serve: 0, land: 0, whiff: 0 }[name] ?? 0;
      if (!freq) return;
      o.frequency.value = freq; o.type = 'triangle';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.3);
    },
    attach(game) {
      game.on('hit', e => A.playHit(e.type, Math.min(1, (e.speed || 10) / 50)));
      game.on('net', () => A.playEvent('net'));
      game.on('whiff', () => A.playEvent('whiff'));
      game.on('point', e => {
        const humanTeam = game.human ? game.human.team : 0;
        A.playEvent(e.winner === humanTeam ? 'point' : 'fault');
      });
      game.on('matchOver', e => A.playEvent(e.winner === (game.human ? game.human.team : 0) ? 'win' : 'lose'));
    },
  };
  return A;
}
