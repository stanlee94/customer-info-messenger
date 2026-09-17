// Feature check on a real live (read-only). Covers what the other scripts do not:
//   video ···     结束直播 / 跑马灯 hidden at rest, shown by ···, closed by Escape (never clicked)
//   card ···      tray hidden at rest, shown by ···, closed by Escape (竞标开始 never clicked)
//   Refresh       in place: no navigation, no duplicate rows, rows kept, still none after 3 polls
//   Rev           hover figures = EC2's 得标结果 #totalPrice / #totalNums (read independently)
//   converter     100 -> 37.00, 128 -> 48.00 and a live price = the Worker's own answer; bad input -> —; Escape clears
//   goods hover   every code's name + RM price = ajax_getGroups; S$ = the Worker's answer
//   last order    hover loads the order from Baserow: total = table 750 Total_Amount
//   flags         every flag says Ships to Malaysia/Singapore and carries the address
//   banding       same PSID as the customer row above keeps the band, a new PSID flips it
//   Flip          mirrors the columns and back
// Never clicks any EC2 control; any POST that is not a read is reported.
//   TONIGHT=557246 node ec2-live-features-test.js
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
const LIVE = process.env.TONIGHT || '556923';
const BASE = 'https://ec2.full2house.com/Ent/index.php';
const SGD_API = 'https://myr-sgd-price-api.stanlee19941218.workers.dev/v1/convert';
const BR = process.env.BASEROW_URL.replace(/\/+$/, '');
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const two = (n) => Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const r = await fetch(`${BR}/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const ec2Post = async (query, body) => JSON.parse(await (await fetch(`${BASE}?${query}`, { method: 'POST',
    headers: { Cookie: cookie, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams(body || {}).toString() })).text());
  const sgdOf = async (prices) => (await (await fetch(SGD_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prices }) })).json()).results;
  const totals = async () => {
    const html = await (await fetch(`${BASE}?live_id=${LIVE}&a=EntLive&m=liveAllWin`, { headers: { Cookie: cookie, 'User-Agent': UA } })).text();
    return { rev: Number(((html.match(/id="totalPrice"[^>]*>([^<]*)/) || [])[1] || '').replace(/[^\d.]/g, '')), cnt: Number(((html.match(/id="totalNums"[^>]*>([^<]*)/) || [])[1] || '').replace(/[^\d]/g, '')) };
  };

  const dir = path.join(EXT, 'chrome-profile-features');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true,
    baserowBaseUrl: BR, baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((res) => setTimeout(res, 100)); });
  await opt.close();
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const writes = [];
  const errs = [];
  let navigations = 0;
  page.on('request', (req) => {
    const u = req.url();
    if (req.method() === 'POST' && /ec2\.full2house\.com/.test(u) && !/getLivingMessage|getLastGroups|get_cur_wins|ajax_getGroups|getCommentsPage|freshGroups/.test(u)) writes.push(u);
  });
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations += 1; });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-vid-more', { timeout: 60000 });
  await page.waitForTimeout(15000);
  const shown = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && !!e.getBoundingClientRect().height; }, sel);

  console.log(`\n== live ${LIVE} ==`);
  // --- video ··· -------------------------------------------------------------
  const vidRest = [await shown('#endLiveBtnDiv'), await shown('#edit_marquee_div')];
  await page.click('.ddr-vid-more');
  await page.waitForTimeout(200);
  const vidOpen = [await shown('#endLiveBtnDiv'), await shown('#edit_marquee_div')];
  const inVideo = await page.evaluate(() => {
    const v = document.querySelector('.l-iframe').getBoundingClientRect();
    return ['#endLiveBtn', '#edit_marquee', '.ddr-vid-more'].every((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.left >= v.left && b.right <= v.right + 1 && b.top >= v.top; });
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const vidEsc = [await shown('#endLiveBtnDiv'), await shown('#edit_marquee_div')];
  check(!vidRest[0] && !vidRest[1] && vidOpen[0] && vidOpen[1] && inVideo && !vidEsc[0] && !vidEsc[1],
    'video ···: 结束直播/跑马灯 hidden at rest, shown inside the video when opened, closed by Escape', JSON.stringify({ vidRest, vidOpen, inVideo, vidEsc }));

  // --- card ··· --------------------------------------------------------------
  const trayRest = [await shown('#oneClickStartBtn'), await shown('.ddr-who-btn')];
  await page.click('.ddr-more-btn');
  await page.waitForTimeout(200);
  const trayOpen = [await shown('#oneClickStartBtn'), await shown('.ddr-who-btn')];
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const trayEsc = [await shown('#oneClickStartBtn'), await shown('.ddr-who-btn')];
  check(!trayRest[0] && !trayRest[1] && trayOpen[0] && trayOpen[1] && !trayEsc[0] && !trayEsc[1],
    'card ···: 竞标开始 + Who\'s in the live hidden at rest, shown when opened, closed by Escape', JSON.stringify({ trayRest, trayOpen, trayEsc }));

  // --- Refresh in place --------------------------------------------------------
  const rowKeys = () => page.evaluate(() => [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')].map((tr) => tr.dataset.index || tr.id.replace('win_tr_', '')));
  const before = await rowKeys();
  const navBefore = navigations;
  await page.evaluate(() => { window.__ddrMark = 1; });
  const t0 = Date.now();
  await page.click('.ddr-goods #refresh');
  await page.waitForFunction(() => !document.documentElement.classList.contains('ddr-lists-loading'), null, { timeout: 30000 }).catch(() => {});
  const took = Date.now() - t0;
  const after = await rowKeys();
  const sameDoc = await page.evaluate(() => window.__ddrMark === 1);
  await page.waitForTimeout(16000);
  const later = await rowKeys();
  const dups = (a) => a.length - new Set(a).size;
  check(sameDoc && navigations === navBefore && dups(after) === 0 && dups(later) === 0 && after.length >= Math.min(before.length, 500) - 5,
    'Refresh reloads both lists in place: no page load, no duplicates (also after 3 polls)',
    `${took} ms · rows ${before.length} → ${after.length} → ${later.length} · duplicates ${dups(after)}/${dups(later)}`);
  const cardsAfter = await page.evaluate(() => [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]:not(.ddr-own)')].filter((tr) => !tr.querySelector('.ddr-card')).length);
  check(cardsAfter === 0, 'every customer row has its card after Refresh', `${cardsAfter} rows without a card`);

  // --- Rev -------------------------------------------------------------------
  const tA = await totals();
  await page.hover('.ddr-sales-btn');
  await page.waitForFunction(() => document.querySelector('.ddr-sales-rev') && document.querySelector('.ddr-sales-rev').textContent !== '—' && !document.querySelector('.ddr-sales-loading'), null, { timeout: 20000 }).catch(() => {});
  const rev = await page.evaluate(() => ({ rev: document.querySelector('.ddr-sales-rev').textContent, cnt: document.querySelector('.ddr-sales-cnt').textContent, open: document.querySelector('.ddr-sales').classList.contains('ddr-sales-on') }));
  const tB = await totals();
  const revOk = [tA, tB].some((t) => rev.rev === two(t.rev) && rev.cnt === t.cnt.toLocaleString('en-MY'));
  check(rev.open && revOk, 'Rev hover = EC2 得标结果 totals', `page RM ${rev.rev} / ${rev.cnt} · EC2 RM ${two(tB.rev)} / ${tB.cnt}`);
  await page.mouse.move(5, 890);
  await page.waitForTimeout(200);
  check(await page.evaluate(() => !document.querySelector('.ddr-sales').classList.contains('ddr-sales-on')), 'Rev panel closes when the pointer leaves');

  // --- converter ---------------------------------------------------------------
  const groups = (await ec2Post(`live_id=${LIVE}&a=EntLive&m=ajax_getGroups&search_status=0`)).data || [];
  const livePrice = groups.length ? String(parseFloat(groups[0].price)) : '59.9';
  const want = await sgdOf(['100', '128', livePrice]);
  const typeIn = async (v) => {
    await page.fill('.ddr-fx-in', v);
    await page.waitForTimeout(1500);
    return page.evaluate(() => [document.querySelector('.ddr-fx-out').textContent, document.querySelector('.ddr-fx').dataset.state]);
  };
  const c100 = await typeIn('100');
  const c128 = await typeIn('RM 128');
  const cLive = await typeIn(livePrice);
  const cBad = await typeIn('abc');
  await page.fill('.ddr-fx-in', '55');
  await page.focus('.ddr-fx-in');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const cEsc = await page.evaluate(() => [document.querySelector('.ddr-fx-in').value, document.querySelector('.ddr-fx-out').textContent]);
  check(c100[0] === two(want[0].sgd) && c100[0] === '37.00' && c128[0] === two(want[1].sgd) && cLive[0] === two(want[2].sgd) && cBad[0] === '—' && cEsc[0] === '' && cEsc[1] === '0.00',
    'MYR → SGD converter = the Worker; bad input shows —; Escape clears', `100→${c100[0]} · RM 128→${c128[0]} · ${livePrice}→${cLive[0]} (Worker ${two(want[2].sgd)}) · abc→${cBad[0]} · Esc→"${cEsc[0]}"/${cEsc[1]}`);

  // --- goods hover ---------------------------------------------------------------
  await page.waitForTimeout(3000);
  const tips = await page.$$eval('#allGroup tbody tr[data-ddr-tip]', (trs) => trs.map((tr) => ({ code: tr.children[0].textContent.trim(), tip: JSON.parse(tr.dataset.ddrTip) })));
  const byCode = new Map(groups.map((g) => [String(g.group_num || '').trim(), g]));
  const sgdAll = await sgdOf([...new Set(groups.map((g) => String(parseFloat(g.price))))]);
  const sgdMap = new Map(sgdAll.map((x) => [String(parseFloat(x.input)), x.sgd]));
  const goodsBad = [];
  tips.forEach(({ code, tip }) => {
    const g = byCode.get(code);
    if (!g) { goodsBad.push(`${code}: not in ajax_getGroups`); return; }
    const price = String(parseFloat(g.price));
    const rows = Object.fromEntries((tip.rows || []).map((x) => [x[0], x[1]]));
    const sgd = sgdMap.get(price);
    if (tip.h !== String(g.group_name).trim() || rows.MYR !== `RM ${two(price)}` || sgd == null || rows.SGD !== `S$ ${two(sgd)}`) goodsBad.push(`${code}: page ${tip.h} ${rows.MYR} ${rows.SGD} · EC2 ${g.group_name} RM ${price} S$ ${sgd}`);
  });
  check(tips.length > 0 && tips.length === groups.length && goodsBad.length === 0, 'goods hover: name, RM price and S$ for every product', `${tips.length - goodsBad.length}/${groups.length} products`);
  goodsBad.slice(0, 4).forEach((b) => console.log('        ', b));

  // --- last order ------------------------------------------------------------------
  const orderSn = await page.evaluate(() => { const e = document.querySelector('.ddr-rec[data-ddr-order]'); return e && e.dataset.ddrOrder; });
  if (orderSn) {
    await page.hover(`.ddr-rec[data-ddr-order="${orderSn}"]`);
    await page.waitForFunction((sn) => { const e = document.querySelector(`.ddr-rec[data-ddr-order="${sn}"]`); return e && !/Loading order/.test(e.dataset.ddrTip); }, orderSn, { timeout: 20000 }).catch(() => {});
    const tip = await page.evaluate((sn) => JSON.parse(document.querySelector(`.ddr-rec[data-ddr-order="${sn}"]`).dataset.ddrTip), orderSn);
    const row = ((await (await fetch(`${BR}/api/database/rows/table/750/?user_field_names=true&size=1&filter__Order_ID__equal=${encodeURIComponent(orderSn)}`,
      { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } })).json()).results || [])[0];
    const total = Object.fromEntries((tip.rows || []).map((x) => [x[0], x[1]])).Total;
    check(row && total === `RM ${two(row.Total_Amount)}` && (tip.items || []).length > 0, 'last-order hover: order from Baserow, total = table 750', `${orderSn} · page ${total} · Baserow RM ${row && row.Total_Amount} · ${(tip.items || []).length} items`);
  } else check(false, 'last-order hover: no customer with a last order on screen');
  await page.mouse.move(5, 890);

  // --- flags -------------------------------------------------------------------------
  const flags = await page.$$eval('.ddr-card .ddr-flag', (els) => els.map((e) => ({ cls: e.className, label: e.getAttribute('aria-label'), tip: e.dataset.ddrTip ? JSON.parse(e.dataset.ddrTip) : null })));
  const flagBad = flags.filter((f) => !/Ships to (Malaysia|Singapore)/.test(f.label || '') || !f.tip || !JSON.stringify(f.tip).match(/Latest shipping address/));
  check(flags.length > 0 && flagBad.length === 0, 'ship-to flags labelled and carry the address', `${flags.length} flags · MY ${flags.filter((f) => /my/.test(f.cls)).length} · SG ${flags.filter((f) => /sg/.test(f.cls)).length} · bad ${flagBad.length}`);

  // --- banding -----------------------------------------------------------------------
  const band = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')]
      .filter((tr) => !tr.classList.contains('ddr-own') && tr.querySelector('.ddr-tonight') && tr.offsetParent)
      .map((tr) => ({ psid: tr.querySelector('.ddr-tonight').dataset.psid, band: tr.dataset.ddrBand }));
    let bad = 0; let pairs = 0;
    for (let i = 1; i < rows.length; i += 1) {
      pairs += 1;
      const same = rows[i].psid === rows[i - 1].psid;
      if (!rows[i].band || (same ? rows[i].band !== rows[i - 1].band : rows[i].band === rows[i - 1].band)) bad += 1;
    }
    return { pairs, bad };
  });
  check(band.pairs > 0 && band.bad === 0, 'customer banding: same customer keeps the band, next customer flips it', `${band.pairs} neighbour pairs · ${band.bad} wrong`);

  // --- Flip --------------------------------------------------------------------------
  const sides = () => page.evaluate(() => ({ video: document.querySelector('.l-iframe').getBoundingClientRect().left, comments: document.querySelector('#liveMessageDiv').getBoundingClientRect().left, flip: document.documentElement.classList.contains('ddr-flip') }));
  const s0 = await sides();
  await page.click('.ddr-flip-btn');
  await page.waitForTimeout(400);
  const s1 = await sides();
  await page.click('.ddr-flip-btn');
  await page.waitForTimeout(400);
  const s2 = await sides();
  check(s0.flip !== s1.flip && (s0.video < s0.comments) !== (s1.video < s1.comments) && s2.flip === s0.flip && Math.abs(s2.video - s0.video) < 2, 'Flip mirrors the page and back', JSON.stringify({ s0, s1, s2 }));

  // --- video stats badge ---------------------------------------------------------------
  await page.waitForSelector('.ddr-vstats:not([hidden])', { timeout: 30000 }).catch(() => {});
  const vs = await page.evaluate(() => {
    const el = document.querySelector('.ddr-vstats');
    if (!el || el.hidden) return null;
    const v = el.getBoundingClientRect(); const box = document.querySelector('.l-iframe').getBoundingClientRect();
    const val = (sel) => { const n = el.querySelector(sel); return n && !n.hidden ? n.querySelector('b').textContent : null; };
    return { live: !el.querySelector('.ddr-vstats-live').hidden, viewers: val('.ddr-vstats-viewers'), likes: val('[data-k="likes"]'), comments: val('[data-k="comments"]'), shares: val('[data-k="shares"]'),
      topLeft: v.left - box.left < 12 && v.top - box.top < 12, src: document.querySelector('.l-iframe iframe').getAttribute('src') };
  });
  if (vs) {
    const html = await (await fetch(vs.src.replace(/&amp;/g, '&'), { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' } })).text();
    const cnt = (t) => { const m = html.match(new RegExp(`title="${t}"[^>]*>(?:<i[^>]*></i>)*\\s*([\\d.,]+[KMB]?)\\s*<`)); return m ? m[1] : null; };
    const live = (html.match(/"is_live_stream"\s*:\s*(true|false)/) || [])[1] === 'true';
    const viewers = (html.match(/viewerCount(?:&quot;|")\s*:\s*(\d+)/) || [])[1] || null;
    // Live counters move between the page's read and ours: within 15% (or 3) counts as equal.
    const num = (t) => (t == null ? null : parseFloat(String(t).replace(/,/g, '')) * ({ K: 1e3, M: 1e6 }[String(t).slice(-1)] || 1));
    const near = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(num(a) - num(b)) <= Math.max(3, 0.15 * num(b)));
    check(vs.topLeft && near(vs.likes, cnt('Like')) && near(vs.comments, cnt('Comment')) && near(vs.shares, cnt('Share')) && vs.live === live && near(vs.viewers, viewers),
      'video stats badge (top left) = Facebook\'s own counters', JSON.stringify({ page: { ...vs, src: undefined }, facebook: { live, viewers, likes: cnt('Like'), comments: cnt('Comment'), shares: cnt('Share') } }));
    console.log('        viewers shown:', vs.viewers);
  } else check(false, 'video stats badge did not appear');

  check(writes.length === 0, 'no EC2 write requests', writes.slice(0, 2).join(' | '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
  await ctx.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
