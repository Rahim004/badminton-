/**
 * net/codec.js — компактный формат сетевых сообщений (без DOM, тестируется в Node).
 *
 * Всё, что приходит из сети, — недоверенные данные: decode*() проверяют диапазоны
 * и возвращают null, если сообщение негодно (тогда его просто отбрасываем).
 *
 * Снимок хоста 's' (≈ 150–300 байт JSON, 20–30 Гц):
 *   { t:'s', n, T, ph, pa, pl:[row…], sg:[…], mv, m?, ev:[…], ak }
 *   T  — время симуляции хоста, мс (целое);  ph — фаза (индекс PHASES);  pa — пауза у хоста;
 *   pl — игроки: [x, y, z, vx, vy (см, см/с), действие, замах|0, промахи]
 *        замах: [id, t(мс), contactAt(мс), cx, cy, cz (см), тип, вид, флаги(jump|lunge<<1|serve<<2|done<<3)]
 *   sg — отрезок полёта волана: [id, t0(мс), x,y,z (мм), vx,vy,vz (мм/с), состояние, lastHitTeam, lastHitter, флаги(netHit|isServe<<1), hits]
 *        id = розыгрыш·64 + удар; между ударами полёт детерминирован — гость досчитывает его сам;
 *   m  — состояние матча (см. encodeMatch), только когда mv изменился или раз в секунду;
 *   ev — события [seq, имя, T(мс), …данные] (повторяются, пока гость не подтвердит);
 *   ak — подтверждения для этого гостя: [последний тик ввода, опоздание ввода p90 (мс), матч].
 * Ввод гостя 'i':
 *   { t:'i', q, mid, ea, s:[[тик, mx, my, sm]…], sh:[[seq, тик, тип, aim|null, retype]…] }
 *   mx,my,sm ×100 (целые); тик = время симуляции / DT (сетка хоста).
 */
export const PROTO = 1;

export const PHASES = ['idle', 'serve', 'rally', 'point', 'gameBreak', 'over'];
export const ACTIONS = ['idle', 'run', 'swing', 'recover', 'whiff', 'serve'];
export const SHOT_TYPES = ['smart', 'clear', 'smash', 'smashdrop', 'drop', 'net', 'drive', 'lift', 'serveShort', 'serveLong'];
export const KINDS = ['overhead', 'side', 'underhand'];
export const SH_STATES = ['held', 'flight', 'net', 'ground'];
export const EVENTS = ['serveReady', 'serve', 'hit', 'whiff', 'net', 'land', 'point', 'game', 'sides', 'matchOver'];
export const REASONS = ['in', 'out', 'net', 'serveFault'];
const TIMINGS = ['perfect', 'early', 'late'];

export const r1 = v => Math.round(v * 10) / 10;
const cm = v => Math.round(v * 100);
const mm = v => Math.round(v * 1000);
const ms = v => Math.round(v * 1000);

/* ---------- проверки ---------- */
export const inR = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;   // NaN/Infinity не проходят
export const isI = (v, lo, hi) => inR(v, lo, hi) && Number.isInteger(v);
const isA = (a, n) => Array.isArray(a) && (n == null || a.length === n);
const allI = (a, lo, hi) => a.every(v => isI(v, lo, hi));

/* ---------- игроки ---------- */
export function encodePlayer(p, swingId) {
  const row = [cm(p.x), cm(p.y), cm(p.z), cm(p.vx), cm(p.vy), Math.max(0, ACTIONS.indexOf(p.action)), 0, p._whiffN | 0];
  const w = p.swing;
  if (w) {
    const c = w.contact || { x: p.x, y: p.y, z: 1 };
    row[6] = [swingId | 0, ms(w.t), ms(w.contactAt), cm(c.x), cm(c.y), cm(c.z), Math.max(0, SHOT_TYPES.indexOf(w.type)), Math.max(0, KINDS.indexOf(w.kind)),
      (w.jump ? 1 : 0) | (w.lunge ? 2 : 0) | (w.serve ? 4 : 0) | (w.done ? 8 : 0)];
  }
  return row;
}

function validPlayerRow(r) {
  if (!isA(r, 8) || !allI(r.slice(0, 5), -5000, 5000) || !isI(r[5], 0, ACTIONS.length - 1) || !isI(r[7], 0, 1e6)) return false;
  const w = r[6];
  if (w === 0) return true;
  return isA(w, 9) && isI(w[0], 0, 1e9) && isI(w[1], 0, 5000) && isI(w[2], 0, 5000) && allI(w.slice(3, 6), -5000, 5000)
    && isI(w[6], 0, SHOT_TYPES.length - 1) && isI(w[7], 0, KINDS.length - 1) && isI(w[8], 0, 15);
}

/** Строка игрока → плоский объект (метры, секунды). */
export function decodePlayer(r) {
  const o = { x: r[0] / 100, y: r[1] / 100, z: r[2] / 100, vx: r[3] / 100, vy: r[4] / 100, action: ACTIONS[r[5]], whiffN: r[7], swing: null };
  const w = r[6];
  if (w) o.swing = { id: w[0], t: w[1] / 1000, contactAt: w[2] / 1000, contact: { x: w[3] / 100, y: w[4] / 100, z: w[5] / 100 }, type: SHOT_TYPES[w[6]], kind: KINDS[w[7]], jump: !!(w[8] & 1), lunge: !!(w[8] & 2), serve: !!(w[8] & 4), done: !!(w[8] & 8) };
  return o;
}

/* ---------- волан ---------- */
export function encodeSeg(seg) {
  const s = seg.st;
  return [seg.id, ms(seg.t0), mm(s.x), mm(s.y), mm(s.z), mm(s.vx), mm(s.vy), mm(s.vz), Math.max(0, SH_STATES.indexOf(s.state)), s.lastHitTeam, s.lastHitter, (s.netHit ? 1 : 0) | (s.isServe ? 2 : 0), s.hits | 0];
}
export function decodeSeg(a) {
  if (!isA(a, 13) || !isI(a[0], 0, 1e9) || !isI(a[1], -1e3, 1e10) || !allI(a.slice(2, 5), -50000, 50000) || !allI(a.slice(5, 8), -200000, 200000)) return null;
  if (!isI(a[8], 0, 3) || !isI(a[9], -1, 1) || !isI(a[10], -1, 3) || !isI(a[11], 0, 3) || !isI(a[12], 0, 1e6)) return null;
  return {
    id: a[0], t0: a[1] / 1000,
    st: { x: a[2] / 1000, y: a[3] / 1000, z: a[4] / 1000, vx: a[5] / 1000, vy: a[6] / 1000, vz: a[7] / 1000, state: SH_STATES[a[8]], lastHitTeam: a[9], lastHitter: a[10], netHit: !!(a[11] & 1), isServe: !!(a[11] & 2), hits: a[12] },
  };
}

/* ---------- матч ---------- */
export function encodeMatch(m) {
  return [m.score[0], m.score[1], m.games[0], m.games[1], m.serverTeam, m.teamSides[0], m.teamSides[1], m.rightPlayer[0], m.rightPlayer[1], m.over ? 1 : 0, m.winner == null ? -1 : m.winner,
    m.gameIndex | 0, m.intervalDone ? 1 : 0, m.rallies | 0, m.gameScores.map(g => [g[0], g[1]])];
}
export function validMatch(a) {
  return isA(a, 15) && allI(a.slice(0, 4), 0, 99) && isI(a[4], 0, 1) && [a[5], a[6]].every(v => v === -1 || v === 1) && isI(a[7], 0, 1) && isI(a[8], 0, 1)
    && isI(a[9], 0, 1) && isI(a[10], -1, 1) && isI(a[11], 0, 9) && isI(a[12], 0, 1) && isI(a[13], 0, 1e6)
    && Array.isArray(a[14]) && a[14].length <= 5 && a[14].every(g => isA(g, 2) && allI(g, 0, 99));
}
/** Перенести состояние матча в объект match (createMatch) у гостя. */
export function applyMatch(m, a) {
  m.score = [a[0], a[1]]; m.games = [a[2], a[3]]; m.serverTeam = a[4]; m.teamSides = [a[5], a[6]]; m.rightPlayer = [a[7], a[8]];
  m.over = !!a[9]; m.winner = a[10] < 0 ? null : a[10]; m.gameIndex = a[11]; m.intervalDone = !!a[12]; m.rallies = a[13];
  m.gameScores = a[14].map(g => g.slice());
}

/* ---------- события ---------- */
/** Событие игры → массив [seq, имяIdx, T, ...]. Игрок передаётся по id. */
export function encodeEvent(seq, name, e, T, extra = {}) {
  const k = EVENTS.indexOf(name);
  if (k < 0) return null;
  const pid = e && e.player ? e.player.id : -1;
  const sg = extra.sg | 0;
  switch (name) {
    case 'serveReady': return [seq, k, ms(T), e.serverId | 0, sg];
    case 'serve': return [seq, k, ms(T), pid, Math.max(0, SHOT_TYPES.indexOf(e.type)), sg];
    case 'hit': return [seq, k, ms(T), pid, Math.max(0, SHOT_TYPES.indexOf(e.type)), Math.round((e.quality || 0) * 100), Math.max(0, TIMINGS.indexOf(e.timing)), Math.round((e.speed || 0) * 10),
      (e.jump ? 1 : 0) | (e.lunge ? 2 : 0) | (e.serve ? 4 : 0), e.target ? cm(e.target.x) : 0, e.target ? cm(e.target.y) : 0, sg];
    case 'whiff': return [seq, k, ms(T), pid, sg];
    case 'net': return [seq, k, ms(T), cm(e.x), cm(e.y), cm(e.z), sg];
    case 'land': return [seq, k, ms(T), cm(e.x), cm(e.y), e.in ? 1 : 0, sg];
    case 'point': return [seq, k, ms(T), e.winner, Math.max(0, REASONS.indexOf(e.reason)), e.rallyLength | 0,
      e.result ? ((e.result.gameWon ? 1 : 0) | (e.result.matchWon ? 2 : 0) | (e.result.switchSides ? 4 : 0) | (e.result.interval ? 8 : 0)) : 0, e.result && Number.isInteger(e.result.gameWinner) ? e.result.gameWinner : -1, extra.m || null, sg];
    case 'game': return [seq, k, ms(T), e.winner, e.games[0], e.games[1], (e.gameScores || []).map(g => [g[0], g[1]]), sg];
    case 'sides': return [seq, k, ms(T), e.teamSides[0], e.teamSides[1], sg];
    case 'matchOver': return [seq, k, ms(T), e.winner, e.games[0], e.games[1], (e.gameScores || []).map(g => [g[0], g[1]]), extra.stats || null, sg];
  }
  return null;
}

const LEN = { serveReady: 5, serve: 6, hit: 12, whiff: 5, net: 7, land: 7, point: 10, game: 8, sides: 6, matchOver: 9 };
const scoresOk = a => Array.isArray(a) && a.length <= 5 && a.every(g => isA(g, 2) && allI(g, 0, 99));

/**
 * Массив события → { seq, name, T, sg, pid, payload } (payload без ссылок на игроков: pid → игрок подставляет гость).
 * Статистика matchOver проверяется отдельно (поля-числа).
 */
export function decodeEvent(a) {
  if (!Array.isArray(a) || !isI(a[0], 0, 1e9) || !isI(a[1], 0, EVENTS.length - 1) || !isI(a[2], -1e3, 1e10)) return null;
  const name = EVENTS[a[1]];
  if (a.length !== LEN[name]) return null;
  const sg = a[a.length - 1];
  if (!isI(sg, 0, 1e9)) return null;
  const o = { seq: a[0], name, T: a[2] / 1000, sg, pid: -1, payload: {} };
  const P = o.payload;
  const pidOk = v => isI(v, -1, 3);
  switch (name) {
    case 'serveReady': if (!isI(a[3], 0, 3)) return null; P.serverId = a[3]; break;
    case 'serve': if (!pidOk(a[3]) || !isI(a[4], 0, SHOT_TYPES.length - 1)) return null; o.pid = a[3]; P.type = SHOT_TYPES[a[4]]; break;
    case 'hit':
      if (!pidOk(a[3]) || !isI(a[4], 0, SHOT_TYPES.length - 1) || !isI(a[5], 0, 200) || !isI(a[6], 0, 2) || !isI(a[7], 0, 2000) || !isI(a[8], 0, 7) || !isI(a[9], -5000, 5000) || !isI(a[10], -5000, 5000)) return null;
      o.pid = a[3]; P.type = SHOT_TYPES[a[4]]; P.quality = a[5] / 100; P.timing = TIMINGS[a[6]]; P.speed = a[7] / 10;
      P.jump = !!(a[8] & 1); P.lunge = !!(a[8] & 2); if (a[8] & 4) P.serve = true; P.target = { x: a[9] / 100, y: a[10] / 100 }; break;
    case 'whiff': if (!pidOk(a[3])) return null; o.pid = a[3]; break;
    case 'net': if (!allI(a.slice(3, 6), -5000, 5000)) return null; P.x = a[3] / 100; P.y = a[4] / 100; P.z = a[5] / 100; break;
    case 'land': if (!allI(a.slice(3, 5), -5000, 5000) || !isI(a[5], 0, 1)) return null; P.x = a[3] / 100; P.y = a[4] / 100; P.in = !!a[5]; break;
    case 'point':
      if (!isI(a[3], 0, 1) || !isI(a[4], 0, 3) || !isI(a[5], 0, 1e5) || !isI(a[6], 0, 15) || !isI(a[7], -1, 1)) return null;
      if (a[8] != null && !validMatch(a[8])) return null;
      P.winner = a[3]; P.reason = REASONS[a[4]]; P.rallyLength = a[5];
      P.result = { gameWon: !!(a[6] & 1), matchWon: !!(a[6] & 2), switchSides: !!(a[6] & 4), interval: !!(a[6] & 8), gameWinner: a[7] };
      o.m = a[8]; break;
    case 'game': if (!isI(a[3], 0, 1) || !isI(a[4], 0, 9) || !isI(a[5], 0, 9) || !scoresOk(a[6])) return null; P.winner = a[3]; P.games = [a[4], a[5]]; P.gameScores = a[6].map(g => g.slice()); break;
    case 'sides': if (![a[3], a[4]].every(v => v === -1 || v === 1)) return null; P.teamSides = [a[3], a[4]]; break;
    case 'matchOver':
      if (!isI(a[3], 0, 1) || !isI(a[4], 0, 9) || !isI(a[5], 0, 9) || !scoresOk(a[6])) return null;
      P.winner = a[3]; P.games = [a[4], a[5]]; P.gameScores = a[6].map(g => g.slice()); o.stats = validStats(a[7]); break;
  }
  return o;
}

/** Итоговая статистика матча (для экрана итогов у гостя). */
export function encodeStats(st) {
  if (!st) return null;
  return { rallies: st.rallies.slice(-400).map(v => v | 0), perfect: st.perfect | 0, hits: st.hits | 0, whiffs: st.whiffs | 0, winners: st.winners | 0, points: st.points.slice(0, 2) };
}
function validStats(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.rallies) || s.rallies.length > 400 || !allI(s.rallies, 0, 1e5)) return null;
  for (const k of ['perfect', 'hits', 'whiffs', 'winners']) if (!isI(s[k], 0, 1e6)) return null;
  if (!isA(s.points, 2) || !allI(s.points, 0, 1e4)) return null;
  return { rallies: s.rallies.slice(), perfect: s.perfect, hits: s.hits, whiffs: s.whiffs, winners: s.winners, points: s.points.slice(), faults: { out: 0, net: 0, serveFault: 0 }, shots: {} };
}

/* ---------- снимок ---------- */
export function decodeSnap(m) {
  try {
    if (!m || m.t !== 's' || !isI(m.n, 0, 1e9) || !isI(m.T, -1e3, 1e10) || !isI(m.ph, 0, PHASES.length - 1)) return null;
    if (!Array.isArray(m.pl) || m.pl.length < 2 || m.pl.length > 4 || !m.pl.every(validPlayerRow)) return null;
    const sg = decodeSeg(m.sg); if (!sg) return null;
    if (!isI(m.mv, 0, 1e9)) return null;
    if (m.m != null && !validMatch(m.m)) return null;
    if (!Array.isArray(m.ev) || m.ev.length > 64) return null;
    const ev = []; for (const e of m.ev) { const d = decodeEvent(e); if (d) ev.push(d); }
    let ak = null;
    if (m.ak != null) { if (!isA(m.ak, 3) || !isI(m.ak[0], -1, 1e10) || !inR(m.ak[1], -1e5, 1e5) || !isI(m.ak[2], 0, 1e9)) return null; ak = { tick: m.ak[0], late: m.ak[1], mid: m.ak[2] }; }
    return { n: m.n, T: m.T / 1000, phase: PHASES[m.ph], paused: !!m.pa, players: m.pl.map(decodePlayer), seg: sg, mv: m.mv, m: m.m || null, ev, ak, mid: isI(m.mid, 0, 1e9) ? m.mid : 0 };
  } catch (_) { return null; }
}

/* ---------- ввод гостя ---------- */
export const q100 = v => Math.max(-100, Math.min(100, Math.round((+v || 0) * 100)));

export function decodeInput(m) {
  try {
    if (!m || m.t !== 'i' || !isI(m.q, 0, 1e9) || !isI(m.mid, 0, 1e9) || !isI(m.ea, -1, 1e9)) return null;
    if (!Array.isArray(m.s) || m.s.length > 160) return null;
    for (const s of m.s) if (!isA(s, 4) || !isI(s[0], 0, 1e10) || !isI(s[1], -100, 100) || !isI(s[2], -100, 100) || !isI(s[3], 0, 200)) return null;
    if (!Array.isArray(m.sh) || m.sh.length > 16) return null;
    for (const s of m.sh) if (!isA(s, 5) || !isI(s[0], 0, 1e9) || !isI(s[1], 0, 1e10) || !isI(s[2], 0, SHOT_TYPES.length - 1) || !(s[3] === null || isI(s[3], -100, 100)) || !isI(s[4], 0, 1)) return null;
    return {
      q: m.q, mid: m.mid, ea: m.ea,
      samples: m.s.map(s => ({ tick: s[0], mx: s[1] / 100, my: s[2] / 100, sm: s[3] / 100 })),
      shots: m.sh.map(s => ({ seq: s[0], tick: s[1], type: SHOT_TYPES[s[2]], aimY: s[3] == null ? null : s[3] / 100, retype: !!s[4] })),
    };
  } catch (_) { return null; }
}

/* ---------- профиль (то, что видят другие) ---------- */
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
export function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
  return {
    id: s(p.id, 40), nick: s(p.nick, 16) || 'Игрок', heroId: /^[a-z]{2,12}$/.test(p.heroId || '') ? p.heroId : 'timur',
    color: COLOR_RE.test(p.color || '') ? p.color : '', friendCode: /^[A-Z0-9]{4,8}$/.test(p.friendCode || '') ? p.friendCode : '',
  };
}

/* ---------- коды комнат ---------- */
export const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // без O и I; без цифр
export const newRoomCode = (rnd = Math.random) => Array.from({ length: 5 }, () => CODE_ABC[(rnd() * CODE_ABC.length) | 0]).join('');
export const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
