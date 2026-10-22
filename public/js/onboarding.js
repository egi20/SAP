/* eslint-env browser */
(function () {
  'use strict';

  /*
   * The welcome tour (views/partials/onboarding.ejs). ES2019 on purpose: this ships
   * untranspiled to every signed-in page.
   */
  var el = document.getElementById('onboardingModal');
  if (!el || !window.bootstrap || !window.bootstrap.Modal) return;

  var modal = window.bootstrap.Modal.getOrCreateInstance(el);
  var steps = [].slice.call(el.querySelectorAll('[data-onb-step]'));
  var dots = [].slice.call(el.querySelectorAll('.onboarding-dot'));
  var back = el.querySelector('[data-onb-back]');
  var next = el.querySelector('[data-onb-next]');
  var intro = el.querySelector('[data-onb-intro]');
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var current = 0;
  var stamped = false;

  function show(n) {
    current = Math.max(0, Math.min(n, steps.length - 1));
    steps.forEach(function (s, i) { s.hidden = i !== current; });
    dots.forEach(function (d, i) { d.classList.toggle('on', i === current); });
    back.hidden = current === 0;
    next.textContent = current === steps.length - 1 ? 'Done' : 'Next';
    if (intro) intro.hidden = current !== 0;
  }

  /*
   * Stamped the moment it first opens by itself, not on close: somebody who navigates away
   * or closes the tab without pressing anything has still seen it, and must not be shown
   * it on every page until they do. A replay never stamps — it was already stamped.
   */
  function stamp() {
    if (stamped) return;
    stamped = true;
    fetch('/dashboard/onboarded', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken, Accept: 'application/json' }
    }).catch(function () { /* best-effort: the next page asks again, which is the honest failure */ });
  }

  /* The assistant's "show me the tour again" calls this. */
  window.saphubOpenOnboarding = function () {
    show(0);
    modal.show();
  };

  next.addEventListener('click', function () {
    if (current < steps.length - 1) show(current + 1);
    else modal.hide();
  });
  back.addEventListener('click', function () { show(current - 1); });

  var ask = el.querySelector('[data-onb-ask]');
  if (ask) {
    ask.addEventListener('click', function () {
      modal.hide();
      window.setTimeout(function () {
        if (window.saphubAskAssistant) window.saphubAskAssistant('How do I get started on SAP Hub?');
      }, 350);
    });
  }

  /*
   * A step's button opens its page in a NEW tab, so the tour stays here and can be
   * finished. That tab must not open the tour as well — the stamp may not have landed yet —
   * so the click leaves a short-lived marker behind.
   */
  [].slice.call(el.querySelectorAll('[data-onb-cta]')).forEach(function (a) {
    a.addEventListener('click', function () {
      try { window.localStorage.setItem('saphub.onboardingOpened', String(Date.now())); } catch (err) { /* private window */ }
    });
  });

  var replay = /(?:^|[?&])tour=1(?:&|$)/.test(window.location.search);
  var auto = el.getAttribute('data-auto') === '1';
  var suppressed = false;
  try {
    suppressed = Date.now() - parseInt(window.localStorage.getItem('saphub.onboardingOpened') || '0', 10) < 15000;
  } catch (err) { /* nothing remembered */ }

  show(0);
  if (replay) {
    modal.show();
  } else if (auto && !suppressed) {
    modal.show();
    stamp();
  }
}());
