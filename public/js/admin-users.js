/* eslint-env browser */
/**
 * /admin/users: the select-all boxes, the live count on "Delete Selected (N)", and the
 * single-delete modal's target.
 *
 * Nothing here decides anything. The server re-checks every id and every rule, and the
 * bulk form posts the count this script showed as `expected`, which the server compares
 * with the ids it received — a selection that changed between reading and pressing is
 * refused rather than acted on.
 */
(function () {
  'use strict';

  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row-select]'));
  var allBoxes = Array.prototype.slice.call(document.querySelectorAll('[data-select-all]'));
  var openButton = document.querySelector('[data-bulk-open]');
  var expected = document.querySelector('[data-bulk-expected]');

  function refresh() {
    var n = rows.filter(function (r) { return r.checked; }).length;
    Array.prototype.forEach.call(document.querySelectorAll('[data-bulk-count]'), function (el) {
      el.textContent = String(n);
    });
    if (openButton) openButton.disabled = n === 0;
    if (expected) expected.value = String(n);
    allBoxes.forEach(function (box) {
      box.checked = rows.length > 0 && n === rows.length;
      box.indeterminate = n > 0 && n < rows.length;
    });
  }

  allBoxes.forEach(function (box) {
    box.addEventListener('change', function () {
      rows.forEach(function (r) { r.checked = box.checked; });
      refresh();
    });
  });
  rows.forEach(function (r) { r.addEventListener('change', refresh); });
  refresh();

  var modal = document.getElementById('deleteUserModal');
  if (modal) {
    modal.addEventListener('show.bs.modal', function (event) {
      var trigger = event.relatedTarget;
      if (!trigger) return;
      var id = trigger.getAttribute('data-delete-id');
      modal.querySelector('[data-delete-form]').setAttribute('action', '/admin/users/' + encodeURIComponent(id) + '/delete');
      modal.querySelector('[data-delete-email]').textContent = trigger.getAttribute('data-delete-email');
    });
  }
}());
