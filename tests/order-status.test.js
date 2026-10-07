// ERP status per order (order-status.js) against a fake qianyi-api-query
// /api/track/order/:id. Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderStatusFetcher, aggregateStatus } = require('../order-status.js');

const BASE = 'https://qianyi.test';

// rowsBySn: { 'F…': [{status}, …] }; missing = the ERP has no such order.
function fakeApi(rowsBySn, opts = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url) => {
    const sn = decodeURIComponent(url.split('/api/track/order/')[1] || '');
    calls.push({ url, sn });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs || 5));
      const hook = opts.respond && opts.respond(sn, calls.filter((c) => c.sn === sn).length);
      if (hook) return { ok: hook.status < 300, status: hook.status, json: async () => hook.body };
      const rows = rowsBySn[sn] || [];
      return { ok: true, status: 200, json: async () => ({ ok: true, total: rows.length, result: rows, source: 'openapi' }) };
    } finally {
      inFlight--;
    }
  };
  return { fetch, calls, max: () => maxInFlight };
}

function fetcher(api, extra = {}) {
  return createOrderStatusFetcher({ fetch: api.fetch, baseUrl: BASE, retryDelayMs: 5, ...extra });
}

test('asks the signed track route, one order per request', async () => {
  const api = fakeApi({ F955820260919005464: [{ status: 'SHIPPED' }] });
  const res = await fetcher(api)(['F955820260919005464']);
  assert.deepEqual(res, { ok: true, statuses: { F955820260919005464: 'SHIPPED' } });
  assert.equal(api.calls[0].url, `${BASE}/api/track/order/F955820260919005464`);
});

test('an order the ERP does not have is left out (shown as NO DATA)', async () => {
  const api = fakeApi({ F955820260919005464: [{ status: 'SHIPPED' }] });
  const res = await fetcher(api)(['F955820260919005464', 'F955820261007008577']);
  assert.deepEqual(res.statuses, { F955820260919005464: 'SHIPPED' });
});

test('split orders: all waiting → WAIT_AUDIT, some sent → PARTIAL_AUDIT, all sent → that status', () => {
  assert.equal(aggregateStatus([{ status: 'WAIT_AUDIT' }, { status: 'WAIT_AUDIT' }]), 'WAIT_AUDIT');
  assert.equal(aggregateStatus([{ status: 'SHIPPED' }, { status: 'WAIT_AUDIT' }]), 'PARTIAL_AUDIT');
  assert.equal(aggregateStatus([{ status: 'SHIPPED' }, { status: 'SHIPPED' }]), 'SHIPPED');
  assert.equal(aggregateStatus([]), '');
});

test('at most 3 orders are asked at once', async () => {
  const sns = Array.from({ length: 10 }, (_, i) => 'F9558202609190054' + String(i).padStart(2, '0'));
  const api = fakeApi(Object.fromEntries(sns.map((s) => [s, [{ status: 'SHIPPED' }]])), { delayMs: 15 });
  const res = await fetcher(api)(sns);
  assert.equal(Object.keys(res.statuses).length, 10);
  assert.ok(api.max() <= 3, `max in flight ${api.max()}`);
});

test('a busy ERP (503) is retried once', async () => {
  const api = fakeApi({ F955820260919005464: [{ status: 'SHIPPED' }] }, {
    respond: (sn, nth) => (nth === 1 ? { status: 503, body: { ok: false, error: 'erp_throttled' } } : null),
  });
  const res = await fetcher(api)(['F955820260919005464']);
  assert.equal(res.statuses.F955820260919005464, 'SHIPPED');
  assert.equal(api.calls.length, 2);
});

test('when every lookup fails the answer is a failure, not "all NO DATA"', async () => {
  const api = fakeApi({}, { respond: () => ({ status: 502, body: { ok: false, error: 'erp_unavailable' } }) });
  const res = await fetcher(api)(['F955820260919005464', 'F955820261007008577']);
  assert.equal(res.ok, false);
});

test('a network error on one order does not lose the others', async () => {
  const api = fakeApi({ F955820260919005464: [{ status: 'SHIPPED' }] });
  const base = api.fetch;
  const res = await createOrderStatusFetcher({
    baseUrl: BASE, retryDelayMs: 5,
    fetch: (url) => (url.includes('F955820261007008577') ? Promise.reject(new TypeError('Failed to fetch')) : base(url)),
  })(['F955820260919005464', 'F955820261007008577']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.statuses, { F955820260919005464: 'SHIPPED' });
});

test('numbers the route cannot take are skipped without a request', async () => {
  const api = fakeApi({});
  const res = await fetcher(api)(['', 'not-an-order', 'F12']);
  assert.deepEqual(res, { ok: true, statuses: {} });
  assert.equal(api.calls.length, 0);
});

test('a shipped answer is reused for 10 minutes; a waiting one is asked again', async () => {
  let now = 0;
  const api = fakeApi({ F955820260919005464: [{ status: 'SHIPPED' }], F955820261007008577: [{ status: 'WAIT_AUDIT' }] });
  const get = fetcher(api, { now: () => now });
  await get(['F955820260919005464', 'F955820261007008577']);
  now += 60 * 1000;
  const res = await get(['F955820260919005464', 'F955820261007008577']);
  assert.deepEqual(res.statuses, { F955820260919005464: 'SHIPPED', F955820261007008577: 'WAIT_AUDIT' });
  assert.deepEqual(api.calls.map((c) => c.sn), ['F955820260919005464', 'F955820261007008577', 'F955820261007008577']);
  now += 10 * 60 * 1000;
  await get(['F955820260919005464']);
  assert.equal(api.calls.length, 4);
});
