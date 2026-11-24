# Онлайн-режим «Волана» — контракт для двух агентов

Решение пользователя: **профиль + код друга, без серверных аккаунтов**. Онлайн должен работать между Россией и Таджикистаном (иногда через VPN), между любыми странами. Онлайн работает только на GitHub Pages (в артефакте-песочнице сеть закрыта — там показываем понятное сообщение «Онлайн-игра работает в версии на GitHub»).

Опыт из волейбола пользователя (рабочий, проверенный): `/tmp/claude-0/-home-claude/4dda28cc-df67-559e-9a69-a98b53e68b81/scratchpad/vg/volleyball/team/src/g_net.js` (+ `assets/mqtt.min.js`, `tools/*test*.js`):
хост-авторитетная модель, транспорт MQTT через несколько публичных брокеров по WSS (emqx, hivemq, eclipse, mosquitto, shiftr) с перебором, и апгрейд до прямого WebRTC (PeerJS), если получится; комнаты по 5-буквенному коду и ссылке `#room-XXXXX`; проверка версии протокола; плашка пинга.

## Разделение
- **Агент «Сеть»** владеет `src/net/*`, `vendor/*` (локальные копии библиотек — никаких CDN в рантайме), сетевыми хуками в `src/game.js`, `src/main.js`, `tests/net*`.
- **Агент «Профиль и лобби»** владеет `src/profile/*`, `src/ui/*`, `src/storage.js`, `src/ui.js`, `styles.css`, `index.html` (+ держит `play.html` в синхроне, он в .gitignore).

## API сети (реализует «Сеть», использует «Профиль и лобби»)
```js
import { createNet } from './net/index.js';
const net = createNet(game);           // game — объект из createGame()
net.available()                        // false в песочнице/без сети → UI показывает сообщение
net.host({ mode:'singles'|'doubles', format, difficulty, profile }) → Promise<{ code, link }>
net.join(code, { profile })            → Promise<{ ok, error? }>
net.leave()
net.on('status'|'peer'|'lobby'|'start'|'end'|'error'|'ping', cb)
//  lobby: { code, mode, slots:[{team, seat, profile|null, ai:bool, ready}] } — до 4 мест; пустые места в 2×2 занимает ИИ
net.setReady(bool); net.setSlot(team, seat); net.startMatch()   // startMatch — только хост
net.sendEmote(id)                      // быстрые реакции («Отлично!», «Ой!», 👍) — показываются над героем
net.info() → { role, code, connected, route:'p2p'|'server', ms }
```
`profile` = `{ id, nick, heroId, color, friendCode }` — всё, что видят другие игроки.

## API профиля (реализует «Профиль и лобби»)
```js
import { getProfile, saveProfile, addFriend, listFriends, recordMatch } from './profile/index.js';
```
- id — случайный, генерируется один раз; friendCode — 6 символов без путаемых букв, выводится из id.
- Друзья хранятся локально (ник, код, последний раз играли, счёт личных встреч). Добавление по коду друга или автоматически после онлайн-матча.
- Пригласить друга: «Создать комнату» → код + кнопка «Скопировать ссылку».
- Хранение в localStorage (try/catch), экспорт/импорт профиля кодом-строкой для переноса на другое устройство.
