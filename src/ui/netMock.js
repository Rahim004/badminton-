/**
 * ui/netMock.js — заглушка сетевого модуля с API из docs/ONLINE_SPEC.md.
 * Нужна, чтобы строить и проверять экраны лобби без настоящей сети.
 * Включается параметром адреса ?mocknet (или если src/net/index.js ещё нет и задан ?mocknet).
 *
 * Поведение: «Аня» заходит в созданную комнату через ~1,2 с и через ~1 с жмёт «Готов»;
 * при входе по коду хозяин комнаты — «Аня». Код 'ZZZZZ' — «комната не найдена».
 * Пинг шлётся раз в 2 с. На эмоцию отвечает своей.
 *
 * Тестовые ручки: net.__mock = { peerEmote(id), drop(), back(), end(winnerTeam, gameScores),
 *   error(code), fill(), status(state) }.
 *
 * Форматы событий, которые ждёт интерфейс (их же должен слать настоящий модуль):
 *   'status' {state:'connecting'|'connected'|'reconnecting'|'disconnected', route?:'p2p'|'server'}
 *   'lobby'  {code, mode, format, difficulty, hostId, slots:[{team, seat, profile|null, ai, ready}]}
 *   'peer'   {type:'join'|'leave'|'drop'|'back', profile}
 *   'ping'   {ms}
 *   'emote'  {id, team, seat, profile?}
 *   'start'  {mode, format, difficulty, slots, seed}
 *   'end'    {winner, gameScores, longestRally?, smashes?: {[profileId]: n}}
 *   'error'  {code, message?}
 */
const FRIEND = { id: 'a1b2c3d4e5f60718', nick: 'Аня', heroId: 'aya', color: '#b388ff', friendCode: '' };
const FRIEND2 = { id: '0f1e2d3c4b5a6978', nick: 'Дамир', heroId: 'niko', color: '#ff7043', friendCode: '' };

export function createNetMock(game, { friendCodeOf } = {}) {
  if (friendCodeOf) { FRIEND.friendCode = friendCodeOf(FRIEND.id); FRIEND2.friendCode = friendCodeOf(FRIEND2.id); }
  const L = new Map();
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const emit = (n, p) => { for (const fn of L.get(n) || []) { try { fn(p); } catch (e) { console.error(e); } } };
  let lobby = null, me = null, role = null, connected = false, ms = 0, route = 'server', pingT = null;

  function seats(mode) {
    const per = mode === 'doubles' ? 2 : 1;
    const out = [];
    for (let team = 0; team < 2; team++) for (let seat = 0; seat < per; seat++) out.push({ team, seat, profile: null, ai: mode === 'doubles', ready: false });
    return out;
  }
  function put(profile, team, seat, ready = false) {
    const s = lobby.slots.find(x => x.team === team && x.seat === seat);
    lobby.slots.forEach(x => { if (x.profile && x.profile.id === profile.id) { x.profile = null; x.ai = lobby.mode === 'doubles'; x.ready = false; } });
    Object.assign(s, { profile, ai: false, ready });
  }
  const push = () => emit('lobby', JSON.parse(JSON.stringify(lobby)));
  function connect() {
    emit('status', { state: 'connecting' });
    later(500, () => {
      connected = true; route = 'server';
      emit('status', { state: 'connected', route });
      later(1600, () => { route = 'p2p'; emit('status', { state: 'connected', route }); });
      pingT = setInterval(() => { ms = route === 'p2p' ? 38 + ((Math.random() * 20) | 0) : 95 + ((Math.random() * 40) | 0); emit('ping', { ms }); }, 2000);
    });
  }
  const code5 = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ'[(Math.random() * 23) | 0]).join('');

  const net = {
    available: () => true,
    on(n, fn) { if (!L.has(n)) L.set(n, new Set()); L.get(n).add(fn); return () => L.get(n).delete(fn); },
    off(n, fn) { L.get(n)?.delete(fn); },
    host({ mode = 'singles', format = 'quick', difficulty = 'amateur', profile } = {}) {
      me = profile; role = 'host';
      lobby = { code: code5(), mode, format, difficulty, hostId: profile.id, slots: seats(mode) };
      connect();
      return new Promise(res => later(600, () => {
        put(me, 0, 0); push();
        later(1200, () => { put(FRIEND, 1, 0); emit('peer', { type: 'join', profile: FRIEND }); push(); });
        later(2300, () => { const s = lobby.slots.find(x => x.profile && x.profile.id === FRIEND.id); if (s) { s.ready = true; push(); } });
        const link = `${location.origin}${location.pathname}#room-${lobby.code}`;
        res({ code: lobby.code, link });
      }));
    },
    join(code, { profile } = {}) {
      me = profile; role = 'guest';
      connect();
      return new Promise(res => later(700, () => {
        if (String(code).toUpperCase() === 'ZZZZZ') { emit('error', { code: 'room-not-found' }); emit('status', { state: 'disconnected' }); res({ ok: false, error: 'room-not-found' }); return; }
        lobby = { code: String(code).toUpperCase(), mode: 'singles', format: 'quick', difficulty: 'amateur', hostId: FRIEND.id, slots: seats('singles') };
        put(FRIEND, 0, 0, true); put(me, 1, 0); push();
        res({ ok: true });
      }));
    },
    leave() {
      for (const t of timers) clearTimeout(t); timers.clear(); clearInterval(pingT);
      connected = false; lobby = null; role = null;
      emit('status', { state: 'disconnected' });
    },
    setReady(b) { const s = lobby && lobby.slots.find(x => x.profile && x.profile.id === me.id); if (s) { s.ready = !!b; push(); } },
    setSlot(team, seat) {
      if (!lobby) return;
      const s = lobby.slots.find(x => x.team === team && x.seat === seat);
      if (!s || (s.profile && s.profile.id !== me.id)) return;
      put(me, team, seat); push();
    },
    startMatch() {
      if (role !== 'host' || !lobby) return;
      later(300, () => emit('start', { mode: lobby.mode, format: lobby.format, difficulty: lobby.difficulty, slots: JSON.parse(JSON.stringify(lobby.slots)), seed: (Math.random() * 1e9) | 0 }));
    },
    sendEmote(id) {
      const pick = ['nice', 'fire', 'oops', 'haha', 'thanks', 'again'];
      later(900, () => {
        const s = lobby && lobby.slots.find(x => x.profile && x.profile.id === FRIEND.id);
        if (s) emit('emote', { id: pick[(Math.random() * pick.length) | 0], team: s.team, seat: s.seat, profile: FRIEND });
      });
    },
    info: () => ({ role, code: lobby && lobby.code, connected, route, ms }),
    __mock: {
      peerEmote(id = 'fire') { const s = lobby.slots.find(x => x.profile && x.profile.id === FRIEND.id); emit('emote', { id, team: s.team, seat: s.seat, profile: FRIEND }); },
      drop() { emit('peer', { type: 'drop', profile: FRIEND }); },
      back() { emit('peer', { type: 'back', profile: FRIEND }); },
      end(winner = 0, gameScores = [[21, 17]]) { emit('end', { winner, gameScores, longestRally: 14, smashes: {} }); },
      error(code = 'timeout') { emit('error', { code }); },
      status(state, r) { emit('status', { state, route: r || route }); },
      fill() { // 2×2: второй человек садится рядом с хозяином
        if (!lobby || lobby.mode !== 'doubles') return;
        const free = lobby.slots.find(x => !x.profile && x.team === 1);
        if (free) { put(FRIEND2, free.team, free.seat, true); emit('peer', { type: 'join', profile: FRIEND2 }); push(); }
      },
      get lobby() { return lobby; },
    },
  };
  return net;
}
