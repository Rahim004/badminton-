"""
Онлайн «от начала до конца» с настоящим интерфейсом (агент «Профиль и лобби») и настоящей
сетью src/net на транспорте 'bc' (две вкладки, ?nettransport=bc), пинг ~160 мс.
  python3 tests/net_ui_browser.py
Хост: «Играть с друзьями» → «Создать комнату»; гость открывает ссылку #room-КОД → лобби →
«Готов»; хост — «Начать»; оба играют ботами через настоящий ввод; реакция гостя видна у хоста;
хост выходит в меню — гость видит «Хост вышел из игры». Без ошибок в консоли.
Скриншоты — tests/screens/net_ui_*.png.
"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from net_browser import serve, check, failures, page_errors, BOT, COUNTERS, NAME, SHOTS
from playwright.sync_api import sync_playwright

def visible(page, sel):
    try: return page.is_visible(sel)
    except Exception: return False

def main():
    httpd = serve()
    base = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/index.html?nettransport=bc'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'])
        ctx = browser.new_context(viewport={'width': 844, 'height': 390})
        ctx.add_init_script('window.__netSim = {lag: 80, jit: 20, loss: 0.02};')
        errs = []
        A = ctx.new_page(); page_errors(A, 'host', errs)
        A.goto(base); A.wait_for_function('window.__net && window.__game')
        A.evaluate("import('./src/profile/index.js').then(P => P.saveProfile({ nick: 'Рахим', heroId: 'kai' }))")
        A.wait_for_timeout(300)
        A.click('#playFriends')
        A.wait_for_selector('#roomCreate', state='visible')
        A.click('#roomCreate')
        A.wait_for_selector('#lobby', state='visible', timeout=8000)
        code = A.evaluate('window.__net.info().code')
        check(isinstance(code, str) and len(code) == 5, 'комната создана из интерфейса: ' + str(code))
        A.screenshot(path=os.path.join(SHOTS, 'net_ui_lobby_host.png'))

        B = ctx.new_page(); page_errors(B, 'guest', errs)
        B.goto(base); B.wait_for_function('window.__net && window.__game')
        B.evaluate("import('./src/profile/index.js').then(P => P.saveProfile({ nick: 'Друг', heroId: 'mira' }))")
        B.wait_for_timeout(300)
        B.goto(base + '#room-' + code); B.wait_for_function('window.__net && window.__game')
        B.wait_for_selector('#lobby', state='visible', timeout=12000)
        check(B.evaluate('window.__net.info().role') == 'guest', 'гость вошёл по ссылке #room-' + code)
        B.wait_for_selector('#readyBtn', state='visible')
        B.click('#readyBtn')
        A.wait_for_selector('#startOnline:not([disabled])', timeout=6000)
        B.screenshot(path=os.path.join(SHOTS, 'net_ui_lobby_guest.png'))
        A.click('#startOnline')
        B.wait_for_function('window.__game.game.netDriver && window.__game.game.netDriver.replacesSim', timeout=8000)
        A.wait_for_timeout(600)
        check(visible(A, '#onlineHud') and visible(B, '#onlineHud'), 'онлайн-HUD у обоих')
        check(not visible(A, '#lobby') and not visible(B, '#lobby'), 'лобби скрыто после старта')
        names = B.evaluate('window.__game.game.players.map(p => p.name)')
        check(names == ['Рахим', 'Друг'], 'ники игроков у гостя: ' + json.dumps(names, ensure_ascii=False))
        A.evaluate(COUNTERS); B.evaluate(COUNTERS)
        A.evaluate(BOT + "('host')"); B.evaluate(BOT + "('guest')")
        A.wait_for_timeout(3000)
        # Реакция гостя — у хоста.
        B.click('#emoteBtn'); B.wait_for_timeout(150)
        B.click('#emotePalette .emote-btn >> nth=0')
        A.wait_for_timeout(900)
        check(A.evaluate("document.querySelectorAll('.emote-pop').length") > 0, 'реакция гостя показана у хоста')
        A.wait_for_timeout(17000)
        A.evaluate('window.__game.game.netDriver.setHidden(true)')
        B.wait_for_timeout(2500)
        hs, gs = A.evaluate('window.__game.game.match.score'), B.evaluate('window.__game.game.match.score')
        hc = A.evaluate('window.__cnt')
        check(hs == gs, f'одинаковый счёт у обоих {hs} / {gs}')
        check(hc['hits'].get('1', 0) >= 3, 'удары гостя засчитаны хостом: ' + json.dumps(hc['hits']))
        A.screenshot(path=os.path.join(SHOTS, 'net_ui_match_host.png'))
        B.screenshot(path=os.path.join(SHOTS, 'net_ui_match_guest.png'))
        A.evaluate('window.__game.game.netDriver.setHidden(false)')
        A.evaluate('window.__bot.on = false'); B.evaluate('window.__bot.on = false')
        # Хост выходит через меню паузы.
        A.keyboard.press('Escape'); A.wait_for_selector('#quit', state='visible', timeout=3000)
        A.click('#quit')
        B.wait_for_timeout(2500)
        txt = B.evaluate('document.body.innerText')
        check('Хост вышел из игры' in txt, 'у гостя сообщение «Хост вышел из игры»')
        check(not B.evaluate('window.__game.game.netDriver'), 'у гостя онлайн-матч остановлен')
        B.screenshot(path=os.path.join(SHOTS, 'net_ui_host_left.png'))
        check(not errs, 'нет ошибок консоли: ' + json.dumps(errs[:6], ensure_ascii=False))
        browser.close()
    httpd.shutdown()
    print('\nИТОГ: ' + ('ВСЁ OK' if not failures else 'ОШИБКИ: ' + '; '.join(failures)))
    sys.exit(1 if failures else 0)

if __name__ == '__main__':
    main()
