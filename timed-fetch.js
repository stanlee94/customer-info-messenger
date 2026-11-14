// Time-limited fetch for the customer panel's lookups (background.js, via
// importScripts; also require()-able for tests/timed-fetch.test.js).
//
// Why: a Baserow / EC2 request that stalls instead of failing (a dead HTTP/2
// connection, a busy server) used to leave the panel on its grey loading bars
// forever — staff then couldn't reach the cart buttons for 人手结单. Measured
// 2026-11-14: these calls normally answer in 0.1–0.25 s, so the limit only
// ever cuts a stall short.
//
// - `ms` covers the headers AND the body: the body is read here, inside the
//   limit, and returned as text.
// - `retries`: extra attempts after a timeout, a network error or a 5xx
//   (Cloudflare 502/520-524 are transient). A second attempt opens on a fresh
//   connection and normally succeeds. Only for requests that are safe to send
//   twice (GET, PATCH) — never a POST that creates something.
// - Errors name the call (`label`) so the panel can say which part didn't
//   answer.
(function (root) {
  const DEFAULT_MS = 7000;

  async function timedFetch(url, opts = {}, { label = 'Request', ms = DEFAULT_MS, retries = 0, fetchImpl } = {}) {
    const doFetch = fetchImpl || root.fetch.bind(root);
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ms);
      try {
        const res = await doFetch(url, { ...opts, signal: ctl.signal });
        const text = await res.text();
        if (res.status >= 500 && !last) continue;
        return { ok: res.ok, status: res.status, text, label };
      } catch (err) {
        if (!last) continue;
        const timedOut = ctl.signal.aborted;
        const e = new Error(timedOut
          ? `${label} didn't answer in ${Math.round(ms / 1000)}s.`
          : `${label} couldn't be reached.`);
        e.code = timedOut ? 'timeout' : 'network';
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // JSON body of a timedFetch result; a non-JSON page (a Cloudflare error
  // page with status 200) becomes a readable error instead of a SyntaxError.
  function timedJson(r) {
    try {
      return JSON.parse(r.text);
    } catch (err) {
      throw new Error(`${r.label} sent an unreadable reply.`);
    }
  }

  const api = { timedFetch, timedJson, TIMED_FETCH_DEFAULT_MS: DEFAULT_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis);
