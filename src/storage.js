/**
 * storage.js — безопасная обёртка над localStorage. Приватный режим, iframe-песочница,
 * переполнение, Node без localStorage — всё глотается: тогда данные живут в памяти
 * до перезагрузки страницы, игра работает и без хранилища.
 *
 * Ключи:
 *   'volan.settings' — общие настройки. Поля, которые читают другие модули, не трогаем:
 *                      controls (controlsSettings.js), sound, volume (audio.js),
 *                      reducedMotion (render/effects.js). Пишем только патчем
 *                      (чтение → слияние → запись), чтобы не затереть чужие поля.
 *   'volan.profile'  — профиль игрока (src/profile)
 *   'volan.friends'  — друзья (src/profile)
 *
 * API:
 *   loadJSON(key, fallback) / saveJSON(key, value) -> bool / removeKey(key)
 *   loadSettings()            — сохранённые настройки поверх DEFAULT_SETTINGS
 *   saveSettings(patch)       — слить патч с сохранённым объектом, записать,
 *                               разослать window 'volan:settings' {detail: весь объект}
 *   SETTINGS_KEY, DEFAULT_SETTINGS
 */
export const SETTINGS_KEY = 'volan.settings';

const memory = new Map(); // запасное хранилище, если localStorage недоступен

function ls() {
  try { const s = globalThis.localStorage; if (s) { s.getItem('__volan'); return s; } } catch (_) { /* заблокировано */ }
  return null;
}

function prefersReducedMotion() {
  try { return !!(globalThis.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; }
}

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  volume: 0.8,
  reducedMotion: prefersReducedMotion(),
  // последние выборы в меню «Играть с ИИ»
  mode: 'singles',
  difficulty: 'amateur',
  format: 'quick',
  assist: true,
});

export function loadJSON(key, fallback = null) {
  let raw = null;
  try { const s = ls(); raw = s ? s.getItem(key) : (memory.has(key) ? memory.get(key) : null); } catch (_) { raw = null; }
  if (raw == null) return fallback;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (_) { return fallback; }
}

export function saveJSON(key, value) {
  let raw;
  try { raw = JSON.stringify(value); } catch (_) { return false; }
  memory.set(key, raw);
  try { const s = ls(); if (!s) return false; s.setItem(key, raw); return true; } catch (_) { return false; }
}

export function removeKey(key) {
  memory.delete(key);
  try { const s = ls(); if (s) s.removeItem(key); } catch (_) { /* ignore */ }
}

function rawSettings() {
  const s = loadJSON(SETTINGS_KEY, null);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

export function loadSettings() {
  const stored = rawSettings();
  // Перенос ключа первой версии меню ('volan.settings.v1': mode/difficulty/format/assist).
  const legacy = loadJSON('volan.settings.v1', null);
  const out = { ...DEFAULT_SETTINGS, ...(legacy && typeof legacy === 'object' ? legacy : {}), ...stored };
  out.volume = Math.max(0, Math.min(1, Number.isFinite(+out.volume) ? +out.volume : DEFAULT_SETTINGS.volume));
  out.sound = out.sound !== false;
  out.reducedMotion = !!out.reducedMotion;
  return out;
}

export function saveSettings(patch = {}) {
  const all = { ...rawSettings(), ...patch };
  saveJSON(SETTINGS_KEY, all);
  try { globalThis.dispatchEvent && globalThis.CustomEvent && dispatchEvent(new CustomEvent('volan:settings', { detail: { ...all } })); } catch (_) { /* старые браузеры */ }
  return loadSettings();
}
