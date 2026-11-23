/**
 * config.js — все числовые константы игры в одном месте.
 *
 * Система координат (метры, секунды):
 *   x — вдоль корта (сетка в x = 0, задние линии в x = ±6.7);
 *   y — поперёк корта (центральная линия y = 0, боковые ±3.05 / ±2.59);
 *   z — высота над полом.
 * Сторона команды `side` ∈ {-1, +1} — знак x её половины.
 * Для стороны s «правая» зона подачи (если смотреть на сетку) имеет знак y = s.
 *
 * Модуль не содержит логики: только данные. Другие агенты могут
 * добавлять поля, но не переименовывать существующие.
 */

export const COURT = {
  LENGTH: 13.4,
  HALF_LENGTH: 6.7,
  WIDTH_DOUBLES: 6.1,
  HALF_WIDTH_DOUBLES: 3.05,
  WIDTH_SINGLES: 5.18,
  HALF_WIDTH_SINGLES: 2.59,
  SHORT_SERVICE: 1.98,          // короткая линия подачи (от сетки)
  DOUBLES_LONG_SERVICE: 5.94,   // длинная линия подачи для пар (от сетки) = 6.7 - 0.76
  NET_HEIGHT: 1.55,
  NET_POST_Y: 3.05,
  LINE_WIDTH: 0.04,
  /** Насколько игрок может выйти за пределы корта. */
  RUNOFF_BACK: 1.6,
  RUNOFF_SIDE: 1.2,
  /** Минимальный зазор игрока до сетки. */
  NET_GAP: 0.25,
};

export const PHYSICS = {
  SIM_HZ: 120,
  DT: 1 / 120,
  GRAVITY: 9.81,
  /**
   * Коэффициент квадратичного сопротивления k (1/м): a = -g·ẑ - k·|v|·v.
   * Предельная скорость падения v_t = sqrt(g/k) ≈ 7.2 м/с — как у
   * настоящего перьевого волана. Даёт «парашют» после клира.
   */
  DRAG: 0.19,
  /** После удара о сетку скорость гасится так. */
  NET_DAMP: 0.08,
  /** Полуширина «ленты» сетки для захвата волана по x. */
  NET_THICKNESS: 0.03,
  /** Максимальная длительность прогноза траектории, с. */
  PREDICT_MAX_T: 6,
};

/**
 * Параметры ударов. speed — базовая начальная скорость (м/с) при power=1.
 * Солвер в shots.js сам подбирает скорость/угол, чтобы попасть в цель;
 * эти числа ограничивают диапазон поиска.
 */
export const SHOTS = {
  clear:      { minSpeed: 12, maxSpeed: 60, angles: [28, 72], minNetClear: 0.8, apex: 'high' },
  lift:       { minSpeed: 6,  maxSpeed: 55, angles: [35, 80], minNetClear: 0.5, apex: 'high' },
  drop:       { minSpeed: 4,  maxSpeed: 22, angles: [-35, 30], minNetClear: 0.08, apex: 'low' },
  smash:      { minSpeed: 22, maxSpeed: 58, angles: [-40, -2], minNetClear: 0.05, apex: 'fast' },
  drive:      { minSpeed: 10, maxSpeed: 34, angles: [-12, 14], minNetClear: 0.08, apex: 'flat' },
  net:        { minSpeed: 1.5, maxSpeed: 10, angles: [-10, 70], minNetClear: 0.04, apex: 'low' },
  serveShort: { minSpeed: 3,  maxSpeed: 14, angles: [0, 40], minNetClear: 0.06, apex: 'low' },
  serveLong:  { minSpeed: 10, maxSpeed: 55, angles: [40, 78], minNetClear: 0.8, apex: 'high' },
};

/** Тайминг удара: время замаха до контакта и окна качества (с). */
export const TIMING = {
  WINDUP: 0.12,          // идеальная задержка нажатие → контакт
  PERFECT_WINDOW: 0.035, // |задержка - WINDUP| ≤ этого → «идеально»
  BUFFER: 0.42,          // насколько заранее можно нажать удар
  MIN_DELAY: 0.02,       // минимально возможная задержка (поздний удар)
  SWING_RECOVER: 0.28,   // после удара
  WHIFF_RECOVER: 0.35,   // после промаха
  SERVE_CLOCK: 6,        // сек на подачу (после — авто-подача человеку)
};

export const PLAYER = {
  HEIGHT: 1.78,
  BASE_SPEED: 4.4,       // м/с максимальная (умножается на stat speed)
  ACCEL: 22,             // м/с²
  DECEL: 30,
  REACH: 0.9,           // горизонтальный радиус досягаемости (рука+ракетка)
  LUNGE_REACH: 0.5,      // доп. досягаемость выпадом
  REACH_LOW: 0.05,       // минимальная высота контакта
  REACH_HIGH: 2.75,      // максимальная высота контакта стоя
  JUMP_REACH: 0.5,       // добавка прыжком
  SMASH_MIN_Z: 2.05,     // смэш возможен с этой высоты контакта
  CONTACT_Z_IDEAL: 2.4,
  SERVE_Z: 1.0,          // точка контакта подачи (ниже пояса 1.15)
};

/**
 * Таблица сложности ИИ.
 *  reaction — задержка реакции после удара соперника, с
 *  speed    — множитель скорости бега
 *  aimError — σ разброса цели, м
 *  blunder  — базовая вероятность грубой ошибки (аут/сетка), растёт под давлением
 *  posError — σ ошибки выбора позиции перед ударом, м
 *  whiff    — вероятность промаха (замах мимо)
 *  wrongFoot — вероятность «купиться на обман»: лишняя задержка и шаг не туда
 *  judge    — σ ошибки оценки «аут/не аут», м
 *  timing   — σ ошибки тайминга, с
 *  smashRate, dropRate — склонность к атаке/укороткам
 *  netClearBonus — запас над сеткой (м): осторожность
 */
export const DIFFICULTY = {
  novice:  { whiff: 0.06, wrongFoot: 0.4, label: 'Новичок', reaction: 0.34, speed: 0.78, aimError: 0.55, blunder: 0.3, posError: 0.42, judge: 0.9, timing: 0.06, smashRate: 0.25, dropRate: 0.25, netClearBonus: 0.25, anticipation: 0.0 },
  amateur: { whiff: 0.025, wrongFoot: 0.3, label: 'Любитель', reaction: 0.25, speed: 0.88, aimError: 0.38, blunder: 0.16, posError: 0.25, judge: 0.5, timing: 0.04, smashRate: 0.4, dropRate: 0.3, netClearBonus: 0.15, anticipation: 0.3 },
  pro:     { whiff: 0.006, wrongFoot: 0.2, label: 'Профи', reaction: 0.17, speed: 0.98, aimError: 0.24, blunder: 0.09, posError: 0.14, judge: 0.25, timing: 0.025, smashRate: 0.55, dropRate: 0.35, netClearBonus: 0.1, anticipation: 0.6 },
  legend:  { whiff: 0.0, wrongFoot: 0.13, label: 'Легенда', reaction: 0.12, speed: 1.06, aimError: 0.15, blunder: 0.055, posError: 0.08, judge: 0.12, timing: 0.015, smashRate: 0.65, dropRate: 0.38, netClearBonus: 0.06, anticipation: 0.85 },
};
export const DIFFICULTY_ORDER = ['novice', 'amateur', 'pro', 'legend'];

/**
 * Герои (статы 0..1). Внешность/истории — задача визуального агента.
 * speed, power, control, stamina.
 */
export const CHARACTERS = {
  kai:   { name: 'Кай Сора',      style: 'net',      color: '#2fb8ff', accent: '#0b4d80', stats: { speed: 0.95, power: 0.6,  control: 0.8,  stamina: 0.75 }, bio: 'Быстрый сеточник: успевает к любому укоротку.' },
  mira:  { name: 'Мира Тан',      style: 'attack',   color: '#ff4d6d', accent: '#7a1027', stats: { speed: 0.78, power: 0.98, control: 0.65, stamina: 0.7 },  bio: 'Её смэш слышно на трибунах.' },
  leo:   { name: 'Лео Варг',      style: 'defense',  color: '#4caf50', accent: '#1b5e20', stats: { speed: 0.8,  power: 0.6,  control: 0.85, stamina: 0.95 }, bio: 'Стена: возвращает всё.' },
  aya:   { name: 'Айя Рен',       style: 'trick',    color: '#b388ff', accent: '#4527a0', stats: { speed: 0.82, power: 0.62, control: 0.97, stamina: 0.72 }, bio: 'Хитрые дропы и обманные движения.' },
  timur: { name: 'Тимур Ахмедов', style: 'allround', color: '#ffb300', accent: '#8a5a00', stats: { speed: 0.85, power: 0.8,  control: 0.8,  stamina: 0.85 }, bio: 'Универсал без слабых мест.' },
  niko:  { name: 'Нико Блейз',    style: 'wild',     color: '#ff7043', accent: '#8c2a0b', stats: { speed: 0.88, power: 0.88, control: 0.6,  stamina: 0.75 }, bio: 'Непредсказуемый: может всё — и ошибиться тоже.' },
};
export const CHARACTER_ORDER = ['timur', 'kai', 'mira', 'leo', 'aya', 'niko'];

/** Форматы матча. */
export const MATCH_FORMATS = {
  quick:  { games: 1, points: 21, cap: 30, label: '1 гейм до 21' },
  short:  { games: 1, points: 11, cap: 15, label: '1 гейм до 11' },
  full:   { games: 3, points: 21, cap: 30, label: '3 гейма до 21' },
};

/** Тайминги фаз матча, с. */
export const FLOW = {
  POINT_PAUSE: 1.4,
  GAME_PAUSE: 2.5,
  AI_SERVE_DELAY: [0.7, 1.4],
};
