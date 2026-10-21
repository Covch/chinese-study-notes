// Постраничный вывод: чистые функции без DOM.
(function (global) {
  'use strict';

  function pageCount(total, pageSize) {
    var size = Number(pageSize);
    if (!(size > 0)) return 0;
    var pages = Math.ceil(Number(total) / size);
    return pages > 0 ? pages : 0;
  }

  // Номер страницы в допустимых границах: 1 … pages.
  function clampPage(page, total, pageSize) {
    var pages = pageCount(total, pageSize);
    var value = Math.floor(Number(page));
    if (!isFinite(value) || value < 1) value = 1;
    if (pages > 0 && value > pages) value = pages;
    return value;
  }

  // Срез списка: {page, pages, start, end, items}; start/end — индексы для подписи.
  function slice(items, page, pageSize) {
    var list = items || [];
    var size = Number(pageSize);
    var pages = pageCount(list.length, size);
    var current = clampPage(page, list.length, size);

    if (pages === 0) {
      return { page: 1, pages: 0, start: 0, end: 0, items: [] };
    }

    var start = (current - 1) * size;
    var end = Math.min(start + size, list.length);
    return {
      page: current,
      pages: pages,
      start: start,
      end: end,
      items: list.slice(start, end)
    };
  }

  global.Pagination = {
    pageCount: pageCount,
    clampPage: clampPage,
    slice: slice
  };
})(window);
