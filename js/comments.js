// Комментарии к карточкам: список, форма с картинками, удаление.
//
// Пользовательский текст выводится только через textContent: innerHTML из чужих
// данных здесь не используется. Чистые проверки (текст, файлы) вынесены в
// tools/test_js.js; DOM-часть проверяет человек в браузере.
(function (global) {
  'use strict';

  var MAX_IMAGES = 4;
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  var MAX_TEXT = 4000;
  var ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var ALLOWED_IMAGE_LABEL = 'JPEG, PNG, WebP или GIF';

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function trim(value) {
    return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
  }

  function toArray(list) {
    var out = [];
    if (!list) return out;
    for (var i = 0; i < list.length; i++) {
      if (list[i]) out.push(list[i]);
    }
    return out;
  }

  function toInt(value, fallback) {
    var n = typeof value === 'number' ? Math.floor(value) : parseInt(value, 10);
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function fileName(file) {
    return (file && typeof file.name === 'string' && file.name) ? file.name : 'файл';
  }

  // --- чистые проверки ------------------------------------------------------

  // Текст 1..4000 символов после trim; переносы строк внутри сохраняются.
  function validateCommentText(text) {
    var raw = (text === null || text === undefined) ? '' : String(text);
    var trimmed = raw.replace(/^\s+|\s+$/g, '');
    if (!trimmed) return { ok: false, error: 'Введите текст комментария.' };
    if (trimmed.length > MAX_TEXT) {
      return { ok: false, error: 'Комментарий длиннее ' + MAX_TEXT + ' символов.' };
    }
    return { ok: true, text: trimmed };
  }

  // files — массив или FileList. Ограничения: 4 файла, по 8 МБ, только картинки
  // разрешённых типов. Сервер всё равно перепроверяет MIME по содержимому.
  function validateFiles(files, limits) {
    var opts = limits || {};
    var maxCount = toInt(opts.maxCount, MAX_IMAGES);
    var maxBytes = toInt(opts.maxBytes, MAX_IMAGE_BYTES);
    var allowed = Array.isArray(opts.types) ? opts.types : ALLOWED_IMAGE_TYPES;
    var list = toArray(files);

    if (list.length > maxCount) {
      return { ok: false, error: 'Можно приложить не больше ' + maxCount + ' картинок.' };
    }

    var totalSize = 0;
    for (var i = 0; i < list.length; i++) {
      var file = list[i];
      var name = fileName(file);
      var type = String(file.type || '').toLowerCase();
      if (allowed.indexOf(type) === -1) {
        return { ok: false, error: 'Файл «' + name + '»: поддерживаются ' + ALLOWED_IMAGE_LABEL + '.' };
      }
      var size = Number(file.size);
      if (!isFinite(size) || size <= 0) {
        return { ok: false, error: 'Файл «' + name + '» пустой или повреждён.' };
      }
      if (size > maxBytes) {
        return {
          ok: false,
          error: 'Файл «' + name + '» больше ' + Math.round(maxBytes / (1024 * 1024)) + ' МБ.'
        };
      }
      totalSize += size;
    }

    return { ok: true, files: list, totalSize: totalSize };
  }

  function imageSrc(image) {
    if (!isObject(image)) return '';
    if (typeof image.url === 'string' && image.url) return image.url;
    // Запасной вариант: сервер отдаёт url, но если его нет — собираем из file.
    if (typeof image.file === 'string' && image.file) return 'media/' + encodeURIComponent(image.file);
    return '';
  }

  function canDeleteComment(comment, userId) {
    if (!isObject(comment)) return false;
    if (comment.canDelete === false) return false;
    if (comment.canDelete === true) return true;
    return !!(userId && typeof comment.userId === 'string' && comment.userId === userId);
  }

  function formatCommentDate(ts) {
    var date = new Date(Number(ts) * 1000);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString('ru-RU');
    } catch (e) {
      return '';
    }
  }

  function formatSize(bytes) {
    var size = Number(bytes);
    if (!isFinite(size) || size <= 0) return '';
    if (size < 1024) return size + ' Б';
    if (size < 1024 * 1024) return Math.round(size / 1024) + ' КБ';
    return (Math.round(size / (1024 * 1024) * 10) / 10) + ' МБ';
  }

  // --- DOM ------------------------------------------------------------------

  function makeEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (node) node.textContent = '';
  }

  function renderImages(comment) {
    var images = Array.isArray(comment.images) ? comment.images : [];
    if (images.length === 0) return null;

    var grid = makeEl('div', 'comment-images');
    images.forEach(function (image) {
      var src = imageSrc(image);
      if (!src) return;
      var link = makeEl('a', 'comment-image-link');
      link.href = src;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      var img = document.createElement('img');
      img.className = 'comment-image';
      img.src = src;
      img.alt = (image && typeof image.name === 'string' && image.name) ? image.name : 'картинка к комментарию';
      img.loading = 'lazy';
      link.appendChild(img);
      grid.appendChild(link);
    });
    return grid.childNodes.length > 0 ? grid : null;
  }

  function renderComment(comment, options) {
    var opts = options || {};
    var item = isObject(comment) ? comment : {};

    var article = makeEl('article', 'comment');
    if (item.id) article.setAttribute('data-comment-id', String(item.id));

    var head = makeEl('div', 'comment-head');
    head.appendChild(makeEl('span', 'comment-author', item.authorName || 'Без имени'));
    var date = formatCommentDate(item.createdAt);
    if (date) head.appendChild(makeEl('span', 'comment-date', date));
    article.appendChild(head);

    article.appendChild(makeEl('p', 'comment-text', item.text || ''));

    var images = renderImages(item);
    if (images) article.appendChild(images);

    if (opts.canDelete) {
      var button = makeEl('button', 'btn btn-ghost comment-delete', 'Удалить');
      button.type = 'button';
      button.addEventListener('click', function () {
        button.disabled = true;
        opts.onDelete(item.id, button);
      });
      article.appendChild(button);
    }

    return article;
  }

  function renderList(listEl, comments, options) {
    if (!listEl) return;
    clear(listEl);
    var list = Array.isArray(comments) ? comments : [];
    if (list.length === 0) {
      listEl.appendChild(makeEl('p', 'comment-empty', 'Комментариев пока нет.'));
      return;
    }
    list.forEach(function (comment) {
      listEl.appendChild(renderComment(comment, options));
    });
  }

  function revokePreviewUrls(previewEl) {
    if (!previewEl) return;
    var urls = previewEl._objectUrls;
    if (Array.isArray(urls) && global.URL && typeof global.URL.revokeObjectURL === 'function') {
      urls.forEach(function (url) {
        try { global.URL.revokeObjectURL(url); } catch (e) { /* уже отозван */ }
      });
    }
    previewEl._objectUrls = [];
  }

  function renderPreview(previewEl, files) {
    if (!previewEl) return;
    revokePreviewUrls(previewEl);
    clear(previewEl);

    var list = toArray(files);
    var urls = [];
    list.forEach(function (file) {
      var figure = makeEl('figure', 'comment-preview-item');
      var img = document.createElement('img');
      img.className = 'comment-preview-image';
      img.alt = fileName(file);
      if (global.URL && typeof global.URL.createObjectURL === 'function') {
        var url = global.URL.createObjectURL(file);
        img.src = url;
        urls.push(url);
      }
      figure.appendChild(img);

      var caption = makeEl('figcaption', 'comment-preview-name', fileName(file));
      var size = formatSize(file.size);
      if (size) caption.textContent = fileName(file) + ' · ' + size;
      figure.appendChild(caption);
      previewEl.appendChild(figure);
    });
    previewEl._objectUrls = urls;
  }

  // --- контроллер блока комментариев ---------------------------------------

  // opts: {listEl, statusEl, errorEl, formEl, textEl, filesEl, previewEl,
  //        submitEl, getUser, loadComments(path), addComment(path,text,files),
  //        deleteComment(id), onCount(n)}
  function createController(options) {
    var opts = options || {};
    var currentPath = null;
    var items = [];
    var loadToken = 0;
    var submitting = false;
    var userProvider = typeof opts.getUser === 'function' ? opts.getUser : function () { return null; };

    function setStatus(text) {
      if (opts.statusEl) opts.statusEl.textContent = text || '';
    }

    function showError(message) {
      if (!opts.errorEl) return;
      opts.errorEl.textContent = message || '';
      opts.errorEl.classList.toggle('hidden', !message);
    }

    function currentUser() {
      try { return userProvider() || null; } catch (e) { return null; }
    }

    function canDelete(comment) {
      var user = currentUser();
      return canDeleteComment(comment, user && user.id ? user.id : '');
    }

    function onDelete(id, button) {
      var ask = global.confirm ? global.confirm('Удалить комментарий?') : true;
      if (!ask) {
        if (button) button.disabled = false;
        return;
      }
      Promise.resolve(opts.deleteComment ? opts.deleteComment(id) : null).then(function () {
        return reload();
      }).catch(function (error) {
        if (button) button.disabled = false;
        showError('Не удалось удалить комментарий: ' + errorText(error));
      });
    }

    function render() {
      renderList(opts.listEl, items, { canDelete: canDelete, onDelete: onDelete });
      if (opts.onCount) opts.onCount(items.length);
    }

    function resetForm() {
      if (opts.textEl) opts.textEl.value = '';
      if (opts.filesEl) opts.filesEl.value = '';
      renderPreview(opts.previewEl, []);
    }

    function load(path) {
      currentPath = path || null;
      var token = ++loadToken;
      showError('');
      setStatus('Загружаем комментарии…');
      if (!currentPath || typeof opts.loadComments !== 'function') {
        items = [];
        render();
        setStatus('');
        return Promise.resolve([]);
      }
      return Promise.resolve(opts.loadComments(currentPath)).then(function (data) {
        if (token !== loadToken) return items;
        items = (data && Array.isArray(data.comments)) ? data.comments : [];
        render();
        setStatus(items.length === 0 ? 'Комментариев пока нет.' : '');
        return items;
      }).catch(function (error) {
        if (token !== loadToken) return items;
        items = [];
        render();
        setStatus('');
        showError('Не удалось загрузить комментарии: ' + errorText(error));
        return items;
      });
    }

    function reload() {
      return load(currentPath);
    }

    function reset() {
      currentPath = null;
      items = [];
      loadToken += 1;
      showError('');
      setStatus('');
      clear(opts.listEl);
      resetForm();
      if (opts.onCount) opts.onCount(0);
    }

    function submit() {
      if (submitting) return Promise.resolve(false);
      if (!currentPath) {
        showError('Сначала откройте карточку.');
        return Promise.resolve(false);
      }

      var textCheck = validateCommentText(opts.textEl ? opts.textEl.value : '');
      if (!textCheck.ok) {
        showError(textCheck.error);
        return Promise.resolve(false);
      }

      var files = opts.filesEl ? opts.filesEl.files : [];
      var fileCheck = validateFiles(files);
      if (!fileCheck.ok) {
        showError(fileCheck.error);
        return Promise.resolve(false);
      }

      submitting = true;
      showError('');
      setStatus('Отправляем…');
      if (opts.submitEl) opts.submitEl.disabled = true;

      return Promise.resolve(opts.addComment(currentPath, textCheck.text, fileCheck.files)).then(function () {
        resetForm();
        return reload();
      }).then(function () {
        setStatus('Комментарий добавлен.');
        return true;
      }).catch(function (error) {
        setStatus('');
        showError('Не удалось отправить комментарий: ' + errorText(error));
        return false;
      }).then(function (result) {
        submitting = false;
        if (opts.submitEl) opts.submitEl.disabled = false;
        return result;
      });
    }

    function onFilesChanged() {
      var files = opts.filesEl ? opts.filesEl.files : [];
      var check = validateFiles(files);
      if (!check.ok) {
        showError(check.error);
        renderPreview(opts.previewEl, []);
        return;
      }
      showError('');
      renderPreview(opts.previewEl, check.files);
    }

    if (opts.formEl) {
      opts.formEl.addEventListener('submit', function (event) {
        event.preventDefault();
        submit();
      });
    }
    if (opts.filesEl) opts.filesEl.addEventListener('change', onFilesChanged);

    return {
      load: load,
      reload: reload,
      reset: reset,
      submit: submit,
      isBusy: function () { return submitting; }
    };
  }

  function errorText(error) {
    if (!error) return 'неизвестная ошибка';
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
  }

  global.Comments = {
    MAX_IMAGES: MAX_IMAGES,
    MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
    MAX_TEXT: MAX_TEXT,
    ALLOWED_IMAGE_TYPES: ALLOWED_IMAGE_TYPES,
    validateCommentText: validateCommentText,
    validateFiles: validateFiles,
    imageSrc: imageSrc,
    canDeleteComment: canDeleteComment,
    formatCommentDate: formatCommentDate,
    formatSize: formatSize,
    renderList: renderList,
    renderComment: renderComment,
    renderPreview: renderPreview,
    createController: createController
  };
})(window);
