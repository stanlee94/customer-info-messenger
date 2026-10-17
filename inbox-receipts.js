// Receipt bar — Business Suite inbox, extension (isolated world) half.
// Under every customer photo / PDF that the messenger-gatekeeper worker read as
// a payment receipt, a bar with what the slip says: amount (click = copy),
// method, paid time, payee, the payer's note (click = copy), slip status, and red
// warnings (duplicate slip, not paid to a DD account, not successful).
// Messenger blue when nothing is wrong (never green — green reads as
// "approved"), red when a warning is raised.
// Data: background.js GET_RECEIPTS → worker GET /receipts?psid= (Bearer
// analysisApiToken; empty token = feature off). Matching: the stored file name
// in the attachment's link (data-cim-rcpt-keys from inbox-receipts-main.js) =
// the worker's file_key; when one file is in two messages, the message time
// (data-cim-rcpt-ts) picks the closest row. No file-name match → no bar, ever.
// Customer isolation: the PSID comes only from html[data-cim-psid] (content.js
// sets it while the linked customer is the one on screen, never while
// "Switching customer…"), checked against the URL uid; a reply for a customer
// no longer open is dropped; every bar carries the PSID it was drawn for and
// all bars go when the PSID changes.
// Rules: Meta's nodes are never moved — our group is one sibling after the
// bubble, re-inserted when React drops it; every write is change-guarded.
(() => {
  if (window.__cimRcpt) return;
  window.__cimRcpt = true;

  const cfg = Object.assign({ cacheMs: 60000, recheckMs: 10000, freshMs: 3 * 60000, replyTimeoutMs: 20000 }, window.__cimRcptCfg || {});
  const TAGGED = '[data-cim-rcpt-keys]';
  const TZ = 'Asia/Kuala_Lumpur';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const stats = (window.__cimRcptStats = { requests: 0, dropped: 0, syncs: 0 });

  let enabled = false;
  const cache = new Map();      // psid → { items, at }
  const lastAsk = new Map();    // psid → ms of the last request
  let inflight = null;          // { psid, seq }
  let seq = 0;
  let lastPsid = null;
  let lastUid = null;
  let recheckTimer = 0;
  let warned = false;

  const uidNow = () => {
    try { return new URLSearchParams(location.search).get('selected_item_id') || ''; } catch (e) { return ''; }
  };

  function currentPsid() {
    const h = document.documentElement;
    const psid = h.getAttribute('data-cim-psid');
    const uid = h.getAttribute('data-cim-psid-uid');
    return psid && uid && uid === uidNow() ? psid : null;
  }

  // ── data ──
  function ask(psid) {
    if (inflight && inflight.psid === psid) return;
    const my = { psid, seq: ++seq };
    inflight = my;
    lastAsk.set(psid, Date.now());
    stats.requests++;
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(backstop);
      if (inflight === my) inflight = null;
      if (my.seq !== seq || currentPsid() !== psid) { stats.dropped++; schedule(); return; }
      if (res && res.ok && Array.isArray(res.items)) {
        cache.set(psid, { items: res.items, at: Date.now() });
      } else {
        if (!warned) console.warn('[CIM receipts] worker not reachable:', (res && res.error) || 'no reply');
        warned = true;
        const old = cache.get(psid);
        cache.set(psid, { items: old ? old.items : [], at: Date.now() });
      }
      schedule();
    };
    const backstop = setTimeout(() => finish({ ok: false, error: 'timeout' }), cfg.replyTimeoutMs);
    try {
      chrome.runtime.sendMessage({ type: 'GET_RECEIPTS', psid }, (res) => { void chrome.runtime.lastError; finish(res); });
    } catch (e) {
      finish({ ok: false, error: 'context' });   // extension reloaded while the tab stayed open
    }
  }

  function pick(items, key, ts) {
    let best = null, bestGap = Infinity;
    for (const it of items) {
      if (!it || it.file_key !== key) continue;
      const gap = ts ? Math.abs((it.ts_ms || 0) - ts) : 0;
      if (gap < bestGap) { best = it; bestGap = gap; }
    }
    return best;
  }

  // ── formatting ──
  function money(amount, currency) {
    if (typeof amount !== 'number' || !isFinite(amount)) return null;
    const n = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (currency === 'MYR') return 'RM ' + n;
    if (currency === 'SGD') return 'S$ ' + n;
    return (currency && currency !== 'OTHER' ? currency + ' ' : '') + n;
  }

  // "YYYY-MM-DD HH:mm" as printed on the slip → "17 Oct, 14:36" (year when not this year).
  function slipTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return s ? String(s) : null;
    const year = Number(m[1]) !== new Date().getFullYear() ? ' ' + m[1] : '';
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]}${year}${m[4] ? `, ${m[4]}:${m[5]}` : ''}`;
  }

  function msTime(ms) {
    if (!ms) return null;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return slipTime(`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`);
  }

  function warnings(r) {
    const out = [];
    const flags = Array.isArray(r.flags) ? r.flags : [];
    if (flags.some((f) => String(f).startsWith('duplicate_of:'))) {
      const d = r.duplicate || {};
      const when = msTime(d.ts_ms);
      out.push(!when ? 'Duplicate — this slip was sent before'
        : d.same_customer ? `Duplicate — this customer sent the same slip on ${when}`
          : `Duplicate — another customer sent the same slip on ${when}`);
    }
    if (flags.includes('wrong_payee')) out.push('Not paid to a DD account — check the payee');
    if (flags.includes('not_successful')) out.push('Slip does not show "successful"');
    for (const f of flags) {
      const s = String(f);
      if (!s.startsWith('duplicate_of:') && s !== 'wrong_payee' && s !== 'not_successful') out.push(s);
    }
    return out;
  }

  // ── bars ──
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function copyBtn(cls, text, value, label) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.dataset.copy = value;
    b.setAttribute('aria-label', label);
    return b;
  }

  function buildBar(item, index, total) {
    const r = item.receipt;
    const warn = warnings(r);
    const bar = el('div', 'cim-rcpt ' + (warn.length ? 'cim-rcpt--warn' : 'cim-rcpt--ok'));

    const head = el('div', 'cim-rcpt-head');
    head.append(el('span', 'cim-rcpt-label', 'Receipt' + (total > 1 ? ` · ${index + 1} of ${total}` : '')));
    const status = String(r.status_on_slip || '').toLowerCase();
    head.append(el('span', 'cim-rcpt-status' + (status === 'successful' ? '' : ' cim-rcpt-status--bad'),
      // What the slip says — not a verdict: no ✓, no green (nobody has checked it yet).
      status === 'successful' ? 'Slip: Successful' : '⚠ ' + (status ? 'Slip: ' + status[0].toUpperCase() + status.slice(1) : 'Status not on slip')));
    bar.append(head);

    const amount = money(r.amount, r.currency);
    bar.append(amount ? copyBtn('cim-rcpt-amount', amount, r.amount.toFixed(2), `Copy amount ${r.amount.toFixed(2)}`)
      : el('div', 'cim-rcpt-amount cim-rcpt-muted', 'Amount not read'));

    const meta = [r.method, slipTime(r.paid_at)].filter(Boolean).join(' · ');
    if (meta) bar.append(el('div', 'cim-rcpt-line', meta));

    const to = el('div', 'cim-rcpt-line');
    if (r.payee_name) { to.append('To '); to.append(el('b', 'cim-rcpt-payee', r.payee_name)); } else { to.classList.add('cim-rcpt-muted'); to.textContent = 'Payee not on slip'; }
    bar.append(to);

    // The payer's own words (Payment Details / Recipient Reference / Description …),
    // not the bank's transaction number — that one only feeds the duplicate check.
    const note = el('div', 'cim-rcpt-line cim-rcpt-noteline');
    if (r.payment_note) { note.append(el('span', 'cim-rcpt-notelabel', 'Note')); note.append(copyBtn('cim-rcpt-note', r.payment_note, r.payment_note, 'Copy note')); } else { note.classList.add('cim-rcpt-muted'); note.textContent = 'No note on slip'; }
    bar.append(note);

    if (warn.length) {
      const list = el('ul', 'cim-rcpt-warns');
      for (const w of warn) list.append(el('li', null, w));
      bar.append(list);
    }
    bar.append(el('div', 'cim-rcpt-foot', 'Read by AI — check the slip before confirming'));
    return bar;
  }

  function onClick(e) {
    e.stopPropagation();   // keep our clicks away from Meta's message handlers
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    const value = b.dataset.copy;
    const flash = () => {
      if (b._cimFlash) return;
      const text = b.textContent;
      b._cimFlash = true;
      b.classList.add('cim-rcpt-copied');
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = text; b.classList.remove('cim-rcpt-copied'); b._cimFlash = false; }, 1200);
    };
    try {
      navigator.clipboard.writeText(value).then(flash, () => { fallbackCopy(value); flash(); });
    } catch (err) { fallbackCopy(value); flash(); }
  }

  function fallbackCopy(value) {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    ta.remove();
  }

  // The bar goes after the bubble — or, when the bubble sits in a row layout
  // (it would land beside it), after the nearest ancestor that doesn't (≤ 4
  // levels). One style read per bubble, remembered.
  const anchors = new WeakMap();
  function anchorFor(host) {
    const known = anchors.get(host);
    if (known && known.isConnected && known.contains(host)) return known;
    let n = host;
    for (let i = 0; i < 4 && n.parentElement && n.parentElement !== document.body; i++) {
      const cs = getComputedStyle(n.parentElement);
      const row = (cs.display.includes('flex') && !cs.flexDirection.startsWith('column')) || cs.display.includes('grid');
      if (!row) break;
      n = n.parentElement;
    }
    anchors.set(host, n);
    return n;
  }

  // ── seamless join ──
  // The bar continues the bubble as one card: same width and left edge, flush
  // under it, taking over its bottom corners. Meta's rounded boxes along the
  // bubble's bottom edge get an inline custom property that CSS flattens
  // (React rewrites className, not unknown style properties — never a class on
  // a Meta node) holding the radius it had, so a redrawn bar still knows it;
  // removed again when the bar goes. Measured when a bar is drawn and when the
  // bubble resizes, never per frame.
  const JOIN = '--cim-rcpt-join';
  const MIN_W = 240;
  const MAX_GAP = 24;
  const groupOf = new WeakMap();   // bubble → its group
  const watchedBy = new WeakMap(); // bubble, its photos and joined boxes → group
  // Re-measure when the bubble OR the photo inside it changes size: Meta
  // reserves the bubble's size and swaps the photo in later (real tab,
  // 2026-10-17 — the bubble never resized, the photo moved up 5px, a gap stayed).
  const resizes = new ResizeObserver((entries) => {
    const seen = new Set();
    for (const e of entries) {
      const g = watchedBy.get(e.target);
      if (g && g.isConnected && !seen.has(g)) { seen.add(g); join(g); }
    }
  });
  function watch(g, nodes) {
    g._cimWatch = g._cimWatch || new Set();
    for (const n of nodes) {
      if (g._cimWatch.has(n)) continue;
      g._cimWatch.add(n);
      watchedBy.set(n, g);
      resizes.observe(n);
    }
  }
  // A photo finishing loading (load doesn't bubble — caught in capture).
  const loadHooked = new WeakSet();
  function onBubbleLoad(e) {
    const g = groupOf.get(e.currentTarget);
    if (g && g.isConnected && e.target.tagName === 'IMG') join(g);
  }

  function flagged(host) {
    return [host, ...host.querySelectorAll(`[style*="${JOIN}"]`)].filter((n) => n.style.getPropertyValue(JOIN));
  }

  // A node's bottom-corner radius: its own, or a ::before/::after layer's
  // (Meta draws photo outlines that way) — or, once flattened, the radius it had.
  function radiusOf(n) {
    const kept = parseFloat(n.style.getPropertyValue(JOIN));
    if (kept) return kept;
    let r = 0;
    for (const which of [null, '::before', '::after']) {
      const cs = getComputedStyle(n, which);
      if (which && (!cs.content || cs.content === 'none')) continue;
      r = Math.max(r, parseFloat(cs.borderBottomLeftRadius) || 0, parseFloat(cs.borderBottomRightRadius) || 0);
    }
    return r;
  }

  // The bubble's visible frame. Meta's photo bubble is taller than the photo
  // (room under it — seen 2026-10-17: a ~12px gap and round corners left
  // under the bar when the outer box was used), so: the largest rounded box
  // inside, widened to every rounded box sharing its bottom edge (a photo grid).
  function frameOf(host) {
    const hr = host.getBoundingClientRect();
    const rounded = [];
    for (const n of [host, ...host.querySelectorAll('*')].slice(0, 80)) {
      const b = n.getBoundingClientRect();
      if (b.width < 40 || b.height < 20) continue;
      const r = radiusOf(n);
      if (r) rounded.push({ n, b, r });
    }
    if (!rounded.length) return { rect: hr, edge: [] };
    const main = rounded.reduce((x, y) => (y.b.width * y.b.height > x.b.width * x.b.height ? y : x));
    const edge = rounded.filter((x) => Math.abs(x.b.bottom - main.b.bottom) <= 2);
    const left = Math.min(...edge.map((x) => x.b.left));
    const right = Math.max(...edge.map((x) => x.b.right));
    return { rect: { left, right, width: right - left, bottom: main.b.bottom }, edge };
  }

  function join(g) {
    const host = g._cimHost;
    if (!host || !host.isConnected || !host.getBoundingClientRect().width) return;
    const f = frameOf(host);
    for (const x of f.edge) if (!x.n.style.getPropertyValue(JOIN)) x.n.style.setProperty(JOIN, String(x.r));
    g._cimFlat = flagged(host);
    watch(g, [host, ...f.edge.map((x) => x.n), ...host.querySelectorAll('img')]);
    if (!loadHooked.has(host)) { loadHooked.add(host); host.addEventListener('load', onBubbleLoad, true); }
    const radius = Math.max(0, ...g._cimFlat.map((n) => parseFloat(n.style.getPropertyValue(JOIN)) || 0));
    const set = (prop, v) => { if (g.style.getPropertyValue(prop) !== v) g.style.setProperty(prop, v); };
    set('--cim-rcpt-r', (radius || 8) + 'px');
    set('width', Math.max(Math.round(f.rect.width), MIN_W) + 'px');
    // Line up with the frame even when the bar is placed after a wider ancestor.
    g.style.marginLeft = '0px';
    g.style.marginTop = '0px';
    const gr = g.getBoundingClientRect();
    const gap = gr.top - f.rect.bottom;
    g.style.marginLeft = Math.round(f.rect.left - gr.left) + 'px';
    g.style.marginTop = gap > 0 && gap <= MAX_GAP ? -Math.round(gap) + 'px' : '0px';
  }

  // Only the bar that currently owns the bubble puts its corners back.
  function unjoin(g) {
    const host = g._cimHost;
    if (host && groupOf.get(host) === g) {
      for (const n of g._cimFlat || []) n.style.removeProperty(JOIN);
      groupOf.delete(host);
    }
    for (const n of g._cimWatch || []) { if (watchedBy.get(n) === g) { resizes.unobserve(n); watchedBy.delete(n); } }
    g._cimWatch = null;
    g._cimFlat = [];
  }

  function dropGroup(g) {
    unjoin(g);
    g.remove();
  }

  function render(host, found, total, psid) {
    const anchor = anchorFor(host);
    let group = anchor.nextElementSibling;
    const has = !!group && group.classList.contains('cim-rcpt-group');
    if (!found.length) { if (has) dropGroup(group); return; }
    if (!has) {
      group = el('div', 'cim-rcpt-group');
      group.addEventListener('click', onClick);
      anchor.after(group);
    }
    if (group._cimHost !== host) {
      if (group._cimHost) unjoin(group);
      group._cimHost = host;
      groupOf.set(host, group);
      join(group);
    }
    const keys = host.getAttribute('data-cim-rcpt-keys');
    const sig = psid + '|' + keys + '|' + JSON.stringify(found.map((f) => [f.i, f.item]));
    if (group._cimSig === sig) return;
    group._cimSig = sig;
    group.dataset.psid = psid;
    group.dataset.for = keys;
    group.replaceChildren(...found.map((f) => buildBar(f.item, f.i, total)));
  }

  function removeAll() {
    for (const g of document.querySelectorAll('.cim-rcpt-group')) dropGroup(g);
  }

  // ── sync ──
  function sync() {
    stats.syncs++;
    lastUid = uidNow();
    const psid = enabled ? currentPsid() : null;
    if (psid !== lastPsid) {
      lastPsid = psid;
      removeAll();
      if (psid) {
        const c = cache.get(psid);
        if (!c || Date.now() - c.at > cfg.cacheMs) ask(psid);
      }
    }
    if (!psid) { removeAll(); return; }

    const entry = cache.get(psid);
    const items = entry ? entry.items : null;
    const now = Date.now();
    let waiting = false;
    const hosts = document.querySelectorAll(TAGGED);
    for (const host of hosts) {
      let keys;
      try { keys = JSON.parse(host.getAttribute('data-cim-rcpt-keys')); } catch (e) { keys = null; }
      if (!Array.isArray(keys)) continue;
      const ts = Number(host.getAttribute('data-cim-rcpt-ts')) || 0;
      const found = [];
      keys.forEach((k, i) => {
        const item = k && items ? pick(items, k, ts) : null;
        if (item && item.kind === 'receipt' && item.receipt) found.push({ i, item });
        // A new attachment the worker hasn't stored or read yet: ask again soon.
        if (k && items && ts && now - ts < cfg.freshMs && (!item || !item.kind)) waiting = true;
      });
      render(host, found, keys.length, psid);
    }
    // Groups whose bubble is gone, re-tagged, or drawn for another customer.
    for (const g of document.querySelectorAll('.cim-rcpt-group')) {
      const host = g._cimHost;
      const ok = g.dataset.psid === psid && host && host.isConnected &&
        host.getAttribute('data-cim-rcpt-keys') === g.dataset.for && anchorFor(host).nextElementSibling === g;
      if (!ok) dropGroup(g);
    }
    if (waiting) {
      const since = now - (lastAsk.get(psid) || 0);
      if (since >= cfg.recheckMs) ask(psid);
      clearTimeout(recheckTimer);
      recheckTimer = setTimeout(schedule, Math.max(cfg.recheckMs - since, 0) + 50);
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try { sync(); } catch (e) { console.warn('[CIM receipts]', e); }
    });
  }

  function setEnabled(on) {
    if (enabled === on) return;
    enabled = on;
    if (!on) cache.clear();
    schedule();
  }

  chrome.storage.local.get('analysisApiToken', (r) => setEnabled(!!(r && r.analysisApiToken)));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.analysisApiToken) { cache.clear(); setEnabled(!!changes.analysisApiToken.newValue); }
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-cim-rcpt-keys', 'data-cim-rcpt-ts', 'data-cim-psid', 'data-cim-psid-uid'],
  });
  // A URL-only switch has no DOM change: bars must still go at once.
  setInterval(() => { if (uidNow() !== lastUid) schedule(); }, 500);
})();
