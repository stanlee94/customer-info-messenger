// Keep unanswered chats unread — Business Suite inbox, page (MAIN world).
//
// Goal: customer service opens only UNREAD conversations. Meta keeps that
// state for us (a customer message makes a chat unread; automations don't
// clear it), except when someone opens a chat and doesn't reply: Meta's
// auto-open on load, a stray click, reading and moving on. This script undoes
// exactly that, for the open chat only, with Meta's own "Mark as unread".
//
// The open chat's messages are already in the page (Meta loaded them to draw
// the chat), read from React props by shape - no network:
//   message.isFromViewer false          → the customer wrote it
//   message.creatorInfo (staff name)    → staff typed it
//   message.creatorInfo null            → automation (ManyChat etc.)
//   message.reactions[].user.userID     → who reacted (our page = viewerID)
// Waiting = the customer's last message is newer than the last staff-typed
// message and our page has not reacted to it (a reaction = "no reply needed").
//
// Rules: acts only while the composer is idle (not focused, empty) and the
// messages have been still for SETTLE_MS; only by clicking Meta's own "Mark as
// unread" (the chat header's envelope, or the same item in its ··· menu when
// the header is too narrow to show it); at most MAX_TRIES per visit; undoes its
// own marking (Mark as read) if the chat stops waiting during the same visit
// (a ❤️). Never sends anything, never moves Meta's nodes. Anything it cannot
// read or find → it does nothing (today's behaviour).
// Also: every visible PENDING row of the conversation list (unread, or the
// open chat still waiting) is tinted light red.
// Off when html[data-cim-keep-unread="0"] (set by content.js from the options).
(() => {
  if (window.__cimUnread) return;
  const cfg = Object.assign({ settleMs: 1500, retryMs: 10000, maxTries: 3, menuWaitMs: 1500, sendQuietMs: 15000, typeQuietMs: 4000, tickMs: 700 }, window.__cimUnreadCfg || {});
  const dbg = (window.__cimUnread = { cfg, log: [], clicks: 0, state: null });

  const MARK_UNREAD = /^(mark as unread|标为未读|標示為未讀|标记为未读|標記為未讀|tandakan sebagai belum dibaca)$/i;
  const MARK_READ = /^(mark as read|标为已读|標示為已讀|标记为已读|標記為已讀|tandakan sebagai sudah dibaca)$/i;
  const MENU_BTN = /^(open drop-?down|more|more options|更多|更多选项|更多選項)$/i;

  const note = (o) => {
    dbg.log.push(Object.assign({ at: new Date().toISOString().slice(11, 23) }, o));
    if (dbg.log.length > 200) dbg.log.splice(0, 100);
    try { console.debug('[cim unread]', o); } catch (e) { /* ignore */ }
  };

  // ── React data, current version (a DOM node's __reactFiber$ can point at the
  // stale alternate; __reactProps$ is always the latest props of that node).
  function currentFiber(el) {
    if (!el) return null;
    let fk = null, pk = null;
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$')) fk = k;
      else if (k.startsWith('__reactProps$')) pk = k;
    }
    let f = fk ? el[fk] : null;
    if (f && pk && f.memoizedProps !== el[pk] && f.alternate && f.alternate.memoizedProps === el[pk]) f = f.alternate;
    return f;
  }
  function propsUp(el, test, depth) {
    for (let f = currentFiber(el), i = 0; f && i < depth; f = f.return, i++) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && test(p)) return p;
    }
    return null;
  }

  const uidNow = () => {
    try { return new URLSearchParams(location.search).get('selected_item_id') || ''; } catch (e) { return ''; }
  };

  // The open chat's messages: [{id, ts, customer, staff, page reaction, sending}].
  function readMessages(uid) {
    const out = [];
    const seen = new Set();
    let viewerID = '';
    let otherChat = false;
    for (const el of document.querySelectorAll('[data-message-id]')) {
      const id = el.getAttribute('data-message-id');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const p = propsUp(el, (x) => x.message && typeof x.message === 'object' && 'isFromViewer' in x, 24);
      if (!p) continue;
      const m = p.message;
      if (Array.isArray(p.participants) && p.participants.length && !p.participants.some((u) => u && String(u.userID) === uid)) { otherChat = true; continue; }
      viewerID = viewerID || String(p.viewerID || '');
      const reacted = (list) => Array.isArray(list) && list.some((r) => r && ((r.user && String(r.user.userID) === String(p.viewerID)) || String(r.userID || r.actorID || '') === String(p.viewerID)));
      const state = m.deliveryStatePayload && m.deliveryStatePayload.deliveryState;
      out.push({
        id,
        ts: Number(m.timestamp) || 0,
        customer: !p.isFromViewer,
        staff: !!p.isFromViewer && !!m.creatorInfo,
        pageReacted: reacted(m.reactions) || reacted(m.reactions_v2),
        sending: !!p.isFromViewer && !!state && !/^(SENT|DELIVERED|READ|SEEN)$/i.test(state),
      });
    }
    out.sort((a, b) => a.ts - b.ts);
    return { messages: out, viewerID, otherChat };
  }

  // waiting | answered | handled | none (no customer message on screen)
  function decide(messages) {
    let lastCustomer = null, lastStaff = null;
    for (const m of messages) {
      if (m.customer) lastCustomer = m;
      else if (m.staff) lastStaff = m;
    }
    if (!lastCustomer) return 'none';
    if (lastStaff && lastStaff.ts > lastCustomer.ts) return 'answered';
    if (lastCustomer.pageReacted) return 'handled';
    return 'waiting';
  }

  // The open chat's entry in Meta's conversation list (isRead), if loaded.
  function readThread(uid) {
    const list = document.querySelector('[data-pagelet="GenericThreadListView"]');
    if (!list) return null;
    const rows = list.querySelectorAll('[role="presentation"]');
    for (let i = 0; i < rows.length && i < 12; i++) {
      const p = propsUp(rows[i], (x) => Array.isArray(x.threadList), 30);
      if (!p) continue;
      const t = p.threadList.find((x) => x && String(x.threadFBID) === uid);
      return t ? { isRead: t.isRead !== false } : null;
    }
    return null;
  }

  // ── Meta's "Mark as unread" / "Mark as read" ──
  const clean = (s) => String(s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.textContent);
  function header() {
    return document.querySelector('[data-pagelet="BizInboxDetailViewHeaderSectionWrapper"]');
  }
  function findIn(root, re, sel) {
    if (!root) return null;
    for (const el of root.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && re.test(labelOf(el))) return el;
    }
    return null;
  }
  function press(el) {
    const o = { bubbles: true, cancelable: true, view: window, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.dispatchEvent(new MouseEvent('click', o));
    } catch (e) { el.click(); }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="button"]';
  async function waitMenuItem(re, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const menu of document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')) {
        const hit = findIn(menu, re, MENU_ITEMS);
        if (hit) return hit;
      }
      await sleep(100);
    }
    return null;
  }
  const escape = () => {
    const o = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', o)); // bubbles to document
  };

  // want 'unread' | 'read'. Clicks only the action that matches what we want,
  // so an already-unread chat is never toggled back to read (and vice versa).
  async function applyRead(want) {
    const re = want === 'unread' ? MARK_UNREAD : MARK_READ;
    const other = want === 'unread' ? MARK_READ : MARK_UNREAD;
    const h = header();
    if (!h) return 'no-header';
    const direct = findIn(h, re, '[role="button"], button');
    if (direct) { press(direct); dbg.clicks++; return 'clicked'; }
    if (findIn(h, other, '[role="button"], button')) return 'already';
    const more = findIn(h, MENU_BTN, '[role="button"], button');
    if (!more) return 'no-button';
    press(more);
    const item = await waitMenuItem(re, cfg.menuWaitMs);
    if (item) { press(item); dbg.clicks++; return 'clicked-menu'; }
    const already = !!(await waitMenuItem(other, 200));
    escape();
    return already ? 'already' : 'no-menu-item';
  }

  // ── the composer: never act while staff is typing or just sent ──
  // Focus alone is not "busy": Meta focuses the reply box when a chat opens.
  let lastSendAt = 0, lastTypeAt = 0;
  document.addEventListener('keydown', (e) => {
    if (!e.target || !e.target.isContentEditable) return;
    lastTypeAt = Date.now();
    if (e.key === 'Enter' && !e.shiftKey) lastSendAt = Date.now();
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('[role="button"], button');
    if (b && /^(send|press enter to send|发送|傳送|hantar)$/i.test(labelOf(b))) lastSendAt = Date.now();
  }, true);
  function composerBusy() {
    for (const el of document.querySelectorAll('[contenteditable="true"]')) {
      const ph = (el.getAttribute('aria-placeholder') || '').toLowerCase();
      if ((ph.includes('reply') || ph.includes('messenger')) && clean(el.textContent)) return true; // a draft
    }
    return Date.now() - lastSendAt < cfg.sendQuietMs || Date.now() - lastTypeAt < cfg.typeQuietMs;
  }

  // ── loop ──
  let visit = null;      // { uid, sig, sigSince, tries, lastTry, marked, busy }
  let timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; tick(); }, cfg.tickMs);
  }

  async function tick() {
    if (document.documentElement.getAttribute('data-cim-keep-unread') === '0') return;
    const uid = uidNow();
    if (!uid) return;
    if (!visit || visit.uid !== uid) visit = { uid, sig: '', sigSince: Date.now(), tries: 0, lastTry: {}, marked: false, busy: false, done: '' };
    if (visit.busy) return;
    let read;
    try { read = readMessages(uid); } catch (e) { return; }
    if (read.otherChat) return; // DOM still shows the previous chat
    const sig = read.messages.map((m) => m.id + (m.pageReacted ? '♥' : '') + (m.staff ? 's' : '')).join(',');
    if (sig !== visit.sig) { visit.sig = sig; visit.sigSince = Date.now(); visit.done = ''; }
    if (Date.now() - visit.sigSince < cfg.settleMs) return schedule();
    if (read.messages.some((m) => m.sending)) return schedule();
    const state = decide(read.messages);
    let thread = null;
    try { thread = readThread(uid); } catch (e) { /* ignore */ }
    const prev = dbg.state && dbg.state.uid + dbg.state.state;
    dbg.state = { uid, state, isRead: thread ? thread.isRead : null, messages: read.messages.length };
    if (prev !== uid + state) scheduleRows();

    let want = null;
    if (state === 'waiting' && thread && thread.isRead) want = 'unread';
    else if (visit.marked && (state === 'answered' || state === 'handled') && thread && !thread.isRead) want = 'read';
    if (!want || visit.done === want + sig) return;
    if (composerBusy()) return schedule();
    if (visit.tries >= cfg.maxTries) return;
    // The pause is between repeats of the SAME action (Meta flipping it back);
    // undoing our own mark after a ❤️ is not held up by it.
    const since = Date.now() - (visit.lastTry[want] || 0);
    if (since < cfg.retryMs) { setTimeout(schedule, cfg.retryMs - since + 20); return; }

    visit.busy = true;
    visit.tries++;
    visit.lastTry[want] = Date.now();
    let result = 'error';
    try { result = await applyRead(want); } catch (e) { result = 'error:' + e.message; }
    visit.busy = false;
    if (result === 'clicked' || result === 'clicked-menu') visit.marked = want === 'unread';
    if (result !== 'no-header') visit.done = want + sig; // one attempt per message state, retried only if Meta flips it back
    if (result === 'already') visit.done = want + sig;
    note({ uid, state, want, result, tries: visit.tries });
    scheduleRows();
    // Meta may flip it back (a new message while open): look again after retryMs.
    setTimeout(() => { if (visit && visit.uid === uid) { visit.done = ''; schedule(); } }, cfg.retryMs + 50);
  }

  // ── PENDING rows tinted light red ──
  // PENDING = unread (the customer is waiting); for the open chat the decision
  // above wins (waiting → PENDING at once, before Meta's read state catches
  // up). Marked with an attribute on Meta's row element, styled by styles.css
  // with an overlay (Meta's inner boxes have their own white background).
  // An attribute React doesn't own survives its re-renders; rows are reused by
  // Meta's virtual list, so every pass re-reads each row's thread and only
  // writes when the value changes. Off → removed.
  const ROW_ATTR = 'data-cim-pending';
  function syncRows() {
    const list = document.querySelector('[data-pagelet="GenericThreadListView"]');
    if (!list) return;
    const off = document.documentElement.getAttribute('data-cim-keep-unread') === '0';
    const open = uidNow();
    for (const row of list.querySelectorAll('[role="presentation"]')) {
      const p = off ? null : propsUp(row, (x) => x.thread && x.thread.threadFBID, 2); // the row's own element only
      let pending = false;
      if (p) {
        pending = p.thread.isRead === false;
        if (String(p.thread.threadFBID) === open && dbg.state && dbg.state.uid === open && dbg.state.state === 'waiting') pending = true;
      }
      if (pending && row.getAttribute(ROW_ATTR) !== '1') row.setAttribute(ROW_ATTR, '1');
      else if (!pending && row.hasAttribute(ROW_ATTR)) row.removeAttribute(ROW_ATTR);
    }
  }
  let rowTimer = 0;
  function scheduleRows() {
    if (rowTimer) return;
    rowTimer = setTimeout(() => { rowTimer = 0; try { syncRows(); } catch (e) { /* never throw into Meta's page */ } }, 150);
  }

  dbg.decide = decide;
  dbg.readMessages = readMessages;
  // childList + characterData only: our own attribute writes never re-trigger it.
  new MutationObserver(() => { schedule(); scheduleRows(); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(() => { schedule(); scheduleRows(); }, Math.max(1000, cfg.tickMs * 2)); // URL-only and read-state changes may not touch the DOM
  schedule();
  scheduleRows();
})();
