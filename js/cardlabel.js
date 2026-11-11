// Подпись карточки. Названия в карточках не хранятся: указание на содержимое
// подсказывало бы ответ при повторении. Подпись — тип плюс порядковый номер
// внутри типа по порядку cards/index.json.
(function (global) {
  'use strict';

  var TYPE_LABELS = { hieroglyph: 'иероглиф', rule: 'правило' };

  function typeLabel(type) {
    return TYPE_LABELS[type] || type || 'карточка';
  }

  // Копия карточек с полем number: сквозная нумерация внутри каждого типа.
  function numberCards(cards) {
    var counts = {};
    return cards.map(function (card) {
      var type = String(card.type || '');
      counts[type] = (counts[type] || 0) + 1;
      var copy = {};
      for (var key in card) {
        if (Object.prototype.hasOwnProperty.call(card, key)) copy[key] = card[key];
      }
      copy.number = counts[type];
      return copy;
    });
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // «Иероглиф 7», «Правило 2»; без номера — «Иероглиф», «Карточка».
  function label(card) {
    var text = capitalize(typeLabel(card && card.type));
    var number = card && card.number;
    return number ? text + ' ' + number : text;
  }

  global.CardLabel = {
    typeLabel: typeLabel,
    numberCards: numberCards,
    label: label
  };
})(window);
