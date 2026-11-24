/**
 * profile/index.js — локальный профиль игрока и друзья (без серверных аккаунтов).
 * Работает и в браузере, и в Node (хранилище — src/storage.js, с запасом в памяти).
 *
 * Профиль: {
 *   id          — случайный, создаётся один раз (16 hex)
 *   nick        — 1..16 символов
 *   heroId      — id героя из config.CHARACTER_ORDER
 *   color       — цвет формы (#rrggbb), accent — второй цвет формы
 *   friendCode  — 6 символов без путаемых (0/O, 1/I/L), выводится из id
 *   created     — ms
 *   stats: { matches, wins, longestRally, smashes, onlineMatches, onlineWins }
 * }
 * Друг: { friendCode, id?, nick, heroId?, color?, added, lastPlayed, wins, losses, together, auto }
 *   wins/losses — личные встречи (мы против него), together — матчи в одной паре.
 *
 * API:
 *   getProfile() -> Profile | null           (null — профиль ещё не создан)
 *   hasProfile() -> bool
 *   saveProfile(patch) -> Profile             (создаёт профиль, если его нет)
 *   publicProfile(p = getProfile()) -> {id, nick, heroId, color, friendCode} | null — то, что видят другие
 *   friendCodeOf(id) -> string, normalizeCode(str) -> string, isFriendCode(str) -> bool
 *   addFriend({friendCode, nick?, heroId?, color?, id?}, {auto}) -> {ok, friend?, error?}
 *   removeFriend(friendCode), listFriends() -> Friend[] (последние сыгранные выше)
 *   recordMatch({won, longestRally, smashes, online, opponents:[pub], partners:[pub]}) -> {profile, records:[...]}
 *   exportProfile() -> string, importProfile(str) -> {ok, error?}
 *   KIT_COLORS — палитра формы [{color, accent, name}]
 *   onProfileChange(fn) -> unsubscribe
 */
import { loadJSON, saveJSON } from '../storage.js';

const PROFILE_KEY = 'volan.profile';
const FRIENDS_KEY = 'volan.friends';
const EXPORT_PREFIX = 'VOLAN1.';

/** Без 0/O, 1/I/L — код диктуют голосом и переписывают с экрана. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const KIT_COLORS = [
  { color: '#ffb300', accent: '#8a5a00', name: 'Янтарь' },
  { color: '#2fb8ff', accent: '#0b4d80', name: 'Небо' },
  { color: '#ff4d6d', accent: '#7a1027', name: 'Малина' },
  { color: '#4caf50', accent: '#1b5e20', name: 'Корт' },
  { color: '#b388ff', accent: '#4527a0', name: 'Лаванда' },
  { color: '#ff7043', accent: '#8c2a0b', name: 'Пламя' },
  { color: '#f2f4f8', accent: '#1c2a5c', name: 'Белая' },
  { color: '#2a2f45', accent: '#ffd23f', name: 'Ночь' },
];
export function kitAccent(color) {
  const k = KIT_COLORS.find(k => k.color.toLowerCase() === String(color || '').toLowerCase());
  return k ? k.accent : '#1c2433';
}

const HERO_IDS = ['timur', 'kai', 'mira', 'leo', 'aya', 'niko'];
const listeners = new Set();
export function onProfileChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { const p = getProfile(); for (const fn of listeners) { try { fn(p); } catch (e) { console.error(e); } } }

function randomId() {
  const b = new Uint8Array(8);
  try { globalThis.crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < 8; i++) b[i] = (Math.random() * 256) | 0; }
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a → 6 символов алфавита. Детерминированно из id. */
export function friendCodeOf(id) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(s.length - 1 - i), 0x5bd1e995) >>> 0;
  }
  let out = '', a = h1, b = h2;
  for (let i = 0; i < 6; i++) {
    const src = i < 3 ? a : b;
    out += CODE_ALPHABET[src % CODE_ALPHABET.length];
    if (i < 3) a = Math.floor(a / CODE_ALPHABET.length); else b = Math.floor(b / CODE_ALPHABET.length);
  }
  return out;
}

/** Приводит ввод к коду: верхний регистр, без пробелов и дефисов. 0/O/1/I/L в коде не бывает — проверка их отклонит. */
export function normalizeCode(str) {
  return String(str || '').toUpperCase().replace(/[\s\-_.]/g, '');
}
export function isFriendCode(str) {
  return typeof str === 'string' && str.length === 6 && [...str].every(c => CODE_ALPHABET.includes(c));
}

function cleanNick(n) {
  return String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function cleanHex(c, d) { return /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : d; }
function cleanHero(h, d = 'timur') { return HERO_IDS.includes(h) ? h : d; }
const N = v => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : 0);

function sanitizeProfile(p) {
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[0-9a-f]{8,32}$/.test(p.id)) return null;
  const nick = cleanNick(p.nick);
  if (!nick) return null;
  const st = p.stats && typeof p.stats === 'object' ? p.stats : {};
  return {
    id: p.id,
    nick,
    heroId: cleanHero(p.heroId),
    color: cleanHex(p.color, '#ffb300'),
    accent: cleanHex(p.accent, kitAccent(p.color)),
    friendCode: friendCodeOf(p.id),
    created: N(p.created) || Date.now(),
    stats: {
      matches: N(st.matches), wins: N(st.wins), longestRally: N(st.longestRally), smashes: N(st.smashes),
      onlineMatches: N(st.onlineMatches), onlineWins: N(st.onlineWins),
    },
  };
}

export function getProfile() { return sanitizeProfile(loadJSON(PROFILE_KEY, null)); }
export function hasProfile() { return !!getProfile(); }

export function saveProfile(patch = {}) {
  const cur = getProfile();
  const base = cur || { id: randomId(), created: Date.now(), stats: {}, heroId: 'timur', color: '#ffb300' };
  const next = { ...base, ...patch, id: base.id, stats: { ...base.stats, ...(patch.stats || {}) } };
  if (patch.color && !patch.accent) next.accent = kitAccent(patch.color);
  if (!cleanNick(next.nick)) next.nick = 'Игрок';
  const clean = sanitizeProfile(next);
  saveJSON(PROFILE_KEY, clean);
  notify();
  return clean;
}

export function publicProfile(p = getProfile()) {
  if (!p) return null;
  return { id: p.id, nick: p.nick, heroId: p.heroId, color: p.color, friendCode: p.friendCode };
}

// ------------------------------------------------------------------ друзья
function sanitizeFriend(f) {
  if (!f || typeof f !== 'object') return null;
  const code = normalizeCode(f.friendCode);
  if (!isFriendCode(code)) return null;
  return {
    friendCode: code,
    id: typeof f.id === 'string' && /^[0-9a-f]{8,32}$/.test(f.id) ? f.id : null,
    nick: cleanNick(f.nick) || `Друг ${code}`,
    named: !!f.named || !!cleanNick(f.nick),
    heroId: f.heroId ? cleanHero(f.heroId) : null,
    color: f.color ? cleanHex(f.color, null) : null,
    added: N(f.added) || Date.now(),
    lastPlayed: N(f.lastPlayed),
    wins: N(f.wins), losses: N(f.losses), together: N(f.together),
    auto: !!f.auto,
  };
}
function loadFriends() {
  const arr = loadJSON(FRIENDS_KEY, []);
  return Array.isArray(arr) ? arr.map(sanitizeFriend).filter(Boolean) : [];
}
function saveFriends(list) { saveJSON(FRIENDS_KEY, list); notify(); }

export function listFriends() {
  return loadFriends().sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || b.added - a.added);
}

export function addFriend(info = {}, { auto = false } = {}) {
  const code = normalizeCode(info.friendCode || (info.id ? friendCodeOf(info.id) : ''));
  if (!isFriendCode(code)) return { ok: false, error: 'Код друга — 6 символов: буквы и цифры, например 7KQ4MX' };
  const me = getProfile();
  if (me && me.friendCode === code) return { ok: false, error: 'Это ваш собственный код' };
  const list = loadFriends();
  let f = list.find(x => x.friendCode === code);
  const isNew = !f;
  if (!f) { f = sanitizeFriend({ friendCode: code, added: Date.now(), auto }); list.push(f); }
  const nick = cleanNick(info.nick);
  if (nick) { f.nick = nick; f.named = true; }
  if (info.heroId) f.heroId = cleanHero(info.heroId);
  if (info.color) f.color = cleanHex(info.color, f.color);
  if (typeof info.id === 'string' && /^[0-9a-f]{8,32}$/.test(info.id)) f.id = info.id;
  saveFriends(list);
  return { ok: true, friend: { ...f }, isNew };
}

export function removeFriend(friendCode) {
  const code = normalizeCode(friendCode);
  const list = loadFriends();
  const next = list.filter(f => f.friendCode !== code);
  saveFriends(next);
  return next.length !== list.length;
}

// ------------------------------------------------------------------ матчи
/**
 * Записать итог матча в профиль. Для онлайна opponents/partners — публичные профили
 * людей (ИИ не передавать): они автоматически добавляются в друзья, растёт счёт встреч.
 * Возвращает records — что обновилось: ['longestRally'] и т.п.
 */
export function recordMatch(r = {}) {
  const p = getProfile();
  if (!p) return { profile: null, records: [] };
  const st = { ...p.stats };
  const records = [];
  st.matches += 1;
  if (r.won) st.wins += 1;
  if (r.online) { st.onlineMatches += 1; if (r.won) st.onlineWins += 1; }
  const rally = N(r.longestRally);
  if (rally > st.longestRally) { st.longestRally = rally; if (p.stats.longestRally > 0) records.push('longestRally'); }
  st.smashes += N(r.smashes);
  const profile = saveProfile({ stats: st });
  const now = Date.now();
  const touch = (pub, fn) => {
    if (!pub || pub.id === p.id) return;
    const res = addFriend(pub, { auto: true });
    if (!res.ok) return;
    const list = loadFriends();
    const f = list.find(x => x.friendCode === res.friend.friendCode);
    if (!f) return;
    f.lastPlayed = now; fn(f);
    saveFriends(list);
  };
  for (const o of r.opponents || []) touch(o, f => { if (r.won) f.wins++; else f.losses++; });
  for (const o of r.partners || []) touch(o, f => { f.together++; });
  return { profile, records };
}

// ------------------------------------------------------------------ перенос
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64decode(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function checksum(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0; return (h % 1296).toString(36).padStart(2, '0'); }

export function exportProfile() {
  const p = getProfile();
  if (!p) return '';
  const body = b64encode(JSON.stringify({ v: 1, p, f: loadFriends() }));
  return EXPORT_PREFIX + body + '.' + checksum(body);
}

export function importProfile(str) {
  const s = String(str || '').replace(/\s+/g, '');
  if (!s.startsWith(EXPORT_PREFIX)) return { ok: false, error: 'Это не код профиля «Волана»: он начинается с VOLAN1.' };
  const rest = s.slice(EXPORT_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 0) return { ok: false, error: 'Код обрезан — скопируйте его целиком' };
  const body = rest.slice(0, dot), sum = rest.slice(dot + 1);
  if (checksum(body) !== sum) return { ok: false, error: 'Код повреждён — скопируйте его целиком ещё раз' };
  let data;
  try { data = JSON.parse(b64decode(body)); } catch (_) { return { ok: false, error: 'Код повреждён — скопируйте его целиком ещё раз' }; }
  const p = sanitizeProfile(data && data.p);
  if (!p) return { ok: false, error: 'В коде нет профиля' };
  saveJSON(PROFILE_KEY, p);
  const friends = Array.isArray(data.f) ? data.f.map(sanitizeFriend).filter(Boolean) : [];
  saveFriends(friends);
  return { ok: true, profile: p };
}
