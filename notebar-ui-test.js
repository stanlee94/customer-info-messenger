// Note bar + Business Suite layout — UI regression test, no network.
// Loads content.js + styles.css into notebar-ui-fixture.html (a stand-in for
// Meta's inbox built from the real DOM anchors: "Inbox / Respond to messages"
// header, role=toolbar with icon-only buttons + hidden labels, Available
// picker in a portal, GenericThreadListView, channel_selector, chat header,
// "View profile" sidebar) with chrome.* stubbed: storage in memory, the notes
// handlers are the real notes-baserow.js running against tests/fake-baserow.js
// (an in-memory Baserow). It never touches Meta, Baserow or ManyChat.
// Run: node notebar-ui-test.js
// Screenshots → $OUT_DIR (default: <tmp>/notebar-ui-shots).
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(require('os').tmpdir(), 'notebar-ui-shots');
fs.mkdirSync(OUT, { recursive: true });

const notesSrc = fs.readFileSync(path.join(EXT, 'notes-baserow.js'), 'utf8');
const fakeSrc = fs.readFileSync(path.join(EXT, 'tests', 'fake-baserow.js'), 'utf8');

const stub = `
(() => {
  const store = Object.assign({ uidPsidMap: { '111': '25881234561194', '222': '25889999990077', '444': '25884444444444', '555': '25885555555555', '666': '25886666666666', '777': '25887777777777' } }, window.__seed || {});
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
  // Counts page scans for Meta's terms notice (the only TreeWalker in content.js).
  const ctw = Document.prototype.createTreeWalker;
  window.__walks = 0;
  Document.prototype.createTreeWalker = function (...a) { window.__walks++; return ctw.apply(this, a); };
  window.chrome = { storage: { local, session: local, onChanged: { addListener: (l) => listeners.push(l) } }, runtime: {} };
  ${fakeSrc}
  ${notesSrc}
  // Baserow table 749 rows (666 is linked in this browser but has NO row).
  const NAMES = { '25881234561194': 'Tan Mei Ling', '25889999990077': 'Lim Ah Kow', '25884444444444': 'Someone Else', '25885555555555': '', '25887777777777': 'Wrong Guy', '25888888888888': 'Chong Wei' };
  const fake = createFakeBaserow();
  for (const [psid, name] of Object.entries(NAMES)) fake.addUser({ PSID: psid, Name: name });
  window.__fake = fake;
  window.__row = (psid) => fake.tables['749'].find((r) => r.PSID === psid);
  window.__fail = '';  // '' | 'save' (PATCH fails) | 'log' (log write fails)
  fake.before((r) => {
    if (window.__fail === 'save' && r.method === 'PATCH') return { status: 500, body: { detail: 'simulated' } };
    if (window.__fail === 'hang' && r.method === 'PATCH') return new Promise(() => {});
    if (window.__fail === 'log' && r.table === '794' && r.method === 'POST') return { status: 500, body: { detail: 'simulated' } };
    if (window.__afterPatch && r.method === 'GET' && r.rowId && fake.requests.at(-2)?.method === 'PATCH') { const f = window.__afterPatch; window.__afterPatch = null; f(); }
    return null;
  });
  const backend = NotesBaserow.createNotesBackend({
    fetch: async (...a) => { await new Promise((r) => setTimeout(r, window.__baserowDelay ?? 120)); return fake.fetch(...a); },
    getConfig: async () => ({ baseUrl: 'https://baserow.test', token: 'tok', usersTableId: '749', logTableId: '794' }),
    timeoutMs: 1500,
  });
  const summary = { totalSpending: 1234.5, totalPurchase: 9, rawRecency: 12, lastOrderDate: '2026-09-20', yearsActive: 2, rank: 'Loyal', address: '12 Jalan Bukit, 50450 KL', recentOrders: [], allOrders: [] };
  const handlers = {
    CHECK_SESSION: async () => ({ ok: true, valid: false }),
    GET_AI_HEALTH: async () => ({ ok: !!window.__aiHealthy }),
    SEARCH_BASEROW_BY_UID: async () => ({ ok: true, psid: null }),
    SEARCH_MANYCHAT_BY_NAME: async (m) => ({ ok: true, candidates: m.name === 'Chong Wei' ? [{ psid: '25888888888888', name: 'Chong Wei', profilePic: '', lastMessage: 'hi', lastInteraction: '' }] : [] }),
    GET_ORDERS_BY_PSID: async (m) => { await new Promise((r) => setTimeout(r, window.__ordersDelay || 300)); return { ok: true, data: { ...summary, baserowName: NAMES[m.psid] || '' } }; },
    GET_MANYCHAT_INFO: async () => ({ ok: true, tags: [] }),
    GET_CUSTOMER_NOTES: (m) => backend.load(String(m.psid || '')),
    SAVE_CUSTOMER_NOTES: (m) => backend.save(m),
    GET_CUSTOMER_NOTE_LOG: (m) => backend.history(String(m.psid || '')),
    NOTES_UNLINK_REVIEW: (m) => backend.unlinkReview(m),
    NOTES_UNLINK_REVERT: (m) => backend.unlinkRevert(m),
    UNLINK_BASEROW_UID: async () => ({ ok: true }),
    LINK_BASEROW_UID: async () => ({ ok: true }),
    OPEN_OPTIONS_PAGE: async () => { window.__optionsOpened = true; return { ok: true }; },
    // Synthetic statements (never real bank data). PBB updated today 05:06 pm.
    GET_BANK_TRANSACTIONS: async (m) => {
      await new Promise((r) => setTimeout(r, 80));
      if (window.__bankFail === m.bank) return { ok: false, error: 'Bank statement API error: 500' };
      const d = new Date(); const today = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
      if (m.bank === 'ocbc') return { ok: true, updatedTime: '01/09/2026 11:40 am', rows: [
        { date: '01/09/2026', reference: '7001', method: 'CASH DEPOSIT     CDM', amount: '37.00', description: 'SG BUYER | NOTE' },
        { date: '31/08/2026', reference: '7002', method: 'FAST TRANSFER', amount: '128.00', description: 'ANOTHER SG' },
      ] };
      const rows = [
        { date: today, reference: '100001', method: 'DUITNOW TRSF CR', amount: '128.00', description: 'TAN MEI LING | payment order|  ' },
        { date: today, reference: '100002', method: 'DUITNOW TRSF CR', amount: '1128.00', description: 'LIM AH KOW' },
        { date: today, reference: '100003', method: 'DEP-ECP', amount: '1643.90', description: 'CHONG WEI | F0955820260113003753' },
        { date: today, reference: '100004', method: 'TSFR FUND CR-ATM/EFT', amount: '128.50', description: 'SOMEONE' },
        { date: today, reference: '200128', method: 'DEP-CASH', amount: '55.00', description: 'CASH' },
      ];
      for (let i = 0; i < 60; i++) rows.push({ date: '01/10/2026', reference: 'F' + i, method: 'DEP-CASH', amount: '10.00', description: 'FILLER ' + i });
      return { ok: true, updatedTime: today + ' 05:06 pm', rows };
    },
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
  const stext = () => page.evaluate(() => document.querySelector('#cim-note-bar .cim-nb-status-text')?.textContent || '');
  const cstatus = () => page.evaluate(() => document.querySelector('#cim-note-bar .cim-nb-cstatus').textContent);
  const links = () => page.locator('#cim-note-bar .cim-nb-status .cim-nb-link').allInnerTexts().then((x) => x.join('|'));
  const waitText = (prefix, t = 6000) => page.waitForFunction((p) => (document.querySelector('#cim-note-bar .cim-nb-status-text')?.textContent || '').startsWith(p), prefix, { timeout: t });
  const openEd = async () => { if (!(await page.evaluate(() => !document.getElementById('cim-nb-editor').hidden))) await page.click('#cim-note-bar .cim-nb-compact'); await page.waitForSelector('#cim-nb-editor:not([hidden])'); };

  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set', null, { timeout: 8000 });
  // Meta's "We're updating our terms" notice: hidden whole, nothing else, looked for once
  check('terms notice hidden', await page.evaluate(() => !document.getElementById('termsBanner').offsetParent));
  check('terms notice: its grey padded box hidden too, no empty strip', await page.evaluate(() => !document.getElementById('termsOuter').offsetParent));
  check("terms notice: Meta's own strip next to it stays", await page.evaluate(() => !!document.getElementById('metaStrip').offsetParent));
  check('terms notice: whole row hidden, the app is not', await page.evaluate(() => { const hidden = document.querySelector('[data-cim-hidden="terms"]'); return !!hidden && hidden.contains(document.getElementById('termsBanner')) && !hidden.contains(document.querySelector('.app')) && getComputedStyle(document.querySelector('.app')).display !== 'none'; }));
  check('terms notice: inbox moves up into the space', await page.evaluate(() => Math.round(document.querySelector('.app').getBoundingClientRect().top) === Math.round(document.getElementById('metaStrip').getBoundingClientRect().bottom) && document.getElementById('metaStrip').getBoundingClientRect().top === 0));
  check("terms notice: Meta's Preview terms never clicked", await page.evaluate(() => !window.__termsClicked));
  // Meta's "Connect to Instagram" card at the top of the conversation list: hidden whole, list stays
  check('Instagram card hidden, with its padded wrapper', await page.evaluate(() => !document.getElementById('igCard').offsetParent && !document.getElementById('igOuter').offsetParent && document.querySelector('[data-cim-hidden="instagram"]')?.id === 'igOuter'));
  check('Instagram card: conversation list, search and rows stay', await page.evaluate(() => !!document.querySelector('.srch').offsetParent && !!document.querySelector('a.row').offsetParent && !!document.getElementById('filtersBtn').offsetParent));
  check("Instagram card: Not now / Connect never clicked", await page.evaluate(() => !window.__igClicked));
  const walks1 = await page.evaluate(() => window.__walks);
  await page.evaluate(() => { for (let i = 0; i < 20; i++) document.querySelector('.msgs').append(document.createElement('span')); });
  await page.waitForTimeout(800);
  check('terms notice: no more scans once hidden', (await page.evaluate(() => window.__walks)) === walks1, `${walks1} → ${await page.evaluate(() => window.__walks)}`);
  // Meta re-renders it as a new node → hidden again
  await page.evaluate(() => { const old = document.querySelector('[data-cim-hidden="terms"]'); const fresh = old.cloneNode(true); fresh.removeAttribute('data-cim-hidden'); fresh.style.removeProperty('display'); old.replaceWith(fresh); });
  await page.waitForTimeout(800);
  check('terms notice: re-rendered by Meta → hidden again', await page.evaluate(() => !document.getElementById('termsOuter').offsetParent && !!document.getElementById('metaStrip').offsetParent));
  await page.evaluate(() => { const old = document.querySelector('[data-cim-hidden="instagram"]'); const fresh = old.cloneNode(true); fresh.removeAttribute('data-cim-hidden'); fresh.style.removeProperty('display'); old.replaceWith(fresh); });
  await page.waitForTimeout(800);
  check('Instagram card: re-rendered by Meta → hidden again', await page.evaluate(() => !document.getElementById('igCard').offsetParent && !!document.querySelector('a.row').offsetParent));
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
  check('no preview tag any more', await page.evaluate(() => !document.querySelector('.cim-nb-preview')));
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
  check('chat header: top/bottom 14 → 2, sides 16 → 8', (await cs('#chatHead', 'padding')) === '2px 8px', await cs('#chatHead', 'padding'));
  check('chat header: name block top/bottom 6 → 2', (await cs('#chatNameBlock', 'padding')) === '2px 0px', await cs('#chatNameBlock', 'padding'));
  check('chat header hugs its tallest item (44px avatar → 48px)', await page.evaluate(() => Math.round(document.getElementById('chatHead').getBoundingClientRect().height)) === 48 + 1, String(await page.evaluate(() => document.getElementById('chatHead').getBoundingClientRect().height)));
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
  await page.evaluate(() => { Object.assign(window.__row('25889999990077'), { Balance: 'RM 5 voucher', Note: '', Note_Updated_By: 'Siti', Note_Updated_At: new Date().toISOString() }); });
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Saved'));
  check('different fields merge, no conflict', (await page.inputValue('.cim-nb-balance')) === 'RM 5 voucher' && (await page.inputValue('.cim-nb-note')) === 'draft for B');
  await page.waitForTimeout(2200);
  // Same field changed by both → conflict
  await openEd(); await page.fill('.cim-nb-note', 'my new note');
  await page.evaluate(() => { Object.assign(window.__row('25889999990077'), { Note: 'Siti: refunded already', Note_Updated_By: 'Siti', Note_Updated_At: new Date().toISOString() }); });
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
  await page.evaluate(() => { Object.assign(window.__row('25889999990077'), { Note: 'Siti again', Note_Updated_By: 'Siti', Note_Updated_At: new Date().toISOString() }); });
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.includes('while you were editing'));
  await page.click('.cim-nb-status .cim-nb-link >> text=Load theirs');
  check('load theirs', (await page.inputValue('.cim-nb-note')) === 'Siti again' && (await status()).startsWith('Saved by Siti'), await status());

  // Save error + retry
  await page.evaluate(() => { window.__fail = 'save'; });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 6');
  await page.press('.cim-nb-balance', 'Enter');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.startsWith('Not saved'));
  check('typed text kept on error', (await page.inputValue('.cim-nb-balance')) === 'RM 6');
  check('server error in plain words', (await stext()) === 'Not saved — Baserow is having a problem (error 500). Try again in a minute. Your text is kept.', await stext());
  await shot('11-save-error');
  // Baserow hangs: the bar stops waiting and says so instead of spinning
  await page.evaluate(() => { window.__fail = 'hang'; });
  await page.click('.cim-nb-status .cim-nb-link');
  await page.waitForTimeout(400);
  check('hang: Saving… at first', (await status()) === 'Saving…', await status());
  await waitText('Not saved', 5000);
  check('hang: gives up and says so', (await stext()) === 'Not saved — Baserow isn’t answering. Press Retry. Your text is kept.', await stext());
  check('hang: typed text kept, Retry offered', (await page.inputValue('.cim-nb-balance')) === 'RM 6' && (await links()) === 'Retry');
  await shot('11a-timeout');
  await page.evaluate(() => { window.__fail = 'log'; });
  await page.click('.cim-nb-status .cim-nb-link');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent.includes('history not recorded'));
  await shot('12-saved-nolog');
  await page.evaluate(() => { window.__fail = ''; });

  // Clearing removes the flag
  await openEd(); await page.fill('.cim-nb-balance', '');
  await openEd(); await page.fill('.cim-nb-note', '');
  await openEd(); await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓');
  check('names match, nothing saved → normal background', await page.evaluate(() => !document.querySelector('[class*="cim-page-"]')));
  check('flag off after clearing', !(await bar.evaluate((b) => b.classList.contains('cim-note-bar--flag'))));
  await page.waitForTimeout(2200);

  // B's row deleted in Baserow after the chat opened → blocked, text kept
  await page.evaluate(() => { const t = window.__fake.tables['749']; window.__bk = t.splice(t.indexOf(window.__row('25889999990077')), 1)[0]; });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 7');
  await page.press('.cim-nb-balance', 'Enter');
  await waitText('Not saved.');
  check('row deleted → says so', (await stext()) === "Not saved. This customer's Baserow row (PSID …0077) was deleted after you opened the chat. Your text is kept. Unlink and link the customer again, then press Save.", await stext());
  check('row deleted → closed row says so', (await cstatus()) === 'Not saved — row deleted', await cstatus());
  check('row deleted → typed text kept', (await page.inputValue('.cim-nb-balance')) === 'RM 7');
  await shot('11b-row-deleted');
  // The row comes back but now carries another PSID → blocked, nothing written
  await page.evaluate(() => { window.__bk.PSID = '25880000000001'; window.__fake.tables['749'].push(window.__bk); });
  await page.click('.cim-nb-save');
  await page.waitForFunction(() => (document.querySelector('#cim-note-bar .cim-nb-status-text')?.textContent || '').startsWith('Not saved. Baserow row #'), null, { timeout: 6000 });
  check('wrong row → names the other PSID', (await stext()).includes('now belongs to a different customer (PSID …0001)'), await stext());
  check('wrong row → nothing written', await page.evaluate(() => !window.__bk.Balance));
  await shot('11c-wrong-row');
  await page.evaluate(() => { window.__bk.PSID = '25889999990077'; });
  // Another agent writes Balance in the instant after ours → told, shows theirs
  await page.evaluate(() => { window.__afterPatch = () => Object.assign(window.__row('25889999990077'), { Balance: 'RM 8 (Siti)', Note_Updated_By: 'Siti', Note_Updated_At: new Date().toISOString() }); });
  await page.click('.cim-nb-save');
  await waitText('Saved, but');
  check('race after our write → says who and what', (await stext()) === 'Saved, but Siti changed Balance a moment later — it now shows "RM 8 (Siti)". Check it.', await stext());
  check('race → box shows what is really stored', (await page.inputValue('.cim-nb-balance')) === 'RM 8 (Siti)');
  await shot('11d-raced');
  await page.keyboard.press('Escape');

  const tone = () => page.evaluate(() => { const m = document.querySelector('.main'); return m.classList.contains('cim-page-green') ? 'green' : m.classList.contains('cim-page-red') ? 'red' : 'none'; });

  // Wrong link: Baserow's name for the linked PSID differs from Meta's
  await page.evaluate(() => switchTo('444', 'Wrong Link', 0));
  await page.waitForFunction(() => document.querySelector('#cim-purchase-panel .cim-name-check')?.textContent.includes('Someone Else'), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  check('Baserow name differs → RED (no balance/note needed)', (await tone()) === 'red');
  check('panel names the Baserow mismatch', (await page.locator('#cim-purchase-panel .cim-name-check').textContent()) === '⚠ Baserow name: Someone Else');
  await shot('13a-wrong-link-red');

  // Saving while red: asks first, naming both; Cancel writes nothing; confirming saves
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set', null, { timeout: 8000 });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 1');
  await page.press('.cim-nb-balance', 'Enter');
  await waitText('Baserow says');
  check('red save asks first, naming both', (await stext()) === 'Baserow says this PSID is Someone Else, but this chat is Wrong Link. Check the link before saving.', await stext());
  check('red save: confirm or cancel', (await links()) === 'It’s the right customer — save|Cancel', await links());
  check('red save: nothing written yet', await page.evaluate(() => !window.__row('25884444444444').Balance));
  check('red save: closed row says check', (await cstatus()) === 'Check customer — open', await cstatus());
  await shot('13c-name-check');
  await page.click('.cim-nb-status .cim-nb-link >> text=Cancel');
  check('cancel keeps the text, writes nothing', (await page.inputValue('.cim-nb-balance')) === 'RM 1' && await page.evaluate(() => !window.__row('25884444444444').Balance));
  await page.press('.cim-nb-balance', 'Enter');
  await waitText('Baserow says');
  await page.click('.cim-nb-status .cim-nb-link >> text=It’s the right customer — save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓', null, { timeout: 6000 });
  check('confirmed → saved to Baserow', await page.evaluate(() => window.__row('25884444444444').Balance === 'RM 1'));
  check('still red after a confirmed save', (await tone()) === 'red');
  await page.waitForTimeout(2200);

  // Baserow has no name for the PSID: confirm the customer once
  await page.evaluate(() => switchTo('555', 'Nameless Chat', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set' && document.querySelector('.cim-nb-name').textContent === 'Nameless Chat', null, { timeout: 8000 });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 2');
  await page.press('.cim-nb-balance', 'Enter');
  await waitText('Save to');
  check('blank Baserow name → confirm the customer', (await stext()) === 'Save to Nameless Chat (PSID …5555)? Baserow has no name for this customer.', await stext());
  await shot('13d-blank-name');
  await page.click('.cim-nb-status .cim-nb-link >> text=Save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓', null, { timeout: 6000 });
  check('blank name confirmed → saved', await page.evaluate(() => window.__row('25885555555555').Balance === 'RM 2'));
  await page.waitForTimeout(2200);

  // Linked here, but Baserow has no row for the PSID → nothing can be saved, never created
  await page.evaluate(() => switchTo('666', 'No Row Person', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-cstatus')?.textContent === 'Not in Baserow', null, { timeout: 8000 });
  check('missing row → inputs disabled', await page.locator('.cim-nb-balance').isDisabled());
  await page.click('.cim-nb-compact');
  await page.waitForTimeout(200);
  check('missing row → the bar opens to explain', await page.locator('#cim-nb-editor').isVisible() && await page.locator('.cim-nb-save').isDisabled());
  check('missing row → editor explains', (await stext()) === "This chat is linked to PSID …6666, but Baserow's Users table has no row for it, and creating one failed. Nothing can be saved. Reload the page; if this stays, unlink and link the customer again.", await stext());
  check('missing row → no row created', await page.evaluate(() => !window.__row('25886666666666') && !window.__fake.requests.some((r) => r.method === 'POST' && r.table === '749')));
  await shot('13e-missing-row');
  await page.keyboard.press('Escape');

  // Back to A (balance saved, names match) → green
  await page.evaluate(() => switchTo('111', 'Tan Mei Ling', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-v-balance')?.textContent === 'RM 19.90 credit', null, { timeout: 8000 });
  // Green needs the panel's Baserow name too (orders lookup), which can land after the notes.
  await page.waitForFunction(() => document.querySelector('.main').classList.contains('cim-page-green'), null, { timeout: 3000 }).catch(() => {});
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

  // Wrong link → agent confirms by mistake and saves → unlink → Move → link the right customer
  await page.evaluate(() => switchTo('777', 'Chong Wei', 0));
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set' && document.querySelector('.cim-nb-name').textContent === 'Chong Wei', null, { timeout: 8000 });
  await openEd(); await page.fill('.cim-nb-balance', 'RM 30 credit');
  await page.press('.cim-nb-balance', 'Enter');
  await waitText('Baserow says');
  await page.click('.cim-nb-status .cim-nb-link >> text=It’s the right customer — save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓', null, { timeout: 6000 });
  check('wrong-link save landed on the wrong customer', await page.evaluate(() => window.__row('25887777777777').Balance === 'RM 30 credit'));
  await page.waitForTimeout(1200);
  const ulm = () => page.evaluate(() => { const m = document.getElementById('cim-unlink-modal'); return m && { title: m.querySelector('.cim-nb-htitle').textContent, sub: m.querySelector('.cim-nb-hsub').textContent, items: Array.from(m.querySelectorAll('.cim-ul-item')).map((i) => i.innerText.replace(/\s+/g, ' ')), buttons: Array.from(m.querySelectorAll('.cim-ul-btn')).map((x) => x.textContent) }; });
  await page.click('#cim-purchase-panel .cim-unlink');
  await page.waitForSelector('#cim-unlink-modal');
  const u1 = await ulm();
  check('unlink shows what this chat saved', u1.title === 'Before you unlink' && u1.sub === 'Wrong Guy · PSID …7777' && u1.items.length === 1 && u1.items[0].includes('Before (empty)') && u1.items[0].includes('This chat RM 30 credit'), JSON.stringify(u1));
  check('unlink offers Move / Keep / Cancel', u1.buttons.join('|') === 'Move to the correct customer|Keep on Wrong Guy|Cancel', u1.buttons.join('|'));
  await page.waitForTimeout(200);
  await shot('18-unlink-review');
  await page.click('#cim-unlink-modal .cim-ul-btn >> text=Cancel');
  check('Cancel unlinks nothing', await page.evaluate(() => !document.getElementById('cim-unlink-modal') && window.__store.uidPsidMap['777'] === '25887777777777' && window.__row('25887777777777').Balance === 'RM 30 credit'));
  await page.click('#cim-purchase-panel .cim-unlink');
  await page.waitForSelector('#cim-unlink-modal');
  await page.click('#cim-unlink-modal .cim-ul-btn >> text=Move to the correct customer');
  await page.waitForSelector('#cim-purchase-panel .cim-candidate-link-btn', { timeout: 8000 });
  check('Move: wrong customer gets the old value back', await page.evaluate(() => window.__row('25887777777777').Balance === ''));
  check('Move: undo is in the history', await page.evaluate(() => { const l = window.__fake.logRows().at(-1); return l.PSID === '25887777777777' && l.Old_Value === 'RM 30 credit' && l.New_Value === '' && l.Changed_By === 'Angel Chok (undo on unlink)'; }));
  check('Move: unlinked', await page.evaluate(() => !window.__store.uidPsidMap['777']));
  await page.click('#cim-purchase-panel .cim-candidate-link-btn');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-cstatus')?.textContent === 'Unsaved', null, { timeout: 8000 });
  await openEd();
  check('right customer gets the text as an unsaved draft', (await page.inputValue('.cim-nb-balance')) === 'RM 30 credit' && (await stext()) === 'Moved from Wrong Guy — not saved yet. Check it and press Save.', await stext());
  check('…and nothing was saved to them yet', await page.evaluate(() => !window.__row('25888888888888').Balance));
  await shot('19-moved-draft');
  await page.click('.cim-nb-save');
  await page.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status').textContent === 'Saved ✓', null, { timeout: 6000 });
  check('agent saves it on the right customer', await page.evaluate(() => window.__row('25888888888888').Balance === 'RM 30 credit' && window.__row('25887777777777').Balance === ''));
  await page.waitForTimeout(1200);

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
  try { await p2.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent.startsWith("Can't read your Facebook name"), null, { timeout: 8000 }); }
  catch (e) { results.push('DEBUG status=' + await p2.evaluate(() => document.querySelector('#cim-note-bar .cim-nb-status')?.innerText + ' | bar=' + !!document.getElementById('cim-note-bar') + ' | scripts=' + document.querySelectorAll('script[type="application/json"]').length)); throw e; }
  check('no identity → read-only', await p2.locator('.cim-nb-balance').isDisabled());
  await p2.click('.cim-nb-compact');
  await p2.screenshot({ path: path.join(OUT, '15-no-identity.png') });
  await p2.keyboard.press('Escape');
  await p2.evaluate(() => chrome.storage.local.set({ staffName: 'Angel' }));
  await p2.waitForTimeout(600);
  check('a leftover typed name is ignored (option removed)', await p2.locator('.cim-nb-balance').isDisabled());

  // AI Rewrite bar: off unless the options toggle `aiReplyEnabled` is on (2026-10-18).
  await p2.evaluate(() => {
    window.__aiHealthy = true;
    const box = document.createElement('div');
    box.id = 'test-composer';
    box.style.cssText = 'position:fixed;left:380px;bottom:10px;width:600px;background:#fff';
    box.innerHTML = '<div style="height:40px"><div contenteditable="true" data-lexical-editor="true" aria-placeholder="Reply in Messenger…" style="height:36px"></div></div><div style="height:30px">toolbar</div>';
    document.body.appendChild(box);
  });
  await p2.waitForTimeout(900);
  check('AI bar: off by default — no bar, no health check', await p2.evaluate(() => !document.getElementById('cim-ai-buttons') && !(window.__msgs || []).includes('GET_AI_HEALTH')));
  await p2.evaluate(() => chrome.storage.local.set({ aiReplyEnabled: true }));
  let aiShown = true;
  try { await p2.waitForSelector('#cim-ai-buttons', { timeout: 3000 }); } catch { aiShown = false; }
  check('AI bar: switched on → shown without reload', aiShown);
  await p2.evaluate(() => chrome.storage.local.set({ aiReplyEnabled: false }));
  await p2.waitForTimeout(500);
  check('AI bar: switched off → removed', await p2.evaluate(() => !document.getElementById('cim-ai-buttons')));
  await p2.evaluate(() => document.getElementById('test-composer').remove());

  // Narrow window
  await p2.setViewportSize({ width: 1180, height: 760 });
  await p2.screenshot({ path: path.join(OUT, '17-narrow.png') });
  await p2.close();

  // Meta's one-row header (2026-10-16): [Inbox][Messages | Leads][toolbar]
  const p3 = await browser.newPage({ viewport: { width: 1440, height: 820 } });
  p3.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await p3.addInitScript(stub);
  await p3.goto(url + '&layout=row');
  const box = (sel) => p3.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; }, sel);
  const tabsBefore = [await box('#tabMessages'), await box('#tabLeads')];
  const rowH3 = (await box('.topbar')).h;
  await p3.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await p3.addScriptTag({ path: path.join(EXT, 'content.js') });
  await p3.waitForFunction(() => document.querySelector('#cim-note-bar .cim-nb-status')?.textContent === 'Never set', null, { timeout: 8000 });
  check('row header: bar in the header row, not the panel', await p3.evaluate(() => { const b = document.getElementById('cim-note-bar'); return b.parentElement === document.querySelector('.topbar') && !b.classList.contains('cim-note-bar--in-panel') && b.classList.contains('cim-note-bar--row'); }));
  check('row header: bar right before the toolbar', await p3.evaluate(() => document.getElementById('cim-note-bar').nextElementSibling === document.querySelector('.tbwrap')));
  check('row header: Inbox shown, Meta\'s Messages | Leads strip hidden', await p3.locator('#inboxHeading').isVisible() && !(await p3.locator('#tabMessages').isVisible()) && !(await p3.locator('#tabLeads').isVisible()));
  check('row header: tabs not moved out of Meta\'s strip', await p3.evaluate(() => document.getElementById('spaceTabs').contains(document.getElementById('tabMessages')) && document.getElementById('spaceTabs').contains(document.getElementById('tabLeads'))));
  const nb = await box('#cim-note-bar');
  check('row header: bar between Inbox and Tools, wide', nb.l > (await box('#inboxHeading')).r && nb.r < (await box('#cim-tb-toggle')).l && nb.w > 800, JSON.stringify(nb));
  check('row header: Tools collapses the toolbar', await p3.locator('#cim-tb-toggle').isVisible() && !(await p3.locator('[data-k="automations"]').isVisible()) && !(await p3.locator('.cim-tb-views').isVisible()));
  check('row header: row height unchanged', (await box('.topbar')).h === rowH3, `${rowH3} → ${(await box('.topbar')).h}`);
  await p3.screenshot({ path: path.join(OUT, '18-row-header.png') });
  await p3.click('#cim-tb-toggle');
  const views = () => p3.evaluate(() => Array.from(document.querySelectorAll('.cim-tb-view')).map((b) => b.textContent.trim() + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join('|'));
  check('Tools: View section lists Messages | Leads, Messages open', (await views()) === 'Messages*|Leads', await views());
  check('Tools: View section on top, divider, then Meta\'s tools', await p3.evaluate(() => { const v = document.querySelector('.cim-tb-views').getBoundingClientRect(); const first = document.querySelector('[role="toolbar"] > .cim-tb-first').getBoundingClientRect(); return v.top > document.getElementById('cim-tb-toggle').getBoundingClientRect().bottom && first.top >= v.bottom && getComputedStyle(document.querySelector('.cim-tb-views')).borderBottomWidth === '1px'; }));
  check('Tools: View items inside the white panel', await p3.evaluate(() => { const m = document.querySelector('[role="toolbar"]'); return Array.from(document.querySelectorAll('.cim-tb-view')).every((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.right + 4, r.top + r.height / 2) === m; }); }));
  check('Tools: Meta\'s tools still all there', await p3.locator('[data-k="automations"]').isVisible() && await p3.locator('[data-k="todos"]').isVisible() && await p3.locator('#avail').isVisible());
  await p3.screenshot({ path: path.join(OUT, '18b-tools-views.png') });
  await p3.click('.cim-tb-view:has-text("Leads")');
  check('Tools → Leads: presses Meta\'s real Leads tab, dropdown closes', (await p3.evaluate(() => window.__view)) === 'tabLeads' && !(await p3.locator('.cim-tb-views').isVisible()));
  await p3.click('#cim-tb-toggle');
  await p3.waitForTimeout(200);
  check('Tools: Leads now marked open', (await views()) === 'Messages|Leads*', await views());
  await p3.click('.cim-tb-view:has-text("Messages")');
  check('Tools → Messages: back to Messages', (await p3.evaluate(() => window.__view)) === 'tabMessages');
  await p3.evaluate(() => chrome.storage.local.set({ noteBarPlacement: 'panel' }));
  await p3.waitForFunction(() => document.getElementById('cim-note-bar')?.classList.contains('cim-note-bar--in-panel'));
  check('row header → panel: Tools removed, toolbar + tabs back', await p3.evaluate(() => !document.getElementById('cim-tb-toggle') && !document.querySelector('.cim-tb-views') && !document.getElementById('cim-note-bar').classList.contains('cim-note-bar--row')) && await p3.locator('[data-k="automations"]').isVisible() && await p3.locator('#tabLeads').isVisible());
  const tabsAfter = [await box('#tabMessages'), await box('#tabLeads')];
  check('row header → panel: tabs exactly where Meta put them', JSON.stringify(tabsAfter) === JSON.stringify(tabsBefore), JSON.stringify([tabsBefore, tabsAfter]));
  await p3.evaluate(() => chrome.storage.local.set({ noteBarPlacement: 'header' }));
  await p3.waitForFunction(() => document.getElementById('cim-note-bar')?.parentElement === document.querySelector('.topbar'), null, { timeout: 4000 });
  check('row header ← panel: back in the row, tabs hidden again', await p3.evaluate(() => document.getElementById('cim-note-bar').nextElementSibling === document.querySelector('.tbwrap')) && !(await p3.locator('#tabLeads').isVisible()));

  // Bank transactions card under the panel (synthetic statements)
  const bankReqs = () => p3.evaluate(() => (window.__msgs || []).filter((t) => t === 'GET_BANK_TRANSACTIONS').length);
  const bankMeta = () => p3.evaluate(() => document.querySelector('#cim-bank-card .cim-bank-meta').textContent);
  const bankRows = () => p3.evaluate(() => Array.from(document.querySelectorAll('#cim-bank-card .cim-bank-row')).map((r) => (r.classList.contains('cim-bank-row--exact') ? '=' : '') + r.querySelector('.cim-bank-amt').textContent));
  const bankType = async (q) => { await p3.fill('#cim-bank-card .cim-bank-input', q); await p3.waitForTimeout(250); };
  await p3.waitForFunction(() => /PBB transactions/.test(document.querySelector('#cim-bank-card .cim-bank-meta')?.textContent || ''), null, { timeout: 4000 });
  check('bank card: right under the panel, in the sidebar', await p3.evaluate(() => document.getElementById('cim-purchase-panel').nextElementSibling === document.getElementById('cim-bank-card') && !!document.getElementById('cim-bank-card').closest('.side')) && await p3.locator('#cim-bank-card').isVisible());
  check('bank card: both banks loaded once', (await bankReqs()) === 2, String(await bankReqs()));
  const tabTxt = () => p3.evaluate(() => Array.from(document.querySelectorAll('#cim-bank-card .cim-bank-tab')).map((t) => (t.classList.contains('cim-bank-tab--on') ? '*' : '') + t.querySelector('.cim-bank-tab-name').textContent + ' ' + t.querySelector('.cim-bank-tab-time').textContent).join(' | '));
  check('bank card: PBB on, each bank shows its own update time', (await tabTxt()) === '*PBB 5:06 pm | OCBC 1 Sep · 11:40 am', await tabTxt());
  check('bank card: empty search shows the count only', (await bankMeta()).startsWith('65 PBB transactions') && (await bankRows()).length === 0, await bankMeta());
  await bankType('128');
  check('bank search "128": exact amount first, then rows containing 128', JSON.stringify(await bankRows()) === JSON.stringify(['=RM 128.00', 'RM 1,128.00', 'RM 128.50', 'RM 55.00']), JSON.stringify(await bankRows()));
  check('bank search "128": meta counts exact vs contains', (await bankMeta()) === '1 exact amount · 3 more contain “128”', await bankMeta());
  await bankType('RM 1,643.9');
  check('bank search "RM 1,643.9" finds 1,643.90', JSON.stringify(await bankRows()) === JSON.stringify(['=RM 1,643.90']), JSON.stringify(await bankRows()));
  await bankType('tan mei');
  check('bank search by name (case-blind), description cleaned', (await bankRows()).length === 1 && (await p3.evaluate(() => document.querySelector('#cim-bank-card .cim-bank-desc').textContent)) === 'TAN MEI LING · payment order');
  await bankType('F09558202601');
  check('bank search by order number in the description', JSON.stringify(await bankRows()) === JSON.stringify(['RM 1,643.90']), JSON.stringify(await bankRows()));
  await bankType('filler');
  check('bank search: at most 50 rows + "Showing 50 of 60"', (await bankRows()).length === 50 && (await p3.evaluate(() => document.querySelector('#cim-bank-card .cim-bank-more')?.textContent)) === 'Showing 50 of 60 — type more to narrow down.');
  check('bank results scroll inside the card (≤360px)', await p3.evaluate(() => document.querySelector('#cim-bank-card .cim-bank-results').getBoundingClientRect().height <= 360));
  await p3.screenshot({ path: path.join(OUT, '20-bank-filler.png') });
  await bankType('cash deposit cdm');
  check('bank search: PBB has no OCBC rows', (await bankRows()).length === 0 && (await bankMeta()).startsWith('No PBB transaction matches'));
  await p3.click('#cim-bank-card .cim-bank-tab[data-bank="ocbc"]');
  check('OCBC: same search, OCBC padded spaces matched, S$', JSON.stringify(await bankRows()) === JSON.stringify(['S$ 37.00']) && (await tabTxt()).startsWith('PBB 5:06 pm | *OCBC'), JSON.stringify(await bankRows()) + ' ' + await tabTxt());
  await bankType('128');
  check('OCBC "128": its own exact row', JSON.stringify(await bankRows()) === JSON.stringify(['=S$ 128.00']), JSON.stringify(await bankRows()));
  await p3.locator('#cim-bank-card .cim-bank-card, #cim-bank-card .cim-bank-results').first().screenshot({ path: path.join(OUT, '21-bank-ocbc.png') }).catch(() => {});
  await p3.evaluate(() => { window.__keysSeen = 0; document.addEventListener('keydown', () => window.__keysSeen++); });
  await p3.press('#cim-bank-card .cim-bank-input', 'Escape');
  check('bank search: Escape clears, key not passed to Meta', (await p3.inputValue('#cim-bank-card .cim-bank-input')) === '' && (await p3.evaluate(() => window.__keysSeen)) === 0);
  await bankType('37');
  const cardEl = await p3.evaluate(() => { window.__bankEl = document.getElementById('cim-bank-card'); return true; });
  await p3.evaluate(() => switchTo('222', 'Lim Ah Kow', 0));
  await p3.waitForFunction(() => document.querySelector('#cim-purchase-panel .cim-name')?.textContent === 'Name: Lim Ah Kow', null, { timeout: 5000 });
  await p3.waitForTimeout(500);
  check('customer switch: same card, OCBC + search kept, no reload', cardEl && await p3.evaluate(() => document.getElementById('cim-bank-card') === window.__bankEl && document.getElementById('cim-purchase-panel').nextElementSibling === window.__bankEl) && (await p3.inputValue('#cim-bank-card .cim-bank-input')) === '37' && (await bankReqs()) === 2, String(await bankReqs()));
  await p3.evaluate(() => { window.__bankFail = 'ocbc'; });
  await p3.click('#cim-bank-card .cim-bank-reload');
  await p3.waitForTimeout(400);
  check('reload: both banks re-read', (await bankReqs()) === 4, String(await bankReqs()));
  check('OCBC fails on reload: red tab, old rows kept, PBB fine', await p3.evaluate(() => document.querySelector('#cim-bank-card .cim-bank-tab[data-bank="ocbc"]').classList.contains('cim-bank-tab--error') && !document.querySelector('#cim-bank-card .cim-bank-tab[data-bank="public"]').classList.contains('cim-bank-tab--error')) && JSON.stringify(await bankRows()) === JSON.stringify(['=S$ 37.00']));
  await p3.screenshot({ path: path.join(OUT, '21-bank-ocbc.png') });
  await p3.evaluate(() => { document.querySelector('#cim-bank-card').remove(); });
  await p3.evaluate(() => document.querySelector('.msgs').append(document.createElement('span')));
  await p3.waitForTimeout(500);
  check('card dropped by a re-render: put back, no reload', await p3.evaluate(() => document.getElementById('cim-bank-card') === window.__bankEl && document.getElementById('cim-purchase-panel').nextElementSibling === window.__bankEl) && (await bankReqs()) === 4);

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(failed ? failed + ' FAILED' : 'ALL ' + results.length + ' PASS');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
