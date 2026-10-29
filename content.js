(() => {
  'use strict';

  const FILES = 'abcdefgh';
  const MIN_DEPTH = 6;
  const MAX_DEPTH = 24;
  const MIN_LINES = 2;
  const MAX_LINES = 5;
  const SCAN_MS = 600;
  const AUTO_DELAY = 260;

  const state = {
    booted: false,
    enabled: false,
    depth: 18,
    hud: true,
    multi: true,
    lines: 3,
    auto: false,
    site: location.hostname.includes('lichess') ? 'LICHESS' : 'CHESS.COM',
    engineName: 'stockfish',
    engineReady: false,
    engineFailed: false,
    searching: false,
    pendingFen: null,
    currentFen: '',
    lastFen: '',
    best: null,
    score: null,
    reachedDepth: 0,
    variants: [],
    variantsFen: '',
    varMap: new Map(),
    lastCompleted: null,
    autoLastFen: '',
    autoTryFen: '',
    autoTryCount: 0,
    autoTimer: 0,
    autoBusy: false,
    autoNote: '',
    autoNoteUntil: 0,
  };

  let board = null;
  let canvas = null;
  let ctx = null;
  let hud = null;
  let ui = null;
  let worker = null;
  let enginePromise = null;
  let workerCooldown = 0;
  let debounceTimer = 0;
  let hudTimer = 0;
  let lastLiveAt = 0;
  let styleReady = false;
  let rafId = 0;

  boot();

  function boot() {
    chrome.storage.sync.get(
      { enabled: false, depth: 18, hud: true, multi: true, lines: 3, auto: false },
      cfg => {
        state.enabled = !!cfg.enabled;
        state.depth = clampDepth(cfg.depth);
        state.hud = cfg.hud !== false;
        state.multi = cfg.multi !== false;
        state.lines = clampLines(cfg.lines);
        state.auto = !!cfg.auto;
        state.booted = true;
        scanBoard(true);
        pushLive(true);
      }
    );

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let restart = false;

      if (changes.enabled) state.enabled = !!changes.enabled.newValue;
      if (changes.depth) {
        state.depth = clampDepth(changes.depth.newValue);
        restart = true;
      }
      if (changes.hud) state.hud = changes.hud.newValue !== false;
      if (changes.multi) {
        state.multi = changes.multi.newValue !== false;
        restart = true;
      }
      if (changes.lines) {
        state.lines = clampLines(changes.lines.newValue);
        if (state.multi) restart = true;
      }
      if (changes.auto) {
        state.auto = !!changes.auto.newValue;
        cancelAutoPlay();
        state.autoTryFen = '';
        state.autoTryCount = 0;
        state.autoNote = '';
        if (state.auto) scheduleAutoPlay(320);
      }

      if (!state.enabled) {
        stopEngine();
        hideHud();
        clearCanvas();
        state.lastFen = '';
        resetAnalysis();
        pushLive(true);
        return;
      }

      if (restart && state.enabled) {
        resetAnalysis();
        state.lastFen = '';
      }
      scanBoard(true);
      pushLive(true);
    });

    setInterval(() => scanBoard(), SCAN_MS);
    setInterval(() => {
      if (state.booted && state.enabled && !document.hidden) pushLive(true);
    }, 8000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      scanBoard(true);
      pushLive(true);
      scheduleAutoPlay(350);
    });
    chrome.runtime.onMessage.addListener(message => {
      if (!message || message.type !== 'ca-ping') return;
      scanBoard(true);
      pushLive(true);
    });
    rafId = requestAnimationFrame(renderLoop);
  }

  function clampDepth(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return 18;
    return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, n));
  }

  function clampLines(v) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return 3;
    return Math.max(MIN_LINES, Math.min(MAX_LINES, n));
  }

  function resetAnalysis() {
    state.best = null;
    state.score = null;
    state.reachedDepth = 0;
    state.variants = [];
    state.variantsFen = '';
    state.varMap.clear();
    state.lastCompleted = null;
    cancelAutoPlay();
  }

  function findBoard() {
    const nodes = document.querySelectorAll('wc-chess-board, cg-board');
    let pick = null;
    let area = 0;
    for (const node of nodes) {
      const r = node.getBoundingClientRect();
      if (r.width < 180 || r.height < 180) continue;
      const a = r.width * r.height;
      if (a > area) { area = a; pick = node; }
    }
    return pick;
  }

  function scanBoard(force) {
    if (!state.booted) return;
    const found = findBoard();
    if (found !== board) {
      board = found;
      state.lastFen = '';
      state.autoLastFen = '';
      state.autoTryFen = '';
      state.autoTryCount = 0;
      resetAnalysis();
    }
    if (!state.enabled || !board) {
      hideHud();
      clearCanvas();
      return;
    }
    ensureHud();
    updateHud();
    if (force) evaluateSoon(60);
    else evaluateSoon();
  }

  function evaluateSoon(ms = 320) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!state.enabled || !board || document.hidden) return;
      const fen = fenFromBoard();
      if (!fen) return;
      if (fen === state.lastFen) return;
      if (state.autoLastFen && state.autoLastFen !== fen) state.autoLastFen = '';
      state.autoTryFen = '';
      state.autoTryCount = 0;
      cancelAutoPlay();
      resetAnalysis();
      state.lastFen = fen;
      if (state.searching) {
        state.pendingFen = fen;
        try { if (worker) worker.postMessage('stop'); } catch (_) { /* engine gone */ }
        pushLive(true);
        return;
      }
      startSearch(fen);
    }, ms);
  }

  function fenFromBoard() {
    if (!board) return null;
    try {
      return board.tagName.toLowerCase() === 'cg-board' ? lichessFen() : chesscomFen();
    } catch (_) {
      return null;
    }
  }

  function emptyGrid() {
    return Array.from({ length: 8 }, () => Array(8).fill(''));
  }

  function lichessFen() {
    const wrap = board.closest('.cg-wrap');
    const flipped = !!wrap && wrap.classList.contains('orientation-black');
    const rect = board.getBoundingClientRect();
    if (!rect.width) return null;
    const cell = rect.width / 8;
    const grid = emptyGrid();

    for (const piece of board.querySelectorAll('piece')) {
      const pr = piece.getBoundingClientRect();
      if (!pr.width) continue;
      let vx = Math.floor((pr.left + pr.width / 2 - rect.left) / cell);
      let vy = Math.floor((pr.top + pr.height / 2 - rect.top) / cell);
      if (vx < 0 || vx > 7 || vy < 0 || vy > 7) continue;

      const classes = piece.classList;
      let type = '';
      if (classes.contains('pawn')) type = 'p';
      else if (classes.contains('knight')) type = 'n';
      else if (classes.contains('bishop')) type = 'b';
      else if (classes.contains('rook')) type = 'r';
      else if (classes.contains('queen')) type = 'q';
      else if (classes.contains('king')) type = 'k';
      if (!type) continue;

      const white = classes.contains('white');
      const file = flipped ? 7 - vx : vx;
      const rank = flipped ? vy : 7 - vy;
      grid[rank][file] = white ? type.toUpperCase() : type;
    }

    return assemble(grid, lichessTurn());
  }

  function chesscomFen() {
    const rect = board.getBoundingClientRect();
    if (!rect.width) return null;
    const grid = emptyGrid();

    for (const piece of board.querySelectorAll('.piece')) {
      const cls = piece.className;
      const sq = cls.match(/square-(\d)(\d)/);
      if (!sq) continue;
      const file = parseInt(sq[1], 10) - 1;
      const rank = parseInt(sq[2], 10) - 1;
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;

      let type = '';
      let white = false;
      for (const token of cls.split(/\s+/)) {
        const m = token.match(/^([wb])([pnbrqk])$/);
        if (m) { white = m[1] === 'w'; type = m[2]; break; }
      }
      if (!type) {
        if (/\bknight\b|\bn\b/.test(cls)) type = 'n';
        else if (/\bbishop\b|\bb\b/.test(cls)) type = 'b';
        else if (/\brook\b|\br\b/.test(cls)) type = 'r';
        else if (/\bqueen\b|\bq\b/.test(cls)) type = 'q';
        else if (/\bking\b|\bk\b/.test(cls)) type = 'k';
        else if (/\bpawn\b|\bp\b/.test(cls)) type = 'p';
        white = /\bw\b|\bwhite\b/.test(cls);
        if (!type) continue;
      }
      grid[rank][file] = white ? type.toUpperCase() : type;
    }

    return assemble(grid, chesscomTurn());
  }

  function lichessTurn() {
    const active = document.querySelector('.rclock-turn');
    if (active) {
      if (active.classList.contains('rclock-black')) return 'b';
      if (active.classList.contains('rclock-white')) return 'w';
    }
    const moves = document.querySelectorAll('l4 move, .tview2 move, .analyse__moves move').length;
    return moves % 2 === 0 ? 'w' : 'b';
  }

  function chesscomTurn() {
    const active = document.querySelector('.clock-player-turn');
    if (active) {
      if (active.classList.contains('clock-black') || active.closest('.clock-black')) return 'b';
      if (active.classList.contains('clock-white') || active.closest('.clock-white')) return 'w';
    }
    const moves = document.querySelectorAll('.move-list .node, .vertical-move-list .node').length;
    return moves % 2 === 0 ? 'w' : 'b';
  }

  function assemble(grid, turn) {
    let placement = '';
    let any = false;
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const sq = grid[rank][file];
        if (!sq) {
          empty++;
          continue;
        }
        if (empty) { placement += empty; empty = 0; }
        placement += sq;
        any = true;
      }
      if (empty) placement += empty;
      if (rank) placement += '/';
    }
    if (!any) return null;

    let castling = '';
    if (grid[0][4] === 'K') {
      if (grid[0][7] === 'R') castling += 'K';
      if (grid[0][0] === 'R') castling += 'Q';
    }
    if (grid[7][4] === 'k') {
      if (grid[7][7] === 'r') castling += 'k';
      if (grid[7][0] === 'r') castling += 'q';
    }

    return `${placement} ${turn} ${castling || '-'} - 0 1`;
  }

  function isFlipped() {
    if (!board) return false;
    if (board.tagName.toLowerCase() === 'cg-board') {
      const wrap = board.closest('.cg-wrap');
      return !!wrap && wrap.classList.contains('orientation-black');
    }
    return board.classList.contains('flipped') || board.hasAttribute('flipped');
  }

  async function ensureEngine() {
    if (worker) return worker;
    if (Date.now() < workerCooldown) return null;
    if (enginePromise) return enginePromise;

    enginePromise = (async () => {
      try {
        const base = chrome.runtime.getURL('engine/');
        const response = await fetch(base + 'stockfish.js');
        if (!response.ok) throw new Error('engine fetch failed: ' + response.status);
        if (!state.enabled) return null;
        const source = await response.text();
        const wasmUrl = base + 'stockfish.wasm';
        const patched = source.replace(
          'location.origin+location.pathname.replace(/\\.js$/i,".wasm")',
          JSON.stringify(wasmUrl)
        );
        if (patched === source) throw new Error('engine patch failed');

        const url = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
        const instance = new Worker(url);
        URL.revokeObjectURL(url);
        instance.onmessage = onEngineMessage;
        instance.onerror = engineError;
        worker = instance;
        state.engineFailed = false;
        post('uci');
        post('setoption name Hash value 64');
        post('setoption name Threads value 1');
        post('isready');
        return instance;
      } catch (err) {
        engineError(err);
        return null;
      } finally {
        enginePromise = null;
      }
    })();

    return enginePromise;
  }

  function post(cmd) {
    try { if (worker) worker.postMessage(cmd); } catch (_) { /* ignore */ }
  }

  function variantValue(score) {
    if (!score) return null;
    if (score.type === 'cp') return Math.max(-2000, Math.min(2000, score.value));
    const n = score.value;
    if (n === 0) return -10000;
    return n > 0 ? 10000 - Math.min(99, n) * 50 : -10000 + Math.min(99, -n) * 50;
  }

  function variantHue(v, bestValue, total) {
    if (!v || v.rank === 1) return 145;
    const tRank = total <= 1 ? 0 : (v.rank - 1) / (total - 1);
    let tLoss = 0;
    const value = variantValue(v.score);
    if (bestValue != null && value != null && Number.isFinite(value)) {
      tLoss = Math.max(0, Math.min(1, (bestValue - value) / 250));
    }
    let t = Math.max(tRank, tLoss * 0.9);
    if (v.rank >= total) t = Math.max(t, 0.85);
    return Math.round(145 * (1 - Math.max(0, Math.min(1, t))));
  }

  function variantScoreText(score, fen) {
    if (!score) return '—';
    const turn = ((fen || '').split(' ')[1] || 'w') === 'b' ? -1 : 1;
    if (score.type === 'mate') {
      const m = score.value === 0 ? 0 : score.value * turn;
      return m === 0 ? '#' : '#' + Math.abs(m);
    }
    const pawns = (score.value * turn) / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
  }

  function refreshVariants(fen) {
    if (!state.multi) {
      state.variants = [];
      state.variantsFen = '';
      return;
    }
    const baseFen = fen || state.currentFen || state.lastFen;
    const list = [...state.varMap.values()]
      .filter(v => v && v.move)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, state.lines);
    const top = list.find(v => v.rank === 1);
    const bestValue = top ? variantValue(top.score) : null;
    for (const v of list) {
      v.hue = variantHue(v, bestValue, state.lines);
      v.text = variantScoreText(v.score, baseFen);
    }
    state.variants = list;
    state.variantsFen = baseFen || '';
  }

  function onEngineMessage(event) {
    const line = typeof event.data === 'string' ? event.data : (event.data && event.data.line) || '';
    if (!line) return;

    if (line.startsWith('id name ')) {
      const name = line.slice(8).trim().split(/\s+/).slice(0, 2).join(' ');
      state.engineName = (name || 'stockfish').toLowerCase();
      updateHud();
      pushLive(true);
      return;
    }

    if (line.startsWith('uciok')) {
      state.engineReady = true;
      state.engineFailed = false;
      updateHud();
      pushLive(true);
      return;
    }

    if (line.startsWith('info ')) {
      const depthMatch = /\bdepth (\d+)/.exec(line);
      const depthNum = depthMatch ? parseInt(depthMatch[1], 10) : state.reachedDepth;
      if (depthMatch) state.reachedDepth = Math.max(state.reachedDepth, depthNum);

      const rankMatch = /\bmultipv (\d+)/.exec(line);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : 1;

      const score = /\bscore (cp|mate) (-?\d+)/.exec(line);
      const parsedScore = score ? { type: score[1], value: parseInt(score[2], 10) } : null;
      if (parsedScore && rank === 1) state.score = parsedScore;

      const pv = /\bpv (.+)$/.exec(line);
      if (pv && state.searching && state.enabled && state.lastFen === state.currentFen) {
        const moves = pv[1]
          .trim()
          .split(/\s+/)
          .map(m => m.toLowerCase())
          .filter(m => /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m));

        if (moves.length) {
          if (rank === 1 && state.best?.uci !== moves[0]) {
            state.best = { fen: state.currentFen, uci: moves[0] };
          }
          if (state.multi && rank <= state.lines) {
            const prev = state.varMap.get(rank);
            if (!prev || depthNum >= prev.depth) {
              state.varMap.set(rank, {
                rank,
                move: moves[0],
                pv: moves.slice(0, 8),
                score: parsedScore,
                depth: depthNum,
              });
              refreshVariants();
            }
          }
        }
      }

      scheduleHud();
      scheduleLive();
      return;
    }

    if (line.startsWith('bestmove')) {
      const parts = line.split(/\s+/);
      finishSearch(parts[1] || '');
    }
  }

  async function startSearch(fen) {
    if (!state.enabled || !board) return;
    const w = await ensureEngine();
    if (!w || !state.enabled) return;
    if (state.searching) {
      state.pendingFen = state.lastFen || fen;
      return;
    }
    fen = state.lastFen || fen;
    state.searching = true;
    state.currentFen = fen;
    state.pendingFen = null;
    state.reachedDepth = 0;
    state.score = null;
    state.variants = [];
    state.variantsFen = '';
    state.varMap.clear();
    state.lastCompleted = null;
    post('setoption name MultiPV value ' + (state.multi ? state.lines : 1));
    post('position fen ' + fen);
    post('go depth ' + state.depth);
    updateHud();
    pushLive(true);
  }

  function finishSearch(move) {
    const fen = state.currentFen;
    const next = state.pendingFen;
    state.searching = false;
    state.pendingFen = null;
    state.currentFen = '';

    const valid = !!move && move !== '(none)' && !!fen && fen === state.lastFen && state.enabled;
    if (valid) {
      state.best = { fen, uci: move };
      if (state.multi) {
        const top = state.varMap.get(1);
        if (top) top.move = move;
        else {
          state.varMap.set(1, {
            rank: 1,
            move,
            pv: [move],
            score: state.score,
            depth: state.reachedDepth,
          });
        }
        refreshVariants(fen);
      }
    } else if (move === '(none)' && fen === state.lastFen) {
      state.best = null;
      state.variants = [];
      state.variantsFen = '';
      state.varMap.clear();
    }

    updateHud();
    pushLive(true);

    if (next && state.enabled) {
      startSearch(next);
      return;
    }
    if (valid) {
      state.lastCompleted = { fen, move, depth: state.reachedDepth };
      scheduleAutoPlay(AUTO_DELAY);
    }
  }

  function engineError(err) {
    state.engineFailed = true;
    state.engineReady = false;
    state.searching = false;
    state.currentFen = '';
    state.pendingFen = null;
    resetAnalysis();
    workerCooldown = Date.now() + 8000;
    try { if (worker) worker.terminate(); } catch (_) { /* ignore */ }
    worker = null;
    if (err && err.message) console.warn('[chess-assist] engine:', err.message);
    updateHud();
    pushLive(true);
    setTimeout(() => {
      if (!state.enabled || !board) return;
      state.lastFen = '';
      evaluateSoon(0);
    }, 8500);
  }

  function stopEngine() {
    try { if (worker) worker.terminate(); } catch (_) { /* ignore */ }
    worker = null;
    state.searching = false;
    state.currentFen = '';
    state.pendingFen = null;
    resetAnalysis();
    updateHud();
  }

  function scheduleHud() {
    if (hudTimer) return;
    hudTimer = setTimeout(() => {
      hudTimer = 0;
      updateHud();
    }, 90);
  }

  function scheduleLive() {
    const now = Date.now();
    if (now - lastLiveAt < 900) return;
    pushLive(false);
  }

  function whiteScore() {
    if (!state.score) return null;
    const turn = (state.lastFen.split(' ')[1] || 'w') === 'b' ? -1 : 1;
    if (state.score.type === 'mate') {
      return { mate: state.score.value === 0 ? 0 : state.score.value * turn };
    }
    return { cp: state.score.value * turn };
  }

  function scoreText() {
    const s = whiteScore();
    if (!s) return '—';
    if ('mate' in s) return s.mate === 0 ? '#' : '#' + Math.abs(s.mate);
    const pawns = s.cp / 100;
    return (pawns >= 0 ? '+' : '') + pawns.toFixed(2);
  }

  function scoreBar() {
    const s = whiteScore();
    if (!s) return 50;
    if ('mate' in s) return s.mate >= 0 ? 97 : 3;
    return Math.max(3, Math.min(97, Math.round(50 + 50 * Math.tanh(s.cp / 450))));
  }

  function pushLive(force) {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (!force && now - lastLiveAt < 900) return;
    lastLiveAt = now;

    const hasMove = !!state.best && state.best.fen === state.lastFen;
    const uci = hasMove ? state.best.uci : '';
    const s = whiteScore();

    let cp = null;
    let mate = null;
    if (s) {
      if ('mate' in s) mate = s.mate;
      else cp = Math.round(s.cp);
    }

    const variantsReady = state.multi && !!state.variantsFen && state.variantsFen === state.lastFen;
    const variants = variantsReady
      ? state.variants.slice(0, state.lines).map(v => ({
          rank: v.rank,
          move: v.move,
          pv: v.pv ? v.pv.slice(0, 6) : [v.move],
          scoreText: v.text || variantScoreText(v.score, state.lastFen),
          hue: typeof v.hue === 'number' ? v.hue : 145,
          depth: v.depth || 0,
        }))
      : [];

    const live = {
      enabled: state.enabled,
      site: state.site,
      engine: state.engineName,
      ready: state.engineReady,
      failed: state.engineFailed,
      thinking: state.searching,
      depth: state.reachedDepth,
      move: hasMove ? uci : null,
      from: uci ? uci.slice(0, 2) : null,
      to: uci ? uci.slice(2, 4) : null,
      scoreText: scoreText(),
      cp,
      mate,
      bar: scoreBar(),
      multi: state.multi,
      lines: state.lines,
      variants,
      auto: state.auto,
      autoTurn: autoTurn(),
      autoBusy: state.autoBusy,
      autoNote: state.autoNote && Date.now() < state.autoNoteUntil ? state.autoNote : '',
      ts: now,
    };

    try {
      chrome.storage.local.set({ live }, () => void chrome.runtime.lastError);
    } catch (_) { /* ignore */ }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function playerColor() {
    return isFlipped() ? 'b' : 'w';
  }

  function autoTurn() {
    if (!state.lastFen) return false;
    // FEN'den mevcut tur: 'w' veya 'b'
    const fenTurn = (state.lastFen.split(' ')[1] || 'w') === 'b' ? 'b' : 'w';
    // Tahta hangi renk displayed/flip durumunda 'active' ise o renk
    const isFlippedState = isFlipped();
    // Eğer flip trueysa, tahta siyah sol altta -> w (beyaz) soldan sağa yazılırsa
    // Standart: w sol altta, b sağ altta. Flip: b sol altta, w sağ altta.
    // Yani: flip trueysa renklertersine çevrildi: actual player = flip ? opposite : same
    const actualPlayer = isFlippedState ? (fenTurn === 'w' ? 'b' : 'w') : fenTurn;
    return actualPlayer === playerColor();
  }

  function autoEligible() {
    return !!(state.enabled && state.auto && board && !document.hidden);
  }

  function cancelAutoPlay() {
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = 0;
    }
  }

  function scheduleAutoPlay(delay = AUTO_DELAY) {
    if (!autoEligible() || state.searching || state.autoBusy) return;
    const fen = state.lastFen;
    const done = state.lastCompleted;
    if (!fen || !done || done.fen !== fen || !done.move || done.move === '(none)') return;
    // Aynı FEN'den daha önceden denendiği / hamle yapılmışsa tekrar başlamayalım
    if (state.autoLastFen === fen && Date.now() - (state.autoLastMoveTs || 0) < 30000) return;
    if (state.autoLastFen === fen && state.autoTryCount >= 1) return;
    if (state.autoTryFen !== fen) {
      state.autoTryFen = fen;
      state.autoTryCount = 0;
    }
    if (autoTurn()) {
      cancelAutoPlay();
      state.autoTimer = setTimeout(() => {
        state.autoTimer = 0;
        attemptAutoPlay(fen, done.move);
      }, Math.max(0, delay));
    }
  }

  async function attemptAutoPlay(fen, move) {
    if (state.autoBusy || !autoEligible() || !autoTurn()) return;
    if (state.searching || state.lastFen !== fen || state.autoLastFen === fen) return;
    const done = state.lastCompleted;
    if (!done || done.fen !== fen || done.move !== move || move === '(none)') return;
    if (state.autoTryFen !== fen) {
      state.autoTryFen = fen;
      state.autoTryCount = 0;
    }
    if (state.autoTryCount >= 2) return;

    state.autoBusy = true;
    state.autoTryCount++;
    updateHud();
    pushLive(true);

    let ok = false;
    try {
      ok = await performAutoMove(fen, move);
    } catch (err) {
      if (err && err.message) console.warn('[chess-assist] auto:', err.message);
    } finally {
      state.autoBusy = false;
    }

    if (ok) {
      state.autoLastFen = fen;
      state.autoLastMoveTs = Date.now(); // Hamle zaman damgası
      state.autoNote = '';
      state.autoNoteUntil = 0;
      updateHud();
      pushLive(true);
      setTimeout(() => { if (state.enabled) scanBoard(true); }, 120);
      return;
    }

    const actual = fenFromBoard();
    if (actual && actual !== fen) {
      state.autoLastFen = fen;
      state.autoNote = '';
      state.autoNoteUntil = 0;
      updateHud();
      pushLive(true);
      setTimeout(() => { if (state.enabled) scanBoard(true); }, 120);
      return;
    }

    setAutoNote('auto blocked', 3200);
    if (state.autoTryCount < 2 && autoEligible() && state.lastFen === fen && autoTurn()) {
      cancelAutoPlay();
      state.autoTimer = setTimeout(() => {
        state.autoTimer = 0;
        attemptAutoPlay(fen, move);
      }, 700);
    }
  }

  function autoStillValid(fen) {
    if (!!(state.enabled && state.auto && board && !document.hidden && state.lastFen === fen)) {
      // Hamle zaman damgası kontrolü: 1 saniyeden eski FEN'de hareket yapma
      const lastMove = state.autoLastMoveTs || 0;
      if (Date.now() - lastMove < 1000) return false; // Çok yakınta hamle yapma
      return true;
    }
    return false;
  }

  async function performAutoMove(fen, uci) {
    if (!board) return false;
    const rect = board.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;
    const size = Math.min(rect.width, rect.height) / 8;
    const flipped = isFlipped();
    const a = squareXY(uci.slice(0, 2), size, flipped);
    const b = squareXY(uci.slice(2, 4), size, flipped);
    const p1 = { x: rect.left + a.x, y: rect.top + a.y };
    const p2 = { x: rect.left + b.x, y: rect.top + b.y };
    const promo = (uci[4] || '').toLowerCase();

    if (!autoStillValid(fen)) return false;

    await clickPoint(p1);
    await sleep(45);
    await clickPoint(p2);
    await sleep(160);
    if (promo) {
      await choosePromotion(promo);
      await sleep(100);
    }
    if (await waitForFenChange(fen, 750)) return true;
    if (!autoStillValid(fen)) return false;

    const afterClick = fenFromBoard();
    if (afterClick && afterClick !== fen) return true;

    await dragPoints(p1, p2);
    await sleep(160);
    if (promo) {
      await choosePromotion(promo);
      await sleep(100);
    }
    return waitForFenChange(fen, 850);
  }

  function autoEvent(type, p, pointer, pressed) {
    const down = !!pressed || type === 'pointerdown' || type === 'mousedown';
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: p.x,
      clientY: p.y,
      screenX: p.x,
      screenY: p.y,
      button: 0,
      buttons: down ? 1 : 0,
    };
    if (pointer) {
      opts.pointerId = 1;
      opts.pointerType = 'mouse';
      opts.isPrimary = true;
      opts.width = 1;
      opts.height = 1;
      opts.pressure = down ? 0.5 : 0;
    }
    try {
      return pointer ? new PointerEvent(type, opts) : new MouseEvent(type, opts);
    } catch (_) {
      return new MouseEvent(type, opts);
    }
  }

  function autoFire(target, type, p, pointer, pressed) {
    if (!target) return;
    try {
      target.dispatchEvent(autoEvent(type, p, pointer, pressed));
    } catch (_) { /* ignore */ }
  }

  async function clickPoint(p) {
    const hit = document.elementFromPoint(p.x, p.y);
    const target = hit && board && board.contains(hit) ? hit : board;
    if (!target) return;
    const seq = [
      ['pointerover', true], ['pointerenter', true], ['pointermove', true],
      ['pointerdown', true], ['mousedown', false],
      ['pointerup', true], ['mouseup', false], ['click', false],
    ];
    for (const [type, pointer] of seq) autoFire(target, type, p, pointer, false);
    await sleep(16);
  }

  async function dragPoints(p1, p2) {
    const hit = document.elementFromPoint(p1.x, p1.y);
    const target = hit && board && board.contains(hit) ? hit : board;
    if (!target) return;
    autoFire(target, 'pointerover', p1, true, false);
    autoFire(target, 'pointermove', p1, true, false);
    autoFire(target, 'pointerdown', p1, true, true);
    autoFire(target, 'mousedown', p1, false, true);
    await sleep(30);

    const steps = 7;
    for (let i = 1; i <= steps; i++) {
      const p = {
        x: p1.x + ((p2.x - p1.x) * i) / steps,
        y: p1.y + ((p2.y - p1.y) * i) / steps,
      };
      const node = document.elementFromPoint(p.x, p.y) || board;
      autoFire(node, 'pointermove', p, true, true);
      autoFire(node, 'mousemove', p, false, true);
      await sleep(18);
    }

    const end = document.elementFromPoint(p2.x, p2.y) || board;
    autoFire(end, 'pointerup', p2, true, false);
    autoFire(end, 'mouseup', p2, false, false);
    autoFire(end, 'click', p2, false, false);
  }

  function findPromotion(promo) {
    const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const name = names[promo] || 'queen';
    const selectors = [
      '.promotion-piece.' + name,
      '.promotion-piece.' + promo,
      '.promotion-piece[data-piece="' + promo + '"]',
      '.promotion-choice.' + name,
      '.promotion piece.' + name,
      '.promotion [data-piece="' + promo + '"]',
      '.promotion-window .w' + promo,
      '.promotion-window .b' + promo,
      '.promotion-window .' + name,
      '.promotion-window [data-piece="' + promo + '"]',
      '[class*="promotion"] [class*="' + name + '"]',
      '[class*="promotion"] [data-piece="' + promo + '"]',
      '[class*="promotion"] .w' + promo,
      '[class*="promotion"] .b' + promo,
    ];
    for (const sel of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return node;
      }
    }
    return null;
  }

  async function choosePromotion(promo) {
    for (let i = 0; i < 8; i++) {
      const node = findPromotion(promo);
      if (node) {
        const r = node.getBoundingClientRect();
        await clickPoint({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        return true;
      }
      await sleep(60);
    }
    return false;
  }

  async function waitForFenChange(before, timeout) {
    const started = Date.now();
    let candidate = '';
    while (Date.now() - started < timeout) {
      await sleep(70);
      const fen = fenFromBoard();
      if (!fen || fen === before) {
        candidate = '';
        continue;
      }
      if (candidate === fen) return true;
      candidate = fen;
    }
    return false;
  }

  function setAutoNote(text, ms) {
    state.autoNote = text || '';
    state.autoNoteUntil = Date.now() + Math.max(0, ms || 0);
    updateHud();
    pushLive(true);
    setTimeout(() => {
      if (Date.now() >= state.autoNoteUntil) {
        state.autoNote = '';
        state.autoNoteUntil = 0;
        updateHud();
        pushLive(true);
      }
    }, Math.max(0, ms || 0) + 30);
  }

  function ensureHud() {
    if (hud) {
      if (!state.hud) { hud.style.display = 'none'; return; }
      hud.style.display = 'block';
      hud.classList.add('ca-on');
      return;
    }
    injectStyle();
    hud = document.createElement('div');
    hud.id = 'ca-hud';
    hud.innerHTML =
      '<div class="ca-row ca-top">' +
        '<span class="ca-brand"><i class="ca-led"></i>ENGINE</span>' +
        '<span class="ca-tags"><span class="ca-site"></span><span class="ca-auto">AUTO</span></span>' +
      '</div>' +
      '<div class="ca-move"><span class="ca-from">—</span><span class="ca-sep">→</span><span class="ca-to">—</span></div>' +
      '<div class="ca-evalrow">' +
        '<div class="ca-bar"><i class="ca-fill"></i><span class="ca-mid"></span></div>' +
        '<span class="ca-score">—</span>' +
      '</div>' +
      '<div class="ca-vars"></div>' +
      '<div class="ca-row ca-meta">' +
        '<span class="ca-depth">d—</span>' +
        '<span class="ca-status">idle</span>' +
        '<span class="ca-spin"></span>' +
      '</div>';
    document.documentElement.appendChild(hud);

    ui = {
      site: hud.querySelector('.ca-site'),
      from: hud.querySelector('.ca-from'),
      to: hud.querySelector('.ca-to'),
      score: hud.querySelector('.ca-score'),
      fill: hud.querySelector('.ca-fill'),
      depth: hud.querySelector('.ca-depth'),
      status: hud.querySelector('.ca-status'),
      vars: hud.querySelector('.ca-vars'),
      auto: hud.querySelector('.ca-auto'),
    };
    hud.style.display = state.hud ? 'block' : 'none';
    updateHud();
    requestAnimationFrame(() => hud && hud.classList.add('ca-on'));
  }

  function hideHud() {
    if (!hud) return;
    hud.classList.remove('ca-on');
    hud.style.display = 'none';
  }

  function updateHud() {
    if (!hud || !ui) return;
    const hasMove = !!state.best && state.best.fen === state.lastFen;
    const uci = hasMove ? state.best.uci : '';
    ui.site.textContent = state.site;
    ui.from.textContent = uci ? uci.slice(0, 2).toUpperCase() : '—';
    ui.to.textContent = uci ? uci.slice(2, 4).toUpperCase() : '—';
    ui.score.textContent = scoreText();
    ui.fill.style.width = scoreBar() + '%';
    ui.depth.textContent = 'd' + (state.reachedDepth || '—') +
      (state.multi && state.lines > 1 ? ' ×' + state.lines : '');

    let label = 'idle';
    let mode = 'idle';
    if (state.engineFailed) { label = 'engine error'; mode = 'error'; }
    else if (state.searching) { label = 'analysing'; mode = 'think'; }
    else if (state.autoBusy) { label = 'auto play'; mode = 'ready'; }
    else if (hasMove) { label = 'ready'; mode = 'ready'; }
    else if (state.enabled && board) { label = 'waiting'; mode = 'idle'; }
    ui.status.textContent = label;
    hud.dataset.state = mode;
    hud.dataset.on = state.enabled ? '1' : '0';
    hud.dataset.auto = state.auto ? '1' : '0';
    hud.dataset.autoTurn = state.auto && autoTurn() ? '1' : '0';
    hud.dataset.autoBusy = state.autoBusy ? '1' : '0';

    if (ui.auto) {
      const note = state.autoNote && Date.now() < state.autoNoteUntil ? state.autoNote : '';
      ui.auto.textContent = note ? 'AUTO!' : 'AUTO';
      ui.auto.style.display = state.auto ? 'inline-block' : 'none';
      ui.auto.title = note || 'auto play';
    }

    renderVariantRows();
  }

  function renderVariantRows() {
    if (!ui || !ui.vars) return;
    const ready = state.multi && state.variantsFen === state.lastFen && state.variants.length > 1;
    const rows = ready ? state.variants.filter(v => v.rank > 1).slice(0, MAX_LINES - 1) : [];

    while (ui.vars.children.length < rows.length) {
      const row = document.createElement('div');
      row.className = 'ca-var';
      const rank = document.createElement('span');
      rank.className = 'ca-rank';
      const move = document.createElement('span');
      move.className = 'ca-var-move';
      const score = document.createElement('span');
      score.className = 'ca-var-score';
      row.appendChild(rank);
      row.appendChild(move);
      row.appendChild(score);
      ui.vars.appendChild(row);
    }

    for (let i = 0; i < ui.vars.children.length; i++) {
      const row = ui.vars.children[i];
      const v = rows[i];
      if (!v) {
        row.style.display = 'none';
        continue;
      }
      row.style.display = 'flex';
      row.style.setProperty('--hue', String(typeof v.hue === 'number' ? v.hue : 145));
      row.querySelector('.ca-rank').textContent = String(v.rank);
      row.querySelector('.ca-var-move').textContent = v.move;
      row.querySelector('.ca-var-score').textContent = v.text || variantScoreText(v.score, state.lastFen);
    }

    ui.vars.style.display = rows.length ? 'flex' : 'none';
  }

  function injectStyle() {
    if (styleReady) return;
    styleReady = true;
    const style = document.createElement('style');
    style.textContent = `
      #ca-hud {
        position: fixed;
        z-index: 2147483647;
        pointer-events: none;
        min-width: 170px;
        padding: 8px 10px 7px;
        border-radius: 11px;
        background:
          linear-gradient(150deg, rgba(12, 20, 30, .93), rgba(5, 9, 15, .9));
        border: 1px solid rgba(92, 242, 194, .22);
        box-shadow:
          0 12px 34px rgba(0, 0, 0, .55),
          0 0 0 1px rgba(0, 0, 0, .35),
          inset 0 1px 0 rgba(255, 255, 255, .06);
        -webkit-backdrop-filter: blur(10px) saturate(1.25);
        backdrop-filter: blur(10px) saturate(1.25);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #dff7ef;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity .22s ease, transform .22s ease;
        user-select: none;
      }
      #ca-hud.ca-on { opacity: 1; transform: translateY(0); }
      #ca-hud::before {
        content: "";
        position: absolute;
        left: 10px; right: 10px; top: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(92, 242, 194, .85), transparent);
      }
      #ca-hud .ca-row { display: flex; align-items: center; }
      #ca-hud .ca-top { justify-content: space-between; margin-bottom: 5px; }
      #ca-hud .ca-brand {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 9px; letter-spacing: .22em; color: #82a49b;
      }
      #ca-hud .ca-led {
        width: 6px; height: 6px; border-radius: 50%;
        background: #5cf2c2;
        box-shadow: 0 0 8px rgba(92, 242, 194, .9);
        animation: ca-pulse 2s ease-in-out infinite;
      }
      #ca-hud .ca-site {
        font-size: 8px; letter-spacing: .18em; color: #6f8f87;
        border: 1px solid rgba(92, 242, 194, .18);
        border-radius: 999px; padding: 2px 6px;
      }
      #ca-hud .ca-tags { display: inline-flex; align-items: center; gap: 5px; }
      #ca-hud .ca-auto {
        display: none; padding: 2px 5px; border-radius: 999px;
        font-size: 7px; font-weight: 700; letter-spacing: .12em;
        color: #07120e; background: #5cf2c2;
        box-shadow: 0 0 8px rgba(92, 242, 194, .45);
      }
      #ca-hud[data-auto="1"] .ca-auto { display: inline-block; }
      #ca-hud[data-auto-turn="1"] .ca-auto { animation: ca-pulse 1.4s ease-in-out infinite; }
      #ca-hud[data-auto-busy="1"] .ca-auto { background: #a6ff8f; }
      #ca-hud .ca-move {
        display: flex; align-items: baseline; gap: 4px;
        font-size: 19px; font-weight: 700; letter-spacing: .09em;
        line-height: 1.1; color: #f2fffb;
        text-shadow: 0 0 18px rgba(92, 242, 194, .35);
      }
      #ca-hud .ca-sep { color: #4f746b; font-size: 15px; font-weight: 400; }
      #ca-hud .ca-evalrow {
        display: flex; align-items: center; gap: 7px; margin-top: 6px;
      }
      #ca-hud .ca-bar {
        position: relative; flex: 1; height: 4px; border-radius: 999px;
        background: rgba(255, 255, 255, .07); overflow: hidden;
      }
      #ca-hud .ca-fill {
        position: absolute; inset: 0 auto 0 0; width: 50%;
        background: linear-gradient(90deg, #5cf2c2, #a6ff8f);
        border-radius: 999px;
        box-shadow: 0 0 10px rgba(92, 242, 194, .6);
        transition: width .35s cubic-bezier(.2, .8, .2, 1);
      }
      #ca-hud .ca-mid {
        position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px;
        background: rgba(255, 255, 255, .25);
      }
      #ca-hud .ca-score {
        font-size: 11px; color: #5cf2c2; min-width: 38px; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      #ca-hud .ca-vars {
        display: none; flex-direction: column; gap: 3px;
        margin-top: 6px; padding-top: 5px;
        border-top: 1px solid rgba(92, 242, 194, .12);
        max-width: 250px;
      }
      #ca-hud .ca-var {
        display: flex; align-items: center; gap: 6px;
        font-size: 9px; letter-spacing: .06em; line-height: 1.15;
      }
      #ca-hud .ca-rank {
        flex: none; width: 13px; height: 13px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 7px; font-weight: 700;
        color: hsl(var(--hue, 145) 90% 70%);
        border: 1px solid hsl(var(--hue, 145) 90% 58% / .42);
        background: hsl(var(--hue, 145) 90% 50% / .14);
      }
      #ca-hud .ca-var-move {
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-weight: 600; color: hsl(var(--hue, 145) 90% 72%);
      }
      #ca-hud .ca-var-score {
        flex: none; color: #9ab8b0; font-size: 8.5px;
        font-variant-numeric: tabular-nums;
      }
      #ca-hud .ca-meta { margin-top: 6px; gap: 7px; font-size: 8px; letter-spacing: .15em; color: #6f8f87; }
      #ca-hud .ca-depth { color: #9ab8b0; }
      #ca-hud .ca-status { text-transform: uppercase; }
      #ca-hud .ca-spin { display: none; width: 9px; height: 9px; margin-left: auto;
        border-radius: 50%; border: 1.5px solid rgba(92, 242, 194, .2);
        border-top-color: #5cf2c2; animation: ca-spin .7s linear infinite;
      }
      #ca-hud[data-state="think"] .ca-spin { display: inline-block; }
      #ca-hud[data-state="think"] .ca-led { animation-duration: .8s; }
      #ca-hud[data-state="ready"] .ca-led { background: #a6ff8f; box-shadow: 0 0 10px rgba(166, 255, 143, .9); }
      #ca-hud[data-state="error"] .ca-led { background: #ff6b81; box-shadow: 0 0 8px rgba(255, 107, 129, .8); }
      #ca-hud[data-state="error"] .ca-score { color: #ff6b81; }
      @keyframes ca-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      @keyframes ca-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        #ca-hud, #ca-hud .ca-led, #ca-hud .ca-spin { animation: none; transition: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearCanvas() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function squareXY(square, size, flipped) {
    const file = FILES.indexOf(square[0]);
    const rank = parseInt(square[1], 10) - 1;
    const x = flipped ? 7 - file : file;
    const y = flipped ? rank : 7 - rank;
    return { x: (x + 0.5) * size, y: (y + 0.5) * size };
  }

  function roundedRect(context, x, y, w, h, r) {
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  function drawArrow(variant, rect, time, best, showRank) {
    const uci = (variant && variant.move) || '';
    if (uci.length < 4) return;
    const size = Math.min(rect.width, rect.height) / 8;
    const flipped = isFlipped();
    const a = squareXY(uci.slice(0, 2), size, flipped);
    const b = squareXY(uci.slice(2, 4), size, flipped);
    const hue = best ? 145 : (typeof variant.hue === 'number' ? variant.hue : 145);

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.004);
    const color = (light, sat, alpha) => 'hsla(' + hue + ', ' + sat + '%, ' + light + '%, ' + alpha + ')';

    ctx.save();
    ctx.globalAlpha = best ? 1 : 0.92;

    ctx.fillStyle = best ? 'rgba(92, 242, 194, 0.10)' : color(55, 92, 0.085);
    roundedRect(ctx, b.x - size * 0.46, b.y - size * 0.46, size * 0.92, size * 0.92, size * 0.14);
    ctx.fill();
    ctx.strokeStyle = best
      ? 'rgba(92, 242, 194, ' + (0.14 + pulse * 0.16).toFixed(3) + ')'
      : color(58, 92, (0.13 + pulse * 0.12).toFixed(3));
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(a.x, a.y, size * (0.13 + pulse * 0.02), 0, Math.PI * 2);
    ctx.fillStyle = best ? 'rgba(92, 242, 194, 0.22)' : color(55, 92, 0.18);
    ctx.fill();

    const start = { x: a.x + ux * size * 0.24, y: a.y + uy * size * 0.24 };
    const headLen = size * (best ? 0.46 : 0.42);
    const headW = size * (best ? 0.34 : 0.30);
    const tip = { x: b.x - ux * size * 0.06, y: b.y - uy * size * 0.06 };
    const base = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(2, 8, 6, 0.35)';
    ctx.lineWidth = size * (best ? 0.23 : 0.17);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(base.x, base.y);
    ctx.stroke();

    const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    if (best) {
      gradient.addColorStop(0, 'rgba(92, 242, 194, 0.18)');
      gradient.addColorStop(0.35, 'rgba(92, 242, 194, 0.9)');
      gradient.addColorStop(1, 'rgba(166, 255, 143, 0.98)');
    } else {
      gradient.addColorStop(0, color(56, 92, 0.22));
      gradient.addColorStop(0.45, color(58, 92, 0.9));
      gradient.addColorStop(1, color(68, 96, 0.98));
    }

    ctx.lineCap = 'round';
    ctx.shadowColor = best ? 'rgba(92, 242, 194, 0.55)' : color(58, 92, 0.45);
    ctx.shadowBlur = size * (best ? 0.32 : 0.22);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = size * (best ? 0.15 : 0.10);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(base.x, base.y);
    ctx.stroke();

    ctx.shadowBlur = size * (best ? 0.22 : 0.14);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(base.x - uy * headW * 0.55, base.y + ux * headW * 0.55);
    ctx.lineTo(base.x + uy * headW * 0.55, base.y - ux * headW * 0.55);
    ctx.closePath();
    ctx.fill();

    if (best) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(240, 255, 250, 0.75)';
      ctx.lineWidth = Math.max(1.2, size * 0.028);
      ctx.setLineDash([size * 0.3, size * 0.26]);
      ctx.lineDashOffset = -((time * 0.06) % (size * 0.56));
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
    }

    if (showRank) {
      const radius = size * 0.12;
      let bx = b.x + size * 0.30;
      let by = b.y - size * 0.30;
      bx = Math.min(Math.max(bx, radius + 3), rect.width - radius - 3);
      by = Math.min(Math.max(by, radius + 3), rect.height - radius - 3);

      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(bx, by, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(4, 10, 8, 0.86)';
      ctx.fill();
      ctx.strokeStyle = color(62, 92, 0.85);
      ctx.lineWidth = Math.max(1, size * 0.022);
      ctx.stroke();

      ctx.fillStyle = best ? '#c9ffe9' : color(74, 96, 1);
      ctx.font = '700 ' + Math.max(7, Math.round(size * 0.16)) + 'px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(variant.rank || 1), bx, by + 0.5);
    }

    ctx.restore();
  }

  function ensureCanvas() {
    if (canvas) return true;
    canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483646;' +
      'width:0;height:0;opacity:.98';
    document.documentElement.appendChild(canvas);
    ctx = canvas.getContext('2d');
    return !!ctx;
  }

  function positionHud() {
    if (!hud || !board) return;
    const rect = board.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    if (!visible || !state.hud) { hud.style.display = 'none'; return; }
    hud.style.display = 'block';

    const hw = hud.offsetWidth || 190;
    const hh = hud.offsetHeight || 68;
    const gap = 10;
    const pad = 8;
    const maxLeft = Math.max(pad, window.innerWidth - hw - pad);
    const maxTop = Math.max(pad, window.innerHeight - hh - pad);
    const x = v => Math.min(Math.max(pad, v), maxLeft);
    const y = v => Math.min(Math.max(pad, v), maxTop);

    const spots = [
      { left: x(rect.left), top: rect.top - hh - gap },
      { left: x(rect.left), top: rect.bottom + gap },
      { left: rect.right + gap, top: rect.top },
      { left: rect.left - hw - gap, top: rect.top },
      { left: rect.left + pad, top: rect.top + pad },
    ];

    let spot = null;
    for (const candidate of spots) {
      if (candidate.left >= pad && candidate.left <= maxLeft && candidate.top >= pad && candidate.top <= maxTop) {
        spot = candidate;
        break;
      }
    }
    if (!spot) spot = { left: pad, top: pad };

    hud.style.left = spot.left + 'px';
    hud.style.top = spot.top + 'px';
  }

  function renderLoop(time) {
    if (state.enabled && board) {
      positionHud();
      const rect = board.getBoundingClientRect();
      const hasMove = !!state.best && state.best.fen === state.lastFen;
      const variantsCurrent = state.multi && !!state.variantsFen &&
        state.variantsFen === state.lastFen && state.variants.length > 0;
      const list = variantsCurrent
        ? state.variants
        : (hasMove ? [{ rank: 1, move: state.best.uci, hue: 145 }] : []);

      if (list.length && rect.width > 0) {
        if (ensureCanvas()) {
          const dpr = window.devicePixelRatio || 1;
          const w = Math.round(rect.width * dpr);
          const h = Math.round(rect.height * dpr);
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
          }
          canvas.style.left = rect.left + 'px';
          canvas.style.top = rect.top + 'px';
          canvas.style.width = rect.width + 'px';
          canvas.style.height = rect.height + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, rect.width, rect.height);
          for (let i = list.length - 1; i >= 0; i--) {
            const v = list[i];
            if (!v || !v.move) continue;
            drawArrow(v, rect, time, v.rank === 1, variantsCurrent && list.length > 1);
          }
        }
      } else if (ctx) {
        clearCanvas();
      }
    }
    requestAnimationFrame(renderLoop);
  }
})();

