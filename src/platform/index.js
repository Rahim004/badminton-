/**
 * platform/index.js — адаптер площадок. Остальной код игры не знает про SDK порталов, а зовёт только это:
 *
 *   platform.id               'web' | 'itch' | 'yandex' | 'crazygames' (window.VOLAN_PLATFORM, вписывает tools/build-portals.mjs)
 *   platform.portal           true на любой площадке, кроме обычного сайта
 *   await platform.init()     один раз при старте: подключает SDK (с таймаутом), определяет язык; не бросает исключений
 *   platform.lang()           'ru' | 'en'
 *   platform.ready()          игра загружена, игрок может начать (Яндекс LoadingAPI.ready, CrazyGames loadingStop) — один раз
 *   platform.gameplay(bool)   идёт ли сейчас сам матч (GameplayAPI.start/stop, gameplayStart/Stop); повторы отфильтрованы
 *   platform.onPause(cb) / onResume(cb)   паузу/возобновление присылает SDK площадки (Яндекс: game_api_pause/resume)
 *   platform.canLinkOut()     можно ли показывать внешние ссылки (GitHub, скачивание, политика) — false на Яндексе и CrazyGames
 *   platform.swAllowed()      регистрировать ли service worker (только обычный сайт)
 *   platform.framedNetOk()    онлайн разрешён внутри iframe (порталы всегда играют во фрейме)
 *   platform.onlineOk()       false в сборке --no-online: нет кнопки «Играть с друзьями» и вообще сетевого кода
 *   platform.roomLink(code)   ссылка-приглашение: строка, null (ссылки нет — только код комнаты) или undefined (по умолчанию)
 *   platform.roomUpdate(code, joinable) / roomLeft()   сообщить площадке о комнате (CrazyGames: друзья, приглашения)
 *   platform.inviteRoom()     код комнаты из приглашения площадки или null;  platform.onJoinRoom(cb) — вход по приглашению в игре
 *   platform.instantMultiplayer()   CrazyGames: игра открыта сразу в «играть с друзьями»
 *   platform.langSwitch() / setLangPref(l)   ручной выбор языка (только itch.io)
 *
 * Модуль безопасен в node (тесты): без window ведёт себя как 'web'.
 */
import { setLang } from './i18n.js';
import { loadJSON, saveJSON } from '../storage.js';

const G = globalThis;
const ID = (() => { const v = G.VOLAN_PLATFORM; return v === 'itch' || v === 'yandex' || v === 'crazygames' ? v : 'web'; })();
const LANG_KEY = 'volan.lang';
/** Языки, для которых показываем русский (СНГ); остальные — английский. */
const RU_LIKE = ['ru', 'be', 'kk', 'ky', 'uk', 'uz', 'tg', 'tt', 'tk', 'az', 'hy'];

const pauseCbs = new Set(), resumeCbs = new Set(), joinCbs = new Set();
const call = (set) => { for (const f of [...set]) { try { f(); } catch (e) { console.error(e); } } };
let lang = 'ru';
let readyDone = false, playing = false, initDone = null;
let ysdk = null, cg = null;       // объекты SDK (null — SDK недоступен: играем без вызовов)

function langFromTag(tag) {
  const l = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return RU_LIKE.includes(l) ? 'ru' : 'en';
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
const safe = (fn) => { try { return fn(); } catch (e) { console.warn('[platform]', e && e.message); return undefined; } };

function blockPageScroll() {
  // Пробел и стрелки не должны прокручивать страницу портала вокруг игры.
  G.addEventListener('keydown', e => {
    if (!/^(?: |ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(e.key)) return;
    const tg = e.target && e.target.tagName;
    if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT') return;
    if (tg === 'BUTTON' && e.key === ' ') return;   // пробел на кнопке — это её нажатие
    e.preventDefault();
  }, { passive: false });
}

async function initYandex() {
  if (!G.YaGames || !G.YaGames.init) return;
  ysdk = await withTimeout(G.YaGames.init(), 6000);
  safe(() => { lang = langFromTag(ysdk.environment.i18n.lang); });
  safe(() => ysdk.on('game_api_pause', () => call(pauseCbs)));
  safe(() => ysdk.on('game_api_resume', () => call(resumeCbs)));
}

async function initCrazy() {
  const S = G.CrazyGames && G.CrazyGames.SDK;
  if (!S) return;
  await withTimeout(S.init(), 6000);
  if (S.environment === 'disabled') return;   // чужой домен: SDK бросает ошибки при вызове
  cg = S;
  safe(() => cg.game.loadingStart());
  safe(() => { const loc = cg.user && cg.user.systemInfo && cg.user.systemInfo.locale; if (loc) lang = langFromTag(loc); });
}

export const platform = {
  id: ID,
  portal: ID !== 'web',

  init() {
    if (initDone) return initDone;
    initDone = (async () => {
      if (ID === 'web') { lang = 'ru'; setLang('ru'); return; }
      // язык по умолчанию — по браузеру (на случай, если SDK недоступен)
      safe(() => { lang = langFromTag(navigator.language || (navigator.languages || [])[0]); });
      try {
        if (ID === 'yandex') await initYandex();
        else if (ID === 'crazygames') await initCrazy();
      } catch (e) { console.warn('[platform] SDK не поднялся, играем без него:', e && e.message); }
      if (ID === 'itch') { const pref = loadJSON(LANG_KEY, null); if (pref === 'ru' || pref === 'en') lang = pref; }
      setLang(lang);
      safe(() => { if (lang === 'en') document.title = 'Volan — badminton'; });
      blockPageScroll();
    })();
    return initDone;
  },

  lang() { return lang; },
  langSwitch() { return ID === 'itch'; },
  setLangPref(l) { saveJSON(LANG_KEY, l === 'en' ? 'en' : 'ru'); try { location.reload(); } catch (_) { /* */ } },

  ready() {
    if (readyDone) return; readyDone = true;
    if (ysdk) safe(() => ysdk.features.LoadingAPI && ysdk.features.LoadingAPI.ready());
    if (cg) safe(() => cg.game.loadingStop());
  },
  gameplay(on) {
    on = !!on;
    if (on === playing) return; playing = on;
    if (ysdk) safe(() => { const api = ysdk.features.GameplayAPI; if (api) on ? api.start() : api.stop(); });
    if (cg) safe(() => (on ? cg.game.gameplayStart() : cg.game.gameplayStop()));
  },
  onPause(cb) { pauseCbs.add(cb); return () => pauseCbs.delete(cb); },
  onResume(cb) { resumeCbs.add(cb); return () => resumeCbs.delete(cb); },

  canLinkOut() { return ID === 'web' || ID === 'itch'; },
  swAllowed() { return ID === 'web'; },
  framedNetOk() { return ID !== 'web'; },
  /** Сборка без онлайна (tools/build-portals.mjs --no-online): запасной вариант на случай претензий модерации к внешним серверам. */
  onlineOk() { return !G.VOLAN_NO_ONLINE; },

  roomLink(code) {
    if (ID === 'yandex') return null;        // ссылку на страницу игры в Яндекс Играх заранее не узнать — только код
    if (ID === 'crazygames') {
      if (!cg) return null;
      const link = safe(() => cg.game.inviteLink({ roomId: code }));
      return typeof link === 'string' && link ? link : null;
    }
    return undefined;
  },
  roomUpdate(code, joinable) { if (cg && code) safe(() => cg.game.updateRoom({ roomId: code, isJoinable: !!joinable, inviteParams: { roomId: code } })); },
  roomLeft() { if (cg) safe(() => cg.game.leftRoom()); },
  inviteRoom() {
    if (!cg) return null;
    const v = safe(() => cg.game.getInviteParam('roomId'));
    return typeof v === 'string' && /^[A-Za-z]{5}$/.test(v) ? v.toUpperCase() : null;
  },
  onJoinRoom(cb) {
    if (!cg) return () => {};
    const f = (params) => { const v = params && params.roomId; if (typeof v === 'string' && /^[A-Za-z]{5}$/.test(v)) cb(v.toUpperCase()); };
    safe(() => cg.game.addJoinRoomListener(f));
    return () => safe(() => cg.game.removeJoinRoomListener(f));
  },
  instantMultiplayer() { return !!(cg && safe(() => cg.game.isInstantMultiplayer)); },
};

try { G.__platform = platform; } catch (_) { /* */ }
