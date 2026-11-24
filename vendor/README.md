# vendor/

Локальные копии библиотек для онлайн-режима (никаких CDN во время игры).
Загружаются лениво (`src/net/libs.js`) только когда игрок выбрал онлайн.

| Файл | Версия | Откуда |
|---|---|---|
| `mqtt.min.js` | MQTT.js 4.x (browser bundle; в волейболе как запасной CDN был 4.3.7) | копия из проекта «№4 × №10» (`assets/mqtt.min.js`), там же проверена |
| `peerjs.min.js` | PeerJS 1.5.4 | `npm pack peerjs@1.5.4` → `dist/peerjs.min.js` (убрана ссылка на source map) |
| `peerjs.LICENSE` | MIT | из пакета peerjs |
