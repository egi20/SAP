/* eslint-env browser */
(function () {
  'use strict';

  /**
   * The quick check on /dedupe: open a CSV file into the box, pick its columns, jump to a
   * line, and download the clean list.
   *
   * Everything here happens in the browser. A file is READ into the textarea and sent only as
   * the pasted text always was, so nothing about it is uploaded or stored on its own. The
   * download is built from a field the server already escaped; this script adds no logic of
   * its own to the matching.
   */
  var list = document.getElementById('dedupeList');
  if (!list) return;

  // --- Jump to a line -----------------------------------------------------------------
  document.querySelectorAll('.dedupe-line').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var n = parseInt(link.getAttribute('data-line'), 10);
      var lines = list.value.split('\n');
      if (!n || n > lines.length) return;
      e.preventDefault();
      var start = 0;
      for (var i = 0; i < n - 1; i += 1) start += lines[i].length + 1;
      var end = start + lines[n - 1].length;
      list.scrollIntoView({ behavior: 'smooth', block: 'center' });
      list.focus({ preventScroll: true });
      list.setSelectionRange(start, end);
      // Bring the selected line into view inside the box, not only the box into the page.
      var lineHeight = parseFloat(getComputedStyle(list).lineHeight) || 20;
      list.scrollTop = Math.max(0, (n - 3) * lineHeight);
    });
  });

  // --- Download the clean list as CSV -----------------------------------------------------
  document.querySelectorAll('[data-dedupe-download]').forEach(function (slot) {
    var source = document.getElementById(slot.getAttribute('data-dedupe-download'));
    if (!source) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-primary';
    button.innerHTML = '<i class="bi bi-download me-1" aria-hidden="true"></i>Download CSV';
    button.addEventListener('click', function () {
      // The byte-order mark is what makes Excel read "Müller" as UTF-8 rather than mojibake.
      var blob = new Blob(['﻿' + source.value], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'clean-list.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    slot.appendChild(button);
  });

  // --- Open a CSV file (button or drop) ------------------------------------------------------
  var fileSlot = document.querySelector('[data-dedupe-file]');
  var columnsBox = document.querySelector('[data-dedupe-columns]');

  /** RFC 4180 rows: quoted fields, doubled quotes, commas or semicolons as the separator. */
  function parseCsv(text) {
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var sep = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
    var rows = [];
    var row = [];
    var cell = '';
    var quoted = false;
    for (var i = 0; i < text.length; i += 1) {
      var c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') { quoted = false; } else { cell += c; }
      } else if (c === '"') {
        quoted = true;
      } else if (c === sep) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else {
        cell += c;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (v) { return v.trim() !== ''; }); });
  }

  function guess(headers, pattern) {
    for (var i = 0; i < headers.length; i += 1) if (pattern.test(headers[i])) return i;
    return -1;
  }

  function select(id, label, headers, chosen, optional) {
    var html = '<div class="col-sm-4"><label class="form-label small mb-1" for="' + id + '">' + label + '</label>'
      + '<select class="form-select form-select-sm" id="' + id + '">';
    if (optional) html += '<option value="-1">—</option>';
    headers.forEach(function (h, i) {
      var text = String(h || 'Column ' + (i + 1)).replace(/[<>&"]/g, '');
      html += '<option value="' + i + '"' + (i === chosen ? ' selected' : '') + '>' + text + '</option>';
    });
    return html + '</select></div>';
  }

  function useRows(rows) {
    if (!rows.length) return;
    if (rows[0].length < 2) {
      list.value = rows.map(function (r) { return r[0]; }).join('\n');
      columnsBox.classList.add('d-none');
      return;
    }
    // More than one column: ask which ones are the person, with a guess from the header.
    var headers = rows[0];
    var hasHeader = headers.some(function (h) { return /name|mail|vorname|nachname|surname/i.test(h); });
    var email = guess(headers, /e-?mail/i);
    var first = guess(headers, /^(first|given|vorname|first ?name)/i);
    var last = guess(headers, /^(last|family|sur|nachname|last ?name)/i);
    var full = guess(headers, /name/i);
    var name1 = first >= 0 ? first : (full >= 0 ? full : 0);
    var name2 = first >= 0 ? last : -1;
    columnsBox.innerHTML = '<div class="border rounded-3 p-3"><div class="small fw-semibold mb-2">Which columns are the person?</div>'
      + '<div class="row g-2 align-items-end">'
      + select('dedupeColName', 'Name', headers, name1, false)
      + select('dedupeColName2', 'Second name column', headers, name2, true)
      + select('dedupeColEmail', 'Email', headers, email, true)
      + '</div><div class="form-check small mt-2"><input class="form-check-input" type="checkbox" id="dedupeHeader"' + (hasHeader ? ' checked' : '') + '>'
      + '<label class="form-check-label" for="dedupeHeader">The first row is a header</label></div>'
      + '<button type="button" class="btn btn-sm btn-primary mt-2" id="dedupeUseColumns">Put these columns in the box</button></div>';
    columnsBox.classList.remove('d-none');
    document.getElementById('dedupeUseColumns').addEventListener('click', function () {
      var n1 = parseInt(document.getElementById('dedupeColName').value, 10);
      var n2 = parseInt(document.getElementById('dedupeColName2').value, 10);
      var em = parseInt(document.getElementById('dedupeColEmail').value, 10);
      var body = document.getElementById('dedupeHeader').checked ? rows.slice(1) : rows;
      list.value = body.map(function (r) {
        var name = [r[n1], n2 >= 0 ? r[n2] : ''].filter(function (v) { return v && v.trim(); }).join(' ').trim();
        var mail = em >= 0 && r[em] ? r[em].trim() : '';
        return [name, mail].filter(Boolean).join(', ');
      }).filter(Boolean).join('\n');
      columnsBox.classList.add('d-none');
      list.focus();
    });
  }

  function readFile(file) {
    if (!file) return;
    if (/\.(xlsx?|ods)$/i.test(file.name)) {
      columnsBox.innerHTML = '<div class="alert alert-info small mb-0">An Excel file cannot be read here. In Excel, choose '
        + 'File › Save As › CSV, and open that file instead.</div>';
      columnsBox.classList.remove('d-none');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { useRows(parseCsv(String(reader.result || ''))); };
    reader.readAsText(file);
  }

  if (fileSlot && window.FileReader) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.txt,text/csv,text/plain';
    input.className = 'd-none';
    input.id = 'dedupeFile';
    var button = document.createElement('label');
    button.className = 'btn btn-sm btn-outline-primary mb-0';
    button.setAttribute('for', 'dedupeFile');
    button.innerHTML = '<i class="bi bi-upload me-1" aria-hidden="true"></i>Open a CSV file';
    input.addEventListener('change', function () { readFile(input.files && input.files[0]); input.value = ''; });
    fileSlot.appendChild(input);
    fileSlot.appendChild(button);

    list.addEventListener('dragover', function (e) { e.preventDefault(); list.classList.add('dedupe-drop'); });
    list.addEventListener('dragleave', function () { list.classList.remove('dedupe-drop'); });
    list.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      list.classList.remove('dedupe-drop');
      readFile(e.dataTransfer.files[0]);
    });
    list.setAttribute('placeholder', list.getAttribute('placeholder') + '\n\n… or drop a CSV file here');
  }
})();
