// Мини-парсер карточек: frontmatter + секции "## Заголовок". Без библиотек.
(function (global) {
  'use strict';

  // Снимаем обрамляющие кавычки: "текст" или 'текст'.
  function stripQuotes(value) {
    var v = value.trim();
    if (v.length >= 2) {
      var first = v.charAt(0);
      var last = v.charAt(v.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return v.slice(1, -1);
      }
    }
    return v;
  }

  // Frontmatter между --- в начале файла. Возвращает {meta, body}.
  function splitFrontmatter(text) {
    var meta = {};
    var normalized = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    var lines = normalized.split('\n');

    if (lines.length === 0 || lines[0].trim() !== '---') {
      return { meta: meta, body: normalized };
    }

    var end = -1;
    for (var i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
    }
    if (end === -1) {
      // Незакрытый frontmatter — считаем, что его нет.
      return { meta: meta, body: normalized };
    }

    for (var j = 1; j < end; j++) {
      var line = lines[j];
      var idx = line.indexOf(':');
      if (idx === -1) continue;
      var key = line.slice(0, idx).trim();
      if (!key) continue;
      meta[key] = stripQuotes(line.slice(idx + 1));
    }

    return { meta: meta, body: lines.slice(end + 1).join('\n') };
  }

  // Тело: преамбула + секции. Секция = {title, content}.
  function splitSections(body) {
    var lines = body.split('\n');
    var preambleLines = [];
    var sections = [];
    var current = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var match = /^##\s+(.*)$/.exec(line);
      if (match) {
        current = { title: match[1].trim(), content: [] };
        sections.push(current);
      } else if (current) {
        current.content.push(line);
      } else {
        preambleLines.push(line);
      }
    }

    for (var k = 0; k < sections.length; k++) {
      var content = sections[k].content.join('\n');
      sections[k].content = trimBlankLines(content);
      sections[k].empty = sections[k].content.length === 0;
    }

    return { preamble: trimBlankLines(preambleLines.join('\n')), sections: sections };
  }

  function trimBlankLines(text) {
    return text.replace(/^\n+/, '').replace(/\s+$/, '');
  }

  // Полный разбор файла карточки. Битый вход не бросает исключение.
  function parseCard(text) {
    var parts = splitFrontmatter(String(text || ''));
    var body = splitSections(parts.body);
    var meta = parts.meta;

    var lesson = parseInt(meta.lesson, 10);
    if (isNaN(lesson)) lesson = null;

    return {
      meta: {
        title: meta.title || '',
        type: meta.type || '',
        lesson: lesson,
        level: meta.level || ''
      },
      preamble: body.preamble,
      sections: body.sections
    };
  }

  global.MdParser = {
    parseCard: parseCard
  };
})(window);
