// Звуковой банк: синтез без WebAudio (Node). node --test tests/audio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECIPES, HIT_TYPES, renderSound, startSound, rateFor } from '../src/audio/bank.js';
import { peak, bandEnergy } from '../src/audio/dsp.js';
import { SHOTS } from '../src/config.js';

const SR = 48000;
const cache = new Map();
const get = (n, v = 0) => { const k = n + '#' + v; if (!cache.has(k)) cache.set(k, renderSound(n, SR, v)); return cache.get(k); };
const dur = (n, v = 0) => get(n, v)[0].length / rateFor(n, SR);

test('у каждого типа удара из SHOTS есть звук', () => {
  for (const t of Object.keys(SHOTS)) assert.ok(HIT_TYPES.includes(t), t);
});

test('все рецепты и варианты: конечные значения, без клиппинга, не тишина, тихий хвост', () => {
  for (const [n, R] of Object.entries(RECIPES)) {
    for (let v = 0; v < R.variants; v++) {
      const chs = get(n, v);
      assert.ok(chs.length === 1 || chs.length === 2, n);
      for (const c of chs) {
        assert.equal(c.length, chs[0].length, n + ': каналы одной длины');
        for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) assert.fail(`${n}#${v}: NaN @${i}`);
        const p = peak(c);
        assert.ok(p <= 1, `${n}#${v}: пик ${p}`);
        if (n !== 'hallIR') assert.ok(p > 0.02, `${n}#${v}: тишина (${p})`);
        if (R.cat !== 'amb') assert.ok(Math.abs(c[c.length - 1]) < 0.01, `${n}#${v}: щелчок в конце`);
      }
    }
  }
});

test('длительности разумны', () => {
  for (const t of HIT_TYPES) assert.ok(dur('hit_' + t) > 0.08 && dur('hit_' + t) < 0.6, t);
  assert.ok(dur('squeak') < 0.25 && dur('step') < 0.2);
  assert.ok(dur('tension') > 2.3 && dur('tension') < 3.5);
  assert.ok(dur('victory') > 2.5 && dur('victory') < 5);
  assert.ok(dur('murmur') >= 7.5 && dur('room') >= 5.5, 'петли достаточно длинные');
  assert.ok(dur('roar') > dur('cheer') && dur('cheer') > dur('applause'));
});

test('удары: смэш громче клира, клир громче укороченного и сетки', () => {
  const pk = t => peak(get('hit_' + t)[0]);
  assert.ok(pk('smash') > pk('clear') && pk('clear') > pk('drop') && pk('drop') > pk('net'));
});

test('драйв — щелчок ярче мягкого укороченного; бум — низы', () => {
  const bright = n => { const x = get(n)[0]; return bandEnergy(x, SR, 3000, 7000) / (bandEnergy(x, SR, 150, 900) + 1e-9); };
  assert.ok(bright('hit_drive') > bright('hit_drop'), `${bright('hit_drive')} vs ${bright('hit_drop')}`);
  const b = get('boom')[0];
  assert.ok(bandEnergy(b, SR, 30, 120) > bandEnergy(b, SR, 1000, 4000) * 5);
  const sh = get('shing')[0];
  assert.ok(bandEnergy(sh, SR, 2000, 7000) > bandEnergy(sh, SR, 100, 1500) * 5, 'шинь — высокий');
});

test('петли бесшовные (стык без скачка)', () => {
  for (const n of ['air', 'room', 'murmur']) {
    for (const c of get(n)) {
      const jump = Math.abs(c[0] - c[c.length - 1]);
      assert.ok(jump < 0.2, `${n}: скачок на стыке ${jump}`);
    }
  }
});

test('детерминированность и порционный синтез тяжёлых рецептов', () => {
  const a = renderSound('hit_clear', SR, 1)[0], b = renderSound('hit_clear', SR, 1)[0];
  assert.deepEqual(a, b);
  const it = startSound('murmur', SR, 0);
  let steps = 0, s;
  do { s = it.next(); steps++; } while (!s.done);
  assert.ok(steps > 10, `мурмур синтезируется порциями (${steps})`);
  assert.equal(s.value[0].length, get('murmur')[0].length);
});

test('толпа и фон синтезируются на пониженной частоте', () => {
  assert.equal(rateFor('murmur', 48000), 22050);
  assert.equal(rateFor('hit_smash', 44100), 44100);
});
