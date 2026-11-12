// Deep check of the square Refresh (#refresh) on a real live. Read-only: never clicks an EC2 write control.
//   TONIGHT=557246 node ec2-live-refresh-verify.js
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
const LIVE = process.env.TONIGHT || '557246';
const BASE = 'https://ec2.full2house.com/Ent/index.php';
const BR = process.env.BASEROW_URL.replace(/\/+$/, '');
let failures = 0;
const check = (ok, label, detail) => { if (!ok) failures += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };
const READS = /getLivingMessage|getLastGroups|get_cur_wins|ajax_getGroups|getCommentsPage|freshGroups|liveAllWin/;

(async () => {
  const r = await fetch(`${BR}/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`, { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const dir = path.join(EXT, 'chrome-profile-refresh');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true, baserowBaseUrl: BR, baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((res) => setTimeout(res, 100)); });
  await opt.close();
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const writes = []; const errs = []; let navigations = 0;
  let log = [];
  page.on('request', (req) => {
    const u = req.url();
    if (!/ec2\.full2house\.com/.test(u)) return;
    const m = (u.match(/[?&]m=([^&]+)/) || [])[1] || '';
    log.push({ t: Date.now(), method: req.method(), m, body: req.postData() || '' });
    if (req.method() === 'POST' && !READS.test(u)) writes.push(u);
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-vid-more', { timeout: 60000 });
  await page.waitForTimeout(15000);
  console.log(`\n== Refresh verify · live ${LIVE} ==`);

  const state = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"], #liveMessageDiv tbody > tr[id^="win_str_"]')];
    return {
      keys: rows.map((tr) => tr.dataset.index || tr.id.replace(/^win_s?tr_/, '')),
      marked: rows.filter((tr) => tr.__ddrOld).length,
      goodsMarked: [...document.querySelectorAll('#allGroup tbody tr')].filter((tr) => tr.__ddrOld).length, goodsOldWhere: [...document.querySelectorAll('#allGroup tr')].filter((tr) => tr.__ddrOld).map((tr) => tr.parentElement.tagName),
      goodsRows: document.querySelectorAll('#allGroup tr').length,
      noCard: rows.filter((tr) => !tr.classList.contains('ddr-own') && !tr.querySelector('.ddr-card')).length,
      lastTime: String(window.lastTime),
      loading: document.documentElement.classList.contains('ddr-lists-loading'),
      failed: !!document.querySelector('#refresh.ddr-refresh-failed'),
      busy: document.getElementById('refresh').getAttribute('aria-busy'),
      inScroll: !!document.querySelector('.ddr-live-scroll #refresh'),
      scrollTop: (document.querySelector('.ddr-col-right .l-table > .tab-body') || {}).scrollTop,
    };
  });
  const dups = (a) => a.length - new Set(a).size;
  const waitDone = () => page.waitForFunction(() => !document.documentElement.classList.contains('ddr-lists-loading'), null, { timeout: 30000 }).catch(() => {});

  // --- 1. placement ----------------------------------------------------------
  const s0 = await state();
  const geo = await page.evaluate(() => { const b = document.getElementById('refresh').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), label: document.getElementById('refresh').getAttribute('aria-label') }; });
  check(s0.inScroll && geo.w >= 44 && geo.h >= 44, 'Refresh button present, square icon, in the scroll area', JSON.stringify(geo));

  // --- 2. stale list is replaced by EC2's first page ------------------------------
  const removed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')];
    rows.forEach((tr) => { tr.__ddrOld = 1; });
    document.querySelectorAll('#allGroup tr').forEach((tr) => { tr.__ddrOld = 1; });
    const gone = rows.slice(1, 4).map((tr) => { tr.remove(); return tr.dataset.index || tr.id.replace('win_tr_', ''); });
    const fake = rows[5].cloneNode(true); fake.id = 'win_tr_FAKE_STALE'; fake.removeAttribute('data-index'); rows[5].before(fake);
    return gone;
  });
  const sStale = await state();
  log = [];
  const samples = [];
  const t0 = Date.now();
  const sampler = setInterval(async () => {
    try { samples.push(await page.evaluate(() => ({ loading: document.documentElement.classList.contains('ddr-lists-loading'), c: getComputedStyle(document.getElementById('liveMessageDiv')).opacity, g: getComputedStyle(document.getElementById('allGroup')).opacity }))); } catch (e) {}
  }, 60);
  let commentsResp = null;
  const respP = page.waitForResponse((res) => /m=getLivingMessage/.test(res.url()) && /page/.test(res.request().postData() || '') , { timeout: 20000 }).catch(() => null);
  await page.click('.ddr-goods #refresh');
  await waitDone();
  clearInterval(sampler);
  const took = Date.now() - t0;
  const s1 = await state();
  const reqs = log.slice();
  console.log('    requests during refresh:', reqs.filter((x) => x.t - t0 < took + 200).map((x) => `${x.method} ${x.m} ${x.body.slice(0, 60)}`).join(' | '));
  check(navigations === 1, 'no page navigation', `navigations ${navigations}`);
  check(removed.every((k) => s1.keys.includes(k)), 'rows missing before Refresh are back', removed.join(','));
  check(!s1.keys.includes('FAKE_STALE'), 'stale row not from EC2 is gone');
  check(s1.marked === 0 && s1.keys.length > 0, 'every comment row was redrawn from the server', `old rows left ${s1.marked} · rows ${sStale.keys.length} → ${s1.keys.length}`);
    check(s1.goodsMarked === 0 && s1.goodsRows > 0, 'bid list (#allGroup) redrawn', `old ${s1.goodsMarked} · rows ${s1.goodsRows}`);
  check(dups(s1.keys) === 0 && s1.noCard === 0, 'no duplicates, every customer row has its card', `dups ${dups(s1.keys)} · no card ${s1.noCard}`);
  check(!s1.lastTime.startsWith('9999') && /^\d{4}-/.test(s1.lastTime), 'living.js poll cursor restored to a real time', s1.lastTime);
  check(!s1.failed && s1.busy === null && s1.scrollTop === 0, 'success state: no red outline, aria-busy cleared, list at top');
  const during = samples.filter((x) => x.loading);
  check(during.length > 0 && during.every((x) => x.c === x.g) && during.slice(-3).every((x) => x.c === '0'), 'both lists fade out in step (180 ms) and stay hidden until revealed together', `${during.length} samples while loading; ${took} ms`);
  const nComments = reqs.filter((x) => x.m === 'getLivingMessage').length;
  console.log(`    took ${took} ms`);

  // Independent: the first page answer vs the rows drawn.
  // (living.js's page-1 request body is replayed from Node below.)
  const pageReq = reqs.find((x) => x.m !== 'ajax_getGroups' && x.method === 'POST' && /page/i.test(x.body + x.m));
  if (pageReq) {
    const u = `${BASE}?a=EntLive&m=${pageReq.m}`;
    const txt = await (await fetch(u, { method: 'POST', headers: { Cookie: cookie, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: pageReq.body })).text();
    let ids = [];
    try { const j = JSON.parse(txt); const list = (j.data && (j.data.list || j.data)) || []; ids = (Array.isArray(list) ? list : []).map((x) => String(x.fb_comment_id || x.id)); } catch (e) { ids = [...txt.matchAll(/win_tr_([\w]+)/g)].map((m) => m[1]); }
    const drawn = new Set(s1.keys);
    const missing = ids.filter((id) => !drawn.has(id));
    check(ids.length > 0 && missing.length <= 3, 'rows drawn = EC2 first page (independent replay)', `EC2 ${ids.length} ids · drawn ${s1.keys.length} · not drawn ${missing.length} (new comments may arrive in between)`);
  } else console.log('    (page-1 request not identified for replay)');

  await page.waitForTimeout(8000);
  const winsAfter = log.filter((x) => x.m === 'get_cur_wins' && x.t > t0).length;
  check(winsAfter > 0, "tonight's wins re-read after Refresh", `${winsAfter} get_cur_wins reads`);

  // --- 3. polls keep working, no duplicates ------------------------------------
  const tp = Date.now();
  await page.waitForTimeout(16000);
  const s2 = await state();
  const polls = log.filter((x) => x.t > tp && x.m === 'getLivingMessage');
  check(polls.length >= 2 && polls.every((x) => !/9999/.test(decodeURIComponent(x.body))), 'living.js 5 s poll continues with a real cursor', `${polls.length} polls`);
  check(dups(s2.keys) === 0, 'no duplicates after 3 polls', `rows ${s2.keys.length}`);

  // --- 4. double click = one reload --------------------------------------------
  log = [];
  const td = Date.now();
  await page.dblclick('.ddr-goods #refresh');
  await waitDone();
  await page.waitForTimeout(1500);
  const s3 = await state();
  const pageLoads = log.filter((x) => x.t >= td && x.m === 'ajax_getGroups').length;
  check(dups(s3.keys) === 0 && s3.keys.length > 0, 'double click: list intact, no duplicates', `rows ${s3.keys.length}`);
  console.log(`    double click requests: ${log.filter((x) => x.t >= td).map((x) => x.m).join(', ')}`);

  // --- 5. keyboard ------------------------------------------------------------
  await page.evaluate(() => { document.querySelectorAll('#liveMessageDiv tbody > tr').forEach((tr) => { tr.__ddrOld = 1; }); });
  await page.focus('.ddr-goods #refresh');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await waitDone();
  const s4 = await state();
  if (process.env.QUICK) { await ctx.close(); process.exit(0); }
  check(s4.marked === 0 && s4.keys.length > 0, 'Enter on the focused button refreshes too', `old rows ${s4.marked}`);

  // --- 6. network failure -----------------------------------------------------
  await page.route(/m=getLivingMessage/, (route) => route.abort());
  await page.route(/m=ajax_getGroups/, (route) => route.abort());
  const before6 = await state();
  await page.click('.ddr-goods #refresh');
  await waitDone();
  const s5 = await state();
  check(s5.failed && !s5.loading && s5.busy === null, 'failed refresh: red outline, lists revealed, not stuck loading');
  check(!s5.lastTime.startsWith('9999'), 'failed refresh: poll cursor given back', s5.lastTime);
  console.log(`    rows after failed refresh: ${before6.keys.length} → ${s5.keys.length}`);
  await page.unroute(/m=getLivingMessage/);
  await page.unroute(/m=ajax_getGroups/);
  await page.waitForTimeout(4500);
  const s6 = await state();
  await page.click('.ddr-goods #refresh');
  await waitDone();
  const s7 = await state();
  check(!s7.failed && s7.keys.length > 0 && dups(s7.keys) === 0, 'next Refresh after the network is back restores the list', `rows ${s6.keys.length} → ${s7.keys.length}`);

  check(writes.length === 0, 'no EC2 writes', writes.join(' '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '));
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASS'}`);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
