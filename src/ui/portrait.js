/**
 * ui/portrait.js — портреты героев для меню: настоящий аниме-бюст из рендера персонажей
 * (render/character.js → drawBust) на отдельном canvas, превращённый в <img> и закэшированный.
 * Если отрисовка не удалась (нет canvas, ошибка модуля) — запасной SVG-портрет.
 *
 *   portrait(heroId, {size=96, mood='calm', color, accent, flip}) -> HTMLImageElement
 *       (класс .portrait; картинка подменяется, когда загрузится шрифт номера)
 *   portraitSVG(hero, {bg}) -> string        — запасной вариант
 */
import { createCharacters } from '../render/character.js';
import { heroById } from './heroes.js';

const cache = new Map();
let chars = null, canvas = null, ctx = null;
let fontsReady = false;
const fontWait = (() => {
  try {
    if (!globalThis.document || !document.fonts) return Promise.resolve();
    return Promise.race([document.fonts.load('900 20px "Unbounded"'), new Promise(r => setTimeout(r, 1500))])
      .catch(() => {}).then(() => { fontsReady = true; });
  } catch (_) { return Promise.resolve(); }
})();

function draw(heroId, size, mood, color, accent, flip) {
  const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const px = Math.round(size * dpr);
  if (!canvas) { canvas = document.createElement('canvas'); ctx = canvas.getContext('2d'); chars = createCharacters(ctx, () => ({ x: 0, y: 0, s: 1, d: 1 }), {}); }
  canvas.width = px; canvas.height = px;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, px, px);
  const r = px * 0.25;
  chars.drawBust(heroId, px * 0.5, px * 0.5, r, mood, { color, accent, flip, yaw: 0.32 });
  return canvas.toDataURL('image/png');
}

export function portrait(heroId, o = {}) {
  const hero = heroById(heroId);
  const size = o.size || 96, mood = o.mood || 'calm';
  const color = o.color || hero.color, accent = o.accent || hero.accent;
  const key = [hero.id, size, mood, color, accent, !!o.flip].join('|');
  const img = new Image();
  img.className = 'portrait';
  img.alt = hero.name;
  img.width = size; img.height = size;
  img.draggable = false;
  const fill = () => {
    let url = cache.get(key + (fontsReady ? '' : '~'));
    if (!url) {
      try { url = draw(hero.id, size, mood, color, accent, !!o.flip); }
      catch (e) { url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(portraitSVG({ ...hero, color, accent }, { bg: false })); }
      cache.set(key + (fontsReady ? '' : '~'), url);
    }
    img.src = url;
  };
  fill();
  if (!fontsReady) fontWait.then(fill);
  return img;
}

let uid = 0;
export function portraitSVG(hero, o = {}) {
  const L = hero.look || {};
  const k = 'p' + (++uid);
  const c = hero.color, a = hero.accent, skin = L.skin || '#e0b090', hair = L.hair || '#222';
  const bg = o.bg !== false;
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<defs><linearGradient id="${k}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="#0a1428"/></linearGradient></defs>
${bg ? `<rect width="100" height="100" fill="url(#${k}g)"/>` : ''}
<path d="M14 104 Q16 70 50 68 Q84 70 86 104Z" fill="${c}"/>
<path d="M43 58 L57 58 L56 70 Q50 74 44 70Z" fill="${skin}"/>
<ellipse cx="50" cy="44" rx="16" ry="19" fill="${skin}"/>
<ellipse cx="44" cy="46" rx="1.8" ry="2.2" fill="#1a1a1a"/><ellipse cx="56" cy="46" rx="1.8" ry="2.2" fill="#1a1a1a"/>
<path d="M45 55 Q50 58 55 55" fill="none" stroke="#5a2e1e" stroke-width="1.6" stroke-linecap="round"/>
<path d="M33 40 Q34 22 50 21 Q66 22 67 40 Q63 31 50 31 Q38 31 33 40Z" fill="${hair}"/>
</svg>`;
}
