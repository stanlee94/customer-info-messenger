// Source-of-truth check (read-only): every "won" number the overlay shows must
// equal EC2's 得标结果 records (a=EntLive&m=liveAllWin), read here independently
// with a regex parser (not the overlay's DOMParser code).
//
//   tonight   🛒 count = distinct products, amount = sum of 小计, tooltip lines =
//             each product's 数量 / 小计; customers with no record show no pill
//   得标 cell  items = the records of that customer whose comment time is the row's
//   batch     (BATCH=1) blue chip products/units/amount per ticked live = that
//             live's records
// 弃标 records are excluded everywhere. Never clicks anything on EC2.
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
const TONIGHT = process.env.TONIGHT || '556923';
const LIVES = JSON.parse(process.env.LIVES || '{"556369":"11-09-2026","556208":"10-09-2026"}');
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const compact = (n) => (n >= 1e6 ? 'RM ' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : n >= 1e3 ? 'RM ' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : 'RM ' + n.toFixed(0));
const full = (n) => 'RM ' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function winRecords(cookie, liveId) {
  const get = async (p) => (await fetch(`https://ec2.full2house.com/Ent/index.php?live_id=${liveId}&a=EntLive&m=liveAllWin${p > 1 ? '&page=' + p : ''}`,
    { headers: { Cookie: cookie, 'User-Agent': UA } })).text();
  const parse = (html) => {
    const body = (html.match(/<table[^>]*id="sample_3"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1])))
      .filter((r) => r.length >= 12)
      .map((r) => ({ win: r[1], psid: r[3], product: r[4], comment: r[6], qty: +r[9], sub: +r[10].replace(/[^\d.]/g, ''), status: r[11] }));
  };
  const first = await get(1);
  const last = Math.max(1, ...[...first.matchAll(/[?&]page=(\d+)/g)].map((m) => +m[1]));
  let all = parse(first);
  for (let p = 2; p <= last; p += 1) all = all.concat(parse(await get(p)));
  const byWin = new Map(all.map((r) => [r.win, r]));
  const totals = { price: (first.match(/totalPrice[^>]*>([^<]*)/) || [])[1], nums: (first.match(/totalNums[^>]*>([^<]*)/) || [])[1] };
  return { records: [...byWin.values()], pages: last, totals };
}

/** psid -> Map(product -> {qty, sub}) without 弃标 */
function truthByPsid(records) {
  const by = new Map();
  records.filter((r) => !r.status.includes('弃标')).forEach((r) => {
    const b = by.get(r.psid) || new Map();
    const cur = b.get(r.product) || { qty: 0, sub: 0 };
    cur.qty += r.qty;
    cur.sub = Math.round((cur.sub + r.sub) * 100) / 100;
    b.set(r.product, cur);
    by.set(r.psid, b);
  });
  return by;
}

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookieStr = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');

  const dir = path.join(EXT, 'chrome-profile-truth');
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
  await ctx.addCookies(cookieStr.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const allWinGets = [];
  const productReads = [];
  const groupLists = [];
  const writes = [];
  const errs = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/m=liveAllWin/.test(u)) allWinGets.push(u);
    if (/m=get_cur_wins/.test(u)) productReads.push(u);
    if (/m=ajax_getGroups/.test(u)) groupLists.push(u);
    if (req.method() === 'POST' && /ec2\.full2house\.com/.test(u) && !/getLivingMessage|getLastGroups|get_cur_wins|getLivingMessagePaged|ajax_getGroups/.test(u)) writes.push(u);
  });
  page.on('pageerror', (e) => errs.push(e.message));
  // Products whose win_num moved between two of the page's own product polls
  // (every 5 s): reading those is the overlay doing its job on a live that is
  // selling, not a burst - see the full-feed re-read check.
  const changedGroups = new Set();
  let lastWinNums = null;
  page.on('response', async (res) => {
    if (!/m=ajax_getGroups/.test(res.url())) return;
    try {
      const now = new Map((JSON.parse(await res.text()).data || []).map((g) => [String(g.group_id), String(g.win_num)]));
      if (lastWinNums) now.forEach((n, id) => { if (lastWinNums.get(id) !== n) changedGroups.add(id); });
      lastWinNums = now;
    } catch (e) { /* not JSON */ }
  });
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${TONIGHT}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(20000);

  // Truth read AFTER the page loaded its copy, so a win landing in between can only make the page look older.
  // The live can still change (replay orders): read until two reads agree.
  let tonight = await winRecords(cookieStr, TONIGHT);
  for (let i = 0; i < 4; i += 1) {
    const again = await winRecords(cookieStr, TONIGHT);
    const same = JSON.stringify(again.records.map((x) => [x.win, x.qty, x.sub, x.status]).sort()) === JSON.stringify(tonight.records.map((x) => [x.win, x.qty, x.sub, x.status]).sort());
    tonight = again;
    if (same) break;
  }
  const truth = truthByPsid(tonight.records);
  console.log(`\n== tonight ${TONIGHT}: ${tonight.records.length} records on ${tonight.pages} pages (EC2 prints ${tonight.totals.price} / ${tonight.totals.nums}) ==`);
  const sumSub = tonight.records.reduce((a, x) => a + x.sub, 0);
  check(full(sumSub).replace(/,/g, '') === String(tonight.totals.price).replace(/\s+/g, ' ').replace(/,/g, '').trim(), 'independent parse sums to EC2\'s printed total', full(sumSub));
  const unfiltered = allWinGets.filter((u) => !/ordered=4/.test(u)).length;
  check(unfiltered === 0 && allWinGets.length <= 2 && productReads.length <= 40,
    'page load: products + per-product wins, no full 得标结果 read',
    `${groupLists.length} product lists · ${productReads.length} product win reads · ${allWinGets.length} 弃标-only page(s) · ${unfiltered} full 得标结果 pages (was ${tonight.pages})`);

  const pills = await page.$$eval('.ddr-tonight', (els) => els.map((el) => ({
    psid: el.dataset.psid, hidden: el.classList.contains('ddr-hide'),
    n: +el.querySelector('.ddr-tonight-n').textContent, amt: (el.querySelector('.ddr-tonight-amt') || {}).textContent || '',
    tip: JSON.parse(el.dataset.ddrTip || '{}'),
  })));
  const seen = new Set();
  let ok = 0; const bad = [];
  pills.forEach((p) => {
    if (seen.has(p.psid)) return;
    seen.add(p.psid);
    const t = truth.get(p.psid);
    if (!t) { if (p.hidden) ok += 1; else bad.push(`${p.psid} shows ${p.n} but has no EC2 record`); return; }
    const total = [...t.values()].reduce((a, x) => a + x.sub, 0);
    const lines = new Map((p.tip.items || []).map((it) => [it.name, it]));
    const linesOk = [...t].every(([name, x]) => lines.has(name) && lines.get(name).qty === x.qty && lines.get(name).amount === full(x.sub)) && lines.size === t.size;
    if (!p.hidden && p.n === t.size && p.amt === compact(total) && p.tip.v === full(total) && linesOk) ok += 1;
    else bad.push(`${p.psid} page ${p.n}·${p.amt}·${p.tip.v} lines ${lines.size} vs EC2 ${t.size}·${compact(total)}·${full(total)}${linesOk ? '' : ' (line qty/小计 differ)'}`);
  });
  check(bad.length === 0, 'every customer on screen: 🛒 count, amount and every hover line = EC2 records', `${ok}/${seen.size} customers`);
  bad.slice(0, 6).forEach((b) => console.log('       ', b));
  const withFoot = pills.filter((p) => !p.hidden).every((p) => /EC2's win records/.test(p.tip.foot || ''));
  check(withFoot, 'hover says where the numbers come from');

  // 得标 cells: rows showing won items vs records with that customer + comment time.
  const feedRes = await fetch('https://ec2.full2house.com/Ent/index.php?a=EntLive&m=getLivingMessage', {
    method: 'POST', headers: { Cookie: cookieStr, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: `live_id=${TONIGHT}&lastTime=` });
  const feed = JSON.parse(await feedRes.text()).data.list;
  const byComment = new Map(feed.map((x) => [String(x.fb_comment_id), x]));
  const cells = await page.$$eval('#liveMessageDiv tbody > tr[id^="win_tr_"]', (trs) => trs.map((tr) => ({
    key: tr.dataset.index || tr.id.replace('win_tr_', ''),
    won: !!tr.querySelector('td:nth-child(4) .cancelWin'),
    items: [...tr.querySelectorAll('.ddr-won-row')].map((row) => JSON.parse(row.dataset.ddrTip)),
  })));
  let cellOk = 0; let cellChecked = 0; const cellBad = [];
  cells.forEach((c) => {
    const x = byComment.get(c.key);
    if (!x || !x.fb_user_id) return;
    const recs = tonight.records.filter((rr) => !rr.status.includes('弃标') && rr.psid === String(x.fb_user_id) && rr.comment.endsWith(x.comment_created_time));
    if (!recs.length && !c.items.length) return;
    cellChecked += 1;
    const want = recs.map((rr) => `${rr.product}×${rr.qty}`).sort().join(' | ');
    const got = c.items.map((it) => `${it.h}${(it.rows.find((q) => q[0] === 'Quantity') || [])[1]}`).sort().join(' | ');
    if (want === got) cellOk += 1; else cellBad.push(`${c.key}: page [${got}] EC2 [${want}]`);
  });
  check(cellBad.length === 0, '得标 cell items = the records of that comment', `${cellOk}/${cellChecked} rows`);
  cellBad.slice(0, 5).forEach((b) => console.log('       ', b));

  // Force the orphan-win full re-read (fake, never-clicked .cancelWin on a row
  // with no win, as in ec2-live-winfix-test.js): re-delivered OLD wins must not
  // queue a read per customer.
  const feedGets = [];
  page.on('request', (req) => { if (/getLivingMessage/.test(req.url()) && /lastTime=$/.test(req.postData() || '')) feedGets.push(Date.now()); });
  const before = allWinGets.length;
  const beforeProducts = productReads.length;
  const readGroups = [];
  const onRead = (req) => { if (/m=get_cur_wins/.test(req.url())) readGroups.push(new URLSearchParams(req.postData() || '').get('group_id')); };
  page.on('request', onRead);
  changedGroups.clear();
  const planted = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')]
      .find((row) => row.querySelector('td:nth-child(4) .okWin') && !row.querySelector('td:nth-child(4) .cancelWin') && row.querySelector('.ddr-card'));
    if (!tr) return false;
    const a = document.createElement('a');
    a.className = 'cancelWin ddr-test-fake';
    a.style.display = 'none';
    tr.querySelector('td:nth-child(4)').appendChild(a);
    return true;
  });
  await page.waitForTimeout(40000);
  await page.evaluate(() => document.querySelectorAll('.ddr-test-fake').forEach((x) => x.remove()));
  const afterResync = allWinGets.slice(before);
  page.off('request', onRead);
  const productAfter = productReads.length - beforeProducts;
  // Reads of products whose win_num really changed in the window are expected
  // (5 s product poll on a selling live); only the rest could be a burst.
  const unexplained = readGroups.filter((g) => !changedGroups.has(g)).length;
  check(planted && feedGets.length >= 1 && unexplained <= 3 && !afterResync.some((u) => !/ordered=4/.test(u)),
    'full feed re-read does not trigger a burst of EC2 win reads',
    `full feed re-reads ${feedGets.length} · product win reads ${productAfter} (${productAfter - unexplained} of products whose win_num changed, ${unexplained} other) · 得标结果 pages ${afterResync.length}`);

  if (process.env.BATCH) {
    console.log('\n== ticked lives ==');
    await page.click('.ddr-batch-btn');
    await page.waitForFunction(() => document.querySelectorAll('.ddr-bp-row').length > 0, null, { timeout: 30000 });
    for (const [id, date] of Object.entries(LIVES)) {
      await page.evaluate(async (d) => {
        for (let i = 0; i < 40; i += 1) {
          const row = [...document.querySelectorAll('.ddr-bp-row')].find((x) => x.textContent.includes(d));
          if (row) { if (!row.querySelector('input').checked) row.querySelector('input').click(); return; }
          const more = document.querySelector('.ddr-bp-more');
          if (!more) return;
          more.click();
          await new Promise((res) => setTimeout(res, 2500));
        }
      }, date);
    }
    await page.waitForFunction((n) => [...document.querySelectorAll('.ddr-bp-status')].filter((x) => /customers · saved/.test(x.textContent)).length >= n,
      Object.keys(LIVES).length, { timeout: 180000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    const labelOf = Object.fromEntries(Object.entries(LIVES).map(([id, d]) => [id, String(+d.slice(0, 2))]));
    const earlier = {};
    for (const id of Object.keys(LIVES)) earlier[id] = truthByPsid((await winRecords(cookieStr, id)).records);
    const chips = await page.$$eval('.ddr-batch', (els) => els.map((el) => ({ psid: el.dataset.psid, hidden: el.classList.contains('ddr-hide'), tip: el.dataset.ddrTip ? JSON.parse(el.dataset.ddrTip) : null })));
    const cs = new Set(); let chipOk = 0; const chipBad = [];
    chips.forEach((c) => {
      if (cs.has(c.psid) || c.hidden) return;
      cs.add(c.psid);
      const lines = (c.tip.items || []);
      const good = Object.keys(LIVES).every((id) => {
        const t = earlier[id].get(c.psid) || new Map();
        const mine = lines.filter((it) => it.code.split(' · ')[0] === labelOf[id]);
        return mine.length === t.size && mine.every((it) => t.has(it.name) && t.get(it.name).qty === it.qty && full(t.get(it.name).sub) === it.amount);
      });
      if (good) chipOk += 1; else chipBad.push(c.psid);
    });
    check(chipBad.length === 0, 'blue chip: every line per ticked live = that live\'s EC2 records (qty, 小计)', `${chipOk}/${cs.size} customers`);
    chipBad.slice(0, 5).forEach((b) => console.log('       ', b));
    // untick to leave storage clean
    await page.click('.ddr-batch-btn');
    await page.evaluate(() => document.querySelectorAll('.ddr-bp-row input:checked').forEach((i) => i.click()));
    await page.waitForTimeout(800);
  }

  check(writes.length === 0, 'no EC2 write requests', writes.slice(0, 2).join(' | '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
  await ctx.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
