"""
Управление в настоящем headless Chrome: живая игра «пальцами» через CDP multi-touch.
  python3 tests/controls_browser.py
Проверяет (портрет 390x844 и альбом 844x390 с тачем, ПК 1366x768):
  * кнопки на экране; подача «Удар» — короткая, «Клир» — длинная;
  * розыгрыши против Новичка и Любителя: палец держит джойстик и ведёт игрока
    к точке перехвата, второй палец жмёт кнопку удара — удары доходят;
  * удары во время движения (мультитач), отмена касания, поворот экрана;
  * режим свайпов, раздел «Управление» в паузе, левша;
  * ПК: стрелки + Shift, легенда клавиш;
  * нет ошибок в консоли, страница не прокручивается.
Скриншоты — в tests/screens/controls/.
"""
import http.server, socketserver, threading, os, sys, json, functools, time, math
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT = os.path.dirname(ROOT)
NAME = os.path.basename(ROOT)
SHOTS = os.path.join(ROOT, 'tests', 'screens', 'controls')
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
    print(('  ok  ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: failures.append(msg)


HELPER = r"""
(async () => {
  const { predictTrajectory } = await import('./src/physics.js');
  const { interceptPlan } = await import('./src/ai.js');
  window.__log = { hits: [], whiffs: 0, serves: [], opp: 0, lost: 0, whiffInfo: [] };
  if (window.__ctl) return;
  const G = __game.game;
  G.on('hit', e => { if (e.player.controller === 'human' && !G.aiControlsHuman) {
    if (e.serve) __log.serves.push(e.type);
    else __log.hits.push({ type: e.type, timing: e.timing, joy: __game.input.state.joystick.active, mag: __game.input.state.joystick.mag }); } });
  G.on('whiff', e => { if (e.player.controller === 'human') { __log.whiffs++;
    const h = e.player, sh = G.shuttle; __log.whiffInfo.push([+Math.hypot(sh.x - h.x, sh.y - h.y).toFixed(2), +sh.z.toFixed(2), sh.lastHitTeam === h.team]); } });
  // Возможности: удар соперника, после которого волан прилетел бы в корт человека.
  G.on('hit', e => { if (e.player.team !== G.human.team) __log.opp++; });
  // Пропущенные: очко сопернику с приземлением «в корт» на стороне человека.
  G.on('point', e => { if (e.reason === 'in' && e.winner !== G.human.team) { __log.lost++;
    const h = G.human, lp = G.lastPoint; __log.lostInfo = (__log.lostInfo || []).concat([[G.rally.lastType, +Math.hypot(lp.x - h.x, lp.y - h.y).toFixed(2)]]); } });
  window.__ctl = () => {
    const g = __game.game, h = g.human, sh = g.shuttle, r = __game.renderer;
    if (!h) return null;
    const inc = g.phase === 'rally' && sh.state === 'flight' && sh.lastHitTeam !== h.team;
    let tx = h.side * 3.3, ty = 0;
    if (inc) {
      const pl = interceptPlan(h, predictTrajectory(sh, 4, 1), 0, g);
      if (pl) { tx = pl.x + h.side * (pl.z > 1.9 ? 0.25 : 0.05); ty = pl.y + 0.21 * (pl.y > h.y ? -1 : 1); }
    }
    const a = r.project(h.x, h.y, 0), b = r.project(tx, ty, 0);
    let sx = b.x - a.x, sy = -(b.y - a.y);
    const l = Math.hypot(sx, sy) || 1;
    const dist = Math.hypot(tx - h.x, ty - h.y);
    const reach = g.humanReach;
    const serveMine = g.phase === 'serve' && g.serveInfo.serverTeam === h.team && g.serveInfo.serverIdx === h.idx;
    return { phase: g.phase, inc, dist, dx: sx / l, dy: sy / l, tLeft: reach ? reach.t - (g.time - reach.at) : null,
             pending: !!g.pendingShot, swing: !!h.swing, serveMine, over: g.phase === 'over', score: g.match.score.slice(),
             time: g.time, hits: (g.match.score[0] + g.match.score[1]) * 1000 + sh.hits };
  };
})()
"""


class Fingers:
    """Несколько пальцев: каждое событие CDP несёт ВСЕ активные касания."""
    def __init__(self, cdp):
        self.cdp, self.pts = cdp, {}
    def _send(self, typ):
        pts = [{'x': x, 'y': y, 'id': i, 'radiusX': 8, 'radiusY': 8, 'force': 1} for i, (x, y) in self.pts.items()]
        self.cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': pts})
    def down(self, i, x, y):
        self.pts[i] = (x, y); self._send('touchStart')
    def move(self, i, x, y):
        self.pts[i] = (x, y); self._send('touchMove')
    def up(self, i):
        # touchEnd с одним отпущенным пальцем: остальные продолжают касаться.
        if i not in self.pts: return
        x, y = self.pts.pop(i)
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': [{'x': x, 'y': y, 'id': i}]})
    def cancel(self):
        self.pts.clear(); self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchCancel', 'touchPoints': []})


def button(page, bid):
    return page.evaluate(f'(() => {{ const b = __game.input.layout.buttons.find(b => b.id === "{bid}"); return [b.x, b.y, b.r]; }})()')


def tap(page, f, fid, x, y, hold=45):
    f.down(fid, x, y); page.wait_for_timeout(hold); f.up(fid)


def play_touch(page, f, w, h, seconds, label, shot_mix=('smart',)):
    """Живая игра: палец 0 — джойстик, палец 1 — кнопки."""
    jx, jy = (w * 0.22, h * 0.72)
    rad = page.evaluate('Math.max(46, Math.min(72, Math.min(innerWidth, innerHeight) * 0.15))')
    f.down(0, jx, jy)
    joy_down = True
    t_end = time.time() + seconds
    pressed_for = -1
    k = 0
    while time.time() < t_end:
        c = page.evaluate('__ctl()')
        if not c or c['over']: break
        if c['phase'] == 'serve' and c['serveMine']:
            bx, by, _ = button(page, 'smart' if k % 2 == 0 else 'clear'); k += 1
            page.wait_for_timeout(250)
            tap(page, f, 1, bx, by)
            page.wait_for_timeout(150)
            continue
        if c['phase'] == 'rally':
            m = min(1.0, c['dist'] / 0.6) if c['dist'] > 0.12 else 0.0
            f.move(0, jx + c['dx'] * rad * m, jy - c['dy'] * rad * m)
            if c['inc'] and c['tLeft'] is not None and c['tLeft'] < 0.24 and pressed_for != c['hits'] and not c['pending'] and not c['swing']:
                bid = shot_mix[k % len(shot_mix)]; k += 1
                bx, by, _ = button(page, bid)
                f.down(1, bx, by); page.wait_for_timeout(40); f.up(1)
                pressed_for = c['hits']
        else:
            f.move(0, jx, jy)
        page.wait_for_timeout(15)
    f.up(0)
    log = page.evaluate('__log')
    return log


def new_page(browser, w, h, mobile):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1,
                              is_mobile=mobile, has_touch=mobile)
    page = ctx.new_page()
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page, errors


def start_match(page, mobile, **opts):
    page.evaluate(f'__game.startMatch({json.dumps(opts)})')
    page.evaluate(HELPER)
    page.wait_for_timeout(200)


def run_touch(p, url, name, w, h):
    print(f'== {name} {w}x{h} (touch)', flush=True)
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx, page, errors = new_page(browser, w, h, True)
    page.goto(url)
    page.wait_for_function('window.__game !== undefined', timeout=10000)
    page.wait_for_timeout(600)
    page.tap('#start')
    page.wait_for_timeout(200)
    cdp = ctx.new_cdp_session(page)
    f = Fingers(cdp)

    # --- подача кнопками ---
    start_match(page, True, mode='singles', difficulty='novice', format='short', firstServer=0, seed=11)
    vis = page.evaluate('__game.input.buttonsVisible()')
    check(vis, f'{name}: кнопки ударов видны на телефоне по умолчанию')
    page.screenshot(path=f'{SHOTS}/{name}-serve-buttons.png')
    bx, by, br = button(page, 'smart')
    check(br >= 36, f'{name}: «Удар» крупная (r={br:.0f}px)')
    tap(page, f, 1, bx, by)
    page.wait_for_timeout(150)
    check(page.evaluate('__log.serves') == ['serveShort'], f'{name}: «Удар» на подаче — короткая ({page.evaluate("__log.serves")})')
    # Длинная подача «Клиром»: новая подача человека.
    start_match(page, True, mode='singles', difficulty='novice', format='short', firstServer=0, seed=12)
    cx, cy, _ = button(page, 'clear')
    tap(page, f, 1, cx, cy)
    page.wait_for_timeout(150)
    check(page.evaluate('__log.serves') == ['serveLong'], f'{name}: «Клир» на подаче — длинная ({page.evaluate("__log.serves")})')

    # --- живые розыгрыши: джойстик + кнопки одновременно ---
    for diff, secs, mix in (('novice', 40, ('smart', 'clear', 'smart', 'smashdrop')), ('amateur', 40, ('smart', 'net', 'clear', 'smart'))):
        start_match(page, True, mode='singles', difficulty=diff, format='quick', firstServer=0, seed=21, assistStrength='off')
        log = play_touch(page, f, w, h, secs, name, mix)
        hits = log['hits']; moving = [x for x in hits if x['joy'] and x['mag'] > 0.05]
        rate = len(hits) / max(1, len(hits) + log['lost'])
        timings = {}
        for x in hits: timings[x['timing']] = timings.get(x['timing'], 0) + 1
        types = sorted(set(x['type'] for x in hits))
        score = page.evaluate('__game.state.score')
        print(f'  {diff}: удары={len(hits)} пропущено={log["lost"]} удары соперника={log["opp"]} на бегу={len(moving)} промахи={log["whiffs"]} {log["whiffInfo"]} тайминг={timings} типы={types} счёт={score}')
        check(len(hits) >= 6 and rate >= 0.75, f'{name}/{diff}: удары пальцами доходят ({len(hits)} из {len(hits) + log["lost"]}, {rate:.0%})')
        check(len(moving) >= 2, f'{name}/{diff}: удар во время бега (мультитач) ({len(moving)})')
        check(log['whiffs'] <= max(2, len(hits) * 0.15), f'{name}/{diff}: мало промахов ({log["whiffs"]})')
    # Скриншот розыгрыша с джойстиком, кнопкой и кольцом тайминга.
    start_match(page, True, mode='singles', difficulty='novice', format='quick', firstServer=1, seed=5)
    page.evaluate('__game.runUntil(s => s.phase === "rally", 120*5)')
    page.evaluate('__game.freeze(true); __game.runUntil(s => { const r = __game.game.humanReach; return r && r.t < 0.3; }, 120*6)')
    jx, jy = w * 0.22, h * 0.72
    f.down(0, jx, jy); page.wait_for_timeout(30); f.move(0, jx + 30, jy - 25)
    bx, by, _ = button(page, 'smart')
    f.down(1, bx, by)
    page.wait_for_timeout(60)
    page.screenshot(path=f'{SHOTS}/{name}-rally-ring.png')
    f.up(1); f.up(0)
    page.evaluate('__game.freeze(false)')

    # --- отмена касания и поворот ---
    f.down(0, jx, jy); f.move(0, jx + 40, jy)
    page.wait_for_timeout(60)
    check(page.evaluate('__game.input.state.joystick.active'), f'{name}: джойстик активен')
    f.cancel(); page.wait_for_timeout(60)
    check(not page.evaluate('__game.input.state.joystick.active'), f'{name}: pointercancel отпускает джойстик')
    f.down(0, jx, jy); f.move(0, jx + 40, jy); page.wait_for_timeout(50)
    page.set_viewport_size({'width': h, 'height': w}); page.wait_for_timeout(300)
    check(not page.evaluate('__game.input.state.joystick.active'), f'{name}: поворот экрана сбрасывает джойстик')
    page.screenshot(path=f'{SHOTS}/{name}-rotated.png')
    f.cancel()
    page.set_viewport_size({'width': w, 'height': h}); page.wait_for_timeout(300)
    check(page.evaluate('document.scrollingElement.scrollTop + window.scrollY') == 0, f'{name}: страница не прокручивается')

    # --- раздел «Управление» в паузе ---
    page.tap('#pauseBtn'); page.wait_for_timeout(150)
    check(page.is_visible('#controlsSettings'), f'{name}: в паузе есть «Управление»')
    page.screenshot(path=f'{SHOTS}/{name}-pause-controls.png')
    page.tap('#controlsSettings [data-ctl="touchMode"] [data-value="swipes"]')
    page.tap('#controlsSettings [data-ctl="leftHanded"] [data-value="true"]')
    page.tap('#controlsSettings [data-ctl="buttonSize"] [data-value="l"]')
    page.tap('#controlsSettings [data-ctl="assist"] [data-value="strong"]')
    saved = page.evaluate('JSON.parse(localStorage.getItem("volan.settings")).controls')
    check(saved['touchMode'] == 'swipes' and saved['leftHanded'] is True and saved['buttonSize'] == 'l' and saved['assist'] == 'strong',
          f'{name}: настройки сохранены в volan.settings ({saved})')
    check(page.evaluate('__game.game.cfg.assistStrength') == 'strong', f'{name}: сила автобега применилась')
    page.tap('#resume'); page.wait_for_timeout(100)

    # --- свайпы ---
    start_match(page, True, mode='singles', difficulty='novice', format='quick', firstServer=0, seed=31)
    page.evaluate("""(() => { const g = __game.game; window.__cmd = []; const o = g.humanShot.bind(g), r = g.retypeHumanShot.bind(g);
        g.humanShot = (t, a) => { __cmd.push('shot:' + t); o(t, a); }; g.retypeHumanShot = (t, a) => { __cmd.push('re:' + t); return r(t, a); }; })()""")
    # Левша: джойстик справа, удары слева. Свайп вверх (длинный) на подаче — длинная подача.
    sx = w * 0.25
    f.down(1, sx, h * 0.7)
    for i in range(1, 6): f.move(1, sx, h * 0.7 - 32 * i); page.wait_for_timeout(16)
    f.up(1); page.wait_for_timeout(150)
    check(page.evaluate('__log.serves') == ['serveLong'], f'{name}: свайп вверх на подаче — длинная ({page.evaluate("__log.serves")}, {page.evaluate("__cmd")})')
    page.evaluate('__game.runUntil(s => s.phase === "rally" && s.shuttle.lastHitTeam === 1, 120*5)')
    page.evaluate('window.__cmd = []')
    tap(page, f, 1, sx, h * 0.5, hold=30)
    page.wait_for_timeout(50)
    f.down(1, sx, h * 0.4)
    for i in range(1, 5): f.move(1, sx + 2, h * 0.4 + 30 * i); page.wait_for_timeout(16)
    f.up(1); page.wait_for_timeout(80)
    cmds = page.evaluate('__cmd')
    check(cmds[:1] == ['shot:smart'] and 're:smashdrop' in cmds, f'{name}: тап — удар сразу на касание, свайп вниз уточняет до смэш/дроп ({cmds})')
    # Джойстик справа у левши.
    f.down(0, w * 0.8, h * 0.7); f.move(0, w * 0.8 - 40, h * 0.7); page.wait_for_timeout(50)
    check(page.evaluate('__game.input.state.joystick.active'), f'{name}: левша — джойстик справа')
    f.up(0)
    page.evaluate("""(async () => { const m = await import('./src/controlsSettings.js'); m.saveControls({ touchMode: 'buttons' }); })()""")
    page.wait_for_timeout(100)
    page.evaluate('__game.startMatch({mode:"singles",difficulty:"novice",firstServer:0,seed:3})')
    page.wait_for_timeout(150)
    page.screenshot(path=f'{SHOTS}/{name}-lefthanded-L.png')
    page.evaluate("""(async () => { const m = await import('./src/controlsSettings.js'); m.saveControls({ leftHanded: false, buttonSize: 'm', assist: 'auto' }); })()""")
    page.wait_for_timeout(100)

    check(not errors, f'{name}: нет ошибок в консоли {errors[:3]}')
    browser.close()


def run_desktop(p, url):
    name = 'desktop'
    print(f'== {name} 1366x768', flush=True)
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx, page, errors = new_page(browser, 1366, 768, False)
    page.goto(url)
    page.wait_for_function('window.__game !== undefined', timeout=10000)
    page.wait_for_timeout(500)
    page.click('#start'); page.wait_for_timeout(150)
    start_match(page, False, mode='singles', difficulty='novice', format='quick', firstServer=0, seed=41, assistStrength='off')
    check(not page.evaluate('__game.input.buttonsVisible()'), 'desktop: без тача кнопки не рисуются')
    page.screenshot(path=f'{SHOTS}/{name}-legend.png')
    page.keyboard.press('ShiftLeft'); page.wait_for_timeout(400)
    check(page.evaluate('__log.serves') == ['serveShort'], f'desktop: Shift — короткая подача ({page.evaluate("__log.serves")})')
    # Игра стрелками + Shift.
    held = set()
    def set_keys(want):
        for k in list(held - want): page.keyboard.up(k); held.discard(k)
        for k in want - held: page.keyboard.down(k); held.add(k)
    t_end = time.time() + 60
    pressed_for = -1
    keys = ['ShiftLeft', 'KeyZ', 'ShiftRight', 'KeyX']
    while time.time() < t_end:
        c = page.evaluate('__ctl()')
        if c['phase'] == 'serve' and c['serveMine']:
            set_keys(set()); page.wait_for_timeout(200); page.keyboard.press('Space'); page.wait_for_timeout(100); continue
        want = set()
        if c['phase'] == 'rally' and c['dist'] > 0.2:
            if c['dx'] > 0.38: want.add('ArrowRight')
            if c['dx'] < -0.38: want.add('ArrowLeft')
            if c['dy'] > 0.38: want.add('ArrowUp')
            if c['dy'] < -0.38: want.add('ArrowDown')
        set_keys(want)
        if c['inc'] and c['tLeft'] is not None and c['tLeft'] < 0.24 and pressed_for != c['hits'] and not c['pending'] and not c['swing']:
            page.keyboard.press(keys[max(0, pressed_for) % len(keys)]); pressed_for = c['hits']
        page.wait_for_timeout(15)
    set_keys(set())
    log = page.evaluate('__log')
    kh = len(log['hits']); krate = kh / max(1, kh + log['lost'])
    print(f'  клавиатура: удары={kh} пропущено={log["lost"]} промахи={log["whiffs"]} {log["whiffInfo"]} счёт={page.evaluate("__game.state.score")}')
    check(kh >= 6 and krate >= 0.7, f'desktop: стрелки + Shift/Z/X — удары доходят ({kh}, {krate:.0%})')
    page.keyboard.press('Escape'); page.wait_for_timeout(150)
    check(page.is_visible('#controlsSettings'), 'desktop: «Управление» в паузе')
    page.screenshot(path=f'{SHOTS}/{name}-pause.png')
    check(not errors, f'desktop: нет ошибок в консоли {errors[:3]}')
    browser.close()


def main():
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'
    with sync_playwright() as p:
        run_touch(p, url, 'portrait', 390, 844)
        run_touch(p, url, 'landscape', 844, 390)
        run_desktop(p, url)
    httpd.shutdown()
    print('\nИТОГ:', 'ВСЁ OK' if not failures else f'{len(failures)} ошибок')
    for m in failures: print('  -', m)
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
