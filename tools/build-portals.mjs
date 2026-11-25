// Собирает готовые к загрузке архивы для игровых порталов:  node tools/build-portals.mjs [itch] [yandex] [crazygames] [--no-online]
//   dist/itch.zip  dist/yandex.zip  dist/crazygames.zip
// В архив попадают только файлы, нужные игре во время работы (index.html, styles.css, src/, vendor/, fonts/, иконка).
// В index.html вписывается window.VOLAN_PLATFORM (см. src/platform/index.js) и, где нужно, скрипт SDK площадки.
// Без зависимостей: ZIP пишется вручную (deflate из node:zlib), порядок и даты файлов фиксированы — сборка воспроизводима.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ROOT } from './webfiles.mjs';

const DIST = join(ROOT, 'dist');

/** Настройки площадок. head — что вставить в <head> перед игрой. */
const PLATFORMS = {
  itch: {
    head: '',
    note: 'itch.io: HTML5-архив, играет во фрейме на itch.zone',
  },
  yandex: {
    head: '  <script src="/sdk.js"></script>\n',   // SDK Яндекс Игр отдаёт сама площадка по этому адресу
    note: 'Яндекс Игры: SDK /sdk.js, без внешних ссылок',
  },
  crazygames: {
    head: '  <script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>\n',
    note: 'CrazyGames: SDK v3, без внешних ссылок',
  },
};

// ------------------------------------------------------------------ файлы игры
function walk(dir, re, out) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(n)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
}

function runtimeFiles() {
  const out = ['styles.css'];
  walk(join(ROOT, 'src'), /\.js$/, out);
  walk(join(ROOT, 'vendor'), /\.(js|LICENSE)$/, out);   // mqtt и peerjs для онлайна, лицензия peerjs
  walk(join(ROOT, 'fonts'), /\.woff2$/, out);
  out.push('icons/icon-192.png');                        // favicon (иконки установки PWA и манифест порталам не нужны)
  return out;
}

function pageFor(id, noOnline) {
  let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const cfg = PLATFORMS[id];
  const inject = `  <script>window.VOLAN_PLATFORM = '${id}';${noOnline ? ' window.VOLAN_NO_ONLINE = true;' : ''}</script>\n${cfg.head}`;
  if (!html.includes('<link rel="manifest"')) throw new Error('index.html изменился: не найден <link rel="manifest">');
  html = html.replace(/\s*<link rel="manifest"[^>]*>\n/, '\n');                // установка как PWA на порталах не нужна
  html = html.replace(/\s*<link rel="apple-touch-icon"[^>]*>\n/, '\n');        // файла иконки в архиве нет
  html = html.replace('  <link rel="stylesheet" href="./styles.css">', inject + '  <link rel="stylesheet" href="./styles.css">');
  if (!html.includes('VOLAN_PLATFORM')) throw new Error('не удалось вписать платформу в index.html');
  return html;
}

// ------------------------------------------------------------------ ZIP
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function makeZip(entries) {   // entries: [{ name, data: Buffer }]
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1 | ((2026 - 1980) << 9);   // 2026-01-01 00:00
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);   // 0x0800 — имена в UTF-8
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(0o100644 << 16 >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + body.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ------------------------------------------------------------------ проверки требований порталов
function validate(id, names, totalBytes) {
  const problems = [];
  for (const n of names) {
    if (/[^\x21-\x7e]/.test(n)) problems.push(`имя файла с пробелом/кириллицей/не-ASCII: ${n}`);   // требование Яндекс Игр
    if (n.startsWith('/') || n.includes('..')) problems.push(`небезопасный путь: ${n}`);
  }
  if (names[0] !== 'index.html') problems.push('index.html должен лежать первым, в корне архива');
  if (totalBytes > 100 * 1024 * 1024) problems.push('больше 100 МБ');
  return problems;
}

function build(id, noOnline) {
  const files = runtimeFiles();
  const entries = [{ name: 'index.html', data: Buffer.from(pageFor(id, noOnline), 'utf8') }];
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) throw new Error('нет файла ' + f);
    entries.push({ name: f, data: readFileSync(join(ROOT, f)) });
  }
  const total = entries.reduce((a, e) => a + e.data.length, 0);
  const problems = validate(id, entries.map(e => e.name), total);
  if (problems.length) throw new Error(id + ': ' + problems.join('; '));
  mkdirSync(DIST, { recursive: true });
  const zip = makeZip(entries);
  const out = join(DIST, id + (noOnline ? '-nonet' : '') + '.zip');
  writeFileSync(out, zip);
  return { id, out, files: entries.length, unpacked: total, zipped: zip.length, note: PLATFORMS[id].note + (noOnline ? ' (без онлайна)' : '') };
}

const noOnline = process.argv.includes('--no-online');   // dist/<площадка>-nonet.zip: без «Играть с друзьями» (запасной вариант для модерации)
const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'));
const ids = wanted.length ? wanted : Object.keys(PLATFORMS);
for (const id of ids) if (!PLATFORMS[id]) { console.error('неизвестная площадка: ' + id + ' (есть: ' + Object.keys(PLATFORMS).join(', ') + ')'); process.exit(2); }
const kb = n => (n / 1024).toFixed(0) + ' КБ';
for (const id of ids) {
  const r = build(id, noOnline);
  console.log(`${relative(ROOT, r.out)}: ${r.files} файлов, распаковано ${kb(r.unpacked)}, архив ${kb(r.zipped)} — ${r.note}`);
}
