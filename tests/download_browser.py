"""
Установка и скачивание «Волана» в настоящем headless Chrome (Playwright).
  python3 tests/download_browser.py
Проверяет на 390x844 (touch) и 1366x768:
  * manifest.webmanifest отдаётся и валиден, иконки существуют и нужного размера;
  * service worker ставится, кэш содержит ВСЕ файлы игры (включая vendor/ и fonts/);
  * после context.set_offline(True) игра грузится из кэша и играется (матч с ИИ);
  * экран «Скачать игру»: кнопка в меню и на заставке, ссылки на APK/exe, инструкции под платформу
    (iPhone, Android, десктоп), кнопка «Установить» по beforeinstallprompt, скрытие в установленном режиме;
  * внутри sandbox-iframe (без allow-same-origin): игра работает, ошибок нет, ссылки — настоящие <a href>;
  * play.html (без манифеста) работает без SW.
Скриншоты — tests/screens/download/.
"""
import http.server, socketserver, threading, os, sys, json, functools, struct
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT = os.path.dirname(ROOT)
NAME = os.path.basename(ROOT)
SHOTS = os.path.join(ROOT, 'tests', 'screens', 'download')
os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')   # как GitHub Pages: нужно модулям в sandbox-iframe с opaque origin
        super().end_headers()
Quiet.extensions_map = {**Quiet.extensions_map, '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.mjs': 'text/javascript'}

def serve():
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=PARENT))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

failures = []
def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

def png_size(path):
    with open(path, 'rb') as f:
        d = f.read(24)
    return struct.unpack('>II', d[16:24])

IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
APP_UA = ANDROID_UA + ' VolanApp/1.0.0'

def watch(page, errors):
    page.on('console', lambda m: errors.append('console: ' + m.text + ' @ ' + str(m.location.get('url'))) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))

def open_download(page, via='#toDownload'):
    page.click(via)
    page.wait_for_selector('#download', state='visible')
    page.wait_for_timeout(150)

def main():
    httpd = serve()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'
    sw_src = open(os.path.join(ROOT, 'sw.js'), encoding='utf-8').read()
    import re
    files = re.findall(r'"(\./[^"]*)"', sw_src.split('/*FILES*/')[1].split('/*END*/')[0])

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])

        for label, vp, mobile in (('phone', {'width': 390, 'height': 844}, True), ('desktop', {'width': 1366, 'height': 768}, False)):
            print(f'== {label} {vp["width"]}x{vp["height"]}')
            errors = []
            ctx = browser.new_context(viewport=vp, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, service_workers='allow')
            page = ctx.new_page(); watch(page, errors)
            page.goto(base + 'index.html')
            page.wait_for_function('window.__game')
            page.wait_for_selector('#menu', state='visible')

            # --- manifest
            href = page.evaluate("document.querySelector('link[rel=manifest]').href")
            r = ctx.request.get(href)
            check(r.ok and 'manifest' in (r.headers.get('content-type') or ''), 'manifest отдаётся: ' + str(r.status) + ' ' + str(r.headers.get('content-type')))
            m = r.json()
            check(m['name'] == 'Волан' and m['display'] == 'standalone' and m['start_url'] and m['theme_color'] == '#17134a', 'manifest: имя, standalone, цвета')
            sizes = {}
            for ic in m['icons']:
                path = os.path.join(ROOT, ic['src'])
                ok = os.path.exists(path) and 'x'.join(map(str, png_size(path))) == ic['sizes']
                sizes[ic['src']] = ok
            check(all(sizes.values()) and {i['purpose'] for i in m['icons']} >= {'any', 'maskable'}, 'manifest: иконки any+maskable существуют и совпадают по размеру')
            check(os.path.exists(os.path.join(ROOT, 'icons/apple-touch-icon.png')) and png_size(os.path.join(ROOT, 'icons/apple-touch-icon.png')) == (180, 180), 'apple-touch-icon 180x180')

            # --- service worker и кэш
            page.wait_for_function('navigator.serviceWorker.getRegistration().then(r => !!(r && r.active))', timeout=20000)
            page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10000)
            cached = page.evaluate("""async () => {
              const names = (await caches.keys()).filter(k => k.startsWith('volan-'));
              const c = await caches.open(names[0]);
              return { names, urls: (await c.keys()).map(r => new URL(r.url).pathname) };
            }""")
            check(len(cached['names']) == 1 and cached['names'][0].startswith('volan-'), 'один версионный кэш: ' + str(cached['names']))
            base_path = f'/{NAME}/'
            missing = [f for f in files if (base_path + f[2:]) not in cached['urls']]
            check(not missing and len(files) > 40, f'в кэше все {len(files)} файлов игры (нет: {missing[:3]})')
            check(any('/vendor/mqtt.min.js' in u for u in cached['urls']) and any('/fonts/unbounded-cyrillic.woff2' in u for u in cached['urls']), 'vendor/ и fonts/ в кэше')

            # --- кнопки на экране меню и экран «Скачать игру»
            check(page.is_visible('#toDownload') and page.is_visible('#dlChip'), 'кнопка «Скачать игру» в меню и «Скачать» на заставке')
            page.screenshot(path=os.path.join(SHOTS, f'{label}_menu.png'))
            open_download(page, '#dlChip')
            page.screenshot(path=os.path.join(SHOTS, f'{label}_download_top.png'))
            apk = page.get_attribute('#dlApk', 'href'); exe = page.get_attribute('#dlExe', 'href')
            check(apk == 'https://github.com/Rahim004/badminton-/releases/latest/download/Volan.apk', 'ссылка APK: ' + str(apk))
            check(exe == 'https://github.com/Rahim004/badminton-/releases/latest/download/Volan.exe', 'ссылка exe: ' + str(exe))
            check(page.get_attribute('#dlApk', 'target') == '_blank' and page.evaluate("document.querySelector('#dlApk').tagName") == 'A', 'ссылки — настоящие <a target=_blank>')
            check('МБ' in page.inner_text('#dlApk') and 'МБ' in page.inner_text('#dlExe'), 'размер файла указан')
            check(page.is_visible('#download details.guide[open]'), 'инструкция для платформы раскрыта (нет prompt)')
            check(not page.is_visible('#installBtn'), 'без beforeinstallprompt кнопки «Установить» нет')
            page.evaluate("document.querySelector('#download').scrollTop = 99999")
            page.screenshot(path=os.path.join(SHOTS, f'{label}_download_bottom.png'))
            page.click('#download .icon-btn.back')
            page.wait_for_selector('#menu', state='visible')

            # --- beforeinstallprompt → кнопка «Установить»
            page.evaluate("""() => {
              window.__prompted = 0;
              const e = new Event('beforeinstallprompt', { cancelable: true });
              e.prompt = async () => { window.__prompted++; };
              e.userChoice = Promise.resolve({ outcome: 'accepted' });
              window.dispatchEvent(e);
            }""")
            open_download(page)
            check(page.is_visible('#installBtn'), 'beforeinstallprompt → видна кнопка «Установить»')
            page.screenshot(path=os.path.join(SHOTS, f'{label}_download_install.png'))
            page.click('#installBtn')
            page.wait_for_timeout(200)
            check(page.evaluate('window.__prompted') == 1, 'клик вызывает prompt() события')
            check(not page.is_visible('#installBtn'), 'после запроса кнопка скрыта (событие одноразовое)')
            page.click('#download .icon-btn.back')

            # --- офлайн: игра из кэша
            ctx.set_offline(True)
            page.reload()
            page.wait_for_function('window.__game', timeout=15000)
            page.wait_for_selector('#menu', state='visible')
            check(True, 'офлайн: страница загрузилась из service worker')
            snap = page.evaluate("window.__game.startMatch({mode:'singles', difficulty:'amateur', humans:1}) && window.__game.step(240) && window.__game.state.phase")
            check(snap in ('serve', 'rally', 'play', 'playing') or bool(snap), 'офлайн: матч с ИИ идёт, фаза ' + str(snap))
            page.screenshot(path=os.path.join(SHOTS, f'{label}_offline_match.png'))
            ctx.set_offline(False)
            check(not errors, 'нет ошибок консоли: ' + '; '.join(errors[:3]))
            ctx.close()

        # ---- платформы: iPhone, Android, приложение, установленный PWA
        print('== платформы')
        for name, ua, vp, key, expect in (
            ('ios', IOS_UA, {'width': 390, 'height': 844}, 'ios', 'Поделиться'),
            ('android', ANDROID_UA, {'width': 390, 'height': 844}, 'android', 'Установить приложение'),
        ):
            errors = []
            ctx = browser.new_context(viewport=vp, user_agent=ua, is_mobile=True, has_touch=True, device_scale_factor=2)
            page = ctx.new_page(); watch(page, errors)
            page.goto(base + 'index.html'); page.wait_for_function('window.__game'); page.wait_for_selector('#menu', state='visible')
            open_download(page)
            check(page.is_visible(f'#download details.guide[data-guide={key}][open]'), f'{name}: открыта инструкция «{key}»')
            check(expect in page.inner_text(f'#download details.guide[data-guide={key}]'), f'{name}: текст инструкции содержит «{expect}»')
            first = page.evaluate("document.querySelector('.dl-links a').id")
            check(first == ('dlApk' if name == 'android' else 'dlExe'), f'{name}: первой идёт ссылка ' + first)
            if name == 'ios': check('не работают' in page.inner_text('#filesBox'), 'ios: предупреждение про APK/exe')
            page.screenshot(path=os.path.join(SHOTS, f'{name}_download.png'))
            check(not errors, f'{name}: нет ошибок консоли ' + '; '.join(errors[:2]))
            ctx.close()

        errors = []
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, user_agent=APP_UA, is_mobile=True, has_touch=True)
        page = ctx.new_page(); watch(page, errors)
        page.goto(base + 'index.html'); page.wait_for_function('window.__game'); page.wait_for_selector('#menu', state='visible')
        check(not page.is_visible('#toDownload') and not page.is_visible('#dlChip'), 'в приложении (VolanApp) кнопок скачивания нет')
        page.wait_for_timeout(2500)
        check(page.evaluate('navigator.serviceWorker.getRegistration().then(r => !r)'), 'в приложении service worker не регистрируется')
        check(page.evaluate('window.__volan.back()') is False, 'Back в главном меню → false (оболочка спросит про выход)')
        page.evaluate("window.__game.ui.go('settings')"); 
        check(page.evaluate('window.__volan.back()') is True and page.is_visible('#menu'), 'Back на вложенном экране → возврат в меню')
        page.evaluate("window.__game.startMatch({mode:'singles', difficulty:'amateur'})")
        check(page.evaluate('window.__volan.back()') is True and page.is_visible('#pause'), 'Back в матче → пауза')
        check(page.evaluate('window.__volan.back()') is True and not page.is_visible('#pause'), 'Back в паузе → продолжить')
        check(not errors, 'приложение: нет ошибок ' + '; '.join(errors[:2]))
        ctx.close()

        errors = []
        ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        ctx.add_init_script("const mm = window.matchMedia.bind(window); window.matchMedia = q => /display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q);")
        page = ctx.new_page(); watch(page, errors)
        page.goto(base + 'index.html'); page.wait_for_function('window.__game'); page.wait_for_selector('#menu', state='visible')
        check(not page.is_visible('#toDownload') and not page.is_visible('#dlChip'), 'установленный PWA (display-mode: standalone): кнопки скачивания скрыты')
        page.evaluate("window.__game.ui.go('download')"); page.wait_for_selector('#download', state='visible')
        check(not page.is_visible('#installBtn') and 'уже установлена' in page.inner_text('#installBox'), 'в установленном режиме вместо «Установить» — «уже установлена»')
        check(not errors, 'standalone: нет ошибок')
        ctx.close()

        # ---- sandbox-iframe и play.html
        print('== sandbox iframe / play.html')
        errors = []
        ctx = browser.new_context(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
        page = ctx.new_page(); watch(page, errors)
        host = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/tests/__frame.html'
        page.route(host, lambda route: route.fulfill(content_type='text/html', body=f'<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts allow-popups allow-forms" src="{base}index.html" style="border:0;width:100vw;height:100vh"></iframe>'))
        page.goto(host)
        fr = page.frame_locator('#f')
        fr.locator('#menu').wait_for(state='visible', timeout=15000)
        fr.locator('#toDownload').click()
        fr.locator('#download').wait_for(state='visible')
        check(fr.locator('a#dlApk[href^="https://github.com/Rahim004/badminton-/releases/latest/download/"][target=_blank]').count() == 1, 'sandbox: ссылка APK — настоящий <a href target=_blank>')
        check(fr.locator('#frameNote').count() == 1 and fr.locator('#openSite').count() == 1, 'sandbox: подсказка и ссылка «Открыть игру в браузере»')
        page.screenshot(path=os.path.join(SHOTS, 'sandbox_iframe_download.png'))
        check(not errors, 'sandbox: нет ошибок консоли ' + '; '.join(errors[:3]))
        ctx.close()

        play = os.path.join(ROOT, 'play.html')
        if os.path.exists(play):
            errors = []
            ctx = browser.new_context(viewport={'width': 844, 'height': 390}, service_workers='block')
            page = ctx.new_page(); watch(page, errors)
            page.goto(base + 'play.html'); page.wait_for_function('window.__game', timeout=15000)
            page.wait_for_timeout(2200)
            check(page.evaluate("window.__game.startMatch({mode:'singles', difficulty:'amateur', humans:1}) && true"), 'play.html: игра стартует без SW')
            errors = [e for e in errors if 'favicon.ico' not in e]   # у play.html нет <link rel=icon> — так было и раньше
            check(not errors, 'play.html: нет ошибок консоли ' + '; '.join(errors[:3]))
            ctx.close()
        else:
            print('  (play.html нет — пропуск)')
        browser.close()
    print('\nИТОГ:', 'всё прошло' if not failures else f'{len(failures)} провалов')
    sys.exit(1 if failures else 0)

if __name__ == '__main__':
    main()
