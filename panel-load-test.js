// Customer panel must never stay on its loading bars — UI regression test, no
// network. Staff reported the panel "keeps loading" (grey bars, PSID shown), so
// they couldn't reach the cart buttons for 人手结单. Each case below is a way
// the lookup used to get stuck for good:
//   A  the orders reply never comes        → error + Retry (watchdog)
//   B  the orders reply is an error        → error + Retry, Retry loads
//   C  Meta removes the panel as the reply lands → orders still shown
//   D  the URL blinks as the reply lands   → orders still shown
//   E  Baserow UID search fails (unlinked) → error + Retry, not a ManyChat
//      search that offers candidates to re-link
//   F  the cart probe fails                → "Cart didn't load · Retry" row,
//      Retry brings the 人手结单 buttons
// Loads content.js + styles.css into notebar-ui-fixture.html with chrome.*
// stubbed (same pattern as notebar-ui-test.js). Run: node panel-load-test.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(require('os').tmpdir(), 'panel-load-shots');
fs.mkdirSync(OUT, { recursive: true });
const notesSrc = fs.readFileSync(path.join(EXT, 'notes-baserow.js'), 'utf8');
const fakeSrc = fs.readFileSync(path.join(EXT, 'tests', 'fake-baserow.js'), 'utf8');

// window.__cfg (set per page before load) and later changes drive the stubs:
//   orders: 'ok' | 'fail' | 'hang' | 'manual' (reply when window.__release() is called)
//   uidSearch: 'notFound' | 'fail' | 'found'
//   cart: 'items' | 'fail'
const stub = `
(() => {
  const cfg = window.__cfg = Object.assign({ orders: 'ok', uidSearch: 'notFound', cart: 'items', session: false }, window.__seedCfg || {});
  const store = { uidPsidMap: { '111': '25881234561194' } };
  const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
  const local = {
    get(keys, cb) { const out = {}; (keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = clone(store[k]); }); setTimeout(() => cb(out), 0); },
    set(obj, cb) { Object.assign(store, clone(obj)); cb && setTimeout(cb, 0); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); cb && setTimeout(cb, 0); },
  };
  window.__store = store;
  window.chrome = { storage: { local, session: local, onChanged: { addListener() {} } }, runtime: {} };
  ${fakeSrc}
  ${notesSrc}
  const fake = createFakeBaserow();
  fake.addUser({ PSID: '25881234561194', Name: 'Tan Mei Ling' });
  const backend = NotesBaserow.createNotesBackend({
    fetch: (...a) => fake.fetch(...a),
    getConfig: async () => ({ baseUrl: 'https://baserow.test', token: 'tok', usersTableId: '749', logTableId: '794' }),
    timeoutMs: 1500,
  });
  const summary = { totalSpending: 1234.5, totalPurchase: 9, rawRecency: 12, lastOrderDate: '2026-09-20', yearsActive: 2, rank: 'Loyal', address: '12 Jalan Bukit', recentOrders: [], allOrders: [], baserowName: 'Tan Mei Ling' };
  window.__count = {};
  const handlers = {
    CHECK_SESSION: async () => ({ ok: true, valid: cfg.session }),
    GET_AI_HEALTH: async () => ({ ok: false }),
    SEARCH_BASEROW_BY_UID: async () => cfg.uidSearch === 'fail'
      ? { ok: false, error: "Baserow (customer record) didn't answer in 7s." }
      : cfg.uidSearch === 'found' ? { ok: true, psid: '25881234561194' } : { ok: true, notFound: true },
    SEARCH_MANYCHAT_BY_NAME: async () => ({ ok: true, candidates: [{ psid: '25880000000001', name: 'Tan Mei Ling', profilePic: '', lastMessage: '', lastInteraction: '' }] }),
    GET_ORDERS_BY_PSID: () => {
      if (cfg.orders === 'hang') return new Promise(() => {});
      if (cfg.orders === 'manual') return new Promise((r) => { window.__release = () => r({ ok: true, data: summary }); });
      if (cfg.orders === 'fail') return new Promise((r) => setTimeout(() => r({ ok: false, error: "Baserow (customer record) didn't answer in 7s." }), 100));
      return new Promise((r) => setTimeout(() => r({ ok: true, data: summary }), 100));
    },
    GET_MANYCHAT_INFO: async () => ({ ok: true, tags: [] }),
    GET_CART_SUMMARY: async () => cfg.cart === 'fail'
      ? { ok: false, error: "Cart didn't answer in 7s." }
      : { ok: true, text: '购物车: 1 item', expiredAvailable: false, myrSum: 50, sgdSum: null },
    GET_CUSTOMER_NOTES: (m) => backend.load(String(m.psid || '')),
    GET_BANK_TRANSACTIONS: async () => ({ ok: true, rows: [], updatedTime: null, etag: null }),
    GET_PENDING_SLIPS: async () => ({ ok: false, error: 'off' }),
  };
  chrome.runtime.sendMessage = (msg, cb) => {
    window.__count[msg.type] = (window.__count[msg.type] || 0) + 1;
    const h = handlers[msg.type] || (async () => ({ ok: false, error: 'stub' }));
    Promise.resolve(h(msg)).then((res) => cb && cb(res));
  };
})();
`;

const results = [];
function check(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

(async () => {
  const browser = await chromium.launch();

  async function open(uid, seedCfg) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
    page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
    await page.addInitScript(`window.__seedCfg = ${JSON.stringify(seedCfg || {})};`);
    await page.addInitScript(stub);
    await page.goto('file://' + path.join(EXT, 'notebar-ui-fixture.html') + `?asset_id=103550019254847&selected_item_id=${uid}`);
    await page.addStyleTag({ path: path.join(EXT, 'styles.css') });
    await page.addScriptTag({ path: path.join(EXT, 'content.js') });
    return page;
  }
  const P = '#cim-purchase-panel';
  const showsOrders = (page) => page.evaluate((p) => !!document.querySelector(p + ' .cim-body .cim-summary'), P);
  const loadingBars = (page) => page.evaluate((p) => !!document.querySelector(p + ' .cim-body .cim-skeleton'), P);
  const retryBtn = (page) => page.locator(P + ' .cim-body .cim-retry-btn');
  const waitOrders = (page, t = 4000) => page.waitForFunction((p) => !!document.querySelector(p + ' .cim-body .cim-summary'), P, { timeout: t }).then(() => true, () => false);
  const bodyText = (page) => page.evaluate((p) => document.querySelector(p + ' .cim-body')?.textContent || '', P);
  const shot = (page, n) => page.screenshot({ path: path.join(OUT, n + '.png') });

  // B — the orders reply is an error: says so, Retry loads it.
  {
    const page = await open('111', { orders: 'fail' });
    await page.waitForSelector(P + ' .cim-body .cim-retry-btn', { timeout: 4000 }).catch(() => {});
    check('B: failed orders reply → Retry shown', await retryBtn(page).isVisible());
    check('B: names which part failed', (await bodyText(page)).includes('Baserow (customer record)'), await bodyText(page));
    await shot(page, 'B-error');
    await page.evaluate(() => { window.__cfg.orders = 'ok'; });
    await retryBtn(page).click().catch(() => {});
    check('B: Retry → orders shown', await waitOrders(page));
    await page.close();
  }

  // C — Meta removes the panel exactly as the reply lands.
  {
    const page = await open('111', { orders: 'manual' });
    await page.waitForFunction(() => typeof window.__release === 'function', null, { timeout: 4000 });
    await page.evaluate((p) => { document.querySelector(p).remove(); window.__release(); }, P);
    await page.waitForTimeout(1200);
    check('C: panel re-added', await page.evaluate((p) => !!document.querySelector(p), P));
    check('C: reply that landed with no panel → orders shown, not stuck', await showsOrders(page), (await bodyText(page)).slice(0, 80));
    check('C: PSID row filled, not "checking..."', !(await page.evaluate((p) => document.querySelector(p + ' .cim-psid').textContent, P)).includes('checking'));
    await shot(page, 'C-panel-readded');
    await page.close();
  }

  // D — the URL loses selected_item_id for a moment as the reply lands.
  {
    const page = await open('111', { orders: 'manual' });
    await page.waitForFunction(() => typeof window.__release === 'function', null, { timeout: 4000 });
    await page.evaluate(() => {
      const back = location.href;
      history.replaceState(null, '', location.pathname + '?asset_id=103550019254847');
      window.__release();
      setTimeout(() => history.replaceState(null, '', back), 50);
    });
    await page.waitForTimeout(1200);
    check('D: reply during a URL blink → orders shown, not stuck', await showsOrders(page), (await bodyText(page)).slice(0, 80));
    await page.close();
  }

  // E — unlinked chat, Baserow UID search fails: Retry, no ManyChat re-link offer.
  {
    const page = await open('999', { uidSearch: 'fail' });
    await page.waitForSelector(P + ' .cim-body .cim-retry-btn', { timeout: 4000 }).catch(() => {});
    check('E: Baserow UID search failed → Retry shown', await retryBtn(page).isVisible(), (await bodyText(page)).slice(0, 80));
    check('E: no ManyChat search / candidates offered', !(await page.evaluate(() => window.__count.SEARCH_MANYCHAT_BY_NAME)));
    await page.evaluate(() => { window.__cfg.uidSearch = 'found'; });
    await retryBtn(page).click().catch(() => {});
    check('E: Retry → found in Baserow, orders shown', await waitOrders(page));
    await page.close();
  }

  // F — the cart probe fails: a Retry row instead of no 人手结单 buttons.
  {
    const page = await open('111', { session: true, cart: 'fail' });
    await waitOrders(page);
    await page.waitForSelector(P + ' .cim-cart-retry', { timeout: 4000 }).catch(() => {});
    check('F: cart probe failed → retry row shown', await page.locator(P + ' .cim-cart-retry').isVisible());
    check('F: no cart buttons yet', !(await page.locator(P + ' .cim-cart-buttons').count()));
    await shot(page, 'F-cart-retry');
    await page.evaluate(() => { window.__cfg.cart = 'items'; });
    await page.locator(P + ' .cim-cart-retry button').click().catch(() => {});
    await page.waitForSelector(P + ' .cim-cart-buttons', { timeout: 4000 }).catch(() => {});
    check('F: Retry → 人手结单 cart buttons shown', await page.locator(P + ' .cim-cart-buttons').isVisible());
    check('F: retry row gone', !(await page.locator(P + ' .cim-cart-retry').count()));
    await page.close();
  }

  // A — the orders reply never comes: the watchdog ends the loading bars.
  {
    const page = await open('111', { orders: 'hang' });
    await page.waitForTimeout(2000);
    check('A: still loading at 2 s (no false alarm)', await loadingBars(page));
    await page.waitForSelector(P + ' .cim-body .cim-retry-btn', { timeout: 33000 }).catch(() => {});
    check('A: no reply → loading bars end with Retry', await retryBtn(page).isVisible() && !(await loadingBars(page)), (await bodyText(page)).slice(0, 80));
    await shot(page, 'A-watchdog');
    await page.evaluate(() => { window.__cfg.orders = 'ok'; });
    await retryBtn(page).click().catch(() => {});
    check('A: Retry → orders shown', await waitOrders(page));
    await page.close();
  }

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(failed ? failed + ' FAILED' : 'ALL ' + results.length + ' PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
