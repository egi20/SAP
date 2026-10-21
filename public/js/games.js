/* eslint-env browser */
/**
 * The SAP games' page enhancements. Every scored game works with scripting off — the
 * answers are radio buttons, selects and text boxes, and the server marks them. This file
 * only adds conveniences:
 *
 *   - word search: tap the first and last letter of a word to copy it into the selected
 *     clue (it never knows whether the word is right — the grid has no answers in it);
 *   - typing practice: a timer and a speed, computed here and never sent anywhere.
 */
(function () {
  'use strict';

  var doc = document;

  /* ---------------------------------------------------------------- word search */
  var grid = doc.querySelector('[data-word-grid]');
  if (grid) {
    var inputs = Array.prototype.slice.call(doc.querySelectorAll('[data-word-input]'));
    var active = inputs[0] || null;
    var start = null;

    inputs.forEach(function (input) {
      input.addEventListener('focus', function () { active = input; });
    });

    function cell(r, c) {
      return grid.querySelector('[data-r="' + r + '"][data-c="' + c + '"]');
    }

    function clearMarks() {
      Array.prototype.forEach.call(grid.querySelectorAll('.is-start'), function (el) { el.classList.remove('is-start'); });
    }

    grid.addEventListener('click', function (event) {
      var target = event.target.closest('.word-cell');
      if (!target) return;
      var r = Number(target.getAttribute('data-r'));
      var c = Number(target.getAttribute('data-c'));
      if (!start) {
        start = { r: r, c: c };
        target.classList.add('is-start');
        return;
      }
      var dr = Math.sign(r - start.r);
      var dc = Math.sign(c - start.c);
      var length = Math.max(Math.abs(r - start.r), Math.abs(c - start.c)) + 1;
      var straight = (r === start.r || c === start.c || Math.abs(r - start.r) === Math.abs(c - start.c));
      clearMarks();
      if (!straight || length < 2) { start = null; return; }
      var letters = '';
      var cells = [];
      for (var k = 0; k < length; k += 1) {
        var el = cell(start.r + dr * k, start.c + dc * k);
        letters += el.textContent;
        cells.push(el);
      }
      start = null;
      if (!active) return;
      active.value = letters;
      cells.forEach(function (el) { el.classList.add('is-picked'); });
      var next = inputs.filter(function (i) { return !i.value; })[0];
      if (next) { active = next; next.focus(); }
    });
  }

  /* ---------------------------------------------------------------- typing practice */
  var typing = doc.querySelector('[data-typing]');
  if (typing) {
    var target = typing.querySelector('[data-typing-target]').textContent.trim();
    var input = typing.querySelector('[data-typing-input]');
    var status = typing.querySelector('[data-typing-status]');
    var began = null;
    var finished = false;

    input.addEventListener('input', function () {
      if (finished) return;
      if (began === null) began = Date.now();
      var typed = input.value;
      var errors = 0;
      for (var i = 0; i < typed.length; i += 1) if (typed[i] !== target[i]) errors += 1;
      var minutes = Math.max((Date.now() - began) / 60000, 1 / 60);
      var wpm = Math.round((typed.length / 5) / minutes);
      var accuracy = typed.length ? Math.round(100 * (typed.length - errors) / typed.length) : 100;
      if (typed.length >= target.length && errors === 0) {
        finished = true;
        input.readOnly = true;
        status.textContent = 'Done: ' + wpm + ' words a minute, no mistakes. Reload for another go.';
        return;
      }
      status.textContent = wpm + ' words a minute · ' + accuracy + '% accurate · ' + typed.length + ' of ' + target.length + ' characters';
    });
  }
}());
