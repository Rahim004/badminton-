/**
 * pwa.js — установка «Волана» как приложения: service worker, событие beforeinstallprompt,
 * определение платформы и режима (уже установлено / внутри APK или exe).
 *
 * API: pwa.registerSW(), pwa.platform(), pwa.isInstalled(), pwa.inNativeApp(), pwa.canPrompt(),
 *      pwa.prompt() -> Promise<'accepted'|'dismissed'|'unavailable'>, pwa.onChange(cb) -> off()
 * Ничего не бросает: в песочнице (iframe без allow-same-origin), file://, старых браузерах всё молча выключено.
 */
import { VERSION } from './version.js';

/** Чистая функция (тестируется в node): ua, число касаний, платформа navigator. */
export function detectPlatform(ua = '', maxTouch = 0, navPlatform = '') {
  ua = String(ua);
  const ipadOs = /Macintosh/.test(ua) && maxTouch > 1;          // iPadOS 13+ выдаёт себя за Mac
  let os = 'other';
  if (/iPhone|iPad|iPod/.test(ua) || ipadOs) os = 'ios';
  else if (/Android/i.test(ua)) os = 'android';
  else if (/Windows/i.test(ua) || /^Win/i.test(navPlatform)) os = 'windows';
  else if (/Mac/i.test(ua) || /^Mac/i.test(navPlatform)) os = 'mac';
  else if (/Linux|X11|CrOS/i.test(ua)) os = 'linux';
  let browser = 'other';
  if (/YaBrowser/.test(ua)) browser = 'yandex';
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung';
  else if (/EdgA?\/|Edg\//.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'firefox';
  else if (/CriOS|Chrome\//.test(ua)) browser = 'chrome';
  else if (/Safari\//.test(ua)) browser = 'safari';
  return { os, browser, mobile: os === 'ios' || os === 'android', iosSafari: os === 'ios' && browser === 'safari' };
}

const listeners = new Set();
let deferred = null;
let installedFlag = false;
const emit = () => listeners.forEach(f => { try { f(); } catch (_) { /* слушатель не должен ломать остальных */ } });

function ua() { try { return navigator.userAgent || ''; } catch (_) { return ''; } }

export const pwa = {
  platform() {
    try { return detectPlatform(ua(), navigator.maxTouchPoints || 0, navigator.platform || ''); }
    catch (_) { return detectPlatform(''); }
  },
  /** Открыто внутри нашего APK / десктоп-приложения (они добавляют VolanApp в user agent). */
  inNativeApp() { return /VolanApp/.test(ua()); },
  /** Уже установлено как PWA (окно без адресной строки) или это нативное приложение. */
  isInstalled() {
    if (installedFlag || pwa.inNativeApp()) return true;
    try {
      if (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: minimal-ui)').matches) return true;
      if (navigator.standalone === true) return true;   // iOS «с экрана Домой»
    } catch (_) { /* нет matchMedia */ }
    return false;
  },
  /** Страница встроена в чужой iframe (чат-превью): установка и SW там недоступны. */
  inFrame() { try { return window.top !== window.self; } catch (_) { return true; } },
  canPrompt() { return !!deferred; },
  async prompt() {
    if (!deferred) return 'unavailable';
    const ev = deferred; deferred = null; emit();
    try {
      await ev.prompt();
      const r = await ev.userChoice;
      return r && r.outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch (_) { return 'unavailable'; }
  },
  onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  version: VERSION,

  /** Регистрация service worker; true — запрос на регистрацию отправлен. Тихо отказывается где нельзя. */
  registerSW() {
    try {
      if (!('serviceWorker' in navigator)) return Promise.resolve(false);
      if (!/^https?:$/.test(location.protocol)) return Promise.resolve(false);
      if (pwa.inNativeApp()) return Promise.resolve(false);   // файлы уже внутри приложения
      const url = new URL('../sw.js', import.meta.url);
      url.searchParams.set('v', VERSION);
      return navigator.serviceWorker.register(url.href).then(() => true, () => false);   // отказ (песочница) — не ошибка
    } catch (_) { return Promise.resolve(false); }
  },
};

try {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; emit(); });
  window.addEventListener('appinstalled', () => { installedFlag = true; deferred = null; emit(); });
  // Регистрируем после загрузки, чтобы не мешать первому запуску игры.
  const go = () => { pwa.registerSW(); };
  if (document.readyState === 'complete') setTimeout(go, 1500); else window.addEventListener('load', () => setTimeout(go, 1500));
} catch (_) { /* не браузер (тесты в node) */ }
