/**
 * version.js — единственный источник версии и ссылок на загрузки.
 * Менять здесь: от VERSION зависят имя кэша sw.js (через ?v= при регистрации), экран
 * «Скачать игру» и проверка тега релиза (v<VERSION>) в .github/workflows/release.yml.
 * Размеры — по сборке 1.0.0 (CI), обновляйте после релиза.
 */
export const VERSION = '1.0.0';
export const REPO = 'Rahim004/badminton-';
export const SITE_URL = 'https://rahim004.github.io/badminton-/';
export const RELEASE_LATEST = `https://github.com/${REPO}/releases/latest/download/`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
/** Файлы релиза: имена должны совпадать с теми, что кладёт workflow в GitHub Release. */
export const DOWNLOADS = {
  apk: { file: 'Volan.apk', label: 'Android (APK)', size: '≈ 1,5 МБ' },
  exe: { file: 'Volan.exe', label: 'Windows (.exe)', size: '≈ 85 МБ' },
  appimage: { file: 'Volan.AppImage', label: 'Linux (AppImage)', size: '≈ 90 МБ' },
};
