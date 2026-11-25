// Политика конфиденциальности (privacy.html) должна перечислять все серверы, к которым ходит онлайн-режим.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MQ_BROKERS } from '../src/net/transport.js';
import { PRIVACY_URL } from '../src/version.js';

const html = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
const src = readFileSync(new URL('../src/net/transport.js', import.meta.url), 'utf8');

test('privacy.html перечисляет все MQTT-брокеры', () => {
  for (const [url] of MQ_BROKERS) assert.ok(html.includes(new URL(url).hostname), 'нет в политике: ' + url);
});
test('privacy.html перечисляет STUN-серверы', () => {
  for (const m of src.matchAll(/stun:([a-z0-9.\-]+):\d+/g)) assert.ok(html.includes(m[1]), 'нет в политике: ' + m[1]);
});
test('ссылка на политику ведёт на privacy.html сайта, страница на русском и английском', () => {
  assert.equal(PRIVACY_URL, 'https://rahim004.github.io/badminton-/privacy.html');
  assert.match(html, /id="ru"[^>]*lang="ru"/); assert.match(html, /id="en"[^>]*lang="en"/);
});
