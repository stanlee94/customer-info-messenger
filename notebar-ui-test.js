// Note bar + Business Suite layout — UI regression test, no network.
// Loads content.js + styles.css into notebar-ui-fixture.html (a stand-in for
// Meta's inbox built from the real DOM anchors: "Inbox / Respond to messages"
// header, role=toolbar with icon-only buttons + hidden labels, Available
// picker in a portal, GenericThreadListView, channel_selector, chat header,
// "View profile" sidebar) with chrome.* stubbed: storage in memory, the notes
// handlers are background.js's real preview code (sliced out of the file).
// It never touches Meta, Baserow or ManyChat. Run: node notebar-ui-test.js
// Screenshots → $OUT_DIR (default: <tmp>/notebar-ui-shots).
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(require('os').tmpdir(), 'notebar-ui-shots');
fs.mkdirSync(OUT, { recursive: true });

const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const notesSrc = bg.slice(bg.indexOf('// ── Customer notes'), bg.indexOf('chrome.runtime.onMessage.addListener'));

const stub = `
(() => {
  const store = Object.assign({ uidPsidMap: { '111': '25881234561194', '222': '25889999990077', '444': '25884444444444' } }, window.__seed || {});
  const listeners = [];
  const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
  const local = {
    get(keys, cb) {
      let out = {};
      if (keys == null) out = clone(store);
      else (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = clone(store[k]); });
      setTimeout(() => cb(out), 0);
    },
    set(obj, cb) {
      const changes = {};
      for (const k in obj) { changes[k] = { oldValue: store[k], newValue: clone(obj[k]) }; store[k] = clone(obj[k]); }
      setTimeout(() => { listeners.forEach((l) => l(changes, 'local')); cb && cb(); }, 0);
    },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]); cb && setTimeout(cb, 0); },
  };
  window.__store = store;
  window.chrome = { storage: { local, session: local, onChanged: { addListener: (l) => listeners.push(l) } }, runtime: {} };
  ${notesSrc}
  const summary = { totalSpending: 1234.5, totalPurchase: 9, rawRecency: 12, lastOrderDate: '2026-09-20', yearsActive: 2, rank: 'Loyal', address: '12 Jalan Bukit, 50450 KL', recentOrders: [], allOrders: [] };
  const handlers = {
    CHECK_SESSION: async () => ({ ok: true, valid: false }),
    GET_AI_HEALTH: async () => ({ ok: false }),
    SEARCH_BASEROW_BY_UID: async () => ({ ok: true, psid: null }),
    SEARCH_MANYCHAT_BY_NAME: async () => ({ ok: true, candidates: [] }),
    GET_ORDERS_BY_PSID: async (m) => { await new Promise((r) => setTimeout(r, window.__ordersDelay || 300)); const names = { '25881234561194': 'Tan Mei Ling', '25889999990077': 'Lim Ah Kow', '25884444444444': 'Someone Else' }; return { ok: true, data: { ...summary, baserowName: names[m.psid] || '' } }; },
    GET_MANYCHAT_INFO: async () => ({ ok: true, tags: [] }),
    GET_CUSTOMER_NOTES: (m) => getCustomerNotes(String(m.psid || '')),
    SAVE_CUSTOMER_NOTES: (m) => saveCustomerNotes(m),
    GET_CUSTOMER_NOTE_LOG: (m) => getCustomerNoteLog(String(m.psid || '')),
    OPEN_OPTIONS_PAGE: async () => { window.__optionsOpened = true; return { ok: true }; },
  };
  chrome.runtime.sendMessage = (msg, cb) => {
    window.__msgs = (window.__msgs || []).concat(msg.type);
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 820 } });
  page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  const url = 'file://' + path.join(__dirname, 'notebar-ui-fixture.html') + '?asset_id=103550019254847&selected_item_id=111';
  const seed = process.env.NO_FB_NAME ? '' : '';
  await page.addInitScript(stub);
  await page.goto(url);
  await page.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  const bar = page.locator('#cim-note-bar');
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png') });
  const status = () => page.evaluate(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent);
  const openEd = async () => { if (!(await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden))) await page.click('#cim-note-bar .cim-nb-compact'); await page.waitForSelector('#cim-nb-editor:not([hidden])'); };

  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set', null, { timeout: 8000 });
  check('bar placed in header', await page.evaluate(() => document.querySelector('#cim-note-bar').nextElementSibling?.textContent.includes('Respond to messages')));
  check('header hidden', await page.evaluate(() => getComputedStyle(document.querySelector('#cim-note-bar').nextElementSibling).display === 'none'));
  check('closed: only the profile button shows', await page.locator('[data-k="avatar"]').isVisible() && !(await page.locator('[data-k="automations"]').isVisible()) && !(await page.locator('#avail').isVisible()));
  const avBefore = await page.evaluate(() => { const r = document.querySelector('[data-k="avatar"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; });
  const rowBefore = await page.evaluate(() => Math.round(document.querySelector('.topbar').getBoundingClientRect().height));
  check('profile button right of Tools', await page.evaluate(() => document.querySelector('[data-k="avatar"]').getBoundingClientRect().left > document.getElementById('cim-tb-toggle').getBoundingClientRect().right));
  check('Tools button shown', await page.locator('#cim-tb-toggle').isVisible());
  const barW = await page.evaluate(() => Math.round(document.getElementById('cim-note-bar').getBoundingClientRect().width));
  check('bar takes the freed row', barW > 1150, String(barW));
  const barBefore = await page.evaluate(() => Math.round(document.getElementById('cim-note-bar').getBoundingClientRect().width));
  await page.click('#cim-tb-toggle');
  check('Tools opens the dropdown', await page.locator('[data-k="automations"]').isVisible());
  const avAfter = await page.evaluate(() => { const r = document.querySelector('[data-k="avatar"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; });
  check('profile button does not move when open', avAfter[0] === avBefore[0] && avAfter[1] === avBefore[1], JSON.stringify([avBefore, avAfter]));
  check('header row height unchanged', (await page.evaluate(() => Math.round(document.querySelector('.topbar').getBoundingClientRect().height))) === rowBefore);
  check('note bar width unchanged', (await page.evaluate(() => Math.round(document.getElementById('cim-note-bar').getBoundingClientRect().width))) === barBefore);
  check('dropdown items below the header, inside window', await page.evaluate(() => { const hb = document.getElementById('cim-tb-toggle').getBoundingClientRect().bottom; return Array.from(document.querySelectorAll('[role="toolbar"] [data-k]:not([data-k="avatar"]), [role="toolbar"] [role="combobox"]')).every((b) => { const r = b.getBoundingClientRect(); return r.top > hb && r.right <= innerWidth && r.left >= 0; }); }));
  check('chat not pushed by dropdown', await page.evaluate(() => Math.round(document.querySelector('.cols').getBoundingClientRect().top)) === await page.evaluate(() => Math.round(document.getElementById('chanBox').getBoundingClientRect().bottom)));
  check('icon-only buttons show their names', await page.evaluate(() => ['Automations', 'Messaging insights', 'Message settings'].every((t) => { const el = Array.from(document.querySelectorAll('[role="toolbar"] [data-sscoverage-ignore]')).find((x) => x.textContent === t); return el && el.getBoundingClientRect().width > 40; })));
  check('every item inside the dropdown', await page.evaluate(() => { const m = (() => { const items = Array.from(document.querySelectorAll('[role="toolbar"] > .cim-tb-first, [role="toolbar"] > .cim-tb-last')).map((x) => x.getBoundingClientRect()); return { left: Math.min(...items.map((r) => r.left)), right: Math.max(...items.map((r) => r.right)) }; })(); return Array.from(document.querySelectorAll('[role="toolbar"] [role="button"]:not([data-k="avatar"]), [role="toolbar"] [role="combobox"]')).every((b) => { const r = b.getBoundingClientRect(); return r.right <= m.right + 0.5 && r.left >= m.left - 0.5; }); }));
  check('items left-aligned in one column', await page.evaluate(() => { const ls = Array.from(document.querySelectorAll('[role="toolbar"] [role="button"][data-k]:not([data-k="avatar"]), [role="toolbar"] [role="combobox"]')).map((b) => Math.round(b.getBoundingClientRect().left)); return new Set(ls).size === 1; }), '');
  check('white panel sits behind every item', await page.evaluate(() => { const m = document.querySelector('[role="toolbar"]'); const items = Array.from(m.querySelectorAll(':scope > [data-cim-row]')).filter((x) => x.offsetParent); return items.every((it) => { const r = it.getBoundingClientRect(); const x = r.right + 4, y = r.top + r.height / 2; const el = document.elementFromPoint(x, y); return el === m; }); }));
  check('avatar not inside the panel', await page.evaluate(() => document.querySelector('[data-k="avatar"]').getBoundingClientRect().bottom <= document.getElementById('cim-tb-toggle').getBoundingClientRect().bottom + 2));
  await page.hover('[role="toolbar"] [data-k="automations"]');
  await page.waitForSelector('#metaTip');
  await page.waitForTimeout(150);
  check("Meta's hover label shows above the dropdown", await page.evaluate(() => { const t = document.getElementById('metaTip'); const r = t.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t.contains(hit); }));
  await shot('00c-hover-label');
  check('icon-only items: name right after the icon', await page.evaluate(() => ['automations', 'insights', 'settings'].every((k) => { const b = document.querySelector('[role="toolbar"] [data-k="' + k + '"]'); const lab = b.querySelector('[data-sscoverage-ignore]').getBoundingClientRect(); const br = b.getBoundingClientRect(); return lab.left - br.left < 60; })));
  check('icon-only names same size as Create messaging ad', await page.evaluate(() => { const ref = getComputedStyle(Array.from(document.querySelectorAll('[role="toolbar"] [data-k="ad"] div')).find((d) => d.textContent === 'Create messaging ad')).fontSize; return ['automations', 'insights', 'settings'].every((k) => getComputedStyle(document.querySelector('[role="toolbar"] [data-k="' + k + '"] [data-sscoverage-ignore]')).fontSize === ref); }));
  check('first item clears the panel top', await page.evaluate(() => { const first = document.querySelector('[role="toolbar"] > .cim-tb-first'); return parseFloat(getComputedStyle(first).marginTop) === 14; }));
  check('separators hidden', await page.evaluate(() => Array.from(document.querySelectorAll('[role="toolbar"] .sep')).every((x) => x.offsetParent === null)));
  await page.waitForTimeout(300); await shot('00-tools-open');
  await page.click('[role="toolbar"] [data-k="automations"]');
  check("Meta's own click handler still runs", await page.evaluate(() => window.__clicks.includes('automations')));
  await page.click('#avail');
  await page.waitForSelector('[role="listbox"]');
  await page.waitForTimeout(200); await shot('00b-available-picker');
  await page.click('[role="option"]:has-text("Away")');
  check('Available picker works inside dropdown', (await page.locator('#availText').textContent()) === 'Away');
  check('dropdown stays open while using the picker', await page.locator('[data-k="automations"]').isVisible());
  await page.keyboard.press('Escape');
  check('Esc closes dropdown', !(await page.locator('[data-k="automations"]').isVisible()) && await page.locator('[data-k="avatar"]').isVisible());
  check('tooltip layer put back after close', await page.evaluate(() => document.getElementById('tipLayer').style.zIndex === '10'));
  await page.click('#cim-tb-toggle');
  await page.mouse.click(700, 600);
  check('outside click closes dropdown', !(await page.locator('[data-k="automations"]').isVisible()));
  check('left nav untouched', await page.evaluate(() => getComputedStyle(document.querySelector('.nav')).display !== 'none' && getComputedStyle(document.querySelector('.app')).display !== 'none'));
  check('identity from Facebook blob', (await page.evaluate(() => document.querySelector('.cim-nb-me').textContent)) === 'You: Angel Chok');
  check('name in bar', (await page.evaluate(() => document.querySelector('.cim-nb-name').textContent)) === 'Tan Mei Ling');
  check('psid suffix', (await page.evaluate(() => document.querySelector('.cim-nb-psid').textContent)) === 'PSID …1194');
  check('preview chip', await page.evaluate(() => !document.querySelector('.cim-nb-preview').hidden));
  check('save disabled when clean', await page.locator('.cim-nb-save').isDisabled());
  // Conversation list: compact by default
  const tl = () => page.evaluate(() => { const col = document.querySelector('.list'); const av = document.querySelector('.av').getBoundingClientRect(); const pl = document.querySelector('[data-pagelet="GenericThreadListView"]'); return { col: Math.round(col.getBoundingClientRect().width - (parseFloat(getComputedStyle(col).borderLeftWidth) + parseFloat(getComputedStyle(col).borderRightWidth))), av: Math.round(av.width), overflow: pl.scrollWidth > pl.clientWidth + 1, chat: Math.round(document.querySelector('.chat').getBoundingClientRect().width) }; });
  const tl1 = await tl();
  check('list column narrowed to 300px', tl1.col === 300, JSON.stringify(tl1));
  check('list content scaled (avatar 48 → ~41px)', tl1.av >= 40 && tl1.av <= 42, String(tl1.av));
  check('nothing spills sideways in the list', !tl1.overflow);
  check("Meta's Filters button stays inside the list column", await page.evaluate(() => { const f = document.getElementById('filtersBtn').getBoundingClientRect(); const c = document.querySelector('.list').getBoundingClientRect(); return f.right <= c.right && f.left >= c.left; }), await page.evaluate(() => JSON.stringify([document.getElementById('filtersBtn').getBoundingClientRect().right, document.querySelector('.list').getBoundingClientRect().right])));
  await page.evaluate(() => chrome.storage.local.set({ threadListSize: 'off' }));
  await page.waitForTimeout(100);
  const tl0 = await tl();
  check("'Meta default' restores the list", tl0.col === 400 && tl0.av === 48, JSON.stringify(tl0));
  check('chat gains the freed width', tl1.chat - tl0.chat === 100, `${tl0.chat} → ${tl1.chat}`);
  await page.evaluate(() => chrome.storage.local.set({ threadListSize: 'extra' }));
  await page.waitForTimeout(100);
  const tl2 = await tl();
  check('extra compact: 260px', tl2.col === 260 && !tl2.overflow, JSON.stringify(tl2));
  await page.evaluate(() => chrome.storage.local.set({ threadListSize: 'compact' }));
  await page.waitForTimeout(100);
  await shot('00d-compact-list');
  // Compact Meta headers: padding halved, fonts untouched, nothing scaled
  const cs = (sel, prop) => page.evaluate(([q, p]) => getComputedStyle(document.querySelector(q))[p], [sel, prop]);
  check('channel tabs bar padding 12/16 → 6/8', (await cs('#chanBox', 'padding')) === '6px 8px', await cs('#chanBox', 'padding'));
  check('tab padding 10/16 → 5/8', (await cs('.tab', 'padding')) === '5px 8px', await cs('.tab', 'padding'));
  check('tab font unchanged (17px)', (await cs('.tab', 'fontSize')) === '17px');
  check('chat header padding 14/16 → 7/8', (await cs('#chatHead', 'padding')) === '7px 8px', await cs('#chatHead', 'padding'));
  check('chat name font unchanged', (await cs('#chatName', 'fontSize')) === '16px', await cs('#chatName', 'fontSize'));
  check('nothing scaled', (await cs('#chanBox', 'zoom')) === '1' && (await cs('#chatHead', 'zoom')) === '1' && (await cs('.prof', 'zoom')) === '1');
  check('chat header buttons still clickable', await page.evaluate(() => { const b = document.querySelectorAll('#chatHead [role="button"]')[2]; const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; }));
  check('our panel padding untouched', (await cs('#cim-purchase-panel', 'padding')) === '8px 10px 10px', await cs('#cim-purchase-panel', 'padding'));
  await shot('00f-compact-headers');
  // Hover must not expand anything (React rewrites className on hover)
  const tabPad = await cs('.tab:nth-child(2)', 'padding');
  const hbPad = await cs('#chatHead [role="button"]', 'padding');
  await page.hover('.tab:nth-child(2)');
  await page.waitForTimeout(150);
  check('tab does not expand on hover', (await cs('.tab:nth-child(2)', 'padding')) === tabPad, `${tabPad} → ${await cs('.tab:nth-child(2)', 'padding')}`);
  await page.hover('#chatHead [role="button"]');
  await page.waitForTimeout(150);
  check('header button does not expand on hover', (await cs('#chatHead [role="button"]', 'padding')) === hbPad, `${hbPad} → ${await cs('#chatHead [role="button"]', 'padding')}`);
  check('header button padding halved (8/12 → 4/6)', hbPad === '4px 6px', hbPad);
  await page.mouse.move(700, 600);
  await page.waitForTimeout(600);
  check('no double-halving after hover + re-scan', (await cs('.tab:nth-child(2)', 'padding')) === tabPad && (await cs('#chatHead [role="button"]', 'padding')) === hbPad);
  await page.evaluate(() => chrome.storage.local.set({ compactMetaHeaders: false }));
  await page.waitForTimeout(100);
  check('switch off → Meta spacing back', (await cs('#chanBox', 'padding')) === '12px 16px' && (await cs('#chatHead', 'padding')) === '14px 16px');
  await page.evaluate(() => chrome.storage.local.set({ compactMetaHeaders: true }));
  await page.waitForTimeout(100);
  // Compact right sidebar
  const sb = () => page.evaluate(() => ({
    prof: getComputedStyle(document.querySelector('.prof')).padding,
    sec: getComputedStyle(document.querySelector('.sec.mine')).padding,
    divider: getComputedStyle(document.querySelector('.divider')).display,
    secBorder: getComputedStyle(document.querySelector('.sec.mine')).borderTopWidth,
    panelMargin: getComputedStyle(document.getElementById('cim-purchase-panel')).margin,
    labelsBorder: getComputedStyle(document.querySelectorAll('.side .sec')[1]).borderTopWidth,
  }));
  const sb1 = await sb();
  const pb = await page.evaluate(() => ({ h: Math.round(document.getElementById('profBlock').getBoundingClientRect().height), av: Math.round(document.querySelector('.pav').getBoundingClientRect().height), nameFont: getComputedStyle(document.getElementById('sideName')).fontSize, padL: getComputedStyle(document.querySelector('.prof')).paddingLeft }));
  check('profile header hugs the avatar (48px avatar → block ≤ 58px)', pb.h <= 58 && pb.av === 48, JSON.stringify(pb));
  check('profile header font and side padding kept', pb.nameFont === '20px' && pb.padL === '8px', JSON.stringify(pb));
  check('panel section padding 16/12 → 6/8', sb1.sec === '6px 8px', sb1.sec);
  check('divider line hidden', sb1.divider === 'none');
  check('section top border removed', sb1.secBorder === '0px');
  check('docked panel: no side margin, 6px below', sb1.panelMargin === '0px 0px 6px', sb1.panelMargin);
  check('other Meta sections untouched (Labels border kept)', sb1.labelsBorder === '1px', sb1.labelsBorder);
  check('View profile still visible', await page.locator('text=View profile').isVisible());
  await page.locator('.side').screenshot({ path: path.join(OUT, '00e-sidebar.png') });
  const rowH = () => page.evaluate(() => Math.round(document.querySelector('.cim-nb-compact').getBoundingClientRect().height));
  check('row is 36px', (await rowH()) === 36, String(await rowH()));
  check('empty row invites', await page.evaluate(() => !document.querySelector('.cim-nb-empty').hidden));
  await shot('01-empty');
  const colsTop = () => page.evaluate(() => Math.round(document.querySelector('.cols').getBoundingClientRect().top));
  const topClosed = await colsTop();
  await page.click('.cim-nb-compact');
  check('editor opens on click', await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden));
  check('opening does not push the chat down', (await colsTop()) === topClosed, `${topClosed} → ${await colsTop()}`);
  check('note box focused', await page.evaluate(() => document.activeElement?.classList.contains('cim-nb-note')));
  await shot('01b-editor-open');
  await page.keyboard.press('Escape');
  check('Esc closes', await page.evaluate(() => document.getElementById('cim-nb-editor').hidden));

  await openEd(); await page.fill('.cim-nb-balance', '  RM 19.90 credit  ');
  check('dirty status', (await status()).startsWith('Unsaved'), await status());
  check('save enabled when dirty', !(await page.locator('.cim-nb-save').isDisabled()));
  check('no flag while typing', !(await bar.evaluate((b) => b.classList.contains('cim-note-bar--flag'))));
  await shot('02-dirty');

  await page.press('.cim-nb-balance', 'Enter');
  await page.waitForTimeout(150);
  check('saving status', (await status()) === 'Saving…', await status());
  check('inputs disabled while saving', await page.locator('.cim-nb-balance').isDisabled());
  await shot('03-saving');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓');
  await page.waitForFunction(() => document.getElementById('cim-nb-editor').hidden);
  await page.mouse.move(700, 600);
  await page.waitForTimeout(250);
  const look = await page.evaluate(() => { const r = getComputedStyle(document.querySelector('.cim-nb-compact')); const t = getComputedStyle(document.getElementById('cim-tb-toggle')); return { row: [r.backgroundColor, r.borderTopColor, r.borderLeftWidth, r.color], tools: [t.backgroundColor, t.borderTopColor, t.borderLeftWidth, t.color] }; });
  check('bar row looks like Tools even with a balance saved', JSON.stringify(look.row) === JSON.stringify(look.tools), JSON.stringify(look));
  const mainFlag = () => page.evaluate(() => document.querySelector('.main').classList.contains('cim-page-green') && getComputedStyle(document.querySelector('.main')).backgroundColor === 'rgb(220, 252, 231)');
  check('names match + balance saved → inbox GREEN', await mainFlag());
  check('inner min-width box not the target', await page.evaluate(() => !document.querySelector('.cols').className.includes('cim-page-')));
  check('panel NOT tinted after save', await page.evaluate(() => getComputedStyle(document.getElementById('cim-purchase-panel')).backgroundColor === 'rgb(255, 255, 255)'));
  check('value trimmed', (await page.inputValue('.cim-nb-balance')) === 'RM 19.90 credit');
  await shot('04-saved');
  await page.waitForTimeout(2200);
  check('saved-by line', /^Saved by Angel Chok · \d\d:\d\d, \d+ \w+$/.test(await status()), await status());
  await shot('05-flagged');

  // Note with Cmd+Enter; plain Enter = newline
  await openEd(); await page.click('.cim-nb-note');
  await page.keyboard.type('Wants parcel left at guardhouse');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Call before delivery');
  check('plain Enter keeps newline', (await page.inputValue('.cim-nb-note')).includes('\n'));
  await page.keyboard.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Saved'));
  await page.waitForTimeout(1200);
  check('editor folds after save', await page.evaluate(() => document.getElementById('cim-nb-editor').hidden));
  // Long text must not grow the row
  await openEd(); await page.fill('.cim-nb-note', 'Wants parcel left at guardhouse\nCall before delivery\n' + 'Long note line that goes on and on about the customer and their preferences. '.repeat(6));
  await page.keyboard.press('Meta+Enter');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Saved'));
  await page.waitForTimeout(1200);
  check('row stays 36px with a long note', (await rowH()) === 36, String(await rowH()));
  check('chat not pushed by long note', (await colsTop()) === topClosed);
  check('editor folded after second quick save', await page.evaluate(() => document.getElementById('cim-nb-editor').hidden));
  await shot('05b-long-note-row');
  await openEd();
  check('editor open: chat still not pushed', (await colsTop()) === topClosed);
  await shot('05c-long-note-editor');
  // Click outside keeps a draft
  await page.fill('.cim-nb-balance', 'RM 19.90 credit + RM 5');
  await page.mouse.click(700, 500);
  check('outside click closes', await page.evaluate(() => document.getElementById('cim-nb-editor').hidden));
  check('row not styled open after outside click', await page.evaluate(() => !document.getElementById('cim-note-bar').classList.contains('cim-note-bar--open') && document.querySelector('.cim-nb-compact').getAttribute('aria-expanded') === 'false'));
  await page.waitForTimeout(300);
  check('row says Unsaved', (await page.evaluate(() => document.querySelector('.cim-nb-cstatus').textContent)) === 'Unsaved');
  check('row still shows stored balance', (await page.evaluate(() => document.querySelector('.cim-nb-v-balance').textContent)) === 'RM 19.90 credit');
  await shot('05d-unsaved-row');
  await openEd();
  check('draft kept on reopen', (await page.inputValue('.cim-nb-balance')) === 'RM 19.90 credit + RM 5');
  await page.focus('.cim-nb-balance'); await page.keyboard.press('Escape');
  check('Esc undoes typing first', (await page.inputValue('.cim-nb-balance')) === 'RM 19.90 credit' && await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden));
  await page.keyboard.press('Escape');

  // Escape reverts

  // History
  await openEd(); await page.click('.cim-nb-history-btn');
  await page.waitForSelector('.cim-nb-hrow');
  check('history rows', (await page.locator('.cim-nb-hrow').count()) === 3, String(await page.locator('.cim-nb-hrow').count()));
  const hm = () => page.evaluate(() => { const m = document.getElementById('cim-nb-hmodal'); if (!m || m.hidden) return null; const c = m.querySelector('.cim-nb-hcard').getBoundingClientRect(); return { cx: Math.round(c.left + c.width / 2), cy: Math.round(c.top + c.height / 2), onBody: m.parentElement === document.body, focus: document.activeElement?.className }; });
  const h1 = await hm();
  check('History opens a centred modal', !!h1 && Math.abs(h1.cx - 720) <= 2 && Math.abs(h1.cy - 410) <= 2, JSON.stringify(h1));
  check('modal lives on <body>, focus on its close button', h1 && h1.onBody && h1.focus === 'cim-nb-hclose');
  check('modal shows the customer', (await page.locator('#cim-nb-hmodal .cim-nb-hsub').textContent()) === 'Tan Mei Ling · PSID …1194');
  check('modal sits above the editor', await page.evaluate(() => { const r = document.querySelector('#cim-nb-hmodal .cim-nb-hcard').getBoundingClientRect(); return document.getElementById('cim-nb-hmodal').contains(document.elementFromPoint(r.left + 20, r.top + 20)); }));
  await page.waitForTimeout(200);
  await shot('06-history');
  await page.keyboard.press('Escape');
  check('Esc closes the modal, editor stays open', (await hm()) === null && await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden));
  await page.click('.cim-nb-history-btn');
  await page.waitForSelector('.cim-nb-hrow');
  await page.mouse.click(30, 780);
  check('backdrop click closes the modal, editor stays open', (await hm()) === null && await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden));
  await page.click('.cim-nb-history-btn');
  await page.click('#cim-nb-hmodal .cim-nb-hclose');
  check('× closes the modal', (await hm()) === null);
  await page.keyboard.press('Escape');

  // Slow switch: URL first, names 1.8 s later → cover, never old data
  await page.evaluate(() => { window.__ordersDelay = 1500; switchTo('222', 'Lim Ah Kow', 1800); });
  await page.waitForTimeout(700);
  check('cover on bar during switch', await bar.evaluate((b) => b.classList.contains('cim-switching')));
  check('cover on panel during switch', await page.evaluate(() => document.getElementById('cim-purchase-panel').classList.contains('cim-switching')));
  check('switching → normal background', await page.evaluate(() => !document.querySelector('.main').className.includes('cim-page-')));
  check('no flag during switch', !(await bar.evaluate((b) => b.classList.contains('cim-note-bar--flag'))));
  await shot('07-switching');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set', null, { timeout: 10000 });
  check('B loaded, cover gone', !(await bar.evaluate((b) => b.classList.contains('cim-switching'))));
  check('B name right (never the old one)', (await page.evaluate(() => document.querySelector('.cim-nb-name').textContent)) === 'Lim Ah Kow', await page.evaluate(() => document.querySelector('.cim-nb-name').textContent));
  check('panel name right', (await page.locator('#cim-purchase-panel .cim-name').innerText()).includes('Lim Ah Kow'));
  check('B fields empty', (await page.inputValue('.cim-nb-balance')) === '');
  await shot('08-customer-b');

  // Draft kept across switches
  await openEd(); await page.fill('.cim-nb-note', 'draft for B');
  await page.evaluate(() => { window.__ordersDelay = 300; switchTo('111', 'Tan Mei Ling', 0); });
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-balance')?.value === 'RM 19.90 credit', null, { timeout: 8000 });
  check('A values back', true);
  await page.evaluate(() => switchTo('222', 'Lim Ah Kow', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-note')?.value === 'draft for B', null, { timeout: 8000 });
  check('B draft restored', (await status()).includes('from earlier'), await status());
  await openEd();
  await shot('09-draft-restored');

  // Another agent changed only Balance meanwhile → my Note save merges, no conflict
  await page.evaluate(() => { window.__store['noteMock:25889999990077'] = { balance: 'RM 5 voucher', note: '', updatedBy: 'Siti', updatedAt: new Date().toISOString() }; });
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Saved'));
  check('different fields merge, no conflict', (await page.inputValue('.cim-nb-balance')) === 'RM 5 voucher' && (await page.inputValue('.cim-nb-note')) === 'draft for B');
  await page.waitForTimeout(2200);
  // Same field changed by both → conflict
  await openEd(); await page.fill('.cim-nb-note', 'my new note');
  await page.evaluate(() => { const r = window.__store['noteMock:25889999990077']; window.__store['noteMock:25889999990077'] = { ...r, note: 'Siti: refunded already', updatedBy: 'Siti', updatedAt: new Date().toISOString() }; });
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.includes('while you were editing'));
  await shot('10-conflict');
  check('conflict actions', (await page.locator('.cim-nb-status .cim-nb-link').allInnerTexts()).join('|') === 'Load theirs|Overwrite');
  check('my text still in box during conflict', (await page.inputValue('.cim-nb-note')) === 'my new note');
  await page.click('.cim-nb-status .cim-nb-link >> text=Overwrite');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Saved'));
  check('overwrite: my note, their balance kept', (await page.inputValue('.cim-nb-note')) === 'my new note' && (await page.inputValue('.cim-nb-balance')) === 'RM 5 voucher');
  await page.waitForTimeout(2200);
  // Load theirs
  await openEd(); await page.fill('.cim-nb-note', 'another try');
  await page.evaluate(() => { const r = window.__store['noteMock:25889999990077']; window.__store['noteMock:25889999990077'] = { ...r, note: 'Siti again', updatedBy: 'Siti', updatedAt: new Date().toISOString() }; });
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.includes('while you were editing'));
  await page.click('.cim-nb-status .cim-nb-link >> text=Load theirs');
  check('load theirs', (await page.inputValue('.cim-nb-note')) === 'Siti again' && (await status()).startsWith('Saved by Siti'), await status());

  // Save error + retry
  await page.evaluate(() => { window.__store.notesMockFail = 'save'; });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 6');
  await page.press('.cim-nb-balance', 'Enter');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Not saved'));
  check('typed text kept on error', (await page.inputValue('.cim-nb-balance')) === 'RM 6');
  await shot('11-save-error');
  await page.evaluate(() => { window.__store.notesMockFail = 'log'; });
  await page.click('.cim-nb-status .cim-nb-link');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.includes('history not recorded'));
  await shot('12-saved-nolog');
  await page.evaluate(() => { window.__store.notesMockFail = ''; });

  // Clearing removes the flag
  await openEd(); await page.fill('.cim-nb-balance', '');
  await openEd(); await page.fill('.cim-nb-note', '');
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓');
  check('names match, nothing saved → normal background', await page.evaluate(() => !document.querySelector('[class*="cim-page-"]')));
  check('flag off after clearing', !(await bar.evaluate((b) => b.classList.contains('cim-note-bar--flag'))));

  const tone = () => page.evaluate(() => { const m = document.querySelector('.main'); return m.classList.contains('cim-page-green') ? 'green' : m.classList.contains('cim-page-red') ? 'red' : 'none'; });

  // Wrong link: Baserow's name for the linked PSID differs from Meta's
  await page.evaluate(() => switchTo('444', 'Wrong Link', 0));
  await page.waitForFunction(() => document.querySelector('#cim-purchase-panel .cim-name-check')?.textContent.includes('Someone Else'), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  check('Baserow name differs → RED (no balance/note needed)', (await tone()) === 'red');
  check('panel names the Baserow mismatch', (await page.locator('#cim-purchase-panel .cim-name-check').textContent()) === '⚠ Baserow name: Someone Else');
  await shot('13a-wrong-link-red');

  // Back to A (balance saved, names match) → green
  await page.evaluate(() => switchTo('111', 'Tan Mei Ling', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-v-balance')?.textContent === 'RM 19.90 credit', null, { timeout: 8000 });
  await page.waitForTimeout(400);
  check('back on A → GREEN', (await tone()) === 'green');
  check('no Baserow warning when names match', await page.evaluate(() => document.querySelector('#cim-purchase-panel .cim-name-check').hidden));

  // Meta changes the chat BEFORE the URL (stays for > 5 s): never relabel, cover stays
  await page.evaluate(() => { document.getElementById('chatName').textContent = 'Other Person'; document.getElementById('sideName').textContent = 'Other Person'; });
  await page.waitForTimeout(2800);
  check('chat-before-URL: cover up, normal background', await bar.evaluate((b) => b.classList.contains('cim-switching')) && (await tone()) === 'none');
  check('chat-before-URL: A is NOT relabelled with the other name', (await page.evaluate(() => document.querySelector('.cim-nb-name').textContent)) === 'Tan Mei Ling');
  await page.waitForTimeout(3000);
  check('after 5 s the cover explains', (await page.evaluate(() => document.querySelector('#cim-note-bar .cim-switch-cover-text').textContent)).includes('different customer name'));
  await shot('13b-name-conflict');
  await page.evaluate(() => { document.getElementById('chatName').textContent = 'Tan Mei Ling'; document.getElementById('sideName').textContent = 'Tan Mei Ling'; });
  await page.waitForTimeout(700);
  check('names agree again → cover off, GREEN', !(await bar.evaluate((b) => b.classList.contains('cim-switching'))) && (await tone()) === 'green');

  // Sidebar closed: bar still works (panel parked), panel returns when it opens
  await page.evaluate(() => { window.__side = document.querySelector('.side'); window.__side.remove(); switchTo('222', 'Lim Ah Kow', 0); });
  await page.waitForFunction(() => document.querySelector('.cim-nb-name')?.textContent === 'Lim Ah Kow' && /^(Saved|Cleared|Never)/.test(document.querySelector('#cim-note-bar .cim-nb-status')?.textContent || '') && !document.getElementById('cim-note-bar').classList.contains('cim-switching'), null, { timeout: 10000 });
  check('sidebar closed: bar loads the customer', (await page.evaluate(() => document.querySelector('.cim-nb-name').textContent)) === 'Lim Ah Kow');
  check('sidebar closed: panel parked (hidden, alive)', await page.evaluate(() => { const p = document.getElementById('cim-purchase-panel'); return !!p && p.classList.contains('cim-parked') && getComputedStyle(p).display === 'none'; }));
  await page.evaluate(() => { window.__side.querySelector('#cim-purchase-panel')?.remove(); document.querySelector('.cols').appendChild(window.__side); });
  await page.waitForFunction(() => document.querySelector('.side #cim-purchase-panel'), null, { timeout: 5000 });
  check('sidebar reopened: panel moves back in', await page.evaluate(() => { const p = document.getElementById('cim-purchase-panel'); return !p.classList.contains('cim-parked') && document.querySelectorAll('#cim-purchase-panel').length === 1; }));
  check('panel shows the right customer after unparking', (await page.locator('#cim-purchase-panel .cim-name').textContent()).includes('Lim Ah Kow'));

  // Unlinked customer
  await page.evaluate(() => switchTo('333', 'Unlinked Person', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Link this customer first', null, { timeout: 8000 });
  check('unlinked disabled', await page.locator('.cim-nb-balance').isDisabled());
  await shot('13-unlinked');

  // In-panel placement
  await page.evaluate(() => { chrome.storage.local.set({ noteBarPlacement: 'panel' }); switchTo('111', 'Tan Mei Ling', 0); });
  await page.waitForFunction(() => document.querySelector('#cim-purchase-panel #cim-note-bar .cim-nb-balance')?.value === 'RM 19.90 credit', null, { timeout: 8000 });
  await openEd();
  check('bar moved into panel', await page.evaluate(() => !!document.querySelector('#cim-purchase-panel > #cim-note-bar')));
  check('header restored', await page.evaluate(() => getComputedStyle(document.querySelector('.hdr > div')).display !== 'none'));
  check('panel mode: Meta toolbar back as before', await page.locator('[data-k="automations"]').isVisible() && !(await page.locator('#cim-tb-toggle').count()) && !(await page.locator('.cim-tb-menu').count()));
  check('one bar only', await page.evaluate(() => document.querySelectorAll('#cim-note-bar').length === 1));
  await shot('14-in-panel');
  await page.locator('#cim-purchase-panel').screenshot({ path: path.join(OUT, '14b-in-panel-crop.png') });

  // No identity
  await page.evaluate(() => { chrome.storage.local.set({ noteBarPlacement: 'header' }); document.querySelector('script[type="application/json"]').remove(); });
  await page.close();

  const p2 = await browser.newPage({ viewport: { width: 1440, height: 820 } });
  p2.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await p2.addInitScript(stub);
  await p2.addInitScript(() => document.addEventListener('DOMContentLoaded', () => document.querySelector('script[type="application/json"]')?.remove()));
  await p2.goto(url);
  await p2.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await p2.addScriptTag({ path: path.join(EXT, 'content.js') });
  try { await p2.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent.startsWith('Set your name'), null, { timeout: 8000 }); }
  catch (e) { results.push('DEBUG status=' + await p2.evaluate(() => document.querySelector('#cim-note-bar .cim-nb-status')?.innerText + ' | bar=' + !!document.getElementById('cim-note-bar') + ' | scripts=' + document.querySelectorAll('script[type="application/json"]').length)); throw e; }
  check('no identity → read-only', await p2.locator('.cim-nb-balance').isDisabled());
  await p2.click('.cim-nb-compact');
  await p2.screenshot({ path: path.join(OUT, '15-no-identity.png') });
  await p2.keyboard.press('Escape');
  await p2.evaluate(() => chrome.storage.local.set({ staffName: 'Angel' }));
  await p2.waitForFunction(() => document.querySelector('.cim-nb-me')?.textContent === 'You: Angel (typed)');
  check('typed name fallback', !(await p2.locator('.cim-nb-balance').isDisabled()));
  await p2.screenshot({ path: path.join(OUT, '16-typed-name.png') });

  // Narrow window
  await p2.setViewportSize({ width: 1180, height: 760 });
  await p2.screenshot({ path: path.join(OUT, '17-narrow.png') });

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(failed ? failed + ' FAILED' : 'ALL ' + results.length + ' PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
