// Список файлов игры, нужных для офлайн-работы (кэш service worker, APK, десктоп-приложение).
// Используют: tools/gen-sw.mjs, tools/stage-web.mjs, tests/pwa.test.mjs.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP = ['index.html', 'styles.css', 'manifest.webmanifest'];
const DIRS = { src: /\.js$/, fonts: /\.woff2$/, vendor: /\.js$/, icons: /\.png$/ };

function walk(dir, re, out) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(n)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
}
export function listWebFiles() {
  const out = [...TOP];
  for (const [d, re] of Object.entries(DIRS)) walk(join(ROOT, d), re, out);
  return out;
}
