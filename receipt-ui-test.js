// Receipt bars — UI test, no network.
// Loads inbox-receipts-main.js + inbox-receipts.js + styles.css into
// receipt-ui-fixture.html (photo / PDF bubbles with fake __reactFiber$ chains
// shaped like the host's 2026-10-17 probe) with chrome.* stubbed: storage in
// memory, GET_RECEIPTS answered from window.__rc (synthetic rows shaped like
// the worker's /receipts). content.js isn't loaded — the test sets
// html[data-cim-psid] / [data-cim-psid-uid] and the URL itself.
// Proves logic and layout, not that Meta's real DOM matches — check a real tab.
// Run: node receipt-ui-test.js        Screenshots → $OUT_DIR (default <tmp>/receipt-ui-shots)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), 'receipt-ui-shots');
fs.mkdirSync(OUT, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const NOW = Date.now();
const DAY = 86400e3;
const K = (n) => `8491340${n}_16586393856399${n}_49550219865118833${n}_n.jpg`;
const KPDF = '851329996_2211231903142823_6051495966749823803_n.pdf';
const RECEIPT = { amount: 164.8, currency: 'MYR', paid_at: '2026-10-10 18:05', method: 'TNG eWallet DuitNow', payee_name: 'DD GROUP SDN. BHD.', reference: '20261010TNGDMYNB010ORM16308941', payment_note: 'P Tn Leong food n nuts', status_on_slip: 'successful', flags: [], duplicate: null };
const row = (key, ts, receipt, kind = 'receipt', i = 0) => ({ ts_ms: ts, att_index: i, kind, file_key: key, receipt: kind === 'receipt' ? receipt : null });

const stub = `
(() => {
  const store = Object.assign({}, window.__seed || {});
  const listeners = [];
  const local = {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
      const p = new Promise((r) => setTimeout(() => r(out), 0));
      if (cb) p.then(cb);
      return p;
    },
    set(obj, cb) {
      const changes = {};
      for (const k in obj) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
      setTimeout(() => { listeners.forEach((l) => l(changes, 'local')); cb && cb(); }, 0);
      return Promise.resolve();
    },
  };
  window.__rc = { items: {}, delay: 40, delayFor: {}, calls: [], fail: '', clip: [], warns: 0 };
  window.chrome = { storage: { local, onChanged: { addListener: (l) => listeners.push(l) } }, runtime: { lastError: undefined } };
  chrome.runtime.sendMessage = (msg, cb) => {
    const rc = window.__rc;
    if (msg.type !== 'GET_RECEIPTS') { cb && cb({ ok: false }); return; }
    rc.calls.push({ psid: msg.psid, at: Date.now() });
    const d = rc.delayFor[msg.psid] ?? rc.delay;
    setTimeout(() => cb && cb(rc.fail ? { ok: false, error: rc.fail } : { ok: true, items: JSON.parse(JSON.stringify(rc.items[msg.psid] || [])) }), d);
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__rc.clip.push(t); return Promise.resolve(); } } });
  const warn = console.warn.bind(console);
  console.warn = (...a) => { if (String(a[0]).includes('[CIM receipts]')) window.__rc.warns++; warn(...a); };
})();
`;

const results = [];
function check(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function openPage(browser, { token = 'tok', items = {}, cfg = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await page.route(/fbcdn\.net|fbsbx\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.addInitScript((s) => { window.__seed = s.seed; window.__cimRcptCfg = s.cfg; }, { seed: token ? { analysisApiToken: token } : {}, cfg: Object.assign({ recheckMs: 300, cacheMs: 2000 }, cfg) });
  await page.addInitScript(stub);
  await page.goto('file://' + path.join(EXT, 'receipt-ui-fixture.html') + '?selected_item_id=uidA');
  await page.evaluate((it) => { window.__rc.items = it; }, items);
  await page.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await page.addScriptTag({ path: path.join(EXT, 'inbox-receipts-main.js') });
  await page.addScriptTag({ path: path.join(EXT, 'inbox-receipts.js') });
  return page;
}
const settle = (page, ms = 250) => page.waitForTimeout(ms);
const bars = (page) => page.evaluate(() => [...document.querySelectorAll('.cim-rcpt-group')].map((g) => ({
  for: g.dataset.for, psid: g.dataset.psid,
  bars: [...g.querySelectorAll('.cim-rcpt')].map((b) => ({ warn: b.classList.contains('cim-rcpt--warn'), text: b.innerText.replace(/\s+/g, ' ').trim() })),
})));

// A conversation for customer A (psid 111…).
const PSID_A = '26997234649945307';
const PSID_B = '8534122233296254';
const T = (d) => NOW - d * DAY;
async function seedThread(page) {
  await page.evaluate(({ K1, K2, K3, K4, K5, K6, KPDF, t }) => {
    addText('hi, I paid');
    addPhoto({ mid: 'mid.$c1', ts: t.p1, keys: [K1] });                 // receipt (green)
    addPhoto({ mid: 'mid.$c2', ts: t.p2, keys: [K2], row: true });      // product photo, in a row wrapper
    addPhoto({ mid: 'mid.$c3', ts: t.p3, keys: [K3] });                 // not in D1 at all
    addFile({ mid: 'mid.$c4', ts: t.f1, key: KPDF });                   // PDF receipt
    addPhoto({ mid: 'mid.$c5', ts: t.p5, keys: [K4], row: true });      // flagged receipt, row wrapper
    addPhoto({ mid: 'mid.$c6', ts: t.p6, keys: [K5, K6] });             // two photos, 2nd a receipt
    addPhoto({ mid: 'mid.$c7', ts: t.p7, keys: [K1], mine: true });     // page's own (same file!) → never
  }, { K1: K(1), K2: K(2), K3: K(3), K4: K(4), K5: K(5), K6: K(6), KPDF, t: { p1: T(3), p2: T(2.9), p3: T(2.8), f1: T(2.7), p5: T(2.6), p6: T(2.5), p7: T(2.4) } });
}
const ITEMS_A = {
  [PSID_A]: [
    row(K(1), T(3), RECEIPT),
    row(K(2), T(2.9), null, 'product_photo'),
    row(KPDF, T(2.7), { ...RECEIPT, amount: 3105.05, method: 'RHB Fund Transfer', paid_at: '2026-09-03 10:59', reference: '17884042646390348' }),
    row(K(4), T(2.6), { ...RECEIPT, amount: 63, payee_name: 'VIVIEN MOK', reference: null, payment_note: null, status_on_slip: 'pending', flags: ['duplicate_of:m_x#0', 'wrong_payee', 'not_successful'], duplicate: { ts_ms: Date.UTC(2026, 9, 16, 13, 14), same_customer: false } }),
    row(K(5), T(2.5), null, 'screenshot', 0),
    row(K(6), T(2.5), { ...RECEIPT, amount: 37, currency: 'SGD', method: 'POSB PayNow', payee_name: 'DD GROUP GLOBAL PTE. LTD.' }, 'receipt', 1),
  ],
  [PSID_B]: [row(K(9), T(1), { ...RECEIPT, amount: 999 })],
};

(async () => {
  const browser = await chromium.launch();

  // ── A. Tagging (inbox-receipts-main.js) ──
  {
    const page = await openPage(browser, { token: '' });
    await seedThread(page);
    await page.evaluate(({ k }) => addFile({ mid: 'mid.$c8', ts: 1792219006792, key: k, noMsgTs: true }), { k: '111_222_333_n.pdf' });
    await settle(page);
    const tags = await page.evaluate(() => [...document.querySelectorAll('[data-cim-rcpt-keys]')].map((r) => ({ mid: r.__fixture.mid, keys: JSON.parse(r.dataset.cimRcptKeys), ts: Number(r.dataset.cimRcptTs), exp: r.__fixture.ts })));
    check('A1 every customer photo / PDF bubble tagged, the page\'s own photo not', tags.length === 7 && !tags.some((t) => t.mid === 'mid.$c7'), tags.map((t) => t.mid).join(','));
    check('A2 keys are the stored file names, in attachment order', JSON.stringify(tags.find((t) => t.mid === 'mid.$c6').keys) === JSON.stringify([K(5), K(6)]) && tags.find((t) => t.mid === 'mid.$c4').keys[0] === KPDF);
    check('A3 message time copied exactly', tags.filter((t) => t.mid !== 'mid.$c8').every((t) => t.ts === t.exp));
    check('A4 PDF without message.timestamp → attachment timestampMs [hi, lo] decoded', tags.find((t) => t.mid === 'mid.$c8').ts === 1792219006792);
    await page.evaluate(({ k }) => reusePhoto('mid.$c3', { mid: 'mid.$c9', ts: 1700000000000, keys: [k] }), { k: K(7) });
    await settle(page);
    const re = await page.evaluate(() => { const r = rootOf('mid.$c9'); return { keys: r.dataset.cimRcptKeys, ts: r.dataset.cimRcptTs }; });
    check('A5 a node React reuses for another photo is re-tagged', re.keys === JSON.stringify([K(7)]) && re.ts === '1700000000000', JSON.stringify(re));
    await page.evaluate(() => { const img = rootOf('mid.$c9').querySelector('img'); delete img['__reactFiber$test']; img.src = img.src + '&x=1'; });
    await settle(page);
    check('A6 a node that no longer reads as a photo loses its tag', await page.evaluate(() => !rootOf('mid.$c9').hasAttribute('data-cim-rcpt-keys')));
    check('A7 token empty → no request, no bar', (await page.evaluate(() => window.__rc.calls.length)) === 0 && (await bars(page)).length === 0);
    await page.close();
  }

  // ── B. Bars ──
  {
    const page = await openPage(browser, { items: ITEMS_A });
    await seedThread(page);
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 400);
    const g = await bars(page);
    const byKey = (k) => g.find((x) => JSON.parse(x.for).includes(k));
    check('B1 bars only under the 4 receipt bubbles (photo, PDF, flagged photo, 2-photo message)', g.length === 4, g.map((x) => x.for.slice(2, 12)).join(' | '));
    const b1 = byKey(K(1))?.bars[0];
    check('B2 green bar: amount, method · time, payee, the payer\'s note (not the bank reference), status', !!b1 && !b1.warn && /RM 164\.80/.test(b1.text) && /TNG eWallet DuitNow · 10 Oct, 18:05/.test(b1.text) && /To DD GROUP SDN\. BHD\./.test(b1.text) && /Note P Tn Leong food n nuts/i.test(b1.text) && !/20261010TNGDMYNB010ORM16308941|Ref /.test(b1.text) && /Slip: Successful/.test(b1.text) && !/✓/.test(b1.text), b1 && b1.text);
    check('B3 product photo, unknown photo and the page\'s own copy of a receipt file get no bar', !byKey(K(2)) && !byKey(K(3)) && (await page.evaluate(() => !rootOf('mid.$c7').parentElement.querySelector('.cim-rcpt-group'))));
    const bp = byKey(KPDF)?.bars[0];
    check('B4 PDF bar', !!bp && /RM 3,105\.05/.test(bp.text) && /RHB Fund Transfer · 3 Sep, 10:59/.test(bp.text), bp && bp.text);
    const bw = byKey(K(4))?.bars[0];
    check('B5 flagged slip: red, all three warnings in plain words, status chip, missing note said', !!bw && bw.warn && /another customer sent the same slip on 16 Oct, 21:14/.test(bw.text) && /Not paid to a DD account/.test(bw.text) && /does not show "successful"/.test(bw.text) && /⚠ Slip: Pending/.test(bw.text) && /No note on slip/.test(bw.text), bw && bw.text);
    const b6 = byKey(K(6))?.bars;
    check('B6 two-photo message: one bar for the receipt, labelled 2 of 2, S$', b6 && b6.length === 1 && /Receipt · 2 of 2/i.test(b6[0].text) && /S\$ 37\.00/.test(b6[0].text), b6 && b6[0].text);
    // One card: flush under the bubble (also when it sits in a padded row wrapper), same left edge and width,
    // the bubble's bottom corners flattened and taken over by the bar.
    const place = await page.evaluate(() => ['mid.$c1', 'mid.$c5', 'mid.$c6', 'mid.$c4'].map((m) => {
      const root = rootOf(m);
      const r = root.getBoundingClientRect();
      const g = root.closest('.msg').querySelector('.cim-rcpt-group');
      const gr = g.getBoundingClientRect();
      const last = g.querySelector('.cim-rcpt:last-child');
      return { m, gap: Math.round((gr.top - r.bottom) * 10) / 10, dl: Math.round(gr.left - r.left), dw: Math.round(gr.width - Math.max(r.width, 240)),
        bubbleR: getComputedStyle(root).borderBottomLeftRadius, barR: getComputedStyle(last).borderBottomLeftRadius };
    }));
    check('B7 bar is flush under its bubble, same left edge and width (plain, row-wrapped, 2-photo, PDF)', place.every((p) => Math.abs(p.gap) <= 0.5 && Math.abs(p.dl) <= 1 && Math.abs(p.dw) <= 1), JSON.stringify(place));
    check('B7c bubble\'s bottom corners squared, bar carries the bubble\'s 18px', place.every((p) => p.bubbleR === '0px' && p.barR === '18px'), JSON.stringify(place.map((p) => [p.bubbleR, p.barR])));
    const untouched = await page.evaluate(() => ['mid.$c2', 'mid.$c3'].map((m) => getComputedStyle(rootOf(m)).borderBottomLeftRadius));
    check('B7d bubbles without a bar keep their corners', untouched.every((r) => r === '18px'), untouched.join(','));
    await page.screenshot({ path: path.join(OUT, 'bars.png') });
    await page.evaluate(() => rootOf('mid.$c5').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(OUT, 'bars-warn.png') });
    const big = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('button.cim-rcpt-amount')).fontSize));
    check('B7b amount is the big figure (22px)', big === 22, String(big));
    // Copy
    const before = await page.evaluate(() => window.__msgClicks);
    await page.click('.cim-rcpt-amount');
    await settle(page, 100);
    const amountText = await page.evaluate(() => document.querySelector('.cim-rcpt-amount').textContent);
    await page.click('.cim-rcpt-note');
    await settle(page, 100);
    const clip = await page.evaluate(() => window.__rc.clip);
    check('B8 click amount → copies 164.80 and says Copied; click note → copies it', clip[0] === '164.80' && amountText === 'Copied' && clip[1] === 'P Tn Leong food n nuts', JSON.stringify(clip) + ' ' + amountText);
    check('B9 clicks on the bar never reach Meta\'s message handlers', (await page.evaluate(() => window.__msgClicks)) === before);
    await settle(page, 1300);
    check('B10 Copied reverts to the amount', (await page.evaluate(() => document.querySelector('.cim-rcpt-amount').textContent)) === 'RM 164.80');
    const n = await page.evaluate(() => window.__rc.calls.length);
    await page.evaluate(() => { for (let i = 0; i < 5; i++) addText('more ' + i); });
    await settle(page, 400);
    check('B11 one request per customer; later chat updates ask nothing', n === 1 && (await page.evaluate(() => window.__rc.calls.length)) === 1, String(n));
    // React drops our node → put back, once.
    await page.evaluate(() => document.querySelector('.cim-rcpt-group').remove());
    await settle(page);
    check('B12 a bar React removed comes back, no duplicates, still 18px corners', (await page.evaluate(() => document.querySelectorAll('.cim-rcpt-group').length)) === 4 &&
      (await page.evaluate(() => [...document.querySelectorAll('.cim-rcpt-group')].every((g) => getComputedStyle(g.querySelector('.cim-rcpt:last-child')).borderBottomLeftRadius === '18px'))));
    await page.close();
  }

  // ── C. Customer safety ──
  {
    const page = await openPage(browser, { items: ITEMS_A, cfg: { cacheMs: 10000 } });
    await seedThread(page);
    await settle(page, 300);
    check('C1 no linked PSID → no request, no bar', (await page.evaluate(() => window.__rc.calls.length)) === 0 && (await bars(page)).length === 0);
    await page.evaluate((p) => { history.replaceState(null, '', location.pathname + '?selected_item_id=uidOther'); document.documentElement.setAttribute('data-cim-psid-uid', 'uidA'); document.documentElement.setAttribute('data-cim-psid', p); }, PSID_A);
    await settle(page, 300);
    check('C2 PSID that belongs to another uid than the URL → nothing', (await page.evaluate(() => window.__rc.calls.length)) === 0 && (await bars(page)).length === 0);
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 300);
    const had = (await bars(page)).length;
    // URL-only switch (content.js hasn't caught up yet): bars must go at once.
    await page.evaluate(() => history.replaceState(null, '', location.pathname + '?selected_item_id=uidB'));
    await settle(page, 650);
    check('C3 URL switches → every bar gone within one tick, before the PSID changes', had === 4 && (await bars(page)).length === 0, `had ${had}`);
    // Stale reply: B's answer is slow, switch back to A before it lands.
    await page.evaluate((p) => { window.__rc.delayFor[p] = 600; setCustomer('uidB', p); }, PSID_B);
    await settle(page, 100);
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 900);
    const g = await bars(page);
    const dropped = await page.evaluate(() => window.__cimRcptStats.dropped);
    check('C4 a reply for a customer no longer open is dropped; only A\'s bars, each tagged with A', dropped >= 1 && g.length === 4 && g.every((x) => x.psid === PSID_A) && !JSON.stringify(g).includes('RM 999.00'), `dropped ${dropped} bars ${g.length} psids ${g.map((x) => x.psid).join(",")} calls ${JSON.stringify(await page.evaluate(() => window.__rc.calls.map((c) => c.psid.slice(-4))))}`);
    const calls = await page.evaluate(() => window.__rc.calls.length);
    await page.evaluate((p) => setCustomer('uidB', p), PSID_B);
    await settle(page, 200);
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 300);
    check('C5 back to a customer within the cache time → no new request for them', (await page.evaluate(() => window.__rc.calls.filter((c) => c.psid === '26997234649945307').length)) === 1, `calls ${calls}`);
    // Token removed → off; added → back.
    await page.evaluate(() => chrome.storage.local.set({ analysisApiToken: '' }));
    await settle(page, 300);
    const off = (await bars(page)).length;
    const offFlat = await page.evaluate(() => document.querySelectorAll('[style*="--cim-rcpt-join"]').length);
    await page.evaluate(() => chrome.storage.local.set({ analysisApiToken: 'tok' }));
    await settle(page, 400);
    check('C6 token cleared → bars gone and every bubble\'s corners back; set again → bars back', off === 0 && offFlat === 0 && (await bars(page)).length === 4, `off ${off} flat ${offFlat}`);
    await page.close();
  }
  {
    const page = await openPage(browser, { items: ITEMS_A });
    await page.evaluate(() => { window.__rc.fail = 'network'; });
    await seedThread(page);
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 400);
    check('C7 worker unreachable → no bars, one console warning, no page error', (await bars(page)).length === 0 && (await page.evaluate(() => window.__rc.warns)) === 1 && !results.some((r) => r.startsWith('PAGEERROR')));
    await page.close();
  }

  // ── D. A slip that arrives while the chat is open ──
  {
    const page = await openPage(browser, { items: { [PSID_A]: [] }, cfg: { recheckMs: 300, freshMs: 1500 } });
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 200);
    const ts = Date.now();
    await page.evaluate(({ k, ts }) => addPhoto({ mid: 'mid.$new', ts, keys: [k] }), { k: K(8), ts });
    await settle(page, 700);
    const asked = await page.evaluate(() => window.__rc.calls.length);
    // The worker finishes reading it.
    await page.evaluate(({ p, row }) => { window.__rc.items[p] = [row]; }, { p: PSID_A, row: row(K(8), ts, { ...RECEIPT, amount: 128 }) });
    await settle(page, 700);
    const g = await bars(page);
    check('D1 a new photo with no result yet is asked for again, and its bar appears once read', asked >= 2 && g.length === 1 && /RM 128\.00/.test(g[0].bars[0].text), `asked ${asked}`);
    // A new photo that never becomes a receipt: re-asking stops after freshMs.
    await page.evaluate(({ k }) => addPhoto({ mid: 'mid.$prod', ts: Date.now(), keys: [k] }), { k: K(0) });
    await settle(page, 2500);
    const n1 = await page.evaluate(() => window.__rc.calls.length);
    await settle(page, 1200);
    const n2 = await page.evaluate(() => window.__rc.calls.length);
    check('D2 re-asking stops once the attachment is older than the wait window', n2 === n1, `${n1} → ${n2}`);
    await page.close();
  }

  // ── E. Meta's real photo shape: rounded inner frame (outline on ::after), space under it ──
  {
    const page = await openPage(browser, { items: { [PSID_A]: [row(K(1), T(3), RECEIPT), row(K(5), T(2), null, 'screenshot'), row(K(6), T(2), RECEIPT, 'receipt', 1)] } });
    await page.evaluate(({ k1, k5, k6, t1, t2 }) => { addPhoto({ mid: 'mid.$f1', ts: t1, keys: [k1], framed: true }); addPhoto({ mid: 'mid.$f2', ts: t2, keys: [k5, k6], framed: true, row: true }); }, { k1: K(1), k5: K(5), k6: K(6), t1: T(3), t2: T(2) });
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 400);
    const m = await page.evaluate(() => ['mid.$f1', 'mid.$f2'].map((mid) => {
      const frame = rootOf(mid).querySelector('.frame');
      const f = frame.getBoundingClientRect();
      const g = rootOf(mid).closest('.msg').querySelector('.cim-rcpt-group');
      const gr = g.getBoundingClientRect();
      return { gap: Math.round(gr.top - f.bottom), dl: Math.round(gr.left - f.left), dw: Math.round(gr.width - Math.max(f.width, 240)),
        frameR: getComputedStyle(frame).borderBottomLeftRadius, outlineR: getComputedStyle(frame, '::after').borderBottomLeftRadius,
        barR: getComputedStyle(g.querySelector('.cim-rcpt:last-child')).borderBottomLeftRadius };
    }));
    check('E1 framed photo (space under it): bar flush under the visible frame, same left edge and width', m.every((x) => x.gap === 0 && Math.abs(x.dl) <= 1 && Math.abs(x.dw) <= 1), JSON.stringify(m));
    check('E2 frame and its ::after outline squared at the bottom, bar takes the 18px', m.every((x) => x.frameR === '0px' && x.outlineR === '0px' && x.barR === '18px'), JSON.stringify(m.map((x) => [x.frameR, x.outlineR, x.barR])));
    await page.screenshot({ path: path.join(OUT, 'bars-framed.png') });
    // Real bubble (probe 2026-10-17): block div > inline <a> > inline-block rounded <img> on the
    // text baseline → ~5px under the photo. Meta reserves the bubble's size first and swaps the
    // photo in later, so the bubble never resizes — only the photo moves.
    await page.evaluate(({ k, t }) => {
      addPhoto({ mid: 'mid.$i1', ts: t, keys: [k], inline: true });
      const root = rootOf('mid.$i1'); const img = root.querySelector('img');
      root.style.height = '485px';
      img.style.height = '485px';   // placeholder fills the reserved box: no gap yet
    }, { k: K(4), t: T(1) });
    await page.evaluate(({ p, r }) => { window.__rc.items[p].push(r); }, { p: PSID_A, r: row(K(4), T(1), RECEIPT) });
    await page.evaluate(() => setCustomer('uidB', '8534122233296254'));
    await settle(page, 2200);   // past this test page's 2 s cache → A's rows are fetched again
    await page.evaluate((p) => setCustomer('uidA', p), PSID_A);
    await settle(page, 400);
    check('E4a bar drawn while the placeholder fills the bubble', await page.evaluate(() => !!rootOf('mid.$i1').closest('.msg').querySelector('.cim-rcpt-group')));
    await page.evaluate(() => { rootOf('mid.$i1').querySelector('img').style.height = '480px'; });   // the real photo lands
    await settle(page, 400);
    const inl = await page.evaluate(() => {
      const img = rootOf('mid.$i1').querySelector('img');
      const g = rootOf('mid.$i1').closest('.msg').querySelector('.cim-rcpt-group');
      return { group: !!g, gap: g ? Math.round(g.getBoundingClientRect().top - img.getBoundingClientRect().bottom) : null, imgR: getComputedStyle(img).borderBottomLeftRadius };
    });
    check('E4 photo swapped in after the bar was drawn (bubble size unchanged): bar re-joins, no gap', inl.group && inl.gap === 0 && inl.imgR === '0px', JSON.stringify(inl));
    await page.evaluate(() => chrome.storage.local.set({ analysisApiToken: '' }));
    await settle(page, 300);
    const back = await page.evaluate(() => ['mid.$f1', 'mid.$f2'].map((mid) => { const fr = rootOf(mid).querySelector('.frame'); return [getComputedStyle(fr).borderBottomLeftRadius, getComputedStyle(fr, '::after').borderBottomLeftRadius]; }));
    check('E3 bars gone → frame and outline corners back', back.every((x) => x[0] === '18px' && x[1] === '18px'), JSON.stringify(back));
    await page.close();
  }

  await browser.close();
  const fails = results.filter((r) => !r.startsWith('PASS'));
  console.log(results.join('\n'));
  console.log(`\n${results.length - fails.length}/${results.length} passed · screenshots in ${OUT}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
