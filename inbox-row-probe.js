// Structure-only probe: why the red pending tint + Slip tag stopped showing.
// Paste into the Business Suite inbox tab's DevTools console (top frame).
// Copies a small JSON to the clipboard. No names, no message text — only
// tags, roles, data-pagelet values, sizes, prop KEY names and booleans.
(() => {
  const fiberOf = (el) => {
    let fk = null, pk = null;
    for (const k of Object.keys(el)) { if (k.startsWith('__reactFiber$')) fk = k; else if (k.startsWith('__reactProps$')) pk = k; }
    let f = fk ? el[fk] : null;
    if (f && pk && f.memoizedProps !== el[pk] && f.alternate && f.alternate.memoizedProps === el[pk]) f = f.alternate;
    return f;
  };
  const nameOf = (f) => { const t = f && f.type; return !t ? null : typeof t === 'string' ? t : (t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || '?'); };
  const threadUp = (el, max) => {
    for (let f = fiberOf(el), i = 0; f && i < max; f = f.return, i++) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        for (const k of Object.keys(p)) {
          const v = p[k];
          if (v && typeof v === 'object' && ('threadFBID' in v || 'isRead' in v) && ('timestamp' in v || 'snippetText' in v)) return { depth: i, comp: nameOf(f), prop: k, keys: Object.keys(v).slice(0, 40), isReadType: typeof v.isRead, tsType: typeof v.timestamp };
        }
      }
    }
    return null;
  };
  const out = {
    at: new Date().toISOString(), path: location.pathname,
    ext: { unread: !!window.__cimUnread, unreadState: window.__cimUnread ? window.__cimUnread.state : null, slipDebug: typeof window.__cimSlipDebug === 'function' ? window.__cimSlipDebug().tagged : 'missing',
      keepUnreadAttr: document.documentElement.getAttribute('data-cim-keep-unread'), slipsLen: (document.documentElement.getAttribute('data-cim-slips') || '').length,
      pendingRows: document.querySelectorAll('[data-cim-pending]').length, slipRows: document.querySelectorAll('[data-cim-slip]').length },
    pagelets: [...new Set([...document.querySelectorAll('[data-pagelet]')].map((e) => e.getAttribute('data-pagelet')))].filter((p) => /thread|list|inbox/i.test(p)).slice(0, 40),
  };
  const list = document.querySelector('[data-pagelet="GenericThreadListView"]');
  out.listFound = !!list;
  out.presentationInList = list ? list.querySelectorAll('[role="presentation"]').length : null;
  if (list) {
    const pres = [...list.querySelectorAll('[role="presentation"]')].slice(0, 6);
    out.presentationSample = pres.map((el) => ({ tag: el.tagName, h: el.offsetHeight, w: el.offsetWidth, children: el.children.length, thread2: !!threadUp(el, 2), threadDeep: threadUp(el, 12) }));
  }
  // Find row-level elements anywhere: the outermost element whose own fiber chain (≤3) carries a thread.
  const scope = list || document.body;
  const hits = [];
  for (const el of scope.querySelectorAll('div, li, a, [role]')) {
    const t = threadUp(el, 3);
    if (!t) continue;
    if (el.parentElement && threadUp(el.parentElement, 3)) continue; // keep outermost only
    hits.push({ el, t });
    if (hits.length >= 6) break;
  }
  out.rowCandidates = hits.map(({ el, t }) => {
    const chain = [];
    for (let a = el, i = 0; a && i < 6; a = a.parentElement, i++) chain.push({ tag: a.tagName, role: a.getAttribute('role'), pagelet: a.getAttribute('data-pagelet'), h: a.offsetHeight, testid: a.getAttribute('data-testid') });
    return { tag: el.tagName, role: el.getAttribute('role'), attrs: [...el.attributes].map((a) => a.name).filter((n) => !/^class$|^style$/.test(n)), h: el.offsetHeight, w: el.offsetWidth, inList: !!(list && list.contains(el)), thread: t, ancestors: chain };
  });
  // Where is the threadList (all loaded conversations) now?
  out.threadListFound = false;
  for (const el of (list || document).querySelectorAll('[role="presentation"], [role="row"], [role="listitem"], div')) {
    for (let f = fiberOf(el), i = 0; f && i < 30; f = f.return, i++) {
      const p = f.memoizedProps;
      if (p && Array.isArray(p.threadList)) { out.threadListFound = { depth: i, comp: nameOf(f), n: p.threadList.length }; break; }
    }
    if (out.threadListFound) break;
  }
  const json = JSON.stringify(out, null, 1);
  try { copy(json); console.log('[cim probe] copied to clipboard'); } catch (e) { /* ignore */ }
  console.log(json);
  return out;
})();
