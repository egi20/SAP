/* eslint-env browser */
/* global module */
/**
 * The calculator on /tax, and the prefill on /tax/apply.
 *
 * The two constants are NOT in this file: they arrive as data attributes on the form,
 * rendered from config/taxProgram.js, whose `estimate()` the server runs on an
 * application. One formula, one copy of its numbers. `compute` below is the same
 * arithmetic, and is exported for the unit test that pins it to the server's.
 */
(function (root) {
  'use strict';

  function compute(gross, net, fixedFee, costRate) {
    var g = Number(gross);
    var n = Number(net);
    if (!(g > 0) || !(n > 0)) return null;
    var cost = fixedFee + costRate * g;
    var newNet = g - cost;
    var saving = newNet - n;
    return {
      cost: cost,
      newNet: newNet,
      monthly: saving,
      annual: saving * 12,
      percent: Number(((saving / n) * 100).toFixed(1))
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compute: compute };
    return;
  }

  function fmt(n) {
    return (n < 0 ? '-€' : '€') + Math.abs(Math.round(n)).toLocaleString('en');
  }

  var doc = root.document;
  var form = doc.getElementById('taxCalcForm');
  if (form) {
    var fixedFee = Number(form.getAttribute('data-fixed-fee'));
    var costRate = Number(form.getAttribute('data-cost-rate'));

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var g = parseFloat(doc.getElementById('grossSalary').value);
      var n = parseFloat(doc.getElementById('netSalary').value);
      var r = compute(g, n, fixedFee, costRate);
      if (!r) { form.classList.add('was-validated'); return; }

      var out = {
        beforeGross: fmt(g), beforeTax: fmt(-(g - n)), beforeNet: fmt(n),
        afterGross: fmt(g), afterCost: fmt(-r.cost), afterNet: fmt(r.newNet),
        monthly: fmt(r.monthly), percent: String(r.percent), annual: fmt(r.annual)
      };
      Array.prototype.forEach.call(doc.querySelectorAll('#taxResult [data-out]'), function (el) {
        el.textContent = out[el.getAttribute('data-out')];
      });

      /*
       * The reference prints "You Save €-450/month — that's -6% more" when the new net is
       * lower. A negative saving is an answer, and the honest wording of it is that this
       * structure would not help; the Apply buttons go with it.
       */
      var positive = r.monthly > 0;
      doc.getElementById('taxSavingBox').classList.toggle('d-none', !positive);
      doc.getElementById('taxNoSaving').classList.toggle('d-none', positive);
      doc.getElementById('taxResultActions').classList.toggle('d-none', !positive);
      var box = doc.getElementById('taxResult');
      box.classList.remove('d-none');
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // Carried to /tax/apply so nobody types the same two numbers twice. sessionStorage
      // can throw in a private window; the form simply starts empty then.
      try {
        root.sessionStorage.setItem('taxEstimate', JSON.stringify({
          gross: g, net: n, country: doc.getElementById('country').value || ''
        }));
      } catch (e) { /* nothing to carry */ }
    });
  }

  // /tax/apply: prefill from the calculator, never over anything already typed.
  var apply = doc.querySelector('[data-tax-apply]');
  if (apply) {
    var est = null;
    try { est = JSON.parse(root.sessionStorage.getItem('taxEstimate') || 'null'); } catch (e) { est = null; }
    if (est) {
      var gi = doc.getElementById('currentGrossMonthly');
      var ni = doc.getElementById('currentNetMonthly');
      var ci = doc.getElementById('currentCountry');
      if (gi && !gi.value && est.gross) gi.value = Math.round(est.gross);
      if (ni && !ni.value && est.net) ni.value = Math.round(est.net);
      if (ci && !ci.value && est.country) {
        var known = Array.prototype.some.call(ci.options, function (o) { return o.value === est.country; });
        if (known) ci.value = est.country;
      }
    }
  }
}(typeof window !== 'undefined' ? window : this));
