"""
Проверка звука в headless Chrome (Playwright).
  python3 tests/audio_browser.py
* Звук разблокируется первым жестом (клик «Играть»), банк синтезируется в фоне без ошибок.
* ИИ против ИИ в реальном времени: удары, шаги, писк, приземления, толпа реально ставятся в очередь.
* Матчбол → «напряжение», очко → стингер, гейм → рёв, конец → джингл.
* Перемотка (runUntil) не устраивает «кашу»: события отбрасываются, голосов ≤ пула.
* Выключение звука через настройки ('volan:settings') — ничего не играет.
* Офлайн-рендер той же цепочки (ревер, компрессор, лимитер) → WAV в tests/audio/
  и числовая проверка: пики без клиппинга, длительности, спектр (центроид, доля низов).
"""
import http.server, socketserver, threading, os, sys, json, functools, base64, struct
import numpy as np
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARENT = os.path.dirname(ROOT)
NAME = os.path.basename(ROOT)
OUT = os.path.join(ROOT, 'tests', 'audio')
os.makedirs(OUT, exist_ok=True)

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

failures = []
def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

ENCODE = """async (spec) => {
  const b = await __game.audio.renderOffline(spec);
  const n = b.length, L = b.getChannelData(0), R = b.getChannelData(1);
  const f32 = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { f32[2*i] = L[i]; f32[2*i+1] = R[i]; }
  const u8 = new Uint8Array(f32.buffer);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { sr: b.sampleRate, data: btoa(s) };
}"""

def write_wav(path, x, sr):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + pcm.nbytes) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 2, sr, sr * 4, 4, 16))
        f.write(b'data' + struct.pack('<I', pcm.nbytes) + pcm.tobytes())

def analyse(x, sr):
    mono = x.mean(axis=1)
    peak = float(np.abs(x).max())
    clip = int((np.abs(x) >= 0.999).sum())
    rms = float(np.sqrt((mono ** 2).mean()))
    env = np.abs(mono)
    thr = max(peak * 0.01, 1e-4)
    idx = np.nonzero(env > thr)[0]
    active = (idx[-1] - idx[0]) / sr if len(idx) else 0
    seg = mono[: min(len(mono), sr * 2)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    p = spec ** 2
    cent = float((fr * p).sum() / (p.sum() + 1e-12))
    low = float(p[fr < 150].sum() / (p.sum() + 1e-12))
    high = float(p[fr > 8000].sum() / (p.sum() + 1e-12))
    return dict(peak=round(peak, 3), clip=clip, rms=round(rms, 4), active=round(active, 3), centroid=round(cent), low=round(low, 3), high=round(high, 3))

RENDERS = {
    # имя: (spec, проверки)
    'hit_clear':  ({'duration': 1.2, 'sounds': [{'name': 'hit_clear', 'at': 0.05, 'gain': 1}]}, dict(cent=(900, 5000))),
    'hit_drop':   ({'duration': 1.0, 'sounds': [{'name': 'hit_drop', 'at': 0.05, 'gain': 0.6}]}, dict(cent=(500, 4500))),
    'hit_drive':  ({'duration': 1.0, 'sounds': [{'name': 'hit_drive', 'at': 0.05, 'gain': 1}]}, dict(cent=(900, 6000))),
    'smash':      ({'duration': 2.0, 'sounds': [{'name': 'riser', 'at': 0.05}, {'name': 'hit_smash', 'at': 0.35, 'gain': 1},
                    {'name': 'boom', 'at': 0.354, 'gain': 1}]}, dict(low=0.04)),
    'perfect':    ({'duration': 2.0, 'sounds': [{'name': 'hit_clear', 'at': 0.05}, {'name': 'shing', 'at': 0.075, 'gain': 0.8}]}, dict(cent=(1500, 7000))),
    'squeak':     ({'duration': 1.0, 'sounds': [{'name': 'squeak', 'at': 0.05}, {'name': 'squeak', 'at': 0.4, 'variant': 2}]}, dict(cent=(1000, 6000))),
    'steps_thud': ({'duration': 1.5, 'sounds': [{'name': 'step', 'at': 0.05 + i * 0.22, 'variant': i % 4} for i in range(4)] + [{'name': 'thud', 'at': 1.0}]}, dict(cent=(60, 1500))),
    'land_net':   ({'duration': 1.6, 'sounds': [{'name': 'net', 'at': 0.05}, {'name': 'land', 'at': 0.6}, {'name': 'landOut', 'at': 1.1}]}, {}),
    'whiff':      ({'duration': 1.0, 'sounds': [{'name': 'whiff', 'at': 0.05}]}, {}),
    'crowd_ooh':  ({'duration': 2.6, 'sounds': [{'name': 'ooh', 'at': 0.05}]}, dict(cent=(250, 3000))),
    'crowd_cheer': ({'duration': 3.6, 'sounds': [{'name': 'cheer', 'at': 0.05}]}, {}),
    'crowd_roar': ({'duration': 5.5, 'sounds': [{'name': 'roar', 'at': 0.05}]}, {}),
    'ambience':   ({'duration': 4.0, 'sounds': [{'name': 'room', 'at': 0, 'loop': True, 'gain': 0.35}, {'name': 'murmur', 'at': 0, 'loop': True, 'gain': 0.35}]}, {}),
    'stingers':   ({'duration': 3.0, 'sounds': [{'name': 'stingerWin', 'at': 0.05}, {'name': 'stingerLose', 'at': 1.6}]}, {}),
    'tension':    ({'duration': 3.6, 'sounds': [{'name': 'tension', 'at': 0.05}]}, dict(active=(2.3, 3.6))),
    'victory':    ({'duration': 4.6, 'sounds': [{'name': 'victory', 'at': 0.05}]}, dict(active=(2.6, 4.6))),
    'defeat':     ({'duration': 4.6, 'sounds': [{'name': 'defeat', 'at': 0.05}]}, dict(active=(2.6, 4.6))),
    # «худший случай»: смэш + бум + рёв + стингер одновременно — лимитер не даёт клиппинга
    'worst_case': ({'duration': 3.0, 'sounds': [{'name': 'hit_smash', 'at': 0.1, 'gain': 1.6}, {'name': 'boom', 'at': 0.1, 'gain': 1.6},
                    {'name': 'roar', 'at': 0.1, 'gain': 1.5}, {'name': 'stingerWin', 'at': 0.1, 'gain': 1.5}, {'name': 'shing', 'at': 0.12, 'gain': 1.5}]}, {}),
}

def main():
    handler = functools.partial(Quiet, directory=PARENT)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/{NAME}/'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
        page = browser.new_page(viewport={'width': 1200, 'height': 760})
        errors = []
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_function('window.__game !== undefined', timeout=10000)
        check(page.evaluate('__game.audio.context === null'), 'до жеста AudioContext не создан')
        page.click('#start')
        page.wait_for_timeout(200)
        check(page.evaluate('__game.audio.context && __game.audio.context.state') == 'running', 'жест разблокировал звук')
        page.wait_for_function('__game.audio.debug.ready.done >= __game.audio.debug.ready.total', timeout=30000)
        d = page.evaluate('__game.audio.debug')
        print(f"  банк готов: {d['ready']}, синтез {d['synthMs']:.0f} мс CPU")
        check(d['errors'] == 0, f"ошибок синтеза нет ({d['lastError']})")
        check(sorted(d['loops']) == ['air', 'murmur', 'room'], f"петли зала/толпы/воздуха запущены {d['loops']}")

        # --- реальное время: ИИ за обоих, x2
        page.evaluate("""(() => { const a = __game.audio.debug; a.played = {}; a.dropped = {}; a.scheduled = 0;
            __game.startMatch({mode: 'singles', difficulty: 'amateur', format: 'quick', seed: 11}); __game.forceAI(true); __game.setSpeed(3); })()""")
        page.wait_for_function('__game.state.stats.rallies.length >= 4', timeout=120000, polling=500)
        page.wait_for_timeout(1500)
        d = page.evaluate('__game.audio.debug')
        st = page.evaluate('__game.state')
        played = d['played']
        print('  сыграно:', json.dumps(played, ensure_ascii=False))
        print('  отброшено:', json.dumps(d['dropped'], ensure_ascii=False), 'пик голосов', d['peakVoices'])
        hits = sum(v for k, v in played.items() if k.startswith('hit_'))
        ev_hits = d['events'].get('hit', 0)
        check(hits >= 15, f'удары озвучены ({hits} звуков, событий hit {ev_hits})')
        check(played.get('step', 0) >= 20, f"шаги ({played.get('step', 0)})")
        check(played.get('squeak', 0) >= 3, f"писк кроссовок ({played.get('squeak', 0)})")
        check(played.get('land', 0) + played.get('landOut', 0) >= 2, 'приземления волана')
        check(played.get('applause', 0) + played.get('cheer', 0) >= 2, 'аплодисменты после очков')
        check(played.get('stingerWin', 0) + played.get('stingerLose', 0) >= 2, 'стингеры очков')
        check(played.get('boom', 0) >= 1 and played.get('riser', 0) >= 1, f"смэш: бум {played.get('boom', 0)}, свист {played.get('riser', 0)}")
        check(d['peakVoices'] <= 24, f"голосов не больше пула ({d['peakVoices']})")
        check(d['errors'] == 0, f"ошибок нет ({d['lastError']})")
        page.evaluate('__game.setSpeed(1)')

        # --- матчбол → напряжение, очко → стингер, гейм → рёв, конец → джингл
        page.evaluate("""(() => { __game.freeze(true); const a = __game.audio.debug; a.played = {}; a.dropped = {};
            __game.startMatch({mode: 'singles', difficulty: 'pro', format: 'short', seed: 5}); __game.forceAI(true);
            __game.runUntil(s => s.phase === 'point' && Math.max(...s.score) >= 9, 120 * 60 * 20); __game.freeze(false); __game.setSpeed(2); })()""")
        page.wait_for_function("__game.state.phase === 'over'", timeout=120000)
        page.wait_for_timeout(1500)
        d = page.evaluate('__game.audio.debug')
        played = d['played']
        print('  концовка:', json.dumps(played, ensure_ascii=False))
        check(played.get('tension', 0) >= 1, 'матчбол — «напряжение»')
        check(played.get('roar', 0) >= 1, 'гейм — рёв трибун')
        check(played.get('victory', 0) + played.get('defeat', 0) == 1, 'джингл победы/поражения')
        check(d['dropped'].get('fastforward', 0) >= 1, f"перемотка не озвучивается ({d['dropped'].get('fastforward', 0)})")
        page.evaluate('__game.setSpeed(1)')

        # --- кнопки интерфейса щёлкают
        page.evaluate('__game.audio.debug.played.click = 0')
        page.click('#again'); page.wait_for_timeout(150)
        check(page.evaluate('__game.audio.debug.played.click || 0') >= 1, 'щелчок кнопки интерфейса')

        # --- выключение звука через настройки
        page.evaluate("""dispatchEvent(new CustomEvent('volan:settings', {detail: {sound: false, volume: 0.5}}))""")
        page.evaluate('__game.audio.debug.dropped.muted = 0; __game.audio.playHit("clear", 1)')
        check(page.evaluate('__game.audio.debug.dropped.muted') >= 1 and page.evaluate('__game.audio.muted'), 'sound:false — звук выключен')
        page.wait_for_timeout(400)
        check(page.evaluate('__game.audio.context.state') == 'suspended', 'при выключенном звуке контекст остановлен (CPU)')
        page.evaluate("""dispatchEvent(new CustomEvent('volan:settings', {detail: {sound: true, volume: 0.8}}))""")
        page.wait_for_timeout(200)
        check(page.evaluate('__game.audio.playHit("clear", 1)'), 'включение обратно')

        # --- перемотка целого матча: без каши и ошибок
        r = page.evaluate("""(() => { __game.freeze(true); const a = __game.audio.debug; const s0 = a.scheduled;
            __game.startMatch({mode: 'doubles', difficulty: 'pro', format: 'short', seed: 9}); __game.forceAI(true);
            __game.runUntil(s => s.phase === 'over', 120 * 60 * 30); __game.freeze(false);
            return {scheduled: a.scheduled - s0, ff: a.dropped.fastforward, errors: a.errors}; })()""")
        print('  перемотка:', r)
        check(r['scheduled'] <= 12, f"при перемотке почти ничего не ставится ({r['scheduled']})")

        # --- офлайн-рендер → WAV + анализ
        print('  офлайн-рендер:')
        for name, (spec, exp) in RENDERS.items():
            res = page.evaluate(ENCODE, spec)
            sr = res['sr']
            x = np.frombuffer(base64.b64decode(res['data']), dtype='<f4').reshape(-1, 2)
            write_wav(os.path.join(OUT, name + '.wav'), x, sr)
            a = analyse(x, sr)
            print(f'    {name:12s} {a}')
            check(np.isfinite(x).all(), f'{name}: конечные значения')
            check(a['clip'] == 0 and a['peak'] < 0.99, f"{name}: без клиппинга (пик {a['peak']})")
            check(a['peak'] > 0.03, f"{name}: слышно (пик {a['peak']})")
            check(a['high'] < 0.12, f"{name}: нет резкого верха >8 кГц ({a['high']})")
            if 'cent' in exp: check(exp['cent'][0] <= a['centroid'] <= exp['cent'][1], f"{name}: центроид {a['centroid']} Гц в {exp['cent']}")
            if 'low' in exp: check(a['low'] >= exp['low'], f"{name}: суб-бум (доля <150 Гц {a['low']})")
            if 'active' in exp: check(exp['active'][0] <= a['active'] <= exp['active'][1], f"{name}: длительность {a['active']} с в {exp['active']}")
        # громкость: смэш громче укороченного
        # громкость (макс. RMS в окне 50 мс): смэш > клир > укороченный
        import wave
        rms = {}
        for n in ('hit_drop', 'smash', 'hit_clear'):
            with wave.open(os.path.join(OUT, n + '.wav')) as w:
                y = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float).reshape(-1, 2).mean(axis=1) / 32767
            win = 2400
            rms[n] = round(max(float(np.sqrt((y[i:i + win] ** 2).mean())) for i in range(0, len(y) - win, win // 2)), 4)
        check(rms['smash'] > rms['hit_clear'] > rms['hit_drop'], f'громкость: смэш > клир > укороченный {rms}')

        check(not errors, f'нет ошибок консоли {errors[:3]}')
        browser.close()
    httpd.shutdown()
    print('\nИТОГ:', 'ВСЁ OK' if not failures else f'{len(failures)} ошибок')
    sys.exit(1 if failures else 0)

if __name__ == '__main__':
    main()
