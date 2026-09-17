// Long-live performance (read-only). Does the page get heavy as comments pile up?
// EC2 prepends a row per comment and never removes one, so a long live ends with
// thousands of rows. This loads a live, grows the list with EC2's own "load
// more" (getCommentsPage, a read) to each size in SIZES, and at each size measures:
//   heap / DOM nodes           CDP Performance.getMetrics
//   new-comment freeze         a row is taken out and put back (a childList change,
//                              as a new comment makes); time until the page can run
//                              a timer again = work done by every observer (median of 5)
//   blocked per minute         long tasks (>50 ms) over 60 s idle, and the worst
//                              event-loop delay seen by a 100 ms probe
//   script / layout per minute CDP ScriptDuration + LayoutDuration + RecalcStyleDuration deltas
// EXT=off runs the same page without the extension (EC2's own cost).
//   TONIGHT=556923 SIZES=500,1000,1500,3000 EXT=on node ec2-live-perf-test.js
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
const SIZES = (process.env.SIZES || '500,1000,1500,3000').split(',').map(Number);
const ON = (process.env.EXT || 'on') !== 'off';
const WINDOW_MS = +(process.env.WINDOW_S || 60) * 1000;

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');

  const dir = path.join(EXT, 'chrome-profile-perf-' + (ON ? 'on' : 'off'));
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: ON ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : [], viewport: { width: 1440, height: 900 } });
  if (ON) {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
    await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true,
      baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
    await opt.evaluate(async () => { for (let i = 0; i < 100 && (await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live', 'ec2-live-main'] })).length < 2; i++) await new Promise((res) => setTimeout(res, 100)); });
    await opt.close();
  }
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#liveMessageDiv tbody tr', { timeout: 60000 });
  await page.waitForTimeout(25000);
  await page.evaluate(() => {
    window.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: false });
  });
  const rowCount = () => page.evaluate(() => document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_"]').length);

  const results = [];
  for (const size of SIZES) {
    // Grow with EC2's own pager until the size is reached or nothing more comes.
    let stuck = 0;
    while ((await rowCount()) < size && stuck < 3) {
      const before = await rowCount();
      await page.evaluate(() => window.getCommentsPage && window.getCommentsPage(window.live_id, 0));
      await page.waitForTimeout(2500);
      stuck = (await rowCount()) === before ? stuck + 1 : 0;
    }
    await page.waitForTimeout(20000); // cards, RFM lookups for new customers, won cells
    const rows = await rowCount();

    // New-comment freeze.
    const freezes = [];
    for (let i = 0; i < 5; i += 1) {
      freezes.push(await page.evaluate(() => new Promise((res) => {
        const tbody = document.querySelector('#liveMessageDiv tbody');
        const tr = tbody.querySelector('tr[id^="win_"]');
        const t0 = performance.now();
        tr.remove();
        tbody.prepend(tr);
        setTimeout(() => res(Math.round(performance.now() - t0)), 0);
      })));
      await page.waitForTimeout(700);
    }

    // Idle window: long tasks, loop delay, CPU split.
    const m0 = await metrics();
    await page.evaluate(() => {
      window.__lt.length = 0;
      window.__lag = [];
      let last = performance.now();
      window.__lagT = setInterval(() => { const n = performance.now(); window.__lag.push(n - last - 100); last = n; }, 100);
    });
    await page.waitForTimeout(WINDOW_MS);
    const idle = await page.evaluate(() => {
      clearInterval(window.__lagT);
      const lag = [...window.__lag].sort((a, b) => a - b);
      return { longTasks: window.__lt.length, blockedMs: Math.round(window.__lt.reduce((a, x) => a + Math.max(0, x[1] - 50), 0)),
        worstTaskMs: Math.round(Math.max(0, ...window.__lt.map((x) => x[1]))), lagP95: Math.round(lag[Math.floor(lag.length * 0.95)] || 0), lagMax: Math.round(lag[lag.length - 1] || 0) };
    });
    const m1 = await metrics();
    const perMin = (k) => Math.round(((m1[k] - m0[k]) * 1000 * 60000) / WINDOW_MS);
    const row = {
      rows,
      heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
      domNodes: m1.Nodes,
      newCommentFreezeMs: freezes.sort((a, b) => a - b)[2],
      newCommentFreezeMax: freezes[4],
      ...idle,
      scriptMsPerMin: perMin('ScriptDuration'),
      layoutStyleMsPerMin: perMin('LayoutDuration') + perMin('RecalcStyleDuration'),
    };
    results.push(row);
    console.log(JSON.stringify(row));
    if (rows < size) break; // the live has no more comments
  }

  // Resident memory of this browser's processes (compare with a page open for hours).
  try {
    const out = require('child_process').execSync('ps -axo pid,rss,command').toString().split('\n')
      .filter((l) => l.includes(dir)).map((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m && { mb: Math.round(+m[2] / 1024), type: (m[3].match(/--type=(\S+)/) || [])[1] || 'browser' }; })
      .filter(Boolean).sort((x, y) => y.mb - x.mb);
    console.log(JSON.stringify({ processesMB: out.slice(0, 6) }));
  } catch (e) { /* ignore */ }

  if (ON) {
    const t0 = Date.now();
    await page.click('.ddr-goods #refresh');
    await page.waitForFunction(() => !document.documentElement.classList.contains('ddr-lists-loading'), null, { timeout: 60000 }).catch(() => {});
    console.log(JSON.stringify({ refreshMs: Date.now() - t0, rowsAfterRefresh: await rowCount() }));
  }
  console.log(JSON.stringify({ ext: ON ? 'on' : 'off', live: LIVE, pageErrors: errs.length }));
  fs.writeFileSync(path.join(process.env.OUT_DIR || EXT, `perf-${LIVE}-${ON ? 'on' : 'off'}.json`), JSON.stringify(results, null, 1));
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
