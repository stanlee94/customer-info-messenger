const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const EXT = '/Users/stanleemok/Documents/Personal/claude-code/chrome-extension/customer-info-messenger';
const OUT = __dirname;
const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function ec2Cookie() {
  const url = process.env.BASEROW_URL.replace(/\/+$/, '') +
    `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`;
  const r = await fetch(url, { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const j = await r.json();
  return String((j.results || []).find((x) => String(x.Name) === 'EC2').Value || '');
}

(async () => {
  const cookieStr = await ec2Cookie();
  const userDataDir = path.join(OUT, 'chrome-profile-winfix-' + (process.env.VW || 1440));
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: +(process.env.VW||1440), height: +(process.env.VH||900) },
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate((cfg) => new Promise((r) => chrome.storage.local.set(cfg, r)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''),
    baserowToken: process.env.BASEROW_TOKEN,
    baserowUsersTableId: '749',
    baserowOrdersTableId: '750',
  });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in
  await opt.close();

  await ctx.addCookies(cookieStr.split(';').map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' };
  }).filter((c) => c.name));

  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

  // Read-only. Watches getLivingMessage requests; the orphan case is simulated
  // with a detached-looking fake .cancelWin that is never clicked and removed.
  const feed = [];
  page.on('request', (rq) => {
    if (!rq.url().includes('m=getLivingMessage')) return;
    const b = new URLSearchParams(rq.postData() || '');
    feed.push({ t: Date.now(), full: !b.get('lastTime') });
  });
  await page.goto('https://ec2.full2house.com/Ent/index.php?live_id=' + (process.env.TONIGHT || '556923') + '&a=EntLive&m=liveingManager',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(15000);
  const t0 = Date.now();
  const fullAt = (from) => feed.filter((f) => f.full && f.t >= from).length;

  const layout = await page.evaluate(() => {
    const body = document.querySelector('.ddr-msg-body');
    const won = [...document.querySelectorAll('td:nth-child(4) .action-buttons')].filter((a) => a.querySelector('.cancelWin'));
    const wraps = won.filter((ab) => {
      const s = ab.querySelector(':scope > span.green').getBoundingClientRect();
      const c = ab.querySelector('.cancelWin').getBoundingClientRect();
      return c.top >= s.bottom - 2;
    }).length;
    const rows = won.map((a) => a.closest('tr').getBoundingClientRect().height).sort((x, y) => x - y);
    const c = won[0] && won[0].querySelector('.cancelWin');
    return {
      compact: body.classList.contains('ddr-win-compact'),
      wonRows: won.length,
      wrapped: wraps,
      medianWonRow: Math.round(rows[Math.floor(rows.length / 2)] || 0),
      label: c ? getComputedStyle(c, '::after').content : null,
      domText: c ? c.textContent.trim() : null,
      cancelW: c ? Math.round(c.getBoundingClientRect().width) : null,
    };
  });
  console.log('viewport', process.env.VW || 1440, JSON.stringify(layout));

  // --- steady state: no resync without a reason
  await page.waitForTimeout(36000);
  const falseResyncs = fullAt(t0);
  console.log('full-feed requests in 36s steady state:', falseResyncs, falseResyncs === 0 ? 'PASS' : 'FAIL');

  // --- simulated orphan win
  const faked = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')]
      .find((r) => r.querySelector('.ddr-card') && r.querySelector('td:nth-child(4) .okWin'));
    if (!tr) return null;
    const a = document.createElement('a');
    a.className = 'cancelWin ddr-test-fake';
    a.style.pointerEvents = 'none';
    tr.querySelectorAll('td')[3].appendChild(a);
    return tr.id;
  });
  const t1 = Date.now();
  await page.waitForTimeout(12000);
  const resyncs = fullAt(t1);
  console.log('faked orphan on', faked, '-> full-feed requests in 12s:', resyncs, resyncs === 1 ? 'PASS' : 'FAIL');
  await page.waitForTimeout(36000);
  const repeats = fullAt(t1) - resyncs;
  console.log('repeat resyncs for same row in next 36s:', repeats, repeats === 0 ? 'PASS' : 'FAIL');
  const cards = await page.evaluate(() => {
    document.querySelectorAll('.ddr-test-fake').forEach((n) => n.remove());
    return { cards: document.querySelectorAll('.ddr-card').length, pills: document.querySelectorAll('.ddr-tonight:not(.ddr-hide)').length };
  });
  console.log('feed requests seen total:', feed.length, 'full:', feed.filter(f=>f.full).length);
  console.log('after resync', JSON.stringify(cards));
  console.log(errs.filter((e) => !/fburl|facebook/i.test(e)).length ? 'errors: ' + errs.join('\n') : 'no console errors from our code');
  await ctx.close();
})();
