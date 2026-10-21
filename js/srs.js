// Интервальное повторение (упрощённый SM-2) и чистые функции над данными прогресса.
//
// Здесь нет ни DOM, ни localStorage, и ни один вызов не смотрит на текущее время сам —
// `now` всегда приходит параметром. Поэтому модуль детерминирован и его целиком
// прогоняет tools/test_js.js. Подключается и как <script src> (window.Srs), и под Node
// (module.exports), если Node когда-нибудь появится в окружении.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Srs = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Оценки. Значения bad/ok/good — часть контракта хранилища, менять их нельзя
  // (в CARD_FORMAT.md они записаны), меняются только подписи в интерфейсе.
  var RATINGS = ['bad', 'ok', 'good'];
  // Оценка в терминах SM-2: 0..5. «Слабо помню» — это ещё успех (q=3), но EF растёт медленнее.
  var QUALITY = { bad: 2, ok: 3, good: 5 };
  var EF_START = 2.5;
  var EF_MIN = 1.3;
  var EF_MAX = 3.0; // косметический потолок: интервал и так ограничен MAX_IVL
  var FIRST_IVL = 1; // дней после первого успеха
  var SECOND_IVL = 6; // дней после второго успеха
  var MAX_IVL = 365; // дней
  var DAY = 86400; // СЕКУНД: везде в проекте unix-секунды (см. store.js)
  var MAX_REQUEUE = 2; // сколько раз «не помню» возвращает карточку в ту же сессию

  // Метка и версия файла резервной копии (см. CARD_FORMAT.md).
  var APP_MARK = 'chinese-cards';
  var ENVELOPE_VERSION = 1;

  var has = function (obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  };

  var isObject = function (value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  };

  // Терпимые к мусору преобразования: битое поле не должно ломать расписание.
  function toInt(value, fallback) {
    var n = typeof value === 'number' ? Math.floor(value) : parseInt(value, 10);
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function toFloat(value, fallback) {
    var n = typeof value === 'number' ? value : parseFloat(value);
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function newState() {
    return { n: 0, ef: EF_START, ivl: 0, due: 0, reps: 0, lapses: 0 };
  }

  // Чиним состояние по полям: числа в диапазонах, due — не дальше MAX_IVL вперёд
  // (иначе уехавшие часы или битый файл спрячут карточку навсегда).
  function normalizeState(raw, now) {
    var state = newState();
    if (!isObject(raw)) return state;

    state.n = Math.max(0, toInt(raw.n, 0));
    state.ef = clamp(toFloat(raw.ef, EF_START), EF_MIN, EF_MAX);
    state.ivl = clamp(toInt(raw.ivl, 0), 0, MAX_IVL);
    state.reps = Math.max(0, toInt(raw.reps, 0));
    state.lapses = Math.max(0, toInt(raw.lapses, 0));

    var due = Math.max(0, toInt(raw.due, 0));
    var nowSec = toInt(now, 0);
    if (nowSec > 0 && due > nowSec + MAX_IVL * DAY) due = nowSec + MAX_IVL * DAY;
    state.due = due;
    return state;
  }

  // Оценка карточки. Возвращает НОВОЕ состояние, вход не меняет.
  // «Не помню» (bad) возвращает карточку в текущую сессию, но пониженный EF сохраняется:
  // в этом смысл SM-2 — тяжёлая карточка и дальше растёт медленно.
  function review(state, rating, now) {
    var s = normalizeState(state, now);
    if (RATINGS.indexOf(rating) === -1) return s; // неизвестная оценка ничего не меняет

    var nowSec = toInt(now, 0);
    var q = QUALITY[rating];
    // Формула EF из SM-2: good +0.10, ok −0.14, bad −0.32.
    s.ef = clamp(s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)), EF_MIN, EF_MAX);
    s.reps += 1;

    if (rating === 'bad') {
      s.n = 0;
      s.ivl = 0;
      s.due = nowSec;
      s.lapses += 1;
      return s;
    }

    s.n += 1;
    if (s.n === 1) s.ivl = FIRST_IVL;
    else if (s.n === 2) s.ivl = SECOND_IVL;
    else s.ivl = Math.max(1, Math.round(s.ivl * s.ef)); // по уже обновлённому EF
    s.ivl = Math.min(s.ivl, MAX_IVL);
    s.due = nowSec + s.ivl * DAY;
    return s;
  }

  function dueOf(state) {
    return isObject(state) ? Math.max(0, toInt(state.due, 0)) : 0;
  }

  function isDue(state, now) {
    return dueOf(state) <= toInt(now, 0);
  }

  // Через сколько дней карточка понадобится: отрицательное число — просрочена.
  function daysUntil(state, now) {
    return Math.floor((dueOf(state) - toInt(now, 0)) / DAY);
  }

  // Очередь на повторение. Сначала просроченные (по возрастанию срока), затем новые
  // в порядке индекса. limit <= 0 или отсутствует — «все доступные».
  // nextDue — ближайший срок среди тех, что ещё не пора, для подсказки в UI.
  function buildQueue(cards, srsMap, opts) {
    opts = opts || {};
    var now = toInt(opts.now, 0);
    var match = opts.match;
    var map = isObject(srsMap) ? srsMap : {};
    var list = cards || [];
    var due = [];
    var fresh = [];
    var later = [];

    for (var i = 0; i < list.length; i++) {
      var card = list[i];
      if (!card || !card.path) continue;
      if (match && !match(card)) continue;

      var state = map[card.path];
      if (!isObject(state)) {
        fresh.push(card.path);
        continue;
      }
      var dueAt = dueOf(state);
      if (dueAt <= now) due.push({ path: card.path, due: dueAt, idx: i });
      else later.push(dueAt);
    }

    // Тайбрейк по индексу: sort стабилен только с ES2019, а очередь должна быть предсказуемой.
    due.sort(function (a, b) { return (a.due - b.due) || (a.idx - b.idx); });

    var paths = [];
    for (var j = 0; j < due.length; j++) paths.push(due[j].path);
    paths = paths.concat(fresh);

    var limit = toInt(opts.limit, 0);
    if (limit > 0 && paths.length > limit) paths = paths.slice(0, limit);

    var nextDue = null;
    for (var k = 0; k < later.length; k++) {
      if (nextDue === null || later[k] < nextDue) nextDue = later[k];
    }

    return {
      paths: paths,
      dueCount: due.length,
      newCount: fresh.length,
      laterCount: later.length,
      nextDue: nextDue
    };
  }

  // Текущая сессия повторения: очередь путей и позиция в ней. Живёт в sessionStorage,
  // поэтому нормализация терпит любой мусор.
  function normalizeSession(raw) {
    var session = { paths: [], i: 0, done: 0, requeued: {} };
    if (!isObject(raw)) return session;

    if (Array.isArray(raw.paths)) {
      session.paths = raw.paths.filter(function (path) {
        return typeof path === 'string' && path.length > 0;
      });
    }
    session.i = clamp(toInt(raw.i, 0), 0, session.paths.length);
    session.done = Math.max(0, toInt(raw.done, 0));
    if (isObject(raw.requeued)) {
      for (var path in raw.requeued) {
        if (has(raw.requeued, path)) {
          session.requeued[path] = Math.max(0, toInt(raw.requeued[path], 0));
        }
      }
    }
    return session;
  }

  function sessionLeft(session) {
    var s = normalizeSession(session);
    return Math.max(0, s.paths.length - s.i);
  }

  // Шаг сессии. rating — bad/ok/good, либо null для «Пропустить».
  // Возвращает НОВУЮ сессию: оценка увеличивает счётчик, «не помню» возвращает карточку
  // в конец очереди, но не больше maxRequeue раз. Нормализация не даёт расти очереди вечно.
  function stepSession(session, rating, maxRequeue) {
    var s = normalizeSession(session);
    if (s.i >= s.paths.length) return s;

    var path = s.paths[s.i];
    if (RATINGS.indexOf(rating) !== -1) {
      s.done += 1;
      if (rating === 'bad') {
        var requeues = s.requeued[path] || 0;
        var cap = Math.max(0, toInt(maxRequeue, MAX_REQUEUE));
        if (requeues < cap) {
          s.requeued[path] = requeues + 1;
          // Копия массива, чтобы не менять вход: функция должна быть чистой.
          s.paths = s.paths.concat([path]);
        }
      }
    }
    s.i += 1;
    return s;
  }

  // Считает повторы пар (ts, rating): counts[ts][rating] = сколько раз.
  function ratingCounts(list) {
    var counts = {};
    if (!Array.isArray(list)) return counts;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!isObject(rec) || RATINGS.indexOf(rec.rating) === -1) continue;
      var ts = toInt(rec.ts, 0);
      if (ts <= 0) continue;
      if (!counts[ts]) counts[ts] = {};
      counts[ts][rec.rating] = (counts[ts][rec.rating] || 0) + 1;
    }
    return counts;
  }

  function unionKeys(a, b) {
    var keys = [];
    var key;
    for (key in a) if (has(a, key)) keys.push(key);
    for (key in b) if (has(b, key) && keys.indexOf(key) === -1) keys.push(key);
    return keys;
  }

  // Слияние истории оценок. Одинаковые записи (один ts, одна оценка) не удваиваются:
  // берётся максимум кратности, поэтому повторный импорт того же файла — no-op.
  function mergeProgress(local, imported) {
    var a = isObject(local) ? local : {};
    var b = isObject(imported) ? imported : {};
    var progress = {};
    var added = 0;
    var ratingsTotal = 0;

    var paths = unionKeys(a, b);
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var ca = ratingCounts(a[path]);
      var cb = ratingCounts(b[path]);
      var stamps = unionKeys(ca, cb);
      var list = [];

      for (var j = 0; j < stamps.length; j++) {
        var ts = stamps[j];
        var byRating = {};
        var ratings = unionKeys(ca[ts] || {}, cb[ts] || {});
        for (var k = 0; k < ratings.length; k++) {
          var rating = ratings[k];
          byRating[rating] = true;
          var have = (ca[ts] && ca[ts][rating]) || 0;
          var want = Math.max(have, (cb[ts] && cb[ts][rating]) || 0);
          if (want > have) added += want - have;
          ratingsTotal += want;
          for (var n = 0; n < want; n++) list.push({ ts: toInt(ts, 0), rating: rating });
        }
      }

      list.sort(function (x, y) { return x.ts - y.ts; });
      progress[path] = list;
    }

    return { progress: progress, added: added, ratingsTotal: ratingsTotal };
  }

  // Расписания совпадают по всем полям. Нужно, чтобы повторный импорт того же файла
  // (в том числе собственной свежей копии) не отчитывался об обновлениях.
  function sameState(a, b) {
    return a.n === b.n && a.ef === b.ef && a.ivl === b.ivl &&
      a.due === b.due && a.reps === b.reps && a.lapses === b.lapses;
  }

  // Слияние расписания: побеждает запись с большим числом ответов, при равенстве —
  // с более поздним сроком (то есть «дальше продвинутая»).
  function mergeSrs(local, imported) {
    var a = isObject(local) ? local : {};
    var b = isObject(imported) ? imported : {};
    var srs = {};
    var updated = 0;

    var paths = unionKeys(a, b);
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var mine = a[path];
      var theirs = b[path];
      var pick;

      if (!isObject(mine)) pick = isObject(theirs) ? 'imported' : null;
      else if (!isObject(theirs)) pick = 'local';
      else if (toInt(theirs.reps, 0) > toInt(mine.reps, 0)) pick = 'imported';
      else if (toInt(mine.reps, 0) > toInt(theirs.reps, 0)) pick = 'local';
      else pick = (toInt(theirs.due, 0) >= toInt(mine.due, 0)) ? 'imported' : 'local';

      if (!pick) continue;
      var next = normalizeState(pick === 'imported' ? theirs : mine);
      if (pick === 'imported' && (!isObject(mine) || !sameState(normalizeState(mine), next))) updated += 1;
      srs[path] = next;
    }

    return { srs: srs, updated: updated };
  }

  // Разбор файла резервной копии. Фатально только чужой файл, слишком новая версия и
  // не-объект; битые отдельные записи отбрасываются со счётчиком skipped, а битые числа
  // в расписании чинятся, а не отбрасываются. Пути вне индекса сохраняются как есть.
  function parseEnvelope(raw, now) {
    if (!isObject(raw)) {
      return { ok: false, error: 'это не файл резервной копии' };
    }
    if (raw.app !== APP_MARK) {
      return { ok: false, error: 'это не файл резервной копии' };
    }
    if (toInt(raw.version, 0) > ENVELOPE_VERSION) {
      return { ok: false, error: 'файл новее, чем умеет сайт' };
    }

    var skipped = 0;
    var warnings = [];
    var progress = {};
    var srs = {};

    var rawProgress = raw.progress;
    if (rawProgress !== undefined && rawProgress !== null && !isObject(rawProgress)) {
      warnings.push('раздел progress пропущен: это не объект');
      rawProgress = null;
    }
    if (isObject(rawProgress)) {
      for (var path in rawProgress) {
        if (!has(rawProgress, path)) continue;
        var list = rawProgress[path];
        if (!Array.isArray(list)) { skipped += 1; continue; }
        var clean = [];
        for (var i = 0; i < list.length; i++) {
          var rec = list[i];
          if (!isObject(rec) || RATINGS.indexOf(rec.rating) === -1) { skipped += 1; continue; }
          var ts = toInt(rec.ts, 0);
          if (ts <= 0) { skipped += 1; continue; }
          clean.push({ ts: ts, rating: rec.rating });
        }
        if (clean.length > 0) progress[path] = clean;
      }
    }

    var rawSrs = raw.srs;
    if (rawSrs !== undefined && rawSrs !== null && !isObject(rawSrs)) {
      warnings.push('раздел srs пропущен: это не объект');
      rawSrs = null;
    }
    if (isObject(rawSrs)) {
      for (var srsPath in rawSrs) {
        if (has(rawSrs, srsPath) && isObject(rawSrs[srsPath])) {
          srs[srsPath] = normalizeState(rawSrs[srsPath], now);
        }
      }
    }

    var name = '';
    if (isObject(raw.user) && typeof raw.user.name === 'string') name = raw.user.name;

    return {
      ok: true,
      env: { user: { name: name }, progress: progress, srs: srs },
      skipped: skipped,
      warnings: warnings
    };
  }

  return {
    RATINGS: RATINGS,
    QUALITY: QUALITY,
    EF_START: EF_START,
    EF_MIN: EF_MIN,
    EF_MAX: EF_MAX,
    FIRST_IVL: FIRST_IVL,
    SECOND_IVL: SECOND_IVL,
    MAX_IVL: MAX_IVL,
    DAY: DAY,
    MAX_REQUEUE: MAX_REQUEUE,
    APP_MARK: APP_MARK,
    ENVELOPE_VERSION: ENVELOPE_VERSION,
    newState: newState,
    normalizeState: normalizeState,
    review: review,
    isDue: isDue,
    daysUntil: daysUntil,
    buildQueue: buildQueue,
    normalizeSession: normalizeSession,
    sessionLeft: sessionLeft,
    stepSession: stepSession,
    mergeProgress: mergeProgress,
    mergeSrs: mergeSrs,
    parseEnvelope: parseEnvelope
  };
});
