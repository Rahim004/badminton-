"""Графика для Google Play: иконка 512x512 и рекламный баннер 1024x500 (headless Chrome, Playwright).
  python3 tools/play-graphics.py [папка_вывода]      (по умолчанию docs/play-store/graphics)
Фон баннера — настоящий кадр игры (смэш), без интерфейса; надпись тем же шрифтом и стилем, что логотип в меню."""
import http.server, socketserver, threading, os, sys, functools, re, io
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT, NAME = os.path.dirname(ROOT), os.path.basename(ROOT)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'play-store', 'graphics')
os.makedirs(OUT, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=PARENT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'

SETUP = open(os.path.join(ROOT, 'tools', 'play-store-shots.py'), encoding='utf-8').read().split("SETUP = '''")[1].split("'''")[0]

def to_rgba_png(img, path):
    img.convert('RGBA').save(path, 'PNG', optimize=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

    # ------------------------------------------------ иконка 512x512: полный квадрат без скруглений (Play скругляет сам)
    svg = open(os.path.join(ROOT, 'tools', 'icon.svg'), encoding='utf-8').read()
    svg = svg.replace('width="512" height="512">', 'width="100%" height="100%">', 1)
    pg = b.new_page(viewport={'width': 512, 'height': 512}, device_scale_factor=1)
    pg.set_content(f'<!doctype html><body style="margin:0;background:#17134a"><div style="width:512px;height:512px">{svg}</div></body>')
    pg.wait_for_timeout(300)
    png = pg.screenshot(clip={'x': 0, 'y': 0, 'width': 512, 'height': 512}, omit_background=False)
    to_rgba_png(Image.open(io.BytesIO(png)), os.path.join(OUT, 'icon-512.png'))
    pg.close()

    # ------------------------------------------------ кадр игры без интерфейса
    ctx = b.new_context(viewport={'width': 1024, 'height': 500}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.goto(BASE + '?mocknet')
    pg.wait_for_function('window.__game !== undefined'); pg.wait_for_timeout(1200)
    pg.add_style_tag(content='#ui{display:none !important}')
    pg.evaluate(SETUP)
    pg.evaluate('__game.startMatch({mode:"singles",difficulty:"legend",seed:23}); __game.forceAI(true); __game.freeze(true); __ev={}')
    ok = pg.evaluate('__sim(() => (__ev.hit||[]).some(e=>e.type==="smash"), 20000, 3)')
    assert ok
    shot = pg.screenshot()
    import base64
    bg_uri = 'data:image/png;base64,' + base64.b64encode(shot).decode()
    ctx.close()

    # ------------------------------------------------ баннер 1024x500
    html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face {{ font-family: "Unbounded"; font-weight: 200 900; src: url("{BASE}fonts/unbounded-cyrillic.woff2") format("woff2"); unicode-range: U+0400-045F, U+2116; }}
    @font-face {{ font-family: "Unbounded"; font-weight: 200 900; src: url("{BASE}fonts/unbounded-latin.woff2") format("woff2"); unicode-range: U+0000-00FF; }}
    html,body {{ margin:0; width:1024px; height:500px; overflow:hidden; background:#17134a; }}
    .bg {{ position:absolute; inset:0; background:url("{bg_uri}") center/cover; filter: saturate(1.1); }}
    .bg::after {{ content:""; position:absolute; inset:0; background:
        linear-gradient(180deg, rgba(15,11,52,1) 0, rgba(15,11,52,1) 66px, rgba(15,11,52,0) 150px),
        linear-gradient(90deg, rgba(15,11,52,.96) 0%, rgba(15,11,52,.88) 30%, rgba(15,11,52,.35) 58%, rgba(15,11,52,0) 78%),
        linear-gradient(0deg, rgba(15,11,52,.55), rgba(15,11,52,0) 40%); }}
    .copy {{ position:absolute; left:56px; top:0; bottom:0; display:flex; flex-direction:column; justify-content:center; gap:18px; }}
    .logo {{ font: 900 136px/0.95 "Unbounded", "Arial Black", sans-serif; letter-spacing:-0.035em; color:#fff; transform: skewX(-9deg); transform-origin:left;
        text-shadow: 7px 7px 0 #ff3d6e, 14px 14px 0 rgba(15,11,52,.6); display:flex; align-items:center; gap:14px; white-space:nowrap; }}
    .mark {{ flex:none; color:#ffd23f; width:84px; height:84px; transform: rotate(28deg) translateY(-8%); filter: drop-shadow(5px 5px 0 #ff3d6e); }}
    .tag {{ display:inline-block; align-self:flex-start; font: 700 27px/1.25 system-ui, "Segoe UI", Roboto, sans-serif; color:#fff; background:rgba(15,11,52,.7);
        padding:8px 16px; border-left:6px solid #ffd23f; max-width:470px; }}
    .pills {{ display:flex; gap:10px; }}
    .pills span {{ font: 800 19px/1 system-ui, "Segoe UI", Roboto, sans-serif; color:#221800; background:#ffd23f; padding:9px 16px; transform: skewX(-9deg); }}
    .pills span.b {{ background:#2fb8ff; color:#04243a; }}
    </style></head><body><div class="bg"></div>
    <div class="copy"><div class="logo"><span>Волан</span><svg class="mark" viewBox="0 0 24 24">
    <path d="M12 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M9 18 5 4l4 2 3-3 3 3 4-2-4 14Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 3v15M9 6l.8 12M15 6l-.8 12" stroke="currentColor" stroke-width="1.2" opacity=".7"/></svg></div>
    <div class="tag">Бадминтон в аниме-стиле: против ИИ и с друзьями онлайн</div>
    <div class="pills"><span>1 × 1</span><span>2 × 2</span><span class="b">ОНЛАЙН</span></div></div></body></html>'''
    pg = b.new_page(viewport={'width': 1024, 'height': 500}, device_scale_factor=1)
    pg.goto(BASE + 'privacy.html')   # любая страница с нашего сервера: шрифты берутся по полным адресам
    pg.set_content(html)
    pg.wait_for_timeout(1500)
    png = pg.screenshot(clip={'x': 0, 'y': 0, 'width': 1024, 'height': 500})
    img = Image.open(io.BytesIO(png)).convert('RGB')   # без прозрачности: баннер Play должен быть непрозрачным
    img.save(os.path.join(OUT, 'feature-graphic-1024x500.png'), 'PNG', optimize=True)
    b.close()
httpd.shutdown()
print('готово:', OUT)
