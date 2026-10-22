/* eslint-env browser */
/**
 * The SAP games' page enhancements. Every scored game works with scripting off — the
 * answers are radio buttons, selects and text boxes, and the server marks them. This file
 * only adds conveniences:
 *
 *   - word search: tap the first and last letter of a word to copy it into the selected
 *     clue (it never knows whether the word is right — the grid has no answers in it);
 *   - typing practice: a timer and a speed, computed here and never sent anywhere;
 *   - multiple choice: one question at a time, with a progress bar.
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

  /* ---------------------------------------------------------------- multiple choice, one at a time */
  /*
   * The questions are all in the page and all in the form; this only shows one at a time,
   * moves on when an answer is picked, and keeps the submit button for the end. It never
   * knows which answer is right — the server marks the form exactly as it would without it.
   */
  var steps = Array.prototype.slice.call(doc.querySelectorAll('[data-mcq-step]'));
  if (steps.length > 1) {
    var form = steps[0].closest('form');
    var nav = form.querySelector('[data-stepper-nav]');
    var buttons = form.querySelector('[data-stepper-buttons]');
    var back = form.querySelector('[data-stepper-back]');
    var next = form.querySelector('[data-stepper-next]');
    var submit = form.querySelector('[data-stepper-submit]');
    var count = form.querySelector('[data-stepper-count]');
    var bar = form.querySelector('[data-stepper-bar]');
    var current = 0;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    form.classList.add('quiz-stepper');
    nav.hidden = false;
    buttons.hidden = false;

    var answered = function (step) { return Boolean(step.querySelector('input:checked')); };

    var show = function (n) {
      current = Math.max(0, Math.min(n, steps.length - 1));
      steps.forEach(function (step, i) {
        step.hidden = i !== current;
        step.classList.toggle('quiz-step-in', i === current && !reduced);
      });
      var done = steps.filter(answered).length;
      count.textContent = 'Question ' + (current + 1) + ' of ' + steps.length;
      bar.style.width = Math.round((done / steps.length) * 100) + '%';
      back.disabled = current === 0;
      var last = current === steps.length - 1;
      next.hidden = last;
      next.disabled = !answered(steps[current]);
      submit.hidden = !(last && done === steps.length);
    };

    form.addEventListener('change', function (event) {
      if (event.target.type !== 'radio') return;
      show(current);
      if (current < steps.length - 1) window.setTimeout(function () { show(current + 1); }, reduced ? 0 : 350);
    });
    back.addEventListener('click', function () { show(current - 1); });
    next.addEventListener('click', function () { show(current + 1); });
    show(0);
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
