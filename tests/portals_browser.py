"""
Проверка порталов в настоящем headless Chrome (Playwright): собирает архивы (tools/build-portals.mjs),
распаковывает каждый во временную папку, поднимает сервер и играет с подставными SDK:
  itch        — без SDK; ссылки и экран «Скачать» остаются;
  yandex      — /sdk.js с YaGames (ysdk.on, LoadingAPI, GameplayAPI, environment.i18n.lang), записывает вызовы;
  crazygames  — SDK v3 с game.loadingStart/Stop, gameplayStart/Stop, inviteLink, updateRoom, leftRoom, addJoinRoomListener.
  python3 tests/portals_browser.py [itch yandex crazygames]
Скриншоты — tests/screens/portals/ (в .gitignore).
"""
import http.server, socketserver, threading, os, sys, json, functools, subprocess, tempfile, zipfile, re, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screens', 'portals')
os.makedirs(SHOTS, exist_ok=True)
failures = []

def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: failures.append(msg)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve(directory):
    httpd = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=directory))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

# ---------------------------------------------------------------- подставные SDK
REC = "window.__calls = window.__calls || []; const rec = n => window.__calls.push(n);"
YA_SDK = REC + """
(function () {
  const handlers = {};
  const ysdk = {
    environment: { i18n: { lang: window.__MOCK_LANG || 'ru' } },
    features: {
      LoadingAPI: { ready() { rec('LoadingAPI.ready'); } },
      GameplayAPI: { start() { rec('GameplayAPI.start'); }, stop() { rec('GameplayAPI.stop'); } },
    },
    on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); rec('on:' + ev); },
  };
  window.__ysEmit = ev => (handlers[ev] || []).forEach(f => f());
  window.YaGames = { init() { rec('YaGames.init'); return Promise.resolve(ysdk); } };
})();
"""
CG_SDK = REC + """
(function () {
  window.CrazyGames = { SDK: {
    environment: 'crazygames',
    init() { rec('init'); return Promise.resolve(); },
    user: { systemInfo: { locale: window.__MOCK_LANG || 'en-US' } },
    game: {
      loadingStart() { rec('loadingStart'); }, loadingStop() { rec('loadingStop'); },
      gameplayStart() { rec('gameplayStart'); }, gameplayStop() { rec('gameplayStop'); },
      inviteLink(p) { rec('inviteLink:' + JSON.stringify(p)); return 'https://www.crazygames.com/game/volan?roomId=' + p.roomId; },
      updateRoom(p) { rec('updateRoom:' + JSON.stringify(p)); }, leftRoom() { rec('leftRoom'); },
      getInviteParam(k) { return k === 'roomId' ? (window.__MOCK_INVITE || null) : null; },
      addJoinRoomListener(f) { window.__cgJoin = f; rec('addJoinRoomListener'); }, removeJoinRoomListener() {},
      isInstantMultiplayer: !!window.__MOCK_INSTANT,
    },
  } };
})();
"""

def calls(page): return page.evaluate('window.__calls || []')
def count(page, name): return sum(1 for c in calls(page) if c == name)

def new_page(browser, base, platform, w, h, mobile, lang=None, extra_init=''):
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1,
                              is_mobile=mobile, has_touch=mobile, locale='ru-RU' if lang != 'en' else 'en-US')
    page = ctx.new_page()
    errors, external = [], []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('requestfailed', lambda r: errors.append('requestfailed: ' + r.url) if r.url.startswith(base) else None)
    init = f"window.__MOCK_LANG = {json.dumps(lang)};" if lang else ''
    page.add_init_script(init + extra_init)
    if platform == 'yandex':
        page.route(base + 'sdk.js', lambda route: route.fulfill(body=YA_SDK, content_type='application/javascript'))
    def handler(route):
        url = route.request.url
        if url.startswith('https://sdk.crazygames.com/'): route.fulfill(body=CG_SDK, content_type='application/javascript'); return
        external.append(url); route.abort()
    page.route(lambda u: not u.startswith(base) and not u.startswith('data:') and not u.startswith('blob:'), handler)
    return ctx, page, errors, external

def shot(page, platform, name):
    page.screenshot(path=os.path.join(SHOTS, f'{platform}-{name}.png'))

def open_game(page, base, query='?mocknet'):
    page.goto(base + query)
    page.wait_for_function('window.__game && document.querySelector("#menu:not(.hidden)")', timeout=15000)
    page.wait_for_timeout(300)

CYR = re.compile('[А-Яа-яЁё]')
def cyrillic_left(page):
    """Русские тексты, оставшиеся на экране (для английской версии)."""
    out = page.evaluate("""() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const n = w.currentNode; if (/[А-Яа-яЁё]/.test(n.nodeValue) && n.parentElement && n.parentElement.offsetParent !== null && !/hidden/.test(n.parentElement.closest('.screen')?.className || '')) out.push(n.nodeValue.trim()); }
      for (const el of document.querySelectorAll('[aria-label],[placeholder]')) for (const a of ['aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v && /[А-Яа-яЁё]/.test(v) && el.offsetParent !== null) out.push(a + ': ' + v); }
      return out;
    }""")
    # ники из мока сети (Аня, Дамир) — пользовательские данные; «Русский» и «Language / Язык» — переключатель языка на itch, намеренно на обоих языках
    return [x for x in out if CYR.search(re.sub('Аня|Дамир|Language / Язык|Русский', '', x))]

def visible(page, sel):
    return page.evaluate(f'(() => {{ const e = document.querySelector({json.dumps(sel)}); return !!e && e.offsetParent !== null; }})()')

def external_links(page):
    return page.evaluate("""() => [...document.querySelectorAll('a[href]')].filter(a => a.offsetParent !== null && /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin).map(a => a.href)""")

# ---------------------------------------------------------------- игра руками
def key_play(page, seconds=7):
    """Десктоп: клавиатура. Подача пробелом, бег стрелками, удары пробелом/J/K."""
    t0 = page.evaluate('__game.state.players[0].x')
    end = time.time() + seconds
    k = 0
    while time.time() < end:
        s = page.evaluate('__game.state')
        if s['over']: break
        if s['phase'] == 'serve' and s['serverTeam'] == 0:
            page.keyboard.press('Space'); page.wait_for_timeout(500)
        else:
            sh = s['shuttle']; p = s['players'][0]
            key = 'ArrowRight' if sh['x'] > p['x'] else 'ArrowLeft'
            page.keyboard.down(key); page.wait_for_timeout(120); page.keyboard.up(key)
            if abs(sh['x'] - p['x']) < 1.2 and s['phase'] == 'rally': page.keyboard.press('Space')
        page.wait_for_timeout(40)
    s = page.evaluate('__game.state')
    return s

def touch_event(cdp, typ, pts):
    cdp.send('Input.dispatchTouchEvent', {'type': typ, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in pts]})

def touch_play(page, ctx, w, h, seconds=7):
    cdp = ctx.new_cdp_session(page)
    jx, jy = w * 0.22, h * 0.72
    touch_event(cdp, 'touchStart', [(0, (jx, jy))])
    end = time.time() + seconds
    while time.time() < end:
        s = page.evaluate('__game.state')
        if s['over']: break
        if s['phase'] == 'serve' and s['serverTeam'] == 0:
            b = page.evaluate('(() => { const b = __game.input.layout.buttons.find(b => b.id === "smart"); return [b.x, b.y]; })()')
            page.wait_for_timeout(300)
            touch_event(cdp, 'touchStart', [(0, (jx, jy)), (1, tuple(b))]); page.wait_for_timeout(50)
            touch_event(cdp, 'touchEnd', [(1, tuple(b))]); page.wait_for_timeout(200)
        elif s['phase'] == 'rally':
            sh = s['shuttle']; p = s['players'][0]
            dx = 1 if sh['x'] > p['x'] else -1
            touch_event(cdp, 'touchMove', [(0, (jx + dx * 40, jy))])
            if abs(sh['x'] - p['x']) < 1.4:
                b = page.evaluate('(() => { const b = __game.input.layout.buttons.find(b => b.id === "smart"); return [b.x, b.y]; })()')
                touch_event(cdp, 'touchStart', [(1, tuple(b))]); page.wait_for_timeout(40); touch_event(cdp, 'touchEnd', [(1, tuple(b))])
        page.wait_for_timeout(60)
    touch_event(cdp, 'touchEnd', [(0, (jx, jy))])
    return page.evaluate('__game.state')

def create_profile(page):
    page.click('#toProfile')
    page.fill('#nickInput', 'Tester')
    page.click('#profileSave')
    page.wait_for_timeout(300)
    if visible(page, '#profile'): page.click('#profile .icon-btn.back')
    page.wait_for_selector('#menu:not(.hidden)')

# ---------------------------------------------------------------- проверки одной площадки
def run_platform(browser, platform, base):
    print(f'\n===== {platform}  {base}', flush=True)
    is_portal_nolink = platform in ('yandex', 'crazygames')

    # ---- 1. запуск, русский язык, нет ошибок, SW не зарегистрирован
    ctx, page, errors, external = new_page(browser, base, platform, 1366, 768, False, lang='ru' if platform != 'itch' else None)
    open_game(page, base)
    plat = page.evaluate('window.__platform.id')
    check(plat == platform, f'платформа определена: {plat}')
    check('Играть с ИИ' in page.inner_text('#start'), 'русское меню по умолчанию (ru)')
    shot(page, platform, 'menu-ru-1366')
    if platform == 'yandex':
        check(count(page, 'YaGames.init') == 1, 'YaGames.init вызван один раз')
        check(count(page, 'LoadingAPI.ready') == 1, 'LoadingAPI.ready вызван ровно один раз после загрузки меню')
        check(count(page, 'on:game_api_pause') == 1 and count(page, 'on:game_api_resume') == 1, 'подписка на game_api_pause / game_api_resume')
        check(count(page, 'GameplayAPI.start') == 0, 'GameplayAPI.start не вызван, пока матч не начался (меню)')
    if platform == 'crazygames':
        check(count(page, 'init') == 1 and count(page, 'loadingStart') == 1 and count(page, 'loadingStop') == 1, 'SDK.init, loadingStart и loadingStop по одному разу')
        check(calls(page).index('loadingStart') < calls(page).index('loadingStop'), 'loadingStart раньше loadingStop')
        check(count(page, 'gameplayStart') == 0, 'gameplayStart не вызван в меню')
    page.wait_for_timeout(2200)   # SW у обычного сайта регистрируется через 1.5 с
    regs = page.evaluate('navigator.serviceWorker.getRegistrations().then(r => r.length)')
    check(regs == 0, f'service worker не зарегистрирован ({regs})')
    check(not page.evaluate('!!document.querySelector("link[rel=manifest]")'), 'в index.html нет ссылки на manifest')

    # ---- 2. внешние ссылки
    dl = visible(page, '#toDownload') or visible(page, '#dlChip')
    if is_portal_nolink:
        check(not dl, 'кнопки «Скачать» скрыты')
        page.click('#toSettings'); page.wait_for_timeout(200)
        check(not visible(page, '#privacyLink'), 'в настройках нет ссылки на политику конфиденциальности')
        check(not external_links(page), 'на экране настроек нет внешних ссылок')
        check(not page.evaluate('/github|apk|\\.exe/i.test(document.body.innerText)'), 'в тексте экрана нет GitHub/APK/exe')
        shot(page, platform, 'settings-ru-1366')
        page.click('#settings .icon-btn.back')
    else:
        check(dl, 'кнопка «Скачать» осталась (itch.io разрешает ссылки)')
        page.click('#toSettings'); page.wait_for_timeout(200)
        check(visible(page, '#privacyLink'), 'в настройках есть ссылка на политику')
        check(visible(page, '#settings .set-row select, #settings [data-seg="lang"], #settings .seg'), 'настройки открылись')
        page.click('#settings .icon-btn.back')
        page.click('#toDownload'); page.wait_for_timeout(300)
        check(visible(page, '#dlApk') or visible(page, '#dlExe'), 'экран «Скачать» открывается и показывает ссылки')
        shot(page, platform, 'download-1366')
        links = page.evaluate("[...document.querySelectorAll('#download a[href]')].every(a => a.target === '_blank')")
        check(links, 'ссылки на экране «Скачать» открываются в новой вкладке')
        page.click('#download .icon-btn.back')

    # ---- 3. матч с ИИ: gameplay start/stop, пауза, итоги
    page.click('#start'); page.wait_for_timeout(500)
    check(page.evaluate('__game.state.phase') in ('serve', 'rally', 'point'), 'матч начался из меню')
    start_name, stop_name = ('GameplayAPI.start', 'GameplayAPI.stop') if platform == 'yandex' else ('gameplayStart', 'gameplayStop')
    if platform != 'itch':
        check(count(page, start_name) == 1 and count(page, stop_name) == 0, f'{start_name} вызван при старте матча (start=1, stop=0)')
    s = key_play(page, 6)
    moved = page.evaluate('__game.state.players[0]')
    check(s['rally']['hits'] > 0 or s['score'][0] + s['score'][1] > 0 or s['phase'] == 'rally', f'матч идёт руками на 1366x768: фаза {s["phase"]}, счёт {s["score"]}, ударов {s["rally"]["hits"]}')
    shot(page, platform, 'match-1366')
    page.keyboard.press('Escape'); page.wait_for_timeout(250)
    check(visible(page, '#pause'), 'Esc ставит на паузу')
    if platform != 'itch':
        check(count(page, stop_name) == 1, f'{stop_name} вызван при паузе')
    shot(page, platform, 'pause-1366')
    page.click('#resume'); page.wait_for_timeout(250)
    if platform != 'itch':
        check(count(page, start_name) == 2 and count(page, stop_name) == 1, f'{start_name} вызван снова при продолжении (start=2, stop=1)')

    # события паузы площадки
    if platform == 'yandex':
        page.evaluate('window.__audioProbe = []')
        page.evaluate('__game.audio.unlock()'); page.wait_for_timeout(200)
        page.evaluate('window.__ysEmit("game_api_pause")'); page.wait_for_timeout(300)
        check(page.evaluate('__game.game.paused === true'), 'game_api_pause: игра на паузе')
        check(page.evaluate('__game.audio.held === true'), 'game_api_pause: звук заморожен (audio.held)')
        ctxstate = page.evaluate('__game.audio.context ? __game.audio.context.state : "none"')
        check(ctxstate in ('suspended', 'none'), f'game_api_pause: AudioContext {ctxstate}')
        check(visible(page, '#pause'), 'game_api_pause: показан экран паузы')
        check(count(page, stop_name) == 2, 'GameplayAPI.stop вызван при паузе площадки')
        page.evaluate('window.__ysEmit("game_api_resume")'); page.wait_for_timeout(300)
        check(page.evaluate('__game.audio.held === false'), 'game_api_resume: звук разморожен')
        page.click('#resume'); page.wait_for_timeout(200)
    # потеря фокуса окна глушит звук (порталы)
    if platform != 'itch':
        page.evaluate('window.dispatchEvent(new Event("blur"))'); page.wait_for_timeout(150)
        check(page.evaluate('__game.audio.held === true'), 'blur окна: звук заморожен')
        page.evaluate('window.dispatchEvent(new Event("focus"))'); page.wait_for_timeout(150)
        check(page.evaluate('__game.audio.held === false'), 'focus окна: звук разморожен')

    # конец матча → stop
    before = count(page, stop_name)
    page.evaluate('__game.forceAI(true); __game.setSpeed(40)')
    page.wait_for_function('__game.state.over', timeout=60000)
    page.wait_for_selector('#over:not(.hidden)', timeout=8000)
    page.evaluate('__game.setSpeed(1)')
    if platform != 'itch':
        check(count(page, stop_name) == before + 1, f'{stop_name} вызван при показе итогов матча')
    shot(page, platform, 'over-1366')
    page.click('#overMenu'); page.wait_for_selector('#menu:not(.hidden)')
    if platform != 'itch':
        check(count(page, start_name) == count(page, stop_name), 'вызовы start/stop сбалансированы (меню — не игра)')
        check(count(page, 'LoadingAPI.ready' if platform == 'yandex' else 'loadingStop') == 1, 'ready/loadingStop за сессию — ровно один раз')

    # ---- 4. онлайн-часть (mocknet): ссылки приглашения
    create_profile(page)
    page.click('#playFriends'); page.wait_for_selector('#roomCreate', state='visible')
    page.click('#roomCreate'); page.wait_for_selector('#lobby:not(.hidden)', timeout=8000); page.wait_for_timeout(300)
    open_game_url = page.url
    link_visible = bool(page.input_value('#roomLink'))   # поле со ссылкой заполнено (само поле на экране скрыто до «Скопировать»)
    if platform == 'yandex':
        check(not link_visible, 'Яндекс: ссылки-приглашения нет, показан только код комнаты')
        check('Скопировать код' in page.inner_text('#copyLink'), 'Яндекс: кнопка копирует код комнаты')
    elif platform == 'crazygames':
        check(link_visible and 'crazygames.com' in page.input_value('#roomLink'), 'CrazyGames: ссылка-приглашение берётся из SDK.game.inviteLink')
        check(any(c.startswith('updateRoom:') and '"isJoinable":true' in c for c in calls(page)), 'CrazyGames: updateRoom(isJoinable: true) при создании комнаты')
    else:
        check(link_visible, 'itch: обычная ссылка-приглашение')
    shot(page, platform, 'lobby-1366')
    page.click('#lobby .icon-btn.back'); page.wait_for_timeout(300)
    if platform == 'crazygames':
        check(count(page, 'leftRoom') >= 1, 'CrazyGames: leftRoom при выходе из комнаты')
    ctx.close()

    # ---- 5. телефон 390x844: игра руками (касания)
    ctx, page, errors2, external2 = new_page(browser, base, platform, 390, 844, True, lang='ru' if platform != 'itch' else None)
    open_game(page, base)
    shot(page, platform, 'menu-390')
    page.tap('#start'); page.wait_for_timeout(600)
    shot(page, platform, 'match-start-390')
    s = touch_play(page, ctx, 390, 844, 7)
    check(s['rally']['hits'] > 0 or s['score'][0] + s['score'][1] > 0, f'матч идёт касаниями на 390x844: счёт {s["score"]}, ударов {s["rally"]["hits"]}')
    shot(page, platform, 'match-390')
    page.tap('#pauseBtn'); page.wait_for_timeout(250)
    shot(page, platform, 'pause-390')
    check(visible(page, '#pause'), 'кнопка паузы на телефоне работает')
    page.tap('#quit'); page.wait_for_selector('#menu:not(.hidden)')
    ctx.close()
    check(not errors and not errors2, f'нет ошибок в консоли ({(errors + errors2)[:3]})')
    ext = [u for u in external + external2 if not u.startswith('https://sdk.crazygames.com')]
    check(not ext, f'нет запросов к внешним адресам при игре против ИИ ({ext[:3]})')

    # ---- 6. английский язык
    lang = 'en'
    ctx, page, errors3, external3 = new_page(browser, base, platform, 1366, 768, False, lang='en' if platform != 'itch' else None,
                                             extra_init=("localStorage.setItem('volan.lang', '\"en\"');" if platform == 'itch' else ''))
    open_game(page, base)
    check('Play vs AI' in page.inner_text('#start'), 'английское меню (Play vs AI)')
    check(page.evaluate('document.documentElement.lang') == 'en', '<html lang> = en')
    shot(page, platform, 'menu-en-1366')
    left = {}
    def audit(name):
        l = cyrillic_left(page)
        if l: left[name] = l
    audit('menu')
    page.click('#aiSetupBtn'); page.wait_for_timeout(200); audit('aiSetup'); shot(page, platform, 'aisetup-en')
    page.click('#aiSetup .icon-btn.back'); page.click('#toSettings'); page.wait_for_timeout(200); audit('settings'); shot(page, platform, 'settings-en')
    page.click('#settings .icon-btn.back'); page.click('#toProfile'); page.wait_for_timeout(200); audit('profileEdit'); shot(page, platform, 'profile-en')
    page.fill('#nickInput', 'Tester'); page.click('#profileSave'); page.wait_for_timeout(300)
    audit('profile'); shot(page, platform, 'profile-view-en')
    page.click('#toFriends'); page.wait_for_timeout(200); audit('friends'); page.click('#friends .icon-btn.back')
    page.click('#toTransfer'); page.wait_for_timeout(200); audit('transfer'); page.click('#transfer .icon-btn.back')
    page.click('#profile .icon-btn.back'); page.wait_for_selector('#menu:not(.hidden)')
    page.click('#playFriends'); page.wait_for_selector('#roomCreate', state='visible'); audit('online'); shot(page, platform, 'online-en')
    page.click('#roomCreate'); page.wait_for_selector('#lobby:not(.hidden)', timeout=8000); page.wait_for_timeout(1500); audit('lobby'); shot(page, platform, 'lobby-en')
    page.click('#lobby .icon-btn.back'); page.wait_for_timeout(200)
    page.click('#online .icon-btn.back'); page.wait_for_selector('#menu:not(.hidden)')
    page.click('#start'); page.wait_for_timeout(2500); audit('hud')
    shot(page, platform, 'match-en-1366')
    page.keyboard.press('Escape'); page.wait_for_timeout(200); audit('pause'); shot(page, platform, 'pause-en')
    page.click('#resume')
    page.evaluate('__game.forceAI(true); __game.setSpeed(40)')
    page.wait_for_function('__game.state.over', timeout=60000); page.wait_for_selector('#over:not(.hidden)', timeout=8000); page.evaluate('__game.setSpeed(1)')
    audit('over'); shot(page, platform, 'over-en')
    check(not left, f'в английской версии не осталось русских текстов: {json.dumps(left, ensure_ascii=False)[:600]}')
    ctx.close()
    check(not errors3, f'нет ошибок в консоли (en) ({errors3[:3]})')

    # ---- 7. специфика CrazyGames: приглашение при запуске и из игры
    if platform == 'crazygames':
        ctx, page, errs, ext = new_page(browser, base, platform, 1366, 768, False, lang='en-US')
        open_game(page, base); create_profile(page); page.close()
        page = ctx.new_page(); page.add_init_script("window.__MOCK_INVITE = 'ABCDE'; window.__MOCK_LANG='en-US';")
        page.route(lambda u: u.startswith('https://sdk.crazygames.com/'), lambda r: r.fulfill(body=CG_SDK, content_type='application/javascript'))
        page.goto(base + '?mocknet')
        page.wait_for_selector('#lobby:not(.hidden)', timeout=10000)
        check('ABCDE' in page.inner_text('#roomCode').replace(' ', '').replace('\n', ''), 'CrazyGames: запуск по приглашению сразу открывает комнату ABCDE')
        shot(page, platform, 'invite-lobby')
        page.close()
        page = ctx.new_page(); page.add_init_script("window.__MOCK_LANG='en-US';")
        page.route(lambda u: u.startswith('https://sdk.crazygames.com/'), lambda r: r.fulfill(body=CG_SDK, content_type='application/javascript'))
        open_game(page, base)
        check(count(page, 'addJoinRoomListener') == 1, 'CrazyGames: подписка на приглашения внутри игры')
        page.evaluate('window.__cgJoin({ roomId: "QWERT" })')
        page.wait_for_selector('#lobby:not(.hidden)', timeout=10000)
        check('QWERT' in page.inner_text('#roomCode').replace(' ', '').replace('\n', ''), 'CrazyGames: приглашение внутри игры ведёт в комнату QWERT')
        page.close()
        page = ctx.new_page(); page.add_init_script("window.__MOCK_INSTANT = true; window.__MOCK_LANG='en-US';")
        page.route(lambda u: u.startswith('https://sdk.crazygames.com/'), lambda r: r.fulfill(body=CG_SDK, content_type='application/javascript'))
        page.goto(base + '?mocknet'); page.wait_for_selector('#lobby:not(.hidden)', timeout=10000)
        check(count(page, 'inviteLink:{"roomId":"' + page.inner_text('#roomCode').replace(' ', '').replace('\n', '') + '"}') >= 1, 'CrazyGames: isInstantMultiplayer сразу создаёт комнату и готовит ссылку-приглашение')
        ctx.close()

def run_nonet(browser):
    """Запасная сборка Яндекса без онлайна (--no-online)."""
    print('\n===== yandex-nonet', flush=True)
    subprocess.check_call(['node', os.path.join(ROOT, 'tools', 'build-portals.mjs'), 'yandex', '--no-online'])
    tmp = tempfile.mkdtemp(prefix='volan-yandex-nonet-')
    with zipfile.ZipFile(os.path.join(ROOT, 'dist', 'yandex-nonet.zip')) as z: z.extractall(tmp)
    httpd = serve(tmp); base = f'http://127.0.0.1:{httpd.server_address[1]}/'
    try:
        ctx, page, errors, external = new_page(browser, base, 'yandex', 1366, 768, False, lang='ru')
        open_game(page, base, '')
        check(not visible(page, '#playFriends') and page.evaluate('!document.querySelector("#playFriends")'), 'без онлайна: кнопки «Играть с друзьями» нет')
        check(page.evaluate('__net.available()') is False, 'без онлайна: сеть недоступна (__net.available() = false)')
        check(count(page, 'LoadingAPI.ready') == 1, 'без онлайна: LoadingAPI.ready вызван')
        shot(page, 'yandex-nonet', 'menu')
        page.click('#start'); page.wait_for_timeout(1500)
        check(page.evaluate('__game.state.phase') in ('serve', 'rally'), 'без онлайна: матч с ИИ запускается')
        check(not errors and not external, f'без онлайна: нет ошибок и внешних запросов ({errors[:2]} {external[:2]})')
        ctx.close()
    finally: httpd.shutdown()

def main():
    ids = [a for a in sys.argv[1:] if not a.startswith('-')] or ['itch', 'yandex', 'crazygames']
    subprocess.check_call(['node', os.path.join(ROOT, 'tools', 'build-portals.mjs')] + ids)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        for pid in ids:
            tmp = tempfile.mkdtemp(prefix=f'volan-{pid}-')
            with zipfile.ZipFile(os.path.join(ROOT, 'dist', pid + '.zip')) as z: z.extractall(tmp)
            check(os.path.isfile(os.path.join(tmp, 'index.html')), f'{pid}.zip: index.html в корне')
            httpd = serve(tmp)
            try: run_platform(browser, pid, f'http://127.0.0.1:{httpd.server_address[1]}/')
            finally: httpd.shutdown()
        if 'yandex' in ids: run_nonet(browser)
        browser.close()
    print('\n' + ('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' if not failures else f'ПРОВАЛЕНО: {len(failures)}'))
    for f in failures: print('  -', f)
    sys.exit(1 if failures else 0)

main()
