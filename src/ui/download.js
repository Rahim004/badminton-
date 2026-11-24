/**
 * ui/download.js — экран «Скачать игру»: установка как приложения (PWA) и прямые ссылки на
 * APK / exe из GitHub Releases. Показывает инструкцию для платформы пользователя.
 *   buildDownloadScreen(nav) -> { el, open }        id для тестов: #download #installBtn #dlApk #dlExe
 *   downloadAvailable()                              — false внутри APK/exe и в установленном PWA
 */
import { h, icon, toast } from './dom.js';
import { topBar } from './profileScreens.js';
import { pwa } from '../pwa.js';
import { VERSION, SITE_URL, RELEASE_LATEST, RELEASES_PAGE, DOWNLOADS } from '../version.js';

export function downloadAvailable() { return !pwa.isInstalled(); }

/** Инструкции по платформам: ключ → { title, steps[], note? } */
export const GUIDES = {
  ios: {
    title: 'iPhone и iPad (Safari)',
    steps: [
      'Откройте игру в Safari (а не во встроенном браузере мессенджера).',
      'Нажмите «Поделиться» — квадрат со стрелкой вверх (на iPhone внизу экрана, на iPad вверху).',
      'Прокрутите список вниз и выберите «На экран “Домой”».',
      'Нажмите «Добавить». Иконка «Волан» появится на экране — запускайте как обычное приложение.',
    ],
    note: 'В Chrome на iPhone то же самое: «Поделиться» → «На экран “Домой”» (iOS 16.4 и новее). Если такого пункта нет — откройте ссылку в Safari.',
  },
  android: {
    title: 'Android (Chrome и другие)',
    steps: [
      'Откройте игру в Chrome.',
      'Нажмите меню ⋮ в углу и выберите «Установить приложение» (или «Добавить на главный экран»).',
      'Подтвердите — «Волан» появится среди приложений и работает без интернета (против ИИ).',
    ],
    note: 'Samsung Internet и Яндекс Браузер: меню → «Добавить страницу в» → «Главный экран». Firefox: меню ⋮ → «Установить». Можно также скачать APK ниже.',
  },
  desk: {
    title: 'Компьютер (Chrome, Edge, Яндекс, Opera)',
    steps: [
      'Откройте игру в Chrome, Edge, Яндекс Браузере или Opera.',
      'В адресной строке справа нажмите значок установки (монитор со стрелкой) и выберите «Установить».',
      'Если значка нет: меню ⋮ → «Установить Волан» (в Edge: ⋯ → «Приложения» → «Установить этот сайт как приложение»).',
      'Игра откроется в своём окне, ярлык появится в меню «Пуск» или на рабочем столе.',
    ],
    note: 'Либо скачайте готовый файл Volan.exe ниже — ничего устанавливать не нужно.',
  },
  macsafari: {
    title: 'Mac (Safari)',
    steps: [
      'Откройте игру в Safari 17 или новее.',
      'Выберите в строке меню «Файл» → «Добавить в Dock».',
      'Нажмите «Добавить» — «Волан» запустится из Dock как приложение.',
    ],
  },
  firefox: {
    title: 'Firefox на компьютере',
    steps: [
      'Firefox на компьютере не умеет устанавливать веб-приложения.',
      'Откройте эту же ссылку в Chrome, Edge или Яндекс Браузере и установите оттуда — или скачайте Volan.exe ниже.',
    ],
  },
};

function guideKeyFor(p) {
  if (p.os === 'ios') return 'ios';
  if (p.os === 'android') return 'android';
  if (p.browser === 'safari') return 'macsafari';
  if (p.browser === 'firefox') return 'firefox';
  return 'desk';
}

function guideEl(key, open) {
  const g = GUIDES[key];
  return h('details', { class: 'guide', 'data-guide': key, open: open || null },
    h('summary', {}, g.title),
    h('ol', { class: 'steps' }, g.steps.map(s => h('li', {}, s))),
    g.note ? h('p', { class: 'note' }, g.note) : null);
}

/** Настоящая ссылка: в песочнице iframe откроется в новой вкладке, в приложении — во внешнем браузере. */
function dlLink(id, d, cls) {
  return h('a', { class: 'bar dl-link ' + (cls || ''), id, href: RELEASE_LATEST + d.file, target: '_blank', rel: 'noopener noreferrer', download: d.file },
    icon('download'),
    h('span', { class: 'bar-label' }, d.label),
    h('span', { class: 'bar-sub' }, `${d.file} · ${d.size}`));
}

export function buildDownloadScreen(nav) {
  const body = h('div', { class: 'dl-body' });
  const el = h('div', { class: 'screen hidden', id: 'download' },
    h('div', { class: 'sheet wide' }, topBar('Скачать игру', () => nav.back()), body));
  let off = null;

  function paint() {
    const p = pwa.platform();
    const key = guideKeyFor(p);
    body.textContent = '';

    if (pwa.inNativeApp()) {
      body.append(h('div', { class: 'block dl-state' }, h('h3', {}, 'Вы уже в приложении'), h('p', { class: 'note' }, 'Это приложение «Волан», игра хранится на устройстве и работает без интернета (против ИИ). Для онлайна с друзьями нужна сеть.')),
        h('p', { class: 'note center', id: 'dlVersion' }, `Версия ${VERSION}`));
      return;
    }

    // ---------------------------------------------------------- установка (PWA)
    const installBox = h('section', { class: 'block', id: 'installBox' }, h('h3', {}, 'Установить на устройство'));
    if (pwa.isInstalled()) {
      installBox.append(h('p', { class: 'note ok' }, 'Игра уже установлена на это устройство.'));
    } else {
      if (pwa.inFrame()) {
        installBox.append(h('p', { class: 'note warn', id: 'frameNote' }, 'Сейчас игра открыта во встроенном окне — установить отсюда нельзя. Откройте её в отдельной вкладке:'),
          h('a', { class: 'bar small sky', id: 'openSite', href: SITE_URL, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'bar-label' }, 'Открыть игру в браузере')));
      }
      if (pwa.canPrompt()) {
        installBox.append(
          h('p', { class: 'note' }, 'Игра встанет рядом с обычными приложениями, запускается в своём окне и работает без интернета (против ИИ).'),
          h('button', { class: 'bar go', id: 'installBtn', type: 'button', onclick: async () => {
            const r = await pwa.prompt();
            if (r === 'accepted') toast('Волан установлен');
            else if (r === 'unavailable') toast('Установка недоступна — следуйте инструкции ниже', 'err');
          } }, icon('download'), h('span', { class: 'bar-label' }, 'Установить')),
          h('details', { class: 'more' }, h('summary', {}, 'Установить вручную'), guideEl(key, true)));
      } else {
        installBox.append(guideEl(key, true));
      }
      const others = Object.keys(GUIDES).filter(k => k !== key);
      installBox.append(h('details', { class: 'more' }, h('summary', {}, 'Инструкции для других устройств'), ...others.map(k => guideEl(k, false))));
    }
    body.append(installBox);

    // ---------------------------------------------------------- прямые ссылки
    const apkFirst = p.os === 'android';
    const apk = dlLink('dlApk', DOWNLOADS.apk, apkFirst ? 'go' : '');
    const exe = dlLink('dlExe', DOWNLOADS.exe, !apkFirst && !p.mobile ? 'go' : '');
    const links = h('div', { class: 'dl-links' }, ...(apkFirst ? [apk, exe] : [exe, apk]));
    const files = h('section', { class: 'block', id: 'filesBox' }, h('h3', {}, 'Скачать файлом'), links,
      h('a', { class: 'dl-alt', id: 'dlAppImage', href: RELEASE_LATEST + DOWNLOADS.appimage.file, target: '_blank', rel: 'noopener noreferrer' }, `Linux: ${DOWNLOADS.appimage.file} · ${DOWNLOADS.appimage.size}`));
    if (p.os === 'ios') files.append(h('p', { class: 'note warn' }, 'На iPhone и iPad файлы APK и exe не работают — установите игру через Safari (инструкция выше).'));
    files.append(
      h('details', { class: 'more', id: 'apkHelp' }, h('summary', {}, 'Как установить APK на Android'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Скачайте файл Volan.apk и откройте его (из уведомления или из папки «Загрузки»).'),
          h('li', {}, 'Если телефон спросит — разрешите установку из неизвестных источников для вашего браузера или «Файлов» (Настройки → Безопасность или «Особый доступ»).'),
          h('li', {}, 'Нажмите «Установить». Если Play Защита предупреждает, выберите «Всё равно установить» — приложение не из магазина.'),
          h('li', {}, 'Обновление: просто поставьте новый APK поверх старого, прогресс сохранится.'))),
      h('details', { class: 'more', id: 'exeHelp' }, h('summary', {}, 'Как запустить Volan.exe на Windows'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Скачайте Volan.exe и запустите двойным щелчком — установка не нужна, это портативная версия.'),
          h('li', {}, 'Если Windows пишет «Система Windows защитила ваш компьютер», нажмите «Подробнее» → «Выполнить в любом случае» (файл не подписан платным сертификатом).'),
          h('li', {}, 'Полный экран — F11.'))),
      h('p', { class: 'note' }, 'Файлы лежат на GitHub. Если ссылка не открывается, включите VPN или установите игру из браузера (выше). ',
        h('a', { href: RELEASES_PAGE, target: '_blank', rel: 'noopener noreferrer' }, 'Все версии')));
    body.append(files, h('p', { class: 'note center', id: 'dlVersion' }, `Версия ${VERSION}`));
  }

  return {
    el,
    open() {
      paint();
      if (off) off();
      off = pwa.onChange(() => { if (!el.classList.contains('hidden')) paint(); });
    },
  };
}
