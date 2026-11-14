// node tests/timed-fetch.test.js — timedFetch against a scripted fake fetch.
const assert = require('assert');
const { timedFetch, timedJson } = require('../timed-fetch.js');

// Each script step: 'hang' | 'neterr' | 'slowbody' | [status, body]
function fakeFetch(steps) {
  const calls = [];
  const impl = (url, opts) => {
    const step = steps[calls.length] ?? steps[steps.length - 1];
    calls.push({ url, method: opts.method || 'GET' });
    const abortable = () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (step === 'hang') return abortable();
    if (step === 'neterr') return Promise.reject(new TypeError('Failed to fetch'));
    if (step === 'slowbody') return Promise.resolve({ ok: true, status: 200, text: abortable });
    const [status, body] = step;
    return Promise.resolve({ ok: status < 400, status, text: async () => body });
  };
  return { impl, calls };
}

const tests = {
  async 'fast reply passes through'() {
    const f = fakeFetch([[200, '{"a":1}']]);
    const r = await timedFetch('u', {}, { label: 'X', ms: 50, retries: 1, fetchImpl: f.impl });
    assert.deepStrictEqual([r.ok, r.status, timedJson(r).a, f.calls.length], [true, 200, 1, 1]);
  },
  async 'stall then reply: retried once, succeeds'() {
    const f = fakeFetch(['hang', [200, '{}']]);
    const r = await timedFetch('u', {}, { label: 'X', ms: 50, retries: 1, fetchImpl: f.impl });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(f.calls.length, 2);
  },
  async 'stalls every time: error names the call, code timeout'() {
    const f = fakeFetch(['hang']);
    const t = Date.now();
    await assert.rejects(timedFetch('u', {}, { label: 'Baserow (customer record)', ms: 50, retries: 1, fetchImpl: f.impl }),
      (e) => e.message === "Baserow (customer record) didn't answer in 0s." && e.code === 'timeout');
    assert.strictEqual(f.calls.length, 2);
    assert.ok(Date.now() - t < 500);
  },
  async 'body that stalls is cut by the same limit'() {
    const f = fakeFetch(['slowbody']);
    await assert.rejects(timedFetch('u', {}, { label: 'X', ms: 50, fetchImpl: f.impl }), (e) => e.code === 'timeout');
  },
  async 'network error: retried, then "couldn\'t be reached"'() {
    const f = fakeFetch(['neterr']);
    await assert.rejects(timedFetch('u', {}, { label: 'EC2 order list', ms: 50, retries: 1, fetchImpl: f.impl }),
      (e) => e.message === "EC2 order list couldn't be reached." && e.code === 'network');
    assert.strictEqual(f.calls.length, 2);
  },
  async '5xx retried; last 5xx returned to the caller'() {
    const f = fakeFetch([[522, 'cf'], [200, '{}']]);
    assert.strictEqual((await timedFetch('u', {}, { ms: 50, retries: 1, fetchImpl: f.impl })).status, 200);
    const g = fakeFetch([[502, 'bad']]);
    const r = await timedFetch('u', {}, { ms: 50, retries: 1, fetchImpl: g.impl });
    assert.deepStrictEqual([r.ok, r.status, g.calls.length], [false, 502, 2]);
  },
  async '4xx is not retried'() {
    const f = fakeFetch([[404, '{}']]);
    const r = await timedFetch('u', {}, { ms: 50, retries: 1, fetchImpl: f.impl });
    assert.deepStrictEqual([r.status, f.calls.length], [404, 1]);
  },
  async 'retries 0 (a POST): one attempt only'() {
    const f = fakeFetch(['hang']);
    await assert.rejects(timedFetch('u', { method: 'POST' }, { ms: 50, fetchImpl: f.impl }));
    assert.strictEqual(f.calls.length, 1);
  },
  async 'non-JSON 200 → readable error'() {
    const r = { ok: true, status: 200, text: '<html>Cloudflare</html>', label: 'Baserow (customer record)' };
    assert.throws(() => timedJson(r), /Baserow \(customer record\) sent an unreadable reply\./);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
  }
  console.log(failed ? failed + ' FAILED' : 'ALL ' + Object.keys(tests).length + ' PASS');
  process.exit(failed ? 1 : 0);
})();
