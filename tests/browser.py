"""
Проверка в настоящем headless Chrome (Playwright).
  python3 tests/browser.py
Поднимает статический сервер над родительской папкой, открывает игру по
подпути /badminton/ (как на GitHub Pages), проверяет:
  * нет ошибок в консоли и неудачных запросов;
  * портрет 390x844 (touch), альбом 844x390 (touch), десктоп 1366x768;
  * джойстик двигает игрока, тап подаёт, свайп бьёт;
  * матч ИИ против ИИ через __game доходит до конца с корректным счётом.
Скриншоты — в tests/screens/.
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
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

failures = []
def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

def touch(cdp, typ, pts):
    cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in pts]})

def drag(cdp, page, x0, y0, x1, y1, steps=8, hold=0.0, tid=0):
    touch(cdp, 'touchStart', [(tid, (x0, y0))])
    for i in range(1, steps + 1):
        touch(cdp, 'touchMove', [(tid, (x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps))])
        page.wait_for_timeout(16)
    if hold: page.wait_for_timeout(int(hold * 1000))
    touch(cdp, 'touchEnd', [])

def run_viewport(p, url, name, w, h, mobile):
    print(f'== {name} {w}x{h} touch={mobile}')
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1,
                              is_mobile=mobile, has_touch=mobile)
    page = ctx.new_page()
    errors, failed = [], []
    page.on('console', lambda m: errors.append(m.text + ' @ ' + str(m.location.get('url'))) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('requestfailed', lambda r: failed.append(r.url))
    page.goto(url)
    page.wait_for_function('window.__game !== undefined', timeout=10000)
    page.wait_for_timeout(1200)
    page.screenshot(path=f'{SHOTS}/{name}-menu.png')
    # Старт через кнопку меню (как пользователь).
    if mobile: page.tap('#start')
    else: page.click('#start')
    page.wait_for_timeout(300)
    st = page.evaluate('__game.state')
    check(st['phase'] == 'serve', f'{name}: матч начался с подачи (phase={st["phase"]})')
    check(st['players'][0]['controller'] == 'human', f'{name}: игрок 0 — человек')
    page.screenshot(path=f'{SHOTS}/{name}-serve.png')

    if mobile:
        cdp = ctx.new_cdp_session(page)
        # Джойстик: тянем влево-вверх в левой половине, держим.
        st0 = page.evaluate('__game.state')
        page.evaluate('__game.game.phase')
        # Подача тапом по правой половине.
        touch(cdp, 'touchStart', [(1, (w * 0.8, h * 0.6))]); page.wait_for_timeout(40); touch(cdp, 'touchEnd', [])
        page.wait_for_timeout(250)
        st1 = page.evaluate('__game.state')
        check(st1['phase'] in ('rally', 'point') or st1['rally']['hits'] >= 1 or st0['serverTeam'] != 0,
              f'{name}: тап — подача (phase={st1["phase"]}, hits={st1["rally"]["hits"]}, serverTeam={st0["serverTeam"]})')
        # Джойстик двигает человека.
        page.wait_for_timeout(100)
        page.evaluate('__game.game.cfg.assist = false')
        pa = page.evaluate('[__game.state.players[0].x, __game.state.players[0].y]')
        drag(cdp, page, w * 0.2, h * 0.75, w * 0.2 + 60, h * 0.75 - 10, steps=6, hold=0.5)
        pb = page.evaluate('[__game.state.players[0].x, __game.state.players[0].y]')
        moved = ((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5
        check(moved > 0.3, f'{name}: джойстик двигает игрока ({moved:.2f} м)')
        page.screenshot(path=f'{SHOTS}/{name}-joystick.png')
        # Свайп вверх (клир) регистрируется как команда.
        page.evaluate('window.__lastShots = []; __game.game.on("hit", e => { if (e.player.controller === "human") window.__lastShots.push(e.type) })')
        page.evaluate("""(() => { const g = __game.game; const orig = g.humanShot; window.__cmd = []; g.humanShot = (t, a) => { window.__cmd.push(t); orig(t, a); }; })()""")
        drag(cdp, page, w * 0.75, h * 0.7, w * 0.75, h * 0.7 - 160, steps=5)
        page.wait_for_timeout(60)
        drag(cdp, page, w * 0.75, h * 0.4, w * 0.75 + 5, h * 0.4 + 120, steps=5)
        page.wait_for_timeout(60)
        drag(cdp, page, w * 0.75, h * 0.6, w * 0.75, h * 0.6 - 50, steps=4)
        page.wait_for_timeout(100)
        cmds = page.evaluate('window.__cmd')
        check(cmds[:3] == ['clear', 'smash', 'net'], f'{name}: свайпы → {cmds}')
        page.evaluate('__game.game.cfg.assist = true')

    if not mobile:
        # Клавиатура: пробел — подача, A — движение, Esc — пауза.
        page.evaluate('__game.game.cfg.assist = false')
        st0 = page.evaluate('__game.state')
        if st0['serverTeam'] == 0:
            page.keyboard.press('Space'); page.wait_for_timeout(200)
            check(page.evaluate('__game.state.rally.hits') >= 1, 'desktop: пробел — подача')
        page.evaluate('__game.runUntil(s => s.phase === "rally", 120*10)')
        xa = page.evaluate('[__game.state.players[0].x, __game.state.players[0].y]')
        page.keyboard.down('KeyA'); page.wait_for_timeout(400); page.keyboard.up('KeyA')
        xb = page.evaluate('[__game.state.players[0].x, __game.state.players[0].y]')
        check(abs(xa[1] - xb[1]) > 0.3 or abs(xa[0] - xb[0]) > 0.3, f'desktop: клавиша A двигает игрока {xa} → {xb}')
        page.keyboard.press('Escape'); page.wait_for_timeout(150)
        check(page.is_visible('#pause'), 'desktop: Esc — пауза')
        page.screenshot(path=f'{SHOTS}/{name}-pause.png')
        page.click('#resume'); page.wait_for_timeout(100)
        check(not page.is_visible('#pause'), 'desktop: продолжить')
        page.evaluate('__game.game.cfg.assist = true')
        # Производительность отрисовки.
        ms = page.evaluate('''(() => { const r = __game.renderer, g = __game.game; const t0 = performance.now();
            for (let i = 0; i < 200; i++) r.render(g, __game.input, 1/60); return (performance.now() - t0) / 200; })()''')
        print(f'  render: {ms:.2f} мс/кадр')
        check(ms < 8, f'desktop: отрисовка быстрая ({ms:.2f} мс)')

    # Игра ИИ за человека, скриншоты розыгрыша.
    page.evaluate('__game.forceAI(true)')
    page.wait_for_timeout(2500)
    page.screenshot(path=f'{SHOTS}/{name}-rally.png')
    # Ловим момент высокого волана для скриншота.
    page.evaluate('__game.freeze(true)')
    ok = page.evaluate('__game.runUntil(s => s.phase === "rally" && s.shuttle.z > 2.2 && s.shuttle.vz < 0, 120*60)')
    page.wait_for_timeout(100)
    page.screenshot(path=f'{SHOTS}/{name}-highball.png')
    page.evaluate('__game.freeze(false)')
    # Смэш крупным планом: останавливаемся сразу после смэша.
    page.evaluate('__game.freeze(true); window.__sm = false; __game.game.on("hit", e => { if (e.type === "smash") window.__sm = true; })')
    page.evaluate('__game.runUntil(s => window.__sm && s.shuttle.state === "flight" && Math.abs(s.shuttle.x) < 2.5, 120*120)')
    page.wait_for_timeout(80)
    page.screenshot(path=f'{SHOTS}/{name}-smash.png')
    page.evaluate('__game.freeze(false)')
    # Конец матча → экран итогов.
    page.evaluate('__game.freeze(true); __game.startMatch({mode: "singles", difficulty: "novice", format: "short", seed: 3}); __game.forceAI(true); __game.runUntil(s => s.phase === "over", 120*60*20); __game.freeze(false)')
    page.wait_for_timeout(1300)
    check(page.is_visible('#over'), f'{name}: экран конца матча')
    page.screenshot(path=f'{SHOTS}/{name}-over.png')
    # Пара 2x2.
    page.evaluate('__game.startMatch({mode: "doubles", difficulty: "pro"}); __game.forceAI(true)')
    page.wait_for_timeout(3000)
    page.screenshot(path=f'{SHOTS}/{name}-doubles.png')
    check(len(page.evaluate('__game.state.players')) == 4, f'{name}: в паре 4 игрока')
    check(not errors, f'{name}: нет ошибок консоли {errors[:3]}')
    check(not failed, f'{name}: нет неудачных запросов {failed[:3]}')
    browser.close()

def run_full_match(p, url):
    print('== полный матч ИИ×ИИ в браузере (Профи, до 11)')
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 800, 'height': 600})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    page.wait_for_function('window.__game !== undefined')
    res = page.evaluate("""(() => {
      __game.freeze(true);
      __game.startMatch({mode: 'singles', difficulty: 'pro', format: 'short', seed: 42});
      __game.forceAI(true);
      const ok = __game.runUntil(s => s.phase === 'over', 120 * 60 * 30);
      const s = __game.state;
      const r = s.stats.rallies;
      return {ok, score: s.gameScores, winner: s.winner, avg: r.reduce((a,b)=>a+b,0)/r.length, n: r.length, faults: s.stats.faults};
    })()""")
    print('  ', json.dumps(res, ensure_ascii=False))
    check(res['ok'], 'матч завершился')
    a, b = res['score'][0]
    wv, lv = max(a, b), min(a, b)
    check((wv == 11 and lv <= 9) or (wv > 11 and wv - lv == 2) or wv == 15, f'счёт гейма корректен {a}:{b}')
    check(res['avg'] >= 6, f'средний розыгрыш ≥ 6 ({res["avg"]:.2f})')
    check(not errors, f'нет ошибок {errors[:2]}')
    browser.close()

if __name__ == '__main__':
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'
    with sync_playwright() as p:
        run_viewport(p, url, 'portrait', 390, 844, True)
        run_viewport(p, url, 'landscape', 844, 390, True)
        run_viewport(p, url, 'desktop', 1366, 768, False)
        run_full_match(p, url)
    httpd.shutdown()
    print('\nИТОГ:', 'ВСЁ OK' if not failures else f'{len(failures)} ошибок')
    sys.exit(1 if failures else 0)
