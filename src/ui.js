/**
 * ui.js — DOM-экраны «Волана»: главное меню, игра с ИИ, профиль и друзья, онлайн-лобби,
 * настройки, пауза, итоги. Экраны живут в src/ui/*, здесь — навигация и связка с игрой.
 *
 * Публичный API (сигнатуры не менять):
 *   createUI(root, handlers) -> UI
 *     handlers: { onStart(opts), onPause(), onResume(), onQuit(), onRestart(),
 *                 onOnlineStart?(startEvent, {lobby, me, slot}) — если сетевой модуль сам запускает
 *                                 матч (иначе UI вызовет onStart с opts.online = true),
 *                 onOnlineLobby?() — игрок вернулся из итогов онлайн-матча в лобби }
 *     opts в onStart: {mode, difficulty, format, assist, characters, kit:{color, accent}, online?}
 *   ui.showMenu() / ui.showPause() / ui.showGameOver(info) / ui.hideAll()
 *   ui.setHint(text|null)       — короткая подсказка внизу экрана
 *   ui.settings                 — {mode, difficulty, format, assist}
 *   ui.attach(game)             — подписки на события (подсказки подачи, статистика профиля)
 *   ui.setNet(net)              — отдать объект сети (createNet(game)); без него UI загрузит src/net сам
 *   ui.online                   — онлайн-часть (src/ui/online.js), ui.go(name, arg) — открыть экран
 *
 * id для тестов: #menu #start #aiSetup #aiGo #playFriends #toProfile #toSettings #pause #resume
 *   #over #again #pauseBtn #profileEdit #profile #friends #transfer #settings #online #lobby
 *   #onlineOver #onlineHud #emoteBtn #dropOverlay #toDownload #dlChip #download #installBtn #dlApk #dlExe
 */
import { DIFFICULTY, DIFFICULTY_ORDER, MATCH_FORMATS, CHARACTER_ORDER } from './config.js';
import { buildControlsSection, loadControls } from './controlsSettings.js';
import { loadSettings, saveSettings } from './storage.js';
import * as P from './profile/index.js';
import { h, seg, icon } from './ui/dom.js';
import { heroById } from './ui/heroes.js';
import { portrait } from './ui/portrait.js';
import { buildProfileScreens, topBar, plural } from './ui/profileScreens.js';
import { createOnline, parseRoomHash } from './ui/online.js';
import { buildDownloadScreen, downloadAvailable, privacyLink } from './ui/download.js';
import { pwa } from './pwa.js';

const MODE_LABEL = { singles: '1 × 1', doubles: '2 × 2' };

export function createUI(root, handlers = {}) {
  const stored = loadSettings();
  const settings = { mode: stored.mode, difficulty: stored.difficulty, format: stored.format, assist: stored.assist !== false };
  if (!DIFFICULTY[settings.difficulty]) settings.difficulty = 'amateur';
  if (!MATCH_FORMATS[settings.format]) settings.format = 'quick';
  if (!MODE_LABEL[settings.mode]) settings.mode = 'singles';
  const persist = () => saveSettings({ ...settings });
  let game = null;
  const screens = {};
  const history = [];
  let current = 'menu';

  const nav = {
    go(name, arg) {
      if (name !== current && current) history.push(current);
      if (history.length > 12) history.shift();
      show(name, arg);
    },
    back() { show(history.pop() || 'menu'); },
  };

  // ------------------------------------------------------------ главное меню
  const meChip = h('button', { class: 'me-chip', id: 'meChip', type: 'button', onclick: () => nav.go(P.hasProfile() ? 'profile' : 'profileEdit') });
  const aiSub = h('span', { class: 'bar-sub', id: 'aiSummary' });
  const dlBar = h('button', { class: 'bar small dl-menu', id: 'toDownload', type: 'button', onclick: () => nav.go('download') }, icon('download'), h('span', { class: 'bar-label' }, 'Скачать игру'));
  const dlChip = h('button', { class: 'dl-chip', id: 'dlChip', type: 'button', onclick: () => nav.go('download') }, icon('download'), 'Скачать');
  const menu = h('div', { class: 'screen menu', id: 'menu' },
    h('div', { class: 'menu-wrap' },
      h('div', { class: 'brand' },
        meChip,
        h('h1', { class: 'logo' }, h('span', { class: 'logo-word' }, 'Волан'), h('span', { class: 'logo-mark' }, icon('shuttle'))),
        h('p', { class: 'tag' }, 'Бадминтон: против ИИ и с друзьями по ссылке'), dlChip),
      h('nav', { class: 'menu-actions', 'aria-label': 'Главное меню' },
        h('div', { class: 'ai-group' },
          h('button', { class: 'bar go hero-bar', id: 'start', type: 'button', onclick: startAI },
            h('span', { class: 'bar-label' }, 'Играть с ИИ'), aiSub),
          h('button', { class: 'bar tune', id: 'aiSetupBtn', type: 'button', 'aria-label': 'Режим и сложность', onclick: () => nav.go('aiSetup') }, icon('gear'))),
        h('button', { class: 'bar sky', id: 'playFriends', type: 'button', onclick: () => nav.go('online') },
          h('span', { class: 'bar-label' }, 'Играть с друзьями'), h('span', { class: 'bar-sub' }, 'онлайн, 1 × 1 и 2 × 2')),
        h('div', { class: 'row2' },
          h('button', { class: 'bar', id: 'toProfile', type: 'button', onclick: () => nav.go(P.hasProfile() ? 'profile' : 'profileEdit') }, h('span', { class: 'bar-label' }, 'Профиль')),
          h('button', { class: 'bar', id: 'toSettings', type: 'button', onclick: () => nav.go('settings') }, h('span', { class: 'bar-label' }, 'Настройки'))),
        dlBar)));

  function paintMenu() {
    const p = P.getProfile();
    meChip.textContent = '';
    if (p) {
      meChip.style.setProperty('--kit', p.color);
      meChip.append(h('span', { class: 'chip-bust' }, portrait(p.heroId, { size: 44, color: p.color, accent: p.accent })),
        h('span', { class: 'chip-text' }, h('b', {}, p.nick), h('small', {}, `код ${p.friendCode}`)));
    } else {
      meChip.style.removeProperty('--kit');
      meChip.append(h('span', { class: 'chip-bust empty' }, icon('plus')), h('span', { class: 'chip-text' }, h('b', {}, 'Создать профиль'), h('small', {}, 'ник, герой, код друга')));
    }
    const canDl = downloadAvailable();   // в установленном приложении кнопки не нужны
    dlBar.classList.toggle('hidden', !canDl); dlChip.classList.toggle('hidden', !canDl);
    aiSub.textContent = `${MODE_LABEL[settings.mode]}, ${DIFFICULTY[settings.difficulty].label.toLowerCase()}, ${MATCH_FORMATS[settings.format].label.replace('1 гейм ', '')}`;
  }

  function myHero() { const p = P.getProfile(); return p ? p.heroId : 'timur'; }
  function startAI() {
    const me = myHero();
    const n = settings.mode === 'doubles' ? 4 : 2;
    const rest = CHARACTER_ORDER.filter(x => x !== me);
    for (let i = rest.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const p = P.getProfile();
    handlers.onStart?.({ ...settings, characters: [me, ...rest].slice(0, n), kit: p ? { color: p.color, accent: p.accent } : null });
  }

  // ------------------------------------------------------------ игра с ИИ: режим и сложность
  const aiHero = h('div', { class: 'ai-hero' });
  const aiSetup = h('div', { class: 'screen hidden', id: 'aiSetup' },
    h('div', { class: 'sheet' }, topBar('Игра с ИИ', () => nav.back()),
      aiHero,
      h('div', { class: 'row' }, h('div', { class: 'field-label' }, 'Режим'),
        seg('mode', [['singles', '1 × 1'], ['doubles', '2 × 2, с ИИ-напарником']], settings.mode, v => { settings.mode = v; persist(); })),
      h('div', { class: 'row' }, h('div', { class: 'field-label' }, 'Сложность'),
        seg('difficulty', DIFFICULTY_ORDER.map(k => [k, DIFFICULTY[k].label]), settings.difficulty, v => { settings.difficulty = v; persist(); })),
      h('div', { class: 'row' }, h('div', { class: 'field-label' }, 'Матч'),
        seg('format', Object.entries(MATCH_FORMATS).map(([k, f]) => [k, f.label]), settings.format, v => { settings.format = v; persist(); })),
      h('label', { class: 'check' },
        (() => { const c = h('input', { type: 'checkbox', id: 'assist' }); c.checked = settings.assist; c.addEventListener('change', () => { settings.assist = c.checked; persist(); }); return c; })(),
        h('span', {}, 'Автобег и подсказка приземления')),
      h('button', { class: 'bar go', id: 'aiGo', type: 'button', onclick: startAI }, icon('play'), h('span', { class: 'bar-label' }, 'Играть'))));
  function paintAiSetup() {
    const p = P.getProfile();
    const hero = heroById(myHero());
    aiHero.textContent = '';
    aiHero.style.setProperty('--kit', p ? p.color : hero.color);
    aiHero.append(portrait(hero.id, { size: 64, color: p ? p.color : undefined, accent: p ? p.accent : undefined }),
      h('div', {}, h('b', {}, p ? p.nick : 'Ваш герой'), h('span', {}, hero.name)),
      h('button', { class: 'chip-btn', type: 'button', onclick: () => nav.go('profileEdit', { then: () => nav.go('aiSetup') }) }, p ? 'Сменить' : 'Выбрать'));
  }

  // ------------------------------------------------------------ настройки
  const settingsBody = h('div', { class: 'settings-body' });
  const settingsScreen = h('div', { class: 'screen hidden', id: 'settings' },
    h('div', { class: 'sheet' }, topBar('Настройки', () => nav.back()), settingsBody));
  const controlsInSettings = buildControlsSection();
  function paintSettings() {
    const s = loadSettings();
    const vol = h('input', { type: 'range', min: '0', max: '100', step: '5', id: 'volume', 'aria-label': 'Громкость', value: String(Math.round(s.volume * 100)) });
    vol.addEventListener('input', () => saveSettings({ volume: +vol.value / 100 }));
    const touch = matchMedia('(pointer: coarse)').matches;
    settingsBody.textContent = '';
    controlsInSettings.refresh();
    settingsBody.append(
      h('div', { class: 'set-row' }, h('span', {}, 'Звук'), seg('sound', [[true, 'Вкл'], [false, 'Выкл']], s.sound, v => saveSettings({ sound: v }))),
      h('div', { class: 'set-row' }, h('span', {}, 'Громкость'), vol),
      h('div', { class: 'set-row' }, h('span', {}, 'Эффекты'), seg('reducedMotion', [[false, 'Все'], [true, 'Меньше']], s.reducedMotion, v => saveSettings({ reducedMotion: v }))),
      controlsInSettings,
      h('p', { class: 'note' }, touch
        ? 'Слева — джойстик, справа — кнопки «Удар», «Клир», «Смэш/Дроп», «Сетка». Свайпы включаются в разделе «Управление».'
        : 'WASD или стрелки — бег, пробел — удар, J — клир, K — смэш или дроп, L — сетка, Esc — пауза.'),
      (() => { const p = privacyLink(); p.firstChild.id = 'privacyLink'; return p; })());
  }

  // ------------------------------------------------------------ пауза
  const controlsSection = buildControlsSection();
  const pauseNote = h('p', { class: 'note center hidden' }, 'Онлайн-матч на паузу не встаёт — соперник продолжает видеть игру.');
  const pause = h('div', { class: 'screen hidden', id: 'pause' },
    h('div', { class: 'sheet small center' },
      h('h2', {}, 'Пауза'), pauseNote,
      h('button', { class: 'bar go', type: 'button', id: 'resume', onclick: () => handlers.onResume?.() }, h('span', { class: 'bar-label' }, 'Продолжить')),
      h('button', { class: 'bar', type: 'button', id: 'restart', onclick: () => handlers.onRestart?.() }, h('span', { class: 'bar-label' }, 'Заново')),
      h('button', { class: 'bar', type: 'button', id: 'quit', onclick: () => quit() }, h('span', { class: 'bar-label' }, 'В меню')),
      controlsSection));

  // ------------------------------------------------------------ итоги матча с ИИ
  const overTitle = h('h2', { class: 'result' }, '');
  const overBust = h('div', { class: 'over-bust' });
  const overScore = h('div', { class: 'score-big' });
  const overStats = h('p', { class: 'note center' }, '');
  const overRecord = h('p', { class: 'record hidden' }, '');
  const over = h('div', { class: 'screen hidden', id: 'over' },
    h('div', { class: 'sheet small center' }, overBust, overTitle, overScore, overRecord, overStats,
      h('button', { class: 'bar go', type: 'button', id: 'again', onclick: () => handlers.onRestart?.() }, h('span', { class: 'bar-label' }, 'Ещё матч')),
      h('button', { class: 'bar', type: 'button', id: 'overMenu', onclick: () => quit() }, h('span', { class: 'bar-label' }, 'В меню'))));

  // ------------------------------------------------------------ профиль и онлайн
  const prof = buildProfileScreens(nav);
  const download = buildDownloadScreen(nav);
  const online = createOnline({
    nav, handlers,
    getGame: () => game,
    getRenderer: () => (globalThis.__game && globalThis.__game.renderer) || null,
    showHud: b => online.showHud(b),
  });

  const pauseBtn = h('button', { class: 'pause-btn hidden', id: 'pauseBtn', type: 'button', 'aria-label': 'Пауза', onclick: () => handlers.onPause?.() },
    h('i'), h('i'));
  const hint = h('div', { class: 'hint hidden', id: 'hint' }, '');
  root.append(menu, aiSetup, settingsScreen, pause, over,
    prof.edit.el, prof.view.el, prof.friends.el, prof.transfer.el, download.el,
    online.screens.home.el, online.screens.lobby.el, online.screens.over.el,
    ...online.layers, pauseBtn, hint);

  Object.assign(screens, {
    menu: { el: menu, open: paintMenu },
    aiSetup: { el: aiSetup, open: paintAiSetup },
    settings: { el: settingsScreen, open: paintSettings },
    pause: { el: pause, open: () => { controlsSection.refresh(); pauseNote.classList.toggle('hidden', !online.inMatch); } },
    over: { el: over, open() {} },
    profileEdit: prof.edit, profile: prof.view, friends: prof.friends, transfer: prof.transfer, download,
    online: online.screens.home, lobby: online.screens.lobby, onlineOver: online.screens.over,
  });

  function show(name, arg) {
    current = name;
    online.current = name;
    for (const [k, s] of Object.entries(screens)) s.el.classList.toggle('hidden', k !== name);
    pauseBtn.classList.toggle('hidden', name !== null);
    online.showHud(name === null && online.inMatch && !online.state.ended);
    if (name && name !== 'pause' && name !== 'over') ui.setHint(null);
    if (name && screens[name]) {
      screens[name].open(arg);
      const sc = screens[name].el; sc.scrollTop = 0;
    }
  }

  function quit() {
    if (online.active) online.leave();
    handlers.onQuit?.();
  }

  const ui = {
    settings,
    online,
    go: (name, arg) => nav.go(name, arg),
    setNet(net) { online.setNet(net); },
    showMenu() { history.length = 0; show('menu'); ui.setHint(null); },
    showPause() { show('pause'); },
    showGameOver(info) {
      if (online.inMatch) { online.showOver({ won: info.won, gameScores: info.gameScores }); return; }
      const p = P.getProfile();
      overTitle.textContent = info.won ? 'Победа!' : 'Поражение';
      overTitle.classList.toggle('lose', !info.won);
      overBust.textContent = '';
      const heroId = (game && game.human && game.human.character) || myHero();
      overBust.append(portrait(heroId, { size: 96, mood: info.won ? 'happy' : 'sad', color: p && game && game.cfg.kit ? p.color : undefined, accent: p && game && game.cfg.kit ? p.accent : undefined }));
      overScore.textContent = '';
      for (const g of info.gameScores || []) overScore.append(h('span', { class: 'g' }, h('b', {}, String(g[info.team])), h('i', {}, ':'), h('b', {}, String(g[1 - info.team]))));
      overStats.textContent = info.statsText || '';
      overRecord.classList.toggle('hidden', !lastRecord);
      overRecord.textContent = lastRecord || '';
      show('over');
      ui.setHint(null);
    },
    hideAll() { show(null); },
    /** Кнопка «Назад» оболочки (Android): true — экран обработал, false — мы в главном меню. */
    handleBack() {
      if (current === null) { handlers.onPause?.(); return true; }
      if (current === 'pause') { handlers.onResume?.(); return true; }
      if (current === 'menu') return false;
      const el = screens[current] && screens[current].el;
      const b = el && el.querySelector('.icon-btn.back, #overMenu');
      if (b) { b.click(); return true; }
      nav.back(); return true;
    },
    setHint(text) {
      hint.textContent = text || '';
      hint.classList.toggle('hidden', !text);
    },
    attach(g) {
      game = g;
      let smashes = 0, matchRef = null;
      g.on('serveReady', e => {
        if (g.match !== matchRef) { // новый матч: форма из профиля, обнулить счётчики
          matchRef = g.match; smashes = 0; lastRecord = null;
          if (g.cfg.kit && g.human) { g.human.color = g.cfg.kit.color; g.human.accent = g.cfg.kit.accent; }
          if (g.cfg.online) online.onGameStarted();
        }
        if (e.human) {
          const touch = matchMedia('(pointer: coarse)').matches;
          const c = loadControls();
          ui.setHint(!touch ? 'Подача: пробел — короткая, J — длинная (влево/вправо — направление)'
            : c.touchMode === 'swipes' ? 'Подача: тап — короткая, свайп вверх — длинная'
            : null); // режим кнопок: подписи «короткая/длинная» на самих кнопках
        } else ui.setHint(null);
      });
      g.on('serve', () => ui.setHint(null));
      g.on('hit', e => { if (e.type === 'smash' && e.player && e.player === g.human) { smashes++; online.countSmash(); } });
      g.on('matchOver', e => {
        if (online.inMatch || !g.human || g.cfg.humans === 0) return;
        const longest = (g.stats.rallies || []).reduce((a, b) => Math.max(a, b), 0);
        const r = P.recordMatch({ won: e.winner === g.human.team, longestRally: longest, smashes });
        lastRecord = r.records.includes('longestRally') ? `Новый рекорд: розыгрыш в ${longest} ${plural(longest, 'удар', 'удара', 'ударов')}` : null;
      });
      // Ссылка-приглашение #room-XXXXX — сразу ко входу в комнату.
      if (parseRoomHash()) setTimeout(() => online.handleHash(), 0);
    },
  };
  let lastRecord = null;
  globalThis.addEventListener && globalThis.addEventListener('hashchange', () => { if (game && parseRoomHash() && !online.inMatch) online.handleHash(); });
  P.onProfileChange(() => { if (current === 'menu') paintMenu(); });
  pwa.onChange(() => { if (current === 'menu') paintMenu(); });
  paintMenu();
  return ui;
}
