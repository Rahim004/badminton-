"""
Настоящий ретранслятор: хост и гость в РАЗНЫХ контекстах браузера (BroadcastChannel не работает),
связь только через публичные MQTT-брокеры по WSS (как у игроков). Короткий матч ботами.
  python3 tests/net_real_mq.py        (нужен интернет; без него — SKIP)
В песочнице с прокси: --proxy-server берётся из HTTPS_PROXY.
"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from net_browser import serve, check, failures, page_errors, BOT, COUNTERS, NAME, SHOTS
from playwright.sync_api import sync_playwright

def main(no_rtc=False):
    print('== ' + ('только ретранслятор (у гостя нет WebRTC)' if no_rtc else 'ретранслятор + прямой канал WebRTC'))
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/index.html'
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    args = ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    if proxy: args += [f'--proxy-server={proxy}', '--proxy-bypass-list=127.0.0.1;localhost']
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=args)
        errs = []
        ca, cb = browser.new_context(viewport={'width': 844, 'height': 390}), browser.new_context(viewport={'width': 844, 'height': 390})
        A = ca.new_page(); page_errors(A, 'host', errs)
        if no_rtc: cb.add_init_script('delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;')
        B = cb.new_page(); page_errors(B, 'guest', errs)
        for pg in (A, B): pg.goto(url); pg.wait_for_function('window.__net && window.__game')
        r = A.evaluate("window.__net.host({ mode: 'singles', format: 'short', profile: { nick: 'Тест-хост', heroId: 'kai' }, transport: 'mq' })")
        if not r.get('code'):
            print('SKIP: ретранслятор недоступен отсюда: ' + str(r.get('error'))); return 0
        print('   комната', r['code'], 'через MQTT, статус:', A.evaluate('window.__net.debug()'))
        t0 = time.time()
        j = B.evaluate("c => window.__net.join(c, { profile: { nick: 'Тест-гость', heroId: 'mira' }, transport: 'mq' })", r['code'])
        check(j.get('ok') is True, 'гость вошёл через настоящий MQTT-брокер за %.1f с: %s' % (time.time() - t0, json.dumps(j, ensure_ascii=False)))
        if not j.get('ok'): return 1
        B.evaluate('window.__net.setReady(true)'); A.wait_for_timeout(1500)
        check(A.evaluate('window.__net.startMatch()')['ok'] is True, 'старт через ретранслятор')
        B.wait_for_function('window.__game.game.netDriver && window.__game.game.netDriver.replacesSim', timeout=15000)
        A.evaluate(COUNTERS); B.evaluate(COUNTERS)
        A.evaluate(BOT + "('host')"); B.evaluate(BOT + "('guest')")
        A.wait_for_timeout(30000)
        A.evaluate('window.__game.game.netDriver.setHidden(true)'); B.wait_for_timeout(4000)
        hs, gs = A.evaluate('window.__game.game.match.score'), B.evaluate('window.__game.game.match.score')
        hc = A.evaluate('window.__cnt'); info = B.evaluate('window.__net.debug()')
        print('   ', json.dumps({'score': hs, 'guest': gs, 'hits': hc['hits'], 'perfect': hc['perfect'], 'whiffs': hc['whiffs'], 'guestNet': info}, ensure_ascii=False)[:900])
        check(hs == gs, f'одинаковый счёт через MQTT {hs} / {gs}')
        check(hc['hits'].get('1', 0) >= 3, 'удары гостя доходят до хоста через MQTT: ' + json.dumps(hc['hits']))
        check(info['ms'] > 0, 'пинг: %d мс, маршрут %s' % (info['ms'], info['route']))
        if no_rtc: check(info['route'] == 'server', 'без WebRTC игра идёт через сервер')
        B.screenshot(path=os.path.join(SHOTS, 'net_mq_guest.png'))
        # Недоступные отсюда брокеры Chrome сам пишет в консоль (net::ERR_…) — это ожидаемо; прочих ошибок быть не должно.
        check(not [e for e in errs if 'net::ERR_' not in e], 'нет ошибок консоли (кроме недоступных брокеров): ' + json.dumps([e for e in errs if 'net::ERR_' not in e][:6], ensure_ascii=False))
        A.evaluate('window.__net.leave()'); B.wait_for_timeout(2000)
        browser.close()
    httpd.shutdown()
    return 1 if failures else 0

if __name__ == '__main__':
    main(False); main(True)
    print('\nИТОГ: ' + ('ВСЁ OK' if not failures else 'ОШИБКИ: ' + '; '.join(failures)))
    sys.exit(1 if failures else 0)
