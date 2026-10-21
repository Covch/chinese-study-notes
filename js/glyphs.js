// Сетка иероглифов: берёт из index.json карточки type=hieroglyph,
// вытаскивает символ из секции «## Иероглиф» и рисует ссылки на карточки.
(function (global) {
  'use strict';

  var INDEX_URL = 'cards/index.json';
  // Ссылка на карточку — hash-роутинг index.html (см. js/app.js).
  var CARD_URL = 'index.html#card=';
  var PAGE_SIZE = 60;

  // --- чистые функции: используются и тестами ------------------------------

  function sectionLine(parsed, titleRe) {
    if (!parsed || !parsed.sections) return '';
    for (var i = 0; i < parsed.sections.length; i++) {
      var section = parsed.sections[i];
      if (!titleRe.test(String(section.title || '').trim())) continue;
      var firstLine = String(section.content || '').split('\n')[0].trim();
      if (firstLine) return firstLine;
    }
    return '';
  }

  // Символ из «## Иероглиф»; если секции нет — хотя бы CJK из названия.
  function extractGlyph(parsed, entry) {
    var glyph = sectionLine(parsed, /^иероглиф/i);
    if (glyph) return glyph;

    var title = String((entry && entry.title) || '');
    var cjk = title.match(/[㐀-鿿豈-﫿]+/);
    return cjk ? cjk[0] : title;
  }

  function extractPinyin(parsed) {
    return sectionLine(parsed, /пиньинь|pinyin/i);
  }

  // Пиньинь ищем без учёта регистра и тонов: nǐ → ni.
  function fold(value) {
    var text = String(value || '').toLowerCase();
    if (text.normalize) {
      text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    }
    return text;
  }

  // Один набор условий: урок, уровень и поиск по символу/названию/пиньиню.
  function matches(item, filters) {
    var entry = item.entry || {};
    var f = filters || {};

    if (f.lesson && String(entry.lesson) !== String(f.lesson)) return false;
    if (f.level && String(entry.level) !== String(f.level)) return false;

    var query = fold(f.search).trim();
    if (!query) return true;

    var haystack = fold([item.glyph, entry.title, item.pinyin].join(' '));
    return haystack.indexOf(query) !== -1;
  }

  function glyphClass(glyph) {
    var length = Array.from ? Array.from(glyph).length : String(glyph).length;
    if (length <= 1) return 'len-1';
    if (length === 2) return 'len-2';
    if (length === 3) return 'len-3';
    return 'len-many';
  }

  global.GlyphCore = {
    extractGlyph: extractGlyph,
    extractPinyin: extractPinyin,
    matches: matches
  };

  // Дальше — только браузер. В тестах (gjs) document отсутствует.
  if (typeof document === 'undefined') return;

  // --- DOM -----------------------------------------------------------------

  var state = {
    entries: [],   // карточки-иероглифы из индекса
    items: [],     // + glyph/pinyin, загруженные из md
    failed: 0,     // сколько md не удалось прочитать
    filters: { lesson: '', level: '', search: '' },
    page: 1
  };

  var el = {};

  function setText(node, text) {
    node.textContent = text;
  }

  function show(node, visible) {
    node.classList.toggle('hidden', !visible);
  }

  // Путь кодируем по сегментам: в именах файлов есть CJK.
  function encodePath(path) {
    return String(path).split('/').map(encodeURIComponent).join('/');
  }

  function cardTitle(entry) {
    return entry.title || entry.path;
  }

  function loadIndex() {
    return fetch(INDEX_URL).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' при загрузке ' + INDEX_URL);
      return res.json();
    }).then(function (data) {
      if (!data || !Array.isArray(data.cards)) {
        throw new Error('Некорректный index.json: нет массива cards');
      }
      return data.cards.filter(function (card) {
        return card && card.type === 'hieroglyph' && card.path;
      });
    });
  }

  // Ошибка одной карточки не роняет всю сетку — плитка просто не покажется.
  function loadItem(entry) {
    return fetch(encodePath(entry.path)).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var parsed = global.MdParser.parseCard(text);
      return {
        entry: entry,
        glyph: extractGlyph(parsed, entry),
        pinyin: extractPinyin(parsed),
        failed: false
      };
    }).catch(function () {
      return {
        entry: entry,
        glyph: extractGlyph(null, entry),
        pinyin: '',
        failed: true
      };
    });
  }

  function collectValues(entries, key) {
    var values = [];
    entries.forEach(function (entry) {
      var value = entry[key];
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

  function tileLabel(item) {
    var title = cardTitle(item.entry);
    var parts = [item.glyph];
    if (item.pinyin) parts.push(item.pinyin);
    if (title && title !== item.glyph) parts.push(title);
    return parts.join(' — ');
  }

  function buildTile(item) {
    var link = document.createElement('a');
    link.className = 'glyph-tile';
    link.href = CARD_URL + encodePath(item.entry.path);
    link.title = tileLabel(item);
    link.setAttribute('aria-label', tileLabel(item));

    var glyph = document.createElement('span');
    glyph.className = 'glyph-char ' + glyphClass(item.glyph);
    setText(glyph, item.glyph);
    link.appendChild(glyph);

    return link;
  }

  function render() {
    var shown = state.items.filter(function (item) {
      return matches(item, state.filters);
    });

    el.glyphGrid.innerHTML = '';
    show(el.glyphError, false);
    show(el.glyphPager, false);

    if (state.items.length === 0) {
      setText(el.glyphStatus, state.entries.length === 0
        ? 'В индексе нет карточек-иероглифов.'
        : 'Не удалось загрузить иероглифы: ни один файл карточки не прочитался.');
      return;
    }

    if (shown.length === 0) {
      setText(el.glyphStatus, 'Ничего не найдено по фильтрам.');
      return;
    }

    var page = global.Pagination.slice(shown, state.page, PAGE_SIZE);
    state.page = page.page;

    var status = 'Показано: ' + shown.length + ' из ' + state.items.length;
    if (state.failed > 0) status += ' · не удалось загрузить: ' + state.failed;
    setText(el.glyphStatus, status);

    page.items.forEach(function (item) {
      el.glyphGrid.appendChild(buildTile(item));
    });

    if (page.pages > 1) {
      show(el.glyphPager, true);
      setText(el.glyphPageInfo, 'Страница ' + page.page + ' из ' + page.pages);
      el.glyphPrev.disabled = page.page <= 1;
      el.glyphNext.disabled = page.page >= page.pages;
    }
  }

  function cacheElements() {
    var ids = ['glyph-lesson', 'glyph-level', 'glyph-search', 'glyph-reset',
      'glyph-status', 'glyph-error', 'glyph-grid',
      'glyph-pager', 'glyph-prev', 'glyph-next', 'glyph-page-info'];
    ids.forEach(function (id) {
      el[id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); })] = document.getElementById(id);
    });
  }

  function goToPage(page) {
    state.page = page;
    render();
    global.scrollTo(0, 0);
  }

  function bindEvents() {
    el.glyphLesson.addEventListener('change', function () {
      state.filters.lesson = el.glyphLesson.value;
      state.page = 1;
      render();
    });
    el.glyphLevel.addEventListener('change', function () {
      state.filters.level = el.glyphLevel.value;
      state.page = 1;
      render();
    });
    el.glyphSearch.addEventListener('input', function () {
      state.filters.search = el.glyphSearch.value;
      state.page = 1;
      render();
    });
    el.glyphReset.addEventListener('click', function () {
      state.filters = { lesson: '', level: '', search: '' };
      state.page = 1;
      el.glyphLesson.value = '';
      el.glyphLevel.value = '';
      el.glyphSearch.value = '';
      render();
    });

    el.glyphPrev.addEventListener('click', function () { goToPage(state.page - 1); });
    el.glyphNext.addEventListener('click', function () { goToPage(state.page + 1); });
  }

  function init() {
    cacheElements();
    bindEvents();

    loadIndex().then(function (entries) {
      state.entries = entries;
      fillSelect(el.glyphLesson, collectValues(entries, 'lesson'), 'все уроки');
      fillSelect(el.glyphLevel, collectValues(entries, 'level'), 'все уровни');
      return Promise.all(entries.map(loadItem));
    }).then(function (items) {
      state.items = items.filter(function (item) { return !item.failed; });
      state.failed = items.length - state.items.length;
      render();
    }).catch(function (error) {
      setText(el.glyphStatus, '');
      setText(el.glyphError, 'Не удалось загрузить список карточек: ' +
        (error && error.message ? error.message : error) +
        '. Проверьте, что сайт открыт по http (не file://) и что cards/index.json доступен.');
      show(el.glyphError, true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
