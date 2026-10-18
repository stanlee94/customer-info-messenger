// "Slip" tag in the conversation list — UI test, no network.
// Loads inbox-receipts-main.js + inbox-receipts.js + styles.css into
// unread-ui-fixture.html (list rows whose own component carries `thread`, as in
// Meta's real page) with chrome.* stubbed: GET_PENDING_SLIPS answers from
// window.__sl.items. Rows are matched on thread.timestamp = the item's last_ts
// (the real check: 16/16 rows equal D1's last message to the ms, 2026-10-19).
// Proves logic only — check a real tab after any change.
// Run: node slip-ui-test.js
const path = require('path');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(require('os').tmpdir(), 'slip-ui-shots');
require('fs').mkdirSync(OUT, { recursive: true });
const T1 = 1792340784390, T2 = 1792339685833, T3 = 1792338336661, T4 = 1792337807391;

const stub = `
(() => {
  const store = Object.assign({}, window.__seed || {});
  const listeners = [];
  const local = {
    get(keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = store[k]; });
      setTimeout(() => cb && cb(out), 0);
    },
    set(obj, cb) {
      const changes = {};
      for (const k in obj) { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = obj[k]; }
      setTimeout(() => { listeners.forEach((l) => l(changes, 'local')); cb && cb(); }, 0);
    },
  };
  window.__sl = { items: [], fail: '', calls: 0 };
  window.chrome = { storage: { local, onChanged: { addListener: (l) => listeners.push(l) } }, runtime: { lastError: undefined } };
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type !== 'GET_PENDING_SLIPS') { cb && cb({ ok: false }); return; }
    window.__sl.calls++;
    setTimeout(() => cb && cb(window.__sl.fail ? { ok: false, error: window.__sl.fail } : { ok: true, items: JSON.parse(JSON.stringify(window.__sl.items)) }), 30);
  };
})();
`;

const results = [];
const check = (name, cond, extra) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
  page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await page.addInitScript((s) => { window.__seed = s; window.__cimRcptCfg = { slipPollMs: 300 }; }, { analysisApiToken: 'tok' });
  await page.addInitScript(stub);
  await page.goto('file://' + path.join(EXT, 'unread-ui-fixture.html') + '?selected_item_id=999');
  await page.evaluate(([t1, t2, t3, t4]) => {
    // Row timestamps as Meta has them: numbers, one as a string.
    window.setThreads([
      { threadFBID: '111', isRead: false, title: 'A', timestamp: t1 },
      { threadFBID: '222', isRead: false, title: 'B', timestamp: String(t2) },
      { threadFBID: '333', isRead: false, title: 'C', timestamp: t3 },
      { threadFBID: '444', isRead: true, title: 'D', timestamp: t4 },
    ]);
    window.__sl.items = [
      { last_ts: t1, n: 1, amount: 979.8, currency: 'MYR', flagged: false },
      { last_ts: t2, n: 2, amount: 50, currency: 'MYR', flagged: false },
      { last_ts: t3, n: 1, amount: 1643.9, currency: 'SGD', flagged: true },
      { last_ts: 1111, n: 1, amount: 10, currency: 'MYR', flagged: false },   // a chat not loaded in the list
    ];
  }, [T1, T2, T3, T4]);
  // Meta's real row layout (structure probe 2026-10-19): row padding 12px, 41px
  // avatar, text column; under name + snippet a line of label chips, each a
  // 21px box (radius 4px, padding 4px 8px) inside row-flex wrappers 7px apart.
  await page.evaluate(() => {
    window.__fillRows = (chips) => document.querySelectorAll('#rows [role="presentation"]').forEach((row, i) => {
      const labels = chips[i] || [];
      row.style.height = '79px';
      row.innerHTML = '<span style="display:contents"><div style="display:flex;padding:12px 0 12px 12px;background:#fff">' +
        '<div style="width:41px;height:41px;border-radius:999px;background:#f1f4f7;flex:none"></div>' +
        '<div style="display:flex;flex-wrap:wrap;width:239px;margin-left:8px">' +
          '<div style="width:183px;height:33px;padding-right:56px"><div style="font:700 14px/17px sans-serif">Customer ' + i + '</div><div style="font:12px/15px sans-serif">snippet text</div></div>' +
          (labels.length ? '<div style="display:flex;width:239px;height:26px"><div><div style="display:flex">' +
            labels.map((l) => '<div style="display:flex;padding-right:7px"><div style="display:flex"><div><div class="mchip" style="display:flex;background:#f1f4f7;border-radius:4px;padding:4px 8px;font:12px/14px sans-serif;color:#1c2b33"><div>' + l + '</div></div></div></div></div>').join('') +
          '</div></div></div>' : '') +
        '</div></div></span>';
    });
  });
  await page.evaluate(() => window.__fillRows({ 0: ['Ordered', 'Purchase'], 2: ['Priority'] }));
  await page.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await page.addScriptTag({ path: path.join(EXT, 'inbox-receipts-main.js') });
  await page.addScriptTag({ path: path.join(EXT, 'inbox-receipts.js') });

  const tags = () => page.evaluate(() => [...document.querySelectorAll('#rows [role="presentation"]')].map((r) => {
    const host = r.querySelector('[data-cim-slip-chip]') || r;
    const cs = getComputedStyle(host, '::before');
    return { label: r.getAttribute('data-cim-slip'), flag: r.getAttribute('data-cim-slip-flag'), content: cs.content, bg: cs.backgroundColor };
  }));
  await page.waitForTimeout(600);
  let t = await tags();
  check('clean single slip: blue "🧾 Slip RM979.80"', t[0].label === '🧾 Slip RM979.80' && t[0].flag === '0' && t[0].content === '"🧾 Slip RM979.80"' && t[0].bg === 'rgb(10, 124, 255)', JSON.stringify(t[0]));
  check('two slips: "🧾 2 slips" (row timestamp given as a string)', t[1].label === '🧾 2 slips', JSON.stringify(t[1]));
  check('flagged slip: red, no amount', t[2].label === '🧾 Slip' && t[2].flag === '1' && t[2].bg === 'rgb(220, 38, 38)', JSON.stringify(t[2]));
  check('no slip → no tag', t[3].label === null && t[3].content === 'none');
  // Placement: first in Meta's chip line, Meta's chip shape; no chips → where the line would be.
  const place = await page.evaluate(() => [...document.querySelectorAll('#rows [role="presentation"]')].slice(0, 3).map((row) => {
    const anchor = row.querySelector('[data-cim-slip-chip]');
    const firstChip = row.querySelector('.mchip');
    const pill = anchor ? getComputedStyle(anchor, '::before') : getComputedStyle(row, '::before');
    // The pseudo-element has no box of its own to measure: measure where Meta's first chip moved to.
    return { pos: row.getAttribute('data-cim-slip-pos'), anchor: !!anchor, chipShift: firstChip ? Math.round(firstChip.getBoundingClientRect().left - row.querySelector('.mchip').closest('[style*="width:239px"]').getBoundingClientRect().left) : null,
      h: pill.height, rad: pill.borderTopLeftRadius, pad: pill.padding, font: pill.fontSize, mr: pill.marginRight, left: pill.left, content: pill.content };
  }));
  check('row with labels: pill drawn first in the chip line (Meta\'s first chip pushed right)', place[0].pos === 'chip' && place[0].anchor && place[0].chipShift > 80, JSON.stringify(place[0]));
  check('pill has Meta\'s chip shape: 21px, radius 4px, padding 4px 8px, 12px text, 7px gap', place[0].h === '21px' && place[0].rad === '4px' && place[0].pad === '4px 8px' && place[0].font === '12px' && place[0].mr === '7px', JSON.stringify(place[0]));
  check('row without labels: pill where the chip line would be, left = the text column', place[1].pos === 'abs' && !place[1].anchor && place[1].left === '61px' && place[1].content === '"🧾 2 slips"', JSON.stringify(place[1]));
  check('flagged row with one label: red pill first', place[2].pos === 'chip' && t[2].flag === '1', JSON.stringify(place[2]));
  await page.screenshot({ path: path.join(OUT, 'slip-tags.png'), clip: { x: 0, y: 0, width: 320, height: 330 } });

  // Staff replies in chat A: Meta updates the row's timestamp in place (no re-render) → tag gone at once.
  await page.evaluate((t1) => { window.__threads[0].timestamp = t1 + 9000; }, T1);
  await page.waitForTimeout(1300);
  t = await tags();
  check('row time changes (staff reply) → tag removed within ~1 s, before the worker knows', t[0].label === null && t[1].label === '🧾 2 slips');

  // The worker drops B on its next poll.
  await page.evaluate((t2) => { window.__sl.items = window.__sl.items.filter((i) => i.last_ts !== t2); }, T2);
  await page.waitForTimeout(800);
  t = await tags();
  check('worker drops a customer → its tag goes on the next poll', t[1].label === null && t[2].label === '🧾 Slip');

  // Virtual list reuses rows for other chats: tags follow the chat, not the row element.
  await page.evaluate(([t3, t4]) => window.setThreads([
    { threadFBID: '444', isRead: true, title: 'D', timestamp: t4 },
    { threadFBID: '333', isRead: false, title: 'C', timestamp: t3 },
  ]), [T3, T4]);
  await page.waitForTimeout(300);
  t = await tags();
  check('rows re-used for other chats: tag follows the chat', t[0].label === null && t[1].label === '🧾 Slip');

  // Scrolling: the list re-uses a row element for another chat (props change, no DOM change)
  // → the tag must follow on the scroll frame, not up to 1 s later.
  await page.evaluate(([t1]) => { window.__sl.items.push({ last_ts: t1 + 50, n: 1, amount: 12, currency: 'MYR', flagged: false }); }, [T1]);
  await page.waitForTimeout(800);
  const lag = await page.evaluate((ts) => new Promise((resolve) => {
    const row = document.querySelectorAll('#rows [role="presentation"]')[0];
    window.__threads[0].timestamp = ts;   // row 0 now shows another chat
    const t0 = performance.now();
    document.getElementById('rows').dispatchEvent(new Event('scroll'));
    const poll = () => (row.getAttribute('data-cim-slip') ? resolve(Math.round(performance.now() - t0)) : performance.now() - t0 > 2000 ? resolve(-1) : requestAnimationFrame(poll));
    poll();
  }), T1 + 50);
  check('scrolling: a re-used row is tagged on the next frame', lag >= 0 && lag < 100, lag + ' ms');

  // Worker unreachable: the last map stays.
  await page.evaluate(() => { window.__sl.fail = 'network'; });
  await page.waitForTimeout(800);
  t = await tags();
  check('worker fails → last tags kept', t[1].label === '🧾 Slip');

  // Token removed in the options: all tags go, no more polls.
  await page.evaluate(() => { window.__sl.fail = ''; chrome.storage.local.set({ analysisApiToken: '' }); });
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__sl.calls);
  t = await tags();
  const attr = await page.evaluate(() => document.documentElement.hasAttribute('data-cim-slips'));
  await page.waitForTimeout(900);
  check('token off → tags and map removed, polling stops', t.every((x) => x.label === null) && !attr && (await page.evaluate(() => window.__sl.calls)) === calls);

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(failed ? `${failed} FAILED` : `ALL ${results.length} PASS`);
  console.log('screenshot:', path.join(OUT, 'slip-tags.png'));
  process.exit(failed ? 1 : 0);
})();
