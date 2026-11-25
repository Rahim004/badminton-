"""Скриншоты для Google Play из настоящей игры (headless Chrome, Playwright).
  python3 tools/play-store-shots.py [папка_вывода]      (по умолчанию docs/play-store/graphics/screenshots)

Телефон 9:16: вьюпорт 360x640 при deviceScaleFactor=3 → 1080x1920; альбом 700x360 → 2100x1080.
Планшеты: 7" портрет 600x960 @2 → 1200x1920, 10" альбом 1280x800 @2 → 2560x1600.
User agent содержит «VolanApp» — игра ведёт себя как внутри приложения (без кнопок «Скачать»).
Онлайн-лобби строится на встроенной заглушке сети (?mocknet): тот же экран, что и в настоящей игре.
"""
import http.server, socketserver, threading, os, sys, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT, NAME = os.path.dirname(ROOT), os.path.basename(ROOT)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'play-store', 'graphics', 'screenshots')
os.makedirs(OUT, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=PARENT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'

SETUP = '''(() => { const r=__game.renderer; r.__orig=r.__orig||r.render; r.render=()=>{}; __game.freeze(true);
 window.__ev={}; const g=__game.game;
 for (const n of ['hit','point','net','land','game','serveReady']) g.on(n, e => { (__ev[n]=__ev[n]||[]).push(e); });
 window.__sim = (pred, maxF, after=0) => { const r=__game.renderer, g=__game.game; let f=0, hit=-1;
   for (; f<maxF; f++) { g.step(1/120); g.step(1/120); if (hit<0 && pred()) hit=f; const near = hit>=0 || f%6===5; if (!near) continue;
     r.__orig(g, __game.input, hit>=0 ? 1/60 : 6/60);
     if (hit<0 && pred()) hit=f; if (hit>=0 && f-hit>=after) break; }
   return hit>=0; }; })()'''

DEVICES = {
    'phone':   dict(w=360, h=640, dsf=3, touch=True),    # 1080x1920
    'phone-l': dict(w=700, h=360, dsf=3, touch=True),    # 2100x1080
    'tab7':    dict(w=600, h=960, dsf=2, touch=True),    # 1200x1920
    'tab10-l': dict(w=1280, h=800, dsf=2, touch=True),   # 2560x1600
}
UA_EXTRA = ' VolanApp/1.0 Android'
LOBBY_SCROLL = 330
RALLY_AFTER = int(os.environ.get('RALLY_AFTER', 16))
SMASH_AFTER = int(os.environ.get('SMASH_AFTER', 3))

def scroll_top(page, sel, y=0):
    # прокрутить прокручиваемый блок экрана sel на y CSS-пикселей от верха (0 — к началу)
    page.evaluate(f'''document.querySelectorAll("{sel}, {sel} *").forEach(e => {{ if (e.scrollHeight > e.clientHeight + 4 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = {y}; }})''')
    page.wait_for_timeout(150)

def start(page, o):
    page.evaluate(f'__game.startMatch({o}); __game.forceAI(true); __game.freeze(true); __ev={{}}')

def shoot_match(page, path, pred, o, maxf=20000, after=0, controls=True):
    start(page, o)
    ok = page.evaluate(f'__sim(() => {pred}, {maxf}, {after})')
    assert ok, f'не дождались: {pred}'
    if controls:   # на кадре показать экранные кнопки и кольцо тайминга, как у играющего человека
        page.evaluate('__game.forceAI(false); __game.renderer.__orig(__game.game, __game.input, 1/60)')
    page.screenshot(path=path)

def run(p, key, dev, which):
    print('==', key, dev)
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    errs = []
    ctx = b.new_context(viewport={'width': dev['w'], 'height': dev['h']}, device_scale_factor=dev['dsf'], is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' + UA_EXTRA)
    page = ctx.new_page()
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    page.on('pageerror', lambda e: errs.append(str(e)))
    f = lambda n: os.path.join(OUT, f'{key}-{n}.png')
    page.goto(BASE + '?mocknet')
    page.wait_for_function('window.__game !== undefined'); page.wait_for_timeout(1500)
    if 'menu' in which:
        page.screenshot(path=f('01-menu'))
    page.evaluate(SETUP)
    if 'rally' in which:
        shoot_match(page, f('02-rally'), '(__ev.hit||[]).length>=5 && __game.game.shuttle.z>2', '{mode:"singles",difficulty:"pro",seed:11}', 6000, RALLY_AFTER)
    if 'smash' in which:
        shoot_match(page, f('03-smash'), '(__ev.hit||[]).some(e=>e.type==="smash")', '{mode:"singles",difficulty:"legend",seed:23}', 20000, SMASH_AFTER, False)
    if 'over' in which:
        # итоги матча: «Победа» с реальной сеткой счёта
        start(page, '{mode:"singles",difficulty:"amateur",format:"short",seed:4}')
        page.evaluate('__game.forceAI(true)')
        page.evaluate('__game.renderer.render = __game.renderer.__orig; __game.freeze(false); __game.setSpeed(25)')
        page.wait_for_function('__game.game.phase==="over"', timeout=240000)
        page.evaluate('__game.setSpeed(1)')
        page.wait_for_timeout(2500)
        page.screenshot(path=f('05-over'))
    if 'ui' in which:
        # вернуть живой цикл и пройти интерфейс: профиль → герой → лобби
        page.reload(); page.wait_for_function('window.__game !== undefined'); page.wait_for_timeout(1200)
        page.tap('#playFriends'); page.wait_for_timeout(500)
        page.fill('#nickInput', 'Рахим')
        page.tap('[data-hero="mira"]'); page.tap('[data-kit="#2fb8ff"]'); page.wait_for_timeout(400)
        scroll_top(page, '#profileEdit')
        page.screenshot(path=f('04-hero'))
        page.tap('#profileSave'); page.wait_for_timeout(700)
        page.tap('#online [data-name="onlineMode"] [data-value="doubles"]')
        page.tap('#roomCreate'); page.wait_for_timeout(900)
        page.wait_for_timeout(2600)
        page.evaluate('__game.ui.online.net.__mock.fill()'); page.wait_for_timeout(4500)   # пусть исчезнет всплывашка «в комнате»
        scroll_top(page, '#lobby', LOBBY_SCROLL if dev['h'] > dev['w'] else 0)
        page.screenshot(path=f('06-lobby'))
    print('  ошибки консоли:', errs[:5])
    ctx.close(); b.close()

with sync_playwright() as p:
    full = ['menu', 'rally', 'smash', 'over', 'ui']
    run(p, 'phone', DEVICES['phone'], full)
    run(p, 'phone-landscape', DEVICES['phone-l'], ['menu', 'rally', 'smash'])
    run(p, 'tablet7', DEVICES['tab7'], ['menu', 'rally', 'smash', 'ui'])
    run(p, 'tablet10-landscape', DEVICES['tab10-l'], ['menu', 'rally', 'smash'])
httpd.shutdown()
