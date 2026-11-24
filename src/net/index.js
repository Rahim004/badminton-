/**
 * net/index.js — онлайн-игра с друзьями (контракт: docs/ONLINE_SPEC.md).
 *
 *   import { createNet } from './net/index.js';
 *   const net = createNet(game);          // один объект на игру (повторный вызов вернёт тот же)
 *   net.available()                       // false в песочнице/без сети → «Онлайн-игра работает в версии на GitHub»
 *   net.host({ mode:'singles'|'doubles', format, difficulty, profile }) → Promise<{ code, link, error? }>
 *   net.join(code, { profile })           → Promise<{ ok, error? }>
 *   net.leave()
 *   net.on(name, cb) → off()              // события ниже
 *   net.setReady(bool); net.setSlot(team, seat); net.startMatch() → {ok, error?}  (startMatch — только хост)
 *   net.sendEmote(id)
 *   net.info() → { role, code, connected, route:'p2p'|'server', ms }
 *   net.roomFromHash() → 'ABCDE' | null   (ссылка вида …#room-ABCDE);  net.roomLink(code)
 *
 * События (payload):
 *   'status' {text, state}  state: 'connecting'|'waiting'|'connected'|'reconnecting'|'idle'|'error'
 *   'peer'   {type:'join'|'leave'|'lost'|'back', profile, team, seat}
 *   'lobby'  {code, mode, format, difficulty, slots:[{team, seat, profile|null, ai, ready, you}], canStart, host}
 *   'start'  {mode, format, difficulty, you:{team, seat, playerId}, slots}
 *   'end'    {reason:'over'|'host-left'|'lost'|'left'|'kicked', message, winner?, won?, score?, players?}
 *   'error'  {code, message}               — понятный русский текст в message
 *   'ping'   {ms, route, warn}             — раз в секунду (warn — «Связь прерывается…» и т.п.)
 *   'emote'  {id, playerId, team, seat, nick}   — быстрая реакция (показать над героем)
 *   'pause'  {paused, text}                — хост свернул игру (матч стоит у всех)
 *
 * Хуки для main.js: game.netDriver = { online, replacesSim, frame(dt), setHidden(h), leave(), rematch() };
 * game.emit('netStart') / game.emit('netEnd') — main запускает/останавливает цикл матча.
 * Тестовый транспорт: net.host({..., transport:'bc'}) / net.join(code, {..., transport:'bc'}).
 */
import { PROTO, cleanProfile, decodeSnap, decodeInput, newRoomCode, normCode } from './codec.js';
import { bcHub, bcLink, mqHub, mqLink, peerHub, peerLink, createRtc, rid, MQ_BROKERS } from './transport.js';
import { createHostDriver } from './host.js';
import { createGuestView } from './guest.js';
import { CHARACTER_ORDER, CHARACTERS, MATCH_FORMATS, DIFFICULTY } from '../config.js';
import { SITE_URL } from '../version.js';

export const NET_TEXT = {
  noweb: 'Онлайн-игра работает в версии на GitHub',
  ver: 'Версии игры разные — обновите страницу у обоих',
  net: 'Нет связи с сервером комнат. Проверьте интернет',
  conn: 'Не удалось соединиться. Попробуйте другую сеть или Wi-Fi',
  room: 'Комната не найдена. Проверьте код',
  code: 'Введите код комнаты из 5 букв',
  mqscript: 'Не загрузилась библиотека связи. Проверьте интернет или VPN и обновите страницу',
  mqnet: 'Ни один сервер недоступен — попробуйте выключить/включить VPN',
  full1: 'В комнате уже играют двое',
  full2: 'В комнате уже четверо игроков',
  busy: 'Матч в этой комнате уже идёт — дождитесь конца',
  hostLeft: 'Хост вышел из игры',
  lost: 'Соединение потеряно',
  hostLost: 'Связь с хостом потеряна',
  waitReady: 'Ждём, пока все нажмут «Готов»',
  needTwo: 'Нужен второй игрок',
};

const MAX_HUMANS = { singles: 2, doubles: 4 };

export function roomFromHash() { try { const m = /^#room-([A-Za-z]{5})$/.exec(location.hash); return m ? m[1].toUpperCase() : null; } catch (_) { return null; } }
export function roomLink(code) { try { if (/VolanApp/.test(navigator.userAgent)) return SITE_URL + '#room-' + code; return location.href.split('#')[0] + '#room-' + code; } catch (_) { return '#room-' + code; } }

/** Сеть вообще возможна? (файл/встроенный просмотрщик/песочница — нет). */
export function netAvailable() {
  try {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return false;
    if (!/^https?:$/.test(location.protocol) && !/VolanApp/.test(navigator.userAgent)) return false;   // exe-приложение открывает игру по volan://
    if (window.top !== window) return false;       // встроенный просмотрщик (iframe-песочница)
    if (navigator && navigator.onLine === false) return false;
    return true;
  } catch (_) { return false; }
}

const nowMs = () => performance.now();
const rtcOk = kind => { try { return typeof RTCPeerConnection !== 'undefined' && (kind === 'mq' || (kind === 'bc' && !!window.__p2pTest)); } catch (_) { return false; } };

export function createNet(game) {
  if (game.__net) return game.__net;
  const L = new Map();
  const emit = (name, p) => { const s = L.get(name); if (s) for (const fn of [...s]) { try { fn(p); } catch (e) { console.error(e); } } };
  let S = null;       // активная сессия
  let gen = 0;

  const net = {
    on(name, fn) { if (!L.has(name)) L.set(name, new Set()); L.get(name).add(fn); return () => L.get(name).delete(fn); },
    off(name, fn) { L.get(name)?.delete(fn); },
    available: netAvailable,
    roomFromHash, roomLink,
    texts: NET_TEXT,
  };
  const status = (text, state) => { if (S) S.statusText = text; emit('status', { text, state }); };
  const fail = (code, text) => { emit('error', { code, message: text }); status(text, 'error'); };

  /* ================================================================ общее */
  function teardown(sendBye) {
    const s = S; if (!s) return; S = null;
    clearInterval(s.beat);
    if (s.role === 'host') {
      for (const p of s.peers.values()) { if (sendBye) gsendRaw(p, { t: 'bye' }); if (p.rtc) p.rtc.close(); }
      if (s.drv) s.drv.destroy();
      setTimeout(() => s.hubs.forEach(h => h.close()), sendBye ? 150 : 0);
    } else {
      if (sendBye && s.link) s.link.send({ t: 'bye' });
      if (s.rtc) s.rtc.close();
      const lk = s.link; setTimeout(() => lk && lk.close(), sendBye ? 150 : 0);
    }
    game.netDriver = null;
    if (s.inMatch) { s.inMatch = false; game.emit('netEnd', {}); }
  }

  net.leave = function () {
    gen++;
    const s = S; if (!s) return;
    teardown(true);
    emit('end', { reason: 'left', message: '' });
    status('', 'idle');
  };

  net.info = function () {
    if (!S) return { role: null, code: null, connected: false, route: 'server', ms: 0 };
    if (S.role === 'host') {
      const ps = [...S.peers.values()].filter(p => !p.gone);
      const p2p = ps.length > 0 && ps.every(p => (p.rtc && p.rtc.open) || p.via.kind === 'peer' || p.via.kind === 'bc');
      return { role: 'host', code: S.code, connected: ps.length > 0, route: p2p ? 'p2p' : 'server', ms: Math.round(Math.max(0, ...ps.map(p => p.rtt || 0))), peers: ps.length };
    }
    return { role: 'guest', code: S.code, connected: !!S.welcomed, route: (S.rtc && S.rtc.open) || (S.link && (S.link.kind === 'peer' || S.link.kind === 'bc')) ? 'p2p' : 'server', ms: Math.round(S.rtt || 0), srv: S.link ? S.link.srvIdx : 0 };
  };
  net._view = () => (S && S.view) || null;   // для автотестов
  net.debug = () => S && (S.role === 'guest' ? { ...net.info(), view: S.view ? S.view.info() : null } : { ...net.info(), peers: [...S.peers.values()].map(p => ({ nick: p.profile.nick, rtt: p.rtt, late: S.drv ? S.drv.lateP90(p.playerId) : 0, rtc: !!(p.rtc && p.rtc.open), slot: p.slot })) });

  function rttSample(o, ts) { const s = nowMs() - ts; if (!(s >= 0 && s < 1e5)) return; o.rtt = o.rtt ? o.rtt * 0.7 + s * 0.3 : s; }

  /* ================================================================ хост */
  function lobbyObj() {
    const s = S;
    const per = s.mode === 'doubles' ? 2 : 1;
    const slots = [];
    for (let team = 0; team < 2; team++) for (let seat = 0; seat < per; seat++) {
      const who = slotOwner(team, seat);
      slots.push({ team, seat, profile: who ? who.profile : null, ai: !who && s.mode === 'doubles', ready: who ? !!who.ready : false, you: false, pid: who ? who.pid : null });
    }
    const humans = slots.filter(x => x.profile).length;
    const allReady = slots.every(x => !x.profile || x.ready);
    return { code: s.code, mode: s.mode, format: s.format, difficulty: s.difficulty, slots, canStart: humans >= 2 && allReady, host: s.me.profile };
  }
  function slotOwner(team, seat) {
    const s = S;
    if (s.me.slot.team === team && s.me.slot.seat === seat) return s.me;
    for (const p of s.peers.values()) if (!p.gone && p.slot.team === team && p.slot.seat === seat) return p;
    return null;
  }
  function freeSlot() {
    const s = S, per = s.mode === 'doubles' ? 2 : 1;
    const order = per === 1 ? [[1, 0], [0, 0]] : [[1, 0], [0, 1], [1, 1], [0, 0]];
    for (const [t, q] of order) if (!slotOwner(t, q)) return { team: t, seat: q };
    return null;
  }
  function pushLobby() {
    if (!S || S.role !== 'host') return;
    const lob = lobbyObj();
    for (const p of S.peers.values()) if (!p.gone) gsendRaw(p, { t: 'lobby', lobby: lob });
    emit('lobby', { ...lob, slots: lob.slots.map(x => ({ ...x, you: x.pid === 'host' })) });
  }

  function gsendRaw(p, m) { try { p.via.send(p.pid, m); } catch (_) {} }
  function gsend(p, m) { if (p.rtc && p.rtc.open && p.rtc.send(m)) return; gsendRaw(p, m); }

  net.host = async function (o = {}) {
    if (!netAvailable()) { fail('noweb', NET_TEXT.noweb); return { code: null, link: null, error: NET_TEXT.noweb }; }
    net.leave();
    const my = ++gen;
    const mode = o.mode === 'doubles' ? 'doubles' : 'singles';
    const format = MATCH_FORMATS[o.format] ? o.format : 'quick';
    const difficulty = DIFFICULTY[o.difficulty] ? o.difficulty : 'amateur';
    const profile = cleanProfile(o.profile) || cleanProfile({ nick: 'Хост' });
    const code = newRoomCode();
    status('Создаём комнату…', 'connecting');
    const hubs = [];
    let err = null;
    if (o.transport === 'bc') { if (typeof BroadcastChannel === 'undefined') err = 'conn'; else hubs.push(bcHub(code)); }
    else {
      const wantPeer = o.transport !== 'mq';
      const [mq, pj] = await Promise.all([o.transport === 'peer' ? { err: 'skip' } : mqHub(code), wantPeer ? peerHub(code) : { err: 'skip' }]);
      if (mq.hub) hubs.push(mq.hub);
      if (pj.hub) hubs.push(pj.hub);
      if (!hubs.length) err = mq.err === 'mqscript' ? 'mqscript' : mq.err === 'mqnet' ? 'mqnet' : (pj.err === 'net' ? 'net' : 'conn');
    }
    if (my !== gen) { hubs.forEach(h => h.close()); return { code: null, link: null, error: 'cancelled' }; }
    if (err) { fail(err, NET_TEXT[err] || NET_TEXT.conn); return { code: null, link: null, error: NET_TEXT[err] || NET_TEXT.conn }; }
    S = {
      role: 'host', code, mode, format, difficulty, hubs, peers: new Map(), mid: 0, inMatch: false,
      me: { pid: 'host', profile, slot: { team: 0, seat: 0 }, ready: true }, drv: null, hidden: false,
    };
    for (const h of hubs) h.onMsg = (pid, d, via) => { try { hostMsg(pid, d, via); } catch (e) { console.error(e); } };
    S.beat = setInterval(hostBeat, 1000);
    installDriver();
    const mqh = hubs.find(h => h.kind === 'mq');
    status('Ждём друга…' + (mqh ? ' (серверов на связи: ' + mqh.up() + ' из ' + MQ_BROKERS.length + ')' : ''), 'waiting');
    pushLobby();
    return { code, link: roomLink(code) };
  };

  function hostMsg(pid, d, via) {
    const s = S; if (!s || s.role !== 'host' || !d || typeof d !== 'object' || typeof pid !== 'string' || pid.length > 40) return;
    let p = s.peers.get(pid);
    if (d.t === 'hello') {
      if (d.v !== PROTO) { via.send(pid, { t: 'ver', v: PROTO }); return; }
      if (p && !p.left) {
        p.via = via; p.lastRx = nowMs();
        const back = p.gone; p.gone = false;
        gsendRaw(p, { t: 'welcome', v: PROTO, pid, lobby: lobbyObj() });
        if (s.inMatch && p.playerId != null) {
          if (back || game.players[p.playerId].controller !== 'remote') { game.setController(p.playerId, 'remote'); s.drv.addRemote(p.playerId); emit('peer', { type: 'back', profile: p.profile, ...p.slot }); status(p.profile.nick + ' вернулся', 'connected'); }
          p.ea = -1; gsendRaw(p, startMsg(p));
        }
        maybeRtc(p, d);
        return;
      }
      if (s.inMatch && !s.over) { via.send(pid, { t: 'busy' }); return; }
      const slot = freeSlot();
      if (!slot) { via.send(pid, { t: 'full', mode: s.mode }); return; }
      p = { pid, via, profile: cleanProfile(d.profile) || cleanProfile({ nick: 'Друг' }), slot, ready: false, lastRx: nowMs(), rtt: 0, ea: -1, mid: 0, acc: 0, playerId: null, gone: false };
      s.peers.set(pid, p);
      gsendRaw(p, { t: 'welcome', v: PROTO, pid, lobby: lobbyObj() });
      emit('peer', { type: 'join', profile: p.profile, ...slot });
      status(p.profile.nick + ' в комнате', 'connected');
      pushLobby();
      maybeRtc(p, d);
      return;
    }
    if (!p || p.left) return;
    p.lastRx = nowMs();
    if (p.via !== via) p.via = via;
    switch (d.t) {
      case 'i': {
        const inp = decodeInput(d); if (!inp) return;
        p.ea = Math.max(p.ea, inp.ea); p.mid = inp.mid;
        if (s.inMatch && inp.mid === s.mid && p.playerId != null && s.drv) s.drv.input(p.playerId, inp, nowMs());
        if (s.inMatch && inp.mid !== s.mid && nowMs() - (p.startSentAt || 0) > 800) { p.startSentAt = nowMs(); gsendRaw(p, startMsg(p)); }
        return;
      }
      case 'ping': if (Number.isFinite(d.ts)) gsend(p, { t: 'pong', ts: d.ts }); return;
      case 'pong': if (Number.isFinite(d.ts)) rttSample(p, d.ts); return;
      case 'rtc': if (p.rtc) p.rtc.signal(d); return;
      case 'ready': if (!s.inMatch || s.over) { p.ready = !!d.r; pushLobby(); } return;
      case 'slot': if (!s.inMatch || s.over) { trySlot(p, d.team, d.seat); } return;
      case 'emote': relayEmote(p, d.id); return;
      case 'bye': peerGone(p, true); return;
    }
  }

  function maybeRtc(p, d) {
    if (!d.rtc || !rtcOk(p.via.kind) || (p.rtc && !p.rtc.dead)) return;
    p.rtc = createRtc('host', m => gsendRaw(p, m), m => { p.lastRx = nowMs(); hostMsg(p.pid, m, p.via); }, open => {
      if (open) gsend(p, { t: 'ping', ts: nowMs() });
      status(open ? 'Прямое соединение с ' + p.profile.nick : 'Прямое соединение пропало — играем через сервер', 'connected');
    });
    if (!p.rtc.dead) p.rtc.offer();
  }

  function trySlot(p, team, seat) {
    const s = S, per = s.mode === 'doubles' ? 2 : 1;
    if (!Number.isInteger(team) || !Number.isInteger(seat) || team < 0 || team > 1 || seat < 0 || seat >= per) return false;
    const o = slotOwner(team, seat);
    if (o && o !== p) return false;
    p.slot = { team, seat }; pushLobby(); return true;
  }

  function relayEmote(p, id) {
    if (typeof id !== 'string' || !id || id.length > 16 || /[<>]/.test(id)) return;
    const now = nowMs(); if (now - (p.emoteAt || 0) < 700) return; p.emoteAt = now;
    const pl = S.inMatch ? p.playerId : null;
    const m = { t: 'emote', id, playerId: pl, team: p.slot.team, seat: p.slot.seat, nick: p.profile.nick };
    for (const q of S.peers.values()) if (!q.gone) gsendRaw(q, m);
    emit('emote', { id, playerId: pl, team: p.slot.team, seat: p.slot.seat, nick: p.profile.nick });
  }

  function peerGone(p, left) {
    const s = S; if (!s || p.gone) return;
    p.gone = true; if (left) p.left = true;
    if (p.rtc) { p.rtc.close(); p.rtc = null; }
    if (s.inMatch && p.playerId != null) {
      game.setController(p.playerId, 'ai'); s.drv.removeRemote(p.playerId);
      status(p.profile.nick + (left ? ' вышел' : ' отключился') + ' — вместо него играет ИИ', 'connected');
      emit('peer', { type: left ? 'leave' : 'lost', profile: p.profile, ...p.slot });
    } else {
      s.peers.delete(p.pid);
      emit('peer', { type: left ? 'leave' : 'lost', profile: p.profile, ...p.slot });
      status(p.profile.nick + (left ? ' вышел из комнаты' : ' отключился'), s.peers.size ? 'connected' : 'waiting');
      pushLobby();
    }
  }

  function hostBeat() {
    const s = S; if (!s || s.role !== 'host') return;
    const now = nowMs();
    let warn = '';
    for (const p of s.peers.values()) {
      if (p.gone) continue;
      gsend(p, { t: 'ping', ts: now });
      if (p.rtc && p.rtc.open && now - p.rtc.rxAt > 3000) { p.rtc.close(); }
      const age = now - p.lastRx;
      if (age > 2500) { warn = p.profile.nick + ' не отвечает…'; if (s.drv && p.playerId != null) s.drv.idle(p.playerId); }
      if (age > (s.inMatch ? 20000 : 12000)) peerGone(p, false);
      if (s.inMatch && p.mid !== s.mid && now - (p.startSentAt || 0) > 1500) { p.startSentAt = now; gsendRaw(p, startMsg(p)); }
    }
    const inf = net.info();
    emit('ping', { ms: inf.ms, route: inf.route, warn });
  }

  /** Сеть ведёт цикл матча через main.js. */
  function installDriver() {
    game.netDriver = {
      get online() { return !!S && S.inMatch; },
      get replacesSim() { return !!S && S.role === 'guest' && S.inMatch; },
      frame(dt) { try { if (S && S.role === 'host') hostFrame(dt); else if (S && S.view && S.inMatch) S.view.frame(dt); } catch (e) { console.error(e); } },
      setHidden(h) { if (S && S.role === 'host' && S.inMatch) { S.hidden = !!h; game.paused = !!h; emit('pause', { paused: !!h, text: h ? 'Пауза' : '' }); } },
      leave() { net.leave(); },
      rematch() { if (S && S.role === 'host') return net.startMatch(); return { ok: false }; },
    };
  }

  function hostFrame(dt) {
    const s = S; if (!s.inMatch || !s.drv) return;
    for (const p of s.peers.values()) {
      if (p.gone || p.playerId == null) continue;
      p.acc += dt;
      const direct = (p.rtc && p.rtc.open) || p.via.kind === 'peer' || p.via.kind === 'bc';
      const period = game.paused ? 0.25 : direct ? 1 / 30 : 1 / 20;
      if (p.acc < period) continue;
      p.acc = p.acc - period > period ? 0 : p.acc - period;
      gsend(p, s.drv.snapshot({ playerId: p.playerId, ea: p.mid === s.mid ? p.ea : -1, mid: s.mid }));
    }
  }

  function startMsg(p) {
    const s = S;
    return { t: 'start', v: PROTO, mid: s.mid, mode: s.mode, format: s.format, difficulty: s.difficulty, seed: s.seed, chars: s.chars, names: s.names, ctl: s.ctl, you: p.playerId, lobby: lobbyObj() };
  }

  net.startMatch = function () {
    const s = S;
    if (!s || s.role !== 'host') return { ok: false, error: 'Начать матч может только хост' };
    const lob = lobbyObj();
    const humans = lob.slots.filter(x => x.profile);
    if (humans.length < 2) { fail('need', NET_TEXT.needTwo); return { ok: false, error: NET_TEXT.needTwo }; }
    if (!humans.every(x => x.ready)) { fail('ready', NET_TEXT.waitReady); return { ok: false, error: NET_TEXT.waitReady }; }
    const per = s.mode === 'doubles' ? 2 : 1;
    const ctl = [], chars = [], names = {};
    const used = new Set();
    for (const x of lob.slots) if (x.profile && CHARACTERS[x.profile.heroId]) used.add(x.profile.heroId);
    const free = CHARACTER_ORDER.filter(c => !used.has(c));
    for (const x of lob.slots) {
      const id = x.team * per + x.seat;
      if (x.profile) {
        ctl[id] = x.pid; names[id] = x.profile.nick;
        chars[id] = CHARACTERS[x.profile.heroId] ? x.profile.heroId : (free.shift() || 'timur');
      } else { ctl[id] = 'ai'; chars[id] = free.length ? free.splice((Math.random() * free.length) | 0, 1)[0] : 'leo'; }
    }
    s.mid++; s.seed = (Math.random() * 2 ** 31) | 0; s.ctl = ctl; s.chars = chars; s.names = names;
    for (const p of s.peers.values()) { p.playerId = null; p.ea = -1; p.mid = 0; }
    for (const p of s.peers.values()) if (!p.gone) { const sl = p.slot; p.playerId = sl.team * per + sl.seat; }
    s.me.playerId = s.me.slot.team * per + s.me.slot.seat;
    if (!s.drv) s.drv = createHostDriver(game);
    game.startMatch({
      mode: s.mode, format: s.format, difficulty: s.difficulty, seed: s.seed, characters: chars, names,
      controllers: ctl.map(c => (c === 'host' ? 'human' : c === 'ai' ? 'ai' : 'remote')),
      assist: true, assistStrength: game.cfg.assistStrength || 'auto', humans: 1,
    });
    game.paused = false;
    s.drv.reset();
    for (const p of s.peers.values()) if (!p.gone) s.drv.addRemote(p.playerId);
    s.inMatch = true;
    for (const p of s.peers.values()) if (!p.gone) { p.startSentAt = nowMs(); gsendRaw(p, startMsg(p)); }
    game.emit('netStart', { role: 'host' });
    s.over = false;
    emit('start', { mode: s.mode, format: s.format, difficulty: s.difficulty, you: { ...s.me.slot, playerId: s.me.playerId }, slots: lob.slots.map(x => ({ ...x, you: x.pid === 'host' })) });
    status('Матч начался', 'connected');
    return { ok: true };
  };

  net.setSlot = function (team, seat) {
    const s = S; if (!s) return false;
    if (s.role === 'host') {
      if (s.inMatch && !s.over) return false;
      const per = s.mode === 'doubles' ? 2 : 1;
      if (!Number.isInteger(team) || !Number.isInteger(seat) || team < 0 || team > 1 || seat < 0 || seat >= per) return false;
      const o = slotOwner(team, seat); if (o && o !== s.me) return false;
      s.me.slot = { team, seat }; pushLobby(); return true;
    }
    if (s.link) s.link.send({ t: 'slot', team, seat });
    return true;
  };
  net.setReady = function (r) {
    const s = S; if (!s) return;
    if (s.role === 'guest' && s.link) s.link.send({ t: 'ready', r: !!r });
  };
  net.sendEmote = function (id) {
    const s = S; if (!s) return;
    if (s.role === 'guest') { if (s.link) s.link.send({ t: 'emote', id: String(id).slice(0, 16) }); return; }
    relayEmote(s.me, String(id).slice(0, 16));
  };

  // Конец матча (у хоста и гостя): 'end' с итогом — UI сохраняет результат (recordMatch).
  game.on('matchOver', e => {
    if (!S || !S.inMatch) return;
    if (S.role === 'host') {   // реванш: гости снова жмут «Готов», хост — «Начать»
      S.over = true;
      for (const p of S.peers.values()) p.ready = false;
      setTimeout(pushLobby, 0);
    }
    const myTeam = game.human ? game.human.team : 0;
    const players = game.players.map(p => ({ id: p.id, team: p.team, name: p.name, controller: p.controller }));
    const profiles = S.role === 'host' ? [S.me, ...S.peers.values()].map(x => ({ ...x.profile, team: x.slot.team, seat: x.slot.seat })) : (S.lobby ? S.lobby.slots.filter(x => x.profile).map(x => ({ ...x.profile, team: x.team, seat: x.seat })) : []);
    setTimeout(() => emit('end', { reason: 'over', message: '', winner: e.winner, won: e.winner === myTeam, score: e.gameScores, games: e.games, players, profiles }), 0);
  });

  /* ================================================================ гость */
  net.join = async function (code, o = {}) {
    code = normCode(code);
    if (code.length !== 5) { fail('code', NET_TEXT.code); return { ok: false, error: NET_TEXT.code }; }
    if (!netAvailable()) { fail('noweb', NET_TEXT.noweb); return { ok: false, error: NET_TEXT.noweb }; }
    net.leave();
    const my = ++gen;
    const profile = cleanProfile(o.profile) || cleanProfile({ nick: 'Гость' });
    const pid = 'g' + rid() + rid();
    status('Подключаемся…', 'connecting');
    const hello = { t: 'hello', v: PROTO, pid, profile, rtc: rtcOk(o.transport === 'bc' ? 'bc' : 'mq') ? 1 : 0 };
    const r = await openLink(code, pid, hello, o.transport, () => my !== gen);
    if (my !== gen) { if (r.link) r.link.close(); return { ok: false, error: 'cancelled' }; }
    if (!r.link) { const t = NET_TEXT[r.err] || NET_TEXT.conn; fail(r.err || 'conn', t); return { ok: false, error: t }; }
    S = { role: 'guest', code, pid, profile, hello, link: r.link, transport: o.transport, welcomed: false, inMatch: false, lastRx: nowMs(), rtt: 0, view: null, mid: 0, lobby: null, reconnecting: false };
    const res = await new Promise(resolve => {
      S.joinResolve = resolve;
      r.link.listen(m => { try { guestMsg(m); } catch (e) { console.error(e); } });
      setTimeout(() => resolve({ err: 'conn' }), 5000);
    });
    if (!S || my !== gen) return { ok: false, error: 'cancelled' };
    S.joinResolve = null;
    if (res.err) { const t = res.text || NET_TEXT[res.err] || NET_TEXT.conn; teardown(false); fail(res.err, t); return { ok: false, error: t }; }
    S.beat = setInterval(guestBeat, 1000);
    installDriver();
    status('Подключено' + (S.link.kind === 'mq' ? ' через сервер ' + S.link.srvIdx + ' из ' + MQ_BROKERS.length : '') + ', ждём начала матча…', 'connected');
    return { ok: true };
  };

  async function openLink(code, pid, hello, transport, cancelled) {
    if (transport === 'bc') return typeof BroadcastChannel === 'undefined' ? { err: 'conn' } : bcLink(code, pid, hello);
    let r = transport === 'peer' ? { err: 'skip' } : await mqLink(code, pid, hello, cancelled);
    if (r.link || cancelled() || transport === 'mq') return r;
    const first = r.err;
    if (first === 'room') status('Комната не найдена на серверах, пробуем прямое соединение…', 'connecting');
    const p = await peerLink(code, pid, hello);
    if (p.link) return p;
    if (first === 'room' || first === 'skip') return { err: p.err === 'room' || first === 'room' ? 'room' : p.err };
    return { err: first === 'mqnet' || first === 'mqscript' ? first : p.err };
  }

  function guestSend(m) {
    const s = S; if (!s || !s.link) return;
    if (s.rtc && s.rtc.open && s.rtc.send(m)) return;
    s.link.send(m);
  }

  function guestMsg(m) {
    const s = S; if (!s || s.role !== 'guest' || !m || typeof m !== 'object') return;
    s.lastRx = nowMs();
    switch (m.t) {
      case 'welcome':
        if (m.v !== PROTO) { if (s.joinResolve) s.joinResolve({ err: 'ver' }); return; }
        s.welcomed = true; s.lobby = m.lobby || s.lobby;
        if (s.joinResolve) s.joinResolve({ ok: true });
        if (s.lobby) emitLobby();
        return;
      case 'ver': if (s.joinResolve) s.joinResolve({ err: 'ver' }); else endGuest('version', NET_TEXT.ver); return;
      case 'full': if (s.joinResolve) s.joinResolve({ err: 'full', text: m.mode === 'doubles' ? NET_TEXT.full2 : NET_TEXT.full1 }); return;
      case 'busy': if (s.joinResolve) s.joinResolve({ err: 'busy' }); return;
      case 'lobby': if (m.lobby && Array.isArray(m.lobby.slots)) { s.lobby = m.lobby; emitLobby(); } return;
      case 'start': guestStart(m); return;
      case 's': { const snap = decodeSnap(m); if (snap && s.view) s.view.onSnap(snap); else if (!snap) s.bad = (s.bad || 0) + 1; return; }
      case 'ping': if (Number.isFinite(m.ts)) guestSend({ t: 'pong', ts: m.ts }); return;
      case 'pong': if (Number.isFinite(m.ts)) { rttSample(s, m.ts); if (s.view) s.view.setRtt(s.rtt / 1000); } return;
      case 'rtc':
        if (m.k === 'offer' && (!s.rtc || s.rtc.dead) && rtcOk(s.link.kind)) {
          s.rtc = createRtc('guest', x => s.link.send(x), x => { s.lastRx = nowMs(); guestMsg(x); }, open => {
            if (s.view) s.view.setRoute(open ? 'p2p' : 'server');
            status(open ? 'Подключено · прямое соединение' : 'Подключено · через сервер (прямое соединение пропало)', 'connected');
          });
        }
        if (s.rtc) s.rtc.signal(m);
        return;
      case 'emote':
        if (typeof m.id === 'string' && m.id.length <= 16) emit('emote', { id: m.id, playerId: Number.isInteger(m.playerId) ? m.playerId : null, team: m.team | 0, seat: m.seat | 0, nick: String(m.nick || '').slice(0, 16) });
        return;
      case 'bye': endGuest('host-left', NET_TEXT.hostLeft); return;
    }
  }

  function emitLobby() {
    const s = S, lob = s.lobby;
    const slots = lob.slots.map(x => ({ team: x.team | 0, seat: x.seat | 0, profile: x.profile ? cleanProfile(x.profile) : null, ai: !!x.ai, ready: !!x.ready, you: x.pid === s.pid }));
    emit('lobby', { code: s.code, mode: lob.mode === 'doubles' ? 'doubles' : 'singles', format: lob.format, difficulty: lob.difficulty, slots, canStart: false, host: lob.host ? cleanProfile(lob.host) : null });
  }

  function guestStart(m) {
    const s = S;
    if (m.v !== PROTO) { endGuest('version', NET_TEXT.ver); return; }
    if (!Number.isInteger(m.mid) || m.mid === s.mid) return;
    const per = m.mode === 'doubles' ? 2 : 1;
    if (!Array.isArray(m.ctl) || m.ctl.length !== per * 2 || !Array.isArray(m.chars)) return;
    const myId = m.ctl.indexOf(s.pid);
    if (myId < 0) return;
    const names = {};
    if (m.names && typeof m.names === 'object') for (const k of Object.keys(m.names)) if (/^[0-3]$/.test(k)) names[k] = String(m.names[k]).slice(0, 16);
    const chars = m.chars.map(c => (CHARACTERS[c] ? c : 'timur'));
    s.mid = m.mid;
    if (m.lobby) s.lobby = m.lobby;
    game.startMatch({
      mode: per === 2 ? 'doubles' : 'singles', format: MATCH_FORMATS[m.format] ? m.format : 'quick', difficulty: DIFFICULTY[m.difficulty] ? m.difficulty : 'amateur',
      seed: m.seed | 0, characters: chars, names,
      controllers: m.ctl.map(c => (c === s.pid ? 'human' : c === 'ai' ? 'ai' : 'remote')),
      assist: true, assistStrength: game.cfg.assistStrength || 'auto', humans: 1,
    });
    const route = (s.rtc && s.rtc.open) || s.link.kind === 'peer' || s.link.kind === 'bc' ? (s.link.kind === 'bc' && !(s.rtc && s.rtc.open) ? 'bc' : 'p2p') : 'server';
    s.view = createGuestView(game, { myId, mid: m.mid, route, send: guestSend, onPause: p => emit('pause', { paused: p, text: p ? 'Пауза: хост свернул игру' : '' }) });
    if (s.rtt) s.view.setRtt(s.rtt / 1000);
    const wasIn = s.inMatch;
    s.inMatch = true;
    game.emit('netStart', { role: 'guest', rejoin: wasIn });
    const sl = m.ctl.length === 2 ? { team: myId, seat: 0 } : { team: myId >> 1, seat: myId & 1 };
    const lslots = s.lobby && Array.isArray(s.lobby.slots) ? s.lobby.slots.map(x => ({ team: x.team | 0, seat: x.seat | 0, profile: x.profile ? cleanProfile(x.profile) : null, ai: !!x.ai, ready: !!x.ready, you: x.pid === s.pid })) : [];
    emit('start', { mode: per === 2 ? 'doubles' : 'singles', format: m.format, difficulty: m.difficulty, you: { ...sl, playerId: myId }, slots: lslots });
    status('Матч начался', 'connected');
  }

  function endGuest(reason, text) {
    if (!S || S.role !== 'guest') return;
    teardown(reason !== 'host-left' && reason !== 'lost');
    emit('end', { reason, message: text });
    status(text, 'error');
  }

  async function reconnect() {
    const s = S; if (!s || s.reconnecting) return;
    s.reconnecting = true;
    status('Переподключаемся…', 'reconnecting');
    const my = gen;
    const r = await openLink(s.code, s.pid, s.hello, s.transport, () => my !== gen || S !== s);
    if (S !== s || my !== gen) { if (r.link) r.link.close(); return; }
    s.reconnecting = false;
    if (!r.link) return;
    const old = s.link; s.link = r.link;
    try { old.close(); } catch (_) {}
    if (s.rtc) { s.rtc.close(); s.rtc = null; }
    r.link.listen(m => { try { guestMsg(m); } catch (e) { console.error(e); } });
    s.mid = s.mid;   // хост пришлёт start ещё раз — тот же mid не пересоздаёт матч
    status('Связь восстановлена', 'connected');
  }

  function guestBeat() {
    const s = S; if (!s || s.role !== 'guest') return;
    const now = nowMs();
    guestSend({ t: 'ping', ts: now });
    if (s.rtc && s.rtc.open && now - s.rtc.rxAt > 3000) s.rtc.close();
    const age = now - s.lastRx;
    let warn = '';
    if (age > 2500) warn = 'Связь с хостом прерывается…';
    if (age > 6000 && !s.reconnecting && now - (s.reconAt || 0) > 9000) { s.reconAt = now; reconnect(); }
    if (age > 30000) { endGuest('lost', NET_TEXT.hostLost); return; }
    const inf = net.info();
    emit('ping', { ms: inf.ms, route: inf.route, warn });
  }

  try { addEventListener('pagehide', () => { try { if (S) net.leave(); } catch (_) {} }); } catch (_) {}
  game.__net = net;
  return net;
}
