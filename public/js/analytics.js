/*
 * Google Analytics 4, behind a real choice.
 *
 * Loaded only when GA4_MEASUREMENT_ID is configured (views/partials/footer.ejs). With it
 * configured the site sets a cookie a visitor can refuse, so the plain cookie notice in
 * main.js stands down and this asks instead — and nothing is requested from Google until
 * the visitor presses "Allow analytics". "Decline" is the same size and the same weight:
 * a choice with one button made easy and the other hidden is not a choice.
 *
 * The answer lives in localStorage, like the notice's dismissal, never in a cookie. If
 * storage throws (private browsing), the question is asked again on every page and GA4
 * never loads — the honest failure, since we cannot remember a yes.
 *
 * "Analytics choices" in the footer reopens the question. Withdrawing deletes the _ga
 * cookies this site set and stops the tag for the rest of the page.
 */
(function analyticsConsent() {
  var meta = document.querySelector('meta[name="ga4-id"]');
  if (!meta) return;
  var ID = meta.getAttribute('content');
  var KEY = 'saphub.analyticsConsent';

  function read() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (err) {
      return null;
    }
  }

  function write(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch (err) {
      // Not remembered: the question comes back on the next page, and nothing loads.
    }
  }

  var loaded = false;
  // The admin surface and administrators are not measured: the answer is kept, the tag is not loaded.
  var measureOff = Boolean(document.querySelector('meta[name="analytics-measure"][content="off"]'));
  function loadGa4() {
    if (loaded || measureOff) return;
    loaded = true;
    window['ga-disable-' + ID] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ID, { anonymize_ip: true });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
    document.head.appendChild(s);
  }

  function removeGaCookies() {
    window['ga-disable-' + ID] = true;
    var host = window.location.hostname;
    var domains = ['', host, '.' + host, '.' + host.split('.').slice(-2).join('.')];
    document.cookie.split(';').forEach(function (pair) {
      var name = pair.split('=')[0].trim();
      if (name !== '_ga' && name.indexOf('_ga_') !== 0) return;
      domains.forEach(function (d) {
        document.cookie = name + '=; Max-Age=0; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }

  var bar = null;
  function closeBar() {
    if (bar) bar.remove();
    bar = null;
    document.body.classList.remove('has-cookie-notice');
  }

  function ask() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'cookie-notice';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Analytics choice');
    bar.innerHTML =
      '<p class="cookie-notice-text">' +
        'We would like to count visits with <strong>Google Analytics</strong>, which sets cookies ' +
        'and sends the visit to Google. It stays off unless you allow it, and the site works the ' +
        'same either way. <a href="/legal/privacy#cookies">Details</a>.' +
      '</p>';

    var actions = document.createElement('div');
    actions.className = 'cookie-notice-actions';

    var allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'btn btn-primary btn-sm';
    allow.textContent = 'Allow analytics';
    allow.addEventListener('click', function () {
      write('granted');
      closeBar();
      loadGa4();
    });

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'btn btn-primary btn-sm';
    decline.textContent = 'Decline';
    decline.addEventListener('click', function () {
      write('denied');
      closeBar();
      removeGaCookies();
    });

    actions.appendChild(allow);
    actions.appendChild(decline);
    bar.appendChild(actions);
    document.body.appendChild(bar);
    document.body.classList.add('has-cookie-notice');
  }

  var answer = read();
  if (answer === 'granted') loadGa4();
  else if (answer !== 'denied') ask();

  document.querySelectorAll('[data-analytics-choices]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (read() === 'granted') removeGaCookies();
      try {
        window.localStorage.removeItem(KEY);
      } catch (err) {
        // Nothing stored to remove.
      }
      ask();
    });
  });
}());
