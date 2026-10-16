// Keep unanswered chats unread — UI test, no network.
// Loads inbox-unread-main.js into unread-ui-fixture.html (a stand-in inbox whose
// list rows, messages and header buttons carry fake React data shaped like
// Meta's real probes of 2026-10-15) and checks every decision and both ways of
// reaching Meta's "Mark as unread" (header button / ··· menu). It proves logic,
// not that Meta's real page matches — check a real tab after any change.
// Run: node unread-ui-test.js
const path = require('path');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const FIXTURE = 'file://' + path.join(__dirname, 'unread-ui-fixture.html') + '?selected_item_id=111';
const SCRIPT = path.join(__dirname, 'inbox-unread-main.js');
const CFG = { settleMs: 200, retryMs: 1500, maxTries: 3, menuWaitMs: 400, sendQuietMs: 1200, typeQuietMs: 1000, tickMs: 100 };
let failures = 0;
const check = (ok, label, detail) => { if (!ok) failures += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

// Message helpers: c = customer, a = automation (page, no staff name), s = staff.
const c = (id, ts, extra) => Object.assign({ id, ts, customer: true }, extra);
const a = (id, ts) => ({ id, ts });
const s = (id, ts, extra) => Object.assign({ id, ts, staff: true }, extra);
const threads = (isRead = true) => [
  { threadFBID: '111', isRead, title: 'Customer A' },
  { threadFBID: '222', isRead: true, title: 'Customer B' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];

  async function open({ list = threads(), uid = '111', msgs, header = 'wide', menuHasItem = true, disabled = false }) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(FIXTURE);
    await page.evaluate(([l, u, m, h, mi, d, cfg]) => {
      window.__fake.header = h; window.__fake.menuHasItem = mi;
      window.setThreads(l); window.setChat(u, m);
      if (d) document.documentElement.setAttribute('data-cim-keep-unread', '0');
      window.__cimUnreadCfg = cfg;
    }, [list, uid, msgs, header, menuHasItem, disabled, CFG]);
    await page.addStyleTag({ path: path.join(__dirname, 'styles.css') });
    await page.addScriptTag({ path: SCRIPT });
    return page;
  }
  const state = (page, uid = '111') => page.evaluate((u) => ({
    isRead: window.__threads.find((t) => t.threadFBID === u)?.isRead,
    actions: window.__actions.slice(),
    log: window.__cimUnread.log.map((l) => l.want + ':' + l.result),
    menus: document.querySelectorAll('.menu').length,
  }), uid);
  const wait = (page, ms) => page.waitForTimeout(ms);

  console.log('Decisions');
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200), a('m3', 300)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false && st.actions.join() === 'Mark as unread:111', 'customer message, then 2 automations → marked unread once', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), s('m2', 200), a('m3', 300)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'staff replied after the customer → left read', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [s('m0', 50), c('m1', 100, { react: true }), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'our page reacted to the customer\'s last message → left read', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [a('m1', 100), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'only automations on screen → nothing to decide, left alone');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m0', 50), s('m1', 100), c('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false, 'customer wrote again after the staff reply → marked unread');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100, { react: false }), c('m2', 150)].map((m, i) => i === 0 ? Object.assign(m, { react: true }) : m) });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false, 'reaction on an earlier message only → the newer one still waits → marked unread');
    await p.close();
  }
  {
    const p = await open({ list: threads(false), msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false && st.actions.length === 0, 'already unread → no click (never toggled back to read)', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100, { react: true, staleNoReact: true }), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'reads the CURRENT React data, not the stale copy (reaction only in the current one) → left read', JSON.stringify(st.actions));
    await p.close();
  }

  console.log('Safety');
  {
    const p = await open({ disabled: true, msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'switched off in the options → does nothing');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100, { otherUid: '999' }), a('m2', 200, {})] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.length === 0, 'messages on screen belong to another customer (mid-switch) → does nothing');
    await p.close();
  }
  {
    const p = await open({ list: [{ threadFBID: '222', isRead: true }], msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.actions.length === 0, 'open chat not in the loaded list → does nothing');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), s('m2', 200, { sending: true })] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.actions.length === 0, 'a staff message still sending → waits (never marks unread mid-send)');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await p.evaluate(() => { document.getElementById('composer').textContent = 'typing a reply…'; });
    await wait(p, 900);
    const st1 = await state(p);
    await p.evaluate(() => { document.getElementById('composer').textContent = ''; });
    await wait(p, 900);
    const st2 = await state(p);
    check(st1.isRead === true && st2.isRead === false, 'a draft in the reply box → waits; box empty again → marks unread', `${st1.isRead} → ${st2.isRead}`);
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await p.focus('#composer');
    await p.keyboard.press('Enter');
    await wait(p, 600);
    const st1 = await state(p);
    await wait(p, 1600);
    const st2 = await state(p);
    check(st1.isRead === true && st2.isRead === false, 'Enter pressed in the reply box → quiet for a while, then decides', `${st1.isRead} → ${st2.isRead}`);
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await p.focus('#composer');
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false, 'reply box merely focused (Meta does that on open) → still marks unread');
    await p.close();
  }

  console.log('Narrow header (··· menu)');
  {
    const p = await open({ header: 'narrow', msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 1200);
    const st = await state(p);
    check(st.isRead === false && st.actions.join() === 'menu-open,Mark as unread:111' && st.menus === 0, 'opens ··· and picks Mark as unread; menu closed', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ header: 'narrow', menuHasItem: false, msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 5500);
    const st = await state(p);
    const opens = st.actions.filter((x) => x === 'menu-open').length;
    check(st.isRead === true && st.menus === 0 && opens >= 1 && opens <= CFG.maxTries && !st.actions.includes('done'), `menu without the item → closes it with Escape, never clicks anything else, ≤ ${CFG.maxTries} tries`, JSON.stringify(st.actions));
    await p.close();
  }

  console.log('Over time');
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 900);
    await p.evaluate(() => { window.__threads[0].isRead = true; window.renderHead(); }); // Meta marks it read again (e.g. a new automation while open)
    await wait(p, 2200);
    const st = await state(p);
    check(st.isRead === false && st.actions.filter((x) => x.startsWith('Mark as unread')).length === 2, 'Meta flips it back to read while open → marked unread again after a pause', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    for (let i = 0; i < 5; i++) { await wait(p, 1700); await p.evaluate(() => { window.__threads[0].isRead = true; window.renderHead(); }); }
    await wait(p, 1700);
    const st = await state(p);
    const n = st.actions.filter((x) => x.startsWith('Mark as unread')).length;
    check(n >= 2 && n <= CFG.maxTries, `at most ${CFG.maxTries} clicks per visit even if Meta keeps flipping it`, `${n} clicks`);
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 900);
    const st1 = await state(p);
    await p.evaluate(() => window.setChat('111', [{ id: 'm1', ts: 100, customer: true, react: true }, { id: 'm2', ts: 200 }])); // staff reacts ❤️
    await wait(p, 1000);
    const st2 = await state(p);
    check(st1.isRead === false && st2.isRead === true && st2.actions.join() === 'Mark as unread:111,Mark as read:111', 'staff reacts ❤️ during the same visit → its own marking is undone (Mark as read)', JSON.stringify(st2.actions));
    await p.close();
  }
  {
    const p = await open({ list: threads(false), msgs: [c('m1', 100, { react: true }), a('m2', 200)] });
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === false && st.actions.length === 0, 'a chat someone marked unread by hand is never marked read by us', JSON.stringify(st.actions));
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 900);
    await p.evaluate(() => window.setChat('222', [{ id: 'x1', ts: 100, customer: true }, { id: 'x2', ts: 200, staff: true }]));
    await wait(p, 1000);
    const a1 = await state(p, '111');
    const b1 = await state(p, '222');
    check(a1.isRead === false && b1.isRead === true, 'switch to another (answered) customer → the first stays unread, the second untouched');
    await p.close();
  }
  {
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await wait(p, 900);
    await p.evaluate(() => window.setChat('111', [{ id: 'm1', ts: 100, customer: true }, { id: 'm2', ts: 200 }, { id: 'm3', ts: 300, staff: true }])); // staff replies
    await p.evaluate(() => { window.__threads[0].isRead = true; window.renderHead(); }); // Meta marks a replied chat read
    await wait(p, 1000);
    const st = await state(p);
    check(st.isRead === true && st.actions.join() === 'Mark as unread:111', 'staff replies → stays read (Meta\'s normal behaviour), no click', JSON.stringify(st.actions));
    await p.close();
  }

  console.log('PENDING rows tinted light red');
  {
    const list = [
      { threadFBID: '111', isRead: true }, { threadFBID: '222', isRead: false },
      { threadFBID: '333', isRead: true }, { threadFBID: '444', isRead: false },
    ];
    const rows = (p) => p.evaluate(() => [...document.querySelectorAll('[role="presentation"]')].map((r) => {
      const tint = getComputedStyle(r, '::after').backgroundColor;
      return (r.getAttribute('data-cim-pending') === '1' ? 'P' : '-') + (tint === 'rgba(239, 68, 68, 0.14)' ? 'red' : '');
    }));
    const p = await open({ list, uid: '111', msgs: [c('m1', 100), s('m2', 200)] }); // open chat answered
    await wait(p, 900);
    const r1 = await rows(p);
    check(JSON.stringify(r1) === JSON.stringify(['-', 'Pred', '-', 'Pred']), 'unread rows tinted light red, read rows untouched', JSON.stringify(r1));
    await p.evaluate(() => { window.__threads[2].isRead = false; window.__threads[3].isRead = true; });
    await wait(p, 2200);
    const r2 = await rows(p);
    check(r2[2] === 'Pred' && r2[3] === '-', 'read state changes → tint follows (no DOM change needed)', JSON.stringify(r2));
    await p.evaluate(() => { const t = window.__threads; [t[0], t[1]] = [t[1], t[0]]; window.setThreads(t.slice()); }); // Meta's virtual list reuses rows
    await wait(p, 900);
    const r3 = await rows(p);
    check(r3[0] === 'Pred' && r3[1] === '-', 'rows reused for other conversations → each tint follows its row', JSON.stringify(r3));
    await p.evaluate(() => document.documentElement.setAttribute('data-cim-keep-unread', '0'));
    await wait(p, 2200);
    const r4 = await rows(p);
    check(r4.every((x) => x === '-'), 'switched off → no tint');
    await p.close();
  }
  {
    // Open chat still waiting while Meta still says read → tinted at once.
    const p = await open({ msgs: [c('m1', 100), a('m2', 200)] });
    await p.evaluate(() => { window.__fake.header = 'none'; window.renderHead(); }); // no button: Meta's state stays "read"
    await wait(p, 1000);
    const t = await p.evaluate(() => document.querySelector('[role="presentation"]').getAttribute('data-cim-pending'));
    check(t === '1', 'open chat still waiting (Meta still says read) → tinted', String(t));
    await p.close();
  }

  check(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
