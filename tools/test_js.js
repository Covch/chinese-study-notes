// Автотесты для js/*.js: математика повторений, разбор карточек, хранилище,
// статические проверки разметки. Без фреймворков и зависимостей.
//
// В этом окружении Node не установлен, поэтому основной запуск — через gjs
// (Mozilla SpiderMonkey, есть в системе):
//
//     gjs tools/test_js.js
//     node tools/test_js.js     — тот же файл, если Node когда-нибудь появится
//
// Код возврата: 0 — всё прошло, 1 — есть провалы. Проверяются только чистые
// функции и хранилище на подставных объектах; DOM, fetch и переходы по кнопкам
// здесь не покрываются — их смотрит человек в браузере.

var FIXED_NOW = 1700000000; // фиксированное «сейчас»: тесты не должны зависеть от часов

// --- окружение -------------------------------------------------------------

function readFile(path) {
  if (typeof require === 'function') {
    return require('fs').readFileSync(path, 'utf8');
  }
  var res = imports.gi.Gio.File.new_for_path(path).load_contents(null);
  if (!res[0]) throw new Error('не удалось прочитать ' + path);
  return new TextDecoder().decode(res[1]);
}

// Каталог этого файла: под Node — __dirname, под gjs — путь запущенного скрипта.
function scriptDir() {
  if (typeof __dirname === 'string') return __dirname;
  var name = (imports.system && imports.system.programInvocationName) || '';
  var cut = name.lastIndexOf('/');
  return cut >= 0 ? name.slice(0, cut) : '.';
}

var ROOT = scriptDir() + '/..';
var JS_DIR = ROOT + '/js';
var HTML_PATH = ROOT + '/index.html';
var GLYPHS_HTML_PATH = ROOT + '/glyphs.html';

// js/*.js — обычные IIFE на window, поэтому подставляем фейковый window с
// подставным хранилищем. Ошибки записи нужны, чтобы проверить честный отказ
// импорта при заблокированном localStorage.
function makeStorage() {
  var storage = { _data: {}, broken: false };
  storage.getItem = function (key) {
    return Object.prototype.hasOwnProperty.call(storage._data, key) ? storage._data[key] : null;
  };
  storage.setItem = function (key, value) {
    if (storage.broken) throw new Error('хранилище недоступно');
    storage._data[key] = String(value);
  };
  storage.removeItem = function (key) { delete storage._data[key]; };
  storage.clear = function () { storage._data = {}; };
  return storage;
}

var localStorageFake = makeStorage();
var sessionStorageFake = makeStorage();

// Подставное «окно». Присваивать globalThis.window нельзя: в gjs глобальный window
// уже существует и не перезаписывается (присваивание молча теряется), поэтому
// подставляем его параметром функции — приём работает в любом движке.
var fakeWindow = { localStorage: localStorageFake, sessionStorage: sessionStorageFake };

// Часы фиксируем: Store.addRating берёт Date.now() сам.
var realDateNow = Date.now;
Date.now = function () { return FIXED_NOW * 1000; };

function loadScript(name) {
  var source = readFile(JS_DIR + '/' + name);
  new Function('window', source)(fakeWindow);
  return source;
}

function resetStorages() {
  localStorageFake.clear();
  sessionStorageFake.clear();
  localStorageFake.broken = false;
}

// --- мини-фреймворк --------------------------------------------------------

var passed = 0;
var failed = 0;
var failures = [];
var groupName = '';
var notes = [];

function say(line) {
  if (typeof print === 'function') { print(line); return; }
  console.log(line);
}

function group(name, fn) {
  groupName = name;
  var checksBefore = passed + failed;
  var failedBefore = failed;
  var noteBefore = notes.length;

  try {
    fn();
  } catch (e) {
    // Исключение в одной группе не должно скрывать остальные.
    ok(false, 'исключение: ' + (e && e.message ? e.message : String(e)));
  }

  var checks = passed + failed - checksBefore;
  var bad = failed - failedBefore;
  say('  ' + name + ': ' + checks + ' проверок' + (bad > 0 ? ', провалов ' + bad : ' — ok'));
  for (var i = noteBefore; i < notes.length; i++) say('    замечание: ' + notes[i]);
}

function ok(condition, message) {
  if (condition) {
    passed += 1;
    return true;
  }
  failed += 1;
  failures.push(groupName + ': ' + message);
  say('  FAIL ' + groupName + ': ' + message);
  return false;
}

function eq(actual, expected, message) {
  return ok(String(actual) === String(expected),
    message + ' — ожидалось <' + expected + '>, получено <' + actual + '>');
}

function near(actual, expected, message) {
  return ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9,
    message + ' — ожидалось ' + expected + ', получено ' + actual);
}

function deepEq(actual, expected, message) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  return ok(a === b, message + ' — ожидалось ' + b + ', получено ' + a);
}

// --- загрузка модулей -----------------------------------------------------

var appSource = readFile(JS_DIR + '/app.js'); // только на чтение: DOM-объектов у нас нет
loadScript('srs.js');
// В браузере globalThis и window — один объект, поэтому srs.js кладёт Srs прямо
// в window. Здесь окно подставное, так что пробрасываем ссылку руками.
fakeWindow.Srs = globalThis.Srs;
loadScript('md.js');
loadScript('store.js');
// В gjs document отсутствует, поэтому glyphs.js останавливается на чистых функциях.
loadScript('glyphs.js');

var Srs = globalThis.Srs;
var Store = fakeWindow.Store;
var MdParser = fakeWindow.MdParser;
var GlyphCore = fakeWindow.GlyphCore;
var DAY = Srs.DAY;
var NOW = FIXED_NOW;

// --- разбор кода и разметки -----------------------------------------------

group('разбор: js/*.js компилируются', function () {
  ['srs.js', 'md.js', 'store.js', 'pagination.js', 'app.js', 'glyphs.js'].forEach(function (name) {
    // new Function компилирует, но не выполняет: ловим синтаксис даже в app.js.
    var error = null;
    try {
      new Function(readFile(JS_DIR + '/' + name));
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    ok(error === null, name + ' разбирается без ошибок' + (error ? ' (' + error + ')' : ''));
  });
});

group('разбор: id из cacheElements есть в index.html', function () {
  var htmlIds = {};
  var re = /\bid\s*=\s*"([^"]+)"/g;
  var m;
  while ((m = re.exec(readFile(HTML_PATH))) !== null) htmlIds[m[1]] = true;

  var block = /var ids\s*=\s*\[([\s\S]*?)\]/.exec(appSource);
  if (!ok(!!block, 'в app.js найден список кэшируемых id (var ids = [...])')) return;

  var ids = [];
  var reId = /'([^']+)'|"([^"]+)"/g;
  while ((m = reId.exec(block[1])) !== null) ids.push(m[1] || m[2]);

  ok(ids.length > 0, 'список кэшируемых id не пуст');
  ids.forEach(function (id) {
    ok(htmlIds[id] === true, 'элемент #' + id + ' объявлен в index.html');
  });

  // Точечные getElementById вне списка тоже должны существовать.
  var reGet = /getElementById\(\s*'([^']+)'\s*\)/g;
  while ((m = reGet.exec(appSource)) !== null) {
    ok(htmlIds[m[1]] === true, 'элемент #' + m[1] + ' из getElementById объявлен в index.html');
  }

  var uncached = [];
  Object.keys(htmlIds).forEach(function (id) {
    if (ids.indexOf(id) === -1) uncached.push(id);
  });
  if (uncached.length > 0) notes.push('в index.html объявлены id вне cacheElements: ' + uncached.join(', '));
});

function pageScripts(path) {
  var html = readFile(path);
  var order = [];
  var re = /<script\s+src="([^"]+)"><\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) order.push(m[1]);
  return order;
}

group('разбор: страницы подключают все js/*.js', function () {
  var indexScripts = pageScripts(HTML_PATH);
  var glyphScripts = pageScripts(GLYPHS_HTML_PATH);

  deepEq(indexScripts, ['js/md.js', 'js/srs.js', 'js/store.js', 'js/pagination.js', 'js/app.js'],
    'порядок подключения скриптов на index.html');

  deepEq(glyphScripts, ['js/md.js', 'js/pagination.js', 'js/glyphs.js'],
    'порядок подключения скриптов на glyphs.html');

  // Проверка на будущее: каждый файл из js/ должен быть подключён хотя бы на
  // одной странице, иначе он окажется «мёртвым» и никакой тест этого не заметит.
  var names = [];
  if (typeof require === 'function') {
    names = require('fs').readdirSync(JS_DIR);
  } else {
    var children = imports.gi.Gio.File.new_for_path(JS_DIR).enumerate_children(
      'standard::name', imports.gi.Gio.FileQueryInfoFlags.NONE, null);
    var info;
    while ((info = children.next_file(null)) !== null) names.push(info.get_name());
  }
  names.forEach(function (name) {
    var used = indexScripts.indexOf('js/' + name) !== -1 ||
      glyphScripts.indexOf('js/' + name) !== -1;
    ok(used, 'js/' + name + ' подключён хотя бы на одной странице');
  });
});

group('разбор: id из glyphs.js есть в glyphs.html', function () {
  var htmlIds = {};
  var re = /\bid\s*=\s*"([^"]+)"/g;
  var m;
  while ((m = re.exec(readFile(GLYPHS_HTML_PATH))) !== null) htmlIds[m[1]] = true;

  var glyphsSource = readFile(JS_DIR + '/glyphs.js');
  var block = /var ids\s*=\s*\[([\s\S]*?)\]/.exec(glyphsSource);
  if (!ok(!!block, 'в glyphs.js найден список кэшируемых id (var ids = [...])')) return;

  var ids = [];
  var reId = /'([^']+)'|"([^"]+)"/g;
  while ((m = reId.exec(block[1])) !== null) ids.push(m[1] || m[2]);

  ok(ids.length > 0, 'список кэшируемых id в glyphs.js не пуст');
  ids.forEach(function (id) {
    ok(htmlIds[id] === true, 'элемент #' + id + ' объявлен в glyphs.html');
  });

  var reGet = /getElementById\(\s*'([^']+)'\s*\)/g;
  while ((m = reGet.exec(glyphsSource)) !== null) {
    ok(htmlIds[m[1]] === true, 'элемент #' + m[1] + ' из glyphs.js объявлен в glyphs.html');
  }
});

// --- парсер карточек ------------------------------------------------------

group('MdParser.parseCard', function () {
  var sample = '---\n' +
    'title: "Частица 的"\n' +
    'type: rule\n' +
    'lesson: 2\n' +
    'level: HSK1\n' +
    '---\n' +
    '\n## Правило\n\nТекст\nвторая строка\n' +
    '\n## Примеры\n\n我的书\n';
  var card = MdParser.parseCard(sample);

  eq(card.meta.title, 'Частица 的', 'кавычки вокруг title снимаются');
  eq(card.meta.type, 'rule', 'type читается');
  eq(card.meta.lesson, 2, 'lesson приводится к числу');
  eq(card.meta.level, 'HSK1', 'level читается');
  eq(card.sections.length, 2, 'две секции');
  eq(card.sections[0].title, 'Правило', 'заголовок секции');
  eq(card.sections[0].content, 'Текст\nвторая строка', 'многострочное содержимое секции');
  eq(card.sections[0].empty, false, 'непустая секция');
  eq(card.preamble, '', 'преамбулы нет');

  var notNumber = MdParser.parseCard('---\nlesson: HSK1\n---\n\n## Секция\nтело\n');
  eq(notNumber.meta.lesson, null, 'нечисловой lesson превращается в null');

  var bom = MdParser.parseCard('﻿---\r\ntitle: Тест\r\n---\r\n\r\n## Секция\r\nпривет\r\n');
  eq(bom.meta.title, 'Тест', 'CRLF и BOM не мешают frontmatter');
  eq(bom.sections[0].title, 'Секция', 'секция читается после CRLF');
  eq(bom.sections[0].content, 'привет', 'содержимое без хвостовых переводов');

  var emptySection = MdParser.parseCard('## Пусто\n\n## Вторая\nтекст\n');
  eq(emptySection.sections[0].empty, true, 'пустая секция помечается empty');
  eq(emptySection.sections[0].content, '', 'содержимое пустой секции пусто');
  eq(emptySection.sections[1].content, 'текст', 'следующая секция не съедена');

  var withPreamble = MdParser.parseCard('---\ntitle: X\n---\n\nвводный текст\n\n## Секция\nтело\n');
  eq(withPreamble.preamble, 'вводный текст', 'преамбула отделяется от секций');

  var unclosed = MdParser.parseCard('---\ntitle: X\n\n## Секция\nтело\n');
  eq(unclosed.meta.title, '', 'незакрытый frontmatter считается отсутствующим');
  eq(unclosed.sections.length, 1, 'секции читаются и без frontmatter');

  var empty = MdParser.parseCard(null);
  eq(empty.sections.length, 0, 'пустой вход не бросает исключение');
  eq(empty.meta.title, '', 'у пустого входа пустой title');
});

// --- сетка иероглифов -----------------------------------------------------

group('GlyphCore: символ и пиньинь из карточки', function () {
  var parsed = MdParser.parseCard('---\n' +
    'title: Приветствие 你好\ntype: hieroglyph\nlesson: 1\nlevel: HSK1\n---\n' +
    '\n## Иероглиф\n\n你好\n\n## Пиньинь\n\nnǐ hǎo\n');

  eq(GlyphCore.extractGlyph(parsed, { title: 'Приветствие 你好' }), '你好',
    'символ берётся из секции «Иероглиф»');
  eq(GlyphCore.extractPinyin(parsed), 'nǐ hǎo', 'пиньинь берётся из одноимённой секции');
  eq(GlyphCore.extractPinyin(MdParser.parseCard('## Пример\nтекст\n')), '',
    'без секции пиньиня — пусто');

  eq(GlyphCore.extractGlyph(null, { title: 'Приветствие 你好' }), '你好',
    'без файла — CJK из названия');
  eq(GlyphCore.extractGlyph(null, { title: 'Him' }), 'Him',
    'без CJK — название целиком');

  var item = {
    entry: { lesson: 1, level: 'HSK1', title: 'Приветствие 你好' },
    glyph: '你好',
    pinyin: 'nǐ hǎo'
  };
  eq(GlyphCore.matches(item, { lesson: '', level: '', search: '' }), true,
    'пустые фильтры пропускают всё');
  eq(GlyphCore.matches(item, {}), true, 'отсутствующие поля фильтров не отсекают');
  eq(GlyphCore.matches(item, { lesson: '2' }), false, 'фильтр по уроку отсекает');
  eq(GlyphCore.matches(item, { level: 'HSK1' }), true, 'фильтр по уровню совпадает');
  eq(GlyphCore.matches(item, { search: '你' }), true, 'поиск по символу');
  eq(GlyphCore.matches(item, { search: 'NI' }), true, 'поиск по пиньиню без регистра');
  eq(GlyphCore.matches(item, { search: 'привет' }), true, 'поиск по названию без регистра');
  eq(GlyphCore.matches(item, { search: 'кот' }), false, 'несовпадающий поиск отсекает');
});

// --- математика повторений ------------------------------------------------

group('Srs.review: три оценки от нового состояния', function () {
  var def = Srs.newState();
  eq(def.ef, Srs.EF_START, 'новая карточка начинается с EF 2.5');
  eq(def.n, 0, 'новая карточка: n = 0');
  eq(def.due, 0, 'новая карточка: due = 0');

  var good = Srs.review(null, 'good', NOW);
  near(good.ef, 2.6, '«хорошо» повышает EF на 0.10');
  eq(good.n, 1, '«хорошо»: первый успех');
  eq(good.ivl, Srs.FIRST_IVL, 'первый интервал');
  eq(good.due, NOW + DAY, 'первый срок — через день');
  eq(good.reps, 1, 'ответ посчитан');
  eq(good.lapses, 0, 'провалов нет');

  var ok = Srs.review(null, 'ok', NOW);
  near(ok.ef, 2.36, '«слабо помню» понижает EF на 0.14');
  eq(ok.n, 1, '«слабо помню» — тоже успех');
  eq(ok.ivl, Srs.FIRST_IVL, 'интервал после «слабо помню» — первый');

  var bad = Srs.review(null, 'bad', NOW);
  near(bad.ef, 2.18, '«не помню» понижает EF на 0.32');
  eq(bad.n, 0, '«не помню» сбрасывает серию успехов');
  eq(bad.ivl, 0, '«не помню» обнуляет интервал');
  eq(bad.due, NOW, '«не помню» — карточка нужна сразу');
  eq(bad.lapses, 1, 'провал посчитан');
});

group('Srs.review: интервалы растут', function () {
  var first = Srs.review(null, 'good', NOW);
  var second = Srs.review(first, 'good', first.due);
  eq(second.ivl, Srs.SECOND_IVL, 'второй интервал фиксирован — 6 дней');
  eq(second.n, 2, 'второй успех');
  eq(second.due, first.due + Srs.SECOND_IVL * DAY, 'срок = предыдущий + 6 дней');

  var third = Srs.review(second, 'good', second.due);
  eq(third.n, 3, 'третий успех');
  eq(third.ivl, Math.round(Srs.SECOND_IVL * third.ef), 'дальше интервал = предыдущий × EF');
  ok(third.ivl > Srs.SECOND_IVL, 'третий интервал больше второго');

  // «Слабо помню» тоже продлевает, но EF гасится — рост медленнее, чем на «хорошо».
  var okState = Srs.review(second, 'ok', second.due);
  var goodState = Srs.review(second, 'good', second.due);
  ok(okState.ivl < goodState.ivl, 'после «слабо помню» интервал короче, чем после «хорошо»');
  ok(okState.ef < goodState.ef, '«слабо помню» оставляет EF ниже');
});

group('константы алгоритма зафиксированы', function () {
  // Эти числа — часть договора (см. CARD_FORMAT.md). Тесты ниже сравнивают результаты
  // с литералами, а не с самими константами, поэтому случайная правка числа ломает тест,
  // а не «согласованно» проходит вместе с ним.
  eq(Srs.EF_START, 2.5, 'стартовый EF = 2.5');
  eq(Srs.EF_MIN, 1.3, 'нижний предел EF = 1.3');
  eq(Srs.EF_MAX, 3.0, 'верхний предел EF = 3.0');
  eq(Srs.FIRST_IVL, 1, 'первый интервал = 1 день');
  eq(Srs.SECOND_IVL, 6, 'второй интервал = 6 дней');
  eq(Srs.MAX_IVL, 365, 'потолок интервала = 365 дней');
  eq(Srs.DAY, 86400, 'сутки = 86400 секунд');
  eq(Srs.MAX_REQUEUE, 2, 'возвратов в сессию не больше двух');
  eq(Srs.APP_MARK, 'chinese-cards', 'метка файла копии не менялась');
  eq(Srs.ENVELOPE_VERSION, 1, 'версия файла копии не менялась');
  deepEq(Srs.RATINGS, ['bad', 'ok', 'good'], 'три оценки, порядок фиксирован');
  eq(Srs.QUALITY.bad, 2, 'bad — это 2 балла SM-2');
  eq(Srs.QUALITY.ok, 3, 'ok — это 3 балла SM-2');
  eq(Srs.QUALITY.good, 5, 'good — это 5 баллов SM-2');
});

group('Srs.review: предохранители', function () {
  var state = null;
  for (var i = 0; i < 50; i++) state = Srs.review(state, 'bad', NOW);
  near(state.ef, 1.3, 'EF не опускается ниже 1.3 на полусотне провалов');

  var grown = null;
  for (var j = 0; j < 30; j++) grown = Srs.review(grown, 'good', grown ? grown.due : NOW);
  eq(grown.ivl, 365, 'интервал упирается в потолок 365 дней');
  ok(grown.ef <= 3.0, 'EF не превышает потолок');

  var source = Srs.newState();
  var before = JSON.stringify(source);
  Srs.review(source, 'good', NOW);
  eq(JSON.stringify(source), before, 'review не меняет исходное состояние');

  var unknown = Srs.review({ n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 }, 'нет такой', NOW);
  eq(unknown.reps, 1, 'неизвестная оценка ничего не меняет');
  eq(unknown.n, 1, 'неизвестная оценка не трогает серию');
});

group('Srs.review: сценарий ok → good → good → bad', function () {
  // Ровно таблица из плана: каждая оценка даётся в момент, когда карточка снова нужна.
  var ratings = ['ok', 'good', 'good', 'bad'];
  var state = null;
  var at = NOW;
  var rows = [];

  for (var i = 0; i < ratings.length; i++) {
    state = Srs.review(state, ratings[i], at);
    rows.push({ state: state, at: at });
    at = state.due;
  }

  near(rows[0].state.ef, 2.36, 'шаг 1 (ok): EF');
  eq(rows[0].state.ivl, 1, 'шаг 1 (ok): интервал 1 день');
  eq(rows[0].state.due, NOW + DAY, 'шаг 1 (ok): срок');

  near(rows[1].state.ef, 2.46, 'шаг 2 (good): EF');
  eq(rows[1].state.ivl, 6, 'шаг 2 (good): интервал 6 дней');
  eq(rows[1].state.due, NOW + 7 * DAY, 'шаг 2 (good): срок +7 дней');

  near(rows[2].state.ef, 2.56, 'шаг 3 (good): EF');
  eq(rows[2].state.ivl, 15, 'шаг 3 (good): интервал 15 дней');
  eq(rows[2].state.due, NOW + 22 * DAY, 'шаг 3 (good): срок +22 дня');

  near(rows[3].state.ef, 2.24, 'шаг 4 (bad): EF остался пониженным');
  eq(rows[3].state.n, 0, 'шаг 4 (bad): серия сброшена');
  eq(rows[3].state.due, NOW + 22 * DAY, 'шаг 4 (bad): карточка нужна сразу');
  eq(rows[3].state.lapses, 1, 'шаг 4 (bad): провал посчитан');
  eq(rows[3].state.reps, 4, 'шаг 4 (bad): всего четыре ответа');
});

group('Srs.normalizeState', function () {
  var garbage = Srs.normalizeState({ n: -5, ef: 'x', ivl: NaN, due: '123', reps: null, lapses: -3 }, NOW);
  eq(garbage.n, 0, 'отрицательное n обнуляется');
  eq(garbage.ef, Srs.EF_START, 'нечисловой EF заменяется стартовым');
  eq(garbage.ivl, 0, 'NaN в ivl заменяется нулём');
  eq(garbage.reps, 0, 'null в reps заменяется нулём');
  eq(garbage.lapses, 0, 'отрицательные провалы обнуляются');
  eq(Srs.isDue(garbage, NOW), true, 'битая карточка не прячется — она просто нужна сейчас');

  var far = { n: 1, ef: 2.5, ivl: 10, due: NOW + 10 * 365 * DAY, reps: 1, lapses: 0 };
  eq(Srs.normalizeState(far, NOW).due, NOW + Srs.MAX_IVL * DAY,
    'срок из далёкого будущего подрезается до потолка');

  var hugeEf = Srs.normalizeState({ ef: 99 }, NOW);
  eq(hugeEf.ef, Srs.EF_MAX, 'EF обрезается сверху');
  eq(Srs.normalizeState({ ef: 0.1 }, NOW).ef, Srs.EF_MIN, 'EF обрезается снизу');

  deepEq(Srs.normalizeState(null, NOW), Srs.newState(), 'null даёт состояние новой карточки');
  deepEq(Srs.normalizeState('мусор', NOW), Srs.newState(), 'строка даёт состояние новой карточки');

  var valid = { n: 3, ef: 2.56, ivl: 15, due: NOW + 5 * DAY, reps: 5, lapses: 1 };
  deepEq(Srs.normalizeState(valid, NOW), valid, 'корректное состояние не портится');
});

group('Srs.buildQueue', function () {
  var cards = [
    { path: 'a', type: 'hieroglyph' },
    { path: 'b', type: 'rule' },
    { path: 'c', type: 'rule' },
    { path: 'd', type: 'hieroglyph' }
  ];
  var srsMap = {
    b: { n: 1, ef: 2.5, ivl: 1, due: NOW - 10, reps: 1, lapses: 0 },
    c: { n: 1, ef: 2.5, ivl: 1, due: NOW - 100, reps: 1, lapses: 0 },
    d: { n: 1, ef: 2.5, ivl: 1, due: NOW + 5 * DAY, reps: 1, lapses: 0 },
    zzz: { n: 1, ef: 2.5, ivl: 1, due: NOW - 1000, reps: 1, lapses: 0 }
  };

  var queue = Srs.buildQueue(cards, srsMap, { now: NOW });
  deepEq(queue.paths, ['c', 'b', 'a'], 'сначала просроченные по сроку, затем новые');
  eq(queue.dueCount, 2, 'просроченных двое');
  eq(queue.newCount, 1, 'новых одна');
  eq(queue.laterCount, 1, 'одна ждёт своего часа');
  eq(queue.nextDue, NOW + 5 * DAY, 'nextDue — ближайший будущий срок');
  eq(queue.paths.indexOf('zzz'), -1, 'путь вне индекса в очередь не попадает');

  deepEq(Srs.buildQueue(cards, srsMap, { now: NOW, limit: 2 }).paths, ['c', 'b'], 'лимит обрезает очередь');
  eq(Srs.buildQueue(cards, srsMap, { now: NOW, limit: 99 }).paths.length, 3, 'лимит больше очереди — берём всю');
  eq(Srs.buildQueue(cards, srsMap, { now: NOW, limit: 0 }).paths.length, 3, 'лимит 0 — все доступные');

  var onlyRules = Srs.buildQueue(cards, srsMap, {
    now: NOW,
    match: function (card) { return card.type === 'rule'; }
  });
  deepEq(onlyRules.paths, ['c', 'b'], 'предикат отбирает только правила');

  var nothing = Srs.buildQueue([cards[3]], srsMap, { now: NOW });
  deepEq(nothing.paths, [], 'когда ничего не пора — очередь пуста');
  eq(nothing.nextDue, NOW + 5 * DAY, 'при пустой очереди подсказываем следующий срок');

  var allFuture = Srs.buildQueue([cards[3]], { d: srsMap.d }, { now: NOW });
  eq(allFuture.nextDue, NOW + 5 * DAY, 'nextDue считается и без просроченных');

  var noLater = Srs.buildQueue([cards[0], cards[1]], srsMap, { now: NOW });
  eq(noLater.nextDue, null, 'если будущих нет — nextDue пуст');

  var sameDue = Srs.buildQueue(cards, {
    b: { n: 1, ef: 2.5, ivl: 1, due: NOW - 50, reps: 1, lapses: 0 },
    c: { n: 1, ef: 2.5, ivl: 1, due: NOW - 50, reps: 1, lapses: 0 }
  }, { now: NOW });
  deepEq(sameDue.paths, ['b', 'c', 'a', 'd'], 'при равных сроках порядок задаёт индекс');

  var exact = Srs.buildQueue([cards[1]], srsMap, { now: NOW - 10 });
  deepEq(exact.paths, ['b'], 'срок ровно «сейчас» уже пора повторять');
});

group('Srs.isDue / daysUntil', function () {
  eq(Srs.isDue({ due: NOW }, NOW), true, 'due == now — пора');
  eq(Srs.isDue({ due: NOW + 1 }, NOW), false, 'due в будущем — не пора');
  eq(Srs.daysUntil({ due: NOW - 2 * DAY }, NOW), -2, 'просрочка даёт отрицательное число дней');
  eq(Srs.daysUntil({ due: NOW }, NOW), 0, 'сегодня — ноль дней');
  eq(Srs.daysUntil({ due: NOW + 6 * DAY }, NOW), 6, 'через шесть дней — шесть');
  eq(Srs.isDue(null, NOW), true, 'нет записи — карточка нужна сейчас');
});

// --- очередь сессии повторения --------------------------------------------

group('Srs.stepSession', function () {
  var fresh = function () { return { paths: ['a', 'b', 'c'], i: 0, done: 0, requeued: {} }; };

  var good = Srs.stepSession(fresh(), 'good', 2);
  eq(good.i, 1, 'успех двигает очередь на одну карточку');
  eq(good.done, 1, 'успех посчитан как оценённый');
  deepEq(good.paths, ['a', 'b', 'c'], 'успех не меняет очередь');

  var skipped = Srs.stepSession(fresh(), null, 2);
  eq(skipped.i, 1, 'пропуск двигает очередь');
  eq(skipped.done, 0, 'пропуск не считается оценкой');
  deepEq(skipped.paths, ['a', 'b', 'c'], 'пропуск не меняет очередь');

  var bad = Srs.stepSession(fresh(), 'bad', 2);
  eq(bad.i, 1, '«не помню» двигает очередь');
  eq(bad.done, 1, '«не помню» — это оценка');
  deepEq(bad.paths, ['a', 'b', 'c', 'a'], '«не помню» возвращает карточку в конец');
  eq(bad.requeued.a, 1, 'возврат посчитан');

  // Второй и третий «не помню»: при MAX_REQUEUE = 2 карточка возвращается дважды, потом нет.
  var second = Srs.stepSession({ paths: ['a', 'a'], i: 1, done: 1, requeued: { a: 1 } }, 'bad', 2);
  deepEq(second.paths, ['a', 'a', 'a'], 'второй возврат разрешён');
  eq(second.requeued.a, 2, 'счётчик возвратов растёт');

  var third = Srs.stepSession({ paths: ['a', 'a', 'a'], i: 2, done: 2, requeued: { a: 2 } }, 'bad', 2);
  deepEq(third.paths, ['a', 'a', 'a'], 'после лимита очередь не растёт');
  eq(third.requeued.a, 2, 'счётчик возвратов не превышает лимит');
  eq(third.i, 3, 'но карточка всё равно уходит из очереди');

  var defaultCap = Srs.stepSession(fresh(), 'bad');
  eq(defaultCap.requeued.a, 1, 'без явного лимита берётся MAX_REQUEUE');

  // Лимит по умолчанию проверяем прогоном до конца: карточка возвращается ровно дважды.
  var auto = { paths: ['a'], i: 0, done: 0, requeued: {} };
  var returns = 0;
  for (var step = 0; step < 10 && auto.i < auto.paths.length; step++) {
    var lengthBefore = auto.paths.length;
    auto = Srs.stepSession(auto, 'bad');
    if (auto.paths.length > lengthBefore) returns += 1;
  }
  eq(returns, 2, 'по умолчанию карточка возвращается ровно дважды');
  deepEq(auto.paths, ['a', 'a', 'a'], 'очередь выросла ровно на два возврата');

  var zeroCap = Srs.stepSession(fresh(), 'bad', 0);
  deepEq(zeroCap.paths, ['a', 'b', 'c'], 'лимит 0 отключает возврат');

  // Очередь живёт в sessionStorage, поэтому мусор из неё не должен ломать шаг.
  var junk = Srs.stepSession({ paths: ['a', 7, '', null], i: 99, done: -5, requeued: { a: 'два' } }, 'good', 2);
  deepEq(junk.paths, ['a'], 'нестроковые пути выброшены');
  eq(junk.i, 1, 'позиция за пределами очереди прижата к концу');
  eq(junk.done, 0, 'сессия за концом очереди не двигается');
  eq(Srs.stepSession({ paths: ['a'], i: 0, done: -5 }, 'good', 2).done, 1,
    'отрицательный счётчик оценок исправлен');
  eq(Srs.stepSession(null, 'good', 2).done, 0, 'null вместо сессии — пустая сессия, а не исключение');

  var finished = Srs.stepSession({ paths: ['a'], i: 1, done: 1, requeued: {} }, 'good', 2);
  eq(finished.i, 1, 'шаг за концом очереди ничего не делает');
  eq(finished.done, 1, 'и не добавляет оценок');

  // Чистота: вход не меняется.
  var source = fresh();
  Srs.stepSession(source, 'bad', 2);
  deepEq(source.paths, ['a', 'b', 'c'], 'входная сессия не мутируется');
  eq(source.i, 0, 'позиция входа не сдвинулась');
});

group('Srs.sessionLeft', function () {
  eq(Srs.sessionLeft({ paths: ['a', 'b', 'c'], i: 1 }), 2, 'остаток очереди посчитан');
  eq(Srs.sessionLeft({ paths: ['a'], i: 1 }), 0, 'пройденная сессия — ноль');
  eq(Srs.sessionLeft(null), 0, 'нет сессии — ноль');
  eq(Srs.sessionLeft({ paths: ['a', 'b'], i: 99 }), 0, 'позиция за концом не даёт отрицательного остатка');
});

// --- слияние и разбор резервной копии -------------------------------------

group('Srs.mergeProgress', function () {
  var local = { 'cards/a.md': [{ ts: 100, rating: 'good' }] };

  var same = Srs.mergeProgress(local, local);
  eq(same.added, 0, 'повторный импорт того же файла ничего не добавляет');
  deepEq(same.progress['cards/a.md'], [{ ts: 100, rating: 'good' }], 'записи не удваиваются');

  var disjoint = Srs.mergeProgress(
    { 'cards/a.md': [{ ts: 100, rating: 'good' }] },
    { 'cards/b.md': [{ ts: 200, rating: 'bad' }] }
  );
  eq(disjoint.added, 1, 'новая карточка из файла добавляется');
  ok(disjoint.progress['cards/a.md'] && disjoint.progress['cards/b.md'], 'оба пути на месте');

  // Три одинаковые оценки в одну секунду локально, одна в файле → остаётся три,
  // а не четыре: кратность записи не суммируется.
  var multiplicity = Srs.mergeProgress(
    { 'cards/a.md': [{ ts: 100, rating: 'good' }, { ts: 100, rating: 'good' }, { ts: 100, rating: 'good' }] },
    { 'cards/a.md': [{ ts: 100, rating: 'good' }] }
  );
  eq(multiplicity.progress['cards/a.md'].length, 3, 'кратность берётся по максимуму, а не суммой');
  eq(multiplicity.added, 0, 'лишних записей не появилось');

  var more = Srs.mergeProgress(
    { 'cards/a.md': [{ ts: 100, rating: 'good' }] },
    { 'cards/a.md': [{ ts: 100, rating: 'good' }, { ts: 100, rating: 'good' }] }
  );
  eq(more.progress['cards/a.md'].length, 2, 'из файла добирается недостающая кратность');
  eq(more.added, 1, 'добавлена ровно одна запись');

  var sorted = Srs.mergeProgress(
    { 'cards/a.md': [{ ts: 300, rating: 'good' }] },
    { 'cards/a.md': [{ ts: 100, rating: 'bad' }] }
  );
  deepEq(sorted.progress['cards/a.md'], [{ ts: 100, rating: 'bad' }, { ts: 300, rating: 'good' }],
    'история отсортирована по времени');

  var badRating = Srs.mergeProgress({}, { 'cards/a.md': [{ ts: 100, rating: 'что-то' }] });
  eq(badRating.added, 0, 'неизвестная оценка в истории игнорируется');

  var otherRatings = Srs.mergeProgress(
    { 'cards/a.md': [{ ts: 100, rating: 'good' }] },
    { 'cards/a.md': [{ ts: 100, rating: 'bad' }] }
  );
  eq(otherRatings.progress['cards/a.md'].length, 2, 'разные оценки одной секунды сохраняются обе');
});

group('Srs.mergeSrs', function () {
  var moreReps = Srs.mergeSrs(
    { 'a': { n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 } },
    { 'a': { n: 5, ef: 2.7, ivl: 30, due: NOW + 30 * DAY, reps: 5, lapses: 0 } }
  );
  eq(moreReps.srs.a.reps, 5, 'побеждает запись с большим числом ответов');
  eq(moreReps.updated, 1, 'обновление посчитано');

  var sameReps = Srs.mergeSrs(
    { 'a': { n: 1, ef: 2.5, ivl: 1, due: NOW + 5, reps: 2, lapses: 0 } },
    { 'a': { n: 1, ef: 2.5, ivl: 1, due: NOW + 50, reps: 2, lapses: 0 } }
  );
  eq(sameReps.srs.a.due, NOW + 50, 'при равных ответах побеждает более поздний срок');
  eq(sameReps.updated, 1, 'замена посчитана');

  var onlyImported = Srs.mergeSrs({}, { 'b': { n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 } });
  ok(!!onlyImported.srs.b, 'путь только из файла добавляется');
  eq(onlyImported.updated, 1, 'новый путь — это обновление');

  var onlyLocal = Srs.mergeSrs({ 'c': { n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 } }, {});
  ok(!!onlyLocal.srs.c, 'локальное расписание не теряется при импорте без srs');
  eq(onlyLocal.updated, 0, 'нечего обновлять');

  var weaker = Srs.mergeSrs(
    { 'a': { n: 5, ef: 2.9, ivl: 30, due: NOW + 30 * DAY, reps: 9, lapses: 1 } },
    { 'a': { n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 } }
  );
  eq(weaker.srs.a.reps, 9, 'более слабая запись из файла не откатывает локальную');
  eq(weaker.updated, 0, 'откат не считается обновлением');
});

group('Srs.parseEnvelope', function () {
  var envelope = {
    app: 'chinese-cards',
    version: 1,
    exportedAt: NOW,
    user: { name: 'Дмитрий' },
    progress: { 'cards/rule-的.md': [{ ts: NOW, rating: 'good' }] },
    srs: { 'cards/rule-的.md': { n: 1, ef: 2.5, ivl: 1, due: NOW + DAY, reps: 1, lapses: 0 } },
    лишнийКлюч: 'игнорируется'
  };
  var parsed = Srs.parseEnvelope(envelope, NOW);
  eq(parsed.ok, true, 'корректный файл принимается');
  eq(parsed.env.user.name, 'Дмитрий', 'имя из файла читается');
  eq(parsed.env.progress['cards/rule-的.md'].length, 1, 'история читается');
  eq(parsed.env.srs['cards/rule-的.md'].ivl, 1, 'расписание читается');
  eq(parsed.skipped, 0, 'ничего не отброшено');

  eq(Srs.parseEnvelope(null, NOW).ok, false, 'null — не файл копии');
  eq(Srs.parseEnvelope('строка', NOW).ok, false, 'строка — не файл копии');
  eq(Srs.parseEnvelope([], NOW).ok, false, 'массив — не файл копии');
  eq(Srs.parseEnvelope({ version: 1 }, NOW).ok, false, 'файл без метки приложения отвергается');
  eq(Srs.parseEnvelope({ app: 'другое', version: 1 }, NOW).ok, false, 'чужая метка отвергается');
  eq(Srs.parseEnvelope({ app: 'chinese-cards', version: 99 }, NOW).ok, false, 'слишком новая версия отвергается');
  eq(Srs.parseEnvelope({ app: 'chinese-cards' }, NOW).ok, true, 'отсутствие version не мешает (считаем 0)');

  var broken = Srs.parseEnvelope({
    app: 'chinese-cards',
    version: 1,
    progress: {
      'cards/a.md': [
        { ts: NOW, rating: 'good' },
        { ts: NOW, rating: 'undefined-оценка' },
        { ts: 'вчера', rating: 'good' },
        { ts: -5, rating: 'good' }
      ],
      'cards/b.md': 'не массив'
    }
  }, NOW);
  eq(broken.ok, true, 'битые записи не делают файл невалидным');
  eq(broken.skipped, 4, 'битые записи посчитаны');
  deepEq(broken.env.progress['cards/a.md'], [{ ts: NOW, rating: 'good' }], 'осталась только целая запись');
  eq(broken.env.progress['cards/b.md'], undefined, 'не-массив по пути пропускается');

  var weird = Srs.parseEnvelope({ app: 'chinese-cards', version: 1, progress: [] }, NOW);
  eq(weird.ok, true, 'не-объект в progress не фатален');
  eq(weird.warnings.length, 1, 'о пропущенном progress сообщается');
  deepEq(weird.env.progress, {}, 'прогресс пуст');

  var weirdSrs = Srs.parseEnvelope({
    app: 'chinese-cards',
    version: 1,
    srs: { 'cards/a.md': { ef: 'x', ivl: NaN, n: 'много' }, 'cards/b.md': 5 }
  }, NOW);
  eq(weirdSrs.ok, true, 'битое расписание не фатально');
  eq(weirdSrs.env.srs['cards/a.md'].ef, Srs.EF_START, 'битый EF чинится');
  eq(weirdSrs.env.srs['cards/a.md'].ivl, 0, 'битый интервал чинится');
  eq(weirdSrs.env.srs['cards/b.md'], undefined, 'не-объект в расписании пропускается');

  var clamps = Srs.parseEnvelope({
    app: 'chinese-cards',
    version: 1,
    srs: { 'cards/a.md': { n: 1, ef: 2.5, ivl: 10, due: NOW + 10 * 365 * DAY } }
  }, NOW);
  eq(clamps.env.srs['cards/a.md'].due, NOW + Srs.MAX_IVL * DAY, 'срок из будущего подрезается при импорте');
});

// --- хранилище -------------------------------------------------------------

group('Store: имя и история оценок', function () {
  resetStorages();
  eq(Store.getUserName(), '', 'без записи имя пустое');

  Store.setUserName('Дмитрий');
  eq(Store.getUserName(), 'Дмитрий', 'имя сохраняется и читается');

  deepEq(Store.getRatings('cards/a.md'), [], 'истории нет — пустой список');
  Store.addRating('cards/a.md', 'good');
  var list = Store.addRating('cards/a.md', 'bad');
  eq(list.length, 2, 'оценки дописываются, а не перезаписываются');
  eq(Store.getRatings('cards/a.md')[0].ts, NOW, 'время пишется в секундах');
  eq(Store.getRatings('cards/a.md')[1].rating, 'bad', 'значение оценки сохраняется как есть');

  var raw = JSON.parse(localStorageFake.getItem(Store.KEY_PROGRESS));
  eq(raw['cards/a.md'].length, 2, 'история лежит в cl:v1:progress');
  eq(Store.getRatings('cards/другой.md').length, 0, 'чужая карточка не затронута');
});

group('Store: расписание повторений', function () {
  resetStorages();
  eq(Store.getSrsCard('cards/a.md'), null, 'расписания нет — null');

  eq(Store.setSrsCard('cards/a.md', { n: 1, ef: 2.6, ivl: 1, due: NOW + DAY, reps: 1, lapses: 0 }), true,
    'запись расписания проходит');
  eq(Store.getSrsCard('cards/a.md').ivl, 1, 'расписание читается');

  Store.setSrsCard('cards/a.md', { ef: 'x' });
  eq(Store.getSrsCard('cards/a.md').ef, Srs.EF_START, 'мусор чинится при записи');

  localStorageFake.setItem(Store.KEY_SRS, JSON.stringify({
    'cards/a.md': { n: 2, ef: 2.5, ivl: 6, due: NOW + 6 * DAY, reps: 2, lapses: 0 },
    'cards/b.md': 'мусор',
    'cards/c.md': null
  }));
  var all = Store.getSrs();
  eq(Object.keys(all).length, 1, 'не-объекты выбрасываются при чтении');
  eq(all['cards/a.md'].n, 2, 'целая запись читается');

  Store.resetSrs();
  deepEq(Store.getSrs(), {}, 'сброс расписания очищает только его');
  eq(Store.getRatings('cards/a.md').length, 0, 'сброс расписания не трогает историю оценок');
});

group('Store: резервная копия', function () {
  resetStorages();
  Store.setUserName('Дмитрий');
  Store.addRating('cards/a.md', 'good');
  Store.setSrsCard('cards/a.md', Srs.review(null, 'good', NOW));

  var env = Store.exportData();
  eq(env.app, 'chinese-cards', 'в копии есть метка приложения');
  eq(env.version, 1, 'в копии есть версия');
  eq(env.exportedAt, NOW, 'время выгрузки в секундах');
  eq(env.user.name, 'Дмитрий', 'имя попадает в копию');
  eq(env.progress['cards/a.md'].length, 1, 'история попадает в копию');
  eq(env.srs['cards/a.md'].ivl, 1, 'расписание попадает в копию');
  eq(JSON.stringify(env.progress).indexOf('cards/a.md') > 0, true, 'пути в копии сырые');

  // Импорт своей же копии после сброса возвращает состояние и ничего не удваивает.
  Store.resetSrs();
  localStorageFake.removeItem(Store.KEY_PROGRESS);
  var merged = Store.importData(env, 'merge', ['cards/a.md']);
  eq(merged.ok, true, 'импорт проходит');
  eq(merged.summary.ratingsAdded, 1, 'история восстановлена из копии');
  eq(merged.summary.srsUpdated, 1, 'расписание восстановлено из копии');
  eq(merged.summary.orphanPaths, 0, 'путей вне индекса нет');
  eq(Store.getSrsCard('cards/a.md').ivl, 1, 'расписание на месте после импорта');

  var again = Store.importData(env, 'merge', ['cards/a.md']);
  eq(again.summary.ratingsAdded, 0, 'повторный импорт той же копии ничего не добавляет');

  var orphan = Store.importData({
    app: 'chinese-cards',
    version: 1,
    progress: { 'cards/пропавшая.md': [{ ts: NOW, rating: 'good' }] },
    srs: { 'cards/пропавшая.md': { n: 1, ef: 2.5, ivl: 1, due: NOW, reps: 1, lapses: 0 } }
  }, 'merge', ['cards/a.md']);
  eq(orphan.summary.orphanPaths, 1, 'записи вне индекса сохраняются и считаются');
  eq(Store.getRatings('cards/пропавшая.md').length, 1, 'история вне индекса не выбрасывается');

  // Замена перезаписывает целиком.
  var replaced = Store.importData({
    app: 'chinese-cards',
    version: 1,
    progress: { 'cards/b.md': [{ ts: NOW, rating: 'bad' }] },
    srs: {}
  }, 'replace', ['cards/b.md']);
  eq(replaced.ok, true, 'замена проходит');
  eq(Store.getRatings('cards/a.md').length, 0, 'при замене старая история уходит');
  eq(Store.getRatings('cards/b.md').length, 1, 'новая история записана');
});

group('Store: имя не затирается, отказы честные', function () {
  resetStorages();
  Store.setUserName('Дмитрий');
  Store.importData({
    app: 'chinese-cards', version: 1, user: { name: 'Кто-то другой' }, progress: {}, srs: {}
  }, 'merge', []);
  eq(Store.getUserName(), 'Дмитрий', 'непустое имя не перезаписывается из файла');

  localStorageFake.removeItem(Store.KEY_USER);
  Store.importData({
    app: 'chinese-cards', version: 1, user: { name: 'Из файла' }, progress: {}, srs: {}
  }, 'merge', []);
  eq(Store.getUserName(), 'Из файла', 'пустое имя заполняется из файла');

  var foreign = Store.importData({ app: 'другое', version: 1 }, 'merge', []);
  eq(foreign.ok, false, 'чужой файл отвергается');
  ok(foreign.error.length > 0, 'причина отказа описана');

  var brokenEnv = Store.exportData();
  localStorageFake.broken = true;
  eq(Store.isAvailable(), false, 'недоступное хранилище распознаётся');
  var refused = Store.importData(brokenEnv, 'merge', []);
  eq(refused.ok, false, 'при заблокированной записи импорт не притворяется успешным');
  localStorageFake.broken = false;
  eq(Store.isAvailable(), true, 'рабочее хранилище распознаётся');
});

group('Store: сессия повторения', function () {
  resetStorages();
  eq(Store.getSession(), null, 'сессии нет — null');
  eq(Store.setSession({ mode: 'srs', paths: ['cards/a.md'], i: 0, rated: 0, skipped: 0, startedAt: NOW }), true,
    'сессия записывается');
  eq(Store.getSession().paths.length, 1, 'сессия читается');
  eq(Store.getSession().mode, 'srs', 'режим сохраняется');
  Store.clearSession();
  eq(Store.getSession(), null, 'сессия очищается');
  eq(localStorageFake.getItem(Store.KEY_SESSION), null, 'сессия не попадает в localStorage');
  eq(sessionStorageFake.getItem(Store.KEY_SESSION), null, 'запись сессии удалена из sessionStorage');
});

group('сквозной сценарий: выгрузка → импорт', function () {
  resetStorages();
  Store.addRating('cards/a.md', 'ok');
  Store.setSrsCard('cards/a.md', Srs.review(null, 'ok', NOW));

  var env = Store.exportData();
  var parsed = Srs.parseEnvelope(env, NOW);
  eq(parsed.ok, true, 'своя копия проходит проверку');

  var merged = Srs.mergeProgress(Store.getAllProgress(), parsed.env.progress);
  eq(merged.added, 0, 'своя копия не добавляет ни одной оценки');

  var mergedSrs = Srs.mergeSrs(Store.getSrs(), parsed.env.srs);
  eq(mergedSrs.updated, 0, 'своя копия не меняет расписание');
  eq(mergedSrs.srs['cards/a.md'].ivl, 1, 'расписание из копии совпадает с текущим');
});

// --- итог ------------------------------------------------------------------

localStorageFake.broken = false;
Date.now = realDateNow;

if (failed === 0) {
  say('ПРОЙДЕНО: ' + passed + ' из ' + (passed + failed) + ' — провалов нет');
} else {
  say('ПРОЙДЕНО: ' + passed + ' из ' + (passed + failed) + ', провалено: ' + failed);
  failures.forEach(function (line) { say('  • ' + line); });
}
notes.forEach(function (line) { say('замечание: ' + line); });

function finish(code) {
  if (typeof process !== 'undefined' && process && process.exitCode !== undefined) {
    process.exitCode = code;
    return;
  }
  imports.system.exit(code);
}

finish(failed === 0 ? 0 : 1);
