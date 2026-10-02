// Voice messages in the Business Suite inbox — extension (isolated world) half.
// inbox-voice-main.js copies each voice message's clip URL and Meta message id
// onto its play button (data-cim-voice-*). Here, under each one, we show its
// transcript — Gemini via background.js TRANSCRIBE_VOICE, cached per message in
// chrome.storage.local voiceTx:<id> — and 1× / 1.5× / 2× speed chips.
// Whole feature off when no geminiApiKey is set.
// Rules: Meta's nodes are never moved; our row is one sibling after the audio
// bubble, re-inserted when React drops it; every write is change-guarded; an
// answer is written only into rows whose data-cim-voice-for matches its id.
// Spec: docs/superpowers/specs/2026-10-02-voice-message-transcript-design.md
(() => {
  if (window.__cimVoice) return;
  window.__cimVoice = true;

  const TAGGED = 'a[data-cim-voice-id]:not([aria-hidden="true"])';
  const MAX_INFLIGHT = 2;
  const CACHE_PREFIX = 'voiceTx:';
  const CACHE_MAX = 3000;
  const CACHE_DROP = 500;
  const PRUNE_DELAY_MS = window.__cimVoicePruneDelay ?? 30000;
  const SPEEDS = [1, 1.5, 2];
  // Content-side backstop above the worst legitimate background time
  // (30 s download + 3 × 60 s Gemini + 8 s of retry waits).
  const REQUEST_TIMEOUT_MS = window.__cimVoiceReqTimeout ?? 220000;

  let enabled = false;
  let speed = 1;
  const memo = new Map();       // id → transcript ('' = no speech)
  const failed = new Set();     // ids whose last attempt failed (never cached)
  const lookedUp = new Set();   // ids whose cache entry was read (or is being read)
  const inflight = new Set();
  const deadlines = new Map();   // id → timer of an in-flight request
  const queue = [];             // ids waiting, in want() order (newest first)
  const queued = new Set();
  const onScreen = new Set();
  const srcOf = new Map();      // id → latest clip URL seen on its button
  const observed = new WeakSet();
  const stats = (window.__cimVoiceStats = { maxSyncMs: 0, syncs: 0 });

  // Requests wait (≤ IO_WAIT_MS) for the first visibility report on newly seen
  // buttons, so the first picks are the messages on screen, not just the newest.
  const IO_WAIT_MS = 250;
  const unreported = new Set();
  let ioDeadline = 0;
  let ioTimer = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      unreported.delete(e.target);
      const id = e.target.getAttribute('data-cim-voice-id');
      if (!id) continue;
      if (e.isIntersecting) onScreen.add(id); else onScreen.delete(id);
    }
    pump();
  });

  // ── rows ──
  function hostOf(a) { return a.parentElement?.parentElement || a.parentElement; }

  function buildRow() {
    const row = document.createElement('div');
    row.className = 'cim-voice';
    const text = document.createElement('div');
    text.className = 'cim-voice-text';
    // One WhatsApp-style speed pill that cycles 1× → 1.5× → 2×.
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'cim-voice-speed';
    // Long transcripts fold to FOLD_LINES (CSS) behind Show more / Show less.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'cim-voice-more';
    row.append(text, more, pill);
    // Keep our clicks away from Meta's message handlers.
    row.addEventListener('click', onRowClick);
    return row;
  }

  function stateOf(id) {
    if (memo.has(id)) return 'done';
    if (failed.has(id)) return 'failed';
    return 'pending';
  }

  function renderRow(row) {
    const id = row.dataset.cimVoiceFor;
    const state = stateOf(id);
    const text = state === 'done' ? (memo.get(id) || '(no speech)') : '';
    const key = `${state}|${text}|${speed}`;
    if (row._cimKey === key) return;
    row._cimKey = key;
    row.dataset.state = state;
    const box = row.querySelector('.cim-voice-text');
    if (state === 'done') { box.textContent = text; measureFold(row); }
    else if (state === 'pending') box.textContent = 'Transcribing…';
    if (state !== 'done') row.classList.remove('cim-voice--long', 'cim-voice--folded');
    if (state === 'failed') {
      box.textContent = 'Couldn\'t transcribe · ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'cim-voice-retry';
      retry.textContent = 'Retry';
      box.append(retry);
    }
    renderSpeed(row.querySelector('.cim-voice-speed'));
  }

  function renderSpeed(pill) {
    if (!pill) return;
    const label = speed + '×';
    if (pill.textContent !== label) pill.textContent = label;
    const aria = `Playback speed ${label} — click to change`;
    if (pill.getAttribute('aria-label') !== aria) pill.setAttribute('aria-label', aria);
    const fast = speed !== 1;
    if (pill.classList.contains('cim-voice-speed--fast') !== fast) pill.classList.toggle('cim-voice-speed--fast', fast);
  }

  // One layout read per transcript change: fold it, see whether it overflows.
  function measureFold(row) {
    const box = row.querySelector('.cim-voice-text');
    row.classList.add('cim-voice--long', 'cim-voice--folded');
    const long = box.scrollHeight > box.clientHeight + 1;
    if (!long) row.classList.remove('cim-voice--long', 'cim-voice--folded');
    else applyFold(row);
  }

  function applyFold(row) {
    const open = row.dataset.cimVoiceOpen === '1';
    row.classList.toggle('cim-voice--folded', !open);
    const more = row.querySelector('.cim-voice-more');
    const label = open ? 'Show less' : 'Show more';
    if (more.textContent !== label) more.textContent = label;
    more.setAttribute('aria-expanded', String(open));
  }

  function renderAll(id) {
    for (const row of document.querySelectorAll(`.cim-voice[data-cim-voice-for="${CSS.escape(id)}"]`)) renderRow(row);
  }

  // claimed: host → id for this sync pass. Two buttons under one host (a
  // message with two clips, or a shallower DOM than expected) would otherwise
  // pass the single row back and forth forever; the first (newest) one wins.
  function ensureRow(a, id, claimed) {
    const host = hostOf(a);
    if (!host || !host.parentElement) return false;
    const owner = claimed.get(host);
    if (owner !== undefined && owner !== id) return false;
    claimed.set(host, id);
    let row = host.nextElementSibling;
    if (!row || !row.classList.contains('cim-voice')) {
      row = buildRow();
      host.after(row);
    }
    if (row.dataset.cimVoiceFor !== id) { row.dataset.cimVoiceFor = id; row._cimKey = ''; delete row.dataset.cimVoiceOpen; }
    const mine = a.getAttribute('data-cim-voice-mine') === '1';
    if (row.classList.contains('cim-voice--mine') !== mine) row.classList.toggle('cim-voice--mine', mine);
    renderRow(row);
    return true;
  }

  function removeAllRows() {
    for (const row of document.querySelectorAll('.cim-voice')) row.remove();
  }

  // ── queue ──
  function want(id) {
    if (memo.has(id) || failed.has(id) || inflight.has(id) || queued.has(id) || lookedUp.has(id)) return;
    lookedUp.add(id);
    try {
      chrome.storage.local.get([CACHE_PREFIX + id], (r) => {
        const hit = r && r[CACHE_PREFIX + id];
        if (hit && typeof hit.t === 'string') { memo.set(id, hit.t); renderAll(id); return; }
        enqueue(id, false);
      });
    } catch (e) {
      // Extension reloaded while this tab stayed open: every chrome.* call throws.
      lookedUp.delete(id);
      failed.add(id);
      renderAll(id);
    }
  }

  function enqueue(id, front) {
    if (queued.has(id) || inflight.has(id)) return;
    queued.add(id);
    front ? queue.unshift(id) : queue.push(id);
    pump();
  }

  function takeNext() {
    const vis = queue.findIndex((id) => onScreen.has(id));
    const id = queue.splice(vis >= 0 ? vis : 0, 1)[0];
    queued.delete(id);
    return id;
  }

  function finish(id, res) {
    if (!inflight.has(id)) return;   // already timed out — ignore a late answer
    clearTimeout(deadlines.get(id));
    deadlines.delete(id);
    inflight.delete(id);
    if (res && res.ok) {
      const t = typeof res.text === 'string' ? res.text : '';
      memo.set(id, t);
      try { chrome.storage.local.set({ [CACHE_PREFIX + id]: { t, at: Date.now() } }); } catch (e) { /* context gone: shown, not cached */ }
    } else {
      failed.add(id);
    }
    renderAll(id);
    pump();
  }

  function pump() {
    const wait = unreported.size ? ioDeadline - performance.now() : 0;
    if (wait > 0) {
      clearTimeout(ioTimer);
      ioTimer = setTimeout(pump, wait + 1);
      return;
    }
    while (enabled && inflight.size < MAX_INFLIGHT && queue.length) {
      const id = takeNext();
      const url = srcOf.get(id);
      if (!url) continue;
      inflight.add(id);
      deadlines.set(id, setTimeout(() => finish(id, { ok: false, error: 'timeout' }), REQUEST_TIMEOUT_MS));
      try {
        chrome.runtime.sendMessage({ type: 'TRANSCRIBE_VOICE', url, messageId: id }, (res) => {
          void chrome.runtime.lastError;
          finish(id, res);
        });
      } catch (e) {
        // Extension reloaded while this tab stayed open.
        finish(id, { ok: false, error: 'context' });
      }
    }
  }

  function retry(id) {
    failed.delete(id);
    const a = document.querySelector(`${TAGGED}[data-cim-voice-id="${CSS.escape(id)}"]`);
    if (a) srcOf.set(id, a.getAttribute('data-cim-voice-src'));
    renderAll(id);
    enqueue(id, true);
  }

  function onRowClick(e) {
    e.stopPropagation();
    const row = e.currentTarget;
    if (e.target.closest('.cim-voice-retry')) { e.preventDefault(); retry(row.dataset.cimVoiceFor); return; }
    if (e.target.closest('.cim-voice-more')) {
      e.preventDefault();
      if (row.dataset.cimVoiceOpen === '1') delete row.dataset.cimVoiceOpen; else row.dataset.cimVoiceOpen = '1';
      applyFold(row);
      return;
    }
    if (e.target.closest('.cim-voice-speed')) {
      e.preventDefault();
      setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]);
    }
  }

  // ── speed ──
  function setSpeed(r) {
    if (!SPEEDS.includes(r) || r === speed) return;
    speed = r;
    try { chrome.storage.local.set({ voiceSpeed: r }); } catch (e) { /* context gone: applies to this page only */ }
    applySpeed();
    for (const row of document.querySelectorAll('.cim-voice')) renderRow(row);
  }

  function applySpeed() {
    const html = document.documentElement;
    if (!enabled) { if ('cimVoiceRate' in html.dataset) delete html.dataset.cimVoiceRate; return; }
    if (html.dataset.cimVoiceRate !== String(speed)) html.dataset.cimVoiceRate = String(speed);
  }

  // ── sync ──
  function sync() {
    const t0 = performance.now();
    if (!enabled) { removeAllRows(); return; }
    const anchors = document.querySelectorAll(TAGGED);
    const claimed = new Map();
    for (let i = anchors.length - 1; i >= 0; i--) {   // bottom-up = newest first
      const a = anchors[i];
      const id = a.getAttribute('data-cim-voice-id');
      if (!id) continue;
      srcOf.set(id, a.getAttribute('data-cim-voice-src'));
      if (!observed.has(a)) {
        observed.add(a);
        unreported.add(a);
        ioDeadline = performance.now() + IO_WAIT_MS;
        io.observe(a);
      }
      if (ensureRow(a, id, claimed)) want(id);
    }
    // Rows whose button is gone or now belongs to another message.
    for (const row of document.querySelectorAll('.cim-voice')) {
      const prev = row.previousElementSibling;
      const mine = `${TAGGED}[data-cim-voice-id="${CSS.escape(row.dataset.cimVoiceFor || '')}"]`;
      if (!prev || !(prev.matches?.(mine) || prev.querySelector?.(mine))) row.remove();
    }
    pump();
    stats.syncs++;
    stats.maxSyncMs = Math.max(stats.maxSyncMs, performance.now() - t0);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try { sync(); } catch (e) { console.warn('[CIM voice]', e); }
    });
  }

  // ── cache pruning ──
  async function prune() {
    try {
      if (!chrome.storage.local.getKeys) return;
      const keys = (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(CACHE_PREFIX));
      if (keys.length <= CACHE_MAX) return;
      const all = await chrome.storage.local.get(keys);
      const oldest = keys.sort((x, y) => (all[x]?.at || 0) - (all[y]?.at || 0)).slice(0, CACHE_DROP);
      await chrome.storage.local.remove(oldest);
    } catch (e) { console.warn('[CIM voice] prune', e); }
  }

  // ── start ──
  function setEnabled(on) {
    if (enabled === on) return;
    enabled = on;
    if (!on) {
      for (const id of queued) lookedUp.delete(id);
      queue.length = 0;
      queued.clear();
    }
    applySpeed();
    schedule();
  }

  chrome.storage.local.get(['geminiApiKey', 'voiceSpeed'], (r) => {
    if (SPEEDS.includes(r.voiceSpeed)) speed = r.voiceSpeed;
    setEnabled(!!r.geminiApiKey);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.geminiApiKey) setEnabled(!!changes.geminiApiKey.newValue);
    if (changes.voiceSpeed && SPEEDS.includes(changes.voiceSpeed.newValue) && changes.voiceSpeed.newValue !== speed) {
      speed = changes.voiceSpeed.newValue;
      applySpeed();
      schedule();
    }
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-cim-voice-id'],
  });
  setTimeout(prune, PRUNE_DELAY_MS);
})();
