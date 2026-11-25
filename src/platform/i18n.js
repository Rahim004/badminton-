/**
 * platform/i18n.js — лёгкий слой перевода интерфейса для порталов (Яндекс Игры, CrazyGames, itch.io).
 * Исходные тексты игры русские; при lang === 'ru' этот модуль ничего не делает (обычная веб-версия не меняется).
 * При lang === 'en':
 *   t(ru)         — перевод строки (точное совпадение, затем правила-регулярки, иначе исходная строка) — для canvas;
 *   watchDom(el)  — переводит текстовые узлы и aria-label/placeholder/title внутри el и следит за изменениями.
 * Непереведённая строка остаётся русской (не ломает игру).
 */
const CYR = /[А-Яа-яЁё]/;
let LANG = 'ru';
const cache = new Map();

export function getLang() { return LANG; }
export function setLang(l) {
  const next = l === 'en' ? 'en' : 'ru';
  if (next !== LANG) { LANG = next; cache.clear(); }
  try { document.documentElement.lang = LANG; } catch (_) { /* нет document */ }
}

const D = {
  // ---- меню
  'Волан': 'Volan',
  'Волан — бадминтон': 'Volan — badminton',
  'Бадминтон: против ИИ и с друзьями по ссылке': 'Badminton: vs AI and with friends online',
  'Бадминтон: против ИИ и с друзьями': 'Badminton: vs AI and with friends online',
  'Бадминтон: против ИИ, 1 × 1 и 2 × 2': 'Badminton vs AI, 1 × 1 and 2 × 2',
  'Главное меню': 'Main menu',
  'Играть с ИИ': 'Play vs AI',
  'Режим и сложность': 'Mode and difficulty',
  'Играть с друзьями': 'Play with friends',
  'онлайн, 1 × 1 и 2 × 2': 'online, 1 × 1 and 2 × 2',
  'Профиль': 'Profile',
  'Настройки': 'Settings',
  'Создать профиль': 'Create profile',
  'ник, герой, код друга': 'nickname, hero, friend code',
  'Скачать игру': 'Download the game',
  'Скачать': 'Download',
  'Корт': 'Court',
  // ---- игра с ИИ
  'Игра с ИИ': 'Game vs AI',
  'Режим': 'Mode',
  'Сложность': 'Difficulty',
  'Матч': 'Match',
  '2 × 2, с ИИ-напарником': '2 × 2, with an AI partner',
  'Автобег и подсказка приземления': 'Auto-run and landing hint',
  'Играть': 'Play',
  'Ваш герой': 'Your hero',
  'Сменить': 'Change',
  'Выбрать': 'Choose',
  'Новичок': 'Beginner', 'Любитель': 'Amateur', 'Профи': 'Pro', 'Легенда': 'Legend',
  '1 гейм до 21': '1 game to 21', '1 гейм до 11': '1 game to 11', '3 гейма до 21': '3 games to 21',
  'до 21': 'to 21', 'до 11': 'to 11',
  // ---- настройки
  'Звук': 'Sound', 'Вкл': 'On', 'Выкл': 'Off', 'Громкость': 'Volume', 'Эффекты': 'Effects', 'Все': 'All', 'Меньше': 'Fewer',
  'Управление': 'Controls', 'Удары': 'Shots', 'Кнопки': 'Buttons', 'Свайпы': 'Swipes', 'Автобег': 'Auto-run',
  'Лёгкий': 'Light', 'Сильный': 'Strong', 'Левша': 'Left-handed', 'Нет': 'No', 'Да': 'Yes', 'Вибрация': 'Vibration',
  'Сейчас авто: на «Новичке» сильный, иначе лёгкий': 'Auto for now: strong on Beginner, light otherwise',
  'Слева — джойстик, справа — кнопки «Удар», «Клир», «Смэш/Дроп», «Сетка». Свайпы включаются в разделе «Управление».':
    'Joystick on the left, shot buttons on the right: Hit, Clear, Smash/Drop, Net. Swipes can be enabled in “Controls”.',
  'WASD или стрелки — бег, пробел — удар, J — клир, K — смэш или дроп, L — сетка, Esc — пауза.':
    'WASD or arrows — move, Space — hit, J — clear, K — smash or drop, L — net, Esc — pause.',
  'Язык / Language': 'Language / Язык',
  // ---- пауза и итоги
  'Пауза': 'Paused', 'Продолжить': 'Resume', 'Заново': 'Restart', 'В меню': 'To menu',
  'Онлайн-матч на паузу не встаёт — соперник продолжает видеть игру.': 'An online match cannot be paused — your opponent keeps playing.',
  'Победа!': 'Victory!', 'Поражение': 'Defeat', 'Ещё матч': 'Play again',
  'Подача: пробел — короткая, J — длинная (влево/вправо — направление)': 'Serve: Space — short, J — long (left/right — direction)',
  'Подача: тап — короткая, свайп вверх — длинная': 'Serve: tap — short, swipe up — long',
  'Пауза: хост свернул игру': 'Paused: the host left the game window',
  'короткая': 'short', 'длинная': 'long',
  // ---- кнопки на корте
  'Удар': 'Hit', 'Клир': 'Clear', 'Смэш': 'Smash', 'Дроп': 'Drop', 'Смэш/Дроп': 'Smash/Drop', 'Сетка': 'Net', 'Смэш/': 'Smash/',
  'бег': 'move', 'удар': 'hit', 'клир': 'clear', 'смэш/дроп': 'smash/drop', 'сетка': 'net', 'пауза': 'pause',
  'Пробел / Shift': 'Space / Shift',
  // ---- профиль
  'Назад': 'Back', 'Ник': 'Nickname', 'Герой': 'Hero', 'Цвет формы': 'Kit colour', 'Сохранить': 'Save',
  'Например, Рахим': 'E.g. Alex', 'Введите ник — его увидят друзья': 'Enter a nickname — your friends will see it',
  'Профиль сохранён': 'Profile saved', 'Кто ты на корте?': 'Who are you on court?', 'Изменить профиль': 'Edit profile',
  'Готово, дальше': 'Done, continue', 'Ваш код друга': 'Your friend code', 'Скопировать код': 'Copy code', 'Код скопирован': 'Code copied',
  'Не удалось скопировать — перепишите код вручную': 'Could not copy — please write the code down',
  'Друг вводит этот код в разделе «Друзья». После онлайн-матча вы добавитесь друг другу сами.': 'Your friend enters this code in “Friends”. After an online match you are added to each other automatically.',
  'Изменить': 'Edit', 'матч': 'match', 'матча': 'matches', 'матчей': 'matches', 'победа': 'win', 'победы': 'wins', 'побед': 'wins',
  'смэш': 'smash', 'смэша': 'smashes', 'смэшей': 'smashes', 'удар': 'hit', 'удара': 'hits', 'ударов': 'hits',
  'ударов в самом длинном розыгрыше': 'hits in the longest rally', 'удар в самом длинном розыгрыше': 'hit in the longest rally', 'удара в самом длинном розыгрыше': 'hits in the longest rally',
  'Друзья': 'Friends', 'Перенести': 'Transfer', 'на другое устройство': 'to another device', 'Добавить': 'Add', 'Удалить?': 'Delete?',
  'Друзей пока нет. Добавьте по коду — или сыграйте онлайн, и соперник добавится сам.': 'No friends yet. Add one by code — or play online and your opponent is added automatically.',
  'Код друга': 'Friend code', 'Код': 'Code',
  'ник появится после первой игры': 'nickname will appear after your first game', 'встречи': 'games', 'не играли': 'not played yet',
  'Личные встречи: ваши победы — его победы': 'Head to head: your wins — their wins',
  'Этот друг уже в списке': 'This friend is already in the list',
  'Перенос профиля': 'Transfer profile', 'Забрать на другое устройство': 'Take to another device',
  'Скопируйте код и откройте его на новом телефоне или компьютере. В коде — ник, герой, статистика и друзья.': 'Copy the code and paste it on your new phone or computer. It holds your nickname, hero, stats and friends.',
  'Загрузить на это устройство': 'Load onto this device', 'Профиль на этом устройстве заменится загруженным.': 'The profile on this device will be replaced.',
  'Загрузить профиль': 'Load profile', 'Вставьте код VOLAN1.… с другого устройства': 'Paste the VOLAN1.… code from another device',
  'Код профиля': 'Profile code', 'Код профиля для загрузки': 'Profile code to load', 'Код профиля скопирован': 'Profile code copied',
  'Скопировать код профиля': 'Copy profile code',
  'Политика конфиденциальности': 'Privacy policy',
  'Игрок': 'Player', 'Друг': 'Friend', 'Хост': 'Host', 'Гость': 'Guest',
  'Код друга — 6 символов: буквы и цифры, например 7KQ4MX': 'A friend code is 6 characters: letters and digits, e.g. 7KQ4MX',
  'Это ваш собственный код': 'This is your own code', 'В коде нет профиля': 'No profile in this code',
  'Код обрезан — скопируйте его целиком': 'The code is cut off — copy all of it',
  'Код повреждён — скопируйте его целиком ещё раз': 'The code is damaged — copy it again in full',
  'Это не код профиля «Волана»: он начинается с VOLAN1.': 'This is not a Volan profile code: it starts with VOLAN1.',
  'Янтарь': 'Amber', 'Небо': 'Sky', 'Малина': 'Raspberry', 'Лаванда': 'Lavender', 'Пламя': 'Flame', 'Белая': 'White', 'Ночь': 'Night',
  // ---- герои
  'Скорость': 'Speed', 'Сила': 'Power', 'Контроль': 'Control', 'Выносливость': 'Stamina',
  'Тимур Ахмедов': 'Timur Akhmedov', 'Кай Сора': 'Kai Sora', 'Мира Тан': 'Mira Tan', 'Лео Варг': 'Leo Varg', 'Айя Рен': 'Aya Ren', 'Нико Блейз': 'Niko Blaze',
  'Тимур': 'Timur', 'Кай': 'Kai', 'Мира': 'Mira', 'Лео': 'Leo', 'Айя': 'Aya', 'Нико': 'Niko',
  'Универсал': 'All-rounder', 'Сеточник': 'Net player', 'Атака': 'Attacker', 'Защита': 'Defender', 'Хитрость': 'Trickster', 'Непредсказуемый': 'Wildcard',
  'Вырос в школьном спортзале Казани, где сетку натягивали между шведскими стенками. Играет ровно в любой фазе розыгрыша и не любит отдавать подачу.': 'Grew up in a school gym in Kazan where the net was strung between wall bars. Steady in every phase of a rally and hates giving up the serve.',
  'Бывший юниор по настольному теннису — отсюда реакция и мелкий шаг. На сетке ловит волан раньше, чем соперник поймёт, куда сыграл.': 'A former junior table tennis player — hence the reflexes and quick feet. At the net he gets to the shuttle before his opponent knows where it went.',
  'Пришла из волейбола и принесла с собой прыжок. Её смэш с задней линии — самый быстрый в лиге, а замах почти не читается.': 'Came from volleyball and brought her jump. Her smash from the back line is the fastest in the league, and the swing is hard to read.',
  'Северянин из Мурманска, тренировался на длинных розыгрышах до сотни ударов. Поднимает любой смэш и ждёт, пока ошибётся соперник.': 'A northerner from Murmansk who trained on rallies of a hundred shots. Returns any smash and waits for the opponent to slip.',
  'Играет как шахматист: показывает клир — кладёт укороченный за сетку. Соперники говорят, что её ракетка «врёт».': 'Plays like a chess player: shows a clear — and drops it just over the net. Opponents say her racket “lies”.',
  'Уличный игрок с набережной, учился по видео и чутью. Может выиграть розыгрыш невозможным ударом и тут же отдать очко в аут.': 'A street player from the embankment who learned from videos and instinct. Can win a rally with an impossible shot and give the point away with an out the next second.',
  'Кросс-клир в угол': 'Cross-court clear to the corner', 'Подставка с переката': 'Rolling net lift', 'Смэш в прыжке': 'Jump smash',
  'Приём смэша в выпаде': 'Lunging smash return', 'Обманный укороченный': 'Deceptive drop', 'Драйв из-за спины': 'Behind-the-back drive',
  'Быстрый сеточник: успевает к любому волану у сетки.': 'Fast net player: gets to every shuttle at the net.', 'Её смэш слышно на трибунах.': 'You can hear her smash in the stands.',
  'Стена: возвращает всё.': 'A wall: returns everything.', 'Универсал без слабых мест.': 'An all-rounder with no weak spots.',
  // ---- онлайн
  'Играть с друзьями ': 'Play with friends', 'Новая комната': 'New room', 'Формат': 'Format', 'ИИ на свободных местах': 'AI on empty seats',
  'Создать комнату': 'Create room', 'Войти': 'Join', 'Комната друга': "Friend's room", 'Загружаем онлайн…': 'Loading online…',
  'Введите 5 букв, которые прислал друг, или просто откройте его ссылку.': 'Enter the 5 letters your friend sent you.',
  'Введите код из 5 букв, который прислал друг.': 'Enter the 5-letter code your friend sent you.',
  'Код комнаты — 5 букв, например KTQMX': 'A room code is 5 letters, e.g. KTQMX', 'Код комнаты': 'Room code', 'Комната': 'Room',
  'Создаём комнату…': 'Creating room…', 'Входим…': 'Joining…', 'Скопировать ссылку': 'Copy link', 'Отправить': 'Share', 'Ссылка на комнату': 'Room link',
  'Отправьте ссылку в Telegram или WhatsApp — по ней друг сразу попадёт в комнату.': 'Send the link to your friend — it takes them straight into the room.',
  'Сообщите другу код комнаты — он вводит его в разделе «Играть с друзьями».': 'Tell your friend the room code — they enter it under “Play with friends”.',
  'Ссылка скопирована — отправьте её другу': 'Link copied — send it to your friend', 'Ссылка выделена — скопируйте её вручную': 'Link selected — copy it manually',
  'Код комнаты скопирован — назовите его другу': 'Room code copied — tell it to your friend',
  'Готов': 'Ready', 'Готов — ждём начала': 'Ready — waiting for the start', 'Не готов': 'Not ready', 'Хозяин': 'Host', 'Начать': 'Start', 'Начинаем…': 'Starting…',
  '(вы)': '(you)', ' (вы)': ' (you)', 'ИИ': 'AI', 'Свободно': 'Free', 'Свободное место': 'Free seat', 'Ждём друга': 'Waiting for a friend', 'Друг или ИИ': 'Friend or AI',
  'Сесть сюда': 'Sit here', 'Ваша команда': 'Your team', 'Соперники': 'Opponents', 'Команда 1': 'Team 1', 'Команда 2': 'Team 2',
  'Подключаемся к комнате…': 'Connecting to the room…', 'Ждём друга. Отправьте ему ссылку или код.': 'Waiting for a friend. Send them the link or code.',
  'Ждём друга. Назовите ему код комнаты.': 'Waiting for a friend. Tell them the room code.',
  'Все готовы — жмите «Начать».': 'Everyone is ready — press “Start”.', 'Ждём, пока все нажмут «Готов».': 'Waiting for everyone to press “Ready”.',
  'Хозяин комнаты начнёт матч.': 'The host will start the match.', 'Нажмите «Готов», когда будете готовы.': 'Press “Ready” when you are ready.',
  'Подключаемся…': 'Connecting…', 'Комната открыта, ждём друга': 'Room is open, waiting for a friend', 'На связи': 'Connected',
  'Восстанавливаем связь…': 'Restoring the connection…', 'Нет связи': 'Disconnected', 'напрямую': 'direct', 'через сервер': 'via server', 'прямое': 'direct', 'сервер': 'server',
  'Реакции': 'Emotes', 'Выйти в меню': 'Leave to menu', 'Связь потерялась': 'Connection lost', 'Друг отключился': 'Friend disconnected',
  'Восстанавливаем соединение. Если не выйдет — проверьте интернет или VPN.': 'Restoring the connection. If it fails, check your internet or VPN.',
  'Реванш': 'Rematch', 'Вы': 'You', 'Класс!': 'Nice!', 'Огонь!': 'Fire!', 'Ой!': 'Oops!', 'Ха-ха!': 'Haha!', 'Спасибо!': 'Thanks!', 'Реванш!': 'Rematch!',
  'Онлайн-игра сейчас недоступна': 'Online play is unavailable right now',
  'Не удалось подключиться к серверам игры. Проверьте интернет — против ИИ можно играть без сети.': 'Could not reach the game servers. Check your internet — playing vs AI works offline.',
  'Онлайн-игра работает в версии на GitHub': 'Online play works in the GitHub version',
  'Комнаты с таким кодом нет. Проверьте код или попросите друга прислать ссылку ещё раз.': 'There is no room with that code. Check the code or ask your friend to send it again.',
  'В комнате уже нет свободных мест.': 'The room is full.',
  'У вас с другом разные версии игры. Обновите страницу у обоих и попробуйте снова.': 'You and your friend have different game versions. Reload the page for both and try again.',
  'Друг не отвечает. Проверьте интернет; если включён VPN — попробуйте с ним и без него.': 'Your friend is not responding. Check your internet; if a VPN is on, try with and without it.',
  'Нет связи с серверами игры. Проверьте интернет или включите/выключите VPN.': 'Cannot reach the game servers. Check your internet or toggle your VPN.',
  'Нет интернета. Подключитесь к сети и попробуйте снова.': 'No internet. Connect to a network and try again.',
  'Хозяин закрыл комнату. Создайте новую или попросите новую ссылку.': 'The host closed the room. Create a new one or ask for a new link.',
  'Хозяин убрал вас из комнаты.': 'The host removed you from the room.', 'Связь прервалась. Попробуйте ещё раз.': 'The connection dropped. Please try again.',
  'Версии игры разные — обновите страницу у обоих': 'Game versions differ — reload the page for both of you',
  'Нет связи с сервером комнат. Проверьте интернет': 'Cannot reach the room server. Check your internet',
  'Не удалось соединиться. Попробуйте другую сеть или Wi-Fi': 'Could not connect. Try another network or Wi-Fi',
  'Комната не найдена. Проверьте код': 'Room not found. Check the code', 'Введите код комнаты из 5 букв': 'Enter a 5-letter room code',
  'Не загрузилась библиотека связи. Проверьте интернет или VPN и обновите страницу': 'The networking library failed to load. Check your internet or VPN and reload the page',
  'Ни один сервер недоступен — попробуйте выключить/включить VPN': 'No server is reachable — try toggling your VPN',
  'В комнате уже играют двое': 'Two players are already in this room', 'В комнате уже четверо игроков': 'Four players are already in this room',
  'Матч в этой комнате уже идёт — дождитесь конца': 'A match is already running in this room — wait for it to end',
  'Хост вышел из игры': 'The host left the game', 'Соединение потеряно': 'Connection lost', 'Связь с хостом потеряна': 'Connection to the host lost',
  'Ждём, пока все нажмут «Готов»': 'Waiting for everyone to press “Ready”', 'Нужен второй игрок': 'A second player is needed',
  'Создаём комнату…': 'Creating room…', 'Матч начался': 'The match has started', 'Начать матч может только хост': 'Only the host can start the match',
  'Переподключаемся…': 'Reconnecting…', 'Связь восстановлена': 'Connection restored', 'Связь с хостом прерывается…': 'The connection to the host is unstable…',
  'Комната не найдена на серверах, пробуем прямое соединение…': 'Room not found on the servers, trying a direct connection…',
  'Подключено · прямое соединение': 'Connected · direct connection', 'Подключено · через сервер (прямое соединение пропало)': 'Connected · via server (direct connection lost)',
  'Ждём друга…': 'Waiting for a friend…',
  // ---- в матче (canvas)
  'Вы ': 'You', 'Ваша пара': 'Your pair', 'и': 'and', 'МАТЧБОЛ': 'MATCH POINT', 'ГЕЙМБОЛ': 'GAME POINT', 'Геймбол': 'Game point', ' м': ' m',
  'СМЭШ!': 'SMASH!', 'БАХ!': 'BAM!', 'Идеально!': 'Perfect!', 'ВЖУХ!': 'WHOOSH!', 'Рано': 'Early', 'Поздно': 'Late', 'Мимо!': 'Miss!', 'Аут': 'Out',
  'Очко!': 'Point!', 'Ошибка подачи': 'Service fault', 'Гейм!': 'Game!', 'ПОБЕДА!': 'VICTORY!', 'Матч!': 'Match!', 'Смена сторон': 'Change of ends',
  'ВОТ ЭТО РОЗЫГРЫШ!': 'WHAT A RALLY!', 'ГЕЙМ!': 'GAME!', 'МАТЧ!': 'MATCH!',
  'ВОЛАН!': 'VOLAN!', 'ЛЕТИ ВЫШЕ!': 'FLY HIGHER!', 'ДАВАЙ-ДАВАЙ!': 'GO GO GO!', 'ЖМИ!': 'PUSH!', 'МЫ С ТОБОЙ': 'WE ARE WITH YOU',
  // ---- загрузка/прочее
  'Для игры нужен JavaScript.': 'JavaScript is required to play.',
  'Браузерный бадминтон: одиночка и пара против ИИ и с друзьями онлайн, правила BWF.': 'Browser badminton: singles and doubles vs AI and online with friends, BWF rules.',
};

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const plural = (n, one, many) => (n === 1 ? one : many);

/** Правила для строк с числами и именами: [regex, функция]. */
const RULES = [
  [/^код ([A-Z0-9]+)$/, (m) => `code ${m[1]}`],
  [/^Код друга ([A-Z0-9]+)$/, (m) => `Friend code ${m[1]}`],
  [/^Код комнаты (.+)$/, (m) => `Room code ${m[1]}`],
  [/^Коронный удар: (.+)$/, (m) => `Signature shot: ${tr(m[1])}`],
  [/^Профиль создан\. Ваш код друга — (\S+)$/, (m) => `Profile created. Your friend code is ${m[1]}`],
  [/^Код (\S+) добавлен в друзья$/, (m) => `Code ${m[1]} added to friends`],
  [/^Удалить (.+)$/, (m) => `Delete ${m[1]}`],
  [/^(.+) — больше не в друзьях$/, (m) => `${m[1]} is no longer your friend`],
  [/^Профиль «(.+)» загружен$/, (m) => `Profile “${m[1]}” loaded`],
  [/^(\d+) в паре$/, (m) => `${m[1]} as partners`],
  [/^играли (\d+) (день|дня|дней) назад$/, (m) => `played ${m[1]} ${plural(+m[1], 'day', 'days')} ago`],
  [/^играли (\d+) (\S+)$/, (m) => { const i = MONTHS.indexOf(m[2]); return i < 0 ? m[0] : `played ${MONTHS_EN[i]} ${m[1]}`; }],
  [/^играли сегодня$/, () => 'played today'], [/^играли вчера$/, () => 'played yesterday'], [/^ещё не играли$/, () => 'not played yet'],
  [/^Новый рекорд: розыгрыш в (\d+) (удар|удара|ударов)$/, (m) => `New record: a rally of ${m[1]} ${plural(+m[1], 'hit', 'hits')}`],
  [/^Личные встречи: вы (\d+) — (\d+) (.+)$/, (m) => `Head to head: you ${m[1]} — ${m[2]} ${m[3]}`],
  [/^Розыгрышей: (\d+) · средняя длина: ([\d.]+) уд\. · идеальных: (\d+)$/, (m) => `Rallies: ${m[1]} · average length: ${m[2]} hits · perfect: ${m[3]}`],
  [/^Очко: (.+)$/, (m) => `Point: ${m[1]}`],
  [/^(.+) — (\d+(?::\d+)*)$/, (m) => `${tr(m[1])} — ${m[2]}`],
  [/^(\d+) мс$/, (m) => `${m[1]} ms`],
  [/^Ждём (\d+:\d+)$/, (m) => `Waiting ${m[1]}`],
  [/^(.+) в комнате$/, (m) => `${m[1]} joined the room`],
  [/^(.+) уходит из комнаты$/, (m) => `${m[1]} is leaving the room`],
  [/^(.+) снова на связи$/, (m) => `${m[1]} is back online`],
  [/^(.+) выходит из матча\.$/, (m) => `${m[1]} is leaving the match.`],
  [/^(.+): нет связи\. Подождём — может, связь вернётся\.$/, (m) => `${m[1]}: no connection. Let's wait — it may come back.`],
  [/^(.+) вышел из комнаты$/, (m) => `${m[1]} left the room`], [/^(.+) отключился$/, (m) => `${m[1]} disconnected`],
  [/^(.+) вышел — вместо него играет ИИ$/, (m) => `${m[1]} left — an AI plays instead`], [/^(.+) отключился — вместо него играет ИИ$/, (m) => `${m[1]} disconnected — an AI plays instead`],
  [/^(.+) не отвечает…$/, (m) => `${m[1]} is not responding…`],
  [/^Прямое соединение с (.+)$/, (m) => `Direct connection with ${m[1]}`], [/^Прямое соединение пропало — играем через сервер$/, () => 'Direct connection lost — playing via server'],
  [/^Сыграем в бадминтон\? Комната (\S+)$/, (m) => `Shall we play badminton? Room ${m[1]}`],
  [/^Ждём друга… \(серверов на связи: (\d+) из (\d+)\)$/, (m) => `Waiting for a friend… (servers connected: ${m[1]} of ${m[2]})`],
  [/^Подключено через сервер (\d+) из (\d+), ждём начала матча…$/, (m) => `Connected via server ${m[1]} of ${m[2]}, waiting for the match…`],
  [/^Подключено, ждём начала матча…$/, () => 'Connected, waiting for the match…'],
  [/^Ждём ([\d:]+)$/, (m) => `Waiting ${m[1]}`],
];

function tr(s) { return t(s); }

/** Перевод строки на текущий язык (ru → без изменений). */
export function t(s) {
  if (LANG === 'ru' || typeof s !== 'string' || !s) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const out = translate(s);
  if (cache.size > 800) cache.clear();
  cache.set(s, out);
  return out;
}

function translate(s) {
  if (!/[А-Яа-яЁё]/.test(s)) return s;
  const core = s.trim();
  const lead = s.slice(0, s.indexOf(core)), tail = s.slice(s.indexOf(core) + core.length);
  const one = lookup(core);
  if (one != null) return lead + one + tail;
  // «1 × 1, любитель, до 21» и подобные списки через запятую
  if (core.includes(', ')) {
    const parts = core.split(', ');
    const outp = parts.map(p => (CYR.test(p) ? lookup(p) : p));
    if (outp.every(x => x != null)) return lead + outp.join(', ') + tail;
  }
  return s;
}

function lookup(core) {
  if (Object.prototype.hasOwnProperty.call(D, core)) return D[core];
  const cap = core[0].toUpperCase() + core.slice(1);   // «любитель» → «Любитель» (названия в меню пишутся строчными)
  if (cap !== core && Object.prototype.hasOwnProperty.call(D, cap)) return D[cap].toLowerCase();
  for (const [re, fn] of RULES) { const m = re.exec(core); if (m) return fn(m); }
  return null;
}

// ------------------------------------------------------------------ DOM
const ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];

function fixText(n) {
  const v = n.nodeValue;
  if (!v || !CYR.test(v)) return;
  const o = t(v);
  if (o !== v) n.nodeValue = o;
}
function fixEl(el) {
  for (const a of ATTRS) { const v = el.getAttribute && el.getAttribute(a); if (v && CYR.test(v)) { const o = t(v); if (o !== v) el.setAttribute(a, o); } }
}
function walk(node) {
  if (node.nodeType === 3) { fixText(node); return; }
  if (node.nodeType !== 1) return;
  const tag = node.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return;
  fixEl(node);
  for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
}

let observer = null;
/** Переводит el и следит за изменениями (только при lang === 'en'). */
export function watchDom(el) {
  if (LANG === 'ru' || typeof MutationObserver === 'undefined') return;
  walk(el);
  if (observer) return;
  observer = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') fixText(m.target);
      else if (m.type === 'attributes') fixEl(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  });
  observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
