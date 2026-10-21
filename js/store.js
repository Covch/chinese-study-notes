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
    try {
      global.localStorage.setItem(PROBE_KEY, '1');
      global.localStorage.removeItem(PROBE_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getUserName() {
    var user = readJSON(KEY_USER, {});
    return typeof user.name === 'string' ? user.name : '';
  }

  function setUserName(name) {
    writeJSON(KEY_USER, { name: String(name || '') });
  }

  function getAllProgress() {
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
  function addRating(path, rating) {
    var progress = getAllProgress();
    var list = progress[path] || [];
    list.push({ ts: nowSec(), rating: rating });
    progress[path] = list;
    writeJSON(KEY_PROGRESS, progress);
    return list;
  }

  // Расписание повторений: мусор в хранилище чинится, а не роняет сайт.
  function getAllSrs() {
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
    var all = getAllSrs();
    all[path] = global.Srs.normalizeState(state, nowSec());
    return writeJSON(KEY_SRS, all);
  }

  function resetSrs() {
    removeKey(global.localStorage, KEY_SRS);
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
    importData: importData
  };
})(window);
