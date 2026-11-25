"""Картинки для порталов (itch.io, Яндекс Игры, CrazyGames) из настоящей игры — headless Chrome, Playwright, Pillow.
  python3 tools/portal-graphics.py [папка_вывода] [--video | --video-only]      (по умолчанию docs/portals/images; --video — ещё превью-ролики, --video-only — только ролики; нужен ffmpeg)

Кадры — живые матчи ИИ против ИИ без DOM-интерфейса (как в tools/play-store-shots.py), портреты героев — из
настоящего рендера персонажей (src/ui/portrait.js). Размеры взяты из документации площадок на 2026-11-25:
  itch.io       обложка 630x500 (рекомендация, макс. 3840x2160 и 3 МБ), скриншоты — любой размер до 3 МБ
  Яндекс Игры   иконка 512x512 PNG, обложка 800x470 PNG, главная обложка 1560x520 (необязательно),
                скриншоты 1280–2560 px по длинной стороне (JPEG/PNG), минимум 2 на платформу, геймплей >= 70% кадра;
                на иконке и обложке нельзя использовать скриншоты игры -> там портреты героев и логотип
  CrazyGames    обложки 1920x1080 (16:9), 800x1200 (2:3), 800x800 (1:1): без рамок, из текста только название игры
"""
import http.server, socketserver, threading, os, sys, functools, io, base64, json, shutil, subprocess, tempfile
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT, NAME = os.path.dirname(ROOT), os.path.basename(ROOT)
args = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = args[0] if args else os.path.join(ROOT, 'docs', 'portals', 'images')
VIDEO = '--video' in sys.argv or '--video-only' in sys.argv
VIDEO_ONLY = '--video-only' in sys.argv   # только ролики, без картинок
for d in ('itch', 'yandex', 'yandex/screenshots', 'crazygames'):
    os.makedirs(os.path.join(OUT, d), exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=PARENT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'

SETUP = open(os.path.join(ROOT, 'tools', 'play-store-shots.py'), encoding='utf-8').read().split("SETUP = '''")[1].split("'''")[0]
# Игра видит себя «на itch»: так включается английский (по настройке volan.lang) и нет кнопок установки.
def init_script(lang): return f"window.VOLAN_PLATFORM = 'itch'; try {{ localStorage.setItem('volan.lang', '\"{lang}\"'); }} catch (e) {{}}"

def png_to_img(b): return Image.open(io.BytesIO(b)).convert('RGB')
def data_uri(b, mime='image/png'): return f'data:{mime};base64,' + base64.b64encode(b).decode()
def save_png(img, path): img.convert('RGB').save(path, 'PNG', optimize=True); print('  ', os.path.relpath(path, ROOT), img.size, os.path.getsize(path) // 1024, 'КБ')
def save_jpg(img, path): img.convert('RGB').save(path, 'JPEG', quality=92, optimize=True); print('  ', os.path.relpath(path, ROOT), img.size, os.path.getsize(path) // 1024, 'КБ')

def new_game_page(b, w, h, dsf, lang, mobile):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dsf, is_mobile=mobile, has_touch=mobile, locale='en-US' if lang == 'en' else 'ru-RU')
    ctx.add_init_script(init_script(lang))
    page = ctx.new_page()
    page.goto(BASE + '?mocknet')
    page.wait_for_function('window.__game !== undefined'); page.wait_for_timeout(1500)
    return ctx, page

def match_frame(page, pred, opts, maxf, after, controls):
    page.evaluate(f'__game.startMatch({opts}); __game.forceAI(true); __game.freeze(true); __ev={{}}')
    ok = page.evaluate(f'__sim(() => {pred}, {maxf}, {after})')
    assert ok, 'не дождались: ' + pred
    if controls: page.evaluate('__game.forceAI(false); __game.renderer.__orig(__game.game, __game.input, 1/60)')
    return page.screenshot()

RALLY = ('(__ev.hit||[]).length>=5 && __game.game.shuttle.z>2', '{mode:"singles",difficulty:"pro",seed:11}', 6000, 16)
SMASH = ('(__ev.hit||[]).some(e=>e.type==="smash")', '{mode:"singles",difficulty:"legend",seed:23}', 20000, 3)
DOUBLES = ('(__ev.hit||[]).length>=4 && __game.game.shuttle.z>1.5', '{mode:"doubles",difficulty:"pro",seed:5}', 8000, 12)

def capture(b, w, h, dsf, lang, mobile, controls, kinds=('rally', 'smash', 'doubles')):
    ctx, page = new_game_page(b, w, h, dsf, lang, mobile)
    out = {}
    if 'menu' in kinds:
        out['menu'] = page.screenshot()
    page.add_style_tag(content='#ui{display:none !important}')
    page.evaluate(SETUP)
    for k, spec in (('rally', RALLY), ('smash', SMASH), ('doubles', DOUBLES)):
        if k in kinds: out[k] = match_frame(page, *spec, controls=controls and k != 'smash')
    ctx.close()
    return out

def portraits(b, heroes):
    """Портреты героев (PNG с прозрачностью) из настоящего рендера."""
    ctx = b.new_context(viewport={'width': 800, 'height': 800}, device_scale_factor=1)
    page = ctx.new_page(); page.goto(BASE + 'privacy.html')
    res = page.evaluate("""async (list) => {
      const m = await import('%ssrc/ui/portrait.js');
      const out = {};
      for (const [id, mood] of list) { const img = m.portrait(id, { size: 520, mood }); await new Promise(r => setTimeout(r, 900)); out[id] = img.src; }
      return out; }""" % BASE, heroes)
    ctx.close()
    return res

LOGO_SVG = '''<svg class="mark" viewBox="0 0 24 24"><path d="M12 21a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z" fill="currentColor"/><path d="M9 18 5 4l4 2 3-3 3 3 4-2-4 14Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 3v15M9 6l.8 12M15 6l-.8 12" stroke="currentColor" stroke-width="1.2" opacity=".7"/></svg>'''
FONTS = f'''@font-face {{ font-family: "Unbounded"; font-weight: 200 900; src: url("{BASE}fonts/unbounded-cyrillic.woff2") format("woff2"); unicode-range: U+0400-045F, U+2116; }}
@font-face {{ font-family: "Unbounded"; font-weight: 200 900; src: url("{BASE}fonts/unbounded-latin.woff2") format("woff2"); unicode-range: U+0000-00FF; }}'''

def render_html(b, html, w, h, wait=1500):
    pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=1)
    pg.goto(BASE + 'privacy.html')
    pg.set_content(html); pg.wait_for_timeout(wait)
    png = pg.screenshot(clip={'x': 0, 'y': 0, 'width': w, 'height': h}); pg.close()
    return png_to_img(png)

def cover_html(w, h, bg_uri, word, logo_px, tag=None, pills=(), mark=True, bg_pos='center', shade='left', mark_px=None, extra_css=''):
    """Обложка из кадра игры: тёмный градиент, логотип «в стиле меню», подпись и плашки."""
    mark_px = mark_px or int(logo_px * 0.62)
    grad = {
        'left': 'linear-gradient(90deg, rgba(15,11,52,.95) 0%, rgba(15,11,52,.8) 34%, rgba(15,11,52,.25) 62%, rgba(15,11,52,0) 80%), linear-gradient(0deg, rgba(15,11,52,.6), rgba(15,11,52,0) 42%)',
        'bottom': 'linear-gradient(0deg, rgba(15,11,52,.97) 0%, rgba(15,11,52,.85) 30%, rgba(15,11,52,.2) 58%, rgba(15,11,52,0) 75%), linear-gradient(180deg, rgba(15,11,52,.55), rgba(15,11,52,0) 24%)',
    }[shade]
    justify = 'center' if shade == 'left' else 'flex-end'
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{FONTS}
    html,body {{ margin:0; width:{w}px; height:{h}px; overflow:hidden; background:#17134a; }}
    .bg {{ position:absolute; inset:0; background:url("{bg_uri}") {bg_pos}/cover; }}
    .bg::after {{ content:""; position:absolute; inset:0; background:{grad}; }}
    .copy {{ position:absolute; left:{int(w*0.06)}px; right:{int(w*0.06)}px; top:0; bottom:{int(h*0.07) if shade == 'bottom' else 0}px; display:flex; flex-direction:column; justify-content:{justify}; gap:{int(logo_px*0.14)}px; }}
    .logo {{ font: 900 {logo_px}px/0.95 "Unbounded","Arial Black",sans-serif; letter-spacing:-0.035em; color:#fff; transform: skewX(-9deg); transform-origin:left;
        text-shadow: {logo_px*0.05:.0f}px {logo_px*0.05:.0f}px 0 #ff3d6e, {logo_px*0.1:.0f}px {logo_px*0.1:.0f}px 0 rgba(15,11,52,.6); display:flex; align-items:center; gap:{int(logo_px*0.1)}px; white-space:nowrap; }}
    .mark {{ flex:none; color:#ffd23f; width:{mark_px}px; height:{mark_px}px; transform: rotate(28deg) translateY(-8%); filter: drop-shadow({mark_px*0.06:.0f}px {mark_px*0.06:.0f}px 0 #ff3d6e); {'' if mark else 'display:none;'} }}
    .tag {{ display:inline-block; align-self:flex-start; font: 700 {int(logo_px*0.2)}px/1.25 system-ui,"Segoe UI",Roboto,sans-serif; color:#fff; background:rgba(15,11,52,.72); padding:{int(logo_px*0.06)}px {int(logo_px*0.12)}px; border-left:{int(logo_px*0.045)}px solid #ffd23f; max-width:{int(w*0.62)}px; }}
    .pills {{ display:flex; gap:{int(logo_px*0.07)}px; }}
    .pills span {{ font: 800 {int(logo_px*0.15)}px/1 system-ui,"Segoe UI",Roboto,sans-serif; color:#221800; background:#ffd23f; padding:{int(logo_px*0.07)}px {int(logo_px*0.12)}px; transform: skewX(-9deg); }}
    .pills span.b {{ background:#2fb8ff; color:#04243a; }}
    {extra_css}</style></head><body><div class="bg"></div>
    <div class="copy"><div class="logo"><span>{word}</span>{LOGO_SVG}</div>{f'<div class="tag">{tag}</div>' if tag else ''}
    {'<div class="pills">' + ''.join(f'<span class="{c}">{t}</span>' for t, c in pills) + '</div>' if pills else ''}</div></body></html>'''

def hero_art_html(w, h, P, word, logo_px, tag, layout):
    """Обложка без скриншотов (требование Яндекс Игр): герои, ракетки-лучи и логотип."""
    heroes = layout['heroes']   # [(id, left%, bottom%, size_px, rotate, z)]
    imgs = ''.join(f'<img src="{P[i]}" style="position:absolute;left:{x}%;bottom:{y}%;width:{s}px;height:{s}px;transform:rotate({r}deg);z-index:{z};filter:drop-shadow(0 {s*0.03:.0f}px {s*0.05:.0f}px rgba(0,0,0,.45))">' for i, x, y, s, r, z in heroes)
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{FONTS}
    html,body {{ margin:0; width:{w}px; height:{h}px; overflow:hidden; background:#17134a; }}
    .bg {{ position:absolute; inset:0; background:
        radial-gradient(ellipse at {layout['glow']}, rgba(255,61,110,.85) 0%, rgba(255,61,110,0) 55%),
        radial-gradient(ellipse at 10% 100%, rgba(47,184,255,.55) 0%, rgba(47,184,255,0) 50%),
        linear-gradient(135deg, #2a1d7a 0%, #17134a 55%, #0f0b34 100%); }}
    .rays {{ position:absolute; inset:-20%; background: repeating-conic-gradient(from 0deg at {layout['glow']}, rgba(255,255,255,.07) 0 6deg, rgba(255,255,255,0) 6deg 14deg); }}
    .court {{ position:absolute; left:-5%; right:-5%; bottom:0; height:{int(h*0.2)}px; background: linear-gradient(0deg, #0e8f5f, #14b87e); clip-path: polygon(6% 0, 94% 0, 100% 100%, 0 100%); opacity:.9; }}
    .court::before {{ content:""; position:absolute; left:50%; top:0; bottom:0; width:{max(3, int(h*0.008))}px; background:rgba(255,255,255,.8); }}
    .copy {{ position:absolute; {layout['copy']}; z-index:5; display:flex; flex-direction:column; gap:{int(logo_px*0.14)}px; }}
    .logo {{ font: 900 {logo_px}px/0.95 "Unbounded","Arial Black",sans-serif; letter-spacing:-0.035em; color:#fff; transform: skewX(-9deg); transform-origin:left;
        text-shadow: {logo_px*0.05:.0f}px {logo_px*0.05:.0f}px 0 #ff3d6e, {logo_px*0.1:.0f}px {logo_px*0.1:.0f}px 0 rgba(15,11,52,.6); display:flex; align-items:center; gap:{int(logo_px*0.1)}px; white-space:nowrap; }}
    .mark {{ flex:none; color:#ffd23f; width:{int(logo_px*0.62)}px; height:{int(logo_px*0.62)}px; transform: rotate(28deg) translateY(-8%); filter: drop-shadow({logo_px*0.04:.0f}px {logo_px*0.04:.0f}px 0 #ff3d6e); }}
    .tag {{ align-self:flex-start; font: 700 {int(logo_px*0.2)}px/1.25 system-ui,"Segoe UI",Roboto,sans-serif; color:#fff; background:rgba(15,11,52,.72); padding:{int(logo_px*0.06)}px {int(logo_px*0.12)}px; border-left:{int(logo_px*0.045)}px solid #ffd23f; }}
    </style></head><body><div class="bg"></div><div class="rays"></div><div class="court"></div>{imgs}
    <div class="copy"><div class="logo"><span>{word}</span>{LOGO_SVG}</div><div class="tag">{tag}</div></div></body></html>'''

def square_crop(img, cx=0.5, cy=0.5):
    w, h = img.size; s = min(w, h)
    x = int(max(0, min(w - s, cx * w - s / 2))); y = int(max(0, min(h - s, cy * h - s / 2)))
    return img.crop((x, y, x + s, y + s))

def fit_crop(img, tw, th, cx=0.5, cy=0.5):
    w, h = img.size; k = max(tw / w, th / h)
    img = img.resize((int(w * k) + 1, int(h * k) + 1), Image.LANCZOS)
    w, h = img.size
    x = int(max(0, min(w - tw, cx * w - tw / 2))); y = int(max(0, min(h - th, cy * h - th / 2)))
    return img.crop((x, y, x + tw, y + th))

def record_video(b, w, h, mobile, seconds, out_path, lang='en', seed=31):
    """Превью-ролик: живой матч ИИ против ИИ без интерфейса, запись экрана Playwright → mp4 без звука (ffmpeg)."""
    tmp = tempfile.mkdtemp(prefix='volan-video-')
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1, is_mobile=mobile, has_touch=mobile,
                        locale='en-US' if lang == 'en' else 'ru-RU', record_video_dir=tmp, record_video_size={'width': w, 'height': h})
    ctx.add_init_script(init_script(lang))
    page = ctx.new_page()
    page.goto(BASE + '?mocknet')
    page.wait_for_function('window.__game !== undefined'); page.wait_for_timeout(1200)
    page.add_style_tag(content='#ui{display:none !important}')
    page.evaluate(f'__game.startMatch({{mode:"singles",difficulty:"legend",seed:{seed}}}); __game.forceAI(true)')
    page.wait_for_timeout(int((seconds + 2.5) * 1000))
    page.close(); ctx.close()
    webm = [f for f in os.listdir(tmp) if f.endswith('.webm')][0]
    subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '2', '-i', os.path.join(tmp, webm), '-t', str(seconds), '-an',
                           '-vf', f'scale={w}:{h},fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out_path])
    print('  ', os.path.relpath(out_path, ROOT), f'{w}x{h}', seconds, 'с', os.path.getsize(out_path) // 1024, 'КБ')

def videos(b):
    print('видео…')
    record_video(b, 1280, 720, False, 20, os.path.join(OUT, 'yandex', 'video-horizontal-1280x720.mp4'), lang='ru')
    record_video(b, 720, 1280, True, 20, os.path.join(OUT, 'yandex', 'video-vertical-720x1280.mp4'), lang='ru')
    record_video(b, 1920, 1080, False, 18, os.path.join(OUT, 'crazygames', 'preview-landscape-1920x1080.mp4'))
    record_video(b, 720, 1080, True, 18, os.path.join(OUT, 'crazygames', 'preview-portrait-720x1080.mp4'))

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        if VIDEO_ONLY:
            videos(b); b.close(); print('готово:', OUT); return
        print('кадры игры…')
        land_en = capture(b, 1920, 1080, 1, 'en', False, False, ('menu', 'rally', 'smash', 'doubles'))
        land_ru = capture(b, 1920, 1080, 1, 'ru', False, False, ('menu', 'rally', 'smash', 'doubles'))
        port_ru = capture(b, 360, 640, 3, 'ru', True, True, ('rally', 'smash', 'doubles'))
        port_en = capture(b, 360, 640, 3, 'en', True, True, ('rally', 'smash'))
        P = portraits(b, [('mira', 'happy'), ('kai', 'calm'), ('timur', 'happy'), ('aya', 'calm'), ('niko', 'happy'), ('leo', 'calm')])

        # ---------------- itch.io: обложка 630x500 + скриншоты (английские, ссылка на кадры без интерфейса)
        print('itch.io')
        bg = data_uri(land_en['smash'])
        cover = render_html(b, cover_html(630, 500, bg, 'Volan', 92, tag='Anime-style badminton. Play vs AI or online with friends', pills=[('1 × 1', ''), ('2 × 2', ''), ('ONLINE', 'b')], bg_pos='62% center', mark_px=60), 630, 500)
        save_png(cover, os.path.join(OUT, 'itch', 'cover-630x500.png'))
        for name, key in (('screenshot-1-menu', 'menu'), ('screenshot-2-rally', 'rally'), ('screenshot-3-smash', 'smash'), ('screenshot-4-doubles', 'doubles')):
            save_jpg(png_to_img(land_en[key]).resize((1280, 720), Image.LANCZOS), os.path.join(OUT, 'itch', name + '.jpg'))
        save_jpg(png_to_img(port_en['rally']).resize((720, 1280), Image.LANCZOS), os.path.join(OUT, 'itch', 'screenshot-5-mobile.jpg'))
        # баннер страницы itch (необязательно): 960x300
        banner = render_html(b, cover_html(960, 300, bg, 'Volan', 120, tag='Anime-style badminton · vs AI & online', bg_pos='60% 40%', mark_px=76), 960, 300)
        save_png(banner, os.path.join(OUT, 'itch', 'banner-960x300.png'))

        # ---------------- Яндекс Игры
        print('Яндекс Игры')
        shutil.copyfile(os.path.join(ROOT, 'docs', 'play-store', 'graphics', 'icon-512.png'), os.path.join(OUT, 'yandex', 'icon-512.png'))
        print('   yandex/icon-512.png (из docs/play-store/graphics, иконка приложения)')
        art_cover = hero_art_html(800, 470, P, 'Волан', 108, 'Бадминтон: против ИИ и онлайн',
                                  dict(glow='72% 40%', copy='left:34px;top:30px', heroes=[('kai', 49, 1, 270, -4, 1), ('timur', 78, 1, 270, 5, 1), ('mira', 62, -3, 330, 0, 2)]))
        save_png(render_html(b, art_cover, 800, 470), os.path.join(OUT, 'yandex', 'cover-800x470.png'))
        art_feat = hero_art_html(1560, 520, P, 'Волан', 170, 'Бадминтон: против ИИ и с друзьями онлайн',
                                 dict(glow='70% 45%', copy='left:70px;top:70px', heroes=[('aya', 42, 2, 360, -5, 1), ('kai', 53, 2, 370, -3, 1), ('timur', 83, 2, 360, 5, 1), ('mira', 65, -3, 440, 0, 2)]))
        save_png(render_html(b, art_feat, 1560, 520), os.path.join(OUT, 'yandex', 'featured-1560x520.png'))
        for name, key in (('desktop-1-rally', 'rally'), ('desktop-2-smash', 'smash'), ('desktop-3-doubles', 'doubles')):
            save_jpg(png_to_img(land_ru[key]), os.path.join(OUT, 'yandex', 'screenshots', name + '.jpg'))
        for name, key in (('mobile-1-rally', 'rally'), ('mobile-2-smash', 'smash'), ('mobile-3-doubles', 'doubles')):
            save_jpg(png_to_img(port_ru[key]), os.path.join(OUT, 'yandex', 'screenshots', name + '.jpg'))

        # ---------------- CrazyGames
        print('CrazyGames')
        land = land_en['smash']; port = port_en['smash']
        cg_land = render_html(b, cover_html(1920, 1080, data_uri(land), 'Volan', 240, bg_pos='65% center', mark=False), 1920, 1080)
        save_png(cg_land, os.path.join(OUT, 'crazygames', 'cover-landscape-1920x1080.png'))
        cg_port = render_html(b, cover_html(800, 1200, data_uri(port), 'Volan', 150, bg_pos='center 35%', shade='bottom', mark=False), 800, 1200)
        save_png(cg_port, os.path.join(OUT, 'crazygames', 'cover-portrait-800x1200.png'))
        cg_sq_bg = square_crop(png_to_img(land), 0.62, 0.5).resize((1000, 1000), Image.LANCZOS)
        buf = io.BytesIO(); cg_sq_bg.save(buf, 'PNG')
        cg_sq = render_html(b, cover_html(800, 800, data_uri(buf.getvalue()), 'Volan', 170, bg_pos='center', shade='bottom', mark=False), 800, 800)
        save_png(cg_sq, os.path.join(OUT, 'crazygames', 'cover-square-800x800.png'))
        if VIDEO: videos(b)
        b.close()
    print('готово:', OUT)

main()
httpd.shutdown()
