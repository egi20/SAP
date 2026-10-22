/* eslint-env browser */
(function () {
  'use strict';

  /**
   * The SOW generator's form: module search, a count of what is ticked in each product
   * line, and the live total.
   *
   * The total is asked of POST /quotes/preview, which runs the same engine the save runs.
   * Nothing here does arithmetic on effort or money: a second copy of the estimator in the
   * browser would be a second answer to the same question.
   */
  var form = document.getElementById('quote-form');
  if (!form) return;

  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  // Module search — only offered when this script runs, so the box is never a dead control.
  var searchWrap = form.querySelector('[data-module-search-wrap]');
  var search = form.querySelector('[data-module-search]');
  var groups = Array.prototype.slice.call(form.querySelectorAll('[data-module-group]'));
  if (searchWrap && search) {
    searchWrap.classList.remove('d-none');
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      groups.forEach(function (group) {
        var hits = 0;
        group.querySelectorAll('[data-module-item]').forEach(function (item) {
          var match = !q || item.getAttribute('data-search').indexOf(q) !== -1;
          item.classList.toggle('d-none', !match);
          if (match) hits += 1;
        });
        group.classList.toggle('d-none', Boolean(q) && hits === 0);
        if (q && hits) group.open = true;
      });
    });
  }

  function updateCounts() {
    groups.forEach(function (group) {
      var n = group.querySelectorAll('input[type="checkbox"]:checked').length;
      var badge = group.querySelector('[data-selected-count]');
      if (!badge) return;
      badge.textContent = n + ' selected';
      badge.classList.toggle('d-none', n === 0);
    });
  }

  var box = document.querySelector('[data-quote-preview]');
  var empty = box && box.querySelector('[data-preview-empty]');
  var figures = box && box.querySelector('[data-preview-figures]');

  function set(key, text) {
    var el = box.querySelector('[data-preview="' + key + '"]');
    if (el) el.textContent = text;
  }

  function money(n, currency) {
    return (currency === 'EUR' ? '€' : currency + ' ') + Math.round(n).toLocaleString('en');
  }

  var seq = 0;
  function preview() {
    if (!box) return;
    var mine = ++seq;
    fetch('/quotes/preview', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString()
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (mine !== seq || !data || !data.success) return;
        empty.classList.toggle('d-none', !data.empty);
        figures.classList.toggle('d-none', Boolean(data.empty));
        if (data.empty) return;
        set('modules', String(data.modules));
        set('days', data.totalManDays + ' days');
        set('months', data.durationMonths + (data.durationMonths === 1 ? ' month' : ' months'));
        set('migration', data.dataMigrationDays ? data.dataMigrationDays + ' days' : 'Not costed');
        set('budget', money(data.totalBudget, data.currency));
      })
      .catch(function () { /* the saved estimate is the answer; a missed preview is not an error */ });
  }

  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(preview, 300);
  }

  form.addEventListener('change', function () { updateCounts(); schedule(); });
  form.addEventListener('input', function (e) {
    if (e.target === search) return;
    if (e.target.type === 'number' || e.target.tagName === 'TEXTAREA') schedule();
  });

  updateCounts();
  preview();
})();
