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
   * Unread badges.
   *
   * ONE request per count, written into every element carrying its `data-count` — the bell
   * and the chat icon in the bar, and the Messages tile in the user menu. Two elements
   * fetching the same number separately could show two different numbers on one page.
   *
   * Fails silently: a 401 here simply means the session ended, and the page should not
   * grow an error banner because a decorative counter could not load.
   */
  function setBadges(kind, count) {
    var badges = document.querySelectorAll('[data-count="' + kind + '"]');
    Array.prototype.forEach.call(badges, function (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.classList.remove('d-none');
      } else {
        badge.textContent = '';
        badge.classList.add('d-none');
      }
    });
  }

  function fillBadges(kind, url) {
    if (!document.querySelector('[data-count="' + kind + '"]')) return;
    apiFetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) setBadges(kind, data.count); })
      .catch(function () { /* decorative only */ });
  }

  fillBadges('notifications', '/notifications/unread-count');
  fillBadges('messages', '/messages/unread-count');

  /**
   * The Notifications section of the user menu.
   *
   * Loaded the first time the menu opens, not with the page: most page views never open it,
   * and a query per render for a list nobody reads is a cost every page pays. Each entry is
   * built with textContent — a notification title is text somebody else's action produced.
   * The server only hands back same-site links; this checks again rather than trusting it.
   */
  var notifList = document.querySelector('[data-notification-list]');
  var notifLoaded = false;

  function safeLink(link) {
    return typeof link === 'string' && link.charAt(0) === '/' && link.charAt(1) !== '/' && link.charAt(1) !== '\\';
  }

  function emptyNotifications() {
    notifList.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'text-center text-muted-2 small py-3 mb-0';
    var icon = document.createElement('i');
    icon.className = 'bi bi-bell-slash d-block fs-4 mb-1';
    icon.setAttribute('aria-hidden', 'true');
    p.appendChild(icon);
    p.appendChild(document.createTextNode('No new notifications'));
    notifList.appendChild(p);
  }

  function renderNotifications(items) {
    if (!items.length) return emptyNotifications();
    notifList.innerHTML = '';
    items.forEach(function (n) {
      var entry = document.createElement('a');
      entry.className = 'notification-entry' + (n.read ? '' : ' is-unread');
      entry.href = safeLink(n.link) ? n.link : '/notifications';
      var icon = document.createElement('i');
      icon.className = 'bi ' + (n.read ? 'bi-bell' : 'bi-bell-fill');
      icon.setAttribute('aria-hidden', 'true');
      var text = document.createElement('span');
      text.className = 'flex-grow-1 min-w-0';
      var title = document.createElement('span');
      title.className = 'notification-title d-block text-truncate';
      title.textContent = n.title;
      var time = document.createElement('span');
      time.className = 'notification-time';
      time.textContent = n.when;
      text.appendChild(title);
      text.appendChild(time);
      entry.appendChild(icon);
      entry.appendChild(text);
      if (!n.read) {
        var dot = document.createElement('span');
        dot.className = 'notification-unread-dot';
        dot.setAttribute('aria-label', 'Unread');
        entry.appendChild(dot);
        // Marked read on the way out. keepalive lets the request finish after navigation.
        entry.addEventListener('click', function () {
          apiFetch('/notifications/' + encodeURIComponent(n.id) + '/read', { method: 'POST', keepalive: true })
            .catch(function () { /* the list page can still mark it */ });
        });
      }
      notifList.appendChild(entry);
    });
    return undefined;
  }

  function loadNotifications() {
    if (!notifList || notifLoaded) return;
    notifLoaded = true;
    apiFetch('/notifications/recent')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.notifications)) { notifLoaded = false; return; }
        renderNotifications(data.notifications);
        setBadges('notifications', data.unread);
      })
      .catch(function () { notifLoaded = false; });
  }

  var userToggle = document.getElementById('userMenuToggle');
  if (userToggle) userToggle.addEventListener('show.bs.dropdown', loadNotifications);

  // "Mark all read" without leaving the page. Without scripting the form posts normally.
  var markAll = document.querySelector('[data-mark-all-read]');
  if (markAll) {
    markAll.addEventListener('submit', function (event) {
      event.preventDefault();
      apiFetch(markAll.action, { method: 'POST' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          setBadges('notifications', 0);
          if (!notifList) return;
          Array.prototype.forEach.call(notifList.querySelectorAll('.notification-entry'), function (entry) {
            entry.classList.remove('is-unread');
            var dot = entry.querySelector('.notification-unread-dot');
            if (dot) dot.remove();
          });
        })
        .catch(function () { /* the list page can still do it */ });
    });
  }

  /**
   * The search panel under the magnifier: finds pages and menu items without leaving the page.
   *
   * The index is READ FROM THIS PAGE — every link in the navbar menus and the footer, with
   * the menu or footer column it sits under — so it can only offer what the navigation
   * offers, and adding a page to a menu adds it here with nothing else to edit. Labels are
   * read and written as text. Enter with no result picked submits the form, which is the
   * full search at /search.
   */
  var searchForm = document.querySelector('[data-nav-search]');
  var searchResults = document.getElementById('navSearchResults');
  var searchToggle = document.getElementById('navSearchToggle');

  function fold(text) {
    return String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function groupOf(link) {
    var footerColumn = link.closest('.footer-hub [class*="col-"]');
    if (footerColumn) {
      var heading = null;
      Array.prototype.forEach.call(footerColumn.querySelectorAll('h3'), function (h) {
        // eslint-disable-next-line no-bitwise
        if (h.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) heading = h;
      });
      return heading ? heading.textContent.trim() : '';
    }
    var menu = link.closest('.dropdown-menu');
    if (menu && menu.classList.contains('user-menu-dropdown')) return 'Your account';
    var toggle = menu && menu.parentElement.querySelector('.dropdown-toggle');
    return toggle ? toggle.textContent.trim() : '';
  }

  var searchIndex = null;
  function buildIndex() {
    var seen = {};
    searchIndex = [];
    var links = document.querySelectorAll(
      '.navbar-hub .nav-main a[href^="/"], .navbar-hub .dropdown-item[href^="/"], .navbar-hub .quick-link-item[href^="/"], .footer-hub a[href^="/"]'
    );
    Array.prototype.forEach.call(links, function (link) {
      var href = link.getAttribute('href');
      var label = link.textContent.replace(/\s+/g, ' ').trim();
      if (!label || seen[href]) return;
      seen[href] = true;
      var group = groupOf(link);
      var icon = link.querySelector('.bi');
      searchIndex.push({
        href: href,
        label: label,
        group: group,
        icon: icon ? icon.className.replace(/\b(me|ms)-\d\b/g, '').trim() : 'bi bi-link-45deg',
        haystack: fold(label + ' ' + group)
      });
    });
  }

  function searchMessage(text) {
    var p = document.createElement('p');
    p.className = 'nav-search-hint mb-0';
    p.textContent = text;
    return p;
  }

  function renderSearch(query) {
    if (!searchIndex) buildIndex();
    searchResults.innerHTML = '';
    var words = fold(query).split(' ').filter(Boolean);
    if (!words.length) {
      searchResults.appendChild(searchMessage('Type to find pages, menus, or features'));
      return;
    }
    var matches = searchIndex.filter(function (entry) {
      return words.every(function (w) { return entry.haystack.indexOf(w) !== -1; });
    }).slice(0, 8);

    matches.forEach(function (entry) {
      var a = document.createElement('a');
      a.className = 'dropdown-item nav-search-result';
      a.href = entry.href;
      var i = document.createElement('i');
      i.className = entry.icon + ' me-2';
      i.setAttribute('aria-hidden', 'true');
      var label = document.createElement('span');
      label.className = 'flex-grow-1 text-truncate';
      label.textContent = entry.label;
      a.appendChild(i);
      a.appendChild(label);
      if (entry.group) {
        var group = document.createElement('span');
        group.className = 'nav-search-group';
        group.textContent = entry.group;
        a.appendChild(group);
      }
      searchResults.appendChild(a);
    });

    // Always offered last: the full search, for anything that is not a page name.
    var all = document.createElement('a');
    all.className = 'dropdown-item nav-search-result nav-search-all';
    all.href = '/search?q=' + encodeURIComponent(query.trim());
    var allIcon = document.createElement('i');
    allIcon.className = 'bi bi-search me-2';
    allIcon.setAttribute('aria-hidden', 'true');
    all.appendChild(allIcon);
    all.appendChild(document.createTextNode(matches.length ? 'Search the Hub for “' + query.trim() + '”'
      : 'No page matches. Search the Hub for “' + query.trim() + '”'));
    searchResults.appendChild(all);
  }

  if (searchForm && searchResults && searchToggle) {
    var searchInput = searchForm.querySelector('input[name="q"]');
    searchToggle.addEventListener('shown.bs.dropdown', function () {
      buildIndex();
      searchInput.focus();
      searchInput.select();
    });
    searchInput.addEventListener('input', function () { renderSearch(searchInput.value); });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown') return;
      var first = searchResults.querySelector('.nav-search-result');
      if (first) { event.preventDefault(); first.focus(); }
    });
    searchResults.addEventListener('keydown', function (event) {
      var items = Array.prototype.slice.call(searchResults.querySelectorAll('.nav-search-result'));
      var at = items.indexOf(document.activeElement);
      if (at === -1 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowUp' && at === 0) { searchInput.focus(); return; }
      var next = items[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
    });
  }

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
    document.body.classList.remove('has-cookie-notice');
  });

  bar.appendChild(button);
  document.body.appendChild(bar);
  /*
   * The notice is `position: fixed`, so it cannot push anything out of its way — on a
   * phone it covered about a third of the screen, and the form buttons and validation
   * messages underneath it were unreachable until it was dismissed. The class makes `body`
   * reserve the space, and it goes when the notice does.
   */
  document.body.classList.add('has-cookie-notice');
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

/*
 * Copy-link buttons.
 *
 * Built here rather than rendered, for the same reason as the password toggle: the button
 * cannot work without scripting, and a server-rendered control that silently does nothing
 * is worse than none. The URL comes from `data-copy`, which the server filled from the
 * canonical base URL — not from `location.href`, which carries whatever query string the
 * reader happened to arrive with into the link they then send somebody.
 */
(function copyLinks() {
  document.querySelectorAll('.copy-link').forEach(function (slot) {
    var url = slot.getAttribute('data-copy');
    if (!url) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-secondary';
    button.innerHTML = '<i class="bi bi-link-45deg" aria-hidden="true"></i> Copy link';

    // aria-live, so the confirmation is announced rather than only seen.
    var status = document.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('aria-live', 'polite');

    function confirm(text) {
      button.innerHTML = '<i class="bi bi-check2" aria-hidden="true"></i> ' + text;
      status.textContent = text;
      window.setTimeout(function () {
        button.innerHTML = '<i class="bi bi-link-45deg" aria-hidden="true"></i> Copy link';
        status.textContent = '';
      }, 2000);
    }

    button.addEventListener('click', function () {
      /*
       * `navigator.clipboard` needs a secure context, which http://localhost is and a
       * plain-http deployment is not. Falling back to a hidden field and execCommand keeps
       * the button honest there rather than leaving it silently doing nothing.
       */
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(function () { confirm('Copied'); },
          function () { confirm('Press Ctrl+C'); });
        return;
      }
      var field = document.createElement('input');
      field.value = url;
      field.setAttribute('readonly', '');
      field.style.position = 'absolute';
      field.style.left = '-9999px';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
        confirm('Copied');
      } catch (err) {
        confirm('Press Ctrl+C');
      }
      field.remove();
    });

    slot.appendChild(button);
    slot.appendChild(status);
  });
}());

/*
 * Confirm before a form that destroys something.
 *
 * A quote draft was deleted by one click with nothing in between, and the community's
 * delete carried its own inline `onsubmit` — one copy per button, which is how a button
 * ends up without one. A `data-confirm` attribute and one listener is the same shape as
 * the copy button and the password toggle: the markup declares intent, this file builds
 * the behaviour.
 *
 * Bound on the FORM in the capture phase, so it runs before anything a page island has
 * attached and before the submit reaches the network. Without scripting the form submits
 * exactly as it does today — this degrades to the current behaviour rather than to a
 * control that lies about what it does, which is why it may be built here at all.
 */
(function confirmDestructive() {
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.matches || !form.matches('form[data-confirm]')) return;
    var message = form.getAttribute('data-confirm');
    if (!message) return;
    if (!window.confirm(message)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
})();
