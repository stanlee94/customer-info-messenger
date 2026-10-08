// Medium (750–1023px) and small (< 750px) layouts of the live overlay, in a narrow desktop window.
// Read-only: never clicks an EC2 write control.
//   TONIGHT=557246 node ec2-live-responsive-test.js        (OUT=<dir> keeps the screenshots)
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EXT = __dirname;
const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const LIVE = process.env.TONIGHT || '556923';
const BR = process.env.BASEROW_URL.replace(/\/+$/, '');
const OUT = process.env.OUT || path.join(os.tmpdir(), 'ec2-live-responsive-shots');
const WRITES = /okWin|cancelWin|oneClickStart|endLive|ajax_sendMessage|addGroup|delGroup|saveMarquee/i;
let failures = 0;
const check = (ok, label, detail) => { if (!ok) failures += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

// Boxes of the three cards and the video overlays, plus per-row facts for the comment table.
const measure = () => {
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; };
  const rows = [...document.querySelectorAll('.ddr-msg-body > tbody > tr[id^="win_"]:not(.ddr-own)')].slice(0, 40).map((tr) => {
    const rb = tr.getBoundingClientRect();
    const name = tr.querySelector('.ddr-name');
    const won = tr.querySelector('td:nth-child(4)');
    const wb = won && won.getBoundingClientRect();
    return { nameW: name ? name.getBoundingClientRect().width : -1, wonIn: !!wb && wb.width > 60 && wb.left >= rb.left - 1 && wb.right <= rb.right + 1 };
  });
  return {
    iw: innerWidth, ih: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    video: box('.l-iframe'), live: box('.ddr-live-scroll'), goods: box('#flowDivOne'), table: box('.l-table'),
    more: box('.ddr-vid-more'), stats: box('.ddr-vstats'), flipShown: vis('.ddr-flip-btn'), rows,
    // Bid list in EC2's order: [x, y] of each product row.
    bids: [...document.querySelectorAll('#allGroup tbody tr')].filter((tr) => tr.cells.length > 1).map((tr) => { const b = tr.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y)]; }),
  };
};

const inside = (a, b) => !!a && !!b && a.x >= b.x - 1 && a.r <= b.r + 1 && a.y >= b.y - 1 && a.b <= b.b + 1;
const px = (b) => b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}` : 'none';

function checkLayout(tag, m) {
  check(m.sw <= m.iw, `${tag}: no sideways scroll`, `${m.sw} ≤ ${m.iw}`);
  check(inside(m.more, m.video), `${tag}: video ··· inside the video`, `··· ${px(m.more)} · video ${px(m.video)}`);
  if (m.stats && m.stats.w) check(inside(m.stats, m.video), `${tag}: stats badge inside the video`, px(m.stats));
  const wide = m.iw >= 1024;
  check(m.flipShown === wide, `${tag}: ⇄ Flip ${wide ? 'shown' : 'hidden'}`);
  if (m.iw >= 750 && m.iw < 1024) {
    const top = [m.video, m.live, m.goods];
    check(top.every((b) => b && Math.abs(b.y - m.video.y) < 2), `${tag}: video, controls and bids share the top band`, top.map(px).join(' | '));
    check(m.video.r <= m.live.x && m.live.r <= m.goods.x, `${tag}: band order video · controls · bids, no overlap`);
    check(m.table.y >= m.video.b && m.table.w >= m.iw - 20, `${tag}: comments under the band, full width`, px(m.table));
    check(m.sh <= m.ih, `${tag}: the page itself does not scroll`, `${m.sh} ≤ ${m.ih}`);
  } else if (m.iw < 750) {
    check(m.video.b <= m.goods.y && m.goods.b <= m.table.y, `${tag}: Live, then Bids, then Comments`, [m.video, m.goods, m.table].map(px).join(' | '));
    check(m.goods.w >= m.iw - 20 && m.table.w >= m.iw - 20, `${tag}: bids and comments full width`);
    check(Math.abs(m.table.h - (m.ih - 16)) < 2, `${tag}: comments card one window tall`, `${Math.round(m.table.h)} vs ${m.ih - 16}`);
    check(m.live.x >= m.video.r, `${tag}: controls beside the video`, px(m.live));
  }
  if (m.iw < 1024) {
    const named = m.rows.filter((r) => r.nameW >= 0);
    check(named.length > 0 && named.every((r) => r.nameW > 24), `${tag}: every customer name visible`, `${named.length} rows · min ${Math.round(Math.min(...named.map((r) => r.nameW)))}px`);
    check(m.rows.every((r) => r.wonIn), `${tag}: every 得标 cell inside its row and ≥ 60px`);
    // Top to bottom, then the next column: each next code is lower in the same column or starts a column further right.
    const down = m.bids.every((p, i) => !i || (p[0] === m.bids[i - 1][0] ? p[1] > m.bids[i - 1][1] : p[0] > m.bids[i - 1][0]));
    const cols = new Set(m.bids.map((p) => p[0])).size;
    check(m.bids.length > 0 && down, `${tag}: bid list reads top to bottom, column by column`, `${m.bids.length} codes in ${cols} columns`);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await fetch(`${BR}/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`, { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const dir = path.join(EXT, 'chrome-profile-responsive');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true, baserowBaseUrl: BR, baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); });
  await opt.close();
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const writes = [];
  const errs = [];
  page.on('request', (q) => { if (q.method() === 'POST' && WRITES.test(q.url() + ' ' + (q.postData() || ''))) writes.push(q.url()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(9000);
  const desk0 = await page.evaluate(measure);

  // One page, resized through both breakpoints: EC2 swaps live.css ↔ mob.css at 750px on resize.
  for (const [w, h] of [[1000, 650], [820, 1100], [760, 800], [700, 900], [390, 844], [340, 700]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2500);
    const m = await page.evaluate(measure);
    console.log(`${w}×${h}`);
    checkLayout(`${w}×${h}`, m);
    await page.screenshot({ path: path.join(OUT, `${w}x${h}.png`) });
  }

  // The ··· tray in the narrowest controls column: open, everything still inside the window.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.click('.ddr-more-btn');
  await page.waitForTimeout(500);
  const tray = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.l-group-btn > .btn, .l-group-btn > .ddr-who-btn')].filter((e) => getComputedStyle(e).display !== 'none');
    return { n: items.length, out: items.filter((e) => { const b = e.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth; }).length, sw: document.documentElement.scrollWidth, iw: innerWidth };
  });
  check(tray.n >= 2 && tray.out === 0 && tray.sw <= tray.iw, '390: ··· tray opens inside the window', `${tray.n} buttons, ${tray.out} outside`);
  await page.click('.ddr-more-btn');

  // Column widths: content can't widen a column, and the header grips resize header + body together.
  const cols = () => page.evaluate(() => {
    const w = (el) => el ? Math.round(el.getBoundingClientRect().width) : -1;
    const ths = [...document.querySelectorAll('.ddr-msg-head thead th')];
    const tr = document.querySelector('.ddr-msg-body > tbody > tr[id^="win_"]:not(.ddr-own)');
    return { head: [w(ths[0]), w(ths[1]), w(ths[3])], body: tr ? [w(tr.cells[0]), w(tr.cells[1]), w(tr.cells[3])] : [], grips: document.querySelectorAll('.ddr-col-grip').length,
      saved: localStorage.getItem('ddrColWidths') };
  });
  const near = (a, b, tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
  for (const [w, h] of [[1200, 800], [860, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2000);
    const c0 = await cols();
    // A card line far wider than its column (a batch chip did this on a real live).
    await page.evaluate(() => { const r2 = document.querySelector('.ddr-msg-body tr[id^="win_"]:not(.ddr-own) .ddr-r2'); const x = document.createElement('span'); x.id = 'ddr-test-wide'; x.className = 'ddr-m'; x.textContent = 'W'.repeat(120); r2 && r2.appendChild(x); });
    await page.waitForTimeout(300);
    const c1 = await cols();
    check(near(c0.body, c1.body), `${w}×${h}: a too-wide card line does not move the columns`, `${c0.body} → ${c1.body}`);
    await page.evaluate(() => document.getElementById('ddr-test-wide')?.remove());
    check(c0.grips === 2 && near(c0.head, c0.body), `${w}×${h}: 2 grips, header and body columns aligned`, `${c0.head} / ${c0.body}`);
    const g = await page.locator('.ddr-col-grip').first().boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 20, g.y + g.height / 2, { steps: 4 });
    await page.mouse.move(g.x + g.width / 2 + 40, g.y + g.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const c2 = await cols();
    check(Math.abs(c2.head[0] - c0.head[0] - 40) <= 3 && Math.abs(c2.head[1] - c0.head[1] + 40) <= 3 && Math.abs(c2.head[2] - c0.head[2]) <= 2,
      `${w}×${h}: dragging the first grip 40px moves only that border`, `${c0.head} → ${c2.head}`);
    check(near(c2.head, c2.body), `${w}×${h}: body follows the header`, `${c2.head} / ${c2.body}`);
    // Can't squeeze the comment column below its minimum.
    const g2 = await page.locator('.ddr-col-grip').nth(1).boundingBox();
    await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
    await page.mouse.down();
    await page.mouse.move(g2.x - 900, g2.y + g2.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const c3 = await cols();
    check(c3.body[1] >= 55 && near(c3.head, c3.body), `${w}×${h}: comment column stops at its minimum`, `${c3.body}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(6000);
  const c4 = await cols();
  check(c4.saved && JSON.parse(c4.saved).medium && near(c4.head, c4.body) && c4.body[1] <= 60, 'widths kept after a reload', `${c4.body} · ${c4.saved}`);
  await page.dblclick('.ddr-col-grip');
  await page.waitForTimeout(600);
  const c5 = await cols();
  check(!JSON.parse(c5.saved || '{}').medium && near(c5.head, c5.body) && c5.body[1] > 100, 'double-click a grip = default widths', `${c5.body}`);
  await page.evaluate(() => localStorage.removeItem('ddrColWidths'));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(6000);
  const desk1 = await page.evaluate(measure);
  const same = ['video', 'live', 'goods', 'table', 'more'].every((k) => JSON.stringify(desk0[k]) === JSON.stringify(desk1[k]));
  check(same, 'back to 1440: every card where it was before', ['video', 'goods', 'table'].map((k) => px(desk1[k])).join(' | '));
  check(desk1.sh <= desk1.ih && desk1.flipShown, '1440: no page scroll, ⇄ Flip shown');

  check(writes.length === 0, 'no EC2 write requests', writes.join(' '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 3).join(' | '));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED', `· screenshots in ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
