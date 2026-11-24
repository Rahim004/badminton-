/**
 * net/transport.js — транспорт: хост — «хаб» на несколько гостей, гость — одна связь с хостом.
 *
 * Виды:
 *   'mq'   — ретранслятор через публичные MQTT-брокеры (WSS). Хост слушает комнату на ВСЕХ
 *            доступных брокерах сразу; гость стучится на всех и закрепляется на первом, где ответил
 *            хост (так друзья встречаются, даже если каждому доступна только часть брокеров).
 *            Работает везде, где открываются обычные сайты (Россия, Таджикистан, VPN).
 *   'peer' — PeerJS (WebRTC + их сигнальный сервер) — запасной путь, если брокеры недоступны.
 *   'bc'   — BroadcastChannel (две вкладки одного браузера) — для автотестов; умеет имитировать
 *            задержку/джиттер/потери: window.__netSim = {lag, jit, loss} (мс, мс, доля).
 * Поверх ретранслятора — прямой канал WebRTC (createRtc): игровые сообщения идут по нему,
 * когда он открыт, управляющие — всегда по ретранслятору.
 *
 * Конверт: {from, to, d}; to — id гостя, 'H' (хост) или '*' (все).
 * Хаб:   { kind, onMsg(pid, d, via), send(pid, d, via), close(), up() }
 * Связь: { kind, onMsg(d), onDown(), send(d), close(), srvIdx }
 */
import { loadLib } from './libs.js';

export const TOPIC = 'volan1';
export const MQ_BROKERS = [
  ['wss://broker.emqx.io:8084/mqtt'],
  ['wss://public.cloud.shiftr.io', { username: 'public', password: 'public' }],
  ['wss://broker.hivemq.com:8884/mqtt'],
  ['wss://test.mosquitto.org:8081/mqtt'],
  ['wss://mqtt.eclipseprojects.io:443/mqtt'],
];

export const rid = () => Math.random().toString(36).slice(2, 10);
const UNRELIABLE = { s: 1, i: 1, ping: 1, pong: 1 };
const nowMs = () => (globalThis.performance ? performance.now() : Date.now());

/* ---------------------------------------------------------------- BroadcastChannel (тест) */
function simOut(post) {
  // Имитация сети: порядок сохраняется (как у TCP-ретранслятора), теряются только игровые сообщения.
  let lastAt = 0;
  return m => {
    const sim = globalThis.__netSim;
    if (!sim || (!sim.lag && !sim.jit && !sim.loss)) { post(m); return; }
    if (sim.loss && m.d && UNRELIABLE[m.d.t] && Math.random() < sim.loss) return;
    const at = Math.max(lastAt + 0.01, nowMs() + (sim.lag || 0) + Math.random() * (sim.jit || 0));
    lastAt = at;
    setTimeout(() => post(m), Math.max(0, at - nowMs()));
  };
}

export function bcHub(code) {
  const ch = new BroadcastChannel(TOPIC + '-' + code);
  const h = { kind: 'bc', onMsg: null, closed: false, up: () => 1 };
  const out = simOut(m => { if (!h.closed) ch.postMessage(m); });
  ch.onmessage = ev => { const m = ev.data; if (!m || m.to !== 'H' || typeof m.from !== 'string') return; if (h.onMsg) h.onMsg(m.from, m.d, h); };
  h.send = (pid, d) => out({ from: 'H', to: pid, d });
  h.close = () => { h.closed = true; setTimeout(() => { try { ch.close(); } catch (_) {} }, 50); };
  return h;
}

export function bcLink(code, me, knock) {
  return new Promise(res => {
    const ch = new BroadcastChannel(TOPIC + '-' + code);
    const L = { kind: 'bc', onMsg: null, onDown: null, closed: false, q: [], srvIdx: 0 };
    const out = simOut(m => { if (!L.closed) ch.postMessage(m); });
    let ok = false;
    ch.onmessage = ev => {
      const m = ev.data; if (!m || m.from !== 'H' || (m.to !== me && m.to !== '*')) return;
      if (!ok) { ok = true; clearTimeout(to); clearInterval(iv); res({ link: L }); }
      if (L.onMsg) L.onMsg(m.d); else L.q.push(m.d);
    };
    L.send = d => out({ from: me, to: 'H', d });
    L.close = () => { L.closed = true; clearInterval(iv); setTimeout(() => { try { ch.close(); } catch (_) {} }, 50); };
    L.listen = fn => { L.onMsg = fn; const q = L.q; L.q = []; q.forEach(fn); };
    const iv = setInterval(() => L.send(knock), 400);
    const to = setTimeout(() => { if (!ok) { L.close(); res({ err: 'room' }); } }, 3500);
    L.send(knock);
  });
}

/* ---------------------------------------------------------------- MQTT */
function mqConnect(br, timeout = 6000) {
  return new Promise(res => {
    let c = null, fin = false;
    const done = v => { if (fin) return; fin = true; clearTimeout(to); if (!v) { try { c && c.end(true); } catch (_) {} } res(v); };
    const to = setTimeout(() => done(null), timeout);
    try { c = globalThis.mqtt.connect(br[0], Object.assign({ clientId: 'vl' + rid() + rid(), clean: true, connectTimeout: timeout, reconnectPeriod: 1000, keepalive: 15 }, br[1] || {})); } catch (_) { done(null); return; }
    c.once('connect', () => done(c));
    c.on('error', () => { if (!fin) done(null); });
  });
}

function mqWire(c, idx, topicIn, topicOut, onEnv) {
  const s = { c, idx, link: true, rxAt: nowMs(), dead: false, kickAt: 0 };
  c.on('connect', () => { s.link = true; s.rxAt = nowMs(); try { c.subscribe(topicIn, { qos: 0 }); } catch (_) {} });
  c.on('offline', () => { s.link = false; });
  c.on('close', () => { s.link = false; });
  c.on('message', (topic, buf) => {
    if (s.dead || topic !== topicIn) return;
    s.rxAt = nowMs();
    if (buf && buf.length > 60000) return;
    let m; try { m = JSON.parse(typeof buf === 'string' ? buf : new TextDecoder().decode(buf)); } catch (_) { return; }
    if (m && typeof m === 'object' && typeof m.from === 'string') onEnv(m, s);
  });
  try { c.subscribe(topicIn, { qos: 0 }); } catch (_) {}
  s.pub = env => { try { c.publish(topicOut, JSON.stringify(env), { qos: 0 }); } catch (_) {} };
  s.kick = () => {   // «полумёртвый» сокет: переподключаемся сами
    const now = nowMs(); if (now - s.kickAt < 8000) return; s.kickAt = now; s.link = false;
    try { c.end(true, () => { try { if (!s.dead) c.reconnect(); } catch (_) {} }); } catch (_) {}
  };
  s.stop = () => { s.dead = true; try { c.end(true); } catch (_) {} };
  return s;
}

export async function mqHub(code) {
  if (!(await loadLib('mqtt'))) return { err: 'mqscript' };
  const base = TOPIC + '/' + code + '/';
  const h = { kind: 'mq', onMsg: null, closed: false, ws: [], peerBroker: new Map(), n: MQ_BROKERS.length };
  const attach = (c, idx) => {
    if (h.closed) { try { c.end(true); } catch (_) {} return; }
    const s = mqWire(c, idx, base + 'h', base + 'g', (m, s) => {
      if (m.to !== 'H') return;
      h.peerBroker.set(m.from, s);
      if (h.onMsg) h.onMsg(m.from, m.d, h);
    });
    h.ws.push(s);
  };
  await new Promise(res => {
    let settled = 0, g = 0;
    MQ_BROKERS.forEach((br, i) => mqConnect(br).then(c => {
      settled++;
      if (c) { attach(c, i); if (!g) g = setTimeout(res, 900); }
      if (settled === MQ_BROKERS.length) { clearTimeout(g); res(); }
    }));
  });
  if (!h.ws.length) { h.closed = true; return { err: 'mqnet' }; }
  h.up = () => h.ws.filter(s => s.link).length;
  h.send = (pid, d) => {
    const env = { from: 'H', to: pid, d };
    const s = h.peerBroker.get(pid);
    if (s) s.pub(env); else for (const w of h.ws) w.pub(env);
  };
  h.brokerOf = pid => { const s = h.peerBroker.get(pid); return s ? s.idx + 1 : 0; };
  h.close = () => { h.closed = true; setTimeout(() => h.ws.forEach(s => s.stop()), 250); };
  return { hub: h };
}

/** Гость: стучимся на всех брокерах, закрепляемся на первом, где ответил хост. knock — первое сообщение (hello). */
export async function mqLink(code, me, knock, isCancelled) {
  if (!(await loadLib('mqtt'))) return { err: 'mqscript' };
  const base = TOPIC + '/' + code + '/';
  return new Promise(res => {
    const L = { kind: 'mq', onMsg: null, onDown: null, closed: false, q: [], srvIdx: 0, srvN: MQ_BROKERS.length };
    const ws = [];
    let won = null, fin = false, settled = 0, up = 0, roomTo = 0;
    const finish = v => {
      if (fin) return; fin = true; clearInterval(iv); clearTimeout(roomTo); clearTimeout(gto);
      for (const s of ws) if (s !== won) s.stop();
      res(v);
    };
    const knockAll = () => { if (isCancelled && isCancelled()) { finish({ err: 'cancel' }); return; } ws.forEach(s => s.pub({ from: me, to: 'H', d: knock })); };
    const iv = setInterval(knockAll, 600);
    const gto = setTimeout(() => finish({ err: up ? 'room' : 'mqnet', up, n: MQ_BROKERS.length }), 11000);
    const attach = (c, idx) => {
      if (fin) { try { c.end(true); } catch (_) {} return; }
      const s = mqWire(c, idx, base + 'g', base + 'h', (m, s) => {
        if (m.from !== 'H' || (m.to !== me && m.to !== '*') || (won && won !== s)) return;
        if (!won) { won = s; L.srvIdx = idx + 1; L._s = s; finish({ link: L }); }
        if (L.onMsg) L.onMsg(m.d); else L.q.push(m.d);
      });
      ws.push(s);
      setTimeout(() => { if (!fin) s.pub({ from: me, to: 'H', d: knock }); }, 120);
    };
    L.send = d => { if (L._s && !L.closed) L._s.pub({ from: me, to: 'H', d }); };
    L.close = () => { L.closed = true; clearInterval(L._wd); setTimeout(() => { if (L._s) L._s.stop(); }, 200); };
    L.listen = fn => { L.onMsg = fn; const q = L.q; L.q = []; q.forEach(fn); };
    L.isUp = () => !!(L._s && L._s.link);
    L._wd = setInterval(() => {   // сокет «жив», а сообщений нет 5 с — переподключаем
      if (L.closed || !L._s) return;
      if (nowMs() - L._s.rxAt > 5000) L._s.kick();
    }, 1000);
    MQ_BROKERS.forEach((br, i) => mqConnect(br).then(c => {
      settled++; if (c) { up++; attach(c, i); }
      if (fin || settled < MQ_BROKERS.length) return;
      if (!up) finish({ err: 'mqnet', up: 0, n: MQ_BROKERS.length });
      else if (!roomTo) roomTo = setTimeout(() => finish({ err: 'room', up, n: MQ_BROKERS.length }), 4500);
    }));
  });
}

/* ---------------------------------------------------------------- PeerJS (запасной путь) */
const peerErr = e => {
  const ty = (e && e.type) || '';
  if (ty === 'peer-unavailable') return 'room';
  if (/^(network|server-error|socket-error|socket-closed)$/.test(ty)) return 'net';
  return 'conn';
};

export async function peerHub(code) {
  if (typeof RTCPeerConnection === 'undefined') return { err: 'conn' };
  if (!(await loadLib('peerjs'))) return { err: 'peerscript' };
  return new Promise(res => {
    let peer, fin = false;
    const done = v => { if (fin) return; fin = true; clearTimeout(to); res(v); };
    const to = setTimeout(() => { try { peer.destroy(); } catch (_) {} done({ err: 'net' }); }, 10000);
    try { peer = new globalThis.Peer(TOPIC + '-' + code, { debug: 0 }); } catch (_) { done({ err: 'conn' }); return; }
    const h = { kind: 'peer', onMsg: null, closed: false, conns: new Map(), up: () => (peer && !peer.disconnected ? 1 : 0) };
    peer.on('open', () => done({ hub: h }));
    peer.on('error', err => { if (!fin) { try { peer.destroy(); } catch (_) {} done({ err: err && err.type === 'unavailable-id' ? 'taken' : peerErr(err) }); } });
    peer.on('disconnected', () => { try { if (!h.closed) peer.reconnect(); } catch (_) {} });
    peer.on('connection', c => {
      c.on('data', m => {
        if (!m || typeof m !== 'object' || typeof m.from !== 'string') return;
        h.conns.set(m.from, c);
        if (h.onMsg) h.onMsg(m.from, m.d, h);
      });
    });
    h.send = (pid, d) => { const c = h.conns.get(pid); try { if (c && c.open) c.send({ from: 'H', to: pid, d }); } catch (_) {} };
    h.close = () => { h.closed = true; setTimeout(() => { try { peer.destroy(); } catch (_) {} }, 250); };
  });
}

export async function peerLink(code, me, knock) {
  if (typeof RTCPeerConnection === 'undefined') return { err: 'conn' };
  if (!(await loadLib('peerjs'))) return { err: 'peerscript' };
  return new Promise(res => {
    let peer, conn = null, fin = false;
    const L = { kind: 'peer', onMsg: null, closed: false, q: [], srvIdx: 0 };
    const done = v => { if (fin) return; fin = true; clearTimeout(to); if (v.err) { try { peer.destroy(); } catch (_) {} } res(v); };
    const to = setTimeout(() => done({ err: 'conn' }), 14000);
    try { peer = new globalThis.Peer(undefined, { debug: 0 }); } catch (_) { done({ err: 'conn' }); return; }
    peer.on('open', () => {
      try {
        conn = peer.connect(TOPIC + '-' + code, { reliable: true });
        conn.on('open', () => { conn.send({ from: me, to: 'H', d: knock }); });
        conn.on('data', m => {
          if (!m || m.from !== 'H') return;
          if (!fin) done({ link: L });
          if (L.onMsg) L.onMsg(m.d); else L.q.push(m.d);
        });
        conn.on('close', () => { if (L.onDown) L.onDown(); });
        conn.on('error', () => { if (!fin) done({ err: 'conn' }); });
      } catch (_) { done({ err: 'conn' }); }
    });
    peer.on('error', err => { if (!fin) done({ err: peerErr(err) }); });
    L.send = d => { try { if (conn && conn.open) conn.send({ from: me, to: 'H', d }); } catch (_) {} };
    L.close = () => { L.closed = true; setTimeout(() => { try { conn && conn.close(); } catch (_) {} try { peer.destroy(); } catch (_) {} }, 200); };
    L.listen = fn => { L.onMsg = fn; const q = L.q; L.q = []; q.forEach(fn); };
  });
}

/* ---------------------------------------------------------------- прямой канал WebRTC поверх ретранслятора */
const RTC_ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];

/**
 * Один прямой канал (хост ↔ один гость). Сигналы offer/answer/ice идут через sendSig (ретранслятор).
 * rtc.open — канал открыт; rtc.send(m) → false, если не удалось (тогда шлём по ретранслятору).
 */
export function createRtc(role, sendSig, onMsg, onState) {
  const R = { open: false, dead: false, pc: null, dc: null, cand: [], rdesc: false, rxAt: 0 };
  if (typeof RTCPeerConnection === 'undefined') { R.dead = true; return R; }
  const kill = () => {
    R.dead = true; const was = R.open; R.open = false;
    try { if (R.dc) { R.dc.onopen = R.dc.onmessage = R.dc.onclose = null; R.dc.close(); } } catch (_) {}
    try { if (R.pc) { R.pc.onicecandidate = R.pc.onconnectionstatechange = R.pc.ondatachannel = null; R.pc.close(); } } catch (_) {}
    clearTimeout(R.to);
    if (was && onState) onState(false);
  };
  R.close = kill;
  try { R.pc = new RTCPeerConnection({ iceServers: RTC_ICE }); } catch (_) { R.dead = true; return R; }
  const pc = R.pc;
  pc.onicecandidate = e => { if (!R.dead && e.candidate) sendSig({ t: 'rtc', k: 'ice', c: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') kill(); };
  R.to = setTimeout(() => { if (!R.open) kill(); }, 9000);
  const chan = ch => {
    if (R.dc) return; R.dc = ch;
    ch.onopen = () => { if (R.dead) return; clearTimeout(R.to); R.open = true; R.rxAt = nowMs(); if (onState) onState(true); };
    ch.onmessage = e => {
      if (R.dead || typeof e.data !== 'string' || e.data.length > 30000) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      R.rxAt = nowMs(); onMsg(m);
    };
    ch.onclose = () => kill();
  };
  const flush = () => { const q = R.cand; R.cand = []; for (const c of q) { try { pc.addIceCandidate(c).catch(() => {}); } catch (_) {} } };
  R.send = m => {
    if (!R.open || !R.dc || R.dc.readyState !== 'open') return false;
    if (R.dc.bufferedAmount > 48000) return true;   // канал не успевает: старый снимок не нужен
    try { R.dc.send(JSON.stringify(m)); return true; } catch (_) { return false; }
  };
  R.offer = async () => {
    try {
      chan(pc.createDataChannel('g', { ordered: false, maxRetransmits: 0 }));
      const o = await pc.createOffer(); await pc.setLocalDescription(o);
      if (!R.dead) sendSig({ t: 'rtc', k: 'offer', sdp: pc.localDescription.sdp });
    } catch (_) { kill(); }
  };
  R.signal = async m => {
    if (R.dead) return;
    try {
      if (m.k === 'ice') {
        const c = m.c; if (!c || typeof c.candidate !== 'string' || c.candidate.length > 500) return;
        const ci = { candidate: c.candidate, sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 20) : null, sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : 0 };
        if (R.rdesc) pc.addIceCandidate(ci).catch(() => {}); else R.cand.push(ci);
      } else if (m.k === 'offer' && role === 'guest') {
        if (typeof m.sdp !== 'string' || m.sdp.length > 12000) return;
        pc.ondatachannel = e => chan(e.channel);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp }); R.rdesc = true; flush();
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        if (!R.dead) sendSig({ t: 'rtc', k: 'answer', sdp: pc.localDescription.sdp });
      } else if (m.k === 'answer' && role === 'host') {
        if (typeof m.sdp !== 'string' || m.sdp.length > 12000 || R.rdesc) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); R.rdesc = true; flush();
      }
    } catch (_) { kill(); }
  };
  return R;
}
