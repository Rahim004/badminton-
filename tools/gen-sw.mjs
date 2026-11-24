// Обновляет список файлов для офлайн-кэша внутри sw.js.  node tools/gen-sw.mjs  (--check — только проверка)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, listWebFiles } from './webfiles.mjs';

const swPath = join(ROOT, 'sw.js');
const src = readFileSync(swPath, 'utf8');
const list = ['./', ...listWebFiles().map(f => './' + f)];
const h = createHash('sha1');
for (const f of listWebFiles()) { h.update(f + '\0'); h.update(readFileSync(join(ROOT, f))); }
const build = h.digest('hex').slice(0, 8);
const block = '/*FILES*/ [\n' + list.map(f => `  ${JSON.stringify(f)},`).join('\n') + '\n] /*END*/';
let next = src.replace(/\/\*FILES\*\/[\s\S]*?\/\*END\*\//, () => block);
next = next.replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`);
if (process.argv.includes('--check')) {
  if (next !== src) { console.error('sw.js: список файлов устарел, запустите node tools/gen-sw.mjs'); process.exit(1); }
  console.log('sw.js: список файлов актуален (' + list.length + ')');
} else { writeFileSync(swPath, next); console.log('sw.js обновлён: ' + list.length + ' файлов'); }
