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
  var LIST_PAGE_SIZE = 20;
  // Метка «локальный прогресс уже перенесён»: не предлагать перенос при каждом входе.
  var MIGRATION_KEY = 'cl:v1:migrated';

  // Секции формы создания карточки: заголовки фиксированы форматом (CARD_FORMAT.md).
  var CREATE_FIELDS = {
    hieroglyph: [
      { title: 'Иероглиф', key: 'createHieroglyph' },
      { title: 'Пиньинь', key: 'createPinyin' },
      { title: 'Перевод', key: 'createTranslation' },
      { title: 'Пример', key: 'createExample' }
    ],
    rule: [
      { title: 'Правило', key: 'createRule' },
      { title: 'Примеры', key: 'createRuleExamples' }
    ]
  };

  var state = {
    cards: [],        // элементы index.json
    current: null,    // текущая карточка-элемент индекса
    filters: { lesson: '', level: '', search: '' },
    listPage: 1,      // страница списка карточек
    session: null,    // {mode, paths, i, done, requeued, currentPath}
    cardLoad: 0,      // номер последнего запроса карточки: старые ответы отбрасываем
    sessionLoad: 0,   // то же для карточки в сессии повторения
    server: false,    // серверный режим (true) или fallback на localStorage
    user: null,       // {id, login, name, role} в серверном режиме
    ratingPending: false,
    statsLoad: 0,
    migrationOffered: false,
    sessionCommentsOpen: false
  };

  var el = {};

  // Контроллеры комментариев создаются один раз после загрузки элементов.
  var cardComments = null;
  var sessionComments = null;
  var eventsBound = false;

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
    return global.CardLabel.typeLabel(type);
  }

  function lessonLabel(lesson) {
    return (lesson === null || lesson === undefined || lesson === '') ? 'урок —' : 'урок ' + lesson;
  }

  function setText(node, text) {
    node.textContent = text;
  }

  function show(node, visible) {
    if (!node) return;
    node.classList.toggle('hidden', !visible);
  }

  function errorText(error) {
    if (!error) return 'неизвестная ошибка';
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
  }

  function isAuthError(error) {
    return !!(error && Number(error.status) === 401);
  }

  // Любая серверная операция с истёкшей сессией возвращает человека на вход.
  function apiGuard(promise) {
    return promise.catch(function (error) {
      if (isAuthError(error) && state.server) handleAuthExpired();
      throw error;
    });
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
    return fetch(INDEX_URL, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        var indexError = new Error('HTTP ' + res.status + ' при загрузке ' + INDEX_URL);
        indexError.status = res.status;
        throw indexError;
      }
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.cards)) {
        throw new Error('Некорректный index.json: нет массива cards');
      }
      // Дубликаты путей не мешают рендеру — просто подстраховываемся.
      var seen = {};
      var cards = data.cards.filter(function (card) {
        var path = card && card.path;
        if (!path || seen[path]) return false;
        seen[path] = true;
        return true;
      });
      // Подпись («Иероглиф 7») считается по порядку в индексе, а не хранится в карточке.
      return global.CardLabel.numberCards(cards);
    });
  }

  function loadCardText(path) {
    return fetch(encodePath(path), { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        var cardError = new Error('HTTP ' + res.status + ' — файл не найден');
        cardError.status = res.status;
        throw cardError;
      }
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
    if (search && global.CardLabel.label(card).toLowerCase().indexOf(search) === -1) return false;
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
      setText(title, global.CardLabel.label(card));

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
    if (!path) return;

    var card = cardByPath(path);
    state.current = card || { path: path, type: '', lesson: null, level: '' };
    // Быстрые клики по разным карточкам: ответ на старый запрос не должен
    // перерисовать уже открытую карточку.
    var load = ++state.cardLoad;

    // Хеш обновляем сразу — ссылку можно копировать до загрузки файла.
    global.location.hash = 'card=' + encodePath(path);

    el.cardSections.innerHTML = '';
    show(el.cardError, false);
    show(el.cardPreamble, false);
    show(el.cardRating, false);
    if (el.ratingError) show(el.ratingError, false);
    setText(el.cardTitle, global.CardLabel.label(state.current));
    renderCardMeta(el.cardMeta, state.current, false);
    updateNavButtons();

    // Комментарии — только в серверном режиме и только для открытой карточки.
    show(el.cardComments, state.server);
    if (state.server) {
      ensureCommentControllers();
      if (cardComments) {
        cardComments.reset();
        cardComments.load(path);
      }
    } else if (cardComments) {
      cardComments.reset();
    }

    loadCardText(path).then(function (text) {
      if (load !== state.cardLoad || !state.current || state.current.path !== path) return;
      renderCardBody(el.cardPreamble, el.cardSections, window.MdParser.parseCard(text), state.current.type);
      renderRating(state.current.path);
      show(el.cardRating, true);
    }).catch(function (error) {
      if (load !== state.cardLoad) return;
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
    if (!global.Store.isAvailable()) {
      parts.push('Браузер не сохраняет данные: оценка не запишется.');
    }
    setText(el.ratingInfo, parts.join(' '));
  }

  // Оценка пишется и в историю, и в расписание повторений (fallback-режим).
  function applyRating(path, rating) {
    global.Store.addRating(path, rating);
    var next = global.Srs.review(global.Store.getSrsCard(path), rating, nowSec());
    global.Store.setSrsCard(path, next);
    return next;
  }

  function setRatingButtonsDisabled(container, disabled) {
    if (!container) return;
    var buttons = container.querySelectorAll('[data-rating]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !!disabled;
    container.setAttribute('aria-busy', disabled ? 'true' : 'false');
  }

  function setRatingPending(pending) {
    state.ratingPending = !!pending;
    setRatingButtonsDisabled(el.cardRatingButtons, pending);
    setRatingButtonsDisabled(el.sessionRatingButtons, pending);
  }

  function ratingErrorNode() {
    return el.viewSession.classList.contains('hidden') ? el.ratingError : el.sessionRatingError;
  }

  function showRatingError(message) {
    var node = ratingErrorNode();
    if (!node) return;
    setText(node, message || '');
    show(node, !!message);
  }

  // Серверная оценка: ждём ответ, обновляем кэш, только потом двигаем сессию.
  function rateOnServer(path, rating) {
    if (state.ratingPending) return Promise.resolve(false);
    setRatingPending(true);
    showRatingError('');

    return apiGuard(global.Api.review(path, rating)).then(function (data) {
      var responseRating = data && data.rating ? data.rating : {};
      global.Store.applyServerReview({
        path: path,
        ts: responseRating.ts,
        rating: responseRating.rating
      }, data && data.srs);
      return true;
    }).catch(function (error) {
      showRatingError('Оценка не сохранена: ' + errorText(error) + '. Попробуйте ещё раз.');
      return false;
    }).then(function (saved) {
      setRatingPending(false);
      return saved;
    });
  }

  function onRate(rating) {
    if (!state.current) return;
    if (!state.server) {
      applyRating(state.current.path, rating);
      renderRating(state.current.path);
      el.ratingInfo.classList.add('flash');
      global.setTimeout(function () { el.ratingInfo.classList.remove('flash'); }, 500);
      return;
    }

    var path = state.current.path;
    rateOnServer(path, rating).then(function (saved) {
      if (!saved || !state.current || state.current.path !== path) return;
      renderRating(path);
      el.ratingInfo.classList.add('flash');
      global.setTimeout(function () { el.ratingInfo.classList.remove('flash'); }, 500);
    });
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
    var raw = global.Store.getSession();
    if (!raw) return null;
    // sessionStorage мог остаться от старой версии или быть испорченным вручную.
    var saved = global.Srs.normalizeSession(raw);
    if (saved.paths.length === 0 || saved.i >= saved.paths.length) return null;
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
    state.sessionLoad += 1;
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
    var paths = prefix.concat(tail);

    if (saved.i >= paths.length) {
      global.Store.clearSession();
      updateResumeButton();
      refreshReviewStatus('Начатая сессия устарела: карточек из неё больше нет в индексе.');
      return;
    }

    state.sessionLoad += 1;
    state.session = {
      mode: saved.mode === 'manual' ? 'manual' : 'srs',
      paths: paths,
      i: saved.i,
      done: saved.done,
      requeued: saved.requeued,
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
    if (!path) {
      finishSession();
      return;
    }
    // Пока грузится одна карточка, пользователь может нажать «Пропустить»;
    // ответ на прошлый запрос не должен попасть в следующую карточку.
    var load = ++state.sessionLoad;

    var card = cardByPath(path) || { path: path, type: '', lesson: null, level: '' };
    session.currentPath = path;

    el.sessionSections.innerHTML = '';
    show(el.sessionError, false);
    show(el.sessionPreamble, false);
    show(el.sessionRating, false);
    if (el.sessionRatingError) show(el.sessionRatingError, false);
    resetSessionComments();
    setText(el.sessionTitle, global.CardLabel.label(card));
    renderCardMeta(el.sessionMeta, card, !global.Store.getSrsCard(path));
    updateSessionProgress();

    loadCardText(path).then(function (text) {
      if (load !== state.sessionLoad || state.session !== session) return;
      if (session.paths[session.i] !== path) return;
      renderCardBody(el.sessionPreamble, el.sessionSections, window.MdParser.parseCard(text), card.type);
      renderSessionInfo(path);
      show(el.sessionRating, true);
    }).catch(function (error) {
      if (load !== state.sessionLoad || state.session !== session) return;
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

    if (!state.server) {
      applyRating(session.currentPath, rating);
      advanceSession(global.Srs.stepSession(session, rating, global.Srs.MAX_REQUEUE));
      return;
    }

    // Сервер — источник правды: сессию двигаем только после успешного ответа.
    var path = session.currentPath;
    var current = session;
    rateOnServer(path, rating).then(function (saved) {
      if (!saved) return;
      if (state.session !== current || current.currentPath !== path) return;
      advanceSession(global.Srs.stepSession(current, rating, global.Srs.MAX_REQUEUE));
    });
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
    state.sessionLoad += 1;
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
    state.sessionLoad += 1;
    state.session = null;
    setActiveTab('review');
    showOnly(el.viewReview);
    refreshReviewStatus('Сессия отложена: пройдено ' + passed + ' ' + plural(passed, 'карточка', 'карточки', 'карточек') + '. Продолжить можно кнопкой ниже.');
  }

  // --- комментарии ---------------------------------------------------------

  function commentApiOptions(prefix, elements) {
    return {
      listEl: elements.list,
      statusEl: elements.status,
      errorEl: elements.error,
      formEl: elements.form,
      textEl: elements.text,
      filesEl: elements.files,
      previewEl: elements.preview,
      submitEl: elements.submit,
      getUser: function () { return state.user; },
      loadComments: function (path) { return apiGuard(global.Api.getComments(path)); },
      addComment: function (path, text, files) {
        return apiGuard(global.Api.addComment(path, text, files));
      },
      deleteComment: function (id) { return apiGuard(global.Api.deleteComment(id)); }
    };
  }

  function ensureCommentControllers() {
    if (!state.server || cardComments || !global.Comments) return;
    cardComments = global.Comments.createController(commentApiOptions('card', {
      list: el.cardCommentsList,
      status: el.cardCommentsStatus,
      error: el.cardCommentsError,
      form: el.cardCommentForm,
      text: el.cardCommentText,
      files: el.cardCommentFiles,
      preview: el.cardCommentsPreview,
      submit: el.cardCommentSubmit
    }));
    sessionComments = global.Comments.createController(commentApiOptions('session', {
      list: el.sessionCommentsList,
      status: el.sessionCommentsStatus,
      error: el.sessionCommentsError,
      form: el.sessionCommentForm,
      text: el.sessionCommentText,
      files: el.sessionCommentFiles,
      preview: el.sessionCommentsPreview,
      submit: el.sessionCommentSubmit,
      onCount: updateSessionCommentsButton
    }));
  }

  function updateSessionCommentsButton(count) {
    if (!el.btnSessionComments) return;
    var text = (typeof count === 'number' && count > 0) ? 'Комментарии (' + count + ')' : 'Комментарии';
    setText(el.btnSessionComments, text);
  }

  function resetSessionComments() {
    state.sessionCommentsOpen = false;
    show(el.sessionComments, false);
    show(el.btnSessionComments, state.server);
    if (el.btnSessionComments) el.btnSessionComments.setAttribute('aria-expanded', 'false');
    updateSessionCommentsButton(0);
    if (sessionComments) {
      sessionComments.reset();
    } else if (el.sessionCommentsList) {
      el.sessionCommentsList.textContent = '';
    }
  }

  function toggleSessionComments() {
    if (!state.server || !state.session || !state.session.currentPath) return;
    ensureCommentControllers();
    var open = el.sessionComments.classList.contains('hidden');
    state.sessionCommentsOpen = open;
    show(el.sessionComments, open);
    if (el.btnSessionComments) el.btnSessionComments.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && sessionComments) sessionComments.load(state.session.currentPath);
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
    var where = state.server ? 'Данные на сервере' : 'Данные в этом браузере';

    setText(el.dataSummary, where + ' · Имя: ' + (name || '—') + ' · оценок: ' + ratings +
      ' · карточек в расписании: ' + srsCount + ' · всего карточек в индексе: ' + state.cards.length);

    if (state.server && el.profileName) el.profileName.value = name;
    show(el.serverProfile, state.server);
    updateResumeButton();
  }

  function exportFileName() {
    var date = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'chinese-cards-' + date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '.json';
  }

  function downloadJson(data) {
    var text = JSON.stringify(data, null, 2);
    var blob = new global.Blob([text], { type: 'application/json' });
    var url = global.URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 1000);
  }

  function onExport() {
    if (!state.server) {
      downloadJson(global.Store.exportData());
      setText(el.exportResult, 'Файл ' + exportFileName() + ' выгружен.');
      show(el.exportResult, true);
      return;
    }

    setText(el.exportResult, 'Выгружаем данные с сервера…');
    show(el.exportResult, true);
    apiGuard(global.Api.exportData()).then(function (envelope) {
      downloadJson(envelope);
      setText(el.exportResult, 'Файл ' + exportFileName() + ' выгружен с сервера.');
      show(el.exportResult, true);
    }).catch(function (error) {
      setText(el.exportResult, 'Не удалось выгрузить данные: ' + errorText(error) + '.');
      show(el.exportResult, true);
    });
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

  function serverImportSummaryText(summary, mode) {
    var parts = [mode === 'replace' ? 'Данные заменены на сервере.' : 'Данные объединены с серверными.'];
    var data = summary && typeof summary === 'object' ? summary : {};
    var labels = {
      ratingsAdded: 'добавлено оценок',
      ratingsTotal: 'всего оценок',
      srsUpdated: 'обновлено расписаний',
      srsTotal: 'всего расписаний',
      skipped: 'пропущено битых записей'
    };
    Object.keys(labels).forEach(function (key) {
      if (typeof data[key] === 'number') parts.push(labels[key] + ': ' + data[key] + '.');
    });
    if (typeof data.orphanPaths === 'number' && data.orphanPaths > 0) {
      parts.push('Записей вне текущего индекса: ' + data.orphanPaths + ' — они сохранены.');
    }
    (Array.isArray(data.warnings) ? data.warnings : []).forEach(function (line) {
      parts.push(line + '.');
    });
    if (typeof data.nameNote === 'string' && data.nameNote) parts.push('Имя: ' + data.nameNote + '.');
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

      if (state.server) {
        importServerData(raw, mode);
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

  function importServerData(raw, mode) {
    show(el.importError, false);
    setText(el.importResult, 'Загружаем данные на сервер…');
    show(el.importResult, true);

    apiGuard(global.Api.importData(mode, raw)).then(function (response) {
      return apiGuard(global.Api.getProgress()).then(function (data) {
        global.Store.replaceServerData(data);
        return response;
      });
    }).then(function (response) {
      setText(el.importResult, serverImportSummaryText(response && response.summary, mode));
      show(el.importResult, true);
      renderDataSummary();
    }).catch(function (error) {
      show(el.importResult, false);
      setText(el.importError, 'Импорт не выполнен: ' + errorText(error) + '.');
      show(el.importError, true);
    });
  }

  function onResetSrs() {
    if (!global.confirm('Сбросить интервалы повторений? История оценок останется.')) return;

    if (state.server) {
      apiGuard(global.Api.resetSrs()).then(function () {
        return apiGuard(global.Api.getProgress());
      }).then(function (data) {
        global.Store.replaceServerData(data);
        setText(el.resetResult, 'Расписание на сервере сброшено: все карточки снова считаются новыми.');
        show(el.resetResult, true);
        renderDataSummary();
      }).catch(function (error) {
        setText(el.resetResult, 'Не удалось сбросить расписание: ' + errorText(error) + '.');
        show(el.resetResult, true);
      });
      return;
    }

    if (!global.Store.resetSrs()) {
      setText(el.resetResult, 'Не удалось сбросить расписание: браузер не даёт сохранять данные.');
      show(el.resetResult, true);
      return;
    }
    setText(el.resetResult, 'Расписание сброшено: все карточки снова считаются новыми.');
    show(el.resetResult, true);
    renderDataSummary();
  }

  // --- профиль на сервере --------------------------------------------------

  function onSaveName() {
    if (!state.server) return;
    var name = el.profileName.value.replace(/^\s+|\s+$/g, '');
    if (!name) {
      setText(el.profileNameResult, 'Имя не может быть пустым.');
      show(el.profileNameResult, true);
      return;
    }

    el.btnSaveName.disabled = true;
    setText(el.profileNameResult, 'Сохраняем имя…');
    show(el.profileNameResult, true);

    apiGuard(global.Api.updateName(name)).then(function (data) {
      var user = data && data.user;
      state.user = user || state.user;
      if (!state.user) state.user = { name: name };
      global.Store.setUserName(state.user.name || name);
      setText(el.userBadgeName, state.user.name || name);
      setText(el.profileNameResult, 'Имя сохранено: ' + (state.user.name || name) + '.');
      show(el.profileNameResult, true);
      renderDataSummary();
    }).catch(function (error) {
      setText(el.profileNameResult, 'Не удалось сохранить имя: ' + errorText(error) + '.');
      show(el.profileNameResult, true);
    }).then(function () {
      el.btnSaveName.disabled = false;
    });
  }

  function onChangePassword() {
    if (!state.server) return;
    var current = el.profileCurrent.value;
    var next = el.profileNext.value;
    show(el.profileError, false);
    show(el.profilePasswordResult, false);

    if (!current || !next) {
      setText(el.profileError, 'Введите текущий и новый пароль.');
      show(el.profileError, true);
      return;
    }

    el.btnChangePassword.disabled = true;
    apiGuard(global.Api.changePassword(current, next)).then(function () {
      el.profileCurrent.value = '';
      el.profileNext.value = '';
      setText(el.profilePasswordResult, 'Пароль изменён. Остальные сессии завершены.');
      show(el.profilePasswordResult, true);
    }).catch(function (error) {
      setText(el.profileError, 'Не удалось сменить пароль: ' + errorText(error) + '.');
      show(el.profileError, true);
    }).then(function () {
      el.btnChangePassword.disabled = false;
    });
  }

  // --- навигация между экранами и hash-роутинг -----------------------------

  function showOnly(view) {
    [el.viewBoot, el.viewLogin, el.viewList, el.viewCard, el.viewReview,
      el.viewSession, el.viewData, el.viewAdd, el.viewStats].forEach(function (node) {
      show(node, node === view);
    });
  }

  function setActiveTab(name) {
    el.tabList.classList.toggle('is-active', name === 'list');
    el.tabReview.classList.toggle('is-active', name === 'review');
    el.tabData.classList.toggle('is-active', name === 'data');
    el.tabAdd.classList.toggle('is-active', name === 'add');
    el.tabStats.classList.toggle('is-active', name === 'stats');
  }

  function showList() {
    state.cardLoad += 1;
    state.current = null;
    if (state.server && !state.user) { showLogin(''); return; }
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
    // Переход по вкладке во время сессии не должен терять её позицию:
    // сохраняем, чтобы «Продолжить начатую» осталась доступной.
    if (state.session) saveSession();
    state.sessionLoad += 1;
    state.session = null;
    showOnly(el.viewReview);
    setActiveTab('review');
    refreshReviewStatus(note);
  }

  function showData() {
    if (state.session) saveSession();
    state.sessionLoad += 1;
    state.session = null;
    showOnly(el.viewData);
    setActiveTab('data');
    show(el.importResult, false);
    show(el.importError, false);
    show(el.exportResult, false);
    show(el.resetResult, false);
    show(el.profileNameResult, false);
    show(el.profilePasswordResult, false);
    show(el.profileError, false);
    renderDataSummary();
  }

  function showAdd() {
    if (!state.server) { showList(); return; }
    if (state.session) saveSession();
    state.sessionLoad += 1;
    state.session = null;
    showOnly(el.viewAdd);
    setActiveTab('add');
    show(el.createResult, false);
    show(el.createError, false);
  }

  function showStats() {
    if (!state.server) { showList(); return; }
    if (state.session) saveSession();
    state.sessionLoad += 1;
    state.session = null;
    showOnly(el.viewStats);
    setActiveTab('stats');
    loadStats();
  }

  function handleHash() {
    if (state.server && !state.user) { showLogin(''); return; }
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
    if (hash === '#add') { showAdd(); return; }
    if (hash === '#stats') { showStats(); return; }
    showList();
  }

  // --- статистика ----------------------------------------------------------

  function setStatValue(id, value) {
    var node = el[id];
    if (!node) return;
    var number = Number(value);
    setText(node, isFinite(number) ? String(number) : '—');
  }

  function renderChart(last30) {
    var chart = global.Api ? global.Api.statsChartData(last30) : { max: 0, bars: [] };
    el.statsChart.textContent = '';
    chart.bars.forEach(function (bar) {
      var column = document.createElement('div');
      column.className = 'chart-bar' + (bar.total === 0 ? ' is-zero' : '');
      var height = bar.total > 0 ? Math.max(2, bar.percent) : 1;
      column.style.height = height + '%';
      column.title = (bar.date || '') + ': ' + bar.total + ' (не помню ' + bar.bad +
        ', слабо ' + bar.ok + ', хорошо ' + bar.good + ')';
      el.statsChart.appendChild(column);
    });

    var caption = '';
    if (chart.bars.length > 0) {
      var first = chart.bars[0].date;
      var last = chart.bars[chart.bars.length - 1].date;
      caption = 'С ' + (first || '—') + ' по ' + (last || '—') + '. Максимум за день: ' + chart.max + '.';
    } else {
      caption = 'Данных за последние 30 дней нет.';
    }
    setText(el.statsChartCaption, caption);
  }

  function renderRatingDistribution(byValue) {
    var data = byValue && typeof byValue === 'object' ? byValue : {};
    var labels = { bad: 'Не помню', ok: 'Слабо помню', good: 'Хорошо помню' };
    var max = 0;
    RATING_ORDER.forEach(function (rating) {
      var value = Number(data[rating]) || 0;
      if (value > max) max = value;
    });

    el.statsRatings.textContent = '';
    RATING_ORDER.forEach(function (rating) {
      var value = Number(data[rating]) || 0;
      var row = document.createElement('div');
      row.className = 'dist-row';

      var label = document.createElement('span');
      setText(label, labels[rating]);

      var track = document.createElement('span');
      track.className = 'dist-track';
      var fill = document.createElement('span');
      fill.className = 'dist-fill ' + rating;
      fill.style.width = (max > 0 ? Math.round((value / max) * 100) : 0) + '%';
      track.appendChild(fill);

      var count = document.createElement('span');
      count.className = 'dist-count';
      setText(count, String(value));

      row.appendChild(label);
      row.appendChild(track);
      row.appendChild(count);
      el.statsRatings.appendChild(row);
    });
  }

  function renderLeaderboard(data) {
    var entries = data && Array.isArray(data.entries) ? data.entries : [];
    el.statsLeaderboardBody.textContent = '';

    if (entries.length === 0) {
      setText(el.statsLeaderboardStatus, 'В рейтинге пока никого нет.');
      return;
    }
    setText(el.statsLeaderboardStatus, 'Всего участников: ' + entries.length + '.');

    entries.forEach(function (entry, index) {
      var item = entry && typeof entry === 'object' ? entry : {};
      var row = document.createElement('tr');
      if (state.user && item.userId && item.userId === state.user.id) row.className = 'is-me';

      var rank = document.createElement('td');
      rank.className = 'rank';
      setText(rank, String(index + 1));
      row.appendChild(rank);

      var name = document.createElement('td');
      setText(name, item.name || '—');
      row.appendChild(name);

      var cells = [item.ratings, item.cards, item.good, item.streakDays];
      cells.forEach(function (value) {
        var cell = document.createElement('td');
        cell.className = 'num';
        var number = Number(value);
        setText(cell, isFinite(number) ? String(number) : '—');
        row.appendChild(cell);
      });

      el.statsLeaderboardBody.appendChild(row);
    });
  }

  function renderStats(stats, leaderboard) {
    var data = stats && typeof stats === 'object' ? stats : {};
    setStatValue('statsTotalRatings', data.totalRatings);
    setStatValue('statsCardsTouched', data.cardsTouched);
    setStatValue('statsCardsSchedule', data.cardsInSchedule);
    setStatValue('statsDueNow', data.dueNow);
    setStatValue('statsNewCards', data.newCards);
    setStatValue('statsLater', data.later);
    setStatValue('statsStreak', data.streakDays);

    renderChart(data.last30);
    renderRatingDistribution(data.ratingsByValue);
    renderLeaderboard(leaderboard);
  }

  function loadStats() {
    if (!state.server) return;
    var token = ++state.statsLoad;
    setText(el.statsStatus, 'Загружаем статистику…');
    show(el.statsError, false);

    Promise.all([
      global.Api.getStats(),
      global.Api.getLeaderboard()
    ]).then(function (results) {
      if (token !== state.statsLoad) return;
      setText(el.statsStatus, '');
      renderStats(results[0], results[1]);
    }).catch(function (error) {
      if (token !== state.statsLoad) return;
      if (isAuthError(error) && state.server) { handleAuthExpired(); return; }
      setText(el.statsStatus, '');
      setText(el.statsError, 'Не удалось загрузить статистику: ' + errorText(error) + '.');
      show(el.statsError, true);
    });
  }

  // --- создание карточки ---------------------------------------------------

  function currentCreateSections() {
    var type = el.createType.value === 'rule' ? 'rule' : 'hieroglyph';
    var fields = CREATE_FIELDS[type];
    return {
      type: type,
      lesson: el.createLesson.value,
      level: el.createLevel.value,
      sections: fields.map(function (field) {
        var node = el[field.key];
        return { title: field.title, content: node ? node.value : '' };
      })
    };
  }

  function updateCreateFields() {
    var type = el.createType.value === 'rule' ? 'rule' : 'hieroglyph';
    show(el.createFieldsHieroglyph, type === 'hieroglyph');
    show(el.createFieldsRule, type === 'rule');
  }

  function clearCreateContent() {
    Object.keys(CREATE_FIELDS).forEach(function (type) {
      CREATE_FIELDS[type].forEach(function (field) {
        if (el[field.key]) el[field.key].value = '';
      });
    });
  }

  function refreshCardSelects() {
    var values = {
      filterLesson: el.filterLesson.value,
      filterLevel: el.filterLevel.value,
      reviewLesson: el.reviewLesson.value,
      reviewLevel: el.reviewLevel.value,
      reviewType: el.reviewType.value
    };
    fillSelect(el.filterLesson, collectFilterValues(state.cards, 'lesson'), 'все уроки');
    fillSelect(el.filterLevel, collectFilterValues(state.cards, 'level'), 'все уровни');
    fillSelect(el.reviewLesson, collectFilterValues(state.cards, 'lesson'), 'все уроки');
    fillSelect(el.reviewLevel, collectFilterValues(state.cards, 'level'), 'все уровни');
    fillTypeSelect(el.reviewType, state.cards);

    if (arrayHasValue(collectFilterValues(state.cards, 'lesson'), values.filterLesson)) el.filterLesson.value = values.filterLesson;
    if (arrayHasValue(collectFilterValues(state.cards, 'level'), values.filterLevel)) el.filterLevel.value = values.filterLevel;
    if (arrayHasValue(collectFilterValues(state.cards, 'lesson'), values.reviewLesson)) el.reviewLesson.value = values.reviewLesson;
    if (arrayHasValue(collectFilterValues(state.cards, 'level'), values.reviewLevel)) el.reviewLevel.value = values.reviewLevel;
    if (arrayHasValue(collectFilterValues(state.cards, 'type'), values.reviewType)) el.reviewType.value = values.reviewType;

    state.filters.lesson = el.filterLesson.value;
    state.filters.level = el.filterLevel.value;
  }

  function arrayHasValue(values, value) {
    for (var i = 0; i < values.length; i++) if (String(values[i]) === String(value)) return true;
    return false;
  }

  function onCreateCard() {
    if (!state.server) return;
    show(el.createError, false);
    show(el.createResult, false);

    var check = global.Api.validateCardDraft(currentCreateSections());
    if (!check.ok) {
      setText(el.createError, check.error);
      show(el.createError, true);
      return;
    }

    el.btnCreateCard.disabled = true;
    setText(el.createResult, 'Создаём карточку…');
    show(el.createResult, true);

    apiGuard(global.Api.createCard(check.payload)).then(function (response) {
      var path = response && response.path ? response.path : '';
      var text = 'Карточка создана: ' + (path || '(путь не вернулся)') + '.';
      if (response && response.commit) text += ' Коммит: ' + response.commit + '.';
      setText(el.createResult, text);
      show(el.createResult, true);
      clearCreateContent();

      return loadIndex().then(function (cards) {
        state.cards = cards;
        refreshCardSelects();
        renderList();
      });
    }).catch(function (error) {
      show(el.createResult, false);
      setText(el.createError, 'Не удалось создать карточку: ' + errorText(error) + '.');
      show(el.createError, true);
    }).then(function () {
      el.btnCreateCard.disabled = false;
    });
  }

  // --- вход, выход и перенос локальных данных ------------------------------

  function setChromeLogin() {
    show(el.tabs, false);
    show(el.userBox, false);
    show(el.userBadge, false);
    show(el.serverProfile, false);
    show(el.cardComments, false);
    show(el.sessionComments, false);
  }

  function setChromeServer() {
    show(el.tabs, true);
    show(el.userBox, false);
    show(el.userBadge, true);
    show(el.tabAdd, true);
    show(el.tabStats, true);
    show(el.serverProfile, true);
    setText(el.userBadgeName, state.user ? (state.user.name || state.user.login || 'пользователь') : '');
    if (el.profileName && state.user) el.profileName.value = state.user.name || '';
  }

  function setChromeFallback() {
    show(el.tabs, true);
    show(el.userBox, true);
    show(el.userBadge, false);
    show(el.tabAdd, false);
    show(el.tabStats, false);
    show(el.serverProfile, false);
    show(el.cardComments, false);
    show(el.sessionComments, false);
  }

  function showBoot(message) {
    setText(el.bootStatus, message || 'Загружаем…');
    show(el.bootError, false);
    setChromeLogin();
    showOnly(el.viewBoot);
  }

  function showBootError(message) {
    setText(el.bootError, message);
    show(el.bootError, true);
  }

  function showLogin(message) {
    setChromeLogin();
    show(el.loginError, !!message);
    setText(el.loginError, message || '');
    el.btnLogin.disabled = false;
    setText(el.btnLogin, 'Войти');
    showOnly(el.viewLogin);
    if (el.loginName && !el.loginName.value) {
      try { el.loginName.focus(); } catch (e) { /* фокус не критичен */ }
    }
  }

  function onLogin(event) {
    if (event) event.preventDefault();
    if (!state.server) return;

    var loginName = el.loginName.value.replace(/^\s+|\s+$/g, '');
    var password = el.loginPassword.value;
    if (!loginName) {
      setText(el.loginError, 'Введите логин.');
      show(el.loginError, true);
      return;
    }

    el.btnLogin.disabled = true;
    setText(el.btnLogin, 'Входим…');
    show(el.loginError, false);

    global.Api.login(loginName, password).then(function (data) {
      var user = data && data.user;
      if (!user) throw new Error('сервер не вернул пользователя');
      el.loginPassword.value = '';
      return startServerSession(user);
    }).then(function () {
      el.btnLogin.disabled = false;
      setText(el.btnLogin, 'Войти');
    }).catch(function (error) {
      el.btnLogin.disabled = false;
      setText(el.btnLogin, 'Войти');
      setText(el.loginError, 'Не удалось войти: ' + errorText(error) + '.');
      show(el.loginError, true);
    });
  }

  function handleAuthExpired() {
    if (!state.server) return;
    global.Store.detach();
    state.user = null;
    state.ratingPending = false;
    state.cards = [];
    state.current = null;
    state.session = null;
    global.Store.clearSession();
    state.migrationOffered = false;
    setRatingPending(false);
    setChromeLogin();
    showLogin('Сессия истекла. Войдите снова.');
  }

  function onLogout() {
    if (!state.server) return;
    var finish = function () {
      global.Store.detach();
      state.user = null;
      state.cards = [];
      state.current = null;
      state.session = null;
      state.migrationOffered = false;
      global.Store.clearSession();
      if (global.location.hash) {
        global.history.replaceState(null, '', global.location.pathname + global.location.search);
      }
      setChromeLogin();
      showLogin('Вы вышли. Войдите снова, чтобы продолжить.');
    };
    global.Api.logout().then(finish).catch(finish);
  }

  function migrationAlreadyDone() {
    try {
      return global.localStorage.getItem(MIGRATION_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function markMigrationDone() {
    try {
      global.localStorage.setItem(MIGRATION_KEY, '1');
    } catch (e) {
      // Приватный режим: просто предложим перенос в следующий раз.
    }
  }

  function migrateLocalData() {
    if (!state.server) return;
    var snapshot = global.Store.localSnapshot();
    var ratings = countSnapshotRatings(snapshot);
    var srs = Object.keys(snapshot.srs || {}).length;
    if (ratings === 0 && srs === 0) {
      show(el.migrationBanner, false);
      return;
    }

    el.btnMigrateLocal.disabled = true;
    show(el.migrationResult, true);
    setText(el.migrationResult, 'Переносим локальные данные на сервер…');

    apiGuard(global.Api.importData('merge', snapshot)).then(function () {
      return apiGuard(global.Api.getProgress());
    }).then(function (data) {
      global.Store.replaceServerData(data);
      markMigrationDone();
      el.btnMigrateLocal.disabled = false;
      show(el.btnMigrateLocal, false);
      show(el.btnDismissMigration, false);
      setText(el.migrationResult, 'Локальные данные перенесены: оценок ' + ratings + ', расписаний ' + srs + '.');
      show(el.migrationResult, true);
      renderList();
      renderDataSummary();
    }).catch(function (error) {
      el.btnMigrateLocal.disabled = false;
      setText(el.migrationResult, 'Перенос не выполнен: ' + errorText(error) + '.');
      show(el.migrationResult, true);
    });
  }

  function countSnapshotRatings(snapshot) {
    var progress = snapshot && snapshot.progress ? snapshot.progress : {};
    var total = 0;
    for (var path in progress) {
      if (Object.prototype.hasOwnProperty.call(progress, path) && Array.isArray(progress[path])) {
        total += progress[path].length;
      }
    }
    return total;
  }

  function offerLocalMigration() {
    if (!state.server || state.migrationOffered) return;
    state.migrationOffered = true;
    if (migrationAlreadyDone()) {
      show(el.migrationBanner, false);
      return;
    }
    var snapshot = global.Store.localSnapshot();
    var ratings = countSnapshotRatings(snapshot);
    var srs = Object.keys(snapshot.srs || {}).length;
    if (ratings === 0 && srs === 0) {
      show(el.migrationBanner, false);
      return;
    }
    setText(el.migrationText, 'В этом браузере остался локальный прогресс: оценок ' + ratings +
      ', карточек в расписании ' + srs + '. Перенести его на сервер? Слияние безопасное: ничего не потеряется.');
    show(el.migrationResult, false);
    show(el.btnMigrateLocal, true);
    show(el.btnDismissMigration, true);
    el.btnMigrateLocal.disabled = false;
    show(el.migrationBanner, true);
  }

  // --- загрузка режима -----------------------------------------------------

  function startServerSession(user) {
    state.server = true;
    state.user = user || null;
    showBoot('Загружаем прогресс…');

    return apiGuard(global.Api.getProgress()).then(function (data) {
      global.Store.attachServer(state.user, data || {});
      return loadIndex();
    }).then(function (cards) {
      state.cards = cards;
      refreshCardSelects();
      ensureCommentControllers();
      setChromeServer();
      if (el.userName) el.userName.value = global.Store.getUserName();
      showOnly(el.viewList);
      bindEvents();
      renderList();
      handleHash();
      offerLocalMigration();
      return true;
    }).catch(function (error) {
      if (isAuthError(error)) {
        handleAuthExpired();
        return false;
      }
      setChromeLogin();
      showOnly(el.viewBoot);
      showBootError('Не удалось загрузить серверные данные: ' + errorText(error) + '. Проверьте, что сервер запущен, и обновите страницу.');
      return false;
    });
  }

  function bootServer() {
    state.server = true;
    showBoot('Проверяем вход…');
    global.Api.me().then(function (data) {
      var user = data && data.user;
      if (!user) throw new Error('сервер не вернул пользователя');
      return startServerSession(user);
    }).catch(function (error) {
      if (isAuthError(error)) { showLogin(''); return; }
      showBoot('Не удалось проверить вход.');
      showBootError('Сервер отвечает, но не удалось получить пользователя: ' + errorText(error) + '. Обновите страницу или войдите заново.');
    });
  }

  function bootFallback() {
    state.server = false;
    state.user = null;
    global.Store.detach();
    setChromeFallback();
    showBoot('Загружаем карточки…');

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
      showOnly(el.viewList);
      setChromeFallback();
      setActiveTab('list');
      setText(el.listError, 'Не удалось загрузить список карточек: ' +
        (error && error.message ? error.message : error) +
        '. Проверьте, что сайт открыт по http (не file://) и что cards/index.json доступен.');
      show(el.listError, true);
      setText(el.listStatus, '');
      bindEvents();
    });
  }

  // --- инициализация -------------------------------------------------------

  function cacheElements() {
    var ids = ['view-boot', 'view-login', 'view-list', 'view-card', 'view-review',
      'view-session', 'view-data', 'view-add', 'view-stats',
      'tabs', 'tab-list', 'tab-review', 'tab-data', 'tab-add', 'tab-stats',
      'boot-status', 'boot-error',
      'login-form', 'login-name', 'login-password', 'login-error', 'btn-login',
      'user-box', 'user-name', 'user-badge', 'user-badge-name', 'btn-logout',
      'migration-banner', 'migration-text', 'migration-result',
      'btn-migrate-local', 'btn-dismiss-migration',
      'card-list', 'list-status', 'list-error',
      'list-pager', 'list-page-info', 'btn-list-prev', 'btn-list-next',
      'filter-lesson', 'filter-level', 'filter-search', 'filter-reset',
      'card-title', 'card-meta', 'card-sections', 'card-preamble', 'card-error',
      'card-rating', 'card-rating-buttons', 'rating-error', 'rating-info',
      'btn-back', 'btn-prev', 'btn-next',
      'card-comments', 'card-comments-list', 'card-comments-status', 'card-comments-error',
      'card-comment-form', 'card-comment-text', 'card-comment-files',
      'card-comments-preview', 'card-comment-submit', 'card-comment-error',
      'review-mode', 'review-lesson', 'review-level', 'review-type', 'review-size',
      'review-status', 'review-error', 'btn-start-review', 'btn-resume-review',
      'session-progress-text', 'session-progress-fill', 'session-title', 'session-meta',
      'session-preamble', 'session-sections', 'session-error', 'session-rating',
      'session-rating-buttons', 'session-rating-error', 'session-rating-info',
      'btn-session-comments', 'btn-skip', 'btn-exit-session',
      'session-comments', 'session-comments-list', 'session-comments-status',
      'session-comments-error', 'session-comment-form', 'session-comment-text',
      'session-comment-files', 'session-comments-preview', 'session-comment-submit',
      'session-comment-error',
      'data-summary', 'data-unavailable', 'btn-export', 'export-result', 'import-mode',
      'import-file', 'import-result', 'import-error', 'btn-reset-srs', 'reset-result',
      'server-profile', 'profile-name', 'btn-save-name', 'profile-name-result',
      'profile-current', 'profile-next', 'btn-change-password',
      'profile-password-result', 'profile-error',
      'create-type', 'create-lesson', 'create-level',
      'create-fields-hieroglyph', 'create-fields-rule',
      'create-hieroglyph', 'create-pinyin', 'create-translation', 'create-example',
      'create-rule', 'create-rule-examples', 'btn-create-card',
      'create-result', 'create-error',
      'stats-status', 'stats-error', 'stats-total-ratings', 'stats-cards-touched',
      'stats-cards-schedule', 'stats-due-now', 'stats-new-cards', 'stats-later',
      'stats-streak', 'stats-chart', 'stats-chart-caption', 'stats-ratings',
      'stats-leaderboard-body', 'stats-leaderboard-status',
      'repo-link'];
    ids.forEach(function (id) {
      el[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;

    el.userName.value = global.Store.getUserName();
    el.userName.addEventListener('input', function () {
      global.Store.setUserName(el.userName.value);
    });

    el.btnLogout.addEventListener('click', onLogout);
    el.loginForm.addEventListener('submit', onLogin);

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
    el.tabAdd.addEventListener('click', function () {
      if (!state.server) return;
      if (global.location.hash === '#add') { showAdd(); return; }
      global.location.hash = 'add';
    });
    el.tabStats.addEventListener('click', function () {
      if (!state.server) return;
      if (global.location.hash === '#stats') { showStats(); return; }
      global.location.hash = 'stats';
    });

    el.btnMigrateLocal.addEventListener('click', migrateLocalData);
    el.btnDismissMigration.addEventListener('click', function () {
      show(el.migrationBanner, false);
    });

    el.btnSessionComments.addEventListener('click', toggleSessionComments);

    el.btnSaveName.addEventListener('click', onSaveName);
    el.btnChangePassword.addEventListener('click', onChangePassword);
    el.createType.addEventListener('change', updateCreateFields);
    el.btnCreateCard.addEventListener('click', onCreateCard);

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
        // Выйти можно и пока карточка грузится — иначе Escape «залипает».
        if (event.key === 'Escape') {
          event.preventDefault();
          exitSession();
          return;
        }
        // Оценки прячутся, пока карточка грузится: иначе быстрые нажатия оценивали бы
        // карточку, которую пользователь ещё не видел.
        if (el.sessionRating.classList.contains('hidden')) return;
        if (state.ratingPending) return;
        var byKey = { '1': 'bad', '2': 'ok', '3': 'good' };
        if (byKey[event.key]) {
          event.preventDefault();
          onSessionRate(byKey[event.key]);
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
    updateCreateFields();
    bindEvents();
    showBoot('Проверяем сервер…');

    var detection;
    if (global.Api && typeof global.Api.detect === 'function') {
      detection = global.Api.detect();
    } else {
      detection = Promise.resolve(false);
    }

    detection.then(function (isServerMode) {
      if (isServerMode) bootServer();
      else bootFallback();
    }).catch(function () {
      bootFallback();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
