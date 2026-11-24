"""
Профиль, друзья и онлайн-лобби в headless Chrome на заглушке сети (?mocknet).
  python3 tests/online_ui_browser.py
Проходит: первый запуск профиля, профиль, друзья, перенос, «Играть с друзьями»,
создание комнаты, вход по коду и по ссылке #room-, лобби 1×1 и 2×2, старт матча,
эмоции, «Друг отключился», итоги с реваншем, отсутствие сети (без ?mocknet).
Скриншоты — tests/screens/online_ui/ (390x844 и 844x390 тач, 1366x768).
"""
import http.server, socketserver, threading, os, sys, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT, NAME = os.path.dirname(ROOT), os.path.basename(ROOT)
SHOTS = os.path.join(ROOT, 'tests', 'screens', 'online_ui')
os.makedirs(SHOTS, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

failures = []
def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

def run(p, base, name, w, h, mobile):
    print(f'== {name} {w}x{h}')
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
    page = ctx.new_page()
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    tap = (lambda sel: page.tap(sel)) if mobile else (lambda sel: page.click(sel))
    shot = lambda n: page.screenshot(path=f'{SHOTS}/{name}-{n}.png')
    vis = page.is_visible

    page.goto(base + '?mocknet')
    page.wait_for_function('window.__game !== undefined')
    page.wait_for_timeout(900)
    shot('01-menu-first')
    check(vis('#start') and vis('#playFriends') and vis('#toProfile') and vis('#toSettings'), 'меню: 4 действия')

    # Первый запуск: «Играть с друзьями» без профиля → создание профиля → онлайн.
    tap('#playFriends'); page.wait_for_timeout(300)
    check(vis('#profileEdit'), 'без профиля онлайн ведёт к созданию профиля')
    tap('#profileSave'); page.wait_for_timeout(100)
    check(page.inner_text('#profileEdit .field-err') != '', 'пустой ник — подсказка')
    page.fill('#nickInput', 'Рахим')
    tap('[data-hero="mira"]'); tap('[data-kit="#2fb8ff"]'); page.wait_for_timeout(200)
    shot('02-profile-create')
    tap('#profileSave'); page.wait_for_timeout(600)
    check(vis('#online'), 'после создания — экран «Играть с друзьями»')
    prof = page.evaluate("JSON.parse(localStorage.getItem('volan.profile'))")
    check(prof['nick'] == 'Рахим' and prof['heroId'] == 'mira' and len(prof['friendCode']) == 6, f'профиль сохранён {prof["friendCode"]}')
    shot('03-online-home')

    # Создать комнату 2×2.
    tap('#online [data-name="onlineMode"] [data-value="doubles"]')
    tap('#roomCreate'); page.wait_for_timeout(900)
    check(vis('#lobby'), 'лобби открылось')
    code = page.inner_text('#roomCode').replace('\n', '')
    check(len(code) == 5, f'код комнаты {code}')
    page.wait_for_timeout(2600)
    page.evaluate('__game.ui.online.net.__mock.fill()'); page.wait_for_timeout(200)
    check(page.locator('#seats .seat').count() == 4, '4 места в 2×2')
    check(page.locator('#seats .seat.ai').count() == 1, 'свободное место занимает ИИ')
    shot('04-lobby-4seats')
    tap('#copyLink'); page.wait_for_timeout(200)
    clip = page.evaluate('navigator.clipboard.readText().catch(() => "")')
    check(('#room-' + code) in clip, f'ссылка в буфере: {clip}')
    # пересесть на место ИИ
    tap('#seats .seat.ai'); page.wait_for_timeout(200)
    mine = page.locator('#seats .seat.mine')
    check(mine.get_attribute('data-team') == '0' and mine.get_attribute('data-seat') == '1', 'пересел на место ИИ')
    tap('#seats .seat.ai'); page.wait_for_timeout(200)
    check(not page.is_disabled('#startOnline'), 'все готовы — «Начать» доступна')
    shot('05-lobby-ready')
    tap('#startOnline'); page.wait_for_timeout(1200)
    check(vis('#onlineHud') and not vis('#lobby'), 'матч начался, онлайн-HUD')
    check(page.evaluate('__game.state.players.length') == 4, 'в матче 4 игрока')
    names = page.evaluate('__game.game.players.map(p => p.name)')
    check('Аня' in names and 'Дамир' in names, f'ники на игроках {names}')
    check(page.locator('.nick-tag').count() == 2, 'ники над героями (2 других человека)')
    page.wait_for_timeout(1500)
    tap('#emoteBtn'); page.wait_for_timeout(150)
    shot('06-match-emote-palette')
    tap('[data-emote="fire"]'); page.wait_for_timeout(100)
    page.evaluate('__game.ui.online.net.__mock.peerEmote("haha")'); page.wait_for_timeout(350)
    check(page.locator('.emote-pop').count() >= 2, 'эмоции: своя и друга')
    shot('07-match-emotes')
    page.evaluate('__game.ui.online.net.__mock.drop()'); page.wait_for_timeout(300)
    check(vis('#dropOverlay'), '«Друг отключился»')
    shot('08-disconnect')
    page.evaluate('__game.ui.online.net.__mock.back()'); page.wait_for_timeout(200)
    check(not vis('#dropOverlay'), 'друг вернулся — оверлей скрыт')
    page.evaluate('__game.ui.online.net.__mock.end(0, [[21, 18]])'); page.wait_for_timeout(400)
    check(vis('#onlineOver'), 'итоги онлайн-матча')
    shot('09-online-over')
    fr = page.evaluate("JSON.parse(localStorage.getItem('volan.friends'))")
    check(len(fr) == 2 and all(f['auto'] for f in fr), f'соперники добавлены в друзья автоматически ({len(fr)})')
    tap('#rematch'); page.wait_for_timeout(300)
    check(vis('#lobby'), 'реванш — снова лобби')
    tap('#lobby .top .back'); page.wait_for_timeout(300)

    # Вход по коду: ошибка и успех.
    page.fill('#roomCodeInput', 'ZZZZZ'); tap('#roomJoin'); page.wait_for_timeout(1000)
    err = page.inner_text('#onlineError')
    check('Комнаты с таким кодом нет' in err, f'понятная ошибка: {err[:40]}')
    shot('10-join-error')
    page.fill('#roomCodeInput', 'KTQMX'); tap('#roomJoin'); page.wait_for_timeout(1200)
    check(vis('#lobby') and page.locator('#seats .seat').count() == 2, 'вошёл по коду, 2 места')
    page.wait_for_timeout(1800)
    tap('#readyBtn'); page.wait_for_timeout(200)
    shot('11-lobby-guest-ready')
    tap('#lobby .top .back'); page.wait_for_timeout(200)
    tap('#online .top .back'); page.wait_for_timeout(200)

    # Профиль, друзья, перенос, настройки.
    tap('#toProfile'); page.wait_for_timeout(500)
    check(vis('#profile'), 'профиль')
    check(page.inner_text('#profile .stat-grid').startswith('1'), 'статистика: 1 матч')
    shot('12-profile')
    tap('#toFriends'); page.wait_for_timeout(300)
    page.fill('#friendCodeInput', 'O0O0O0'); tap('#friendAdd'); page.wait_for_timeout(100)
    check(page.inner_text('#friends .field-err') != '', 'неверный код — ошибка')
    page.fill('#friendCodeInput', '7kq4mx'); tap('#friendAdd'); page.wait_for_timeout(200)
    check(page.locator('#friendList .friend').count() == 3, 'друг добавлен по коду')
    shot('13-friends')
    tap('#friendList .friend[data-code="7KQ4MX"] .del'); tap('#friendList .friend[data-code="7KQ4MX"] .del'); page.wait_for_timeout(200)
    check(page.locator('#friendList .friend').count() == 2, 'друг удалён (подтверждение вторым нажатием)')
    tap('#friends .top .back'); page.wait_for_timeout(200)
    tap('#toTransfer'); page.wait_for_timeout(300)
    exp = page.input_value('#exportCode')
    check(exp.startswith('VOLAN1.'), 'код переноса')
    shot('14-transfer')
    tap('#transfer .top .back'); tap('#profile .top .back'); page.wait_for_timeout(200)
    tap('#toSettings'); page.wait_for_timeout(300)
    shot('15-settings')
    tap('#settings [data-name="sound"] [data-value="false"]'); page.wait_for_timeout(100)
    st = page.evaluate("JSON.parse(localStorage.getItem('volan.settings'))")
    check(st.get('sound') is False, 'звук выключается и сохраняется в volan.settings')
    tap('#settings [data-name="sound"] [data-value="true"]')
    tap('#settings .top .back'); page.wait_for_timeout(300)
    shot('16-menu-profile')
    tap('#aiSetupBtn'); page.wait_for_timeout(300)
    shot('17-ai-setup')
    tap('#aiGo'); page.wait_for_timeout(500)
    hm = page.evaluate('[__game.game.human.character, __game.game.human.color]')
    check(hm == ['mira', '#2fb8ff'], f'против ИИ — герой и форма из профиля {hm}')

    # Ссылка-приглашение: свежая вкладка с #room-.
    page2 = ctx.new_page()
    page2.on('pageerror', lambda e: errors.append(str(e)))
    page2.goto(base + '?mocknet#room-ABCDE'); page2.wait_for_timeout(2000)
    check(page2.is_visible('#lobby'), 'ссылка #room- ведёт сразу в комнату')
    page2.screenshot(path=f'{SHOTS}/{name}-18-link-join.png')
    page2.close()
    # Без сети: сообщение про GitHub.
    page3 = ctx.new_page()
    page3.goto(base); page3.wait_for_function('window.__game !== undefined')
    (page3.tap if mobile else page3.click)('#playFriends'); page3.wait_for_timeout(800)
    check(page3.is_visible('#onlineUnavailable') or page3.is_visible('#online .online-body'), 'без ?mocknet: онлайн или сообщение о GitHub')
    page3.screenshot(path=f'{SHOTS}/{name}-19-unavailable.png')
    page3.close()
    real_err = [e for e in errors if 'net/index.js' not in e]
    check(not real_err, f'нет ошибок консоли {real_err[:3]}')
    browser.close()

if __name__ == '__main__':
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=PARENT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'
    only = sys.argv[1] if len(sys.argv) > 1 else None
    with sync_playwright() as p:
        for n, w, h, m in [('portrait', 390, 844, True), ('landscape', 844, 390, True), ('desktop', 1366, 768, False)]:
            if not only or only == n: run(p, base, n, w, h, m)
    httpd.shutdown()
    print('\nИТОГ:', 'ВСЁ OK' if not failures else f'{len(failures)} ошибок')
    sys.exit(1 if failures else 0)
