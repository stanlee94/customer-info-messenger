// ERP status per order for the status tags (PENDING / PARTIAL / SHIPPED /
// NO DATA) — loaded by background.js (importScripts) and by
// tests/order-status.test.js (require). Pure: fetch, base URL and clock come in.
//
// Source: qianyi-api-query's public GET /api/track/order/:onlineOrderNumber.
// Its old batch route /orders/:ids still sends the ERP's retired static
// signature, so since ~2026-10-01 it answers 404 "Order not found" for every
// order (every tag read NO DATA). That route is left alone on purpose in
// qianyi-api-query (an external caller depends on its current answers); the
// track route signs each request and has no date window, so any order the ERP
// has ever had resolves. It takes ONE order per request, so lookups run at most
// CONCURRENCY at a time, a busy ERP (503) is retried once, and settled
// statuses are reused for CACHE_MS.
(function (root) {
  const ORDER_SN_RE = /^F\d{18}$/;          // the route rejects anything else (400)
  const CONCURRENCY = 3;
  const CACHE_MS = 10 * 60 * 1000;
  const OPEN = new Set(['WAIT_AUDIT', 'PARTIAL_AUDIT']); // can change any minute: never cached

  // One status for a split family — the same rule qianyi-api-query used on
  // /orders/:id: unanimous → that status; a mix still holding WAIT_AUDIT →
  // PARTIAL_AUDIT (some parts sent, some not); any other mix → the first row's.
  function aggregateStatus(rows) {
    if (!rows || !rows.length) return '';
    const statuses = new Set(rows.map((r) => r.status));
    if (statuses.size === 1) return rows[0].status || '';
    return statuses.has('WAIT_AUDIT') ? 'PARTIAL_AUDIT' : rows[0].status || '';
  }

  function createOrderStatusFetcher({ fetch, baseUrl, now = () => Date.now(), retryDelayMs = 1500 }) {
    const cache = new Map(); // sn → { status, at }

    // → { status } (status '' = the ERP has no such order) or null on failure.
    async function lookup(sn) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(`${baseUrl}/api/track/order/${encodeURIComponent(sn)}`);
          if (res.status === 503 && attempt === 1) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          if (!res.ok) return null;
          const json = await res.json();
          if (!json || json.ok !== true) return null;
          return { status: aggregateStatus(json.result) };
        } catch (err) {
          if (attempt === 2) return null;
        }
      }
      return null;
    }

    return async function fetchStatuses(orderIds) {
      const wanted = [...new Set((orderIds || []).map((x) => String(x || '').trim()))].filter((sn) => ORDER_SN_RE.test(sn));
      const statuses = {};
      const todo = [];
      for (const sn of wanted) {
        const hit = cache.get(sn);
        if (hit && now() - hit.at < CACHE_MS) statuses[sn] = hit.status;
        else todo.push(sn);
      }
      let failed = 0;
      let next = 0;
      async function worker() {
        while (next < todo.length) {
          const sn = todo[next++];
          const got = await lookup(sn);
          if (!got) { failed++; continue; }
          if (!got.status) continue; // not in the ERP → NO DATA
          statuses[sn] = got.status;
          if (!OPEN.has(got.status)) cache.set(sn, { status: got.status, at: now() });
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
      if (todo.length && failed === todo.length && !Object.keys(statuses).length) {
        return { ok: false, error: 'Order status service unavailable.' };
      }
      return { ok: true, statuses };
    };
  }

  const api = { createOrderStatusFetcher, aggregateStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OrderStatus = api;
})(typeof self !== 'undefined' ? self : this);
