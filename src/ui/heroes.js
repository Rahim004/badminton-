/**
 * ui/heroes.js — герои для экранов выбора: истории, амплуа, форма.
 * Базовые данные (имя, цвета, статы) берутся из config.CHARACTERS, если они там есть;
 * здесь — только то, что нужно интерфейсу. Чтение конфига — защитное:
 * если героя или поля нет, используется запасное значение отсюда.
 *
 * API:
 *   HEROES: Array<Hero>    Hero: {id, name, role, story, signature, color, accent, stats, look}
 *   heroById(id) -> Hero
 *   STAT_LABELS
 */
import * as CFG from '../config.js';

const CHARS = (CFG && CFG.CHARACTERS) || {};
const ORDER = (CFG && Array.isArray(CFG.CHARACTER_ORDER) && CFG.CHARACTER_ORDER.length) ? CFG.CHARACTER_ORDER : null;

export const STAT_LABELS = { speed: 'Скорость', power: 'Сила', control: 'Контроль', stamina: 'Выносливость' };

/** Запасные данные и всё, чего нет в конфиге. look — параметры портрета. */
const EXTRA = {
  timur: {
    name: 'Тимур Ахмедов', role: 'Универсал', color: '#ffb300', accent: '#8a5a00',
    stats: { speed: 0.85, power: 0.8, control: 0.8, stamina: 0.85 },
    story: 'Вырос в школьном спортзале Казани, где сетку натягивали между шведскими стенками. Играет ровно в любой фазе розыгрыша и не любит отдавать подачу.',
    signature: 'Кросс-клир в угол',
    look: { skin: '#d9a77c', hair: '#1d140f', hairStyle: 'crop', band: null, pattern: 'sash' },
  },
  kai: {
    name: 'Кай Сора', role: 'Сеточник', color: '#2fb8ff', accent: '#0b4d80',
    stats: { speed: 0.95, power: 0.6, control: 0.8, stamina: 0.75 },
    story: 'Бывший юниор по настольному теннису — отсюда реакция и мелкий шаг. На сетке ловит волан раньше, чем соперник поймёт, куда сыграл.',
    signature: 'Подставка с переката',
    look: { skin: '#f0c9a4', hair: '#0f1420', hairStyle: 'spiky', band: '#ffffff', pattern: 'stripe' },
  },
  mira: {
    name: 'Мира Тан', role: 'Атака', color: '#ff4d6d', accent: '#7a1027',
    stats: { speed: 0.78, power: 0.98, control: 0.65, stamina: 0.7 },
    story: 'Пришла из волейбола и принесла с собой прыжок. Её смэш с задней линии — самый быстрый в лиге, а замах почти не читается.',
    signature: 'Смэш в прыжке',
    look: { skin: '#e8b48f', hair: '#2a0f12', hairStyle: 'ponytail', band: '#ffd23f', pattern: 'chevron' },
  },
  leo: {
    name: 'Лео Варг', role: 'Защита', color: '#4caf50', accent: '#1b5e20',
    stats: { speed: 0.8, power: 0.6, control: 0.85, stamina: 0.95 },
    story: 'Северянин из Мурманска, тренировался на длинных розыгрышах до сотни ударов. Поднимает любой смэш и ждёт, пока ошибётся соперник.',
    signature: 'Приём смэша в выпаде',
    look: { skin: '#f3d2bb', hair: '#c9a46a', hairStyle: 'beard', band: null, pattern: 'yoke' },
  },
  aya: {
    name: 'Айя Рен', role: 'Хитрость', color: '#b388ff', accent: '#4527a0',
    stats: { speed: 0.82, power: 0.62, control: 0.97, stamina: 0.72 },
    story: 'Играет как шахматист: показывает клир — кладёт укороченный за сетку. Соперники говорят, что её ракетка «врёт».',
    signature: 'Обманный укороченный',
    look: { skin: '#f5d6c0', hair: '#101010', hairStyle: 'bob', band: null, pattern: 'dots' },
  },
  niko: {
    name: 'Нико Блейз', role: 'Непредсказуемый', color: '#ff7043', accent: '#8c2a0b',
    stats: { speed: 0.88, power: 0.88, control: 0.6, stamina: 0.75 },
    story: 'Уличный игрок с набережной, учился по видео и чутью. Может выиграть розыгрыш невозможным ударом и тут же отдать очко в аут.',
    signature: 'Драйв из-за спины',
    look: { skin: '#a8714f', hair: '#ff7043', hairStyle: 'mohawk', band: '#1c2433', pattern: 'flame' },
  },
};

const DEFAULT_ORDER = ['timur', 'kai', 'mira', 'leo', 'aya', 'niko'];

function num(v, d) { return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : d; }

function build(id) {
  const c = CHARS[id] || {};
  const e = EXTRA[id] || {};
  const baseStats = e.stats || { speed: 0.8, power: 0.8, control: 0.8, stamina: 0.8 };
  const cs = c.stats || {};
  return {
    id,
    name: typeof c.name === 'string' ? c.name : (e.name || id),
    role: e.role || '',
    story: e.story || (typeof c.bio === 'string' ? c.bio : ''),
    bio: typeof c.bio === 'string' ? c.bio : '',
    signature: e.signature || '',
    color: typeof c.color === 'string' ? c.color : (e.color || '#ffd23f'),
    accent: typeof c.accent === 'string' ? c.accent : (e.accent || '#333'),
    stats: {
      speed: num(cs.speed, baseStats.speed), power: num(cs.power, baseStats.power),
      control: num(cs.control, baseStats.control), stamina: num(cs.stamina, baseStats.stamina),
    },
    look: e.look || { skin: '#e0b090', hair: '#222', hairStyle: 'crop', band: null, pattern: 'sash' },
  };
}

const ids = (ORDER || DEFAULT_ORDER).filter(id => CHARS[id] || EXTRA[id]);
for (const id of Object.keys(CHARS)) if (!ids.includes(id)) ids.push(id);
export const HEROES = ids.map(build);

export function heroById(id) {
  return HEROES.find(h => h.id === id) || HEROES[0];
}
