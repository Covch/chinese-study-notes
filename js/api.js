// Клиент серверного API (docs/server-contract.md, раздел 6).
//
// Здесь нет DOM и нет побочных эффектов на загрузке страницы: чистые помощники
// (адреса, заголовки, разбор ошибок, валидация черновика карточки, данные для
// графика) вынесены отдельно и прогоняются в tools/test_js.js. Сетевые вызовы
// используют относительные пути `api/...`, поэтому сервер может раздавать сайт
// и API с одного origin.
(function (global) {
  'use strict';

  var API_PREFIX = 'api/';
  var HEALTH_TIMEOUT_MS = 2000;
  var APP_MARK = 'chinese-cards';

  var RATINGS = ['bad', 'ok', 'good'];
  var CARD_TYPES = ['hieroglyph', 'rule'];
  var CARD_SECTIONS = {
    hieroglyph: ['Иероглиф', 'Пиньинь', 'Перевод', 'Пример'],
    rule: ['Правило', 'Примеры']
  };
  var CARD_LIMITS = {
    sections: 20,
    title: 80,
    content: 10000,
    totalContent: 50000,
    level: 40
  };

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function trim(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  function toInt(value, fallback) {
    var n = typeof value === 'number' ? Math.floor(value) : parseInt(value, 10);
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function toArray(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function isFormDataLike(value) {
    return !!value && typeof value === 'object' &&
      typeof value.append === 'function' && typeof value.getAll === 'function';
  }

  // --- адреса и заголовки ---------------------------------------------------

  function isHealthPayload(payload) {
    return isObject(payload) && payload.app === APP_MARK;
  }

  function needsCsrf(method) {
    var m = String(method || 'GET').toUpperCase();
    return m === 'POST' || m === 'PATCH' || m === 'DELETE';
  }

  // Относительный адрес API. Ведущие слэши убираем: `api/health` — не `/api/health`,
  // иначе сайт, опубликованный не в корне, обращался бы не туда.
  function joinApi(path) {
    var p = String(path === null || path === undefined ? '' : path);
    p = p.replace(/^\/+/, '').replace(/^api\//, '');
    return API_PREFIX + p;
  }

  function buildQuery(params) {
    var parts = [];
    if (!isObject(params)) return '';
    for (var key in params) {
      if (!has(params, key)) continue;
      var value = params[key];
      if (value === null || value === undefined) continue;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    }
    return parts.join('&');
  }

  function commentsUrl(path) {
    return 'comments?' + buildQuery({ path: String(path === null || path === undefined ? '' : path) });
  }

  function buildRequestInit(method, url, options) {
    var m = String(method || 'GET').toUpperCase();
    var opts = options || {};
    var init = {
      method: m,
      // Cookie сессии не уходит на чужие origin.
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };

    if (needsCsrf(m)) init.headers['X-CL-CSRF'] = '1';

    if (isObject(opts.headers)) {
      for (var name in opts.headers) {
        if (has(opts.headers, name)) init.headers[name] = opts.headers[name];
      }
    }

    if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      init.headers['Content-Type'] = 'application/json';
    } else if (opts.body !== undefined && opts.body !== null) {
      if (isFormDataLike(opts.body)) {
        // Content-Type для multipart выставляет браузер: с boundary вручную нельзя.
        init.body = opts.body;
      } else if (typeof opts.body === 'string') {
        init.body = opts.body;
        if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'text/plain;charset=utf-8';
      } else {
        init.body = JSON.stringify(opts.body);
        init.headers['Content-Type'] = 'application/json';
      }
    }

    return { url: url, init: init };
  }

  // --- ошибки ---------------------------------------------------------------

  function statusMessage(status) {
    switch (Number(status)) {
      case 0: return 'сервер недоступен';
      case 400: return 'неверный запрос';
      case 401: return 'нужно войти заново';
      case 403: return 'доступ запрещён';
      case 404: return 'не найдено';
      case 409: return 'конфликт данных';
      case 413: return 'данные слишком большие';
      case 415: return 'неподдерживаемый формат';
      case 429: return 'слишком много попыток, подождите';
      case 500: return 'ошибка на сервере';
      default: return 'ошибка сервера' + (status ? ' (HTTP ' + status + ')' : '');
    }
  }

  // Текст ошибки от сервера: {"error":"..."}. HTML и прочий мусор не показываем.
  function serverErrorText(data) {
    if (isObject(data) && typeof data.error === 'string') {
      var text = trim(data.error);
      if (text) return text;
    }
    return '';
  }

  function errorMessage(status, data) {
    return serverErrorText(data) || statusMessage(status);
  }

  function makeError(status, message) {
    var error = new Error(message);
    error.name = 'ApiError';
    error.status = Number(status) || 0;
    error.api = true;
    return error;
  }

  function isApiError(error) {
    return !!(error && error.api);
  }

  function errorText(error) {
    if (!error) return 'неизвестная ошибка';
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
  }

  function parseBodyText(text, contentType) {
    if (text === null || text === undefined || text === '') return null;
    var type = String(contentType || '').toLowerCase();
    var source = String(text);
    var looksJson = type.indexOf('json') !== -1 || /^[\s]*[\[{]/.test(source);
    if (!looksJson) return { raw: source };
    try {
      return JSON.parse(source);
    } catch (e) {
      return { raw: source };
    }
  }

  function readResponseBody(response) {
    if (!response || response.status === 204) return Promise.resolve(null);
    var contentType = '';
    if (response.headers && typeof response.headers.get === 'function') {
      contentType = response.headers.get('content-type') || '';
    }
    if (typeof response.text === 'function') {
      return response.text().then(function (text) {
        return parseBodyText(text, contentType);
      });
    }
    if (typeof response.json === 'function') {
      return response.json().catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function withTimeout(promise, timeoutMs) {
    var ms = toInt(timeoutMs, 0);
    if (ms <= 0) return Promise.resolve(promise);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = global.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(makeError(0, 'сервер не ответил за ' + Math.round(ms / 1000) + ' с'));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        if (global.clearTimeout) global.clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true;
        if (global.clearTimeout) global.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function request(method, path, options) {
    var opts = options || {};
    var built = buildRequestInit(method, opts.url || joinApi(path), opts);

    if (typeof global.fetch !== 'function') {
      return Promise.reject(makeError(0, 'браузер не поддерживает сетевые запросы'));
    }

    var pending;
    try {
      pending = global.fetch(built.url, built.init);
    } catch (e) {
      return Promise.reject(makeError(0, 'не удалось отправить запрос'));
    }

    return withTimeout(pending, opts.timeoutMs).then(function (response) {
      if (!response || typeof response.status !== 'number') {
        throw makeError(0, 'сервер вернул неожиданный ответ');
      }
      return readResponseBody(response).then(function (data) {
        if (!response.ok) throw makeError(response.status, errorMessage(response.status, data));
        return data;
      });
    }).catch(function (error) {
      if (isApiError(error)) throw error;
      if (error && error.name === 'AbortError') throw makeError(0, 'сервер не ответил вовремя');
      throw makeError(0, 'нет связи с сервером');
    });
  }

  function get(path, options) { return request('GET', path, options); }
  function post(path, json, options) {
    var opts = options || {};
    opts.json = json;
    return request('POST', path, opts);
  }

  // --- health / детект режима ----------------------------------------------

  // GET api/health с таймаутом 2 с. true — это серверная версия, иначе fallback.
  function detect(options) {
    var opts = options || {};
    if (typeof global.fetch !== 'function') return Promise.resolve(false);
    var timeout = opts.timeoutMs === undefined ? HEALTH_TIMEOUT_MS : opts.timeoutMs;
    return request('GET', 'health', { timeoutMs: timeout }).then(function (data) {
      return isHealthPayload(data);
    }).catch(function () {
      return false;
    });
  }

  // --- методы API -----------------------------------------------------------

  function login(loginName, password) {
    return post('login', {
      login: String(loginName === null || loginName === undefined ? '' : loginName),
      password: String(password === null || password === undefined ? '' : password)
    });
  }

  function logout() { return request('POST', 'logout'); }
  function me() { return get('me'); }

  function updateName(name) {
    return request('PATCH', 'me', { json: { name: String(name === null || name === undefined ? '' : name) } });
  }

  function changePassword(current, next) {
    return post('me/password', {
      current: String(current === null || current === undefined ? '' : current),
      next: String(next === null || next === undefined ? '' : next)
    });
  }

  function getProgress() { return get('progress'); }
  function review(path, rating) {
    return post('review', { path: String(path || ''), rating: String(rating || '') });
  }
  function importData(mode, data) {
    return post('progress/import', { mode: mode === 'replace' ? 'replace' : 'merge', data: data });
  }
  function exportData() { return get('export'); }
  function resetSrs() { return post('progress/reset-srs'); }
  function getStats() { return get('stats'); }
  function getLeaderboard() { return get('leaderboard'); }
  function getComments(path) { return get(commentsUrl(path)); }

  function createCommentFormData(path, text, files, FormDataCtor) {
    var Ctor = FormDataCtor || (typeof global.FormData === 'function' ? global.FormData : null);
    if (!Ctor) throw makeError(0, 'браузер не поддерживает отправку файлов');

    var form = new Ctor();
    form.append('path', String(path === null || path === undefined ? '' : path));
    form.append('text', String(text === null || text === undefined ? '' : text));
    var list = toArray(files);
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      if (!file) continue;
      if (typeof file.name === 'string' && file.name) form.append('images', file, file.name);
      else form.append('images', file);
    }
    return form;
  }

  function addComment(path, text, files) {
    var form;
    try {
      form = createCommentFormData(path, text, files);
    } catch (error) {
      return Promise.reject(error);
    }
    return request('POST', 'comments', { body: form });
  }

  function deleteComment(id) {
    return request('DELETE', 'comments/' + encodeURIComponent(String(id === null || id === undefined ? '' : id)));
  }

  function createCard(payload) { return post('cards', payload); }

  // --- валидация черновика карточки ----------------------------------------

  function cardSectionTitles(type) {
    return CARD_SECTIONS[type] ? CARD_SECTIONS[type].slice() : [];
  }

  function isPositiveInteger(value) {
    if (typeof value === 'number') return isFinite(value) && Math.floor(value) === value && value > 0;
    var raw = String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
    if (!/^[0-9]+$/.test(raw)) return false;
    return parseInt(raw, 10) > 0;
  }

  // Черновик из формы: {type, lesson, level, sections:[{title, content}]}.
  // Возвращает {ok:true, payload} либо {ok:false, error}. Границы — из контракта.
  function validateCardDraft(draft) {
    if (!isObject(draft)) return { ok: false, error: 'Нет данных карточки.' };

    var type = String(draft.type === null || draft.type === undefined ? '' : draft.type);
    if (CARD_TYPES.indexOf(type) === -1) {
      return { ok: false, error: 'Тип карточки должен быть hieroglyph или rule.' };
    }

    if (!isPositiveInteger(draft.lesson)) {
      return { ok: false, error: 'Урок должен быть целым числом больше нуля.' };
    }
    var lesson = typeof draft.lesson === 'number' ? draft.lesson : parseInt(String(draft.lesson), 10);

    var level = trim(draft.level);
    if (!level) return { ok: false, error: 'Уровень не может быть пустым.' };
    if (level.length > CARD_LIMITS.level) {
      return { ok: false, error: 'Уровень длиннее ' + CARD_LIMITS.level + ' символов.' };
    }

    if (!Array.isArray(draft.sections)) return { ok: false, error: 'Нет секций карточки.' };
    if (draft.sections.length < 1) return { ok: false, error: 'Нужна хотя бы одна секция.' };
    if (draft.sections.length > CARD_LIMITS.sections) {
      return { ok: false, error: 'Секций не больше ' + CARD_LIMITS.sections + '.' };
    }

    var sections = [];
    var total = 0;
    for (var i = 0; i < draft.sections.length; i++) {
      var section = draft.sections[i];
      var number = i + 1;
      if (!isObject(section)) return { ok: false, error: 'Секция ' + number + ': нет данных.' };

      var title = trim(section.title);
      if (!title) return { ok: false, error: 'Секция ' + number + ': пустой заголовок.' };
      if (title.length > CARD_LIMITS.title) {
        return { ok: false, error: 'Секция ' + number + ': заголовок длиннее ' + CARD_LIMITS.title + ' символов.' };
      }

      if (typeof section.content !== 'string') {
        return { ok: false, error: 'Секция ' + number + ': содержимое должно быть текстом.' };
      }
      if (section.content.length > CARD_LIMITS.content) {
        return { ok: false, error: 'Секция «' + title + '»: текст длиннее ' + CARD_LIMITS.content + ' символов.' };
      }
      total += section.content.length;
      if (total > CARD_LIMITS.totalContent) {
        return { ok: false, error: 'Суммарный текст карточки длиннее ' + CARD_LIMITS.totalContent + ' символов.' };
      }

      sections.push({ title: title, content: section.content });
    }

    return { ok: true, payload: { type: type, lesson: lesson, level: level, sections: sections } };
  }

  // --- данные для бар-чарта статистики -------------------------------------

  // last30: [{date,bad,ok,good,total}] от старых к новым. Возвращает max и
  // процент высоты каждого столбца (0..100) — саму вёрстку строит app.js.
  function statsChartData(last30) {
    var list = Array.isArray(last30) ? last30 : [];
    var rows = [];
    var max = 0;

    for (var i = 0; i < list.length; i++) {
      var item = isObject(list[i]) ? list[i] : {};
      var bad = Math.max(0, toInt(item.bad, 0));
      var ok = Math.max(0, toInt(item.ok, 0));
      var good = Math.max(0, toInt(item.good, 0));
      var total = toInt(item.total, bad + ok + good);
      if (total < bad + ok + good) total = bad + ok + good;
      var row = {
        date: typeof item.date === 'string' ? item.date : '',
        bad: bad,
        ok: ok,
        good: good,
        total: total
      };
      if (total > max) max = total;
      rows.push(row);
    }

    var bars = rows.map(function (row) {
      return {
        date: row.date,
        bad: row.bad,
        ok: row.ok,
        good: row.good,
        total: row.total,
        percent: max > 0 ? Math.round((row.total / max) * 100) : 0
      };
    });

    return { max: max, bars: bars };
  }

  global.Api = {
    API_PREFIX: API_PREFIX,
    HEALTH_TIMEOUT_MS: HEALTH_TIMEOUT_MS,
    CARD_TYPES: CARD_TYPES,
    CARD_SECTIONS: CARD_SECTIONS,
    CARD_LIMITS: CARD_LIMITS,
    RATINGS: RATINGS,

    // чистые помощники — для тестов и app.js
    isHealthPayload: isHealthPayload,
    needsCsrf: needsCsrf,
    joinApi: joinApi,
    buildQuery: buildQuery,
    commentsUrl: commentsUrl,
    buildRequestInit: buildRequestInit,
    statusMessage: statusMessage,
    serverErrorText: serverErrorText,
    errorMessage: errorMessage,
    errorText: errorText,
    parseBodyText: parseBodyText,
    cardSectionTitles: cardSectionTitles,
    validateCardDraft: validateCardDraft,
    statsChartData: statsChartData,
    createCommentFormData: createCommentFormData,

    // сеть
    request: request,
    detect: detect,
    login: login,
    logout: logout,
    me: me,
    updateName: updateName,
    changePassword: changePassword,
    getProgress: getProgress,
    review: review,
    importData: importData,
    exportData: exportData,
    resetSrs: resetSrs,
    getStats: getStats,
    getLeaderboard: getLeaderboard,
    getComments: getComments,
    addComment: addComment,
    deleteComment: deleteComment,
    createCard: createCard
  };
})(window);
