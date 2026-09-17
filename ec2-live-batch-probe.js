// Read-only probe for the batch-compare feature: can an ENDED live's full comment
// feed still be fetched in one request, and do its wins reflect the final state?
// Only POSTs getLivingMessage (a read) and GETs the lives list. Never clicks anything.
const fs = require('fs');

const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const BR = process.env.BASEROW_URL.replace(/\/+$/, '');
const BH = { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA };
const CART_API_BASE = 'https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest';

async function ec2Cookie() {
  const r = await fetch(`${BR}/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`, { headers: BH });
  const j = await r.json();
  return String((j.results || []).find((x) => String(x.Name) === 'EC2').Value || '');
}

async function feed(cookie, liveId) {
  const t0 = Date.now();
  const res = await fetch('https://ec2.full2house.com/Ent/index.php?a=EntLive&m=getLivingMessage', {
    method: 'POST',
    headers: {
      Cookie: cookie, 'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ live_id: liveId, lastTime: '' }).toString(),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let list = null;
  try { list = JSON.parse(text).data.list; } catch (e) { /* not JSON */ }
  return { status: res.status, ms, bytes: Buffer.byteLength(text), list, head: list ? null : text.slice(0, 200) };
}

async function liveItems(liveId) {
  const r = await fetch(`${BR}/api/database/rows/table/771/?user_field_names=true&size=200&filter__live_id__equal=${liveId}`, { headers: BH });
  return (await r.json()).results || [];
}

if (!process.env.DOMCHECK) (async () => {
  // 1. Lives list as the picker would see it
  const lv = await (await fetch(`${CART_API_BASE}/api/lives?page=1`)).json();
  const lives = lv.lives || [];
  console.log('lives page1', lives.length, 'lastPage', lv.lastPage, 'fields', Object.keys(lives[0] || {}).join(','));
  console.log('statuses', JSON.stringify(lives.reduce((a, l) => ((a[l.status] = (a[l.status] || 0) + 1), a), {})));
  lives.slice(0, 6).forEach((l) => console.log('  ', JSON.stringify(l).slice(0, 220)));

  const cookie = await ec2Cookie();
  const targets = (process.env.LIVES || '556369,555516,556923').split(',');
  for (const id of targets) {
    const f = await feed(cookie, id);
    if (!f.list) { console.log(`\n## ${id} status ${f.status} NOT JSON: ${f.head}`); continue; }
    const L = f.list;
    const times = L.map((r) => r.comment_created_time).filter(Boolean).sort();
    const psids = new Set(L.map((r) => r.fb_user_id).filter(Boolean));
    const wins = L.filter((r) => r.win_id && r.win_id !== '0');
    const histOnly = L.filter((r) => (!r.win_id || r.win_id === '0') && r.hit_live_win_id && r.hit_live_win_id !== '0');
    const winIds = new Set(wins.map((r) => r.win_id));
    console.log(`\n## live ${id}: HTTP ${f.status} · ${f.ms} ms · ${(f.bytes / 1024).toFixed(0)} KB · ${L.length} rows · ${psids.size} psids`);
    console.log('  time range', times[0], '→', times[times.length - 1]);
    console.log('  rows with win_id', wins.length, 'distinct win_id', winIds.size, '· cancelled (hit_live_win_id only)', histOnly.length);

    // Cross-check: winners per group vs Baserow 771 得标人数 (EC2 goods list snapshot)
    const perGroup = {};
    wins.forEach((r) => { (perGroup[r.group_id] = perGroup[r.group_id] || new Set()).add(r.fb_user_id); });
    const items = await liveItems(id);
    let same = 0, diff = [];
    items.forEach((it) => {
      const ours = perGroup[it['编号']] ? perGroup[it['编号']].size : 0;
      const theirs = +it['得标人数'] || 0;
      if (ours === theirs) same++; else diff.push(`${it['标号']} feed ${ours} vs 771 ${theirs}`);
    });
    console.log(`  winners/product vs Baserow 771: ${same}/${items.length} equal`, diff.slice(0, 8).join(' | '));
  }
})();

// ---- Part 2: feed win state vs EC2's own rendered page for an old live (read-only).
// Only "点击加载更多" (#page, a read) is clicked. Never 得标 / 取消得标 / 竞标开始.
if (process.env.DOMCHECK) (async () => {
  const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
  const id = process.env.DOMCHECK;
  const cookie = await ec2Cookie();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));
  const page = await ctx.newPage();
  await page.goto(`https://ec2.full2house.com/Ent/index.php?live_id=${id}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#liveMessageDiv tbody > tr[id^="win_tr_"]', { timeout: 60000 });
  await page.waitForTimeout(8000);
  for (let i = 0; i < +(process.env.PAGES || 6); i++) {
    const more = await page.$('#liveMessageDiv #page');
    if (!more) break;
    await more.click();
    await page.waitForTimeout(3000);
  }
  const dom = await page.evaluate(() => [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')].map((tr) => ({
    key: tr.dataset.index || tr.id.replace('win_tr_', ''),
    cancel: !!tr.querySelector('.cancelWin'),
    ok: !!tr.querySelector('.okWin'),
  })));
  await browser.close();
  const f = await feed(cookie, id);
  const byComment = new Map(f.list.map((r) => [String(r.fb_comment_id), r]));
  let matched = 0, agree = 0; const bad = [];
  dom.forEach((d) => {
    const r = byComment.get(String(d.key));
    if (!r) return;
    matched++;
    const feedWin = !!(r.win_id && r.win_id !== '0');
    if (feedWin === d.cancel) agree++; else bad.push(`${d.key} dom ${d.cancel ? 'won' : 'not'} feed ${feedWin ? 'won' : 'not'} hit=${r.hit_live_win_id}`);
  });
  console.log(`\n## DOM check live ${id}: ${dom.length} rows rendered, ${matched} matched to feed, win state agrees ${agree}/${matched}, won on page ${dom.filter((d) => d.cancel).length}`);
  bad.slice(0, 10).forEach((b) => console.log('   ', b));
})();
