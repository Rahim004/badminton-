"""
Онлайн в настоящем headless Chrome: две вкладки (хост и гость) через транспорт 'bc'
(BroadcastChannel) с имитацией сети window.__netSim = {lag, jit, loss}.
  python3 tests/net_browser.py
Проверяет:
  * net.available() — да на http, нет во встроенном iframe;
  * лобби: вход по коду, «Готов», старт; «комната полна», «комната не найдена», разные версии;
  * розыгрыши без задержки и при пинге ~200 мс + джиттер + потери: оба человека — боты,
    жмут через настоящий ввод (input.inject → main.js → game.humanShot);
    удары гостя доходят и оцениваются хостом, счёт у обоих одинаковый;
  * свой игрок у гостя движется плавно; волан без телепортов;
  * вид гостя зеркальный (его сторона внизу), «вверх по экрану» = к сетке у обоих;
  * хост вышел — гость получает понятное сообщение; нет ошибок в консоли.
Скриншоты — в tests/screens/net_*.png.
"""
import http.server, socketserver, threading, os, sys, json, functools, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT = os.path.dirname(ROOT)
NAME = os.path.basename(ROOT)
SHOTS = os.path.join(ROOT, 'tests', 'screens')
os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=PARENT)
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

failures = []
def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

# Бот «человека» внутри страницы: автобег (сильный) + нажатие «Удар» через настоящий ввод за ~WINDUP до контакта.
BOT = r"""
(async (role) => {
  const { findContact } = await import('./src/player.js');
  const G = window.__game, game = G.game, net = window.__net;
  window.__bot = { presses: 0, frames: 0, maxJump: 0, maxShJump: 0, jumps: [], on: true };
  const B = window.__bot;
  let planned = null, last = null, lastSh = null, lastPhase = '';
  function tick() {
    if (!B.on) return;
    B.frames++;
    game.cfg.assistStrength = 'strong';
    const view = net._view && net._view();
    let me, sh;
    if (role === 'guest') { if (!view || !view.started) { requestAnimationFrame(tick); return; } me = view.sim; sh = view.shuttleAt(view.R); }
    else { me = game.human; sh = game.shuttle; }
    if (me && sh) {
      const si = role === 'guest' ? (view.srvLat || game.serveInfo) : game.serveInfo;
      const held = role === 'guest' ? sh.held : sh.state === 'held';
      if (held && si && si.serverTeam === me.team && si.serverIdx === me.idx && Math.random() < 0.03) { G.input.inject({ type: 'smart', dirX: 0, dirY: 0, source: 'button' }); B.presses++; }
      if (!held && sh.state === 'flight' && sh.lastHitTeam !== me.team && !me.swing) {
        if (!planned) planned = { d: 0.12 };
        const c = findContact(me, sh, 0.42);
        if (planned.d > 0 && c && c.t <= 0.125) { G.input.inject({ type: 'smart', dirX: 0, dirY: 0, source: 'button' }); planned.d = -1; B.presses++; }
      } else planned = null;
    }
    // Плавность на экране (то, что рисует render): свой игрок и волан.
    const p = game.human, s = game.shuttle;
    if (p && last && game.phase === 'rally' && lastPhase === 'rally') { const j = Math.hypot(p.x - last.x, p.y - last.y); if (j > B.maxJump) B.maxJump = j; if (j > 0.2) B.jumps.push(+j.toFixed(2)); }
    if (lastSh && s.state === 'flight' && lastSh.state === 'flight') B.maxShJump = Math.max(B.maxShJump, Math.hypot(s.x - lastSh.x, s.y - lastSh.y, s.z - lastSh.z));
    last = p ? { x: p.x, y: p.y } : null; lastSh = { x: s.x, y: s.y, z: s.z, state: s.state }; lastPhase = game.phase;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})
"""

COUNTERS = r"""
(() => {
  const game = window.__game.game;
  window.__cnt = { hits: {}, perfect: {}, whiffs: {}, points: 0, events: {} };
  const C = window.__cnt;
  for (const n of ['hit', 'whiff', 'point', 'land', 'net', 'serveReady', 'matchOver', 'serve']) game.on(n, e => {
    C.events[n] = (C.events[n] || 0) + 1;
    if (n === 'hit' && !e.serve) { const id = e.player.id; C.hits[id] = (C.hits[id] || 0) + 1; if (e.timing === 'perfect') C.perfect[id] = (C.perfect[id] || 0) + 1; }
    if (n === 'whiff') { const id = e.player.id; C.whiffs[id] = (C.whiffs[id] || 0) + 1; }
    if (n === 'point') C.points++;
  });
})()
"""

def page_errors(page, name, errs):
    page.on('pageerror', lambda e: errs.append(f'{name}: {e}'))
    page.on('console', lambda m: errs.append(f'{name} console: {m.text}') if m.type == 'error' else None)
    page.on('requestfailed', lambda r: errs.append(f'{name} request failed: {r.url}'))

def open_pair(browser, url, sim, w=844, h=390):
    ctx = browser.new_context(viewport={'width': w, 'height': h})
    if sim: ctx.add_init_script('window.__netSim = ' + json.dumps(sim) + ';')
    errs = []
    hp = ctx.new_page(); page_errors(hp, 'host', errs)
    gp = ctx.new_page(); page_errors(gp, 'guest', errs)
    for p in (hp, gp):
        p.goto(url)
        p.wait_for_function('window.__net && window.__game')
    return ctx, hp, gp, errs

def start_match(hp, gp, mode='singles'):
    r = hp.evaluate("m => window.__net.host({ mode: m, format: 'short', difficulty: 'amateur', profile: { id: 'h1', nick: 'Рахим', heroId: 'kai' }, transport: 'bc' })", mode)
    code = r['code']
    j = gp.evaluate("c => window.__net.join(c, { profile: { id: 'g1', nick: 'Друг', heroId: 'mira' }, transport: 'bc' })", code)
    return code, j

def run_rallies(hp, gp, seconds, tag):
    hp.evaluate(COUNTERS); gp.evaluate(COUNTERS)
    hp.evaluate(BOT + "('host')"); gp.evaluate(BOT + "('guest')")
    t0 = time.time()
    while time.time() - t0 < seconds:
        hp.wait_for_timeout(1000)
        hs = hp.evaluate('window.__game.state.phase')
        if hs == 'over': break
    # Стоп-кадр: хост «свернул вкладку» → матч стоит у всех, гость догоняет события.
    hp.evaluate('window.__game.game.netDriver.setHidden(true)')
    gp.wait_for_timeout(2500)
    res = {
        'host': hp.evaluate('({ score: window.__game.game.match.score, games: window.__game.game.match.games, cnt: window.__cnt, bot: window.__bot, dbg: window.__net.debug() })'),
        'guest': gp.evaluate('({ score: window.__game.game.match.score, games: window.__game.game.match.games, cnt: window.__cnt, bot: window.__bot, dbg: window.__net.debug(), paused: window.__game.game.paused })'),
    }
    hp.screenshot(path=os.path.join(SHOTS, f'net_{tag}_host.png'))
    gp.screenshot(path=os.path.join(SHOTS, f'net_{tag}_guest.png'))
    hp.evaluate('window.__game.game.netDriver.setHidden(false)')
    hp.evaluate('window.__bot.on = false'); gp.evaluate('window.__bot.on = false')
    return res

def main():
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/index.html'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])

        print('== доступность сети')
        ctx = browser.new_context()
        pg = ctx.new_page(); pg.goto(url); pg.wait_for_function('window.__net')
        check(pg.evaluate('window.__net.available()') is True, 'net.available() = true на http')
        wrap = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/tests/screens/_frame.html'
        with open(os.path.join(SHOTS, '_frame.html'), 'w') as f: f.write(f'<!doctype html><iframe id=f src="../../index.html" sandbox="allow-scripts allow-same-origin" width=600 height=300></iframe>')
        pg.goto(wrap); pg.wait_for_timeout(1500)
        fr = pg.frame_locator('#f')
        inner = [f for f in pg.frames if f != pg.main_frame][0]
        inner.wait_for_function('window.__net')
        check(inner.evaluate('window.__net.available()') is False, 'во встроенном iframe net.available() = false')
        txt = inner.evaluate("window.__net.host({mode:'singles'}).then(r => r.error)")
        check(txt == 'Онлайн-игра работает в версии на GitHub', 'host() в песочнице — понятное сообщение: ' + str(txt))
        ctx.close()

        print('== лобби и ошибки')
        ctx, hp, gp, errs = open_pair(browser, url, None)
        lobbies = []
        hp.evaluate("window.__lob = []; window.__net.on('lobby', l => window.__lob.push(l)); 0")   # «; 0» — иначе Playwright вызовет возвращённую off()
        code, j = start_match(hp, gp)
        check(len(code) == 5 and code.isalpha() and code.isupper(), 'код комнаты из 5 букв: ' + code)
        check(j.get('ok') is True, 'гость вошёл по коду')
        hp.wait_for_function('window.__lob.length && window.__lob[window.__lob.length - 1].slots.every(s => s.profile)', timeout=4000)
        lob = hp.evaluate('window.__lob[window.__lob.length - 1]')
        check(lob and [s['profile']['nick'] if s['profile'] else None for s in lob['slots']] == ['Рахим', 'Друг'], 'лобби: оба места заняты ' + json.dumps(lob and lob['slots'], ensure_ascii=False)[:200])
        check(lob and lob['canStart'] is False, 'старт нельзя, пока гость не «Готов»')
        r = hp.evaluate('window.__net.startMatch()')
        check(r['ok'] is False and 'Готов' in r['error'], 'startMatch без готовности → ' + r.get('error', ''))
        third = ctx.new_page(); page_errors(third, 'third', errs); third.goto(url); third.wait_for_function('window.__net')
        r3 = third.evaluate("c => window.__net.join(c, { profile: { nick: 'Третий' }, transport: 'bc' })", code)
        check(r3['ok'] is False and r3['error'] == 'В комнате уже играют двое', 'третий в 1×1 → «' + r3.get('error', '') + '»')
        r4 = third.evaluate("window.__net.join('QWXYZ', { profile: { nick: 'Т' }, transport: 'bc' })")
        check(r4['ok'] is False and 'не найдена' in r4['error'], 'нет комнаты → «' + r4.get('error', '') + '»')
        # Другая версия протокола: сырое hello с v=999.
        ver = third.evaluate("""c => new Promise(res => { const ch = new BroadcastChannel('volan1-' + c); ch.onmessage = e => { if (e.data.to === 'x1') { res(e.data.d); ch.close(); } };
            ch.postMessage({ from: 'x1', to: 'H', d: { t: 'hello', v: 999, pid: 'x1', profile: {} } }); setTimeout(() => res(null), 2000); })""", code)
        check(ver and ver.get('t') == 'ver', 'хост отвечает «ver» на чужую версию: ' + json.dumps(ver))
        third.close()
        gp.evaluate('window.__net.setReady(true)'); hp.wait_for_timeout(300)
        r = hp.evaluate('window.__net.startMatch()')
        check(r['ok'] is True, 'хост начал матч')
        gp.wait_for_function('window.__game.game.netDriver && window.__game.game.netDriver.replacesSim', timeout=5000)
        gp.wait_for_timeout(800)
        st = gp.evaluate('({ my: window.__game.game.human.id, side: window.__game.game.human.side, cam: window.__game.renderer.camera.humanSide, ui: document.querySelector(".screen.visible, .menu.visible") ? 1 : 0 })')
        hs = hp.evaluate('({ my: window.__game.game.human.id, side: window.__game.game.human.side, cam: window.__game.renderer.camera.humanSide })')
        check(st['my'] == 1 and hs['my'] == 0, 'у каждого свой игрок (хост 0, гость 1)')
        check(st['cam'] == st['side'] and hs['cam'] == hs['side'] and st['side'] == -hs['side'], f'зеркальный вид: камера на своей стороне (хост {hs["cam"]}, гость {st["cam"]})')
        # Альбом: камера сбоку, сетка справа от своего игрока → «вправо» = к сетке; портрет: «вверх» = к сетке.
        up = [pg.evaluate("""(async () => { const { screenDirToWorldAt } = await import('./src/input.js'); const G = window.__game, h = G.game.human;
                 const land = G.renderer.camera.orientation === 'landscape';
                 const w = screenDirToWorldAt(G.renderer, land ? 1 : 0, land ? 0 : 1, h.x, h.y); return { wx: w.x, side: h.side, land }; })()""") for pg in (hp, gp)]
        check(all(u['wx'] * u['side'] < -0.8 for u in up), 'джойстик «к сетке» ведёт к сетке и у хоста, и у гостя (зеркальный вид): ' + json.dumps(up))
        gp.screenshot(path=os.path.join(SHOTS, 'net_start_guest.png'))
        hp.screenshot(path=os.path.join(SHOTS, 'net_start_host.png'))
        print('== розыгрыши без задержки (25 с)')
        res = run_rallies(hp, gp, 25, 'fast')
        report(res, 'без задержки')
        # Хост выходит — гость получает сообщение.
        gp.evaluate("window.__end = null; window.__net.on('end', e => window.__end = e); 0")
        hp.evaluate('window.__net.leave()')
        gp.wait_for_timeout(1500)
        end = gp.evaluate('window.__end')
        check(end and end['reason'] == 'host-left' and end['message'] == 'Хост вышел из игры', 'хост вышел → у гостя «' + (end or {}).get('message', '') + '»')
        check(gp.evaluate('!window.__game.game.netDriver'), 'у гостя онлайн-режим снят')
        check(not errs, 'нет ошибок консоли: ' + json.dumps(errs[:5], ensure_ascii=False))
        ctx.close()

        print('== пинг ~200 мс + джиттер 40 мс + 4% потерь (60 с)')
        ctx, hp, gp, errs = open_pair(browser, url, {'lag': 100, 'jit': 40, 'loss': 0.04})
        code, j = start_match(hp, gp)
        check(j.get('ok') is True, 'вход по коду при задержке')
        gp.evaluate('window.__net.setReady(true)'); hp.wait_for_timeout(600)
        check(hp.evaluate('window.__net.startMatch()')['ok'] is True, 'старт при задержке')
        gp.wait_for_function('window.__game.game.netDriver && window.__game.game.netDriver.replacesSim', timeout=8000)
        res = run_rallies(hp, gp, 60, 'lag')
        report(res, 'пинг 200')
        g = res['guest']['dbg']
        check(g['ms'] > 150, 'пинг измерен у гостя: %d мс' % g['ms'])
        print('== реванш: конец матча → гость «Готов» → хост «Начать»')
        gp.evaluate("window.__ends = []; window.__net.on('end', e => window.__ends.push(e)); 0")
        hp.evaluate("window.__lob = []; window.__net.on('lobby', l => window.__lob.push(l)); 0")
        hp.evaluate('(() => { const m = window.__game.game.match; m.score = [10, 0]; })()')
        hp.evaluate("window.__bot.on = true; 0"); gp.evaluate("window.__bot.on = true; 0")
        hp.evaluate(BOT + "('host')"); gp.evaluate(BOT + "('guest')")
        gp.wait_for_function('window.__ends.length > 0', timeout=120000)
        e = gp.evaluate('window.__ends[0]')
        check(e['reason'] == 'over' and e['won'] is False and e['winner'] == 0, 'у гостя «end» с итогом матча: ' + json.dumps({k: e[k] for k in ('reason', 'winner', 'won')}))
        gp.evaluate('window.__net.setReady(true)')
        hp.wait_for_function('window.__lob.length && window.__lob[window.__lob.length - 1].canStart', timeout=5000)
        check(hp.evaluate('window.__net.startMatch()')['ok'] is True, 'реванш начат')
        gp.wait_for_function('window.__game.game.match.score[0] === 0 && window.__game.game.phase !== "over" && window.__game.game.netDriver.replacesSim', timeout=8000)
        gp.wait_for_timeout(6000)
        dg = gp.evaluate('JSON.stringify({ d: window.__net.debug(), ph: window.__game.game.phase, t: window.__game.game.time })')
        dh = hp.evaluate('JSON.stringify({ d: window.__net.debug(), ph: window.__game.game.phase, t: window.__game.game.time, p: window.__game.game.paused })')
        check(gp.evaluate('window.__net.debug().view.snaps') > 20, 'у гостя идут снимки нового матча ' + dg[:300] + ' | ' + dh[:300])
        check(not errs, 'нет ошибок консоли: ' + json.dumps(errs[:5], ensure_ascii=False))
        ctx.close()

        print('== 2×2: хост и гость против двух ИИ? (по умолчанию гость — соперник, у каждого ИИ-напарник), пинг 300 мс (60 с)')
        ctx, hp, gp, errs = open_pair(browser, url, {'lag': 150, 'jit': 30, 'loss': 0.02}, 390, 844)
        code, j = start_match(hp, gp, 'doubles')
        gp.evaluate('window.__net.setReady(true)'); hp.wait_for_timeout(800)
        check(hp.evaluate('window.__net.startMatch()')['ok'] is True, 'старт 2×2')
        gp.wait_for_function('window.__game.game.netDriver && window.__game.game.netDriver.replacesSim', timeout=8000)
        n = gp.evaluate('window.__game.game.players.map(p => p.controller).join(",")')
        check(n == 'remote,ai,human,ai', 'места 2×2 у гостя: ' + n)
        res = run_rallies(hp, gp, 60, 'doubles')
        report(res, '2×2', guest_id=2, min_hits=2)   # в паре часть воланов берёт ИИ-напарник
        check(not errs, 'нет ошибок консоли: ' + json.dumps(errs[:5], ensure_ascii=False))
        ctx.close()
        browser.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('ВСЁ OK' if not failures else 'ОШИБКИ: ' + '; '.join(failures)))
    sys.exit(1 if failures else 0)

def report(res, tag, guest_id=1, min_hits=3):
    h, g = res['host'], res['guest']
    hc = h['cnt']; gid = str(guest_id)
    hits = hc['hits'].get(gid, 0); perfect = hc['perfect'].get(gid, 0); wh = hc['whiffs'].get(gid, 0)
    print('   ', json.dumps({'score': h['score'], 'guestScore': g['score'], 'hostEv': hc['events'], 'guestEv': g['cnt']['events'], 'guestHits(host)': hits, 'perfect': perfect, 'whiffs': wh,
          'botPresses': g['bot']['presses'], 'maxJump': round(g['bot']['maxJump'], 3), 'jumps': g['bot']['jumps'][:8], 'maxShJump': round(g['bot']['maxShJump'], 2), 'view': g['dbg'].get('view')}, ensure_ascii=False))
    check(h['score'] == g['score'] and h['games'] == g['games'], f'{tag}: одинаковый счёт у обоих {h["score"]} / {g["score"]}')
    check(g['paused'] is True, f'{tag}: пауза хоста видна у гостя')
    check(hits >= min_hits, f'{tag}: удары гостя засчитаны хостом ({hits})')
    check(hits and perfect / hits >= 0.4, f'{tag}: вовремя нажатые удары гостя — «идеально» у хоста ({perfect}/{hits})')
    check(wh <= max(2, hits * 0.2), f'{tag}: мало промахов гостя ({wh})')
    gh = g['cnt']['events'].get('hit', 0); hh = h['cnt']['events'].get('hit', 0)
    check(abs(gh - hh) <= 2, f'{tag}: звуки/эффекты ударов у гостя те же ({gh} / {hh})')
    gl = g['cnt']['events'].get('land', 0); hl = h['cnt']['events'].get('land', 0)
    check(abs(gl - hl) <= 1, f'{tag}: приземления у гостя те же ({gl} / {hl}) — волан не «падает» у соперника раньше его удара')
    check(g['bot']['maxJump'] < 0.25, f'{tag}: свой игрок у гостя без рывков (макс. {g["bot"]["maxJump"]:.3f} м/кадр)')

if __name__ == '__main__':
    main()
