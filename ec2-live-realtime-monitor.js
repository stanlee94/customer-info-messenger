// Real-live monitor (read-only). Opens a live with the overlay in a headless
// browser and, for as long as the live runs, follows EC2's own records from
// Node with its own requests and parser (not the overlay's code):
//
//   products   POST a=EntLive&m=ajax_getGroups (every tick)
//   wins       POST a=EntLive&m=get_cur_wins for each product whose win_num or
//              price changed (all on the first tick)
//   弃标        GET  a=EntLive&m=liveAllWin&ordered=4 (every 3 min)
//   comments   POST a=EntLive&m=getLivingMessage with a lastTime cursor
//
// Every change becomes an event - COMMENT (no win), WIN, QTY (same record, new
// quantity / comment), CANCEL (record gone), SYSTEM_ADD (win with no comment),
// ABANDON (弃标) - and the monitor times how long the overlay takes to show it:
// that customer's 🛒 count, amount and hover lines, and the 得标 cell of every
// comment involved. The page here is "another device" to the host's EC2 tab, so
// the expected bound is the 30 s product check (+ tick). A persistent mismatch
// with unchanged records is a FAIL even without an event.
//
// Never clicks anything on EC2 and counts any POST that is not a read.
//
//   TONIGHT=557246 node ec2-live-realtime-monitor.js
//   env: TICK_S (15) · LIMIT_S (75) · DURATION_MIN (240) · OUT_DIR · stop early: touch $OUT_DIR/STOP
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
const LIVE = process.env.TONIGHT;
if (!LIVE) throw new Error('TONIGHT=<live_id> is required');
const TICK = +(process.env.TICK_S || 15) * 1000;
const LIMIT = +(process.env.LIMIT_S || 75) * 1000;
const END_AT = Date.now() + +(process.env.DURATION_MIN || 240) * 60000;
const OUT = process.env.OUT_DIR || path.join(EXT, 'live-monitor-' + LIVE);
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'events.jsonl');
const BASE = 'https://ec2.full2house.com/Ent/index.php';

const hms = (t = Date.now()) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' });
const log = (type, data) => {
  const row = { t: hms(), type, ...data };
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
  console.log(`[${row.t}] ${type} ${JSON.stringify(data)}`);
};
const money = (n) => 'RM ' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (n) => (n >= 1e6 ? 'RM ' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm' : n >= 1e3 ? 'RM ' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : 'RM ' + n.toFixed(0));
const r2 = (n) => Math.round(n * 100) / 100;

let cookie = '';
async function post(query, body) {
  const res = await fetch(`${BASE}?${query}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams(body || {}).toString(),
  });
  return JSON.parse(await res.text());
}

// ---------------------------------------------------------------- EC2 truth
const products = new Map(); // group_id -> {name, code, price, winNum}
const wins = new Map(); // win_id -> {psid, gid, qty, commentId}
let abandoned = new Set();

async function readAbandoned() {
  const ids = new Set();
  for (let p = 1; p <= 20; p += 1) {
    const html = await (await fetch(`${BASE}?live_id=${LIVE}&a=EntLive&m=liveAllWin&ordered=4${p > 1 ? '&page=' + p : ''}`,
      { headers: { Cookie: cookie, 'User-Agent': UA } })).text();
    const body = (html.match(/<table[^>]*id="sample_3"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
    const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').trim()));
    const before = ids.size;
    rows.filter((r) => r.length >= 12).forEach((r) => ids.add(r[1]));
    if (ids.size === before || !new RegExp(`[?&]page=${p + 1}\\b`).test(html)) break;
  }
  return ids;
}

/** Re-reads products, then the wins of changed products; returns the win diffs. */
async function readTruth(first) {
  const g = await post(`live_id=${LIVE}&a=EntLive&m=ajax_getGroups&search_status=0`);
  const changed = [];
  (g.data || []).forEach((x) => {
    const id = String(x.group_id);
    const next = { name: String(x.group_name || '').trim(), code: String(x.group_num || '').trim().toUpperCase(), price: parseFloat(x.price), winNum: String(x.win_num) };
    const prev = products.get(id);
    if (first || !prev || prev.winNum !== next.winNum || prev.price !== next.price) changed.push(id);
    products.set(id, next);
  });
  const diffs = [];
  for (const gid of changed) {
    const j = await post('a=EntLive&m=get_cur_wins', { group_id: gid, lastWinId: '0' });
    if (String(j.error) !== '0') { log('READ_ERROR', { gid }); continue; }
    const now = new Map((j.data || []).filter((w) => w.win_id && w.fb_user_id).map((w) => [String(w.win_id), {
      psid: String(w.fb_user_id), gid, qty: parseInt(w.num, 10) || 0, commentId: w.fb_comment_id ? String(w.fb_comment_id) : '', message: String(w.message || ''),
    }]));
    for (const [id, w] of wins) {
      if (w.gid === gid && !now.has(id)) { wins.delete(id); if (!first) diffs.push({ kind: 'CANCEL', win: id, ...w }); }
    }
    for (const [id, w] of now) {
      const prev = wins.get(id);
      wins.set(id, w);
      if (first) continue;
      if (!prev) diffs.push({ kind: w.commentId ? 'WIN' : 'SYSTEM_ADD', win: id, ...w });
      else if (prev.qty !== w.qty || prev.commentId !== w.commentId) diffs.push({ kind: 'QTY', win: id, from: { qty: prev.qty, commentId: prev.commentId }, ...w });
    }
  }
  return diffs;
}

function expectFor(psid) {
  const by = new Map();
  for (const [id, w] of wins) {
    if (w.psid !== psid || abandoned.has(id)) continue;
    const p = products.get(w.gid);
    const cur = by.get(p.name) || { qty: 0, sub: 0 };
    cur.qty += w.qty;
    cur.sub = r2(cur.sub + r2(p.price * w.qty));
    by.set(p.name, cur);
  }
  const total = r2([...by.values()].reduce((a, x) => a + x.sub, 0));
  return { n: by.size, amt: by.size ? compact(total) : '', v: by.size ? money(total) : '', lines: [...by].map(([name, x]) => `${name}×${x.qty}=${money(x.sub)}`).sort() };
}

function expectCell(commentId) {
  return [...wins].filter(([id, w]) => w.commentId === commentId && !abandoned.has(id))
    .map(([, w]) => `${products.get(w.gid).name}×${w.qty}`).sort();
}

// ---------------------------------------------------------------- page state
async function pageState(page) {
  return page.evaluate(() => {
    const pills = {};
    document.querySelectorAll('.ddr-tonight').forEach((el) => {
      if (pills[el.dataset.psid]) return;
      const tip = el.dataset.ddrTip ? JSON.parse(el.dataset.ddrTip) : {};
      const hidden = el.classList.contains('ddr-hide');
      pills[el.dataset.psid] = hidden ? { n: 0, amt: '', v: '', lines: [] } : {
        n: +el.querySelector('.ddr-tonight-n').textContent,
        amt: (el.querySelector('.ddr-tonight-amt') || {}).textContent || '',
        v: tip.v || '',
        lines: (tip.items || []).map((it) => `${it.name}×${it.qty}=${it.amount}`).sort(),
      };
    });
    const cells = {};
    const rowPsid = {};
    let rows = 0; let noCard = 0; const keys = new Set(); let dup = 0;
    // win_str_: living.js renames a won row when its win moves to a newer comment.
    document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"], #liveMessageDiv tbody > tr[id^="win_str_"]').forEach((tr) => {
      const key = tr.dataset.index || tr.id.replace(/^win_s?tr_/, '');
      rows += 1;
      if (keys.has(key)) dup += 1;
      keys.add(key);
      if (!tr.classList.contains('ddr-own') && !tr.querySelector('.ddr-card')) noCard += 1;
      const pill = tr.querySelector('.ddr-tonight');
      if (pill) rowPsid[key] = pill.dataset.psid;
      cells[key] = [...tr.querySelectorAll('.ddr-won-row')].map((row) => {
        const t = JSON.parse(row.dataset.ddrTip);
        return `${t.h}${(t.rows.find((q) => q[0] === 'Quantity') || [])[1]}`;
      }).sort();
    });
    return { pills, cells, rowPsid, rows, noCard, dup };
  });
}

// ---------------------------------------------------------------- run
(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');

  const dir = path.join(OUT, 'profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: 1440, height: 900 } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate((cfg) => new Promise((res) => chrome.storage.local.set(cfg, res)), { ec2LiveEnabled: true,
    baserowBaseUrl: process.env.BASEROW_URL.replace(/\/+$/, ''), baserowToken: process.env.BASEROW_TOKEN, baserowUsersTableId: '749', baserowOrdersTableId: '750' });
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((res) => setTimeout(res, 100)); });
  await opt.close();
  await ctx.addCookies(cookie.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));

  const page = await ctx.newPage();
  const writes = [];
  const errs = [];
  page.on('request', (req) => {
    const u = req.url();
    if (req.method() === 'POST' && /ec2\.full2house\.com/.test(u) && !/getLivingMessage|getLastGroups|get_cur_wins|ajax_getGroups|getCommentsPage|freshGroups/.test(u)) {
      writes.push(u);
      log('WRITE_REQUEST', { url: u, body: (req.postData() || '').slice(0, 200) });
    }
  });
  page.on('pageerror', (e) => { errs.push(e.message); log('PAGE_ERROR', { message: e.message }); });
  await page.goto(`${BASE}?live_id=${LIVE}&a=EntLive&m=liveingManager`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-col-left', { timeout: 60000 });

  await readTruth(true);
  abandoned = await readAbandoned();
  let abandonAt = Date.now();
  log('START', { live: LIVE, products: products.size, wins: wins.size, abandoned: abandoned.size });

  const stats = { events: {}, latencies: {}, fails: 0, slow: [], lateMissing: [] };
  // Comment feed from Node (its own cursor): which comments exist and when first seen.
  const commentSeen = new Map(); // fb_comment_id -> {at, psid, message, own}
  let cursor = '';
  // EC2 inserts some comments seconds after their comment time, behind a
  // lastTime cursor that already moved past them - EC2's page and the overlay
  // use the same cursor, so such a comment may never be polled. Every
  // FULL_FEED_MS the whole feed is read (lastTime empty): anything new there is
  // a LATE comment, and the monitor checks whether the page ever shows it.
  const FULL_FEED_MS = 120000;
  const MYT = (t) => Date.parse(String(t).replace(' ', 'T') + '+08:00');
  const readFeed = async (first, full) => {
    const j = await post('a=EntLive&m=getLivingMessage', { live_id: LIVE, lastTime: full ? '' : cursor });
    const list = (j.data && j.data.list) || [];
    list.forEach((x) => {
      const id = String(x.fb_comment_id);
      if (commentSeen.has(id)) return;
      const created = String(x.comment_created_time);
      const late = !first && full;
      commentSeen.set(id, { at: Date.now(), created, psid: String(x.fb_user_id || ''), message: String(x.message || '').slice(0, 60), first, late, shownAt: 0 });
      if (late) {
        stats.events.LATE_COMMENT = (stats.events.LATE_COMMENT || 0) + 1;
        log('LATE_COMMENT', { comment: id, psid: x.fb_user_id, created, message: String(x.message || '').slice(0, 60), cursorWas: cursor, lagBehindCursor_s: Math.round((MYT(cursor) - MYT(created)) / 1000) });
      }
      if (!cursor || created > cursor) cursor = created;
    });
  };
  let fullFeedAt = Date.now();
  await readFeed(true, false);

  const open = []; // pending events {id, kind, psid, commentIds, at, win}
  const mismatchSince = new Map(); // psid|cell:key -> first seen time
  let seq = 0;
  const stopFile = path.join(OUT, 'STOP');
  await page.waitForTimeout(20000); // first load: comments, RFM, tonight's wins

  while (Date.now() < END_AT && !fs.existsSync(stopFile)) {
    const tickAt = Date.now();
    let diffs = [];
    try {
      diffs = await readTruth(false);
      if (Date.now() - abandonAt > 180000) {
        const next = await readAbandoned();
        for (const id of next) if (!abandoned.has(id) && wins.has(id)) diffs.push({ kind: 'ABANDON', win: id, ...wins.get(id) });
        abandoned = next;
        abandonAt = Date.now();
      }
      await readFeed(false, false);
      if (Date.now() - fullFeedAt > FULL_FEED_MS) { await readFeed(false, true); fullFeedAt = Date.now(); }
    } catch (err) {
      log('TRUTH_ERROR', { message: String(err.message || err) });
      await page.waitForTimeout(TICK);
      continue;
    }
    diffs.forEach((d) => {
      stats.events[d.kind] = (stats.events[d.kind] || 0) + 1;
      const commentIds = [d.commentId, d.from && d.from.commentId].filter(Boolean);
      const p = products.get(d.gid);
      const ev = { id: ++seq, kind: d.kind, psid: d.psid, commentIds, at: tickAt, what: `${p.code} ${p.name} ×${d.qty}${d.from ? ` (was ×${d.from.qty}${d.from.commentId !== d.commentId ? ', comment moved' : ''})` : ''}` };
      open.push(ev);
      log('EVENT', { id: ev.id, kind: ev.kind, psid: ev.psid, what: ev.what, comment: d.message });
    });

    let st;
    try { st = await pageState(page); } catch (err) { log('PAGE_READ_ERROR', { message: String(err.message || err) }); continue; }

    // New comments shown on the page (any comment, won or not).
    for (const [id, c] of commentSeen) {
      if (c.shownAt || !(id in st.cells)) continue;
      c.shownAt = Date.now();
      if (c.first) continue;
      const won = expectCell(id).length > 0;
      if (!won) {
        stats.events.COMMENT_NO_WIN = (stats.events.COMMENT_NO_WIN || 0) + 1;
        // A won item shown here without a record is caught by the sweep below (it may just be a win newer than this tick's read).
      }
      (stats.latencies[c.late ? 'LATE_COMMENT_SHOWN' : 'COMMENT_SHOWN'] = stats.latencies[c.late ? 'LATE_COMMENT_SHOWN' : 'COMMENT_SHOWN'] || []).push(Math.round((c.shownAt - c.at) / 1000));
      if (c.late) log('LATE_COMMENT_SHOWN', { comment: id, after_s: Math.round((c.shownAt - c.at) / 1000), won: expectCell(id) });
    }
    // A late comment still missing from the page after LIMIT: the host cannot see it without Refresh.
    for (const [id, c] of commentSeen) {
      if (!c.late || c.shownAt || c.reported || Date.now() - c.at < LIMIT) continue;
      c.reported = true;
      stats.lateMissing.push(id);
      log('LATE_COMMENT_NOT_ON_PAGE', { comment: id, psid: c.psid, created: c.created, message: c.message, won: expectCell(id), note: 'needs Refresh to appear' });
    }

    // Events: resolved when the customer's pill and the involved cells match.
    const cellOk = (key) => !(key in st.cells) || JSON.stringify(st.cells[key]) === JSON.stringify(expectCell(key));
    const pillOk = (psid) => {
      const want = expectFor(psid);
      const got = st.pills[psid];
      if (!got) return true; // customer not on the page's first 500 rows
      return got.n === want.n && got.amt === want.amt && got.v === want.v && JSON.stringify(got.lines) === JSON.stringify(want.lines);
    };
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const ev = open[i];
      if (pillOk(ev.psid) && ev.commentIds.every(cellOk)) {
        const s = Math.round((Date.now() - ev.at) / 1000);
        (stats.latencies[ev.kind] = stats.latencies[ev.kind] || []).push(s);
        log('SHOWN', { id: ev.id, kind: ev.kind, within_s: s, onPage: !!st.pills[ev.psid] });
        open.splice(i, 1);
      } else if (Date.now() - ev.at > LIMIT && !ev.late) {
        ev.late = true;
        stats.slow.push(ev.id);
        log('LATE', { id: ev.id, kind: ev.kind, psid: ev.psid, what: ev.what, page: st.pills[ev.psid], want: expectFor(ev.psid), cells: Object.fromEntries(ev.commentIds.map((k) => [k, { page: st.cells[k], want: expectCell(k) }])) });
      }
    }

    // Sweep: every customer and every comment on the page, events or not.
    const now = Date.now();
    const bad = new Set();
    Object.keys(st.pills).forEach((psid) => { if (!pillOk(psid)) bad.add('pill:' + psid); });
    Object.keys(st.cells).forEach((key) => { if (!cellOk(key)) bad.add('cell:' + key); });
    for (const k of bad) {
      if (!mismatchSince.has(k)) mismatchSince.set(k, now);
      else if (now - mismatchSince.get(k) > LIMIT * 2 && !open.some((e) => k === 'pill:' + e.psid || e.commentIds.some((c) => k === 'cell:' + c))) {
        stats.fails += 1;
        const [kind, id] = k.split(':');
        log('FAIL', { why: 'mismatch persists with no pending change', key: k, page: kind === 'pill' ? st.pills[id] : st.cells[id], want: kind === 'pill' ? expectFor(id) : expectCell(id) });
        mismatchSince.set(k, now + 10 * 60000); // report again only after 10 more minutes
      }
    }
    for (const k of [...mismatchSince.keys()]) if (!bad.has(k)) mismatchSince.delete(k);

    const mismatchDetail = [...bad].slice(0, 5).map((k) => { const [kind, id] = k.split(':'); return { key: k, page: kind === 'pill' ? st.pills[id] : st.cells[id], want: kind === 'pill' ? expectFor(id) : expectCell(id) }; });
    const summary = { mismatchDetail, rows: st.rows, noCard: st.noCard, dupRows: st.dup, customers: Object.keys(st.pills).length, wins: wins.size, comments: commentSeen.size, lateMissing: stats.lateMissing.length, open: open.length, mismatches: bad.size, fails: stats.fails, writes: writes.length, pageErrors: errs.length };
    fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify({ at: hms(), ...summary, events: stats.events, latencies: stats.latencies, slow: stats.slow }, null, 1));
    if (st.dup) log('FAIL', { why: 'duplicate comment rows', count: st.dup });
    const wait = TICK - (Date.now() - tickAt);
    if (wait > 0) await page.waitForTimeout(wait);
  }

  const lat = Object.fromEntries(Object.entries(stats.latencies).map(([k, v]) => {
    const s = [...v].sort((a, b) => a - b);
    return [k, { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] }];
  }));
  log('END', { lateNotOnPage: stats.lateMissing, events: stats.events, latency_s: lat, stillOpen: open.map((e) => e.id), slow: stats.slow.length, fails: stats.fails, writes: writes.length, pageErrors: errs.length });
  await ctx.close();
  process.exit(stats.fails || writes.length ? 1 : 0);
})().catch((e) => { log('CRASH', { message: String(e && e.stack || e) }); process.exit(2); });
