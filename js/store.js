// localStorage-хранилище. Ключи строго по контракту CARD_FORMAT.md.
// Прогресс, расписание повторений и имя — в localStorage; текущая сессия повторения —
// в sessionStorage (умирает вместе с вкладкой и в резервную копию не входит).
(function (global) {
  'use strict';

  var KEY_USER = 'cl:v1:user';         // {"name": "..."}
  var KEY_PROGRESS = 'cl:v1:progress'; // {"<path>": [{"ts": ..., "rating": ...}]}
  var KEY_SRS = 'cl:v1:srs';           // {"<path>": {"n":..,"ef":..,"ivl":..,"due":..,"reps":..,"lapses":..}}
  var KEY_SESSION = 'cl:v1:session';   // sessionStorage: {"mode":..,"paths":[..],"i":..}
  var PROBE_KEY = 'cl:probe';          // пробная запись для проверки доступности хранилища

  // Серверный режим: прогресс и расписание живут в памяти, источник правды — API.
  // Ни progress, ни имя в этом режиме в localStorage не пишутся.
  var server = {
    active: false,
    user: null,
    progress: {},
    srs: {}
  };

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function readJSONFrom(storage, key, fallback) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (e) {
      // Приватный режим / битые данные — работаем без хранилища.
      return fallback;
    }
  }

  function writeJSONTo(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeKey(storage, key) {
    try {
      storage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  function readJSON(key, fallback) {
    return readJSONFrom(global.localStorage, key, fallback);
  }

  function writeJSON(key, value) {
    return writeJSONTo(global.localStorage, key, value);
  }

  // Проверка доступности: приватный режим и запрет записи видны только на попытке записи.
  function isAvailable() {
    if (server.active) return true;
    try {
      global.localStorage.setItem(PROBE_KEY, '1');
      global.localStorage.removeItem(PROBE_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- серверный режим -----------------------------------------------------

  function sanitizeServerUser(user) {
    var raw = isPlainObject(user) ? user : {};
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      login: typeof raw.login === 'string' ? raw.login : '',
      name: typeof raw.name === 'string' ? raw.name : '',
      role: typeof raw.role === 'string' ? raw.role : ''
    };
  }

  // Прогресс с сервера: терпим мусор так же, как parseEnvelope в srs.js.
  function normalizeServerProgress(raw) {
    var result = {};
    if (!isPlainObject(raw)) return result;
    for (var path in raw) {
      if (!has(raw, path) || !Array.isArray(raw[path])) continue;
      var list = [];
      for (var i = 0; i < raw[path].length; i++) {
        var record = raw[path][i];
        if (!isPlainObject(record)) continue;
        if (global.Srs.RATINGS.indexOf(record.rating) === -1) continue;
        var ts = typeof record.ts === 'number' ? Math.floor(record.ts) : parseInt(record.ts, 10);
        if (!isFinite(ts) || ts <= 0) continue;
        list.push({ ts: ts, rating: record.rating });
      }
      if (list.length > 0) result[path] = list;
    }
    return result;
  }

  function normalizeServerSrs(raw, now) {
    var result = {};
    if (!isPlainObject(raw)) return result;
    for (var path in raw) {
      if (has(raw, path) && isPlainObject(raw[path])) {
        result[path] = global.Srs.normalizeState(raw[path], now);
      }
    }
    return result;
  }

  function cloneProgress(map) {
    var result = {};
    for (var path in map) {
      if (!has(map, path) || !Array.isArray(map[path])) continue;
      result[path] = map[path].map(function (record) {
        return { ts: record.ts, rating: record.rating };
      });
    }
    return result;
  }

  // Подключение к серверу: data = ответ GET /api/progress {progress, srs}.
  function attachServer(user, data) {
    var payload = isPlainObject(data) ? data : {};
    server.active = true;
    server.user = sanitizeServerUser(user);
    server.progress = normalizeServerProgress(payload.progress);
    server.srs = normalizeServerSrs(payload.srs, nowSec());
    return server.user;
  }

  function isServer() {
    return server.active === true;
  }

  function serverUser() {
    return server.user ? sanitizeServerUser(server.user) : null;
  }

  // Замена кэша после GET /api/progress (импорт, сброс расписания).
  function replaceServerData(data) {
    if (!server.active) return false;
    var payload = isPlainObject(data) ? data : {};
    server.progress = normalizeServerProgress(payload.progress);
    server.srs = normalizeServerSrs(payload.srs, nowSec());
    return true;
  }

  function detach() {
    server.active = false;
    server.user = null;
    server.progress = {};
    server.srs = {};
  }

  // Ответ POST /api/review: record = {path, ts, rating} (path добавляет app.js),
  // srs — новое состояние этой карточки. Возвращает обновлённую историю пути.
  function applyServerReview(record, srsState) {
    if (!server.active) return null;
    var raw = isPlainObject(record) ? record : {};
    var rating = raw.rating;
    var ts = raw.ts;

    // Допускаем и вложенную форму ответа: {path, rating:{ts,rating}}.
    if (isPlainObject(rating)) {
      ts = rating.ts;
      rating = rating.rating;
    }

    var path = typeof raw.path === 'string' ? raw.path : '';
    if (!path) return null;
    if (global.Srs.RATINGS.indexOf(rating) === -1) return null;

    var stamp = typeof ts === 'number' ? Math.floor(ts) : parseInt(ts, 10);
    if (!isFinite(stamp) || stamp <= 0) stamp = nowSec();

    var list = (server.progress[path] || []).concat([{ ts: stamp, rating: rating }]);
    server.progress[path] = list;

    if (isPlainObject(srsState)) {
      // Сервер отдаёт состояние одной карточки; на всякий случай принимаем и карту.
      var hasStateFields = has(srsState, 'n') || has(srsState, 'ef') || has(srsState, 'ivl') ||
        has(srsState, 'due') || has(srsState, 'reps') || has(srsState, 'lapses');
      if (hasStateFields) {
        server.srs[path] = global.Srs.normalizeState(srsState, nowSec());
      } else if (Object.keys(srsState).length > 0) {
        server.srs = normalizeServerSrs(srsState, nowSec());
      }
    }

    return list;
  }

  // Снимок старого localStorage-прогресса независимо от текущего режима:
  // нужен, чтобы предложить перенос данных на сервер, ничего не потеряв.
  function readLocalName() {
    var user = readJSON(KEY_USER, {});
    return typeof user.name === 'string' ? user.name : '';
  }

  function readLocalProgress() {
    return normalizeServerProgress(readJSON(KEY_PROGRESS, {}));
  }

  function readLocalSrs() {
    return normalizeServerSrs(readJSON(KEY_SRS, {}), nowSec());
  }

  function localSnapshot() {
    return {
      app: global.Srs.APP_MARK,
      version: global.Srs.ENVELOPE_VERSION,
      exportedAt: nowSec(),
      user: { name: readLocalName() },
      progress: readLocalProgress(),
      srs: readLocalSrs()
    };
  }

  // --- чтение и запись (в серверном режиме — кэш в памяти) -----------------

  function getUserName() {
    if (server.active) return server.user && typeof server.user.name === 'string' ? server.user.name : '';
    var user = readJSON(KEY_USER, {});
    return typeof user.name === 'string' ? user.name : '';
  }

  function setUserName(name) {
    if (server.active) {
      if (server.user) server.user.name = String(name || '');
      return;
    }
    writeJSON(KEY_USER, { name: String(name || '') });
  }

  function getAllProgress() {
    if (server.active) return cloneProgress(server.progress);
    var progress = readJSON(KEY_PROGRESS, {});
    var result = {};
    for (var path in progress) {
      if (has(progress, path) && Array.isArray(progress[path])) {
        result[path] = progress[path];
      }
    }
    return result;
  }

  function getRatings(path) {
    var progress = getAllProgress();
    return progress[path] || [];
  }

  // Дописывает оценку в конец массива. rating: bad | ok | good.
  // В серверном режиме пишем только в кэш: источник правды — POST /api/review.
  function addRating(path, rating) {
    var record = { ts: nowSec(), rating: rating };
    if (server.active) {
      var cached = (server.progress[path] || []).concat([record]);
      server.progress[path] = cached;
      return cached.map(function (item) { return { ts: item.ts, rating: item.rating }; });
    }
    var progress = getAllProgress();
    var list = progress[path] || [];
    list.push(record);
    progress[path] = list;
    writeJSON(KEY_PROGRESS, progress);
    return list;
  }

  // Расписание повторений: мусор в хранилище чинится, а не роняет сайт.
  function getAllSrs() {
    if (server.active) {
      var cached = {};
      var nowCached = nowSec();
      for (var cachedPath in server.srs) {
        if (has(server.srs, cachedPath) && isPlainObject(server.srs[cachedPath])) {
          cached[cachedPath] = global.Srs.normalizeState(server.srs[cachedPath], nowCached);
        }
      }
      return cached;
    }
    var raw = readJSON(KEY_SRS, {});
    var now = nowSec();
    var result = {};
    for (var path in raw) {
      if (has(raw, path) && isPlainObject(raw[path])) {
        result[path] = global.Srs.normalizeState(raw[path], now);
      }
    }
    return result;
  }

  function getSrsCard(path) {
    var all = getAllSrs();
    return has(all, path) ? all[path] : null;
  }

  function setSrsCard(path, state) {
    if (server.active) {
      server.srs[path] = global.Srs.normalizeState(state, nowSec());
      return true;
    }
    var all = getAllSrs();
    all[path] = global.Srs.normalizeState(state, nowSec());
    return writeJSON(KEY_SRS, all);
  }

  function resetSrs() {
    if (server.active) {
      server.srs = {};
      return true;
    }
    return removeKey(global.localStorage, KEY_SRS);
  }

  function getSession() {
    var session = readJSONFrom(global.sessionStorage, KEY_SESSION, null);
    if (!isPlainObject(session) || !Array.isArray(session.paths) || typeof session.mode !== 'string') {
      return null;
    }
    return session;
  }

  function setSession(session) {
    return writeJSONTo(global.sessionStorage, KEY_SESSION, session);
  }

  function clearSession() {
    removeKey(global.sessionStorage, KEY_SESSION);
  }

  function countRatings(progress) {
    var total = 0;
    for (var path in progress) {
      if (has(progress, path) && Array.isArray(progress[path])) total += progress[path].length;
    }
    return total;
  }

  // Записи о карточках, которых нет в индексе: их не удаляем (устаревший индекс или
  // другая ветка уничтожили бы историю), но показываем счётчиком на экране «Данные».
  function countOrphans(progress, srs, knownPaths) {
    if (!Array.isArray(knownPaths)) return 0;
    var known = {};
    for (var i = 0; i < knownPaths.length; i++) known[knownPaths[i]] = true;

    var seen = {};
    var count = 0;
    [progress, srs].forEach(function (map) {
      for (var path in map) {
        if (!has(map, path) || known[path] || seen[path]) continue;
        seen[path] = true;
        count += 1;
      }
    });
    return count;
  }

  function nameNote(currentName, nextName) {
    if (!nextName) return 'имени нет';
    if (nextName === currentName) return 'оставлено текущее имя';
    return 'имя применено: ' + nextName;
  }

  // Файл резервной копии: имя, история оценок и расписание.
  function exportData() {
    return {
      app: global.Srs.APP_MARK,
      version: global.Srs.ENVELOPE_VERSION,
      exportedAt: nowSec(),
      user: { name: getUserName() },
      progress: getAllProgress(),
      srs: getAllSrs()
    };
  }

  // Импорт копии. mode: merge (по умолчанию, ничего не теряет) | replace.
  // knownPaths — пути карточек из индекса, нужны только для счётчика «вне индекса».
  function importData(rawEnvelope, mode, knownPaths) {
    var parsed = global.Srs.parseEnvelope(rawEnvelope, nowSec());
    if (!parsed.ok) return { ok: false, error: parsed.error };

    var current = { progress: getAllProgress(), srs: getAllSrs(), name: getUserName() };
    var progress;
    var srs;
    var added = 0;
    var updated = 0;

    if (mode === 'replace') {
      progress = parsed.env.progress;
      srs = parsed.env.srs;
      added = countRatings(progress);
      updated = Object.keys(srs).length;
    } else {
      var mergedProgress = global.Srs.mergeProgress(current.progress, parsed.env.progress);
      var mergedSrs = global.Srs.mergeSrs(current.srs, parsed.env.srs);
      progress = mergedProgress.progress;
      srs = mergedSrs.srs;
      added = mergedProgress.added;
      updated = mergedSrs.updated;
    }

    // Имя из файла применяется только к пустому текущему: непустое не перезаписываем.
    var nextName = current.name || parsed.env.user.name || '';

    // В серверном режиме импорт меняет только кэш в памяти; на сервер его
    // отправляет app.js через POST /api/progress/import.
    if (server.active) {
      server.progress = progress;
      server.srs = srs;
      if (!current.name && nextName && server.user) server.user.name = nextName;
      return {
        ok: true,
        summary: {
          ratingsAdded: added,
          ratingsTotal: countRatings(progress),
          srsUpdated: updated,
          srsTotal: Object.keys(srs).length,
          orphanPaths: countOrphans(progress, srs, knownPaths),
          skipped: parsed.skipped,
          warnings: parsed.warnings,
          nameNote: nameNote(current.name, nextName)
        }
      };
    }

    var wroteProgress = writeJSON(KEY_PROGRESS, progress);
    var wroteSrs = writeJSON(KEY_SRS, srs);
    var wroteName = (nextName === current.name) ? true : writeJSON(KEY_USER, { name: nextName });

    if (!wroteProgress || !wroteSrs || !wroteName) {
      return { ok: false, error: 'браузер блокирует localStorage: данные не сохранены' };
    }

    return {
      ok: true,
      summary: {
        ratingsAdded: added,
        ratingsTotal: countRatings(progress),
        srsUpdated: updated,
        srsTotal: Object.keys(srs).length,
        orphanPaths: countOrphans(progress, srs, knownPaths),
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        nameNote: nameNote(current.name, nextName)
      }
    };
  }

  global.Store = {
    KEY_USER: KEY_USER,
    KEY_PROGRESS: KEY_PROGRESS,
    KEY_SRS: KEY_SRS,
    KEY_SESSION: KEY_SESSION,
    getUserName: getUserName,
    setUserName: setUserName,
    getAllProgress: getAllProgress,
    getRatings: getRatings,
    addRating: addRating,
    isAvailable: isAvailable,
    getSrs: getAllSrs,
    getSrsCard: getSrsCard,
    setSrsCard: setSrsCard,
    resetSrs: resetSrs,
    getSession: getSession,
    setSession: setSession,
    clearSession: clearSession,
    exportData: exportData,
    importData: importData,

    // серверный режим
    attachServer: attachServer,
    isServer: isServer,
    serverUser: serverUser,
    applyServerReview: applyServerReview,
    replaceServerData: replaceServerData,
    detach: detach,
    localSnapshot: localSnapshot,
    normalizeServerProgress: normalizeServerProgress,
    normalizeServerSrs: normalizeServerSrs
  };
})(window);
