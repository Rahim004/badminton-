/**
 * ui/profileScreens.js — экраны профиля: создание/правка, карточка профиля с кодом друга
 * и статистикой, друзья, перенос профиля кодом.
 *
 *   buildProfileScreens(nav) -> { edit, view, friends, transfer }  — каждый {el, open(arg)}
 *   nav: { go(name, arg), back() }
 */
import { h, seg, copyText, toast, icon } from './dom.js';
import { HEROES, heroById, STAT_LABELS } from './heroes.js';
import { portrait } from './portrait.js';
import * as P from '../profile/index.js';

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function ago(ts) {
  if (!ts) return 'ещё не играли';
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const days = Math.floor((d0 - ts) / 864e5) + 1;
  if (ts >= d0.getTime()) return 'играли сегодня';
  if (days <= 1) return 'играли вчера';
  if (days < 7) return `играли ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  return 'играли ' + new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export function topBar(title, onBack) {
  return h('header', { class: 'top' },
    h('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Назад', onclick: onBack }, icon('back')),
    h('h2', {}, title));
}

export function codePlate(code, { big = false, label } = {}) {
  return h('div', { class: 'plate' + (big ? ' big' : ''), 'aria-label': label || code },
    ...[...code].map(c => h('span', {}, c)));
}

export function buildProfileScreens(nav) {
  // -------------------------------------------------------------- создание / правка
  const edit = (() => {
    let draft = null, after = null, firstRun = false;
    const title = h('h2', {}, '');
    const back = h('button', { class: 'icon-btn back', type: 'button', 'aria-label': 'Назад', onclick: () => nav.back() }, icon('back'));
    const nick = h('input', { class: 'field', id: 'nickInput', type: 'text', maxlength: '16', autocomplete: 'nickname', enterkeyhint: 'done', placeholder: 'Например, Рахим', 'aria-label': 'Ник' });
    const nickErr = h('p', { class: 'field-err', role: 'alert' });
    nick.addEventListener('input', () => { draft.nick = nick.value; nickErr.textContent = ''; });
    nick.addEventListener('keydown', e => { if (e.key === 'Enter') nick.blur(); });

    const stage = h('div', { class: 'hero-stage' });
    const grid = h('div', { class: 'hero-grid', role: 'radiogroup', 'aria-label': 'Герой' });
    const kits = h('div', { class: 'kits', role: 'radiogroup', 'aria-label': 'Цвет формы' });
    const save = h('button', { class: 'bar go', id: 'profileSave', type: 'button', onclick: submit }, h('span', { class: 'bar-label' }, 'Сохранить'));

    function renderStage() {
      const hero = heroById(draft.heroId);
      stage.textContent = '';
      stage.style.setProperty('--kit', draft.color);
      stage.append(
        h('div', { class: 'stage-bust' }, portrait(hero.id, { size: 148, mood: 'happy', color: draft.color, accent: P.kitAccent(draft.color) })),
        h('div', { class: 'stage-info' },
          h('div', { class: 'hero-name' }, hero.name),
          h('div', { class: 'hero-role' }, hero.role),
          hero.signature ? h('div', { class: 'hero-sign' }, `Коронный удар: ${hero.signature.toLowerCase()}`) : null,
          h('p', { class: 'hero-story' }, hero.story),
          h('div', { class: 'stats-bars' }, ...Object.entries(STAT_LABELS).map(([k, label]) =>
            h('div', { class: 'stat-bar' }, h('span', {}, label), h('i', { style: `--v:${Math.round(hero.stats[k] * 100)}%` })))),
        ));
    }
    function renderGrid() {
      grid.textContent = '';
      for (const hero of HEROES) {
        const on = hero.id === draft.heroId;
        grid.append(h('button', { class: 'hero-tile' + (on ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(on), 'data-hero': hero.id, style: `--hc:${hero.color}`,
          onclick: () => {
            const wasHeroKit = draft.color === heroById(draft.heroId).color;
            draft.heroId = hero.id;
            if (wasHeroKit) draft.color = hero.color;
            renderGrid(); renderStage(); renderKits();
          } }, portrait(hero.id, { size: 76 }), h('span', {}, hero.name.split(' ')[0])));
      }
    }
    function renderKits() {
      kits.textContent = '';
      for (const k of P.KIT_COLORS) {
        const on = k.color === draft.color;
        kits.append(h('button', { class: 'kit' + (on ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': k.name, title: k.name, 'data-kit': k.color, style: `--c:${k.color};--a:${k.accent}`,
          onclick: () => { draft.color = k.color; renderKits(); renderStage(); } }));
      }
    }
    function submit() {
      const n = String(draft.nick || '').trim();
      if (!n) { nickErr.textContent = 'Введите ник — его увидят друзья'; nick.focus(); return; }
      const p = P.saveProfile({ nick: n, heroId: draft.heroId, color: draft.color });
      toast(firstRun ? `Профиль создан. Ваш код друга — ${p.friendCode}` : 'Профиль сохранён');
      const next = after; after = null;
      if (next) next(p); else nav.go('profile');
    }
    const el = h('div', { class: 'screen hidden', id: 'profileEdit' },
      h('div', { class: 'sheet wide' },
        h('header', { class: 'top' }, back, title),
        h('label', { class: 'field-wrap' }, h('span', { class: 'field-label' }, 'Ник'), nick, nickErr),
        h('div', { class: 'field-label' }, 'Герой'),
        grid, stage,
        h('div', { class: 'field-label' }, 'Цвет формы'),
        kits,
        save));
    return {
      el,
      /** arg: { then(profile) } — куда идти после сохранения (например, в онлайн). */
      open(arg = {}) {
        const p = P.getProfile();
        firstRun = !p; after = arg.then || null;
        draft = p ? { nick: p.nick, heroId: p.heroId, color: p.color } : { nick: '', heroId: 'timur', color: heroById('timur').color };
        title.textContent = firstRun ? 'Кто ты на корте?' : 'Изменить профиль';
        save.querySelector('.bar-label').textContent = firstRun ? (arg.then ? 'Готово, дальше' : 'Создать профиль') : 'Сохранить';
        nick.value = draft.nick; nickErr.textContent = '';
        renderGrid(); renderStage(); renderKits();
      },
    };
  })();

  // -------------------------------------------------------------- карточка профиля
  const view = (() => {
    const body = h('div', { class: 'profile-body' });
    const el = h('div', { class: 'screen hidden', id: 'profile' },
      h('div', { class: 'sheet' }, topBar('Профиль', () => nav.go('menu')), body));
    function open() {
      const p = P.getProfile();
      if (!p) { nav.go('profileEdit'); return; }
      const hero = heroById(p.heroId);
      const st = p.stats;
      const pct = st.matches ? Math.round(st.wins / st.matches * 100) : 0;
      const nFriends = P.listFriends().length;
      const codeBox = h('div', { class: 'code-box' },
        h('div', { class: 'field-label' }, 'Ваш код друга'),
        h('div', { class: 'code-row' }, codePlate(p.friendCode, { label: 'Код друга ' + p.friendCode }),
          h('button', { class: 'icon-btn solid', id: 'copyFriendCode', type: 'button', 'aria-label': 'Скопировать код',
            onclick: async () => { const r = await copyText(p.friendCode); toast(r === 'copied' ? 'Код скопирован' : 'Не удалось скопировать — перепишите код вручную', r === 'copied' ? 'ok' : 'err'); } }, icon('copy'))),
        h('p', { class: 'note' }, 'Друг вводит этот код в разделе «Друзья». После онлайн-матча вы добавитесь друг другу сами.'));
      body.textContent = '';
      body.append(
        h('div', { class: 'id-card', style: `--kit:${p.color}` },
          h('div', { class: 'stage-bust' }, portrait(p.heroId, { size: 128, mood: 'happy', color: p.color, accent: p.accent })),
          h('div', { class: 'id-info' },
            h('div', { class: 'id-nick' }, p.nick),
            h('div', { class: 'hero-role' }, `${hero.name}, ${hero.role.toLowerCase()}`),
            h('button', { class: 'chip-btn', id: 'profileEditBtn', type: 'button', onclick: () => nav.go('profileEdit') }, 'Изменить'))),
        codeBox,
        h('div', { class: 'stat-grid' },
          stat(st.matches, plural(st.matches, 'матч', 'матча', 'матчей')),
          stat(st.wins, plural(st.wins, 'победа', 'победы', 'побед'), st.matches ? `${pct}%` : null),
          stat(st.longestRally, plural(st.longestRally, 'удар', 'удара', 'ударов') + ' в самом длинном розыгрыше'),
          stat(st.smashes, plural(st.smashes, 'смэш', 'смэша', 'смэшей'))),
        h('div', { class: 'row2' },
          h('button', { class: 'bar', id: 'toFriends', type: 'button', onclick: () => nav.go('friends') }, h('span', { class: 'bar-label' }, 'Друзья'), nFriends ? h('span', { class: 'bar-count' }, String(nFriends)) : null),
          h('button', { class: 'bar', id: 'toTransfer', type: 'button', onclick: () => nav.go('transfer') }, h('span', { class: 'bar-label' }, 'Перенести'), h('span', { class: 'bar-sub' }, 'на другое устройство'))));
    }
    function stat(n, label, extra) {
      return h('div', { class: 'stat' }, h('b', {}, String(n)), h('span', {}, label), extra ? h('em', {}, extra) : null);
    }
    return { el, open };
  })();

  // -------------------------------------------------------------- друзья
  const friends = (() => {
    const list = h('ul', { class: 'friend-list', id: 'friendList' });
    const input = h('input', { class: 'field code-field', id: 'friendCodeInput', type: 'text', maxlength: '8', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'go', placeholder: 'Код друга', 'aria-label': 'Код друга' });
    const err = h('p', { class: 'field-err', role: 'alert' });
    input.addEventListener('input', () => { input.value = input.value.toUpperCase(); err.textContent = ''; });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    function add() {
      const res = P.addFriend({ friendCode: input.value });
      if (!res.ok) { err.textContent = res.error; return; }
      input.value = '';
      toast(res.isNew ? `Код ${res.friend.friendCode} добавлен в друзья` : 'Этот друг уже в списке');
      render();
    }
    function render() {
      const fs = P.listFriends();
      list.textContent = '';
      if (!fs.length) {
        list.append(h('li', { class: 'empty' }, 'Друзей пока нет. Добавьте по коду — или сыграйте онлайн, и соперник добавится сам.'));
        return;
      }
      for (const f of fs) {
        const hero = f.heroId ? heroById(f.heroId) : null;
        const del = h('button', { class: 'icon-btn ghost del', type: 'button', 'aria-label': `Удалить ${f.nick}` }, icon('x'));
        del.addEventListener('click', () => {
          if (!del.classList.contains('arm')) {
            list.querySelectorAll('.del.arm').forEach(x => { x.classList.remove('arm'); x.textContent = ''; x.append(icon('x')); });
            del.classList.add('arm'); del.textContent = 'Удалить?';
            return;
          }
          P.removeFriend(f.friendCode); toast(`${f.named ? f.nick : f.friendCode} — больше не в друзьях`); render();
        });
        const games = f.wins + f.losses;
        list.append(h('li', { class: 'friend', 'data-code': f.friendCode, style: `--kit:${f.color || (hero ? hero.color : '#5b5f8a')}` },
          h('div', { class: 'f-bust' }, hero ? portrait(hero.id, { size: 52, color: f.color || undefined, accent: f.color ? P.kitAccent(f.color) : undefined }) : h('span', { class: 'f-q' }, '?')),
          h('div', { class: 'f-info' },
            h('div', { class: 'f-nick' }, f.named ? f.nick : f.friendCode, f.named ? h('small', {}, f.friendCode) : null),
            h('div', { class: 'f-meta' }, f.named ? ago(f.lastPlayed) : 'ник появится после первой игры')),
          h('div', { class: 'f-score', title: 'Личные встречи: ваши победы — его победы' },
            games ? h('b', {}, `${f.wins}:${f.losses}`) : h('b', { class: 'dim' }, '—'),
            h('span', {}, games ? 'встречи' : (f.together ? `${f.together} в паре` : 'не играли'))),
          del));
      }
    }
    const el = h('div', { class: 'screen hidden', id: 'friends' },
      h('div', { class: 'sheet' }, topBar('Друзья', () => nav.back()),
        h('div', { class: 'add-row' }, input, h('button', { class: 'bar go small', id: 'friendAdd', type: 'button', onclick: add }, h('span', { class: 'bar-label' }, 'Добавить'))),
        err, list));
    return { el, open() { err.textContent = ''; render(); } };
  })();

  // -------------------------------------------------------------- перенос
  const transfer = (() => {
    const out = h('textarea', { class: 'field mono', id: 'exportCode', readonly: true, rows: '3', 'aria-label': 'Код профиля' });
    const inp = h('textarea', { class: 'field mono', id: 'importCode', rows: '3', placeholder: 'Вставьте код VOLAN1.… с другого устройства', 'aria-label': 'Код профиля для загрузки', spellcheck: 'false' });
    const err = h('p', { class: 'field-err', role: 'alert' });
    inp.addEventListener('input', () => { err.textContent = ''; });
    const el = h('div', { class: 'screen hidden', id: 'transfer' },
      h('div', { class: 'sheet' }, topBar('Перенос профиля', () => nav.back()),
        h('section', { class: 'block' },
          h('h3', {}, 'Забрать на другое устройство'),
          h('p', { class: 'note' }, 'Скопируйте код и откройте его на новом телефоне или компьютере. В коде — ник, герой, статистика и друзья.'),
          out,
          h('button', { class: 'bar', id: 'exportCopy', type: 'button', onclick: async () => { const r = await copyText(out.value, out); toast(r === 'copied' ? 'Код профиля скопирован' : 'Код выделен — скопируйте его вручную', r === 'copied' ? 'ok' : 'err'); } }, icon('copy'), h('span', { class: 'bar-label' }, 'Скопировать код'))),
        h('section', { class: 'block' },
          h('h3', {}, 'Загрузить на это устройство'),
          h('p', { class: 'note warn' }, 'Профиль на этом устройстве заменится загруженным.'),
          inp, err,
          h('button', { class: 'bar', id: 'importGo', type: 'button', onclick: () => {
            const r = P.importProfile(inp.value);
            if (!r.ok) { err.textContent = r.error; return; }
            inp.value = ''; toast(`Профиль «${r.profile.nick}» загружен`); nav.go('profile');
          } }, h('span', { class: 'bar-label' }, 'Загрузить профиль')))));
    return { el, open() { out.value = P.exportProfile(); err.textContent = ''; } };
  })();

  return { edit, view, friends, transfer };
}

export { seg };
