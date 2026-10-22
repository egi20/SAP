/* eslint-env browser */
(function () {
  'use strict';

  var root = document.getElementById('assistant');
  if (!root) return;

  /*
   * The widget is hidden in the markup and revealed here, so a visitor with scripting off
   * never sees a chat box that cannot send anything.
   */
  root.hidden = false;

  var launcher = document.getElementById('assistantLauncher');
  var panel = document.getElementById('assistantPanel');
  var closeButton = document.getElementById('assistantClose');
  var form = document.getElementById('assistantForm');
  var input = document.getElementById('assistantInput');
  var send = document.getElementById('assistantSend');
  var log = document.getElementById('assistantLog');

  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrfToken = tokenMeta ? tokenMeta.getAttribute('content') : '';

  /*
   * History lives in THIS TAB and nowhere else.
   *
   * sessionStorage rather than localStorage: a conversation about how a page works has no
   * reason to outlive the tab, and on a shared machine it should not. The server keeps no
   * transcript at all, so this is the only copy — and it is re-validated and capped
   * server-side before any of it reaches the model.
   */
  var STORAGE_KEY = 'saphub.assistant.history';
  var MAX_KEPT = 12;
  var history = [];

  try {
    var saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved) history = JSON.parse(saved) || [];
  } catch (err) {
    history = [];
  }
  if (!Array.isArray(history)) history = [];

  function persist() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_KEPT)));
    } catch (err) {
      /* A full or blocked store is not a reason to break the conversation in progress. */
    }
  }

  /** Text only. Nothing the model returns is ever inserted as markup. */
  function bubble(role, text, options) {
    var wrap = document.createElement('div');
    wrap.className = 'assistant-msg assistant-msg-' + (role === 'user' ? 'user' : 'bot');

    var p = document.createElement('p');
    p.className = 'mb-0';
    p.textContent = text;
    wrap.appendChild(p);

    if (options && options.note) {
      var note = document.createElement('p');
      note.className = 'assistant-note mb-0';
      note.textContent = options.note;
      wrap.appendChild(note);
    }

    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  history.forEach(function (entry) {
    bubble(entry.role, entry.content);
  });

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) input.focus();
  }

  launcher.addEventListener('click', function () {
    markTeaserSeen();
    setOpen(panel.hidden);
  });

  /*
   * A one-time teaser naming the mascot, as on dynamicshub.net — a robot in the corner is
   * otherwise easy to read as decoration. Shown once per browser, after a short delay,
   * never while the panel is open, and gone after fifteen seconds. localStorage can throw
   * in a private window; the teaser is then simply not shown, which is the quiet failure.
   */
  var teaser = document.getElementById('assistantTeaser');
  var TEASER_KEY = 'saphub.assistant.teaserSeen';
  function teaserSeen() {
    try { return window.localStorage.getItem(TEASER_KEY) === '1'; } catch (err) { return true; }
  }
  function markTeaserSeen() {
    try { window.localStorage.setItem(TEASER_KEY, '1'); } catch (err) { /* nothing to remember with */ }
    if (teaser) teaser.hidden = true;
  }
  if (teaser && !teaserSeen()) {
    window.setTimeout(function () {
      if (teaserSeen() || !panel.hidden) return;
      teaser.hidden = false;
      window.setTimeout(function () { teaser.hidden = true; }, 15000);
    }, 1800);
    document.getElementById('assistantTeaserClose').addEventListener('click', markTeaserSeen);
    document.getElementById('assistantTeaserOpen').addEventListener('click', function () {
      markTeaserSeen();
      setOpen(true);
    });
  }

  /* Suggested questions: one press asks it. They go once a conversation has started. */
  var chips = document.getElementById('assistantChips');
  function hideChips() { if (chips) chips.hidden = true; }
  if (history.length) hideChips();
  if (chips) {
    chips.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-ask]');
      if (!chip) return;
      input.value = chip.getAttribute('data-ask');
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  }
  /* The welcome tour, replayed: the one way back to it after the first sign-in. */
  var tourButton = document.getElementById('assistantTour');
  if (tourButton) {
    tourButton.addEventListener('click', function () {
      if (!window.saphubOpenOnboarding) return;
      setOpen(false);
      window.saphubOpenOnboarding();
    });
  }
  /* The welcome tour's last step hands over to the assistant with a question already asked. */
  window.saphubAskAssistant = function (question) {
    markTeaserSeen();
    setOpen(true);
    input.value = question;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  };
  closeButton.addEventListener('click', function () {
    setOpen(false);
    launcher.focus();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      launcher.focus();
    }
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var message = input.value.trim();
    if (!message) return;

    hideChips();
    input.value = '';
    input.disabled = true;
    send.disabled = true;

    bubble('user', message);
    history.push({ role: 'user', content: message });
    persist();

    var pending = bubble('bot', 'Thinking…');

    fetch('/assistant/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        // Explicit, because the rate limiter answers an HTML-accepting request with a
        // redirect and a JSON-accepting one with JSON. A default `*/*` would be read as
        // a navigation and this would try to render a login page into a chat bubble.
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body: JSON.stringify({ message: message, history: history.slice(-MAX_KEPT) })
    })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        log.removeChild(pending);

        if (!result.ok || !result.data || !result.data.success) {
          var error = (result.data && result.data.error) || 'Something went wrong. Please try again.';
          bubble('bot', error);
          return;
        }

        bubble('bot', result.data.reply, {
          note: result.data.truncated ? 'That answer hit the length limit — ask for one part at a time.' : null
        });
        history.push({ role: 'assistant', content: result.data.reply });
        persist();
      })
      .catch(function () {
        if (pending.parentNode) log.removeChild(pending);
        bubble('bot', 'The assistant could not be reached. Please try again in a moment.');
      })
      .then(function () {
        input.disabled = false;
        send.disabled = false;
        input.focus();
      });
  });
})();
