// 💬 private reply check on a real EC2 live page (read-only for EC2).
// The worker is NEVER reached: every request to messenger-gatekeeper is answered
// by a Playwright route (ok / already_replied), and the token is a fake one, so
// even an unrouted request would be refused (401) - no customer gets anything.
// Checks: one 💬 per customer row and none on our posts, row height unchanged
// (line 2 doesn't wrap), the popup (name, 中文/English, {name} filled, on
// screen), the request (clicked row's comment first, ≤10 ids, the text), ✓ on
// every row of that customer + saved per live, error text, wording changes from
// Options reach an open popup, Escape, the name cell still opens Messenger
// history, 0 EC2 writes, 0 page errors.
// Env: TONIGHT (live id, default 562594), WHO (customer name to click, `*` = the
// customer with the most rows, default the first customer row), VW/VH.
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const EXT = __dirname;
const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const VW = +(process.env.VW || 1440);
const VH = +(process.env.VH || 900);
const LIVE = process.env.TONIGHT || '562594';
const WHO = process.env.WHO || '';
const WORKER = 'https://messenger-gatekeeper.stanlee19941218.workers.dev';
const TEMPLATES = [
  { zh: '【测试】您好 {name}！这是第一条', en: '[Test] Hi {name}! This is the first one' },
  { zh: '第二条 只有中文 https://ddherbs.com.my/cart/{psid}', en: '' },
];
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookieStr = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const dir = path.join(EXT, 'chrome-profile-reply');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: VW, height: VH } });

  // Every worker call is answered here. `mode` picks the answer.
  const workerCalls = [];
  let mode = 'ok';
  await ctx.route(WORKER + '/**', async (route) => {
    const req = route.request();
    const body = req.postDataJSON ? req.postDataJSON() : null;
    workerCalls.push({ url: req.url(), auth: req.headers().authorization, body });
    if (!/\/private-reply$/.test(req.url())) return route.fulfill({ status: 404, body: '{}' });
    const out = mode === 'ok'
      ? { ok: true, comment_id: body.comment_ids[0], recipient_id: '1', tried: 1 }
      : { ok: false, error: 'already_replied', tried: body.comment_ids.length };
    await new Promise((res) => setTimeout(res, 300));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((t) => new Promise((res) => chrome.storage.local.set({ ...t.cfg, ec2LiveEnabled: true, analysisApiToken: 'playwright-fake-token', liveReplyTemplates: t.templates }, res)),
    { templates: TEMPLATES, cfg: { baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' } });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); });

  await ctx.addCookies(cookieStr.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));
  const page = await ctx.newPage();
  const posts = [];
  page.on('request', (req) => { if (req.method() === 'POST' && /ec2\.full2house\.com/.test(req.url()) && !/getLivingMessage|getWinLists|liveGoods|getGroup|getLastGroups|get_cur_wins|ajax_getGroups/i.test(req.url())) posts.push(req.url() + ' ' + (req.postData() || '').slice(0, 80)); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForSelector('.ddr-card .ddr-pr', { timeout: 90000 }); }
  catch (e) {
    console.log('no 💬 after 90 s:', JSON.stringify(await page.evaluate(() => ({ url: location.href, rows: document.querySelectorAll('#liveMessageDiv tbody > tr').length, cards: document.querySelectorAll('.ddr-card').length, pr: document.querySelectorAll('.ddr-pr').length, title: document.title }))), 'errors:', errs.join(' | '));
    throw e;
  }
  await page.waitForTimeout(6000);

  console.log(`\n== rows (${VW}×${VH}, live ${LIVE}) ==`);
  const rows = await page.evaluate(() => {
    const trs = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_"]')].filter((tr) => tr.offsetParent);
    const cust = trs.filter((tr) => tr.querySelector('.ddr-card'));
    const own = trs.filter((tr) => tr.classList.contains('ddr-own'));
    const h = () => cust.map((tr) => tr.getBoundingClientRect().height);
    const r2 = () => cust.map((tr) => tr.querySelector('.ddr-r2').getBoundingClientRect().height);
    const withH = h(), withR2 = r2();
    document.documentElement.classList.add('ddr-test-no-pr');
    const st = document.createElement('style');
    st.textContent = 'html.ddr-test-no-pr .ddr-pr { display: none !important; }';
    document.head.appendChild(st);
    const noH = h(), noR2 = r2();
    st.remove();
    document.documentElement.classList.remove('ddr-test-no-pr');
    const grew = withH.filter((v, i) => v > noH[i] + 0.5).length;
    const r2grew = withR2.filter((v, i) => v > noR2[i] + 0.5).length;
    return {
      cust: cust.length,
      withOne: cust.filter((tr) => tr.querySelectorAll('.ddr-pr').length === 1).length,
      ownWith: own.filter((tr) => tr.querySelector('.ddr-pr')).length,
      own: own.length, grew, r2grew,
      maxGrow: Math.max(0, ...withH.map((v, i) => Math.round((v - noH[i]) * 10) / 10)),
      at62: noH.filter((v) => Math.round(v) === 62).length,
    };
  });
  check(rows.cust > 0 && rows.withOne === rows.cust, 'every customer row has one 💬', `${rows.withOne}/${rows.cust}`);
  check(rows.ownWith === 0, 'our own posts have none', `${rows.own} own rows`);
  check(rows.r2grew === 0, 'line 2 is no taller with the 💬', `${rows.r2grew} grew`);
  check(rows.grew === 0, 'no row is taller with the 💬', `${rows.grew} of ${rows.cust} grew, max +${rows.maxGrow}px (${rows.at62} rows are 62px without it)`);

  // The customer to click: WHO by name, else the first customer row.
  const target = await page.evaluate((who) => {
    const ORDER = /[A-Za-z]+\d+\s*[+＋]\s*\d+/;
    const isOrder = (t) => ORDER.test((t.querySelectorAll('td')[1] || {}).textContent || '');
    // Customers with at least one comment that is not an order (only those can be sent to).
    const okPsids = new Set([...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_"]')].filter((t) => t.querySelector('.ddr-card') && !isOrder(t)).map((t) => t.querySelector('.ddr-pr').dataset.psid));
    const trs = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_"]')].filter((tr) => tr.querySelector('.ddr-card') && okPsids.has(tr.querySelector('.ddr-pr').dataset.psid));
    // WHO=* : the customer with the most comment rows (exercises the comment order).
    const count = (t) => document.querySelectorAll(`.ddr-pr[data-psid="${t.querySelector('.ddr-pr').dataset.psid}"]`).length;
    const most = () => trs.reduce((a, t) => (count(t) > count(a) ? t : a), trs[0]);
    const tr = (who === '*' ? most() : who && trs.find((t) => (t.querySelector('.ddr-name') || {}).textContent === who)) || trs[0];
    tr.scrollIntoView({ block: 'center' });
    const btn = tr.querySelector('.ddr-pr');
    btn.setAttribute('data-test-target', '1');
    // An order-only customer for the "can't send" check.
    const all = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_"]')].filter((t) => t.querySelector('.ddr-card'));
    const orderOnly = all.find((t) => !okPsids.has(t.querySelector('.ddr-pr').dataset.psid));
    if (orderOnly) orderOnly.querySelector('.ddr-pr').setAttribute('data-test-order-only', '1');
    return { psid: btn.dataset.psid, name: tr.querySelector('.ddr-name').textContent, key: tr.dataset.index || tr.id.replace(/^win_s?tr_/, ''), keyIsOrder: isOrder(tr), rowsOfCustomer: document.querySelectorAll(`.ddr-pr[data-psid="${btn.dataset.psid}"]`).length, orderOnly: orderOnly && orderOnly.querySelector('.ddr-name').textContent };
  }, WHO);
  console.log(`  target: ${target.name} (${target.rowsOfCustomer} rows)`);
  const logIds = (c) => c && console.log('    ids sent:', c.body.comment_ids.length, c.body.comment_ids.slice(0, 3).join(', '));

  console.log('\n== popup ==');
  const chatOpen = () => page.evaluate(() => { const o = document.querySelector('.ddr-chat-overlay'); return !!(o && !o.hidden && getComputedStyle(o).display !== 'none'); });
  await page.click('[data-test-target]');
  await page.waitForTimeout(300);
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.ddr-pr-pop');
    const r = el.getBoundingClientRect();
    return {
      shown: !el.hidden, title: el.querySelector('.ddr-pr-title').textContent,
      lang: (el.querySelector('[data-lang][aria-pressed="true"]') || {}).dataset?.lang,
      items: [...el.querySelectorAll('.ddr-pr-item')].map((b) => b.textContent),
      inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      focus: document.activeElement && document.activeElement.classList.contains('ddr-pr-item'),
    };
  });
  check(pop.shown && pop.title.includes(target.name), 'opens with the customer name', pop.title);
  check(pop.inView, 'popup inside the window');
  check(pop.focus, 'first message focused');
  check(!(await chatOpen()), 'the 💬 click does not open Messenger history');
  const want = (lang) => TEMPLATES.map((t) => t[lang].replace('{name}', target.name).replace('{psid}', target.psid)).filter(Boolean);
  check(JSON.stringify(pop.items) === JSON.stringify(want(pop.lang)), `messages in ${pop.lang} with {name} filled`, JSON.stringify(pop.items));
  const other = pop.lang === 'zh' ? 'en' : 'zh';
  await page.click(`.ddr-pr-pop [data-lang="${other}"]`);
  const items2 = await page.$$eval('.ddr-pr-pop .ddr-pr-item', (b) => b.map((x) => x.textContent));
  check(JSON.stringify(items2) === JSON.stringify(want(other)), `toggle → ${other}, blank ones skipped`, JSON.stringify(items2));
  await page.screenshot({ path: path.join(EXT, `reply-popup-${VW}.png`) });

  console.log('\n== wording changed in Options while open ==');
  const NEW = [{ zh: '新的 {name}', en: 'New {name}' }];
  await opt.evaluate((t) => new Promise((res) => chrome.storage.local.set({ liveReplyTemplates: t }, res)), NEW);
  await page.waitForTimeout(300);
  const items3 = await page.$$eval('.ddr-pr-pop .ddr-pr-item', (b) => b.map((x) => x.textContent));
  check(JSON.stringify(items3) === JSON.stringify([NEW[0][other].replace('{name}', target.name)]), 'open popup shows the new wording', JSON.stringify(items3));

  console.log('\n== send (worker answer mocked: ok) ==');
  mode = 'ok';
  const before = workerCalls.length;
  await page.click('.ddr-pr-pop .ddr-pr-item');
  await page.waitForTimeout(150);
  const busy = await page.evaluate(() => ({ st: document.querySelector('.ddr-pr-status').textContent, dis: [...document.querySelectorAll('.ddr-pr-item')].every((b) => b.disabled) }));
  check(busy.st === 'Sending…' && busy.dis, 'shows Sending… and disables the messages');
  await page.waitForTimeout(900);
  const call = workerCalls.slice(before).find((c) => /private-reply/.test(c.url));
  logIds(call);
  check(!!call, 'one call to the worker', `${workerCalls.length - before}`);
  if (call) {
    check(call.auth === 'Bearer playwright-fake-token', 'with the Options token');
    check(target.keyIsOrder ? !call.body.comment_ids.includes(target.key) : call.body.comment_ids[0] === target.key, target.keyIsOrder ? 'clicked row is an order - not sent to it' : 'clicked row\'s comment first', `${call.body.comment_ids[0]} vs ${target.key}`);
    const orderIds = await page.evaluate((ids) => ids.filter((id) => { const tr = document.getElementById('win_tr_' + id) || document.querySelector(`tr[data-index="${id}"]`); return tr && /[A-Za-z]+\d+\s*[+＋]\s*\d+/.test((tr.querySelectorAll('td')[1] || {}).textContent || ''); }), call.body.comment_ids);
    check(orderIds.length === 0, 'no order comment (A2+3) among the ids sent', orderIds.join(', '));
    check(call.body.comment_ids.length >= 1 && call.body.comment_ids.length <= 10 && call.body.comment_ids.every((id) => /^\d+_\d+$/.test(id)), '1-10 comment ids', String(call.body.comment_ids.length));
    check(call.body.text === NEW[0][other].replace('{name}', target.name), 'text = the message shown', call.body.text);
  }
  const after = await page.evaluate((psid) => ({
    st: document.querySelector('.ddr-pr-status').textContent,
    sent: [...document.querySelectorAll(`.ddr-pr[data-psid="${psid}"]`)].every((b) => b.classList.contains('ddr-pr-sent')),
    n: document.querySelectorAll(`.ddr-pr[data-psid="${psid}"]`).length,
    others: document.querySelectorAll('.ddr-pr.ddr-pr-sent').length,
  }), target.psid);
  check(after.st.startsWith('✓ Sent'), 'shows ✓ Sent', after.st);
  check(after.sent && after.others === after.n, `✓ on every row of that customer only (${after.n})`);
  const saved = await opt.evaluate((k) => new Promise((res) => chrome.storage.local.get(k, (v) => res(v[k]))), `liveReply:${LIVE}`);
  check(saved && saved[target.psid] && saved[target.psid].length === 1, 'saved for this live');
  await page.waitForTimeout(1700);
  check(await page.evaluate(() => document.querySelector('.ddr-pr-pop').hidden), 'closes itself after a send');

  console.log('\n== second send: used comment left out; worker says already replied ==');
  mode = 'already';
  const b2 = workerCalls.length;
  await page.click('[data-test-target]');
  await page.waitForTimeout(200);
  const sentList = await page.$eval('.ddr-pr-pop .ddr-pr-sent-list', (e) => e.textContent);
  check(/Sent tonight \(1\)/.test(sentList), 'popup lists what was sent', sentList.slice(0, 60));
  const hasItem = await page.$('.ddr-pr-pop .ddr-pr-item:not([disabled])');
  if (!hasItem) {
    // No comment left: said up front, messages disabled, nothing sent.
    const st0 = await page.$eval('.ddr-pr-status', (e) => e.textContent);
    check(/already has a reply|only order comments/.test(st0) && !!(await page.$('.ddr-pr-pop .ddr-pr-item[disabled]')), 'no comment left → said when the popup opens, messages disabled', st0.slice(0, 70));
    check(workerCalls.length === b2, 'no worker call');
  } else {
    await page.click('.ddr-pr-pop .ddr-pr-item');
    await page.waitForTimeout(1200);
    const c2 = workerCalls.slice(b2).find((c) => /private-reply/.test(c.url));
    const st2 = await page.$eval('.ddr-pr-status', (e) => e.textContent);
    logIds(c2);
    if (c2) {
      check(call && !c2.body.comment_ids.includes(call.body.comment_ids[0]), 'the comment already used is not sent again');
      check(/already has a reply/.test(st2), 'already_replied → plain message', st2);
    } else {
      check(/already has a reply/.test(st2), 'no comment left → message without calling the worker', st2);
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(await page.evaluate(() => document.querySelector('.ddr-pr-pop').hidden), 'Escape closes');

  console.log('\n== order-only customer: nothing to send to ==');
  if (target.orderOnly) {
    const b3 = workerCalls.length;
    await page.evaluate(() => document.querySelector('[data-test-order-only]').scrollIntoView({ block: 'center' }));
    await page.click('[data-test-order-only]');
    await page.waitForTimeout(300);
    const oo = await page.evaluate(() => ({
      st: document.querySelector('.ddr-pr-status').textContent,
      dis: [...document.querySelectorAll('.ddr-pr-item')].every((b) => b.disabled),
      n: document.querySelectorAll('.ddr-pr-item').length,
    }));
    check(/only order comments/.test(oo.st), `says only order comments (${target.orderOnly})`, oo.st.slice(0, 70));
    check(oo.n > 0 && oo.dis, 'messages shown but disabled');
    await page.evaluate(() => document.querySelector('.ddr-pr-item') && document.querySelector('.ddr-pr-item').click());
    await page.waitForTimeout(400);
    check(workerCalls.length === b3, 'no worker call');
    await page.keyboard.press('Escape');
  } else console.log('  (no order-only customer on screen)');

  console.log('\n== name cell still opens Messenger history ==');
  await page.evaluate(() => {
    const tr = document.querySelector('[data-test-target]').closest('tr');
    tr.querySelector('.ddr-name').click();
  });
  await page.waitForTimeout(500);
  check(await chatOpen(), 'name click opens the chat modal');
  await page.keyboard.press('Escape');

  console.log('\n== safety ==');
  check(posts.length === 0, '0 EC2 writes', posts.join(' | '));
  check(errs.length === 0, '0 page errors', errs.join(' | '));
  const unrouted = workerCalls.filter((c) => !c.url.startsWith(WORKER));
  check(unrouted.length === 0, 'every worker call was answered by the test');

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failures ? 'FAILED ' + failures : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
