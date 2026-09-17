// Live-update check against EC2's semantics (read-only; clicks nothing on EC2).
//
// The overlay must SHOW what EC2 stored, never count comments. This test plays
// the server for one real customer A: new comments are added to the
// getLivingMessage polls, and EC2's win records - get_cur_wins (per product)
// and ajax_getGroups (product list with win_num) - are answered with the real
// data plus synthetic wins, following EC2's rules as verified on live 556923
// (one record per customer per product; a repeat comment UPDATES that record's
// 数量 and points it at the new comment, it does not add one):
//
//   1  "X+1" wins          -> record W qty 1                 pill +1 product, +price
//   2  "X+2" wins again    -> SAME record W, qty 2 (not 3)   same count, total +2 x price
//   3  "Y+1" fails (stock) -> comment, no win, no record     pill unchanged
//   4  System Add Y x1     -> record only, no comment        shows after a hover re-read
//
// Every step checks every row of A (old and new), the hover bubble and the
// 得标 cell. Synthetic rows/records exist only in this headless page.
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
const LIVE = '556923';
const P = require(path.join(EXT, 'ec2-live-reply-parser.js'));
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const compact = (n) => (n >= 1e3 ? 'RM ' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : 'RM ' + n.toFixed(0));
const full = (n) => 'RM ' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookieStr = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const feedRes = await fetch('https://ec2.full2house.com/Ent/index.php?a=EntLive&m=getLivingMessage', {
    method: 'POST', headers: { Cookie: cookieStr, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: `live_id=${LIVE}&lastTime=` });
  const feed = JSON.parse(await feedRes.text()).data.list;

  const dir = path.join(EXT, 'chrome-profile-tally');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in
  await opt.close();
  await ctx.addCookies(cookieStr.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  // ---- the fake server state
  const injectedComments = [];
  const injectedRecords = new Map(); // win id -> { win, psid, name, group, comment, commentId, qty }
  const hiddenWins = new Map(); // real win id -> { group, qty } that EC2 "cancelled"
  const extraWins = new Map(); // group id -> [raw get_cur_wins rows] added by a re-award

  const page = await ctx.newPage();
  const writes = [];
  const productReads = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/m=get_cur_wins/.test(u)) productReads.push(new URLSearchParams(req.postData() || '').get('group_id'));
    if (req.method() === 'POST' && /ec2\.full2house\.com/.test(u) && !/getLivingMessage|getLastGroups|get_cur_wins|getLivingMessagePaged|ajax_getGroups/.test(u)) writes.push(u);
  });
  await page.route('**/Ent/index.php?a=EntLive&m=getLivingMessage', async (route) => {
    const lastTime = new URLSearchParams(route.request().postData() || '').get('lastTime') || '';
    const fresh = injectedComments.filter((x) => lastTime && x.comment_created_time > lastTime);
    if (!fresh.length) return route.continue();
    const res = await route.fetch();
    const json = JSON.parse(await res.text());
    json.data = json.data || {};
    json.data.list = [...fresh].sort((a, b) => (a.comment_created_time < b.comment_created_time ? 1 : -1)).concat(json.data.list || []);
    return route.fulfill({ response: res, body: JSON.stringify(json) });
  });
  // get_cur_wins: add the synthetic wins of that product.
  await page.route(/m=get_cur_wins/, async (route) => {
    const group = new URLSearchParams(route.request().postData() || '').get('group_id');
    const mine = [...injectedRecords.values()].filter((x) => x.group === group);
    if (!mine.length && !hiddenWins.size && !extraWins.size) return route.continue();
    const res = await route.fetch();
    const json = JSON.parse(await res.text());
    const list = (Array.isArray(json.data) ? json.data : []).filter((w) => !hiddenWins.has(String(w.win_id))).concat(extraWins.get(group) || []);
    json.error = 0;
    json.data = mine.map((x) => ({ win_id: x.win, win_name: x.name, message: x.comment, fb_user_id: x.psid, group_id: x.group,
      style_id: '0', goods_id: '0', fb_comment_id: x.commentId, num: String(x.qty), is_baose: '0' })).concat(list);
    return route.fulfill({ response: res, body: JSON.stringify(json) });
  });
  // ajax_getGroups: a product's win_num moves with its synthetic wins, as EC2's would.
  await page.route(/m=ajax_getGroups/, async (route) => {
    if (!injectedRecords.size && !hiddenWins.size && !extraWins.size) return route.continue();
    const res = await route.fetch();
    const json = JSON.parse(await res.text());
    (json.data || []).forEach((g) => {
      const gid = String(g.group_id);
      const extra = [...injectedRecords.values()].filter((x) => x.group === gid).reduce((a, x) => a + x.qty, 0) -
        [...hiddenWins.values()].filter((x) => x.group === gid).reduce((a, x) => a + x.qty, 0) +
        (extraWins.get(gid) || []).reduce((a, w) => a + (+w.num || 0), 0);
      if (extra) g.win_num = String((parseInt(g.win_num, 10) || 0) + extra);
    });
    return route.fulfill({ response: res, body: JSON.stringify(json) });
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(22000);

  const onScreen = await page.$$eval('.ddr-tonight:not(.ddr-hide)', (els) => {
    const o = {};
    els.forEach((e) => { o[e.dataset.psid] = (o[e.dataset.psid] || 0) + 1; });
    return o;
  });
  const A = Object.entries(onScreen).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([p]) => p)[0];
  check(!!A, 'found a customer with 2+ rows on screen', A ? `${A} (${onScreen[A]} rows)` : '');
  if (!A) process.exit(1);

  const readPills = () => page.$$eval(`.ddr-tonight[data-psid="${A}"]`, (els) => els.map((el) => ({
    n: +el.querySelector('.ddr-tonight-n').textContent,
    amt: (el.querySelector('.ddr-tonight-amt') || {}).textContent || '',
    tip: JSON.parse(el.dataset.ddrTip),
  })));
  const before = await readPills();
  const n0 = before[0].n;
  const total0 = Number(String(before[0].tip.v).replace(/[^\d.]/g, ''));
  const had = new Set((before[0].tip.items || []).map((it) => it.name));

  const own = (x) => !x.fb_user_id || String(x.fb_user_id) === String(x.fb_account_id);
  const pick = (skip) => feed.find((x) => !own(x) && x.win_id && x.win_id !== '0' && P.replyNames(x.reply_message).length === 1 &&
    P.replyCode(x.reply_message) && P.replyPrice(x.reply_message) && !had.has(P.replyNames(x.reply_message)[0]) &&
    P.replyNames(x.reply_message)[0] !== skip);
  const p1 = pick();
  const X = { name: P.replyNames(p1.reply_message)[0], code: P.replyCode(p1.reply_message), price: P.replyPrice(p1.reply_message), group: String(p1.group_id), reply: p1.reply_message };
  const p2 = pick(X.name);
  const Y = { name: P.replyNames(p2.reply_message)[0], code: P.replyCode(p2.reply_message), price: P.replyPrice(p2.reply_message), group: String(p2.group_id) };
  const template = feed.find((x) => x.fb_user_id === A);
  const custName = template.fb_user_name || 'A';
  console.log(`\n  customer ${A}: ${n0} products, ${before[0].tip.v}. X = ${X.code} @ ${X.price}; Y = ${Y.code} @ ${Y.price}`);

  const comment = (seq, message, winId, reply) => ({
    ...template, fb_comment_id: `9999_test_${seq}`, message,
    comment_created_time: `2026-09-18 00:00:1${seq}`, create_time: `2026-09-18 00:00:1${seq}`,
    real_create_time: `2026-09-18 00:00:1${seq}`, last_update_time: `2026-09-18 00:00:1${seq}`,
    reply_message: reply || '', win_id: winId || '0', hit_live_win_id: winId || '0', group_id: winId ? X.group : '0',
    hit_live_group_id: winId ? X.group : '0', winnum: winId ? '1' : '0',
  });
  const waitFor = (fn, arg, ms = 35000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const allRows = (pills, n, amt) => pills.length > 0 && pills.every((p) => p.n === n && p.amt === amt);
  const summary = (pills) => `${pills.length} rows: ${[...new Set(pills.map((p) => p.n + '·' + p.amt))].join(', ')}`;
  const hoverOldRow = async () => {
    await page.evaluate((psid) => {
      const els = document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"]`);
      els[els.length - 1].closest('tr').scrollIntoView({ block: 'center' });
    }, A);
    await page.waitForTimeout(600);
    const els = await page.$$(`.ddr-tonight[data-psid="${A}"]`);
    const box = await els[els.length - 1].boundingBox();
    await page.mouse.move(box.x + box.width / 2 - 30, box.y - 20);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.waitForTimeout(700);
  };
  const bubble = () => page.evaluate(() => {
    const t = document.getElementById('ddr-tip');
    return { on: t.classList.contains('ddr-tip-on'), v: (t.querySelector('.ddr-tip-v') || {}).textContent || '' };
  });
  const wonCell = (commentId) => page.evaluate((id) => {
    // Won rows are drawn as win_tr_<win_id> with the comment id in data-index,
    // so two comments sharing a moved win have the same element id.
    const tr = document.querySelector(`tr[data-index="${id}"]`) ||
      [...document.querySelectorAll('#liveMessageDiv tbody > tr')].find((x) => x.id === 'win_tr_' + id && !x.dataset.index);
    return tr ? [...tr.querySelectorAll('.ddr-won-row')].map((row) => row.textContent.replace(/\s+/g, ' ').trim()) : null;
  }, commentId);

  // ---- 1
  console.log('\n== 1. new comment wins X ×1 ==');
  await hoverOldRow();
  const W = '99990001';
  injectedRecords.set(W, { win: W, psid: A, name: custName, group: X.group, comment: `${X.code}+1`, commentId: '9999_test_1', qty: 1 });
  injectedComments.push(comment(1, `${X.code}+1`, W, X.reply));
  await waitFor(({ psid, v }) => [...document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"]`)].every((e) => JSON.parse(e.dataset.ddrTip).v === v),
    { psid: A, v: full(total0 + X.price) });
  await page.waitForTimeout(1500);
  let pills = await readPills();
  check(allRows(pills, n0 + 1, compact(total0 + X.price)), `every row of A: ${n0 + 1} · ${compact(total0 + X.price)}`, summary(pills));
  let line = (pills[0].tip.items || []).find((it) => it.name === X.name);
  check(line && line.qty === 1 && line.amount === full(X.price), `hover line: ${X.code} ×1 ${full(X.price)}`, line ? `${line.code} ×${line.qty} ${line.amount}` : 'missing');
  const b1 = await bubble();
  check(b1.on && b1.v === full(total0 + X.price), 'bubble already open on an old row shows the new EC2 total', b1.v);
  const c1 = (await wonCell('9999_test_1')) || [];
  check(c1.some((t) => t.startsWith(X.code) && t.endsWith('×1')), '得标 cell of the new comment: X ×1', JSON.stringify(c1));

  // ---- 2
  console.log('\n== 2. X again: EC2 updates the same record to X = 2 ==');
  injectedRecords.set(W, { ...injectedRecords.get(W), comment: `${X.code}+2`, commentId: '9999_test_2', qty: 2 });
  injectedComments.push(comment(2, `${X.code}+2`, W, X.reply));
  await waitFor(({ psid, v }) => [...document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"]`)].every((e) => JSON.parse(e.dataset.ddrTip).v === v),
    { psid: A, v: full(total0 + 2 * X.price) });
  await page.waitForTimeout(1500);
  pills = await readPills();
  check(allRows(pills, n0 + 1, compact(total0 + 2 * X.price)), `every row: still ${n0 + 1} products, total +2 × price (${compact(total0 + 2 * X.price)}), not +3 ×`, summary(pills));
  line = (pills[0].tip.items || []).find((it) => it.name === X.name);
  check(line && line.qty === 2 && line.amount === full(2 * X.price), `hover line: ${X.code} ×2 ${full(2 * X.price)} (EC2's 数量, not 1+2)`, line ? `×${line.qty} ${line.amount}` : 'missing');
  const c2 = (await wonCell('9999_test_2')) || [];
  const c1b = (await wonCell('9999_test_1')) || [];
  check(c2.some((t) => t.startsWith(X.code) && t.endsWith('×2')) && !c1b.length, '得标 cell: X ×2 on the new comment, nothing on the old one (record now belongs to the new comment)',
    `new ${JSON.stringify(c2)} · old ${JSON.stringify(c1b)}`);

  // ---- 3
  console.log('\n== 3. Y+1 fails on stock: comment only ==');
  await page.waitForTimeout(11000); // let step 2's +10 s follow-up read finish first
  const reads3 = productReads.length;
  injectedComments.push(comment(3, `${Y.code}+1`));
  await page.waitForFunction(() => !!document.getElementById('win_tr_9999_test_3'), null, { timeout: 20000 }).catch(() => {});
  // Stay under the 30 s product check so only the comment itself could cause a read.
  await page.waitForTimeout(12000);
  pills = await readPills();
  check(allRows(pills, n0 + 1, compact(total0 + 2 * X.price)) && !(pills[0].tip.items || []).some((it) => it.name === Y.name),
    'pill and hover unchanged - a comment without an EC2 record is not counted', summary(pills));
  const yReads = productReads.slice(reads3).filter((g) => g === Y.group).length;
  check(yReads === 0, `the failed ${Y.code} comment triggers no read of ${Y.code}`,
    `${yReads} reads of ${Y.code} · other product reads in the window: ${productReads.length - reads3 - yReads} (30 s check of products EC2 changed)`);

  // ---- 4
  console.log('\n== 4. System Add: Y ×1 recorded, no comment ==');
  injectedRecords.set('99990002', { win: '99990002', psid: A, name: custName, group: Y.group, comment: `${Y.code}+1(System Add)`, commentId: '', qty: 1 });
  await page.mouse.move(5, 5);
  // No comment carries it: the 30 s product-list check sees Y's win_num move and re-reads Y.
  const ok4 = await waitFor(({ psid, n }) => [...document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"] .ddr-tonight-n`)].every((e) => +e.textContent === n),
    { psid: A, n: n0 + 2 }, 45000);
  await hoverOldRow();
  await page.waitForTimeout(800);
  pills = await readPills();
  line = (pills[0].tip.items || []).find((it) => it.name === Y.name);
  check(ok4 && allRows(pills, n0 + 2, compact(total0 + 2 * X.price + Y.price)) && line && line.qty === 1,
    'within one 30 s product check, the System Add win shows on every row', `${summary(pills)} · ${line ? line.code + ' ×' + line.qty : 'Y missing'}`);
  const b4 = await bubble();
  check(b4.on && b4.v === full(total0 + 2 * X.price + Y.price), 'the open bubble shows it too', b4.v);

  // ---- 5: admin cancels one of A's REAL wins on this page (quiet live: no new comments)
  console.log('\n== 5. 取消得标 on this page, no new comments ==');
  const target = await page.evaluate((psid) => {
    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr')].filter((tr) => tr.querySelector(`.ddr-tonight[data-psid="${psid}"]`) && tr.querySelector('td:nth-child(4) .cancelWin'));
    const tr = rows[rows.length - 1];
    if (!tr) return null;
    return { key: tr.dataset.index || tr.id.replace('win_tr_', ''), comment: tr.querySelector('.cancelWin').getAttribute('data-comment').trim() };
  }, A);
  const feedRow = target && feed.find((x) => String(x.fb_comment_id) === target.comment && x.win_id && x.win_id !== '0');
  check(!!feedRow, 'picked one of A\'s real won comments', feedRow ? `${feedRow.message.replace(/<[^>]+>/g, '')} (win ${feedRow.win_id})` : '');
  if (feedRow) {
    const cancelled = { group: String(feedRow.group_id), qty: 0 };
    // what EC2 stored for it, so the expected numbers come from EC2, not the comment
    const stored = await (await fetch('https://ec2.full2house.com/Ent/index.php?a=EntLive&m=get_cur_wins', { method: 'POST',
      headers: { Cookie: cookieStr, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: `group_id=${feedRow.group_id}&lastWinId=0` })).json();
    const rec = (stored.data || []).find((w) => String(w.win_id) === String(feedRow.win_id));
    cancelled.qty = rec ? +rec.num : 0;
    const beforeCancel = await readPills();
    const tipBefore = beforeCancel[0].tip;
    const cancelledLine = (tipBefore.items || []).find((it) => it.qty >= cancelled.qty && (tipBefore.items || []).length);
    await hoverOldRow();
    const reads5 = productReads.length;
    // EC2's side: the win is gone from its records ...
    hiddenWins.set(String(feedRow.win_id), cancelled);
    // ... and living.js's own DOM change after a successful 取消 (no reload):
    const t5 = Date.now();
    await page.evaluate(({ comment }) => {
      const a = [...document.querySelectorAll('#liveMessageDiv .cancelWin')].find((x) => x.getAttribute('data-comment').trim() === comment);
      const tr = a.closest('tr');
      tr.id = 'win_tr_' + comment;
      a.parentNode.innerHTML = '<a class="blue okWin" href="javascript:;" data-index="' + comment + '">得标</a>';
    }, target);
    const moved = await waitFor(({ psid, v }) => [...document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"]`)].every((e) => JSON.parse(e.dataset.ddrTip).v !== v),
      { psid: A, v: tipBefore.v }, 25000);
    const secs = ((Date.now() - t5) / 1000).toFixed(1);
    await page.waitForTimeout(800);
    const afterCancel = await readPills();
    const reread = productReads.slice(reads5).includes(cancelled.group);
    check(moved && reread && Number(secs) < 10, `every row updates in ${secs} s (well before the 30 s check), from a re-read of that product`,
      `${summary(beforeCancel)} -> ${summary(afterCancel)}`);
    const b5 = await bubble();
    check(b5.on && b5.v === afterCancel[0].tip.v, 'the open hover bubble shows the new total too', `${tipBefore.v} -> ${b5.v}`);

    // ---- 6: admin re-awards it (EC2 gives a NEW win id) - on this page that reloads the page
    console.log('\n== 6. re-award on this page: EC2 reloads the page, new win id ==');
    hiddenWins.delete(String(feedRow.win_id));
    const reissued = { ...rec, win_id: '99990077' };
    // the original id stays gone; the same win comes back under the new id
    hiddenWins.set(String(feedRow.win_id), { group: cancelled.group, qty: 0 });
    extraWins.set(cancelled.group, [reissued]);
    const t6 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ddr-card', { timeout: 60000 });
    const back = await waitFor(({ psid, v }) => {
      const els = [...document.querySelectorAll(`.ddr-tonight[data-psid="${psid}"]`)];
      return els.length && els.every((e) => JSON.parse(e.dataset.ddrTip || '{}').v === v);
    }, { psid: A, v: tipBefore.v }, 60000);
    check(back, `after the reload every row is back to ${tipBefore.v} (${((Date.now() - t6) / 1000).toFixed(1)} s incl. page load)`);
    hiddenWins.clear();
    extraWins.clear();
  }

  // A real scroll by the operator still closes the bubble.
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(700);
  check(!(await bubble()).on, 'scrolling the list with the wheel closes the bubble');

  await page.mouse.move(0, 0);
  check(writes.length === 0, 'no EC2 write requests', writes.slice(0, 2).join(' | '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
  await ctx.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
