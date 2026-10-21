/* eslint-env browser */
/**
 * /report-issue: paste a screenshot straight into the message, and see what is attached.
 *
 * A pasted image is added to the form's own file input through DataTransfer, so it is sent
 * exactly as a chosen file would be and the server needs nothing new to accept it. Without
 * this script the file input still works on its own. The limits shown here are read from
 * the input's data attributes, which the server rendered from middleware/fileUpload.js —
 * the server enforces them again whatever this file does.
 */
(function () {
  'use strict';

  var input = document.querySelector('[data-screenshots]');
  var list = document.querySelector('[data-screenshot-list]');
  var message = document.getElementById('f-message');
  if (!input || !list || typeof DataTransfer === 'undefined') return;

  var maxFiles = Number(input.getAttribute('data-max-files')) || 5;
  var maxBytes = (Number(input.getAttribute('data-max-mb')) || 10) * 1024 * 1024;
  var ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

  function setFiles(files) {
    var dt = new DataTransfer();
    files.slice(0, maxFiles).forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    render();
  }

  function current() {
    return Array.prototype.slice.call(input.files || []);
  }

  function render() {
    list.textContent = '';
    current().forEach(function (file, index) {
      var li = document.createElement('li');
      li.className = 'd-flex align-items-center gap-2 mt-1';
      var name = document.createElement('span');
      var tooBig = file.size > maxBytes;
      name.textContent = file.name + ' (' + Math.max(1, Math.round(file.size / 1024)) + ' KB)' +
        (tooBig ? ' — too large, it will be refused' : '');
      if (tooBig) name.className = 'text-danger';
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-link btn-sm p-0';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove ' + file.name);
      remove.addEventListener('click', function () {
        var files = current();
        files.splice(index, 1);
        setFiles(files);
      });
      li.appendChild(name);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  input.addEventListener('change', function () {
    if (current().length > maxFiles) setFiles(current());
    else render();
  });

  if (message) {
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
}());
