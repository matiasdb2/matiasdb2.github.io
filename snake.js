/*
  Snake, with a per-player leaderboard.

  Scores are stored per device in localStorage by default (GitHub Pages is static,
  so there is no server to keep them). For a leaderboard shared across visitors,
  fill window.SNAKE_CONFIG in index.html with a Supabase project URL and anon key,
  and create this table in the Supabase SQL editor:

    create table public.snake_scores (
      id         bigint generated always as identity primary key,
      name       text not null check (char_length(name) between 1 and 16),
      score      int  not null check (score between 0 and 100000),
      created_at timestamptz not null default now()
    );
    alter table public.snake_scores enable row level security;
    create policy "read scores"   on public.snake_scores for select to anon using (true);
    create policy "insert scores" on public.snake_scores for insert to anon with check (true);

  The anon key is public by design; anyone can post a score with curl, so treat
  the global board as for fun, not as a record.
*/
(function () {
  'use strict';

  var GRID = 20;
  var START_TICK = 140;   // ms per step
  var MIN_TICK = 65;
  var GOLD_TTL = 5000;    // ms a gold apple stays on the board
  var STORE_KEY = 'mb.snake.v1';
  var NAME_KEY = 'mb.snake.name';

  var dialog = document.getElementById('snake-dialog');
  var canvas = document.getElementById('snake-canvas');
  var ctx = canvas.getContext('2d');
  var elScore = document.getElementById('snake-score');
  var elMult = document.getElementById('snake-mult');
  var elBest = document.getElementById('snake-best');
  var elName = document.getElementById('snake-name');
  var elBoard = document.getElementById('snake-board');
  var elTabs = document.getElementById('snake-tabs');

  var cfg = window.SNAKE_CONFIG || {};
  var hasGlobal = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  var boardMode = 'local';

  // ── storage ──────────────────────────────────────────────
  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  function loadLocal() {
    try { return JSON.parse(safeGet(STORE_KEY)) || { players: {} }; }
    catch (e) { return { players: {} }; }
  }
  function saveLocal(data) { safeSet(STORE_KEY, JSON.stringify(data)); }

  function cleanName(raw) {
    return String(raw || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 16);
  }
  function playerName() { return cleanName(elName.value) || 'anonymous'; }

  function recordLocal(name, score) {
    var data = loadLocal();
    var p = data.players[name] || { best: 0, games: 0 };
    p.games += 1;
    if (score > p.best) { p.best = score; p.at = Date.now(); }
    data.players[name] = p;
    saveLocal(data);
    return p.best;
  }

  function localBest(name) {
    var p = loadLocal().players[name];
    return p ? p.best : 0;
  }

  function localTop() {
    var players = loadLocal().players;
    return Object.keys(players)
      .map(function (n) { return { name: n, best: players[n].best, games: players[n].games }; })
      .filter(function (r) { return r.best > 0; })
      .sort(function (a, b) { return b.best - a.best; })
      .slice(0, 10);
  }

  function sbFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + cfg.supabaseAnonKey,
      'Content-Type': 'application/json'
    }, opts.headers || {});
    return fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + path, opts);
  }

  function globalTop() {
    return sbFetch('snake_scores?select=name,score&order=score.desc&limit=200')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (rows) {
        var seen = {}, out = [];
        rows.forEach(function (r) {
          if (seen[r.name] || out.length >= 10) return;
          seen[r.name] = true;
          out.push({ name: r.name, best: r.score });
        });
        return out;
      });
  }

  function recordGlobal(name, score) {
    if (!hasGlobal || score <= 0 || name === 'anonymous') return Promise.resolve();
    return sbFetch('snake_scores', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ name: name, score: score })
    }).catch(function () {});
  }

  // ── leaderboard UI ───────────────────────────────────────
  function renderBoard(rows) {
    var me = playerName();
    elBoard.textContent = '';
    if (!rows.length) {
      var li = document.createElement('li');
      li.className = 'empty mono';
      li.textContent = boardMode === 'global' ? 'No scores yet. Be first.' : 'No games on this device yet.';
      elBoard.appendChild(li);
      return;
    }
    rows.forEach(function (r, i) {
      var li = document.createElement('li');
      if (r.name === me) li.className = 'me';
      var rank = document.createElement('span'); rank.className = 'mono'; rank.textContent = String(i + 1).padStart(2, '0');
      var name = document.createElement('span'); name.className = 'name'; name.textContent = r.name;
      var pts = document.createElement('span'); pts.className = 'mono'; pts.textContent = r.best;
      li.append(rank, name, pts);
      elBoard.appendChild(li);
    });
  }

  function refreshBoard() {
    elBest.textContent = localBest(playerName());
    if (boardMode === 'global') {
      elBoard.innerHTML = '<li class="empty mono">loading…</li>';
      globalTop().then(renderBoard).catch(function () {
        elBoard.innerHTML = '<li class="empty mono">Couldn’t reach the global board.</li>';
      });
    } else {
      renderBoard(localTop());
    }
  }

  if (hasGlobal) {
    elTabs.hidden = false;
    elTabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-board]');
      if (!b) return;
      boardMode = b.getAttribute('data-board');
      elTabs.querySelectorAll('button').forEach(function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      refreshBoard();
    });
  }

  elName.value = safeGet(NAME_KEY) || '';
  elName.addEventListener('change', function () {
    elName.value = cleanName(elName.value);
    safeSet(NAME_KEY, elName.value);
    refreshBoard();
  });
  // Let people type a name without steering the snake.
  elName.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      elName.dispatchEvent(new Event('change'));
      canvas.focus();
      start();
    }
  });

  // ── game state ───────────────────────────────────────────
  var snake, dir, queue, apple, gold, score, eaten, tick, state, acc, last, raf;
  // state: 'ready' | 'running' | 'paused' | 'over'

  var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function reset() {
    var mid = Math.floor(GRID / 2);
    snake = [[mid, mid], [mid - 1, mid], [mid - 2, mid]];
    dir = 'right';
    queue = [];
    score = 0;
    eaten = 0;
    tick = START_TICK;
    gold = null;
    apple = freeCell();
    state = 'ready';
    updateHud();
    draw();
  }

  function multiplier() { return 1 + Math.floor(eaten / 5); }

  function freeCell() {
    var taken = {};
    snake.forEach(function (s) { taken[s[0] + ',' + s[1]] = 1; });
    if (apple) taken[apple[0] + ',' + apple[1]] = 1;
    if (gold) taken[gold.x + ',' + gold.y] = 1;
    var free = [];
    for (var x = 0; x < GRID; x++) for (var y = 0; y < GRID; y++) if (!taken[x + ',' + y]) free.push([x, y]);
    return free[Math.floor(Math.random() * free.length)] || null;
  }

  function turn(d) {
    var lastDir = queue.length ? queue[queue.length - 1] : dir;
    var a = DIRS[lastDir], b = DIRS[d];
    if (a[0] + b[0] === 0 && a[1] + b[1] === 0) return; // no reversing
    if (d === lastDir || queue.length > 2) return;
    queue.push(d);
  }

  function step(now) {
    if (queue.length) dir = queue.shift();
    var v = DIRS[dir];
    var head = [snake[0][0] + v[0], snake[0][1] + v[1]];

    var hitWall = head[0] < 0 || head[1] < 0 || head[0] >= GRID || head[1] >= GRID;
    var willGrow = apple && head[0] === apple[0] && head[1] === apple[1];
    var body = willGrow ? snake : snake.slice(0, -1);
    var hitSelf = body.some(function (s) { return s[0] === head[0] && s[1] === head[1]; });
    if (hitWall || hitSelf) return gameOver();

    snake.unshift(head);
    if (willGrow) {
      score += 10 * multiplier();
      eaten += 1;
      tick = Math.max(MIN_TICK, tick - 3);
      apple = freeCell();
      if (!gold && eaten % 7 === 0) {
        var c = freeCell();
        if (c) gold = { x: c[0], y: c[1], until: now + GOLD_TTL };
      }
    } else {
      snake.pop();
    }

    if (gold && head[0] === gold.x && head[1] === gold.y) {
      score += 50;
      gold = null;
    }
    if (gold && now > gold.until) gold = null;
    updateHud();
  }

  function gameOver() {
    state = 'over';
    var name = playerName();
    var prev = localBest(name);
    recordLocal(name, score);
    recordGlobal(name, score).then(function () { if (boardMode === 'global') refreshBoard(); });
    lastResult = { score: score, record: score > prev && score > 0 };
    refreshBoard();
    draw();
  }
  var lastResult = null;

  function updateHud() {
    elScore.textContent = score;
    elMult.textContent = '×' + multiplier();
  }

  // ── loop ─────────────────────────────────────────────────
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (last == null) last = t;
    var dt = Math.min(250, t - last);
    last = t;
    if (state === 'running') {
      acc += dt;
      while (acc >= tick && state === 'running') { acc -= tick; step(t); }
    }
    draw(t);
  }

  function start() {
    if (state === 'running') return;
    if (state === 'over') reset();
    if (!elName.value.trim()) {
      // not required, but nudge once
      elName.placeholder = 'your name (for the board)';
    }
    state = 'running';
    acc = 0;
  }

  function togglePause() {
    if (state === 'running') state = 'paused';
    else if (state === 'paused') state = 'running';
    else start();
  }

  // ── drawing ──────────────────────────────────────────────
  var colors = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['--bg-alt', '--fg', '--muted', '--line', '--accent', '--bg'].forEach(function (k) {
      colors[k] = cs.getPropertyValue(k).trim();
    });
  }
  document.addEventListener('themechange', readColors);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

  function draw(t) {
    var size = canvas.width;
    var cell = size / GRID;
    ctx.fillStyle = colors['--bg-alt'];
    ctx.fillRect(0, 0, size, size);

    // faint dot grid
    ctx.fillStyle = colors['--line'];
    for (var x = 0; x < GRID; x++) for (var y = 0; y < GRID; y++) {
      ctx.fillRect(x * cell + cell / 2 - 1, y * cell + cell / 2 - 1, 2, 2);
    }

    if (apple) {
      ctx.fillStyle = colors['--accent'];
      ctx.beginPath();
      ctx.arc(apple[0] * cell + cell / 2, apple[1] * cell + cell / 2, cell * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }

    if (gold) {
      var left = Math.max(0, gold.until - (t || performance.now()));
      var blink = left < 1500 && Math.floor(left / 150) % 2 === 0;
      if (!blink) {
        ctx.fillStyle = '#e0a526';
        ctx.fillRect(gold.x * cell + cell * 0.2, gold.y * cell + cell * 0.2, cell * 0.6, cell * 0.6);
      }
    }

    snake.forEach(function (s, i) {
      ctx.fillStyle = colors['--fg'];
      ctx.globalAlpha = i === 0 ? 1 : Math.max(0.45, 1 - i * 0.02);
      var pad = i === 0 ? 1 : 2;
      ctx.fillRect(s[0] * cell + pad, s[1] * cell + pad, cell - pad * 2, cell - pad * 2);
    });
    ctx.globalAlpha = 1;

    if (state !== 'running') {
      ctx.fillStyle = colors['--bg'];
      ctx.globalAlpha = 0.82;
      ctx.fillRect(0, size / 2 - 56, size, 112);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors['--fg'];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var title, sub;
      if (state === 'ready') { title = 'Ready.'; sub = 'enter / tap to start'; }
      else if (state === 'paused') { title = 'Paused.'; sub = 'space to resume'; }
      else {
        title = (lastResult && lastResult.record ? 'New best: ' : 'Game over: ') + score;
        sub = 'enter / tap to play again';
      }
      ctx.font = '400 38px "Instrument Serif", serif';
      ctx.fillText(title, size / 2, size / 2 - 12);
      ctx.font = '400 13px "Geist Mono", monospace';
      ctx.fillStyle = colors['--muted'];
      ctx.fillText(sub, size / 2, size / 2 + 26);
    }
  }

  // ── input ────────────────────────────────────────────────
  var KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right'
  };

  // Listen on the document so keys still work if focus drifts out of the dialog.
  document.addEventListener('keydown', function (e) {
    if (!dialog.open || e.target === elName) return;
    var d = KEYMAP[e.key];
    if (d) {
      e.preventDefault();
      if (state === 'ready' || state === 'over') start();
      if (state === 'running') turn(d);
    } else if (e.key === ' ') {
      e.preventDefault(); togglePause();
    } else if (e.key === 'Enter') {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault(); start();
    }
  });

  var touchStart = null;
  canvas.addEventListener('pointerdown', function (e) {
    touchStart = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!touchStart) return;
    var dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
    touchStart = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) {
      if (state === 'running') state = 'paused'; else start();
      return;
    }
    if (state !== 'running') start();
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });

  dialog.querySelectorAll('.pad button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (state !== 'running') start();
      turn(b.getAttribute('data-dir'));
    });
  });

  // ── open / close ─────────────────────────────────────────
  document.querySelectorAll('[data-snake-open]').forEach(function (b) {
    b.addEventListener('click', function () {
      readColors();
      if (!snake) reset();
      refreshBoard();
      dialog.showModal();
      canvas.focus();
      last = null;
      if (!raf) raf = requestAnimationFrame(loop);
    });
  });

  dialog.addEventListener('close', function () {
    if (state === 'running') state = 'paused';
    cancelAnimationFrame(raf);
    raf = null;
  });

  // Make the canvas focusable so key presses land in the dialog, not the page.
  canvas.tabIndex = 0;
})();
