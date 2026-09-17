// Batch compare end-to-end check (read-only).
// Ticks earlier lives in OUR picker, then verifies every batch chip, 已在…得标
// flag and the panel line against an independent recount from the raw feeds,
// that a reload costs 0 feed requests for ticked lives, and that unticking
// removes the stored summary and the chips. Never clicks 得标 / 取消得标 / 竞标开始.
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
// liveId -> the date in its EC2 name, used to find it in the picker
const LIVES = JSON.parse(process.env.LIVES || '{"556369":"11-09-2026","556208":"10-09-2026"}');
const EARLIER = Object.keys(LIVES);
const labelOf = Object.fromEntries(EARLIER.map((id) => [id, String(+LIVES[id].slice(0, 2))]));
const P = require(path.join(EXT, 'ec2-live-reply-parser.js'));

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

async function ec2Cookie() {
  const url = process.env.BASEROW_URL.replace(/\/+$/, '') +
    `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`;
  const r = await fetch(url, { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  return String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
}

async function rawFeed(cookie, id) {
  const res = await fetch('https://ec2.full2house.com/Ent/index.php?a=EntLive&m=getLivingMessage', {
    method: 'POST',
    headers: { Cookie: cookie, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: `live_id=${id}&lastTime=`,
  });
  return JSON.parse(await res.text()).data.list;
}

/** EC2 得标结果 records of a live (regex parser, independent of ec2-live.js), 弃标 left out. */
async function wonByPsid(cookie, liveId) {
  const strip = (x) => x.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const get = async (p) => (await fetch(`https://ec2.full2house.com/Ent/index.php?live_id=${liveId}&a=EntLive&m=liveAllWin${p > 1 ? '&page=' + p : ''}`,
    { headers: { Cookie: cookie, 'User-Agent': UA } })).text();
  const parse = (html) => [...(((html.match(/<table[^>]*id="sample_3"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1]) || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]))).filter((r) => r.length >= 12);
  const first = await get(1);
  const last = Math.max(1, ...[...first.matchAll(/[?&]page=(\d+)/g)].map((m) => +m[1]));
  let rows = parse(first);
  for (let p = 2; p <= last; p += 1) rows = rows.concat(parse(await get(p)));
  const products = {};
  rows.filter((r) => !r[11].includes('弃标')).forEach((r) => (products[r[3]] = products[r[3]] || new Set()).add(r[4].toLowerCase().replace(/\s+/g, '')));
  return products;
}

/** Independent of ec2-live.js: comments per psid (wins come from wonByPsid). */
function recount(list) {
  const own = (r) => !r.fb_user_id || String(r.fb_user_id) === String(r.fb_account_id);
  const comments = {};
  const catalog = new Map();
  const groupName = new Map();
  list.forEach((x) => {
    if (own(x)) return;
    comments[x.fb_user_id] = (comments[x.fb_user_id] || 0) + 1;
    const ns = P.replyNames(x.reply_message);
    if (ns.length !== 1) return;
    if (x.group_id) groupName.set(String(x.group_id), ns[0]);
  });
  const products = {};
  list.forEach((x) => {
    if (own(x) || !x.win_id || String(x.win_id) === '0') return;
    let ns = P.replyNames(x.reply_message);
    if (!ns.length && groupName.has(String(x.group_id || x.hit_live_group_id))) ns = [groupName.get(String(x.group_id || x.hit_live_group_id))];
    ns.forEach((n) => (products[x.fb_user_id] = products[x.fb_user_id] || new Set()).add(n.toLowerCase().replace(/\s+/g, '')));
  });
  return { comments, products };
}

(async () => {
  const cookieStr = await ec2Cookie();
  const userDataDir = path.join(EXT, 'chrome-profile-batch');
  fs.rmSync(userDataDir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: +(process.env.VW || 1440), height: +(process.env.VH || 900) },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate((cfg) => new Promise((r) => chrome.storage.local.set(cfg, r)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN,
    baserowUsersTableId: '749', baserowOrdersTableId: '750',
  });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in
  const storage = (keys) => opt.evaluate((k) => new Promise((r) => chrome.storage.local.get(k, r)), keys);
  await ctx.addCookies(cookieStr.split(';').map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' };
  }).filter((c) => c.name));

  const feedHits = {};
  const errs = [];
  const watch = (page) => {
    page.on('request', (req) => {
      if (!/m=getLivingMessage/.test(req.url())) return;
      const m = String(req.postData() || '').match(/live_id=(\d+)&lastTime=(.*)$/);
      if (m && m[1] !== TONIGHT) feedHits[m[1]] = (feedHits[m[1]] || 0) + 1;
    });
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /ec2-live|ddr/i.test(m.text())) errs.push(m.text()); });
  };
  const URL_TONIGHT = `https://ec2.full2house.com/Ent/index.php?live_id=${TONIGHT}&a=EntLive&m=liveingManager`;

  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL_TONIGHT, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForSelector('.ddr-batch-btn', { timeout: 30000 });
  await page.waitForTimeout(15000);

  console.log('\n== picker ==');
  await page.click('.ddr-batch-btn');
  await page.waitForFunction(() => document.querySelectorAll('.ddr-bp-row').length > 0, null, { timeout: 30000 });
  const listed = await page.$$eval('.ddr-bp-row', (rows) => rows.map((r) => r.textContent));
  // Tonight's own name, as the page shows it (was a hardcoded '15-09-2026', right only for 556923).
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const tonightName = norm(await page.$eval('p[data-ddr-live]', (p) => p.dataset.ddrLive).catch(() => ''));
  check(!!tonightName && !listed.some((t) => norm(t).includes(tonightName)), 'the live on screen is not offered', `${listed.length} lives listed · tonight "${tonightName}"`);
  const t0 = Date.now();
  for (const id of EARLIER) {
    const clicked = await page.evaluate(async (date) => {
      for (let i = 0; i < 40; i += 1) {
        const row = [...document.querySelectorAll('.ddr-bp-row')].find((r) => r.textContent.includes(date));
        if (row) { row.querySelector('input').click(); return true; }
        const more = document.querySelector('.ddr-bp-more');
        if (!more) return false;
        more.click();
        await new Promise((r) => setTimeout(r, 2500));
      }
      return false;
    }, LIVES[id]);
    check(clicked, `ticked ${id}`);
  }
  await page.waitForFunction((n) => {
    const s = [...document.querySelectorAll('.ddr-bp-status')].map((x) => x.textContent);
    return s.filter((t) => /customers · saved/.test(t)).length >= n && !s.some((t) => t === 'Loading…');
  }, EARLIER.length, { timeout: 120000 });
  console.log(`  both lives loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: path.join(EXT, 'batch-picker.png') });

  const st = await storage(['batch:sel', ...EARLIER.map((id) => 'batch:live:' + id)]);
  check(st['batch:sel'] && EARLIER.every((id) => st['batch:sel'].ids.includes(id)), 'selection saved');
  EARLIER.forEach((id) => {
    const e = st['batch:live:' + id];
    const kb = e ? JSON.stringify(e).length / 1024 : 0;
    check(!!e && kb < 400, `summary stored for ${id}`, `${kb.toFixed(0)} KB, ${e ? Object.keys(e.by).length : 0} customers`);
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);

  console.log('\n== chips vs independent recount ==');
  const indep = {};
  for (const id of EARLIER) indep[id] = { comments: recount(await rawFeed(cookieStr, id)).comments, products: await wonByPsid(cookieStr, id) };

  const verify = async (ids, tag) => {
    const cards = await page.$$eval('.ddr-batch', (els) => els.map((el) => ({
      psid: el.dataset.psid, hidden: el.classList.contains('ddr-hide'), tip: el.dataset.ddrTip || null, text: el.textContent,
      productsShown: el.querySelector('b') ? +el.querySelector('b').textContent : 0,
    })));
    let shown = 0; let daysOk = 0; let countsOk = 0; let productsOk = 0; let hiddenOk = 0; const bad = [];
    const seen = new Set();
    cards.forEach((c) => {
      if (seen.has(c.psid)) return;
      seen.add(c.psid);
      const expected = ids.filter((id) => indep[id].comments[c.psid]).sort((a, b) => a - b);
      const wonSomewhere = ids.some((id) => indep[id].products[c.psid]);
      if (!expected.length && wonSomewhere) { if (!c.hidden) { shown += 1; daysOk += 1; countsOk += 1; productsOk += 1; } else bad.push(`${c.psid} won (System Add) but chip hidden`); return; }
      if (!expected.length) {
        if (c.hidden) hiddenOk += 1; else bad.push(`${c.psid} shown but in no ticked live`);
        return;
      }
      if (c.hidden) { bad.push(`${c.psid} hidden but commented in ${expected}`); return; }
      shown += 1;
      const tip = JSON.parse(c.tip);
      const days = expected.map((id) => labelOf[id]);
      const tipDays = [...(tip.sList || []).join(' · ').matchAll(/(\d+) [A-Z][a-z]{2}/g)].map((m) => m[1]);
      if (c.text.startsWith(String(expected.length)) && JSON.stringify(tipDays) === JSON.stringify(days)) daysOk += 1;
      else bad.push(`${c.psid} chip "${c.text}" tip ${tipDays} expected ${expected.length} lives ${days}`);
      const want = expected.map((id) => indep[id].comments[c.psid]);
      const got = [...(tip.sList || []).join(' · ').matchAll(/\((\d+)×\)/g)].map((m) => +m[1]);
      if (JSON.stringify(got) === JSON.stringify(want)) countsOk += 1; else bad.push(`${c.psid} comments ${got} expected ${want}`);
      const okProducts = ids.every((id) => {
        const exp = (indep[id].products[c.psid] || new Set()).size;
        const have = (tip.items || []).filter((it) => it.code.split(' ')[0] === labelOf[id]).length;
        return exp === have;
      });
      const union = new Set();
      // All ticked lives, not only those commented in: System Add wins have no comment.
      ids.forEach((id) => (indep[id].products[c.psid] || new Set()).forEach((n) => union.add(n)));
      const noTonight = !(tip.items || []).some((it) => /^Tonight/.test(it.code));
      if (okProducts && noTonight && c.productsShown === union.size) productsOk += 1;
      else bad.push(`${c.psid} products chip ${c.productsShown} expected ${union.size} (earlier only)${noTonight ? '' : ' - tonight leaked in'}`);
    });
    console.log(`  [${tag}] customers on screen ${seen.size}: shown ${shown}, correctly hidden ${hiddenOk}`);
    check(bad.length === 0, `[${tag}] every chip agrees`, `days ${daysOk}/${shown} · comment counts ${countsOk}/${shown} · won products ${productsOk}/${shown}`);
    bad.slice(0, 6).forEach((b) => console.log('       ', b));
    return shown;
  };
  const shownBefore = await verify(EARLIER, 'ticked');

  // Hover the batch chips wherever they sit - near the top, middle and bottom
  // of the comment list - and require the bubble to stay fully on screen and
  // not to be cut off below.
  const vh = +(process.env.VH || 900);
  const tipRuns = [];
  const chipIdx = await page.$$eval('.ddr-batch:not(.ddr-hide)', (els) => els.length);
  for (const frac of [0.12, 0.5, 0.72, 0.9]) {
    for (let i = 0; i < Math.min(chipIdx, 40); i += 1) {
      const placed = await page.evaluate(({ i, frac }) => {
        const chip = document.querySelectorAll('.ddr-batch:not(.ddr-hide)')[i];
        const scroller = chip.closest('.mCustomScrollBox, [style*="overflow"]') || document.scrollingElement;
        const r = chip.getBoundingClientRect();
        const want = window.innerHeight * frac;
        chip.scrollIntoView({ block: 'center' });
        const r2 = chip.getBoundingClientRect();
        return r2.top > 0 && r2.bottom < window.innerHeight ? Math.round(r2.top / window.innerHeight * 100) / 100 : null;
      }, { i, frac });
      if (placed == null) continue;
      const box = await (await page.$$('.ddr-batch:not(.ddr-hide)'))[i].boundingBox();
      if (!box) continue;
      await page.mouse.move(0, 0);
      await page.waitForTimeout(150);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
      const tip = await page.evaluate(() => {
        const t = document.getElementById('ddr-tip');
        const r = t.getBoundingClientRect();
        return { on: t.classList.contains('ddr-tip-on'), top: r.top, bottom: r.bottom, h: r.height, below: t.classList.contains('ddr-tip-below'), items: t.querySelectorAll('.ddr-tip-item').length };
      });
      tipRuns.push({ chipTop: box.y, ...tip });
      break;
    }
  }
  // Force the worst case: the chip with the most items, placed at ~60% down.
  const worst = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.ddr-batch:not(.ddr-hide)')];
    let best = 0; let bi = -1;
    chips.forEach((c, i) => { const n = (JSON.parse(c.dataset.ddrTip).items || []).length; if (n > best) { best = n; bi = i; } });
    return { bi, best };
  });
  if (worst.bi >= 0) {
    await page.evaluate((bi) => document.querySelectorAll('.ddr-batch:not(.ddr-hide)')[bi].scrollIntoView({ block: 'end' }), worst.bi);
    await page.waitForTimeout(300);
    const box = await (await page.$$('.ddr-batch:not(.ddr-hide)'))[worst.bi].boundingBox();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    tipRuns.push({ chipTop: box.y, worstItems: worst.best, ...(await page.evaluate(() => {
      const t = document.getElementById('ddr-tip'); const r = t.getBoundingClientRect();
      return { on: t.classList.contains('ddr-tip-on'), top: r.top, bottom: r.bottom, h: r.height, below: t.classList.contains('ddr-tip-below'), items: t.querySelectorAll('.ddr-tip-item').length };
    })) });
    await page.screenshot({ path: path.join(EXT, `batch-tip-${process.env.VW || 1440}.png`) });
  }
  await page.mouse.move(0, 0);
  const offscreen = tipRuns.filter((t) => !t.on || t.top < 0 || t.bottom > vh + 0.5 ||
    (t.below ? t.top < t.chipTop : t.bottom > t.chipTop)); // never over the chip itself
  check(tipRuns.length >= 2 && offscreen.length === 0, 'batch tooltip always fully on screen',
    tipRuns.map((t) => `chip@${Math.round(t.chipTop)} -> ${Math.round(t.top)}..${Math.round(t.bottom)}${t.below ? ' below' : ' above'}${t.worstItems ? ` (${t.worstItems} items, ${t.items} listed)` : ''}`).join(' | '));

  // Top pill = tonight only: its amount must equal its own tooltip total.
  const pills = await page.$$eval('.ddr-tonight:not(.ddr-hide)', (els) => els.map((el) => ({
    amt: (el.querySelector('.ddr-tonight-amt') || {}).textContent || '',
    tip: JSON.parse(el.dataset.ddrTip || '{}'),
  })));
  const compact = (v) => {
    const n = Number(String(v).replace(/[^\d.]/g, ''));
    if (n >= 1e3) return 'RM ' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return 'RM ' + n.toFixed(0);
  };
  const pillBad = pills.filter((p) => (p.tip.v ? compact(p.tip.v) : '') !== p.amt || p.tip.h !== 'Won tonight');
  check(pillBad.length === 0, 'tonight pill amount = its tonight-only tooltip total', `${pills.length - pillBad.length}/${pills.length}`);
  pillBad.slice(0, 4).forEach((p) => console.log('       ', p.amt, JSON.stringify(p.tip.v)));
  await page.evaluate(() => {
    const chip = document.querySelector('.ddr-batch:not(.ddr-hide)');
    if (chip) chip.closest('tr').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(EXT, `batch-rows-${process.env.VW || 1440}.png`) });

  const flags = await page.evaluate(() => [...document.querySelectorAll('.ddr-prev')].map((f) => ({
    inCell: [...f.closest('tr').children].indexOf(f.closest('td')),
    insideButtons: !!f.closest('.action-buttons'),
    text: f.textContent,
  })));
  check(flags.every((f) => f.inCell === 3 && !f.insideButtons), '已在…得标 flags only in the 得标 cell, beside .action-buttons', `${flags.length} flags`);

  // Independent: tonight's code -> name (single-product replies), each rendered
  // row's codes + won names, intersected with what that customer won earlier.
  const tonightFeed = await rawFeed(cookieStr, TONIGHT);
  const nn = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
  const codeName = new Map();
  const gName = new Map();
  tonightFeed.forEach((x) => {
    const ns = P.replyNames(x.reply_message);
    if (ns.length !== 1) return;
    if (x.group_id) gName.set(String(x.group_id), ns[0]);
    let code = P.replyCode(x.reply_message);
    if (!code) { const cs = Object.keys(P.qtyByCode(x.message)); if (cs.length === 1) code = cs[0]; }
    if (code && !codeName.has(code)) codeName.set(code, ns[0]);
  });
  const byComment = new Map(tonightFeed.map((x) => [String(x.fb_comment_id), x]));
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ddr-msg-body tbody > tr[id^="win_tr_"]')].map((tr) => ({
    key: tr.dataset.index || tr.id.replace('win_tr_', ''),
    flag: (tr.querySelector('.ddr-prev') || {}).textContent || '',
  })));
  let expFlags = 0; let agree = 0; const flagBad = [];
  rows.forEach((r) => {
    const x = byComment.get(r.key);
    if (!x || !x.fb_user_id || String(x.fb_user_id) === String(x.fb_account_id)) return;
    const names = new Set(Object.keys(P.qtyByCode(x.message)).map((c) => codeName.get(c)).filter(Boolean).map(nn));
    if (x.win_id && x.win_id !== '0') {
      let ns = P.replyNames(x.reply_message);
      if (!ns.length && gName.has(String(x.group_id))) ns = [gName.get(String(x.group_id))];
      ns.forEach((n) => names.add(nn(n)));
    }
    const hit = EARLIER.filter((id) => [...names].some((n) => (indep[id].products[x.fb_user_id] || new Set()).has(n)));
    if (hit.length) expFlags += 1;
    const want = hit.length ? hit.sort((a, b) => a - b).map((id) => labelOf[id]).join('·') : '';
    const got = (r.flag.match(/已在 (\S+) 得标/) || [])[1] || '';
    if (want === got) agree += 1; else flagBad.push(`${r.key} page "${r.flag}" expected ${want || 'none'}`);
  });
  check(flagBad.length === 0, 'every 已在…得标 flag matches the recount', `${agree} rows agree · ${expFlags} flags expected · ${flags.length} on page`);
  flagBad.slice(0, 6).forEach((b) => console.log('       ', b));
  const commentCellClean = await page.evaluate(() => [...document.querySelectorAll('.ddr-msg-body tbody > tr > td:nth-child(2)')]
    .every((td) => !td.querySelector('[class*="ddr-"]')));
  check(commentCellClean, 'no nodes added inside any comment cell');
  const panelLine = await page.$eval('.ddr-panel', (p) => (p.querySelector('.ddr-panel-batch') || {}).textContent || '');
  check(/came back/.test(panelLine), 'panel batch line', panelLine.trim());

  console.log('\n== reload: served from storage ==');
  Object.keys(feedHits).forEach((k) => delete feedHits[k]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(15000);
  check(Object.keys(feedHits).length === 0, 'no feed request for ticked lives after reload', JSON.stringify(feedHits));
  const shownAfter = await verify(EARLIER, 'after reload');
  check(shownAfter === shownBefore || Math.abs(shownAfter - shownBefore) <= 3, 'same chips after reload', `${shownBefore} -> ${shownAfter}`);

  console.log('\n== untick ==');
  const drop = EARLIER[EARLIER.length - 1];
  await page.click('.ddr-batch-btn');
  await page.waitForSelector('.ddr-bp-row');
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('.ddr-bp-row')].find((r) => r.textContent.includes(name));
    row.querySelector('input').click();
  }, LIVES[drop]);
  await page.waitForTimeout(1500);
  const st2 = await storage(['batch:sel', 'batch:live:' + drop]);
  check(!st2['batch:live:' + drop] && !st2['batch:sel'].ids.includes(drop), `unticking ${drop} deletes its summary`);
  const kept = EARLIER.filter((id) => id !== drop);
  await verify(kept, 'one unticked');
  check(Object.keys(feedHits).length === 0, 'untick made no requests', JSON.stringify(feedHits));

  for (const id of kept) {
    await page.evaluate((name) => {
      const row = [...document.querySelectorAll('.ddr-bp-row')].find((r) => r.textContent.includes(name));
      row.querySelector('input').click();
    }, LIVES[id]);
  }
  await page.waitForTimeout(1500);
  const leftovers = await page.evaluate(() => ({
    chips: document.querySelectorAll('.ddr-batch:not(.ddr-hide)').length,
    flags: document.querySelectorAll('.ddr-prev').length,
    panel: !!document.querySelector('.ddr-panel-batch'),
  }));
  const st3 = await storage(['batch:sel', ...EARLIER.map((id) => 'batch:live:' + id)]);
  check(leftovers.chips === 0 && leftovers.flags === 0 && !leftovers.panel, 'all unticked: no chips, flags or panel line', JSON.stringify(leftovers));
  check(st3['batch:sel'].ids.length === 0 && EARLIER.every((id) => !st3['batch:live:' + id]), 'all unticked: storage empty');

  console.log('\n== tooltip stress: 30 lives, 40 items ==');
  const stress = {
    h: 'Earlier lives in this batch', v: 'RM 9,999.00',
    sPre: 'Commented in 30 of 30 ticked lives: ',
    sList: Array.from({ length: 30 }, (_, i) => `${i + 1} Sep (PM) (${i + 3}×)`),
    rows: [['Products won', '40'], ['Units', '80']],
    items: Array.from({ length: 40 }, (_, i) => ({ code: `${(i % 28) + 1} · J${i + 1}`, name: '(500g)【特大XL】(无硫磺)麦冬 Dried Ophiopogon Japonicus 500g', qty: 2, amount: 'RM 108.00' })),
    foot: 'Tonight is not included. A snapshot from when each live was ticked.',
  };
  for (const h of [800, 560, 420, 300]) {
    await page.setViewportSize({ width: 1280, height: h });
    await page.evaluate((spec) => {
      let el = document.getElementById('stress-tip');
      if (!el) { el = document.createElement('span'); el.id = 'stress-tip'; el.textContent = 'stress'; document.body.appendChild(el); }
      Object.assign(el.style, { position: 'fixed', right: '200px', bottom: '40px', padding: '4px', background: '#eee', zIndex: 2147480000 });
      el.dataset.ddrTip = JSON.stringify(spec);
    }, stress);
    const box = await (await page.$('#stress-tip')).boundingBox();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(150);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    const t = await page.evaluate(() => {
      const el = document.getElementById('ddr-tip'); const r = el.getBoundingClientRect();
      return { on: el.classList.contains('ddr-tip-on'), top: r.top, bottom: r.bottom, capped: el.classList.contains('ddr-tip-capped'),
        items: el.querySelectorAll('.ddr-tip-item').length, more: (el.querySelector('.ddr-tip-more') || {}).textContent || '',
        lives: [...el.querySelectorAll('.ddr-tip-s')].map((x) => x.textContent).join('') };
    });
    const livesShown = (t.lives.match(/\(\d+×\)/g) || []).length;
    const moreLives = (t.lives.match(/\+ (\d+) more lives/) || [])[1];
    await page.screenshot({ path: path.join(EXT, `batch-tip-stress-${h}.png`) });
    check(t.on && t.top >= 0 && t.bottom <= h + 0.5 && livesShown + (+moreLives || 0) === 30 && t.items + (+(t.more.match(/\d+/) || [0])[0]) === 40,
      `window ${h}px: bubble on screen, nothing silently dropped`,
      `${Math.round(t.top)}..${Math.round(t.bottom)} · ${t.items} items + "${t.more}" · ${livesShown} lives + ${moreLives || 0} more${t.capped ? ' · capped with fade' : ''}`);
  }
  await page.mouse.move(0, 0);

  check(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '));
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
  await ctx.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
