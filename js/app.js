// Viewer карточек: список, карточка, повторение по интервалам, экспорт/импорт. Чистый JS.
(function (global) {
  'use strict';

  var REPO_URL = 'https://github.com/Covch/chinese-study-notes';

  var INDEX_URL = 'cards/index.json';
  // Значения bad/ok/good — контракт хранилища (см. CARD_FORMAT.md), меняются только подписи.
  var RATING_ORDER = ['bad', 'ok', 'good'];
  var RATING_LABELS = { bad: 'Не помню', ok: 'Слабо помню', good: 'Хорошо помню' };
  var RATING_CLASSES = { bad: 'rate-bad', ok: 'rate-ok', good: 'rate-good' };
  var RATING_KEYS = { bad: '1', ok: '2', good: '3' };
  var TYPE_LABELS = { hieroglyph: 'иероглиф', rule: 'правило' };
  var LIST_PAGE_SIZE = 20;

  var state = {
    cards: [],        // элементы index.json
    current: null,    // текущая карточка-элемент индекса
    filters: { lesson: '', level: '', search: '' },
    listPage: 1,      // страница списка карточек
    session: null     // {mode, paths, i, done, requeued, currentPath}
  };

  var el = {};

  // --- утилиты -------------------------------------------------------------

  // Кодируем путь по сегментам: CJK/кириллица в именах файлов.
  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function decodePath(path) {
    return String(path).split('/').map(function (seg) {
      try {
        return decodeURIComponent(seg);
      } catch (e) {
        return seg;
      }
    }).join('/');
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] || type || 'без типа';
  }

  function lessonLabel(lesson) {
    return (lesson === null || lesson === undefined || lesson === '') ? 'урок —' : 'урок ' + lesson;
  }

  function setText(node, text) {
    node.textContent = text;
  }

  function show(node, visible) {
    node.classList.toggle('hidden', !visible);
  }

  function formatDate(ts) {
    var date = new Date(Number(ts) * 1000);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('ru-RU');
  }

  // «слово» в нужной форме: 1 карточка, 2 карточки, 5 карточек.
  function plural(n, one, few, many) {
    var abs = Math.abs(n) % 100;
    var last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  function cardByPath(path) {
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].path === path) return state.cards[i];
    }
    return null;
  }

  // --- загрузка ------------------------------------------------------------

  function loadIndex() {
    return fetch(INDEX_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' при загрузке ' + INDEX_URL);
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.cards)) {
        throw new Error('Некорректный index.json: нет массива cards');
      }
      // Дубликаты путей не мешают рендеру — просто подстраховываемся.
      var seen = {};
      return data.cards.filter(function (card) {
        var path = card && card.path;
        if (!path || seen[path]) return false;
        seen[path] = true;
        return true;
      });
    });
  }

  function loadCardText(path) {
    return fetch(encodePath(path)).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' — файл не найден');
      return res.text();
    });
  }

  // --- фильтры -------------------------------------------------------------

  function collectFilterValues(cards, key) {
    var values = [];
    cards.forEach(function (card) {
      var value = card[key];
      if (value === null || value === undefined || value === '') return;
      if (values.indexOf(value) === -1) values.push(value);
    });
    if (key === 'lesson') {
      values.sort(function (a, b) { return Number(a) - Number(b); });
    } else {
      values.sort();
    }
    return values;
  }

  function fillSelect(select, values, allLabel) {
    select.innerHTML = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    select.appendChild(all);
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = String(value);
      option.textContent = String(value);
      select.appendChild(option);
    });
  }

  // Тип отображаем по-русски, а в value держим исходное значение из индекса.
  function fillTypeSelect(select, cards) {
    var values = collectFilterValues(cards, 'type');
    select.innerHTML = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'все типы';
    select.appendChild(all);
    values.forEach(function (type) {
      var option = document.createElement('option');
      option.value = String(type);
      option.textContent = typeLabel(type);
      select.appendChild(option);
    });
  }

  // Один набор условий на список и на повторение.
  function matchFilters(card, filters) {
    if (filters.lesson !== '' && String(card.lesson) !== filters.lesson) return false;
    if (filters.level !== '' && String(card.level) !== filters.level) return false;
    // У фильтров списка поля type нет — отсутствующее значение считаем «без фильтра».
    if (filters.type && String(card.type || '') !== filters.type) return false;
    var search = String(filters.search || '').trim().toLowerCase();
    if (search && String(card.title || '').toLowerCase().indexOf(search) === -1) return false;
    return true;
  }

  function filteredCards(filters) {
    var f = filters || state.filters;
    return state.cards.filter(function (card) { return matchFilters(card, f); });
  }

  function renderList() {
    var cards = filteredCards(state.filters);
    el.cardList.innerHTML = '';
    show(el.listPager, false);

    if (cards.length === 0) {
      setText(el.listStatus, state.cards.length === 0 ? 'Карточек пока нет.' : 'Ничего не найдено по фильтрам.');
      return;
    }

    var page = global.Pagination.slice(cards, state.listPage, LIST_PAGE_SIZE);
    state.listPage = page.page;

    setText(el.listStatus, 'Показано: ' + cards.length + ' из ' + state.cards.length);

    page.items.forEach(function (card) {
      var li = document.createElement('li');
      li.className = 'card-item';
      li.tabIndex = 0;

      var title = document.createElement('div');
      title.className = 'card-item-title';
      setText(title, card.title || card.path);

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.appendChild(badge(typeLabel(card.type)));
      meta.appendChild(badge(lessonLabel(card.lesson)));
      if (card.level) meta.appendChild(badge(card.level));

      li.appendChild(title);
      li.appendChild(meta);

      var open = function () { openCard(card.path); };
      li.addEventListener('click', open);
      li.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      });

      el.cardList.appendChild(li);
    });

    if (page.pages > 1) {
      show(el.listPager, true);
      setText(el.listPageInfo, 'Страница ' + page.page + ' из ' + page.pages);
      el.btnListPrev.disabled = page.page <= 1;
      el.btnListNext.disabled = page.page >= page.pages;
    }
  }

  function badge(text) {
    var span = document.createElement('span');
    span.className = 'badge';
    setText(span, text);
    return span;
  }

  // --- карточка ------------------------------------------------------------

  function openCard(path) {
    var card = cardByPath(path);
    state.current = card || { path: path, title: path, type: '', lesson: null, level: '' };

    // Хеш обновляем сразу — ссылку можно копировать до загрузки файла.
    global.location.hash = 'card=' + encodePath(path);

    el.cardSections.innerHTML = '';
    show(el.cardError, false);
    show(el.cardPreamble, false);
    show(el.cardRating, false);
    setText(el.cardTitle, state.current.title || path);
    renderCardMeta(el.cardMeta, state.current, false);
    updateNavButtons();

    loadCardText(path).then(function (text) {
      renderCardBody(el.cardPreamble, el.cardSections, window.MdParser.parseCard(text), state.current.type);
      renderRating(state.current.path);
      show(el.cardRating, true);
    }).catch(function (error) {
      setText(el.cardError, 'Не удалось открыть карточку: ' + (error && error.message ? error.message : error));
      show(el.cardError, true);
    });
  }

  function renderCardMeta(node, card, isNew) {
    node.innerHTML = '';
    node.appendChild(badge(typeLabel(card.type)));
    node.appendChild(badge(lessonLabel(card.lesson)));
    if (card.level) node.appendChild(badge(card.level));
    if (isNew) {
      var fresh = badge('новая');
      fresh.classList.add('badge-new');
      node.appendChild(fresh);
    }
  }

  function renderCardBody(preambleEl, sectionsEl, parsed, type) {
    if (parsed.preamble) {
      setText(preambleEl, parsed.preamble);
      show(preambleEl, true);
    } else {
      show(preambleEl, false);
    }

    sectionsEl.innerHTML = '';

    if (parsed.sections.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'status';
      setText(empty, 'В карточке нет секций.');
      sectionsEl.appendChild(empty);
      return;
    }

    parsed.sections.forEach(function (section) {
      sectionsEl.appendChild(buildSpoiler(section, type));
    });
  }

  // Одна секция = один спойлер. Раскрытие через max-height + opacity.
  function buildSpoiler(section, type) {
    var wrap = document.createElement('div');
    wrap.className = 'spoiler';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'spoiler-head';
    button.setAttribute('aria-expanded', 'false');

    var label = document.createElement('span');
    label.className = 'spoiler-label';
    setText(label, section.title || 'Без названия');

    var hint = document.createElement('span');
    hint.className = 'spoiler-hint';

    button.appendChild(label);
    button.appendChild(hint);

    var body = document.createElement('div');
    body.className = 'spoiler-body';

    var content = document.createElement('div');
    content.className = 'spoiler-content';
    if (section.empty) {
      content.classList.add('is-empty');
      setText(content, 'пусто');
    } else {
      if (type === 'hieroglyph' && /иероглиф/i.test(section.title)) {
        content.classList.add('cjk-large');
      }
      setText(content, section.content);
    }
    body.appendChild(content);

    function setOpen(open) {
      wrap.classList.toggle('open', open);
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      setText(hint, open ? 'нажмите, чтобы закрыть' : 'нажмите, чтобы открыть');
      if (open) {
        body.style.maxHeight = content.scrollHeight + 'px';
        body.style.opacity = '1';
      } else {
        body.style.maxHeight = '0px';
        body.style.opacity = '0';
      }
    }

    button.addEventListener('click', function () {
      setOpen(!wrap.classList.contains('open'));
    });

    setOpen(false);
    wrap.appendChild(button);
    wrap.appendChild(body);
    return wrap;
  }

  function updateNavButtons() {
    var index = indexOfCurrent();
    el.btnPrev.disabled = index <= 0;
    el.btnNext.disabled = index === -1 || index >= state.cards.length - 1;
  }

  function indexOfCurrent() {
    if (!state.current) return -1;
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].path === state.current.path) return i;
    }
    return -1;
  }

  function goRelative(delta) {
    var index = indexOfCurrent();
    if (index === -1) return;
    var next = state.cards[index + delta];
    if (next) openCard(next.path);
  }

  // --- самооценка ----------------------------------------------------------

  // Кнопки оценок строим из одного списка — и в карточке, и в сессии.
  function buildRatingButtons(container) {
    container.innerHTML = '';
    RATING_ORDER.forEach(function (rating) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn rate ' + RATING_CLASSES[rating];
      button.setAttribute('data-rating', rating);
      button.title = 'Клавиша ' + RATING_KEYS[rating];
      setText(button, RATING_LABELS[rating] + ' (' + RATING_KEYS[rating] + ')');
      container.appendChild(button);
    });
  }

  function scheduleText(srs) {
    if (!srs) return 'В расписании нет — карточка новая.';
    var days = global.Srs.daysUntil(srs, nowSec());
    if (days <= 0) return 'Пора повторить.';
    return 'Следующее повторение: ' + formatDate(srs.due) + ' (через ' + days + ' ' + plural(days, 'день', 'дня', 'дней') + ').';
  }

  function renderRating(path) {
    var ratings = global.Store.getRatings(path);
    var srs = global.Store.getSrsCard(path);
    var parts = [];

    if (ratings.length === 0) {
      parts.push('Оценок пока нет.');
    } else {
      var last = ratings[ratings.length - 1];
      parts.push('Оценок: ' + ratings.length + ' · последняя: ' +
        (RATING_LABELS[last.rating] || last.rating) + ' (' + formatDate(last.ts) + ')');
    }
    parts.push(scheduleText(srs));
    setText(el.ratingInfo, parts.join(' '));
  }

  // Оценка пишется и в историю, и в расписание повторений.
  function applyRating(path, rating) {
    global.Store.addRating(path, rating);
    var next = global.Srs.review(global.Store.getSrsCard(path), rating, nowSec());
    global.Store.setSrsCard(path, next);
    return next;
  }

  function onRate(rating) {
    if (!state.current) return;
    applyRating(state.current.path, rating);
    renderRating(state.current.path);
    el.ratingInfo.classList.add('flash');
    global.setTimeout(function () { el.ratingInfo.classList.remove('flash'); }, 500);
  }

  // --- повторение: настройка -----------------------------------------------

  function reviewFilters() {
    return {
      lesson: el.reviewLesson.value,
      level: el.reviewLevel.value,
      type: el.reviewType.value,
      search: ''
    };
  }

  // Очередь под текущие фильтры. В режиме «вручную» порядок — как в индексе.
  function buildReviewQueue() {
    var matching = filteredCards(reviewFilters());
    var mode = el.reviewMode.value === 'manual' ? 'manual' : 'srs';
    var limit = parseInt(el.reviewSize.value, 10);
    if (isNaN(limit) || limit < 0) limit = 0;

    if (mode === 'manual') {
      var paths = matching.map(function (card) { return card.path; });
      if (limit > 0) paths = paths.slice(0, limit);
      return { mode: 'manual', paths: paths, matching: matching.length };
    }

    var queue = global.Srs.buildQueue(matching, global.Store.getSrs(), { now: nowSec(), limit: limit });
    return { mode: 'srs', paths: queue.paths, matching: matching.length, queue: queue };
  }

  function refreshReviewStatus(note) {
    var built = buildReviewQueue();
    var lines = [];

    if (note) lines.push(note);

    if (state.cards.length === 0) {
      lines.push('Список карточек ещё не загрузился.');
    } else if (built.paths.length === 0) {
      lines.push('Под фильтры не подошла ни одна карточка.');
      if (built.mode === 'srs' && built.matching > 0) {
        var next = built.queue.nextDue;
        lines.push('Все подходящие карточки повторены' + (next ? ', ближайшая — ' + formatDate(next) : '') + '. Можно снять фильтры или выбрать другой режим.');
      }
    } else if (built.mode === 'manual') {
      lines.push('Вручную: под фильтры подходит ' + built.matching + ' ' +
        plural(built.matching, 'карточка', 'карточки', 'карточек') + ', в сессию попадёт ' + built.paths.length + '.');
    } else {
      var q = built.queue;
      lines.push('Пора повторить: ' + q.dueCount + ' · новых: ' + q.newCount +
        ' · ещё не пора: ' + q.laterCount + '. В сессию попадёт ' + built.paths.length + '.');
      if (q.nextDue) lines.push('Ближайшее повторение из тех, что не пора: ' + formatDate(q.nextDue) + '.');
    }

    setText(el.reviewStatus, lines.join(' '));

    // Приватный режим: повторять можно, но оценки никуда не денутся — предупреждаем сразу.
    if (global.Store.isAvailable()) {
      show(el.reviewError, false);
    } else {
      setText(el.reviewError, 'Браузер не сохраняет данные (приватный режим?). Оценки и расписание не запишутся.');
      show(el.reviewError, true);
    }

    updateResumeButton();
  }

  // --- повторение: сессия --------------------------------------------------

  function savedSession() {
    var saved = global.Store.getSession();
    if (!saved || !Array.isArray(saved.paths) || saved.i >= saved.paths.length) return null;
    return saved;
  }

  function updateResumeButton() {
    var saved = savedSession();
    show(el.btnResumeReview, !!saved);
    if (saved) {
      var left = global.Srs.sessionLeft(saved);
      setText(el.btnResumeReview, 'Продолжить начатую (' + left + ' ' + plural(left, 'карточка', 'карточки', 'карточек') + ')');
    }
  }

  function saveSession() {
    if (!state.session) {
      global.Store.clearSession();
      return;
    }
    global.Store.setSession({
      mode: state.session.mode,
      paths: state.session.paths,
      i: state.session.i,
      done: state.session.done,
      requeued: state.session.requeued
    });
  }

  function startSession(paths, mode) {
    state.session = {
      mode: mode,
      paths: paths.slice(),
      i: 0,
      done: 0,
      requeued: {},
      currentPath: ''
    };
    saveSession();
    showOnly(el.viewSession);
    setActiveTab('review');
    renderSessionCard();
  }

  function resumeSession() {
    var saved = savedSession();
    if (!saved) {
      updateResumeButton();
      refreshReviewStatus('Начатых сессий нет.');
      return;
    }
    // Пути, которых больше нет в индексе, из будущего выбрасываем, а пройденные оставляем,
    // чтобы нумерация «карточка X из Y» не сдвинулась.
    var known = {};
    state.cards.forEach(function (card) { known[card.path] = true; });
    var prefix = saved.paths.slice(0, saved.i);
    var tail = saved.paths.slice(saved.i).filter(function (path) { return known[path]; });

    state.session = {
      mode: saved.mode === 'manual' ? 'manual' : 'srs',
      paths: prefix.concat(tail),
      i: saved.i,
      done: saved.done || 0,
      requeued: saved.requeued || {},
      currentPath: ''
    };
    showOnly(el.viewSession);
    setActiveTab('review');
    renderSessionCard();
  }

  function updateSessionProgress() {
    var session = state.session;
    if (!session) return;
    var total = session.paths.length;
    setText(el.sessionProgressText, 'Карточка ' + Math.min(session.i + 1, total) + ' из ' + total +
      ' · оценено ' + session.done);
    var percent = total > 0 ? Math.round((session.done / total) * 100) : 0;
    el.sessionProgressFill.style.width = percent + '%';
  }

  function renderSessionCard() {
    var session = state.session;
    if (!session) return;

    var path = session.paths[session.i];
    var card = cardByPath(path) || { path: path, title: path, type: '', lesson: null, level: '' };
    session.currentPath = path;

    el.sessionSections.innerHTML = '';
    show(el.sessionError, false);
    show(el.sessionPreamble, false);
    show(el.sessionRating, false);
    setText(el.sessionTitle, card.title || path);
    renderCardMeta(el.sessionMeta, card, !global.Store.getSrsCard(path));
    updateSessionProgress();

    loadCardText(path).then(function (text) {
      renderCardBody(el.sessionPreamble, el.sessionSections, window.MdParser.parseCard(text), card.type);
      renderSessionInfo(path);
      show(el.sessionRating, true);
    }).catch(function (error) {
      setText(el.sessionError, 'Не удалось открыть карточку: ' +
        (error && error.message ? error.message : error) + ' Нажмите «Пропустить».');
      show(el.sessionError, true);
    });
  }

  function renderSessionInfo(path) {
    var ratings = global.Store.getRatings(path);
    var srs = global.Store.getSrsCard(path);
    var parts = [];
    parts.push(ratings.length === 0 ? 'Новая карточка.' : 'Повторов: ' + ratings.length + '.');
    parts.push(scheduleText(srs));
    setText(el.sessionRatingInfo, parts.join(' '));
  }

  function onSessionRate(rating) {
    var session = state.session;
    if (!session || !session.currentPath) return;
    applyRating(session.currentPath, rating);
    advanceSession(global.Srs.stepSession(session, rating, global.Srs.MAX_REQUEUE));
  }

  function skipSessionCard() {
    if (!state.session) return;
    advanceSession(global.Srs.stepSession(state.session, null));
  }

  // Очередь шагает целиком в Srs.stepSession — здесь только подмена состояния и отрисовка.
  function advanceSession(step) {
    if (!state.session || !step) return;
    state.session = {
      mode: state.session.mode,
      paths: step.paths,
      i: step.i,
      done: step.done,
      requeued: step.requeued,
      currentPath: ''
    };
    if (state.session.i >= state.session.paths.length) {
      finishSession();
      return;
    }
    saveSession();
    renderSessionCard();
  }

  function finishSession() {
    var done = state.session ? state.session.done : 0;
    state.session = null;
    global.Store.clearSession();
    setActiveTab('review');
    showOnly(el.viewReview);
    refreshReviewStatus('Сессия завершена: оценено ' + done + ' ' + plural(done, 'карточка', 'карточки', 'карточек') + '.');
    global.scrollTo(0, 0);
  }

  function exitSession() {
    if (!state.session) return;
    saveSession();
    var passed = state.session.i;
    state.session = null;
    setActiveTab('review');
    showOnly(el.viewReview);
    refreshReviewStatus('Сессия отложена: пройдено ' + passed + ' ' + plural(passed, 'карточка', 'карточки', 'карточек') + '. Продолжить можно кнопкой ниже.');
  }

  // --- данные: экспорт и импорт --------------------------------------------

  function renderDataSummary() {
    var available = global.Store.isAvailable();
    if (!available) {
      setText(el.dataUnavailable, 'Браузер не даёт сохранять данные (приватный режим?). Читать и выгружать можно, записывать — нет.');
      show(el.dataUnavailable, true);
    } else {
      show(el.dataUnavailable, false);
    }

    var progress = global.Store.getAllProgress();
    var ratings = 0;
    for (var path in progress) {
      if (Object.prototype.hasOwnProperty.call(progress, path)) ratings += progress[path].length;
    }
    var srsCount = Object.keys(global.Store.getSrs()).length;
    var name = global.Store.getUserName();

    setText(el.dataSummary, 'Имя: ' + (name || '—') + ' · оценок: ' + ratings +
      ' · карточек в расписании: ' + srsCount + ' · всего карточек в индексе: ' + state.cards.length);
    updateResumeButton();
  }

  function exportFileName() {
    var date = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'chinese-cards-' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '.json';
  }

  function onExport() {
    var text = JSON.stringify(global.Store.exportData(), null, 2);
    var blob = new global.Blob([text], { type: 'application/json' });
    var url = global.URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);

    setText(el.exportResult, 'Файл ' + exportFileName() + ' выгружен.');
    show(el.exportResult, true);
  }

  function importSummaryText(summary, mode) {
    var parts = [];
    parts.push(mode === 'replace' ? 'Загружено с заменой.' : 'Объединено с текущими данными.');
    parts.push('Добавлено оценок: ' + summary.ratingsAdded + ' (всего ' + summary.ratingsTotal + ').');
    parts.push('Обновлено расписаний: ' + summary.srsUpdated + ' (всего ' + summary.srsTotal + ').');
    if (summary.orphanPaths > 0) {
      parts.push('Записей вне текущего индекса: ' + summary.orphanPaths + ' — они сохранены.');
    }
    if (summary.skipped > 0) parts.push('Пропущено битых записей: ' + summary.skipped + '.');
    (summary.warnings || []).forEach(function (line) { parts.push(line + '.'); });
    parts.push('Имя: ' + summary.nameNote + '.');
    return parts.join(' ');
  }

  function onImportFile() {
    var file = el.importFile.files && el.importFile.files[0];
    if (!file) return;

    var reader = new global.FileReader();
    reader.onload = function () {
      var raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (e) {
        el.importFile.value = '';
        show(el.importResult, false);
        setText(el.importError, 'Файл не разобрался как JSON: ' + (e && e.message ? e.message : e));
        show(el.importError, true);
        return;
      }

      var mode = el.importMode.value === 'replace' ? 'replace' : 'merge';
      el.importFile.value = '';

      if (mode === 'replace' && !global.confirm('Заменить текущие оценки и расписание данными из файла? Действие необратимо.')) {
        return;
      }

      var knownPaths = state.cards.map(function (card) { return card.path; });
      var result = global.Store.importData(raw, mode, knownPaths);

      if (!result.ok) {
        show(el.importResult, false);
        setText(el.importError, 'Импорт не выполнен: ' + result.error + '.');
        show(el.importError, true);
        return;
      }

      show(el.importError, false);
      setText(el.importResult, importSummaryText(result.summary, mode));
      show(el.importResult, true);
      renderDataSummary();
    };

    reader.onerror = function () {
      el.importFile.value = '';
      show(el.importResult, false);
      setText(el.importError, 'Не удалось прочитать файл.');
      show(el.importError, true);
    };

    reader.readAsText(file);
  }

  function onResetSrs() {
    if (!global.confirm('Сбросить интервалы повторений? История оценок останется.')) return;
    global.Store.resetSrs();
    setText(el.resetResult, 'Расписание сброшено: все карточки снова считаются новыми.');
    show(el.resetResult, true);
    renderDataSummary();
  }

  // --- навигация между экранами и hash-роутинг -----------------------------

  function showOnly(view) {
    [el.viewList, el.viewCard, el.viewReview, el.viewSession, el.viewData].forEach(function (node) {
      show(node, node === view);
    });
  }

  function setActiveTab(name) {
    el.tabList.classList.toggle('is-active', name === 'list');
    el.tabReview.classList.toggle('is-active', name === 'review');
    el.tabData.classList.toggle('is-active', name === 'data');
  }

  function showList() {
    state.current = null;
    // У списка канонический адрес — без хеша: убираем любой (#card=, #review, #data),
    // иначе после перезагрузки страница открывалась бы не на том экране, что в адресе.
    if (global.location.hash) {
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    }
    showOnly(el.viewList);
    setActiveTab('list');
    renderList();
  }

  function showReview(note) {
    state.session = null;
    showOnly(el.viewReview);
    setActiveTab('review');
    refreshReviewStatus(note);
  }

  function showData() {
    state.session = null;
    showOnly(el.viewData);
    setActiveTab('data');
    show(el.importResult, false);
    show(el.importError, false);
    show(el.exportResult, false);
    show(el.resetResult, false);
    renderDataSummary();
  }

  function handleHash() {
    var hash = global.location.hash || '';
    var prefix = '#card=';
    if (hash.indexOf(prefix) === 0) {
      var path = decodePath(hash.slice(prefix.length));
      showOnly(el.viewCard);
      setActiveTab('list');
      if (!state.current || state.current.path !== path) openCard(path);
      return;
    }
    if (hash === '#review') { showReview(); return; }
    if (hash === '#data') { showData(); return; }
    showList();
  }

  // --- инициализация -------------------------------------------------------

  function cacheElements() {
    var ids = ['view-list', 'view-card', 'view-review', 'view-session', 'view-data',
      'tab-list', 'tab-review', 'tab-data',
      'card-list', 'list-status', 'list-error',
      'list-pager', 'list-page-info', 'btn-list-prev', 'btn-list-next',
      'user-name', 'filter-lesson', 'filter-level', 'filter-search', 'filter-reset',
      'card-title', 'card-meta', 'card-sections', 'card-preamble', 'card-error',
      'card-rating', 'card-rating-buttons', 'rating-info', 'btn-back', 'btn-prev', 'btn-next',
      'review-mode', 'review-lesson', 'review-level', 'review-type', 'review-size',
      'review-status', 'review-error', 'btn-start-review', 'btn-resume-review',
      'session-progress-text', 'session-progress-fill', 'session-title', 'session-meta',
      'session-preamble', 'session-sections', 'session-error', 'session-rating',
      'session-rating-buttons', 'session-rating-info', 'btn-skip', 'btn-exit-session',
      'data-summary', 'data-unavailable', 'btn-export', 'export-result', 'import-mode',
      'import-file', 'import-result', 'import-error', 'btn-reset-srs', 'reset-result',
      'repo-link'];
    ids.forEach(function (id) {
      el[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  function bindEvents() {
    el.userName.value = global.Store.getUserName();
    el.userName.addEventListener('input', function () {
      global.Store.setUserName(el.userName.value);
    });

    el.filterLesson.addEventListener('change', function () {
      state.filters.lesson = el.filterLesson.value;
      state.listPage = 1;
      renderList();
    });
    el.filterLevel.addEventListener('change', function () {
      state.filters.level = el.filterLevel.value;
      state.listPage = 1;
      renderList();
    });
    el.filterSearch.addEventListener('input', function () {
      state.filters.search = el.filterSearch.value;
      state.listPage = 1;
      renderList();
    });
    el.filterReset.addEventListener('click', function () {
      state.filters = { lesson: '', level: '', search: '' };
      state.listPage = 1;
      el.filterLesson.value = '';
      el.filterLevel.value = '';
      el.filterSearch.value = '';
      renderList();
    });

    el.btnListPrev.addEventListener('click', function () {
      state.listPage -= 1;
      renderList();
      global.scrollTo(0, 0);
    });
    el.btnListNext.addEventListener('click', function () {
      state.listPage += 1;
      renderList();
      global.scrollTo(0, 0);
    });

    el.btnBack.addEventListener('click', function () { showList(); });
    el.btnPrev.addEventListener('click', function () { goRelative(-1); });
    el.btnNext.addEventListener('click', function () { goRelative(1); });

    el.tabList.addEventListener('click', function () { showList(); });
    el.tabReview.addEventListener('click', function () {
      if (global.location.hash === '#review') { showReview(); return; }
      global.location.hash = 'review';
    });
    el.tabData.addEventListener('click', function () {
      if (global.location.hash === '#data') { showData(); return; }
      global.location.hash = 'data';
    });

    el.cardRating.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-rating]') : null;
      if (button) onRate(button.getAttribute('data-rating'));
    });

    el.reviewMode.addEventListener('change', function () { refreshReviewStatus(); });
    el.reviewLesson.addEventListener('change', function () { refreshReviewStatus(); });
    el.reviewLevel.addEventListener('change', function () { refreshReviewStatus(); });
    el.reviewType.addEventListener('change', function () { refreshReviewStatus(); });
    el.reviewSize.addEventListener('change', function () { refreshReviewStatus(); });

    el.btnStartReview.addEventListener('click', function () {
      var built = buildReviewQueue();
      if (built.paths.length === 0) {
        refreshReviewStatus('Некуда начинать: под фильтры не подошла ни одна карточка.');
        return;
      }
      startSession(built.paths, built.mode);
      global.scrollTo(0, 0);
    });

    el.btnResumeReview.addEventListener('click', resumeSession);

    el.sessionRating.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-rating]') : null;
      if (button) onSessionRate(button.getAttribute('data-rating'));
    });
    el.btnSkip.addEventListener('click', skipSessionCard);
    el.btnExitSession.addEventListener('click', exitSession);

    el.btnExport.addEventListener('click', onExport);
    el.importFile.addEventListener('change', onImportFile);
    el.btnResetSrs.addEventListener('click', onResetSrs);

    global.addEventListener('hashchange', handleHash);

    // Открытые спойлеры пересчитываем при смене ширины/повороте экрана.
    global.addEventListener('resize', function () {
      var nodes = document.querySelectorAll('.spoiler.open .spoiler-content');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].parentNode.style.maxHeight = nodes[i].scrollHeight + 'px';
      }
    });

    document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      if (!el.viewSession.classList.contains('hidden')) {
        // Оценки прячутся, пока карточка грузится: иначе быстрые нажатия оценивали бы
        // карточку, которую пользователь ещё не видел.
        if (el.sessionRating.classList.contains('hidden')) return;
        var byKey = { '1': 'bad', '2': 'ok', '3': 'good' };
        if (byKey[event.key]) {
          event.preventDefault();
          onSessionRate(byKey[event.key]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          exitSession();
        }
        return;
      }

      if (el.viewCard.classList.contains('hidden')) return;
      if (event.key === 'ArrowLeft') { goRelative(-1); }
      if (event.key === 'ArrowRight') { goRelative(1); }
      if (event.key === 'Escape') { showList(); }
    });
  }

  function init() {
    cacheElements();
    el.repoLink.href = REPO_URL;
    buildRatingButtons(el.cardRatingButtons);
    buildRatingButtons(el.sessionRatingButtons);

    loadIndex().then(function (cards) {
      state.cards = cards;
      fillSelect(el.filterLesson, collectFilterValues(cards, 'lesson'), 'все уроки');
      fillSelect(el.filterLevel, collectFilterValues(cards, 'level'), 'все уровни');
      fillSelect(el.reviewLesson, collectFilterValues(cards, 'lesson'), 'все уроки');
      fillSelect(el.reviewLevel, collectFilterValues(cards, 'level'), 'все уровни');
      fillTypeSelect(el.reviewType, cards);
      bindEvents();
      renderList();
      handleHash();
    }).catch(function (error) {
      setText(el.listError, 'Не удалось загрузить список карточек: ' +
        (error && error.message ? error.message : error) +
        '. Проверьте, что сайт открыт по http (не file://) и что cards/index.json доступен.');
      show(el.listError, true);
      setText(el.listStatus, '');
      bindEvents();
      showOnly(el.viewList);
      setActiveTab('list');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
