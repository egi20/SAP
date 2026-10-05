/* eslint-env browser */
(function () {
  'use strict';

  /**
   * Every fetch from this page carries the CSRF token from the meta tag.
   * Server-rendered forms carry it as a hidden field instead.
   */
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  function apiFetch(url, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'X-CSRF-Token': csrfToken }, opts.headers || {});
    opts.credentials = 'same-origin';
    return fetch(url, opts);
  }

  /**
   * Unread notification badge.
   *
   * Fails silently: a 401 here simply means the session ended, and the page should not
   * grow an error banner because a decorative counter could not load.
   */
  function fillBadge(elementId, url) {
    var badge = document.getElementById(elementId);
    if (!badge) return;
    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.count > 0) {
          badge.textContent = data.count > 99 ? '99+' : String(data.count);
          badge.classList.remove('d-none');
        }
      })
      .catch(function () { /* decorative only */ });
  }

  fillBadge('notifCount', '/notifications/unread-count');
  fillBadge('messageCount', '/messages/unread-count');

  /**
   * Guard against a double-submitted form producing two writes.
   * The button is disabled after submit, but the form still submits normally, so this
   * degrades to no-op without JavaScript.
   */
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || form.dataset.noGuard === 'true') return;
    var button = form.querySelector('button[type="submit"]');
    if (!button || button.disabled) return;
    window.setTimeout(function () {
      button.disabled = true;
      button.dataset.originalText = button.innerHTML;
      button.innerHTML = 'Working…';
    }, 0);
  });

  /**
   * Scroll reveal: a 16px rise as an element enters the viewport, once.
   *
   * Above-the-fold content is revealed immediately rather than waiting for a scroll that
   * may never happen. Anything already intersecting on load counts as above the fold.
   * With reduced motion requested, everything is revealed at once and no observer runs.
   */
  var revealTargets = document.querySelectorAll('.animate-on-scroll');
  var prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (revealTargets.length) {
    if (prefersReducedMotion || typeof IntersectionObserver !== 'function') {
      Array.prototype.forEach.call(revealTargets, function (el) { el.classList.add('is-visible'); });
    } else {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });

      Array.prototype.forEach.call(revealTargets, function (el) { observer.observe(el); });
    }
  }

  /**
   * Print button (the invoice).
   *
   * Delegated rather than an inline `onclick`, so no view has to carry executable markup.
   * Without JavaScript the page still prints correctly from the browser's own menu — the
   * print stylesheet does the real work; this is only a shortcut to it.
   */
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest ? event.target.closest('[data-print]') : null;
    if (!trigger) return;
    event.preventDefault();
    window.print();
  });

  /**
   * Select the whole value of a read-only field when it is focused.
   *
   * Delegated rather than an inline `onfocus`, so no view carries executable markup.
   * Without JavaScript the field still shows the full value and can be selected by hand —
   * this only saves a drag.
   */
  document.addEventListener('focusin', function (event) {
    var field = event.target;
    if (field && field.hasAttribute && field.hasAttribute('data-select-on-focus')) field.select();
  });

  /**
   * A colour picker that writes into its hex field.
   *
   * The text field is the one that submits, so the page works identically with scripting
   * off — the picker is a convenience for choosing, never the source of the value.
   */
  document.addEventListener('input', function (event) {
    var picker = event.target;
    if (!picker || !picker.hasAttribute || !picker.hasAttribute('data-mirror')) return;
    var target = document.getElementById(picker.getAttribute('data-mirror'));
    if (target) target.value = picker.value;
  });

  /**
   * Availability date is only meaningful for a profile that is actually available.
   * Purely a convenience: the server does not depend on it.
   */
  var availability = document.getElementById('availability');
  var availableFrom = document.getElementById('available_from');
  if (availability && availableFrom) {
    var sync = function () {
      availableFrom.disabled = availability.value === 'not_available';
    };
    availability.addEventListener('change', sync);
    sync();
  }

  /** Ending an experience and marking it current are mutually exclusive. */
  var isCurrent = document.getElementById('is_current');
  if (isCurrent) {
    var endedOn = document.querySelector('input[name="ended_on"]');
    var syncCurrent = function () {
      if (endedOn) endedOn.disabled = isCurrent.checked;
    };
    isCurrent.addEventListener('change', syncCurrent);
    syncCurrent();
  }
})();

/*
 * Show/hide for password fields.
 *
 * The button is built HERE rather than in the template, because it only works with
 * scripting: a control rendered by the server that silently does nothing is worse than no
 * control at all, since somebody has already decided to trust what it shows them.
 *
 * `aria-pressed` carries the state, and the label changes with it — an icon alone does not
 * say whether the password is currently visible, which is the only thing the button is
 * for.
 */
(function passwordToggles() {
  document.querySelectorAll('.password-field').forEach(function (wrap) {
    var input = wrap.querySelector('input[type="password"]');
    if (!input) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-toggle';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', input.id);
    button.setAttribute('aria-label', 'Show password');
    button.innerHTML = '<i class="bi bi-eye" aria-hidden="true"></i>';

    button.addEventListener('click', function () {
      var shown = input.type === 'text';
      input.type = shown ? 'password' : 'text';
      button.setAttribute('aria-pressed', shown ? 'false' : 'true');
      button.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
      button.innerHTML = shown
        ? '<i class="bi bi-eye" aria-hidden="true"></i>'
        : '<i class="bi bi-eye-slash" aria-hidden="true"></i>';
      // Returning focus to the field keeps a keyboard user where they were typing.
      input.focus();
    });

    wrap.appendChild(button);
  });
}());

/*
 * The cookie notice.
 *
 * It is a NOTICE, not a consent gate, and the difference is the whole design. This site
 * sets one cookie — the session — and sets it only because somebody asked to be signed in.
 * There is no analytics cookie, no advertising cookie and no third party. So an
 * "Accept all / Reject" pair would be theatre: "Reject" could not do anything, because
 * there is nothing to refuse that would leave the site working. A button that pretends to
 * give somebody a choice they do not have is worse than no button, and it is what trains
 * people to click through every real one.
 *
 * Built here rather than rendered by the server so that somebody who has dismissed it
 * never sees it flash on the next page. The disclosure itself does not depend on this: it
 * is in the privacy policy, which is server-rendered and linked from every footer.
 *
 * The dismissal is remembered in localStorage and NOT in a cookie, which would be comic.
 */
(function cookieNotice() {
  var KEY = 'saphub.cookieNotice';

  var seen;
  try {
    seen = window.localStorage.getItem(KEY);
  } catch (err) {
    // Private browsing, or storage disabled. Showing it every time is the honest failure:
    // we genuinely cannot tell whether this person has read it.
    seen = null;
  }
  if (seen === 'dismissed') return;

  var bar = document.createElement('div');
  bar.className = 'cookie-notice';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Cookie notice');
  bar.innerHTML =
    '<p class="cookie-notice-text">' +
      'This site uses <strong>one cookie</strong>, to keep you signed in. ' +
      'No analytics, no advertising, no third parties — so there is nothing here to opt out of. ' +
      '<a href="/legal/privacy#cookies">What we store</a>.' +
    '</p>';

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-primary btn-sm';
  button.textContent = 'Got it';
  button.addEventListener('click', function () {
    try {
      window.localStorage.setItem(KEY, 'dismissed');
    } catch (err) {
      // Nothing to do: it will appear again, which is the correct outcome.
    }
    bar.remove();
  });

  bar.appendChild(button);
  document.body.appendChild(bar);
}());

/*
 * Back to top.
 *
 * Appears after a screenful of scrolling and not before — a button offering to take
 * somebody to the top of a page they have not left is noise. It is a real <button> so the
 * keyboard reaches it, and it honours prefers-reduced-motion, because a smooth scroll
 * through a long page is exactly the movement that setting exists to stop.
 */
(function backToTop() {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'back-to-top';
  button.setAttribute('aria-label', 'Back to top');
  button.hidden = true;
  button.innerHTML = '<i class="bi bi-arrow-up" aria-hidden="true"></i>';

  button.addEventListener('click', function () {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    // Focus follows the scroll, or a keyboard user is returned to the top of a page while
    // their focus stays at the bottom of it.
    var main = document.getElementById('main');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus({ preventScroll: true });
    }
  });

  document.body.appendChild(button);

  var ticking = false;
  function update() {
    button.hidden = window.scrollY < window.innerHeight;
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    // One update per frame: a scroll handler that runs on every event is the cheapest way
    // to make a long page feel broken on a phone.
    if (!ticking) {
      window.requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
}());
