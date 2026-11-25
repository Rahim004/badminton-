# Выкладка «Волана» на itch.io

Архив: `dist/itch.zip` (собрать: `node tools/build-portals.mjs itch`). Тексты — [LISTING.md](LISTING.md#itchio), картинки — `images/itch/`.

## 1. Регистрация

1. Откройте https://itch.io и нажмите **Register**. Нужны имя пользователя (станет адресом `имя.itch.io`), e-mail и пароль; подтвердите почту. Можно войти через Google, GitHub или Discord.
2. Платёжные данные для бесплатной игры не нужны.

## 2. Создание проекта

**Dashboard → Create new project** (https://itch.io/game/new). Названия полей могут слегка отличаться — смысл тот же.

| Поле | Что указать |
|---|---|
| Title | `Volan` |
| Project URL | `volan` (получится `ваше-имя.itch.io/volan`; если занято — `volan-badminton`) |
| Short description or tagline | `Anime-style badminton: play vs AI or online with friends` |
| Classification | **Games** |
| Kind of project | **HTML** (игра запускается прямо в браузере) |
| Release status | **Released** (или Prototype, если хотите скромнее) |
| Pricing | **No payments** (бесплатно; позже можно включить донаты — «$0 or donate») |
| Description | текст из [LISTING.md](LISTING.md#itchio) (Markdown) |
| Genre | **Sports** |
| Tags | `badminton, sports, anime, multiplayer, online-multiplayer, singleplayer, casual, arcade, mobile, short` (до 10) |
| Community | Comments — включите: так вы увидите отзывы |
| Cover image | `images/itch/cover-630x500.png` |
| Screenshots | `images/itch/screenshot-1…5` (до 3 МБ каждый) |

## 3. Загрузка игры

1. В блоке **Uploads** нажмите **Upload files** и выберите `dist/itch.zip`. `index.html` лежит в корне архива, как требует itch (только ZIP; пути относительные; файлов 53 при лимите 1000).
2. Отметьте галочку **This file will be played in the browser**.
3. Блок **Embed options** (появляется после отметки):
   * **Embed in page** с размером **1280 × 720** (игра подстраивается под любой размер, 16:9 смотрится лучше всего) — или **Click to launch in fullscreen**.
   * **Mobile friendly** — включить (на телефоне страница всегда запускается «по клику» во весь экран; игра адаптивная, портрет и альбом).
   * **Fullscreen button** — включить (itch нарисует её в правом нижнем углу).
   * **Automatically start on page load** — выключить: звук в браузере всё равно включается только после касания.
   * **Scrollbars** — выключить; **SharedArrayBuffer** — не нужен.
   * Если форма предлагает ориентацию — оставьте «по умолчанию» (игра работает в обеих).
4. Нажмите **Save**.

## 4. Проверка и публикация

1. В **Visibility & access** оставьте **Draft** и откройте **View page** — страница видна только вам. Сыграйте матч, проверьте звук (после первого касания), полноэкранную кнопку, телефон (откройте страницу на телефоне).
2. Онлайн внутри itch работает: игра во фрейме `itch.zone`. Ссылка-приглашение — адрес самого фрейма, он открывается и в отдельной вкладке; код комнаты (5 букв) тоже вводится вручную.
3. Если форма спросит о generative AI — ответьте по фактам (код и графика игры сделаны при участии ИИ-агентов).
4. Переключите **Visibility** на **Public** и нажмите **Save**.

## 5. Обновление

Соберите новый архив (`node tools/build-portals.mjs itch`), на странице проекта **Edit game → Uploads** загрузите новый `itch.zip` поверх старого (или удалите старый файл), снова отметьте «played in the browser».

## Что меняется на itch по сравнению с сайтом

* Экран «Скачать» (APK, exe, установка) и политика конфиденциальности остаются, ссылки открываются в новой вкладке.
* В настройках есть переключатель «Русский / English» (по умолчанию язык браузера).
* Service worker выключен (внутри фрейма на itch.zone он всё равно не работает).
