// localStorage-хранилище. Ключи строго по контракту CARD_FORMAT.md.
(function (global) {
  'use strict';

  var KEY_USER = 'cl:v1:user';         // {"name": "..."}
  var KEY_PROGRESS = 'cl:v1:progress'; // {"<path>": [{"ts": ..., "rating": ...}]}

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (e) {
      // Приватный режим / битые данные — работаем без хранилища.
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
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
      if (Object.prototype.hasOwnProperty.call(progress, path) && Array.isArray(progress[path])) {
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
    list.push({ ts: Math.floor(Date.now() / 1000), rating: rating });
    progress[path] = list;
    writeJSON(KEY_PROGRESS, progress);
    return list;
  }

  global.Store = {
    KEY_USER: KEY_USER,
    KEY_PROGRESS: KEY_PROGRESS,
    getUserName: getUserName,
    setUserName: setUserName,
    getRatings: getRatings,
    addRating: addRating
  };
})(window);
