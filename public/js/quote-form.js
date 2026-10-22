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

  var stepsList = box && box.querySelector('[data-preview-steps]');
  var migrationLink = box && box.querySelector('[data-preview-migration-link]');
  var goLiveBox = box && box.querySelector('[data-preview-golive]');
  var earliestLine = box && box.querySelector('[data-preview-earliest]');

  function monthYear(iso) {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function dayMonthYear(iso) {
    return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  // The steps come from the engine and sum to the total there; this only lays them out.
  function renderSteps(steps, total) {
    stepsList.textContent = '';
    steps.forEach(function (step, i) {
      var li = document.createElement('li');
      li.className = 'd-flex justify-content-between gap-2';
      var label = document.createElement('span');
      label.className = 'text-muted-2';
      label.textContent = step.label;
      var days = document.createElement('span');
      days.className = 'text-nowrap';
      days.textContent = (i === 0 ? '' : step.days < 0 ? '− ' : '+ ') + Math.abs(step.days) + 'd';
      li.appendChild(label);
      li.appendChild(days);
      stepsList.appendChild(li);
    });
    var sum = document.createElement('li');
    sum.className = 'd-flex justify-content-between gap-2 border-top mt-1 pt-1 fw-semibold';
    sum.innerHTML = '<span>Total</span>';
    var t = document.createElement('span');
    t.textContent = total + 'd';
    sum.appendChild(t);
    stepsList.appendChild(sum);
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
        var unassessed = data.dataMigrationScope === 'not-assessed';
        set('migration', unassessed ? '' : data.dataMigrationDays ? data.dataMigrationDays + ' days' : 'None');
        migrationLink.classList.toggle('d-none', !unassessed);
        set('hypercare', !data.hypercare.included ? 'Not included'
          : data.hypercare.weeks ? data.hypercare.weeks + ' weeks · ' + data.hypercare.days + ' days'
            : data.hypercare.days + ' days');
        set('budget', money(data.totalBudget, data.currency));
        renderSteps(data.effortSteps, data.totalManDays);

        var months = data.durationMonths + (data.durationMonths === 1 ? ' month' : ' months');
        if (data.goLiveTooSoon) {
          goLiveBox.textContent = 'Timeline needs ~' + months + ' (' + data.durationWeeks + ' weeks) — go-live at the earliest '
            + monthYear(data.earliestGoLive) + ', if work starts today. The target of '
            + dayMonthYear(data.goLiveDate) + ' is earlier: reduce the scope or move the date.';
        }
        goLiveBox.classList.toggle('d-none', !data.goLiveTooSoon);
        earliestLine.textContent = 'If work starts today, the earliest go-live is ' + monthYear(data.earliestGoLive) + '.';
        earliestLine.classList.toggle('d-none', Boolean(data.goLiveTooSoon));
      })
      .catch(function () { /* the saved estimate is the answer; a missed preview is not an error */ });
  }

  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(preview, 300);
  }

  // The hypercare length only means something while hypercare is included.
  var includeRun = document.getElementById('include_run');
  var lengthField = form.querySelector('[data-hypercare-length]');
  function toggleLength() {
    if (includeRun && lengthField) lengthField.classList.toggle('d-none', !includeRun.checked);
  }

  // "Choose a migration scope" scrolls to the field and puts the cursor in it.
  if (migrationLink) {
    migrationLink.addEventListener('click', function (e) {
      var field = document.getElementById('data_migration_scope');
      if (!field) return;
      e.preventDefault();
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field.focus({ preventScroll: true });
    });
  }

  form.addEventListener('change', function () { updateCounts(); toggleLength(); schedule(); });
  form.addEventListener('input', function (e) {
    if (e.target === search) return;
    if (e.target.type === 'number' || e.target.tagName === 'TEXTAREA') schedule();
  });

  updateCounts();
  toggleLength();
  preview();
})();
