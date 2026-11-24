/**
 * net/host.js — хост: авторитетная симуляция + приём ввода гостей + снимки (без DOM).
 *
 * Ввод гостя приходит с меткой тика симуляции (сетка хоста, DT = 1/120): гость
 * отправляет его заранее, на «своё» время R ≈ время прихода к хосту. Хост держит
 * ранний ввод до его тика (onPreStep), опоздавший применяет сразу; нажатие удара
 * получает время нажатия = тик гостя, поэтому оценка тайминга та же, что у локального
 * игрока (ожидание в буфере засчитывается как pressAge — см. game.remoteShot).
 */
import { PHYSICS } from '../config.js';
import { encodePlayer, encodeSeg, encodeMatch, encodeEvent, encodeStats, EVENTS, PHASES } from './codec.js';

const DT = PHYSICS.DT;

export function createHostDriver(game) {
  const H = {
    rally: 0,
    seg: { id: 0, t0: 0, st: { x: 0, y: 0, z: 1, vx: 0, vy: 0, vz: 0, state: 'held', lastHitTeam: -1, lastHitter: -1, netHit: false, isServe: false, hits: 0 } },
    events: [],          // закодированные события (последние 64)
    evSeq: 0,
    mv: 1,
    remotes: new Map(),  // playerId → {samples:[], shots:[], lastShotSeq, lastTick, lastRx, late:[]}
    swingIds: new WeakMap(), swingN: 0,
    n: 0,
    unsub: [],
  };

  function shCopy() {
    const s = game.shuttle;
    return { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, state: s.state, lastHitTeam: s.lastHitTeam, lastHitter: s.lastHitter, netHit: !!s.netHit, isServe: !!s.isServe, hits: s.hits | 0 };
  }
  const segId = () => H.rally * 64 + Math.min(63, game.shuttle.hits | 0);

  function onEvent(name, e) {
    if (name === 'serveReady') { H.rally++; H.seg = { id: H.rally * 64, t0: game.time, st: shCopy() }; }
    if (name === 'hit') {
      // Удар: вылет до шага интегрирования этого тика (у подачи шага в этом тике нет).
      H.seg = { id: segId(), t0: e.serve ? game.time : game.time - DT, st: shCopy() };
      if (e.serve) H.seg.st.isServe = true;
    }
    if (name === 'whiff' && e.player) e.player._whiffN = (e.player._whiffN | 0) + 1;
    if (name === 'point' || name === 'sides' || name === 'game') H.mv++;
    if (name === 'serve') return;   // подачу гость узнаёт по 'hit' {serve:true} и по отрезку
    const extra = { sg: H.seg.id };
    if (name === 'point') extra.m = encodeMatch(game.match);
    if (name === 'matchOver') extra.stats = encodeStats(game.stats);
    const enc = encodeEvent(++H.evSeq, name, e, game.time, extra);
    if (!enc) return;
    H.events.push(enc);
    if (H.events.length > 64) H.events.shift();
  }

  for (const name of EVENTS) {
    const fn = e => { try { onEvent(name, e); } catch (err) { console.error(err); } };
    game.on(name, fn);
    H.unsub.push(() => game.off(name, fn));
  }

  /** Новый матч: всё обнуляем (вызывать сразу после game.startMatch). */
  H.reset = function () {
    H.rally = 1; H.events = []; H.mv++;
    H.seg = { id: 64, t0: game.time, st: shCopy() };
    for (const r of H.remotes.values()) { r.samples = []; r.shots = []; r.lastTick = -1; }
  };

  H.addRemote = function (playerId) {
    H.remotes.set(playerId, { samples: [], shots: [], lastShotSeq: -1, lastTick: -1, lastRx: 0, late: [], cur: { mx: 0, my: 0, sm: 1 } });
  };
  H.removeRemote = function (playerId) { H.remotes.delete(playerId); };

  /** Пакет ввода гостя (уже проверен codec.decodeInput). */
  H.input = function (playerId, inp, nowMs) {
    const r = H.remotes.get(playerId); if (!r) return;
    r.lastRx = nowMs;
    const cur = Math.round(game.time / DT);
    let newest = -1;
    for (const s of inp.samples) {
      if (s.tick <= r.lastTick && r.samples.length) continue;   // уже было (повтор для надёжности)
      if (r.samples.length && s.tick <= r.samples[r.samples.length - 1].tick) continue;
      r.samples.push(s);
      newest = Math.max(newest, s.tick);
    }
    if (inp.samples.length) {
      const top = inp.samples[inp.samples.length - 1].tick;
      r.late.push({ at: nowMs, v: (cur - top) * DT * 1000 });
      while (r.late.length && nowMs - r.late[0].at > 1200) r.late.shift();
    }
    for (const sh of inp.shots) {
      if (sh.seq <= r.lastShotSeq) continue;
      r.lastShotSeq = sh.seq;
      r.shots.push(sh);
    }
    if (r.samples.length > 600) r.samples.splice(0, r.samples.length - 600);
  };

  /** Перед каждым тиком симуляции: ввод, чьё время пришло. */
  game.onPreStep = function () {
    const cur = Math.round(game.time / DT);
    for (const [id, r] of H.remotes) {
      let s = null;
      while (r.samples.length && r.samples[0].tick <= cur) { s = r.samples.shift(); r.lastTick = s.tick; }
      if (s) r.cur = { mx: s.mx, my: s.my, sm: s.sm };
      game.setRemoteInput(id, r.cur.mx, r.cur.my, r.cur.sm);
      while (r.shots.length && r.shots[0].tick <= cur) {
        const sh = r.shots.shift();
        if (sh.retype) game.remoteRetype(id, sh.type, sh.aimY);
        else game.remoteShot(id, sh.type, sh.aimY, sh.tick * DT);
      }
    }
  };

  /** Гость молчит: считаем, что отпустил джойстик. */
  H.idle = function (playerId) {
    const r = H.remotes.get(playerId); if (!r) return;
    r.cur = { mx: 0, my: 0, sm: 1 }; r.samples = [];
  };

  H.lateP90 = function (playerId) {
    const r = H.remotes.get(playerId); if (!r || !r.late.length) return 0;
    const s = r.late.map(o => o.v).sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * 0.9)];
  };

  function swingId(w) {
    if (!w) return 0;
    let id = H.swingIds.get(w);
    if (!id) { id = ++H.swingN; H.swingIds.set(w, id); }
    return id;
  }

  /**
   * Снимок для одного гостя.
   * @param {{playerId:number, ea:number, mid:number}} peer
   */
  H.snapshot = function (peer) {
    const ev = [];
    for (const e of H.events) if (e[0] > peer.ea) ev.push(e);
    if (ev.length > 24) ev.splice(0, ev.length - 24);
    const r = H.remotes.get(peer.playerId);
    return {
      t: 's', n: ++H.n, T: Math.round(game.time * 1000), ph: Math.max(0, PHASES.indexOf(game.phase)), pa: game.paused ? 1 : 0,
      pl: game.players.map(p => encodePlayer(p, swingId(p.swing))),
      sg: encodeSeg(H.seg), mv: H.mv, m: game.match ? encodeMatch(game.match) : null, ev,
      ak: r ? [r.lastTick, Math.round(H.lateP90(peer.playerId)), peer.mid | 0] : null,
      mid: peer.mid | 0,
    };
  };

  H.destroy = function () {
    for (const u of H.unsub) u();
    if (game.onPreStep) game.onPreStep = null;
  };

  return H;
}
