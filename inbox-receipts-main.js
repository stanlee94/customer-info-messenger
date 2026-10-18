// Receipt bar — Business Suite inbox, page (MAIN world) half.
// Tags each customer photo / file bubble of the open chat with what the
// messenger-gatekeeper worker's rows are matched on (verified 2026-10-17 on the
// host's own chat, RHB PDF + TNG photo):
//   data-cim-rcpt-keys  JSON array of the stored file names in the bubble's
//                       links (`…_n.jpg` / `…_n.pdf`), attachment order — the
//                       one id Meta's page and the webhook share (message ids
//                       differ: mid.$c… here, m_… in the webhook)
//   data-cim-rcpt-ts    message time in ms — equal to the webhook's to the ms;
//                       only breaks a tie when one file is in two messages
// on the bubble's root element: the first DOM node of the component with
// `photos` (BizInboxMessagePhotoBubble) or with `attachment.playableUrl` +
// `message` (BizInboxMWXMAAttachmentWrapper — PDFs and other files). Found by
// prop shape, never by class or depth. The page's own bubbles are skipped.
// inbox-receipts.js (isolated world) draws the bars. Never moves Meta's nodes;
// sends nothing anywhere.
(() => {
  if (window.__cimRcptMain) return;
  window.__cimRcptMain = true;

  const FILE_KEY = /(\d+(?:_\d+){1,3}_[a-z]\.[a-z0-9]{2,5})/i;
  const PHOTO_DEPTH = 24;
  const FILE_DEPTH = 45;
  const FILE_LINKS = 'a[href*="l.facebook.com/l.php"], a[href*="fbsbx.com"]';
  const debug = (window.__cimRcptDebug = { tags: 0, passes: 0, maxMs: 0 });

  function fileKey(u) {
    if (typeof u !== 'string' || !u) return null;
    try {
      const url = new URL(u, location.href);
      // l.facebook.com/l.php?u=<the real link>
      const inner = url.searchParams.get('u');
      const m = decodeURIComponent(inner ? new URL(inner).pathname : url.pathname).match(FILE_KEY);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }

  // Meta stores some times as [high, low] 32-bit halves.
  function toMs(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    if (Array.isArray(v) && v.length === 2) return v[0] * 2 ** 32 + (v[1] >>> 0);
    if (v && typeof v === 'object' && 'high' in v && 'low' in v) return v.high * 2 ** 32 + (v.low >>> 0);
    return 0;
  }

  // A node's __reactFiber$ can be the stale alternate; __reactProps$ is current.
  function currentFiber(el) {
    let fk = null, pk = null;
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$')) fk = k;
      else if (k.startsWith('__reactProps$')) pk = k;
    }
    let f = fk ? el[fk] : null;
    if (f && pk && f.memoizedProps !== el[pk] && f.alternate && f.alternate.memoizedProps === el[pk]) f = f.alternate;
    return f;
  }

  function rootNode(fiber) {
    for (let f = fiber.child; f; f = f.child) if (typeof f.type === 'string') return f.stateNode instanceof Element ? f.stateNode : null;
    return null;
  }

  function messageAbove(fiber, depth) {
    for (let f = fiber, i = 0; f && i < depth; f = f.return, i++) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && p.message && typeof p.message === 'object' && p.message.messageID) return p;
    }
    return null;
  }

  // img → {root, keys, ts, mine} | null
  function readPhoto(img) {
    for (let f = currentFiber(img), i = 0; f && i < PHOTO_DEPTH; f = f.return, i++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object' || !Array.isArray(p.photos) || !p.photos.length) continue;
      const keys = p.photos.map((x) => fileKey(x && (x.largeUrl || x.url)));
      // Props must describe this <img> — otherwise they are stale; skip this pass.
      if (!keys.includes(fileKey(img.currentSrc || img.src))) return null;
      const root = rootNode(f);
      const mp = messageAbove(f, 8);
      if (!root) return null;
      return { root, keys, ts: mp ? toMs(mp.message.timestamp) : 0, mine: !!(p.isFromViewer || (mp && mp.isFromViewer)) };
    }
    return null;
  }

  // file link → {root, keys, ts, mine} | null
  function readFile(a) {
    for (let f = currentFiber(a), i = 0; f && i < FILE_DEPTH; f = f.return, i++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      const att = p.attachment;
      if (!att || typeof att !== 'object' || typeof att.playableUrl !== 'string') continue;
      if (!p.message || typeof p.message !== 'object') continue;   // keep climbing to the wrapper
      const root = rootNode(f);
      if (!root) return null;
      const key = fileKey(att.playableUrl) || fileKey(a.href);
      if (!key) return null;
      return { root, keys: [key], ts: toMs(p.message.timestamp) || toMs(att.timestampMs), mine: !!p.isFromViewer };
    }
    return null;
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function tagAll() {
    const t0 = performance.now();
    const tagged = new Set();
    const tag = (v) => {
      if (!v || tagged.has(v.root)) return;
      if (v.mine || !v.keys.some(Boolean)) return;
      tagged.add(v.root);
      setAttr(v.root, 'data-cim-rcpt-ts', String(v.ts || 0));
      const keys = JSON.stringify(v.keys);
      if (v.root.getAttribute('data-cim-rcpt-keys') !== keys) { v.root.setAttribute('data-cim-rcpt-keys', keys); debug.tags++; }
    };
    for (const img of document.querySelectorAll('img')) {
      if (/fbcdn\.net|fbsbx\.com/.test(img.currentSrc || img.src)) tag(readPhoto(img));
    }
    for (const a of document.querySelectorAll(FILE_LINKS)) tag(readFile(a));
    // A node React reused for something else loses its old tag.
    for (const el of document.querySelectorAll('[data-cim-rcpt-keys]')) {
      if (!tagged.has(el)) { el.removeAttribute('data-cim-rcpt-keys'); el.removeAttribute('data-cim-rcpt-ts'); }
    }
    debug.passes++;
    debug.maxMs = Math.max(debug.maxMs, performance.now() - t0);
  }

  // ── "Slip" tag on conversation-list rows ──
  // html[data-cim-slips] (inbox-receipts.js) = {"<last message ms>": [label, flagged]}.
  // A row's own component carries `thread` (BizInboxThreadListRowV2) whose
  // timestamp is the chat's last message time; a match → data-cim-slip (label,
  // drawn by styles.css) + data-cim-slip-flag. The virtual list reuses rows, so
  // every pass re-reads each row's thread; writes only on change.
  let slipSrc = null;
  let slipMap = {};
  // Where the pill goes (structure probe of real rows, 2026-10-19): Meta's label
  // chips (Ordered, Purchase, ad_id…) are 21px boxes with a 4px radius and a
  // background, each inside a row-flex box; the first chip's nearest row-flex
  // ancestor gets data-cim-slip-chip and CSS draws our pill as its ::before —
  // first in the line, Meta's exact chip shape. No chips → the row itself
  // carries data-cim-slip-pos="abs" and the pill sits where the chip line would
  // be, its left edge measured from the row's first text (--cim-slip-left).
  // Measured only when the row shows another chat or every 5 s, never per frame.
  const chipCache = new WeakMap();   // row → { key, at, anchor, left }
  const CHIP_RECHECK_MS = 5000;
  function isChip(el) {
    const h = el.offsetHeight;
    if (h < 14 || h > 30) return false;
    const cs = getComputedStyle(el);
    return cs.borderTopLeftRadius === '4px' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent';
  }
  function measureRow(row) {
    let anchor = null;
    for (const el of row.querySelectorAll('div')) {
      if (!isChip(el)) continue;
      for (let a = el.parentElement; a && a !== row; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if ((cs.display === 'flex' || cs.display === 'inline-flex') && cs.flexDirection === 'row') { anchor = a; break; }
      }
      break;
    }
    let left = 0;
    if (!anchor) {
      const rr = row.getBoundingClientRect();
      const ratio = row.offsetWidth ? rr.width / row.offsetWidth : 1;
      for (const el of row.querySelectorAll('div, span, abbr')) {
        if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
          left = Math.round((el.getBoundingClientRect().left - rr.left) / (ratio || 1));
          break;
        }
      }
    }
    return { anchor, left };
  }
  function syncSlipRows() {
    const src = document.documentElement.getAttribute('data-cim-slips') || '';
    if (src !== slipSrc) {
      slipSrc = src;
      try { slipMap = src ? JSON.parse(src) || {} : {}; } catch (e) { slipMap = {}; }
    }
    const list = document.querySelector('[data-pagelet="GenericThreadListView"]');
    if (!list) return;
    const anchors = new Set();
    const now = Date.now();
    for (const row of list.querySelectorAll('[role="presentation"]')) {
      let hit = null, key = '';
      if (src) {
        for (let f = currentFiber(row), i = 0; f && i < 2; f = f.return, i++) {
          const t = f.memoizedProps && f.memoizedProps.thread;
          if (t && t.threadFBID) { key = t.threadFBID + ':' + toMs(t.timestamp); hit = slipMap[String(toMs(t.timestamp))] || null; break; }
        }
      }
      if (!hit) {
        if (row.hasAttribute('data-cim-slip')) {
          row.removeAttribute('data-cim-slip');
          row.removeAttribute('data-cim-slip-flag');
          row.removeAttribute('data-cim-slip-pos');
        }
        continue;
      }
      let c = chipCache.get(row);
      if (!c || c.key !== key || now - c.at > CHIP_RECHECK_MS || (c.anchor && !(c.anchor.isConnected && row.contains(c.anchor)))) {
        c = Object.assign({ key, at: now }, measureRow(row));
        chipCache.set(row, c);
      }
      const label = String(hit[0]);
      const flag = hit[1] ? '1' : '0';
      setAttr(row, 'data-cim-slip', label);
      setAttr(row, 'data-cim-slip-flag', flag);
      if (c.anchor) {
        anchors.add(c.anchor);
        setAttr(row, 'data-cim-slip-pos', 'chip');
        setAttr(c.anchor, 'data-cim-slip-chip', label);
        setAttr(c.anchor, 'data-cim-slip-flag', flag);
      } else {
        setAttr(row, 'data-cim-slip-pos', 'abs');
        if (row.style.getPropertyValue('--cim-slip-left') !== c.left + 'px') row.style.setProperty('--cim-slip-left', c.left + 'px');
      }
    }
    // A chip box that no longer belongs to a tagged chat loses the pill.
    for (const el of list.querySelectorAll('[data-cim-slip-chip]')) {
      if (!anchors.has(el)) { el.removeAttribute('data-cim-slip-chip'); el.removeAttribute('data-cim-slip-flag'); }
    }
  }
  window.__cimSlipDebug = () => ({ map: slipMap, tagged: document.querySelectorAll('[data-cim-slip]').length });

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { tagAll(); } catch (e) { /* never throw into Meta's page */ }
      try { syncSlipRows(); } catch (e) { /* never throw into Meta's page */ }
    });
  }

  // childList + src changes (an <img> reused for another photo) + a new slip
  // map; our own data-cim-rcpt-* / data-cim-slip* writes never re-trigger it.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'data-cim-slips'] });
  schedule();
  // A row whose time changes through a text-only update fires no childList
  // mutation: re-check the ~20 visible rows every second (cheap, no layout reads),
  // and on every scroll frame — the virtual list may re-use a row element for
  // another chat while scrolling, and the tag must follow at once.
  let slipQueued = false;
  const scheduleSlips = () => {
    if (slipQueued) return;
    slipQueued = true;
    requestAnimationFrame(() => { slipQueued = false; try { syncSlipRows(); } catch (e) { /* never throw into Meta's page */ } });
  };
  document.addEventListener('scroll', scheduleSlips, { capture: true, passive: true });
  setInterval(scheduleSlips, 1000);
})();
