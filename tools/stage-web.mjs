// Копирует файлы игры в каталог (для APK-ассетов и десктоп-приложения).  node tools/stage-web.mjs <dir>
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, listWebFiles } from './webfiles.mjs';

const dest = process.argv[2];
if (!dest) { console.error('usage: node tools/stage-web.mjs <dir>'); process.exit(2); }
rmSync(dest, { recursive: true, force: true });
const files = listWebFiles();
for (const f of files) { const t = join(dest, f); mkdirSync(dirname(t), { recursive: true }); cpSync(join(ROOT, f), t); }
console.log(`staged ${files.length} files -> ${dest}`);
