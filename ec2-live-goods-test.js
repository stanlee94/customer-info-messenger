// Goods list (关键字 | 得标数) vs EC2's products, read-only. A live can carry
// the same code twice: the host re-adds J3 mid-live and EC2 leaves the old
// product with stop_budan = 1 and its own win_num and price (556923: J3 and J4
// twice, old 1 / 0, new 141 / 167). Every row must show ITS product's win_num
// (by group_id, from the row's startEndComment icon) through several of the
// overlay's 5 s product polls, stopped rows are red and only they are, and the
// hover tooltip carries that product's price. Never clicks anything on EC2.
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
const RED = 'rgb(220, 38, 38)';
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookieStr = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');

  const dir = path.join(EXT, 'chrome-profile-goods');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); });
  await ctx.addCookies(cookieStr.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const writes = [];
  let latest = null; // the newest ajax_getGroups answer the page received
  let groupLists = 0;
  page.on('request', (req) => {
    const u = req.url();
    if (req.method() === 'POST' && /ec2\.full2house\.com/.test(u) && !/getLivingMessage|getLastGroups|get_cur_wins|getLivingMessagePaged|ajax_getGroups/.test(u)) writes.push(u);
  });
  page.on('response', async (res) => {
    if (!/m=ajax_getGroups/.test(res.url())) return;
    try { latest = JSON.parse(await res.text()).data; groupLists += 1; } catch (e) { /* not JSON */ }
  });
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${TONIGHT}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  const before = groupLists;
  // At least three of the overlay's product polls (5 s) must have patched the list.
  for (let i = 0; i < 60 && groupLists < before + 3; i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(1500);
  console.log(`live ${TONIGHT}: ${groupLists} product lists read`);

  const rows = await page.$$eval('.ddr-goods #allGroup tbody tr', (trs) => trs.map((tr) => {
    const icon = tr.querySelector('[onclick*="startEndComment"]');
    const m = icon && /startEndComment\(\s*['"]?(\d+)/.exec(icon.getAttribute('onclick') || '');
    const c = tr.children;
    return {
      id: m ? m[1] : null,
      code: c[0] ? c[0].textContent.trim() : '',
      count: c[2] && c[2].firstChild ? c[2].firstChild.nodeValue.trim() : '',
      stoppedClass: tr.classList.contains('ddr-goods-stopped'),
      codeColor: c[0] ? getComputedStyle(c[0]).color : '',
      countColor: c[2] ? getComputedStyle(c[2]).color : '',
      tip: tr.dataset.ddrTip || '',
    };
  }).filter((r) => r.id));
  const byId = new Map((latest || []).map((g) => [String(g.group_id), g]));
  const codeCount = {};
  (latest || []).forEach((g) => { codeCount[g.group_num] = (codeCount[g.group_num] || 0) + 1; });
  const dupCodes = Object.keys(codeCount).filter((k) => codeCount[k] > 1);
  console.log(`  ${rows.length} rows, ${byId.size} products, duplicate codes: ${dupCodes.join(', ') || 'none'}`);

  check(rows.length > 0 && rows.length === byId.size, 'one row per product', `${rows.length} / ${byId.size}`);
  const wrongCount = rows.filter((r) => !byId.has(r.id) || String(byId.get(r.id).win_num) !== r.count);
  check(!wrongCount.length, 'every 得标数 = its own product\'s win_num',
    wrongCount.map((r) => `${r.code}#${r.id} shows ${r.count}, EC2 ${byId.has(r.id) ? byId.get(r.id).win_num : '?'}`).join('; '));
  const wrongRed = rows.filter((r) => {
    const stopped = byId.has(r.id) && String(byId.get(r.id).stop_budan) === '1';
    const red = r.stoppedClass && r.codeColor === RED && r.countColor === RED;
    const anyRed = r.stoppedClass || r.codeColor === RED || r.countColor === RED;
    return stopped ? !red : anyRed;
  });
  check(!wrongRed.length, 'stopped products red, others not', wrongRed.map((r) => `${r.code}#${r.id}`).join(', '));
  const wrongTip = rows.filter((r) => {
    const g = byId.get(r.id);
    if (!g) return true;
    const tip = JSON.parse(r.tip || '{}');
    const price = (tip.rows || []).find((x) => x[0] === 'MYR');
    const stopped = String(g.stop_budan) === '1';
    return tip.h !== String(g.group_name).trim() || !price || !price[1].replace(/,/g, '').includes(Number(g.price).toFixed(2))
      || /Stopped/.test(tip.s || '') !== stopped;
  });
  check(!wrongTip.length, 'tooltip name/price/Stopped = its own product', wrongTip.map((r) => `${r.code}#${r.id} ${r.tip}`).join('; '));
  dupCodes.forEach((code) => {
    console.log(`  ${code}: ` + rows.filter((r) => r.code === code)
      .map((r) => `#${r.id} ${r.count}${r.stoppedClass ? ' (stopped, red)' : ''} ${JSON.parse(r.tip).rows[0][1]}`).join(' | '));
  });
  check(!writes.length, '0 EC2 writes', writes.join(', '));

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
