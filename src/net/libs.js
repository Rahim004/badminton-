/**
 * net/libs.js — ленивая загрузка локальных библиотек из vendor/ (только когда выбран онлайн).
 * Никаких CDN: файлы лежат рядом с игрой (работает и на GitHub Pages из подпапки).
 */
const URLS = {
  mqtt: new URL('../../vendor/mqtt.min.js', import.meta.url).href,
  peerjs: new URL('../../vendor/peerjs.min.js', import.meta.url).href,
};
const READY = {
  mqtt: () => !!(globalThis.mqtt && globalThis.mqtt.connect),
  peerjs: () => !!globalThis.Peer,
};
const loading = {};

/** → Promise<boolean>; не бросает исключений. */
export function loadLib(name, timeoutMs = 12000) {
  try {
    if (READY[name]()) return Promise.resolve(true);
    if (loading[name]) return loading[name];
    loading[name] = new Promise(res => {
      let done = false;
      const fin = ok => { if (done) return; done = true; clearTimeout(to); if (!ok) loading[name] = null; res(ok && READY[name]()); };
      const to = setTimeout(() => fin(false), timeoutMs);
      try {
        const sc = document.createElement('script');
        sc.src = URLS[name]; sc.async = true;
        sc.onload = () => fin(true); sc.onerror = () => { try { sc.remove(); } catch (_) {} fin(false); };
        document.head.appendChild(sc);
      } catch (_) { fin(false); }
    });
    return loading[name];
  } catch (_) { return Promise.resolve(false); }
}
