/* sw.js — офлайн-кэш «Волана». Версия берётся из ?v= в адресе воркера (регистрирует src/pwa.js,
   значение — src/version.js), поэтому при смене VERSION кэш меняется сам.
   Список файлов и хэш BUILD генерирует tools/gen-sw.mjs (проверяется тестом tests/pwa.test.mjs).
   Онлайн-игра (MQTT/WebRTC) идёт мимо воркера: перехватываем только GET своего origin. */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const BUILD = 'b6c12e69';   // хэш содержимого файлов (tools/gen-sw.mjs): любое изменение игры меняет байты sw.js, и браузер обновляет кэш
const CACHE = 'volan-' + VERSION + '-' + BUILD;
const FILES = /*FILES*/ [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./src/ai.js",
  "./src/audio/bank.js",
  "./src/audio/dsp.js",
  "./src/audio.js",
  "./src/config.js",
  "./src/controlsOverlay.js",
  "./src/controlsSettings.js",
  "./src/game.js",
  "./src/input.js",
  "./src/main.js",
  "./src/net/codec.js",
  "./src/net/debug.js",
  "./src/net/guest.js",
  "./src/net/host.js",
  "./src/net/index.js",
  "./src/net/libs.js",
  "./src/net/shuttleline.js",
  "./src/net/timing.js",
  "./src/net/transport.js",
  "./src/physics.js",
  "./src/player.js",
  "./src/profile/index.js",
  "./src/pwa.js",
  "./src/render/arena.js",
  "./src/render/character.js",
  "./src/render/characters/head.js",
  "./src/render/characters/looks.js",
  "./src/render/characters/paint.js",
  "./src/render/effects.js",
  "./src/render/skeleton.js",
  "./src/render.js",
  "./src/rules.js",
  "./src/shots.js",
  "./src/storage.js",
  "./src/ui/dom.js",
  "./src/ui/download.js",
  "./src/ui/heroes.js",
  "./src/ui/netMock.js",
  "./src/ui/online.js",
  "./src/ui/portrait.js",
  "./src/ui/profileScreens.js",
  "./src/ui.js",
  "./src/version.js",
  "./fonts/unbounded-cyrillic.woff2",
  "./fonts/unbounded-latin.woff2",
  "./vendor/mqtt.min.js",
  "./vendor/peerjs.min.js",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
] /*END*/;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' — мимо HTTP-кэша, чтобы в офлайн-кэш не попали устаревшие копии.
    await Promise.all(FILES.map(async f => {
      const res = await fetch(new Request(f, { cache: 'reload' }));
      if (!res.ok) throw new Error('precache ' + f + ' ' + res.status);
      await cache.put(f === './' ? new Request('./') : f, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('volan-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Страница (в т.ч. index.html#room-… и ?параметры) — всегда из кэша: игра самодостаточна.
    if (req.mode === 'navigate') {
      const hit = await cache.match('./index.html');
      if (hit) return hit;
      return fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(req); }
    catch (err) { return Response.error(); }
  })());
});
