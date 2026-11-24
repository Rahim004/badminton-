/**
 * net/debug.js — минимальное отладочное лобби для разработки сети (не настоящий интерфейс!).
 * Открывается по index.html#netdebug. Настоящее лобби делает агент «Профиль и лобби» (src/ui/*).
 */
export function mountNetDebug(net, game) {
  const box = document.createElement('div');
  box.id = 'netdebug';
  box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:9999;background:rgba(10,8,30,.88);color:#fff;font:12px/1.35 system-ui,sans-serif;padding:8px;border-radius:8px;max-width:300px';
  box.innerHTML = `
    <div><b>net debug</b> <span id="nd-av"></span></div>
    <div style="margin:4px 0"><button id="nd-h1">Хост 1×1</button> <button id="nd-h2">Хост 2×2</button></div>
    <div><input id="nd-code" placeholder="КОД" maxlength="5" style="width:70px;text-transform:uppercase"> <button id="nd-join">Войти</button>
    <button id="nd-ready">Готов</button> <button id="nd-start">Старт</button> <button id="nd-leave">Выйти</button></div>
    <div id="nd-st" style="margin-top:4px;opacity:.85"></div><div id="nd-lob" style="opacity:.85"></div><div id="nd-ping" style="opacity:.7"></div>`;
  document.body.appendChild(box);
  const $ = id => box.querySelector('#' + id);
  const kind = /bc/.test(location.hash) ? 'bc' : undefined;
  const profile = { id: 'dbg' + Math.random().toString(36).slice(2, 8), nick: 'Тест' + ((Math.random() * 90 + 10) | 0), heroId: 'kai' };
  $('nd-av').textContent = net.available() ? 'сеть: да' : 'сеть: нет';
  $('nd-h1').onclick = async () => { const r = await net.host({ mode: 'singles', profile, transport: kind }); $('nd-code').value = r.code || ''; };
  $('nd-h2').onclick = async () => { const r = await net.host({ mode: 'doubles', profile, transport: kind }); $('nd-code').value = r.code || ''; };
  $('nd-join').onclick = () => net.join($('nd-code').value, { profile, transport: kind });
  let rd = false;
  $('nd-ready').onclick = () => { rd = !rd; net.setReady(rd); };
  $('nd-start').onclick = () => net.startMatch();
  $('nd-leave').onclick = () => net.leave();
  net.on('status', e => { $('nd-st').textContent = e.text; });
  net.on('error', e => { $('nd-st').textContent = '⚠ ' + e.message; });
  net.on('lobby', l => { $('nd-lob').textContent = l.code + ' · ' + l.slots.map(s => `${s.team}/${s.seat}:${s.profile ? s.profile.nick + (s.ready ? '✓' : '') : s.ai ? 'ИИ' : '—'}`).join(' '); });
  net.on('ping', p => { const i = net.info(); $('nd-ping').textContent = `${i.role || '-'} ${i.route} ${p.ms} мс ${p.warn || ''}`; });
  net.on('end', e => { if (e.message) $('nd-st').textContent = e.message; });
  const room = net.roomFromHash(); if (room) $('nd-code').value = room;
  return box;
}
