/* eslint-env browser */
/**
 * /report-issue, in the browser. Every piece here is an aid: the form posts and the server
 * checks everything without any of it.
 *
 *  - screenshots: chosen or pasted (Ctrl+V into the message), shown as thumbnails with a
 *    Remove button, and a file over the limit is flagged the moment it is added;
 *  - a draft of what was typed is kept in sessionStorage, so a reload does not lose it, and
 *    dropped once the page reports the report arrived;
 *  - a live character count under the message;
 *  - the first refused field gets the focus after a refused submit;
 *  - FAQ questions that match the subject are offered while it is typed;
 *  - the browser/device line is filled in only when its box is ticked, and shown first.
 *
 * The limits come from data attributes the server rendered from middleware/fileUpload.js.
 */
(function () {
  'use strict';

  var form = document.querySelector('[data-report-form]');
  if (!form) return;

  /* ------------------------------------------------------------ screenshots */
  var input = form.querySelector('[data-screenshots]');
  var list = form.querySelector('[data-screenshot-list]');
  var message = document.getElementById('f-message');
  var canTransfer = typeof DataTransfer !== 'undefined';
  var maxFiles = input ? Number(input.getAttribute('data-max-files')) || 5 : 5;
  var maxBytes = input ? (Number(input.getAttribute('data-max-mb')) || 10) * 1024 * 1024 : 0;
  var ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  var previews = [];

  function current() {
    return input ? Array.prototype.slice.call(input.files || []) : [];
  }

  function setFiles(files) {
    if (!canTransfer) return;
    var dt = new DataTransfer();
    files.slice(0, maxFiles).forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    render();
  }

  function render() {
    if (!list) return;
    previews.forEach(function (u) { URL.revokeObjectURL(u); });
    previews = [];
    list.textContent = '';
    current().forEach(function (file, index) {
      var tooBig = file.size > maxBytes;
      var li = document.createElement('li');
      li.className = 'shot-preview' + (tooBig ? ' is-too-big' : '');
      var img = document.createElement('img');
      var url = URL.createObjectURL(file);
      previews.push(url);
      img.src = url;
      img.alt = file.name;
      var caption = document.createElement('span');
      caption.className = 'shot-caption';
      caption.textContent = tooBig
        ? file.name + ' — over ' + Math.round(maxBytes / 1024 / 1024) + ' MB, it will be refused'
        : file.name + ' (' + Math.max(1, Math.round(file.size / 1024)) + ' KB)';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-sm btn-light shot-remove';
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
      remove.addEventListener('click', function () {
        var files = current();
        files.splice(index, 1);
        setFiles(files);
      });
      li.appendChild(img);
      li.appendChild(remove);
      li.appendChild(caption);
      list.appendChild(li);
    });
  }

  if (input) {
    input.addEventListener('change', function () {
      if (current().length > maxFiles) setFiles(current());
      else render();
    });
  }

  if (message && input && canTransfer) {
    message.addEventListener('paste', function (event) {
      var items = (event.clipboardData && event.clipboardData.items) || [];
      var pasted = [];
      Array.prototype.forEach.call(items, function (item) {
        if (item.kind === 'file' && ACCEPTED.indexOf(item.type) !== -1) {
          var blob = item.getAsFile();
          if (blob) {
            var ext = item.type.split('/')[1].replace('jpeg', 'jpg');
            var stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
            pasted.push(new File([blob], 'screenshot-' + stamp + '-' + (current().length + pasted.length + 1) + '.' + ext, { type: item.type }));
          }
        }
      });
      if (!pasted.length) return; // ordinary text: let the paste happen
      event.preventDefault();
      setFiles(current().concat(pasted));
    });
  }

  /* -------------------------------------------------------- character count */
  Array.prototype.forEach.call(form.querySelectorAll('[data-char-count]'), function (field) {
    var out = document.getElementById(field.getAttribute('data-char-count'));
    var min = Number(field.getAttribute('data-char-min')) || 0;
    function update() {
      var n = field.value.trim().length;
      if (!out) return;
      out.textContent = n < min ? n + ' / ' + min + ' minimum' : n + ' characters';
      out.classList.toggle('text-danger', n > 0 && n < min);
    }
    field.addEventListener('input', update);
    update();
  });

  /* ------------------------------------------------------------------ draft */
  var draftKey = form.getAttribute('data-draft-key');
  var DRAFT_FIELDS = ['subject', 'message', 'issue_type', 'severity', 'page_url', 'content_url'];
  function storage() {
    try { return window.sessionStorage; } catch (e) { return null; }
  }
  var store = storage();
  if (store && draftKey) {
    if (document.querySelector('[data-report-sent]')) {
      try { store.removeItem('report-draft-problem'); store.removeItem('report-draft-idea'); } catch (e) { /* nothing kept */ }
    } else {
      var saved = null;
      try { saved = JSON.parse(store.getItem(draftKey) || 'null'); } catch (e) { saved = null; }
      if (saved) {
        DRAFT_FIELDS.forEach(function (name) {
          var el = form.elements[name];
          // Never over something the server rendered (a refused submit) or the page prefilled.
          if (el && !el.value && saved[name]) el.value = saved[name];
        });
        var type = form.elements.issue_type;
        if (type) type.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    form.addEventListener('input', function () {
      var data = {};
      DRAFT_FIELDS.forEach(function (name) { if (form.elements[name]) data[name] = form.elements[name].value; });
      try { store.setItem(draftKey, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
    });
  }

  /* --------------------------------------------------- focus the first error */
  var firstInvalid = form.querySelector('.is-invalid');
  if (firstInvalid) {
    firstInvalid.focus();
    firstInvalid.scrollIntoView({ block: 'center' });
  }

  /* -------------------------------------------------------- FAQ suggestions */
  var subject = document.getElementById('f-subject');
  var box = document.querySelector('[data-faq-suggest]');
  var boxList = document.querySelector('[data-faq-suggest-list]');
  var faq = [];
  try { faq = JSON.parse((document.getElementById('faq-questions') || {}).textContent || '[]'); } catch (e) { faq = []; }
  var STOP = ['the', 'and', 'for', 'with', 'what', 'how', 'can', 'not', 'does', 'why', 'this', 'that', 'my', 'is', 'it', 'on', 'in', 'to', 'a', 'i'];
  function words(text) {
    return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2 && STOP.indexOf(w) === -1; });
  }
  if (subject && box && boxList && faq.length) {
    var timer = null;
    subject.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var typed = words(subject.value);
        var scored = faq.map(function (f) {
          var hay = words(f.q + ' ' + (f.words || ''));
          var score = typed.filter(function (w) {
            return hay.some(function (h) { return h === w || (w.length > 3 && h.indexOf(w) === 0); });
          }).length;
          return { f: f, score: score };
        }).filter(function (x) { return x.score > 0; })
          .sort(function (a, b) { return b.score - a.score; })
          .slice(0, 3);
        boxList.textContent = '';
        scored.forEach(function (x) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.href = '/faq#' + x.f.id;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = x.f.q;
          li.appendChild(a);
          boxList.appendChild(li);
        });
        box.hidden = scored.length === 0;
      }, 250);
    });
  }

  /* ------------------------------------------------------ browser and device */
  var envToggle = form.querySelector('[data-env-toggle]');
  var envInfo = form.querySelector('[data-env-info]');
  var envPreview = form.querySelector('[data-env-preview]');
  function envLine() {
    return (navigator.userAgent || '') + ' | screen ' + screen.width + 'x' + screen.height +
      ' | window ' + window.innerWidth + 'x' + window.innerHeight;
  }
  function syncEnv() {
    if (!envToggle || !envInfo) return;
    envInfo.value = envToggle.checked ? envLine().slice(0, 400) : '';
    if (envPreview) envPreview.textContent = envToggle.checked ? 'We will send: ' + envInfo.value : '';
  }
  if (envToggle) {
    envToggle.addEventListener('change', syncEnv);
    syncEnv();
  }
}());
