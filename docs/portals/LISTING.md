# Тексты для карточек игры «Волан» на порталах

Все тексты можно копировать как есть. Лимиты проверены скриптом (длина в символах указана в скобках). Для Яндекс Игр лимиты взяты из формы черновика (документация на 2026-11-25), для остальных площадок жёстких лимитов в документации нет — тексты короткие. Те же тексты в машинном виде: `listing.json`.

Названия: в игре логотип «Волан» (по-русски) и «Volan» (по-английски), поэтому в карточках название начинается так же. Если «Волан: бадминтон» занят в каталоге Яндекс Игр (названия там уникальны), добавьте уточнение: «Волан: бадминтон 2×2».

## Яндекс Игры

Языки в карточке: **русский и английский** (модерация проверяет, что игра поддерживает все выбранные языки).

### Русский

**Название** (16, лимит ≤50):

```
Волан: бадминтон
```

**Краткое описание** (54, лимит ≤70):

```
Бадминтон в аниме-стиле: против ИИ и онлайн с друзьями
```

**SEO-описание** (121, лимит 50–160):

```
Играйте в бадминтон онлайн: матчи 1×1 и 2×2 против ИИ, мультиплеер с друзьями по коду комнаты, правила BWF, шесть героев.
```

**Об игре** (612, лимит 100–1000):

```
Волан — бадминтон в аниме-стиле по официальным правилам BWF. Играйте один на один или в паре с ИИ-напарником, выбирайте одного из шести героев и сложность — от «Новичка» до «Легенды».

Волан летит по «парашютной» физике: после смэша быстро теряет скорость и плавно опускается, поэтому важно читать траекторию и успевать под него. Клир, смэш, дроп и подставка у сетки — четыре удара под палец, а точный тайминг даёт удар «Идеально!».

Позовите друга: создайте комнату, назовите код — и играйте онлайн 1×1 или 2×2. Против ИИ можно играть и без интернета. Регистрация не нужна, профиль хранится на вашем устройстве.
```

**Как играть** (610, лимит 100–1000):

```
Компьютер: бег — WASD или стрелки, удар — пробел, клир — J, смэш или дроп — K, подставка у сетки — L, пауза — Esc. На подаче пробел — короткая, J — длинная.

Телефон: слева появляется джойстик там, где коснулись пальцем, справа — кнопки «Удар», «Клир», «Смэш/Дроп» и «Сетка». В настройках можно включить управление свайпами, режим левши и силу автобега.

Смотрите на кольцо вокруг волана: когда оно совпало с внутренним, нажимайте удар — получится «Идеально!». Чтобы сыграть с другом, выберите «Играть с друзьями» → «Создать комнату» и назовите ему пятибуквенный код, друг введёт его в разделе «Комната друга».
```

**Ключевые слова (строчные, через запятую)** (69, лимит ≤100):

```
бадминтон, волан, спорт, ракетка, онлайн, с друзьями, на двоих, аниме
```

**Теги (до 20):** бадминтон, спорт, мультиплеер, на двоих, против ИИ, аниме, ракетка, онлайн, с друзьями, 2D, аркада, без регистрации

### English

**Title** (16, limit ≤50):

```
Volan: Badminton
```

**Short description** (52, limit ≤70):

```
Anime-style badminton: vs AI and online with friends
```

**SEO description** (135, limit 50–160):

```
Play badminton online: 1v1 and 2v2 matches against the AI, multiplayer with friends by room code, BWF rules, six heroes to choose from.
```

**About the game** (593, limit 100–1000):

```
Volan is anime-style badminton with official BWF rules. Play singles or doubles with an AI partner, pick one of six heroes and a difficulty from Beginner to Legend.

The shuttle follows "parachute" physics: it slows down fast after a smash and floats down, so reading its flight and getting under it matters. Clear, smash, drop and net shot are four shots under your thumb, and good timing gives you a "Perfect!" hit.

Invite a friend: create a room, share the code and play online 1v1 or 2v2. Matches against the AI also work offline. No sign-up needed, your profile is stored on your device.
```

**How to play** (623, limit 100–1000):

```
Computer: move with WASD or arrows, hit with Space, clear with J, smash or drop with K, net shot with L, pause with Esc. When serving, Space is a short serve and J is a long one.

Phone: a joystick appears on the left where you touch, shot buttons Hit, Clear, Smash/Drop and Net are on the right. In Settings you can switch to swipe controls, left-handed mode and tune auto-run.

Watch the ring around the shuttle: when it meets the inner ring, hit - you get a "Perfect!" shot. To play with a friend choose Play with friends, then Create room, and tell your friend the five-letter code; they enter it under "Friend's room".
```

**Keywords (lowercase, comma-separated)** (79, limit ≤100):

```
badminton, shuttlecock, sports, racket, online, multiplayer, two players, anime
```

**Комментарий разработчика для модераторов** (до 2048 символов, видят только модераторы):

```
Игра — бадминтон «Волан». Полностью играбельна против ИИ без сети. Режим «Играть с друзьями» — необязательный: игроки соединяются по пятибуквенному коду комнаты через публичные MQTT-серверы (WSS) и напрямую через WebRTC; передаются только ник, выбранный герой и игровые действия. Никаких внешних ссылок, рекламы и регистрации в игре нет. SDK подключён: LoadingAPI.ready после загрузки меню, GameplayAPI.start/stop вокруг матча, game_api_pause/game_api_resume ставят игру на паузу и глушат звук; звук также останавливается при потере фокуса. Язык берётся из ysdk.environment.i18n.lang (ru/en). Если онлайн-режим недопустим — напишите, мы пришлём сборку без него.
```

## CrazyGames

Английский обязателен; русский — как дополнительный язык.

### English

**Title** (16):

```
Volan: Badminton
```

**Tagline** (63):

```
Anime-style badminton: beat the AI or play online with friends.
```

**Description** (558):

```
Volan is anime-style badminton with official BWF rules. Play singles or doubles with an AI partner, pick one of six heroes and a difficulty from Beginner to Legend.

The shuttle follows "parachute" physics: it slows down fast after a smash and floats down, so reading its flight and getting under it matters. Clear, smash, drop and net shot are four shots under your thumb; hit when the timing ring closes for a "Perfect!" shot.

Create a room and invite a friend through CrazyGames to play 1v1 or 2v2 online. Matches against the AI work without any sign-up.
```

**Instructions / controls** (409):

```
Computer: move - WASD or arrow keys. Hit - Space or Shift. Clear - J or Z. Smash / drop - K or X. Net shot - L or C. Pause - Esc. Serve: Space for a short serve, J for a long one.
Phone and tablet: use the floating joystick on the left and the shot buttons on the right (swipe controls are available in Settings).
Online: Play with friends -> Create room, then invite a friend with the CrazyGames invite link.
```

### Русский (дополнительный язык)

**Название** (16):

```
Волан: бадминтон
```

**Краткое описание** (55):

```
Бадминтон в аниме-стиле: против ИИ и онлайн с друзьями.
```

**Описание** (525):

```
Волан — бадминтон в аниме-стиле по официальным правилам BWF. Играйте один на один или вдвоём с ИИ-напарником, выбирайте одного из шести героев и сложность от «Новичка» до «Легенды».

Волан летит по «парашютной» физике: после смэша быстро теряет скорость и плавно опускается. Клир, смэш, дроп и подставка у сетки — четыре удара под палец; нажмите, когда кольцо тайминга сойдётся, — получится «Идеально!».

Создайте комнату и позовите друга через CrazyGames — играйте онлайн 1×1 или 2×2. Против ИИ можно играть без регистрации.
```

**Как играть и управление** (365):

```
Компьютер: бег — WASD или стрелки; удар — пробел или Shift; клир — J или Z; смэш/дроп — K или X; подставка — L или C; пауза — Esc. Подача: пробел — короткая, J — длинная.
Телефон и планшет: плавающий джойстик слева и кнопки ударов справа (свайпы — в настройках).
Онлайн: «Играть с друзьями» → «Создать комнату», затем позовите друга ссылкой-приглашением CrazyGames.
```

**Теги:** badminton, sports, multiplayer, anime, 2 player, racket, online, ai, casual, mobile

## itch.io

**Title:** `Volan`

**Short description / tagline** (56): `Anime-style badminton: play vs AI or online with friends`

**Genre:** Sports

**Tags (до 10):** badminton, sports, anime, multiplayer, online-multiplayer, singleplayer, casual, arcade, mobile, short

**Description** (Markdown, English):

```
**Volan** is anime-style badminton that runs right in your browser - on desktop and on your phone.

* Official BWF rules: diagonal serves, games to 21 with a 2-point lead, faults, net, change of ends.
* "Parachute" shuttle physics: light, slows fast after a smash, so reading the flight matters.
* Time your swing: when the ring around the shuttle meets the inner one you get a **Perfect!** hit. Clear, smash, drop and net shot.
* Singles (1v1) and doubles (2v2 with an AI partner), four AI levels from Beginner to Legend, three match formats.
* Online with friends: create a room, send the link or the 5-letter code, play 1v1 or 2v2. Matches against the AI work offline.
* Six heroes, nickname, stats, friend code. No account, no ads, no tracking - the profile lives in your browser.

**Controls**

* Keyboard: WASD / arrows - move, Space - hit, J - clear, K - smash or drop, L - net, Esc - pause.
* Touch: floating joystick on the left, shot buttons on the right (swipe controls in Settings).

*Online mode uses public relay servers and direct WebRTC connections; only your nickname, hero and game inputs are sent to the other players in the room.*

Interface languages: Russian and English. The game is also available as an installable web app, an Android APK and a Windows/Linux build - see the "Download" screen in the game menu.
```

Дополнительно для русскоязычной аудитории можно добавить в начало описания абзац:

```
**Волан** — бадминтон в аниме-стиле прямо в браузере, на компьютере и на телефоне. Правила BWF, «парашютная» физика волана, удары «Идеально!» по таймингу, против ИИ и онлайн с друзьями (1×1 и 2×2). Без регистрации и рекламы. Интерфейс на русском и английском.
```
