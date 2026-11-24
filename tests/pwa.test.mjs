// Упаковка и установка: офлайн-кэш, манифест, версия, имена файлов релиза, определение платформы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, listWebFiles } from '../tools/webfiles.mjs';
import { VERSION, DOWNLOADS, RELEASE_LATEST, SITE_URL, REPO } from '../src/version.js';
import { detectPlatform } from '../src/pwa.js';

const read = p => readFileSync(join(ROOT, p), 'utf8');

test('версия — semver, ссылки ведут в releases/latest/download', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(RELEASE_LATEST, `https://github.com/${REPO}/releases/latest/download/`);
  assert.ok(SITE_URL.startsWith('https://') && SITE_URL.endsWith('/'));
});

test('sw.js: список файлов и хэш актуальны (node tools/gen-sw.mjs)', () => {
  execFileSync(process.execPath, [join(ROOT, 'tools/gen-sw.mjs'), '--check'], { stdio: 'pipe' });
});

test('sw.js кэширует всё нужное для офлайна, включая vendor/ и fonts/', () => {
  const sw = read('sw.js');
  for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'src/main.js', 'src/version.js', 'src/pwa.js', 'vendor/mqtt.min.js', 'vendor/peerjs.min.js', 'fonts/unbounded-cyrillic.woff2', 'fonts/unbounded-latin.woff2', 'icons/icon-512.png'])
    assert.ok(sw.includes(`"./${f}"`), 'нет в sw.js: ' + f);
  assert.ok(!/play\.html|tests\//.test(sw.split('/*FILES*/')[1].split('/*END*/')[0]), 'в кэш не должны попадать play.html и tests/');
  assert.ok(listWebFiles().every(f => existsSync(join(ROOT, f))));
});

test('manifest.webmanifest: standalone, цвета, иконки any и maskable', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'Волан');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#17134a');
  assert.ok(m.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.ok(m.icons.some(i => i.purpose === 'any' && i.sizes === '192x192'));
  for (const i of m.icons) assert.ok(existsSync(join(ROOT, i.src)), i.src);
  assert.match(read('index.html'), /rel="manifest"/);
  assert.match(read('index.html'), /apple-touch-icon/);
});

test('имена файлов релиза совпадают в version.js, workflow и electron-builder', () => {
  const wf = read('.github/workflows/release.yml');
  for (const d of Object.values(DOWNLOADS)) assert.ok(wf.includes(d.file), 'workflow не знает ' + d.file);
  const pkg = JSON.parse(read('desktop/package.json'));
  assert.equal(pkg.build.portable.artifactName, DOWNLOADS.exe.file);
  assert.equal(pkg.build.linux.artifactName.replace('${ext}', 'AppImage'), DOWNLOADS.appimage.file);
  assert.ok(wf.includes('tools/gen-sw.mjs --check'));
});

test('Android: пакет, INTERNET, WebViewAssetLoader, кнопка назад, метка VolanApp', () => {
  const man = read('android/app/src/main/AndroidManifest.xml');
  const act = read('android/app/src/main/java/com/volan/badminton/MainActivity.java');
  assert.match(read('android/app/build.gradle'), /applicationId "com\.volan\.badminton"/);
  assert.match(man, /permission\.INTERNET/);
  for (const s of ['WebViewAssetLoader', 'setDomStorageEnabled(true)', 'MIXED_CONTENT_NEVER_ALLOW', 'FLAG_KEEP_SCREEN_ON', 'VolanApp', '__volan.back', 'setMediaPlaybackRequiresUserGesture(false)', 'onPermissionRequest'])
    assert.ok(act.includes(s), 'MainActivity: нет ' + s);
});

test('detectPlatform: iPhone, iPad (как Mac), Android, Windows, Mac, Linux, браузеры', () => {
  const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  assert.deepEqual(detectPlatform(IOS, 5), { os: 'ios', browser: 'safari', mobile: true, iosSafari: true });
  const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  assert.equal(detectPlatform(IPAD, 5).os, 'ios');
  assert.equal(detectPlatform(IPAD, 0).os, 'mac');
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1', 5).iosSafari, false);
  const AND = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  assert.deepEqual(detectPlatform(AND, 5), { os: 'android', browser: 'chrome', mobile: true, iosSafari: false });
  assert.equal(detectPlatform(AND + ' SamsungBrowser/24.0', 5).browser, 'samsung');
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  assert.equal(detectPlatform(WIN).os, 'windows');
  assert.equal(detectPlatform(WIN + ' Edg/124.0').browser, 'edge');
  assert.equal(detectPlatform(WIN + ' YaBrowser/24.1').browser, 'yandex');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0').browser, 'firefox');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36').os, 'linux');
  assert.equal(detectPlatform('').os, 'other');
});
