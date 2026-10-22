/* eslint-env browser */
(function () {
  'use strict';

  /*
   * "SAP news of the day": turns the server-rendered slides into a carousel. Every slide is
   * already in the page with its link; without this file the first shows and the rest are a
   * list of links. ES2019 — it ships untranspiled.
   */
  var root = document.querySelector('[data-news]');
  if (!root) return;
  var slides = [].slice.call(root.querySelectorAll('[data-news-slide]'));
  if (slides.length < 2) return;

  var controls = root.querySelector('[data-news-controls]');
  var dotsBox = root.querySelector('[data-news-dots]');
  var dots = [].slice.call(root.querySelectorAll('[data-news-dot]'));
  var count = root.querySelector('[data-news-count]');
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var current = 0;

  controls.hidden = false;
  if (dotsBox) dotsBox.hidden = false;

  function show(n) {
    current = (n + slides.length) % slides.length;
    slides.forEach(function (s, i) {
      s.hidden = i !== current;
      s.classList.toggle('is-entering', i === current && !reduced);
    });
    dots.forEach(function (d, i) { d.classList.toggle('on', i === current); });
    count.textContent = (current + 1) + ' / ' + slides.length;
  }

  root.querySelector('[data-news-prev]').addEventListener('click', function () { show(current - 1); });
  root.querySelector('[data-news-next]').addEventListener('click', function () { show(current + 1); });
  dots.forEach(function (d) {
    d.addEventListener('click', function () { show(Number(d.getAttribute('data-news-dot'))); });
  });
  root.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight') show(current + 1);
    if (event.key === 'ArrowLeft') show(current - 1);
  });
  show(0);
}());
