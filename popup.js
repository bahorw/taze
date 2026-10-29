(() => {
  'use strict';

  const MIN_DEPTH = 6;
  const MAX_DEPTH = 24;
  const MIN_LINES = 2;
  const MAX_LINES = 5;
  const STALE_MS = 20000;

  const $ = id => document.getElementById(id);
  const el = {
    toggle: $('toggle'),
    dot: $('dot'),
    statusText: $('statusText'),
    sitePill: $('sitePill'),
    bestMove: $('bestMove'),
    evalText: $('evalText'),
    barFill: $('barFill'),
    depthNow: $('depthNow'),
    engineName: $('engineName'),
    spin: $('spin'),
    depth: $('depth'),
    depthVal: $('depthVal'),
    hint: $('hint'),
    variantsPanel: $('variantsPanel'),
    variantList: $('variantList'),
    variantCount: $('variantCount'),
    linesVal: $('linesVal'),
    linesStepper: $('linesStepper'),
    linesMinus: $('linesMinus'),
    linesPlus: $('linesPlus'),
    multi: $('multi'),
    auto: $('auto'),
    autoHint: $('autoHint'),
  };

  let cfg = { enabled: false, depth: 18, multi: true, lines: 3, auto: false };
  let live = null;
  let lastMove = null;
  let depthTimer = 0;

  chrome.storage.sync.get(
    { enabled: false, depth: 18, multi: true, lines: 3, auto: false },
    stored => {
      cfg.enabled = !!stored.enabled;
      cfg.depth = clampDepth(stored.depth);
      cfg.multi = stored.multi !== false;
      cfg.lines = clampLines(stored.lines);
      cfg.auto = !!stored.auto;
      syncControls();
      render();
      pingActiveTab();
    }
  );

  chrome.storage.local.get({ live: null }, stored => {
    live = stored.live || null;
    render();
  });

  el.toggle.addEventListener('click', () => {
    cfg.enabled = !cfg.enabled;
    el.toggle.setAttribute('aria-checked', cfg.enabled ? 'true' : 'false');
    chrome.storage.sync.set({ enabled: cfg.enabled });
    render();
    setTimeout(pingActiveTab, 120);
  });

  el.depth.addEventListener('input', () => {
    cfg.depth = clampDepth(el.depth.value);
    el.depthVal.textContent = cfg.depth;
    paintRange();
    clearTimeout(depthTimer);
    depthTimer = setTimeout(() => chrome.storage.sync.set({ depth: cfg.depth }), 140);
  });

  el.depth.addEventListener('change', () => {
    clearTimeout(depthTimer);
    chrome.storage.sync.set({ depth: cfg.depth });
  });

  el.multi.addEventListener('click', () => {
    cfg.multi = !cfg.multi;
    chrome.storage.sync.set({ multi: cfg.multi });
    syncControls();
    render();
  });

  el.linesMinus.addEventListener('click', () => stepLines(-1));
  el.linesPlus.addEventListener('click', () => stepLines(1));

  el.auto.addEventListener('click', () => {
    cfg.auto = !cfg.auto;
    chrome.storage.sync.set({ auto: cfg.auto });
    syncControls();
    render();
  });

  function stepLines(delta) {
    cfg.lines = clampLines(cfg.lines + delta);
    chrome.storage.sync.set({ lines: cfg.lines });
    syncControls();
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.enabled) cfg.enabled = !!changes.enabled.newValue;
      if (changes.depth) cfg.depth = clampDepth(changes.depth.newValue);
      if (changes.multi) cfg.multi = changes.multi.newValue !== false;
      if (changes.lines) cfg.lines = clampLines(changes.lines.newValue);
      if (changes.auto) cfg.auto = !!changes.auto.newValue;
      syncControls();
      render();
    }
    if (area === 'local' && changes.live) {
      live = changes.live.newValue || null;
      render();
    }
  });

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

  function syncControls() {
    el.toggle.setAttribute('aria-checked', cfg.enabled ? 'true' : 'false');
    document.body.classList.toggle('armed', cfg.enabled);
    el.depth.value = cfg.depth;
    el.depthVal.textContent = cfg.depth;
    paintRange();

    el.multi.setAttribute('aria-checked', cfg.multi ? 'true' : 'false');
    el.linesVal.textContent = cfg.lines;
    el.linesStepper.classList.toggle('dim', !cfg.multi);
    el.linesStepper.setAttribute('aria-disabled', cfg.multi ? 'false' : 'true');

    el.auto.setAttribute('aria-checked', cfg.auto ? 'true' : 'false');
    document.body.classList.toggle('auto-armed', cfg.auto);
  }

  function paintRange() {
    const pct = ((cfg.depth - MIN_DEPTH) / (MAX_DEPTH - MIN_DEPTH)) * 100;
    el.depth.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  function pingActiveTab() {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== 'number') return;
        chrome.tabs.sendMessage(tab.id, { type: 'ca-ping' }, () => void chrome.runtime.lastError);
      });
    } catch (_) { /* no tab access */ }
  }

  function render() {
    document.body.classList.toggle('armed', cfg.enabled);

    if (!cfg.enabled) {
      document.body.classList.remove('think', 'fault');
      el.statusText.textContent = 'STANDBY';
      el.sitePill.textContent = 'NO BOARD';
      el.bestMove.textContent = '—';
      el.evalText.textContent = '0.00';
      el.barFill.style.width = '50%';
      el.depthNow.textContent = '—';
      el.engineName.textContent = 'stockfish';
      el.hint.textContent = 'toggle to arm';
      el.autoHint.textContent = 'plays your moves';
      el.auto.classList.remove('ready');
      hideVariants();
      lastMove = null;
      return;
    }

    const fresh = live && typeof live.ts === 'number' && Date.now() - live.ts < STALE_MS;
    if (!fresh) {
      document.body.classList.remove('think', 'fault');
      el.statusText.textContent = 'WAITING FOR BOARD';
      el.sitePill.textContent = 'NO BOARD';
      el.bestMove.textContent = '—';
      el.evalText.textContent = '0.00';
      el.barFill.style.width = '50%';
      el.depthNow.textContent = '—';
      el.engineName.textContent = 'stockfish';
      el.hint.textContent = 'open chess.com / lichess';
      el.autoHint.textContent = cfg.auto ? 'armed' : 'plays your moves';
      el.auto.classList.remove('ready');
      if (cfg.multi) showVariantEmpty('waiting for board');
      else hideVariants();
      lastMove = null;
      return;
    }

    document.body.classList.toggle('think', !!live.thinking);
    document.body.classList.toggle('fault', !!live.failed);

    if (live.failed) el.statusText.textContent = 'ENGINE ERROR';
    else if (live.autoBusy) el.statusText.textContent = 'AUTO PLAY';
    else if (live.thinking) el.statusText.textContent = 'ANALYSING';
    else if (live.move) el.statusText.textContent = 'LIVE';
    else el.statusText.textContent = 'ENGINE READY';

    el.sitePill.textContent = live.site || 'BOARD';
    el.engineName.textContent = (live.engine || 'stockfish').replace(/\s+/g, ' ').slice(0, 18);

    const move = live.from && live.to ? `${live.from.toUpperCase()} → ${live.to.toUpperCase()}` : '—';
    el.bestMove.textContent = move;
    if (move !== lastMove) {
      lastMove = move;
      if (move !== '—') {
        el.bestMove.classList.remove('flash');
        void el.bestMove.offsetWidth;
        el.bestMove.classList.add('flash');
      }
    }

    el.evalText.textContent = live.scoreText || '—';
    el.barFill.style.width = Math.max(3, Math.min(97, Number(live.bar) || 50)) + '%';
    el.depthNow.textContent = live.depth ? String(live.depth) : '—';
    el.hint.textContent = live.thinking ? 'searching…' : 'live overlay';

    if (cfg.auto) {
      if (live.autoBusy) el.autoHint.textContent = 'playing…';
      else if (live.autoNote) el.autoHint.textContent = live.autoNote;
      else if (live.autoTurn) el.autoHint.textContent = live.thinking ? 'arming…' : 'ready to play';
      else el.autoHint.textContent = 'waiting turn';
    } else {
      el.autoHint.textContent = 'plays your moves';
    }
    el.auto.classList.toggle('ready', !!(cfg.auto && live.autoTurn && !live.thinking && !live.autoBusy));

    renderVariants();
  }

  function hideVariants() {
    el.variantsPanel.hidden = true;
    el.variantList.textContent = '';
  }

  function showVariantEmpty(message) {
    el.variantsPanel.hidden = false;
    el.variantCount.textContent = (live && live.lines ? live.lines : cfg.lines) + ' LINES';
    el.variantList.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'v-empty';
    empty.textContent = message;
    el.variantList.appendChild(empty);
  }

  function renderVariants() {
    const list = cfg.multi && live && live.multi !== false ? (live.variants || []) : [];
    const requested = (live && live.lines) || cfg.lines;

    if (!cfg.multi) {
      hideVariants();
      return;
    }
    if (!list.length) {
      showVariantEmpty(live && live.thinking ? 'searching…' : 'awaiting position');
      return;
    }

    el.variantsPanel.hidden = false;
    el.variantCount.textContent = requested + ' LINES';
    el.variantList.textContent = '';

    for (const v of list) {
      const row = document.createElement('div');
      row.className = 'variant-row' + (v.rank === 1 ? ' top' : '');
      row.style.setProperty('--hue', String(typeof v.hue === 'number' ? v.hue : 145));

      const rank = document.createElement('span');
      rank.className = 'v-rank';
      rank.textContent = String(v.rank || 1);

      const moves = document.createElement('span');
      moves.className = 'v-moves';
      const pv = Array.isArray(v.pv) && v.pv.length ? v.pv : [v.move || ''];
      moves.textContent = pv.slice(0, 5).join(' ');
      moves.title = moves.textContent;

      const score = document.createElement('span');
      score.className = 'v-score';
      score.textContent = v.scoreText || '—';

      row.appendChild(rank);
      row.appendChild(moves);
      row.appendChild(score);
      el.variantList.appendChild(row);
    }
  }
})();
