// Viewer карточек: список + карточка со спойлерами. Чистый JS, без библиотек.
(function (global) {
  'use strict';

  var REPO_URL = 'https://github.com/Covch/chinese-study-notes';

  var INDEX_URL = 'cards/index.json';
  var RATING_LABELS = { bad: 'Не помню', ok: 'Помню нормально', good: 'Помню хорошо' };
  var TYPE_LABELS = { hieroglyph: 'иероглиф', rule: 'правило' };

  var state = {
    cards: [],        // элементы index.json
    current: null,    // текущая карточка-элемент индекса
    filters: { lesson: '', level: '', search: '' }
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

  // --- список --------------------------------------------------------------

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

  function filteredCards() {
    var search = state.filters.search.trim().toLowerCase();
    return state.cards.filter(function (card) {
      if (state.filters.lesson !== '' && String(card.lesson) !== state.filters.lesson) return false;
      if (state.filters.level !== '' && String(card.level) !== state.filters.level) return false;
      if (search && String(card.title || '').toLowerCase().indexOf(search) === -1) return false;
      return true;
    });
  }

  function renderList() {
    var cards = filteredCards();
    el.cardList.innerHTML = '';

    if (cards.length === 0) {
      setText(el.listStatus, state.cards.length === 0 ? 'Карточек пока нет.' : 'Ничего не найдено по фильтрам.');
      return;
    }
    setText(el.listStatus, 'Показано: ' + cards.length + ' из ' + state.cards.length);

    cards.forEach(function (card) {
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
  }

  function badge(text) {
    var span = document.createElement('span');
    span.className = 'badge';
    setText(span, text);
    return span;
  }

  // --- карточка ------------------------------------------------------------

  function openCard(path) {
    var card = null;
    for (var i = 0; i < state.cards.length; i++) {
      if (state.cards[i].path === path) { card = state.cards[i]; break; }
    }

    state.current = card || { path: path, title: path, type: '', lesson: null, level: '' };

    // Хеш обновляем сразу — ссылку можно копировать до загрузки файла.
    global.location.hash = 'card=' + encodePath(path);

    el.cardSections.innerHTML = '';
    show(el.cardError, false);
    show(el.cardPreamble, false);
    show(el.cardRating, false);
    setText(el.cardTitle, state.current.title || path);
    renderCardMeta(state.current);
    updateNavButtons();

    loadCardText(path).then(function (text) {
      renderCardBody(window.MdParser.parseCard(text), state.current.type);
      renderRating(state.current.path);
      show(el.cardRating, true);
    }).catch(function (error) {
      setText(el.cardError, 'Не удалось открыть карточку: ' + (error && error.message ? error.message : error));
      show(el.cardError, true);
    });
  }

  function renderCardMeta(card) {
    el.cardMeta.innerHTML = '';
    el.cardMeta.appendChild(badge(typeLabel(card.type)));
    el.cardMeta.appendChild(badge(lessonLabel(card.lesson)));
    if (card.level) el.cardMeta.appendChild(badge(card.level));
  }

  function renderCardBody(parsed, type) {
    if (parsed.preamble) {
      setText(el.cardPreamble, parsed.preamble);
      show(el.cardPreamble, true);
    } else {
      show(el.cardPreamble, false);
    }

    el.cardSections.innerHTML = '';

    if (parsed.sections.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'status';
      setText(empty, 'В карточке нет секций.');
      el.cardSections.appendChild(empty);
      return;
    }

    parsed.sections.forEach(function (section) {
      el.cardSections.appendChild(buildSpoiler(section, type));
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

  function renderRating(path) {
    var ratings = global.Store.getRatings(path);
    if (ratings.length === 0) {
      setText(el.ratingInfo, 'Оценок пока нет.');
      return;
    }
    var last = ratings[ratings.length - 1];
    var label = RATING_LABELS[last.rating] || last.rating;
    setText(el.ratingInfo, 'Оценок: ' + ratings.length + ' · последняя: ' + label + ' (' + formatDate(last.ts) + ')');
  }

  function formatDate(ts) {
    var date = new Date(Number(ts) * 1000);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('ru-RU');
  }

  function onRate(rating) {
    if (!state.current) return;
    global.Store.addRating(state.current.path, rating);
    renderRating(state.current.path);
    el.ratingInfo.classList.add('flash');
    global.setTimeout(function () { el.ratingInfo.classList.remove('flash'); }, 500);
  }

  // --- навигация между экранами и hash-роутинг -----------------------------

  function showList() {
    state.current = null;
    if (global.location.hash) {
      // Убираем хеш, не добавляя запись в историю.
      global.history.replaceState(null, '', global.location.pathname + global.location.search);
    }
    show(el.viewCard, false);
    show(el.viewList, true);
    renderList();
  }

  function showCard() {
    show(el.viewList, false);
    show(el.viewCard, true);
  }

  function handleHash() {
    var hash = global.location.hash || '';
    var prefix = '#card=';
    if (hash.indexOf(prefix) === 0) {
      var path = decodePath(hash.slice(prefix.length));
      showCard();
      if (!state.current || state.current.path !== path) openCard(path);
    } else {
      showList();
    }
  }

  // --- инициализация -------------------------------------------------------

  function cacheElements() {
    var ids = ['view-list', 'view-card', 'card-list', 'list-status', 'list-error',
      'user-name', 'filter-lesson', 'filter-level', 'filter-search', 'filter-reset',
      'card-title', 'card-meta', 'card-sections', 'card-preamble', 'card-error',
      'card-rating', 'rating-info', 'btn-back', 'btn-prev', 'btn-next', 'repo-link'];
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
      renderList();
    });
    el.filterLevel.addEventListener('change', function () {
      state.filters.level = el.filterLevel.value;
      renderList();
    });
    el.filterSearch.addEventListener('input', function () {
      state.filters.search = el.filterSearch.value;
      renderList();
    });
    el.filterReset.addEventListener('click', function () {
      state.filters = { lesson: '', level: '', search: '' };
      el.filterLesson.value = '';
      el.filterLevel.value = '';
      el.filterSearch.value = '';
      renderList();
    });

    el.btnBack.addEventListener('click', function () { showList(); });
    el.btnPrev.addEventListener('click', function () { goRelative(-1); });
    el.btnNext.addEventListener('click', function () { goRelative(1); });

    el.cardRating.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('[data-rating]') : null;
      if (button) onRate(button.getAttribute('data-rating'));
    });

    global.addEventListener('hashchange', handleHash);

    // Открытые спойлеры пересчитываем при смене ширины/повороте экрана.
    global.addEventListener('resize', function () {
      var contents = el.cardSections.querySelectorAll('.spoiler.open .spoiler-content');
      for (var i = 0; i < contents.length; i++) {
        contents[i].parentNode.style.maxHeight = contents[i].scrollHeight + 'px';
      }
    });

    document.addEventListener('keydown', function (event) {
      if (el.viewCard.classList.contains('hidden')) return;
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if (event.key === 'ArrowLeft') { goRelative(-1); }
      if (event.key === 'ArrowRight') { goRelative(1); }
      if (event.key === 'Escape') { showList(); }
    });
  }

  function init() {
    cacheElements();
    el.repoLink.href = REPO_URL;
    bindEvents();

    loadIndex().then(function (cards) {
      state.cards = cards;
      fillSelect(el.filterLesson, collectFilterValues(cards, 'lesson'), 'все уроки');
      fillSelect(el.filterLevel, collectFilterValues(cards, 'level'), 'все уровни');
      renderList();
      handleHash();
    }).catch(function (error) {
      setText(el.listError, 'Не удалось загрузить список карточек: ' +
        (error && error.message ? error.message : error) +
        '. Проверьте, что сайт открыт по http (не file://) и что cards/index.json доступен.');
      show(el.listError, true);
      setText(el.listStatus, '');
      show(el.viewList, true);
      show(el.viewCard, false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
