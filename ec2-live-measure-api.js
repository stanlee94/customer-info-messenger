const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const EXT = '/Users/stanleemok/Documents/Personal/claude-code/chrome-extension/customer-info-messenger';
const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
async function ec2Cookie() {
  const url = process.env.BASEROW_URL.replace(/\/+$/, '') +
    `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`;
  const r = await fetch(url, { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const j = await r.json();
  return String((j.results || []).find((x) => String(x.Name) === 'EC2').Value || '');
}
const LIVE = 'https://ec2.full2house.com/Ent/index.php?live_id=556923&a=EntLive&m=liveingManager';

(async () => {
  const cookieStr = await ec2Cookie();
  const userDataDir = path.join(__dirname, 'chrome-profile-m');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1440, height: 900 },
  });

  let baserowHits = 0;
  let rowsRequested = 0;
  ctx.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/database/rows/table/749/')) {
      baserowHits++;
      rowsRequested += (u.match(/filter__PSID__equal=/g) || []).length;
    }
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;

  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate((cfg) => new Promise((r) => chrome.storage.local.set(cfg, r)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''),
    baserowToken: process.env.BASEROW_TOKEN,
    baserowUsersTableId: '749', baserowOrdersTableId: '750',
  });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in
  await opt.close();

  await ctx.addCookies(cookieStr.split(';').map((p) => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' };
  }).filter((c) => c.name));

  const page = await ctx.newPage();

  const run = async (label) => {
    baserowHits = 0; rowsRequested = 0;
    const t0 = Date.now();
    await page.goto(LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.ddr-card', { timeout: 60000 });
    await page.waitForTimeout(18000);
    const cards = await page.evaluate(() => document.querySelectorAll('.ddr-card').length);
    console.log(`  ${label.padEnd(16)} baserow requests: ${String(baserowHits).padStart(3)}   psids asked for: ${String(rowsRequested).padStart(4)}   cards: ${cards}   ${((Date.now()-t0)/1000).toFixed(1)}s`);
    return baserowHits;
  };

  console.log('=== BASEROW CALLS PER PAGE LOAD ===');
  await run('load 1 (cold)');
  await run('load 2 (reload)');
  await run('load 3 (reload)');

  await ctx.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
