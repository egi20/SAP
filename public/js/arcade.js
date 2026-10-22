/* eslint-env browser */
(function () {
  'use strict';

  /*
   * The arcade games (views/games/arcade.ejs). ES2019 — it ships untranspiled.
   *
   * Nothing here knows an answer. Every face, every statement's truth and every right bite
   * comes back from the server in reply to a move, and a finished run is graded from what
   * the SERVER recorded; this file only draws, animates and asks.
   */
  var root = document.querySelector('[data-arcade]');
  if (!root) return;
  var key = root.getAttribute('data-arcade');
  var practice = root.getAttribute('data-practice') === '1';
  var tokenMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = tokenMeta ? tokenMeta.getAttribute('content') : '';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var resultBox = root.querySelector('[data-arcade-result]');

  function post(path, body) {
    return fetch('/games/' + key + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.status = res.status;
        return data;
      });
    });
  }

  function finish() {
    return post('/finish').then(function (data) {
      if (data.redirect && !data.practice) {
        window.location.assign(data.redirect);
        return;
      }
      resultBox.hidden = false;
      resultBox.textContent = '';
      var big = document.createElement('div');
      big.className = 'arcade-result-score';
      big.textContent = (data.score || 0) + ' / ' + (data.total || 0);
      var note = document.createElement('p');
      note.className = 'mb-2';
      note.textContent = data.practice ? 'Practice run — no points, as promised. Reload to go again.' : 'Saved.';
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn btn-primary btn-sm rounded-pill px-3';
      again.textContent = 'Play again';
      again.addEventListener('click', function () { window.location.reload(); });
      resultBox.appendChild(big);
      resultBox.appendChild(note);
      resultBox.appendChild(again);
      if (!reduced) burst(resultBox);
    });
  }

  /* A small celebration: a few coloured dots that fly out and fade. Purely decorative. */
  function burst(target) {
    var colours = ['#0070f2', '#7858ff', '#1aa35c', '#e0a100', '#df1278'];
    for (var i = 0; i < 18; i += 1) {
      var dot = document.createElement('span');
      dot.className = 'arcade-confetti';
      dot.style.background = colours[i % colours.length];
      dot.style.setProperty('--dx', (Math.random() * 240 - 120) + 'px');
      dot.style.setProperty('--dy', (-Math.random() * 160 - 40) + 'px');
      target.appendChild(dot);
      setTimeout(function (d) { return function () { d.remove(); }; }(dot), 1100);
    }
  }

  /* ================================================================ Memory */
  if (key === 'memory') {
    var grid = root.querySelector('[data-mem-grid]');
    var cards = [].slice.call(grid.querySelectorAll('[data-card]'));
    var turnsEl = root.querySelector('[data-mem-turns]');
    var foundEl = root.querySelector('[data-mem-found]');
    var busy = false;
    var open = null;

    var showFace = function (i, face, side) {
      var card = cards[i];
      card.querySelector('.mem-front').textContent = face;
      card.classList.toggle('is-code', side === 'code');
      card.classList.add('is-up');
      card.setAttribute('aria-label', 'Card ' + (i + 1) + ': ' + face);
    };
    var hide = function (i) {
      var card = cards[i];
      card.classList.remove('is-up');
      card.setAttribute('aria-label', 'Card ' + (i + 1) + ', face down');
    };

    try {
      JSON.parse(grid.getAttribute('data-restore') || '[]').forEach(function (m) {
        showFace(m.i, m.face, m.side);
        cards[m.i].classList.add('is-matched');
        cards[m.i].disabled = true;
      });
    } catch (err) { /* nothing to restore */ }

    grid.addEventListener('click', function (event) {
      var card = event.target.closest('[data-card]');
      if (!card || busy || card.classList.contains('is-matched') || card.classList.contains('is-up')) return;
      var i = Number(card.getAttribute('data-card'));
      busy = true;
      post('/flip', { card: i }).then(function (data) {
        if (!data.face) { busy = false; return; }
        showFace(i, data.face, data.side);
        if (data.pair === undefined) {
          open = i;
          busy = false;
          return;
        }
        turnsEl.textContent = data.turns;
        foundEl.textContent = data.found;
        var a = data.pair[0];
        var b = data.pair[1];
        open = null;
        if (data.match) {
          [a, b].forEach(function (n) { cards[n].classList.add('is-matched'); cards[n].disabled = true; });
          busy = false;
          if (data.complete) setTimeout(finish, reduced ? 0 : 700);
        } else {
          [a, b].forEach(function (n) { cards[n].classList.add('is-miss'); });
          setTimeout(function () {
            [a, b].forEach(function (n) { cards[n].classList.remove('is-miss'); hide(n); });
            busy = false;
          }, reduced ? 400 : 1000);
        }
      }).catch(function () { busy = false; });
    });
    return;
  }

  /* ================================================================ Lightning */
  if (key === 'lightning') {
    var startBox = root.querySelector('[data-lt-start]');
    var play = root.querySelector('[data-lt-play]');
    var bar = root.querySelector('[data-lt-bar]');
    var timeEl = root.querySelector('[data-lt-time]');
    var countEl = root.querySelector('[data-lt-count]');
    var streakEl = root.querySelector('[data-lt-streak]');
    var scoreEl = root.querySelector('[data-lt-score]');
    var card = root.querySelector('[data-lt-card]');
    var termEl = root.querySelector('[data-lt-term]');
    var shownEl = root.querySelector('[data-lt-shown]');
    var feedback = root.querySelector('[data-lt-feedback]');
    var items = [];
    var index = 0;
    var seconds = 60;
    var deadline = 0;
    var ticker = null;
    var streak = 0;
    var score = 0;
    var locked = false;
    var ended = false;

    var end = function () {
      if (ended) return;
      ended = true;
      clearInterval(ticker);
      play.classList.add('is-over');
      finish();
    };
    var render = function () {
      if (index >= items.length) { end(); return; }
      var item = items[index];
      termEl.textContent = item.term;
      shownEl.textContent = item.shown;
      countEl.textContent = index + 1;
      card.classList.remove('is-right', 'is-wrong');
      if (!reduced) { card.classList.remove('is-in'); void card.offsetWidth; card.classList.add('is-in'); }
    };
    var answer = function (value) {
      if (locked || ended || index >= items.length) return;
      locked = true;
      var item = items[index];
      post('/answer', { id: item.id, value: value }).then(function (data) {
        if (data.timeUp) { end(); return; }
        if (data.correct) {
          score += 1; streak += 1;
          card.classList.add('is-right');
          feedback.textContent = 'Right!' + (streak >= 3 ? ' ' + streak + ' in a row 🔥' : '');
        } else {
          streak = 0;
          card.classList.add('is-wrong');
          feedback.textContent = data.truth ? 'It was true.' : 'False — ' + item.term + ' is: ' + data.meaning;
        }
        scoreEl.textContent = score;
        streakEl.textContent = streak;
        setTimeout(function () { index += 1; locked = false; render(); }, reduced ? 150 : (data.correct ? 350 : 900));
      }).catch(function () { locked = false; });
    };
    var tick = function () {
      var left = Math.max(0, (deadline - Date.now()) / 1000);
      timeEl.textContent = Math.ceil(left);
      bar.style.width = (100 * left / seconds) + '%';
      bar.classList.toggle('is-low', left < 10);
      if (left <= 0) end();
    };

    root.querySelector('[data-lt-go]').addEventListener('click', function () {
      post('/start').then(function (data) {
        if (!data.items) return;
        items = data.items;
        seconds = data.seconds;
        deadline = Date.now() + data.remaining * 1000;
        startBox.hidden = true;
        play.hidden = false;
        render();
        tick();
        ticker = setInterval(tick, 200);
        if (data.remaining <= 0) end();
      });
    });
    [].slice.call(root.querySelectorAll('[data-lt-answer]')).forEach(function (b) {
      b.addEventListener('click', function () { answer(b.getAttribute('data-lt-answer')); });
    });
    document.addEventListener('keydown', function (event) {
      if (play.hidden) return;
      if (event.key === 'ArrowLeft' || event.key === 'f' || event.key === 'F') { event.preventDefault(); answer('false'); }
      if (event.key === 'ArrowRight' || event.key === 't' || event.key === 'T') { event.preventDefault(); answer('true'); }
    });
    return;
  }

  /* ================================================================ Snake */
  if (key === 'snake') {
    var canvas = root.querySelector('[data-sn-canvas]');
    var ctx = canvas.getContext('2d');
    var overlay = root.querySelector('[data-sn-overlay]');
    var message = root.querySelector('[data-sn-message]');
    var promptEl = root.querySelector('[data-sn-prompt]');
    var livesEl = root.querySelector('[data-sn-lives]');
    var scoreEl2 = root.querySelector('[data-sn-score]');
    var stepEl = root.querySelector('[data-sn-step]');
    var feedbackEl = root.querySelector('[data-sn-feedback]');
    var COLS = 22;
    var ROWS = 14;
    var CELL = canvas.width / COLS;
    var questions = [];
    var q = 0;
    var snake = [];
    var dir = { x: 1, y: 0 };
    var nextDir = dir;
    var foods = [];
    var grow = 0;
    var lives = 3;
    var right = 0;
    var speed = 170;
    var timer = null;
    var running = false;
    var paused = false;
    var waiting = false;
    var over = false;
    var flash = null;

    var free = function (x, y) {
      return !snake.some(function (s) { return s.x === x && s.y === y; }) && !foods.some(function (f) { return f.x === x && f.y === y; });
    };
    var placeFoods = function () {
      foods = [];
      var item = questions[q];
      item.options.forEach(function (label, i) {
        var tries = 0;
        var x; var y;
        do {
          x = 1 + Math.floor(Math.random() * (COLS - 2));
          y = 1 + Math.floor(Math.random() * (ROWS - 2));
          tries += 1;
        } while ((!free(x, y) || Math.abs(x - snake[0].x) + Math.abs(y - snake[0].y) < 4) && tries < 200);
        foods.push({ x: x, y: y, label: label, choice: i });
      });
      promptEl.textContent = item.prompt;
      stepEl.textContent = q;
    };
    var roundRect = function (x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    var draw = function () {
      ctx.fillStyle = '#0b1f45';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      for (var gx = 0; gx <= COLS; gx += 1) { ctx.beginPath(); ctx.moveTo(gx * CELL, 0); ctx.lineTo(gx * CELL, canvas.height); ctx.stroke(); }
      for (var gy = 0; gy <= ROWS; gy += 1) { ctx.beginPath(); ctx.moveTo(0, gy * CELL); ctx.lineTo(canvas.width, gy * CELL); ctx.stroke(); }
      foods.forEach(function (f, i) {
        var colours = ['#7858ff', '#0899a7', '#e0a100', '#df1278'];
        ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
        var w = Math.max(CELL, ctx.measureText(f.label).width + 12);
        var cx = f.x * CELL + CELL / 2;
        roundRect(cx - w / 2, f.y * CELL + 3, w, CELL - 6, 8);
        ctx.fillStyle = colours[i % colours.length];
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.label, cx, f.y * CELL + CELL / 2 + 1);
      });
      snake.forEach(function (s, i) {
        var t = i / Math.max(1, snake.length - 1);
        ctx.fillStyle = i === 0 ? '#5ef0a0' : 'rgba(26,163,92,' + (1 - t * 0.55) + ')';
        roundRect(s.x * CELL + 2, s.y * CELL + 2, CELL - 4, CELL - 4, 7);
        ctx.fill();
      });
      if (snake.length) {
        var h = snake[0];
        ctx.fillStyle = '#0b1f45';
        ctx.beginPath();
        ctx.arc(h.x * CELL + CELL / 2 + dir.x * 5 - dir.y * 5, h.y * CELL + CELL / 2 + dir.y * 5 - dir.x * 5, 2.6, 0, Math.PI * 2);
        ctx.arc(h.x * CELL + CELL / 2 + dir.x * 5 + dir.y * 5, h.y * CELL + CELL / 2 + dir.y * 5 + dir.x * 5, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      if (flash) {
        ctx.fillStyle = flash === 'good' ? 'rgba(94,240,160,0.18)' : 'rgba(224,38,27,0.22)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };
    var showOverlay = function (text, button) {
      message.textContent = text;
      overlay.querySelector('[data-sn-go]').textContent = button;
      overlay.hidden = false;
    };
    var gameOver = function (why) {
      if (over) return;
      over = true;
      running = false;
      clearInterval(timer);
      showOverlay(why + ' You got ' + right + ' of ' + questions.length + '.', 'Saving…');
      overlay.querySelector('[data-sn-go]').disabled = true;
      finish();
    };
    var restart = function () { clearInterval(timer); timer = setInterval(step, speed); };
    var eat = function (food) {
      waiting = true;
      var item = questions[q];
      post('/eat', { id: item.id, choice: food.choice }).then(function (data) {
        if (data.correct) {
          right += 1; grow += 2;
          speed = Math.max(85, speed - 10);
          flash = 'good';
          feedbackEl.textContent = '✓ ' + data.explain;
        } else {
          lives -= 1;
          flash = 'bad';
          feedbackEl.textContent = '✗ The answer was ' + data.answer + '. ' + data.explain;
        }
        scoreEl2.textContent = right;
        livesEl.textContent = lives;
        setTimeout(function () { flash = null; }, 250);
        q += 1;
        stepEl.textContent = q;
        waiting = false;
        if (lives <= 0) { gameOver('Out of lives.'); return; }
        if (q >= questions.length) { gameOver('All done!'); return; }
        placeFoods();
        restart();
      }).catch(function () { waiting = false; });
    };
    var step = function () {
      if (!running || paused || waiting) return;
      dir = nextDir;
      var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS) { draw(); gameOver('Wall!'); return; }
      if (snake.some(function (s) { return s.x === head.x && s.y === head.y; })) { draw(); gameOver('You bit yourself!'); return; }
      snake.unshift(head);
      var food = null;
      foods.forEach(function (f) { if (f.x === head.x && f.y === head.y) food = f; });
      if (grow > 0) grow -= 1; else snake.pop();
      draw();
      if (food) { foods = []; eat(food); }
    };
    var turn = function (name) {
      var d = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[name];
      if (!d || (d.x === -dir.x && d.y === -dir.y)) return;
      nextDir = d;
    };

    overlay.querySelector('[data-sn-go]').addEventListener('click', function () {
      if (over) return;
      if (paused) { paused = false; overlay.hidden = true; return; }
      post('/start').then(function (data) {
        if (!data.items) return;
        var locked = data.locked || [];
        questions = data.items.filter(function (i) { return locked.indexOf(i.id) === -1; });
        if (!questions.length) { gameOver('This run is already answered.'); return; }
        snake = [{ x: 5, y: 7 }, { x: 4, y: 7 }, { x: 3, y: 7 }];
        dir = { x: 1, y: 0 }; nextDir = dir;
        overlay.hidden = true;
        running = true;
        placeFoods();
        draw();
        restart();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (!running) return;
      var map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
      if (map[event.key]) { event.preventDefault(); turn(map[event.key]); }
      if (event.key === ' ') {
        event.preventDefault();
        paused = !paused;
        if (paused) showOverlay('Paused.', 'Resume'); else overlay.hidden = true;
      }
    });
    [].slice.call(root.querySelectorAll('[data-sn-dir]')).forEach(function (b) {
      b.addEventListener('click', function () { turn(b.getAttribute('data-sn-dir')); });
    });
    var touch = null;
    canvas.addEventListener('touchstart', function (e) { touch = e.touches[0]; }, { passive: true });
    canvas.addEventListener('touchend', function (e) {
      if (!touch) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touch.clientX;
      var dy = t.clientY - touch.clientY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > 20) turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      touch = null;
    }, { passive: true });
    draw();
    if (practice) feedbackEl.textContent = '';
  }
}());
