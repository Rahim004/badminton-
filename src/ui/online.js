/**
 * ui/online.js — «Играть с друзьями»: создание комнаты, вход по коду и по ссылке #room-XXXXX,
 * лобби с местами, онлайн-HUD (ники над героями, пинг, эмоции), «Друг отключился», итоги с реваншем.
 *
 * Сеть — модуль из docs/ONLINE_SPEC.md (src/net/index.js → createNet(game)), подключается лениво
 * при первом заходе в онлайн. ?mocknet в адресе — заглушка ui/netMock.js. Нет модуля — net.available() = false.
 *
 *   createOnline(ctx) -> Online
 *     ctx: { nav, handlers, getGame(), getRenderer(), showHud(bool) }
 *   online.screens            — {home, lobby, over} : {el, open(arg)}
 *   online.layers             — элементы поверх игры (HUD, оверлей отключения)
 *   online.setNet(net)        — отдать готовый объект сети (если его создаёт main.js)
 *   online.inMatch / online.active
 *   online.handleHash()       — открыть вход по ссылке #room-XXXXX
 *   online.showOver(info)     — итоги онлайн-матча (вызывается и из ui.showGameOver)
 *   online.leave()            — выйти из комнаты
 *   online.onGameStarted()    — после старта матча: ники/цвета игроков, HUD
 */
import { h, seg, copyText, toast, icon } from './dom.js';
import { portrait } from './portrait.js';
import { heroById } from './heroes.js';
import { topBar, codePlate, plural } from './profileScreens.js';
import * as P from '../profile/index.js';
import { SITE_URL } from '../version.js';
import { platform } from '../platform/index.js';
import { DIFFICULTY, DIFFICULTY_ORDER, MATCH_FORMATS, CHARACTER_ORDER } from '../config.js';

export const EMOTES = [
  { id: 'nice', text: 'Класс!', c: '#2fb8ff' },
  { id: 'fire', text: 'Огонь!', c: '#ff3d6e' },
  { id: 'oops', text: 'Ой!', c: '#ffd23f' },
  { id: 'haha', text: 'Ха-ха!', c: '#3ddc97' },
  { id: 'thanks', text: 'Спасибо!', c: '#b388ff' },
  { id: 'again', text: 'Реванш!', c: '#ff7043' },
];

const ERRORS = {
  'room-not-found': 'Комнаты с таким кодом нет. Проверьте код или попросите друга прислать ссылку ещё раз.',
  'not-found': 'Комнаты с таким кодом нет. Проверьте код или попросите друга прислать ссылку ещё раз.',
  'room-full': 'В комнате уже нет свободных мест.',
  'full': 'В комнате уже нет свободных мест.',
  'version': 'У вас с другом разные версии игры. Обновите страницу у обоих и попробуйте снова.',
  'version-mismatch': 'У вас с другом разные версии игры. Обновите страницу у обоих и попробуйте снова.',
  'timeout': 'Друг не отвечает. Проверьте интернет; если включён VPN — попробуйте с ним и без него.',
  'no-brokers': 'Нет связи с серверами игры. Проверьте интернет или включите/выключите VPN.',
  'network': 'Нет связи с серверами игры. Проверьте интернет или включите/выключите VPN.',
  'offline': 'Нет интернета. Подключитесь к сети и попробуйте снова.',
  'host-left': 'Хозяин закрыл комнату. Создайте новую или попросите новую ссылку.',
  'kicked': 'Хозяин убрал вас из комнаты.',
  'unavailable': 'Онлайн-игра работает в версии на GitHub.',
};
export function errorText(e) {
  if (!e) return 'Связь прервалась. Попробуйте ещё раз.';
  if (typeof e === 'string') return ERRORS[e] || (/[а-яё]/i.test(e) ? e : 'Связь прервалась. Попробуйте ещё раз.');
  if (e.message && /[а-яё]/i.test(e.message)) return e.message; // сеть сама даёт русский текст
  return ERRORS[e.code] || ERRORS[e.reason] || 'Связь прервалась. Попробуйте ещё раз.';
}
const FATAL = new Set(['room-not-found', 'not-found', 'room-full', 'full', 'version', 'version-mismatch', 'host-left', 'kicked', 'unavailable']);

const STATUS = { connecting: 'Подключаемся…', waiting: 'Комната открыта, ждём друга', connected: 'На связи', reconnecting: 'Восстанавливаем связь…', disconnected: 'Нет связи', closed: 'Нет связи', error: 'Нет связи', idle: 'Не подключено' };
const ROUTE = { p2p: 'напрямую', server: 'через сервер' };

function unavailableNet() {
  const noop = () => {};
  return { available: () => false, on: () => noop, off: noop, host: () => Promise.reject(new Error('unavailable')), join: async () => ({ ok: false, error: 'unavailable' }), leave: noop, setReady: noop, setSlot: noop, startMatch: noop, sendEmote: noop, info: () => ({ role: null, connected: false }) };
}

export function parseRoomHash(hash = globalThis.location ? location.hash : '') {
  const m = /^#room-([A-Za-z]{5})$/.exec(hash || '');
  return m ? m[1].toUpperCase() : platform.inviteRoom();   // на CrazyGames код приходит параметром приглашения
}

export function createOnline(ctx) {
  const { nav } = ctx;
  let net = null, netPromise = null, unsub = [];
  const S = { code: null, link: null, lobby: null, status: 'idle', route: null, ms: null, busy: false, inMatch: false, ended: false, teamMap: [0, 1], dropT: 0, lastEmote: 0, overShown: false, smashes: 0, wantRematch: false };
  const me = () => P.publicProfile();

  // ------------------------------------------------------------ сеть
  function setNet(n) { if (net === n) return; detach(); net = n; attach(); }
  async function ensureNet() {
    if (net) return net;
    if (!netPromise) netPromise = (async () => {
      const game = ctx.getGame();
      let n = null;
      const wantMock = /[?&]mocknet\b/.test(globalThis.location ? location.search : '');
      if (!wantMock && globalThis.__net && typeof globalThis.__net.available === 'function') n = globalThis.__net; // создан в main.js
      if (!n && !wantMock) {
        try { const m = await import('../net/index.js'); if (m && typeof m.createNet === 'function') n = m.createNet(game); } catch (_) { n = null; }
      }
      if (!n && wantMock) { const m = await import('./netMock.js'); n = m.createNetMock(game, { friendCodeOf: P.friendCodeOf }); }
      if (!net) setNet(n || unavailableNet());
      return net;
    })();
    return netPromise;
  }
  function available() { try { return !!(net && net.available()); } catch (_) { return false; } }
  function attach() {
    const on = (n, fn) => { const u = net.on(n, fn); unsub.push(typeof u === 'function' ? u : () => net.off && net.off(n, fn)); };
    on('status', onStatus); on('lobby', onLobby); on('peer', onPeer); on('ping', onPing);
    on('error', onError); on('start', onStart); on('end', onEnd); on('emote', onEmote);
    on('pause', e => { if (S.inMatch && e && e.paused) toast(e.text || 'Пауза', 'err'); });
  }
  function detach() { for (const u of unsub) { try { u(); } catch (_) { /* */ } } unsub = []; }

  function onStatus(e) {
    const st = typeof e === 'string' ? e : (e && (e.state || e.status)) || 'idle';
    S.status = st;
    S.statusText = e && typeof e.text === 'string' && e.text && st !== 'connected' ? e.text : null;
    if (e && e.route) S.route = e.route;
    if (e && Number.isFinite(e.ms)) S.ms = e.ms;
    if (S.inMatch) {
      if (st === 'reconnecting' || st === 'disconnected') showDrop({ self: true });
      else if (st === 'connected' && dropLayer.dataset.self === '1') hideDrop();
    }
    paintStatus();
  }
  function onPing(e) {
    const ms = typeof e === 'number' ? e : e && e.ms;
    if (e && e.route) S.route = e.route;
    S.warn = (e && e.warn) || null;
    if (Number.isFinite(ms)) S.ms = Math.round(ms);
    paintStatus();
  }
  function onError(e) {
    const text = errorText(e);
    const code = e && (e.code || e);
    S.busy = false;
    if (S.inMatch) { toast(text, 'err'); return; }
    if (FATAL.has(code) || !S.lobby) {
      S.lobby = null; S.code = null;
      homeErr.textContent = text;
      if (current === 'lobby') nav.go('online', { keep: true });
      paintHome();
    } else { lobbyErr.textContent = text; }
  }
  function onLobby(l) {
    if (!l) return;
    S.lobby = l; if (l.code) S.code = l.code;
    if (!S.link && S.code) S.link = roomLink(S.code);
    roomSync();
    if (current === 'online' && !S.inMatch) nav.go('lobby');
    renderLobby();
  }
  function onPeer(e) {
    if (!e) return;
    const nick = (e.profile && e.profile.nick) || 'Друг';
    const t = e.type || e.event;
    if (t === 'join') { if (!S.inMatch) toast(`${nick} в комнате`); }
    else if (t === 'leave' || t === 'drop' || t === 'lost') {
      if (S.inMatch && !S.ended) showDrop({ nick, left: t === 'leave' });
      else if (current === 'lobby') toast(`${nick} уходит из комнаты`, 'err');
    } else if (t === 'back') {
      if (S.inMatch) { hideDrop(); toast(`${nick} снова на связи`); }
    }
  }
  function onEmote(e) {
    if (!e || !S.inMatch) return;
    const game = ctx.getGame();
    const p = Number.isInteger(e.playerId) && game && game.players[e.playerId] ? game.players[e.playerId] : playerForSlot(e.team, e.seat);
    popEmote(e.id, p);
  }

  // ------------------------------------------------------------ места и игроки
  // Сообщаем площадке о комнате (CrazyGames: друзья видят её и могут зайти). Повторы с тем же состоянием отбрасываем.
  let roomKey = '';
  function roomSync() {
    if (!S.code) return;
    const key = S.code + (S.inMatch ? ':0' : ':1');
    if (key !== roomKey) { roomKey = key; platform.roomUpdate(S.code, !S.inMatch); }
  }
  function roomClosed() { if (roomKey) { roomKey = ''; platform.roomLeft(); } }
  function roomLink(code) {   // в приложении (APK/exe) адрес локальный — зовём друзей на сайт
    const pl = platform.roomLink(code);   // порталы: ссылка площадки или null (только код комнаты)
    if (pl !== undefined) return pl;
    try { if (/VolanApp/.test(navigator.userAgent)) return `${SITE_URL}#room-${code}`; return `${location.origin}${location.pathname}#room-${code}`; } catch (_) { return `#room-${code}`; }
  }
  function mySlot() {
    if (!S.lobby) return null;
    const you = S.lobby.slots.find(s => s.you);
    if (you) return you;
    const id = me() && me().id;
    return S.lobby.slots.find(s => s.profile && s.profile.id === id) || null;
  }
  function hostId() { const l = S.lobby; return l ? (l.hostId || (l.host && l.host.id) || null) : null; }
  function isHost() {
    try { const i = net.info(); if (i && i.role) return i.role === 'host'; } catch (_) { /* */ }
    return !!(S.lobby && me() && hostId() === me().id);
  }
  function playerForSlot(team, seat) {
    const game = ctx.getGame();
    if (!game || !game.players) return null;
    const t = S.teamMap[team] ?? team;
    return game.players.find(p => p.team === t && p.idx === (seat || 0)) || null;
  }

  // ------------------------------------------------------------ экран «Играть с друзьями»
  const createOpts = { mode: 'singles', format: 'quick', difficulty: 'amateur' };
  // Тестовый транспорт сети (две вкладки одного браузера): ?nettransport=bc
  const testTransport = (() => { try { return new URLSearchParams(location.search).get('nettransport') || undefined; } catch (_) { return undefined; } })();
  const homeErr = h('p', { class: 'field-err big', role: 'alert', id: 'onlineError' });
  const codeIn = h('input', { class: 'field code-field', id: 'roomCodeInput', type: 'text', maxlength: '5', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Код', 'aria-label': 'Код комнаты' });
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); homeErr.textContent = ''; });
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(codeIn.value); });
  const createBtn = h('button', { class: 'bar go', id: 'roomCreate', type: 'button', onclick: host }, h('span', { class: 'bar-label' }, 'Создать комнату'));
  const joinBtn = h('button', { class: 'bar sky small', id: 'roomJoin', type: 'button', onclick: () => join(codeIn.value) }, h('span', { class: 'bar-label' }, 'Войти'));
  const diffRow = h('div', { class: 'row hidden' }, h('div', { class: 'field-label' }, 'ИИ на свободных местах'),
    seg('onlineDiff', DIFFICULTY_ORDER.map(k => [k, DIFFICULTY[k].label]), createOpts.difficulty, v => { createOpts.difficulty = v; }));
  const homeBody = h('div', { class: 'online-body' },
    h('section', { class: 'block' },
      h('h3', {}, 'Новая комната'),
      h('div', { class: 'row' }, h('div', { class: 'field-label' }, 'Формат'),
        seg('onlineMode', [['singles', '1 × 1'], ['doubles', '2 × 2']], createOpts.mode, v => { createOpts.mode = v; diffRow.classList.toggle('hidden', v !== 'doubles'); })),
      h('div', { class: 'row' }, h('div', { class: 'field-label' }, 'Матч'),
        seg('onlineFormat', Object.entries(MATCH_FORMATS).map(([k, f]) => [k, f.label]), createOpts.format, v => { createOpts.format = v; })),
      diffRow,
      createBtn),
    h('section', { class: 'block' },
      h('h3', {}, 'Комната друга'),
      h('p', { class: 'note' }, 'Введите 5 букв, которые прислал друг, или просто откройте его ссылку.'),
      h('div', { class: 'add-row' }, codeIn, joinBtn)),
    homeErr);
  const unavailableNote = h('p', { class: 'note' }, platform.portal ? 'Не удалось подключиться к серверам игры. Проверьте интернет — против ИИ можно играть без сети.' : 'Здесь сеть закрыта. Откройте игру по ссылке на GitHub Pages — там можно создать комнату и позвать друга. Против ИИ можно играть и здесь.');
  const unavailableBox = h('div', { class: 'unavailable hidden', id: 'onlineUnavailable' },
    h('div', { class: 'big-icon' }, icon('people')),
    h('h3', {}, platform.portal ? 'Онлайн-игра сейчас недоступна' : 'Онлайн-игра работает в версии на GitHub'),
    unavailableNote,
    h('button', { class: 'bar', type: 'button', onclick: () => nav.go('menu') }, h('span', { class: 'bar-label' }, 'В меню')));
  const loadingBox = h('p', { class: 'note center hidden' }, 'Загружаем онлайн…');
  const home = {
    el: h('div', { class: 'screen hidden', id: 'online' },
      h('div', { class: 'sheet' }, topBar('Играть с друзьями', () => { leave(); nav.go('menu'); }), loadingBox, unavailableBox, homeBody)),
    async open(arg = {}) {
      if (!P.hasProfile()) { nav.go('profileEdit', { then: () => nav.go('online', arg) }); return; }
      if (!arg.keep) homeErr.textContent = '';
      if (!net) { loadingBox.classList.remove('hidden'); homeBody.classList.add('hidden'); await ensureNet(); loadingBox.classList.add('hidden'); }
      paintHome();
      if (arg.joinCode && available()) join(arg.joinCode);
      else if (arg.autoHost && available()) host();   // CrazyGames «instant multiplayer»: сразу своя комната
    },
  };
  function paintHome() {
    const ok = available();
    unavailableBox.classList.toggle('hidden', ok);
    homeBody.classList.toggle('hidden', !ok);
    createBtn.disabled = joinBtn.disabled = S.busy;
    createBtn.querySelector('.bar-label').textContent = S.busy === 'host' ? 'Создаём комнату…' : 'Создать комнату';
    joinBtn.querySelector('.bar-label').textContent = S.busy === 'join' ? 'Входим…' : 'Войти';
  }

  async function host() {
    if (S.busy) return;
    await ensureNet();
    if (!available()) { paintHome(); return; }
    S.busy = 'host'; homeErr.textContent = ''; paintHome();
    try {
      const r = await net.host({ ...createOpts, profile: me(), transport: testTransport });
      S.code = r && r.code; S.link = platform.roomLink(S.code) === undefined ? ((r && r.link) || roomLink(S.code)) : roomLink(S.code);
      S.busy = false; paintHome();
      nav.go('lobby');
    } catch (e) { S.busy = false; homeErr.textContent = errorText(e && (e.code || e.message) ? e : 'network'); paintHome(); }
  }
  async function join(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (S.busy) return;
    if (code.length < 4) { homeErr.textContent = 'Код комнаты — 5 букв, например KTQMX'; codeIn.focus(); return; }
    await ensureNet();
    if (!available()) { paintHome(); return; }
    S.busy = 'join'; homeErr.textContent = ''; paintHome();
    try {
      const r = await net.join(code, { profile: me(), transport: testTransport });
      S.busy = false; paintHome();
      if (r && r.ok === false) { if (!homeErr.textContent) homeErr.textContent = errorText(r.error); return; }
      S.code = code; S.link = roomLink(code);
      nav.go('lobby');
    } catch (e) { S.busy = false; homeErr.textContent = errorText(e && e.code ? e : 'network'); paintHome(); }
  }

  // ------------------------------------------------------------ лобби
  const lobbyErr = h('p', { class: 'field-err', role: 'alert' });
  const plateBox = h('div', { class: 'room-plate', id: 'roomCode' });
  const statusEl = h('div', { class: 'net-status', id: 'netStatus', role: 'status' });
  const seatsEl = h('div', { class: 'seats', id: 'seats' });
  const readyBtn = h('button', { class: 'bar go', id: 'readyBtn', type: 'button', onclick: () => { const s = mySlot(); net.setReady(!(s && s.ready)); } }, h('span', { class: 'bar-label' }, 'Готов'));
  const startBtn = h('button', { class: 'bar go', id: 'startOnline', type: 'button', onclick: () => { if (!startBtn.disabled) { net.startMatch(); startBtn.disabled = true; startBtn.querySelector('.bar-label').textContent = 'Начинаем…'; } } }, icon('play'), h('span', { class: 'bar-label' }, 'Начать'));
  const waitNote = h('p', { class: 'note center', id: 'lobbyWait' });
  const shareBtn = h('button', { class: 'bar small', id: 'shareLink', type: 'button', onclick: share }, icon('share'), h('span', { class: 'bar-label' }, 'Отправить'));
  const linkField = h('input', { class: 'field mono link-field', id: 'roomLink', readonly: true, 'aria-label': 'Ссылка на комнату' });
  const lobbyMeta = h('div', { class: 'lobby-meta' });
  const copyLabel = h('span', { class: 'bar-label' }, 'Скопировать ссылку');
  const shareNote = h('p', { class: 'note' }, 'Отправьте ссылку в Telegram или WhatsApp — по ней друг сразу попадёт в комнату.');
  const lobby = {
    el: h('div', { class: 'screen hidden', id: 'lobby' },
      h('div', { class: 'sheet wide' },
        topBar('Комната', () => { leave(); nav.go('online'); }),
        h('div', { class: 'room-head' },
          h('div', { class: 'room-code-wrap' }, h('div', { class: 'field-label' }, 'Код комнаты'), plateBox, lobbyMeta),
          h('div', { class: 'room-share' },
            h('div', { class: 'add-row' },
              h('button', { class: 'bar sky', id: 'copyLink', type: 'button', onclick: copyLink }, icon('copy'), copyLabel),
              navigator.share ? shareBtn : null),
            linkField,
            shareNote)),
        statusEl,
        seatsEl,
        lobbyErr,
        waitNote,
        h('div', { class: 'lobby-actions' }, readyBtn, startBtn))),
    open() { lobbyErr.textContent = ''; renderLobby(); },
  };
  async function copyLink() {
    if (!S.link) {   // портал без ссылок-приглашений: делимся кодом комнаты
      const rc = await copyText(S.code || '');
      toast(rc === 'copied' ? 'Код комнаты скопирован — назовите его другу' : 'Не удалось скопировать — назовите код другу вслух', rc === 'copied' ? 'ok' : 'err');
      return;
    }
    const r = await copyText(S.link || '', linkField);
    linkField.classList.toggle('shown', r !== 'copied');
    toast(r === 'copied' ? 'Ссылка скопирована — отправьте её другу' : 'Ссылка выделена — скопируйте её вручную', r === 'copied' ? 'ok' : 'err');
  }
  async function share() {
    try { await navigator.share({ title: 'Волан — бадминтон', text: `Сыграем в бадминтон? Комната ${S.code}`, url: S.link }); } catch (_) { /* отменено */ }
  }
  function seatCard(slot, mine, mode) {
    const p = slot.profile;
    const canMove = !p && !S.inMatch;
    const el = h(canMove ? 'button' : 'div', {
      class: 'seat' + (p ? '' : slot.ai ? ' ai' : ' empty') + (mine ? ' mine' : '') + (slot.ready ? ' ready' : ''),
      type: canMove ? 'button' : null, 'data-team': slot.team, 'data-seat': slot.seat,
      style: p ? `--kit:${p.color || heroById(p.heroId).color}` : null,
      onclick: canMove ? () => net.setSlot(slot.team, slot.seat) : null,
      'aria-label': canMove ? 'Сесть сюда' : null,
    });
    if (p) {
      const hero = heroById(p.heroId);
      el.append(
        h('div', { class: 'seat-bust' }, portrait(hero.id, { size: 72, mood: slot.ready ? 'happy' : 'calm', color: p.color, accent: P.kitAccent(p.color), flip: slot.team === 1 })),
        h('div', { class: 'seat-info' },
          h('div', { class: 'seat-nick' }, p.nick, mine ? h('small', {}, ' (вы)') : null),
          h('div', { class: 'seat-hero' }, hero.name),
          h('div', { class: 'seat-badge ' + (slot.ready ? 'ok' : (hostId() === p.id ? 'host' : 'wait')) },
            slot.ready ? 'Готов' : hostId() === p.id ? 'Хозяин' : 'Не готов')));
    } else if (slot.ai) {
      el.append(h('div', { class: 'seat-bust ai' }, icon('robot')),
        h('div', { class: 'seat-info' }, h('div', { class: 'seat-nick' }, 'ИИ'), h('div', { class: 'seat-hero' }, DIFFICULTY[S.lobby.difficulty] ? DIFFICULTY[S.lobby.difficulty].label : 'Свободное место'), h('div', { class: 'seat-badge move' }, 'Сесть сюда')));
    } else {
      el.append(h('div', { class: 'seat-bust empty' }, icon('plus')),
        h('div', { class: 'seat-info' }, h('div', { class: 'seat-nick' }, 'Свободно'), h('div', { class: 'seat-hero' }, mode === 'singles' ? 'Ждём друга' : 'Друг или ИИ'), h('div', { class: 'seat-badge move' }, 'Сесть сюда')));
    }
    return el;
  }
  function renderLobby() {
    const l = S.lobby;
    plateBox.textContent = '';
    plateBox.append(codePlate(S.code || '·····', { big: true, label: 'Код комнаты ' + (S.code || '') }));
    linkField.value = S.link || '';
    const noLink = !S.link;   // портал без ссылок-приглашений (Яндекс Игры): только код комнаты
    linkField.classList.toggle('hidden', noLink); shareBtn.classList.toggle('hidden', noLink);
    copyLabel.textContent = noLink ? 'Скопировать код' : 'Скопировать ссылку';
    shareNote.textContent = noLink ? 'Сообщите другу код комнаты — он вводит его в разделе «Играть с друзьями».' : 'Отправьте ссылку в Telegram или WhatsApp — по ней друг сразу попадёт в комнату.';
    seatsEl.textContent = '';
    if (!l) { waitNote.textContent = 'Подключаемся к комнате…'; readyBtn.classList.add('hidden'); startBtn.classList.add('hidden'); lobbyMeta.textContent = ''; paintStatus(); return; }
    const fmt = MATCH_FORMATS[l.format];
    lobbyMeta.textContent = `${l.mode === 'doubles' ? '2 × 2' : '1 × 1'}, ${fmt ? fmt.label : ''}`;
    const mine = mySlot();
    seatsEl.classList.toggle('doubles', l.mode === 'doubles');
    for (let team = 0; team < 2; team++) {
      const col = h('div', { class: 'team team-' + team },
        h('div', { class: 'team-label' }, mine ? (mine.team === team ? 'Ваша команда' : 'Соперники') : (team === 0 ? 'Команда 1' : 'Команда 2')));
      for (const s of l.slots.filter(x => x.team === team).sort((a, b) => a.seat - b.seat)) col.append(seatCard(s, mine && s === mine, l.mode));
      seatsEl.append(col);
      if (team === 0) seatsEl.append(h('div', { class: 'vs', 'aria-hidden': 'true' }, 'VS'));
    }
    const humans = l.slots.filter(s => s.profile);
    const others = humans.filter(s => s !== mine);
    const host = isHost();
    const allReady = typeof l.canStart === 'boolean' ? l.canStart : others.length > 0 && others.every(s => s.ready);
    readyBtn.classList.toggle('hidden', host);
    startBtn.classList.toggle('hidden', !host);
    readyBtn.classList.toggle('on', !!(mine && mine.ready));
    readyBtn.querySelector('.bar-label').textContent = mine && mine.ready ? 'Готов — ждём начала' : 'Готов';
    startBtn.disabled = !allReady;
    startBtn.querySelector('.bar-label').textContent = 'Начать';
    waitNote.textContent = !others.length ? 'Ждём друга. Отправьте ему ссылку или код.'
      : host ? (allReady ? 'Все готовы — жмите «Начать».' : 'Ждём, пока все нажмут «Готов».')
      : (mine && mine.ready ? 'Хозяин комнаты начнёт матч.' : 'Нажмите «Готов», когда будете готовы.');
    paintStatus();
  }
  function paintStatus() {
    const st = S.status;
    const ms = S.ms;
    const quality = st !== 'connected' ? 'bad' : ms == null ? 'mid' : ms < 90 ? 'good' : ms < 180 ? 'mid' : 'bad';
    statusEl.className = 'net-status ' + quality;
    statusEl.textContent = '';
    statusEl.append(h('i', { class: 'dot' }), h('span', {}, S.statusText || STATUS[st] || st));
    if (S.warn) statusEl.append(h('span', { class: 'route' }, S.warn));
    if (st === 'connected') {
      if (S.route) statusEl.append(h('span', { class: 'route' }, ROUTE[S.route] || S.route));
      if (ms != null) statusEl.append(h('b', {}, `${ms} мс`));
    }
    pingEl.className = 'ping-pill ' + quality;
    pingEl.textContent = '';
    pingEl.append(h('i', { class: 'dot' }), st === 'connected' && ms != null ? `${ms} мс` : (STATUS[st] || ''));
    if (st === 'connected' && S.route) pingEl.append(h('small', {}, S.route === 'p2p' ? 'прямое' : 'сервер'));
  }

  // ------------------------------------------------------------ HUD в матче
  const pingEl = h('div', { class: 'ping-pill', id: 'pingPill' });
  const palette = h('div', { class: 'emote-palette hidden', id: 'emotePalette', role: 'menu' },
    ...EMOTES.map(e => h('button', { class: 'emote-btn', type: 'button', role: 'menuitem', 'data-emote': e.id, style: `--c:${e.c}`, onclick: () => sendEmote(e.id) }, e.text)));
  const emoteToggle = h('button', { class: 'icon-btn hud-btn', id: 'emoteBtn', type: 'button', 'aria-label': 'Реакции', 'aria-expanded': 'false',
    onclick: () => { const open = palette.classList.toggle('hidden'); emoteToggle.setAttribute('aria-expanded', String(!open)); } }, icon('chat'));
  const tagLayer = h('div', { class: 'tag-layer', 'aria-hidden': 'true' });
  const hud = h('div', { class: 'online-hud hidden', id: 'onlineHud' }, tagLayer, pingEl, emoteToggle, palette);
  const tags = new Map(); // player -> {el, bubbles:[]}
  let rafId = 0;

  function sendEmote(id) {
    const now = performance.now();
    if (now - S.lastEmote < 900) return;
    S.lastEmote = now;
    palette.classList.add('hidden'); emoteToggle.setAttribute('aria-expanded', 'false');
    try { net.sendEmote(id); } catch (_) { /* */ }
    const s = mySlot();
    popEmote(id, s ? playerForSlot(s.team, s.seat) : (ctx.getGame() || {}).human);
  }
  function popEmote(id, player) {
    const e = EMOTES.find(x => x.id === id) || { text: String(id).slice(0, 12), c: '#fff' };
    const b = h('div', { class: 'emote-pop', style: `--c:${e.c}` }, e.text);
    tagLayer.append(b);
    const rec = { el: b, player, t0: performance.now() };
    bubbles.push(rec);
    setTimeout(() => { b.remove(); const i = bubbles.indexOf(rec); if (i >= 0) bubbles.splice(i, 1); }, 2400);
    tick();
  }
  const bubbles = [];
  function buildTags() {
    tagLayer.querySelectorAll('.nick-tag').forEach(x => x.remove());
    tags.clear();
    if (!S.lobby) return;
    const mine = mySlot();
    for (const s of S.lobby.slots) {
      if (!s.profile || s === mine) continue;
      const p = playerForSlot(s.team, s.seat);
      if (!p) continue;
      const friendlyTeam = mine && s.team === mine.team;
      const el = h('div', { class: 'nick-tag' + (friendlyTeam ? ' ally' : ''), style: `--kit:${s.profile.color || '#fff'}` }, s.profile.nick);
      tagLayer.append(el);
      tags.set(p, el);
    }
  }
  function headOf(p) {
    const R = ctx.getRenderer();
    try { return p && R && R.characters && R.characters.headScreen(p); } catch (_) { return null; }
  }
  function tick() {
    if (rafId) return;
    rafId = requestAnimationFrame(function loop() {
      rafId = 0;
      if (hud.classList.contains('hidden')) return;
      const R = ctx.getRenderer();
      const top = R && R.hudRect ? R.hudRect.h : 60;
      pingEl.style.top = `${Math.round(top + 6)}px`;
      for (const [p, el] of tags) {
        const hd = headOf(p);
        if (!hd) { el.style.opacity = '0'; continue; }
        el.style.opacity = '';
        el.style.transform = `translate(${Math.round(hd.x)}px, ${Math.round(hd.y - hd.r * 1.9)}px) translate(-50%, -100%)`;
      }
      for (const b of bubbles) {
        const hd = headOf(b.player);
        const x = hd ? hd.x : innerWidth / 2, y = hd ? hd.y - hd.r * 1.9 - 26 : top + 40;
        b.el.style.left = `${Math.round(x)}px`; b.el.style.top = `${Math.round(Math.max(top + 30, y))}px`;
      }
      tick();
    });
  }

  // ------------------------------------------------------------ «Друг отключился»
  const dropTitle = h('h2', {}, '');
  const dropText = h('p', { class: 'note center' }, '');
  const dropTimer = h('div', { class: 'drop-timer' }, '');
  const dropLayer = h('div', { class: 'screen dim hidden', id: 'dropOverlay', role: 'alertdialog', 'aria-live': 'assertive' },
    h('div', { class: 'sheet small center' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }, icon('shuttle')),
      dropTitle, dropText, dropTimer,
      h('button', { class: 'bar', id: 'dropLeave', type: 'button', onclick: () => { hideDrop(); leave(); ctx.handlers.onQuit?.(); } }, h('span', { class: 'bar-label' }, 'Выйти в меню'))));
  let dropIv = 0;
  function showDrop({ nick, self, left } = {}) {
    dropLayer.dataset.self = self ? '1' : '0';
    dropTitle.textContent = self ? 'Связь потерялась' : 'Друг отключился';
    dropText.textContent = self ? 'Восстанавливаем соединение. Если не выйдет — проверьте интернет или VPN.'
      : left ? `${nick} выходит из матча.` : `${nick}: нет связи. Подождём — может, связь вернётся.`;
    S.dropT = performance.now();
    clearInterval(dropIv);
    const upd = () => { const s = Math.floor((performance.now() - S.dropT) / 1000); dropTimer.textContent = `Ждём ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    upd(); dropIv = setInterval(upd, 500);
    dropLayer.classList.remove('hidden');
  }
  function hideDrop() { clearInterval(dropIv); dropLayer.classList.add('hidden'); }

  // ------------------------------------------------------------ старт / конец матча
  function onStart(e) {
    S.inMatch = true; S.ended = false; S.overShown = false; S.wantRematch = false; S.smashes = 0; roomSync();
    if (e && e.slots && S.lobby) S.lobby = { ...S.lobby, slots: e.slots };
    const l = S.lobby || { mode: (e && e.mode) || 'singles', slots: [] };
    const mine = mySlot();
    if (ctx.handlers.onOnlineStart) {
      S.teamMap = [0, 1];
      ctx.handlers.onOnlineStart(e, { lobby: l, me: me(), slot: mine });
    } else if (!net || !net.__mock) {
      S.teamMap = [0, 1]; // настоящая сеть сама запускает матч (game 'netStart' → main.js)
    } else {
      S.matchStarted = true;
      // Без сетевой обвязки в main.js: локальный матч, своя команда — нулевая.
      const myTeam = mine ? mine.team : 0;
      S.teamMap = myTeam === 0 ? [0, 1] : [1, 0];
      const per = l.mode === 'doubles' ? 2 : 1;
      const chars = new Array(per * 2).fill(null);
      const used = new Set();
      const order = [];
      if (mine) order.push(mine);
      for (const s of l.slots) if (s !== mine) order.push(s);
      for (const s of order) {
        const idx = S.teamMap[s.team] * per + s.seat;
        let hid = s.profile && s.profile.heroId;
        if (!hid || used.has(hid)) hid = CHARACTER_ORDER.find(x => !used.has(x));
        used.add(hid); chars[idx] = hid;
      }
      ctx.handlers.onStart?.({ mode: l.mode, difficulty: (e && e.difficulty) || l.difficulty || 'amateur', format: (e && e.format) || l.format || 'quick', characters: chars, online: true });
    }
    onGameStarted();
  }
  function onGameStarted() {
    const l = S.lobby;
    if (l) for (const s of l.slots) {
      const p = playerForSlot(s.team, s.seat);
      if (!p || !s.profile) continue;
      p.name = s.profile.nick;
      if (s.profile.color) { p.color = s.profile.color; p.accent = P.kitAccent(s.profile.color); }
    }
    buildTags();
    ctx.showHud(true);
  }
  function onEnd(e) {
    e = e || {};
    if (e.reason && e.reason !== 'over') { // матч или комната закрылись без результата
      const text = errorText(e.message ? e : (e.reason === 'left' ? null : e.reason));
      const wasIn = S.inMatch;
      hideDrop(); ctx.showHud(false);
      S.inMatch = false; S.lobby = null; S.code = null; S.status = 'idle'; roomClosed();
      if (e.reason === 'left') return; // сами вышли
      if (wasIn) toast(text, 'err');
      else { homeErr.textContent = text; if (current === 'lobby') nav.go('online', { keep: true }); }
      return;
    }
    if (!S.inMatch || S.overShown) return;
    const mine = mySlot();
    const myTeam = mine ? mine.team : 0;
    const won = typeof e.won === 'boolean' ? e.won : e.winner === myTeam;
    showOver({ won, gameScores: e.gameScores || e.score || [], lobbyTeam: myTeam, longestRally: e.longestRally, smashes: e.smashes && me() ? e.smashes[me().id] : null });
  }

  const overTitle = h('h2', { class: 'result' }, '');
  const overScore = h('div', { class: 'score-big' });
  const overVs = h('div', { class: 'over-vs' });
  const overNote = h('p', { class: 'note center' });
  const rematchBtn = h('button', { class: 'bar go', id: 'rematch', type: 'button', onclick: rematch }, h('span', { class: 'bar-label' }, 'Реванш'));
  const over = {
    el: h('div', { class: 'screen hidden', id: 'onlineOver' },
      h('div', { class: 'sheet center' }, overTitle, overScore, overVs, overNote,
        h('div', { class: 'lobby-actions' }, rematchBtn,
          h('button', { class: 'bar', id: 'onlineToMenu', type: 'button', onclick: () => { leave(); ctx.handlers.onQuit?.(); } }, h('span', { class: 'bar-label' }, 'Выйти в меню'))))),
    open() {},
  };
  /** info: {won, gameScores, team?(игровая команда), lobbyTeam?, longestRally?, smashes?} */
  function showOver(info) {
    if (S.overShown) return;
    S.overShown = true; S.ended = true;
    hideDrop();
    ctx.showHud(false);
    const game = ctx.getGame();
    const mine = mySlot();
    const myTeam = mine ? mine.team : 0;
    const gTeam = S.teamMap[myTeam];
    const rallies = game && game.stats && game.stats.rallies || [];
    const longest = Number.isFinite(info.longestRally) ? info.longestRally : rallies.reduce((a, b) => Math.max(a, b), 0);
    const opponents = [], partners = [];
    if (S.lobby) for (const s of S.lobby.slots) {
      if (!s.profile || s === mine) continue;
      (s.team === myTeam ? partners : opponents).push(s.profile);
    }
    const rec = P.recordMatch({ won: !!info.won, longestRally: longest, smashes: Number.isFinite(info.smashes) ? info.smashes : S.smashes, online: true, opponents, partners });
    overTitle.textContent = info.won ? 'Победа!' : 'Поражение';
    overTitle.classList.toggle('lose', !info.won);
    overScore.textContent = '';
    for (const g of info.gameScores || []) {
      const a = g[info.lobbyTeam != null ? S.teamMap[info.lobbyTeam] : gTeam], b = g[1 - (info.lobbyTeam != null ? S.teamMap[info.lobbyTeam] : gTeam)];
      overScore.append(h('span', { class: 'g' }, h('b', {}, String(a)), h('i', {}, ':'), h('b', {}, String(b))));
    }
    overVs.textContent = '';
    if (S.lobby) {
      const side = team => h('div', { class: 'vs-side' }, ...S.lobby.slots.filter(s => s.team === team).map(s => {
        const won = (team === myTeam) === !!info.won;
        const hero = s.profile ? s.profile.heroId : null;
        return h('div', { class: 'vs-pl' },
          hero ? h('div', { class: 'seat-bust' }, portrait(hero, { size: 64, mood: won ? 'happy' : 'sad', color: s.profile.color, accent: P.kitAccent(s.profile.color), flip: team !== myTeam })) : h('div', { class: 'seat-bust ai' }, icon('robot')),
          h('span', {}, s.profile ? (s === mine ? 'Вы' : s.profile.nick) : 'ИИ'));
      }));
      overVs.append(side(myTeam), h('div', { class: 'vs' }, 'VS'), side(1 - myTeam));
    }
    const notes = [];
    if (opponents.length === 1) {
      const f = P.listFriends().find(x => x.friendCode === opponents[0].friendCode || x.id === opponents[0].id);
      if (f) notes.push(`Личные встречи: вы ${f.wins} — ${f.losses} ${f.nick}`);
    }
    if (rec.records.includes('longestRally')) notes.push(`Новый рекорд: розыгрыш в ${longest} ${plural(longest, 'удар', 'удара', 'ударов')}`);
    overNote.textContent = notes.join('. ');
    rematchBtn.disabled = false;
    rematchBtn.querySelector('.bar-label').textContent = 'Реванш';
    nav.go('onlineOver');
  }
  function rematch() {
    S.inMatch = false; S.wantRematch = true; roomSync();
    try { if (!isHost()) net.setReady(true); } catch (_) { /* */ } // хост жмёт «Начать», когда все готовы
    if (ctx.handlers.onOnlineLobby) ctx.handlers.onOnlineLobby();
    else if (S.matchStarted) { S.matchStarted = false; ctx.handlers.onQuit?.(); } // остановить локальный матч
    nav.go('lobby');
  }
  function leave() {
    hideDrop(); ctx.showHud(false);
    if (net && (S.code || S.lobby)) { try { net.leave(); } catch (_) { /* */ } }
    if (S.matchStarted) { S.matchStarted = false; ctx.handlers.onQuit?.(); } // матч ещё идёт в main.js — остановить
    roomClosed();
    S.code = null; S.link = null; S.lobby = null; S.inMatch = false; S.ended = false; S.busy = false; S.status = 'idle'; S.ms = null; S.route = null;
    try { if (parseRoomHash()) history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* */ }
  }

  let current = null;
  return {
    screens: { home, lobby, over },
    layers: [hud, dropLayer],
    setNet,
    ensureNet,
    get net() { return net; },
    get state() { return S; },
    get active() { return !!(S.code || S.lobby); },
    get inMatch() { return S.inMatch; },
    set current(v) { current = v; },
    showHud(b) {
      hud.classList.toggle('hidden', !b);
      if (b) { palette.classList.add('hidden'); paintStatus(); tick(); }
      else { tagLayer.querySelectorAll('.emote-pop').forEach(x => x.remove()); bubbles.length = 0; }
    },
    countSmash() { if (S.inMatch) S.smashes++; },
    handleHash() {
      const code = parseRoomHash();
      if (code) { nav.go('online', { joinCode: code }); return true; }
      return false;
    },
    showOver,
    leave,
    onGameStarted,
    sendEmote,
    showDrop, hideDrop,
  };
}
