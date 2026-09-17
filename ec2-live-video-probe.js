// Facebook video plugin probe (read-only, run during a real live).
// EC2 embeds https://www.facebook.com/plugins/video.php?href=… in the video box.
// This opens that plugin twice in real Chrome (proprietary codecs, so the live
// stream can actually play):
//   kept     loaded once and never reloaded - does its viewer count move on its own?
//   fresh    reloaded every tick - what does a new load say?
// Each tick records the plugin's visible text, every number-like label and its
// position (top-left badge = viewer count), aria-labels, and numbers found in the
// server HTML (reactions / comments / shares / viewers keys), plus screenshots.
//
//   TONIGHT=557246 node ec2-live-video-probe.js      env: TICK_S (30) · TICKS (20) · OUT_DIR
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const LIVE = process.env.TONIGHT;
if (!LIVE) throw new Error('TONIGHT=<live_id> is required');
const TICK = +(process.env.TICK_S || 30) * 1000;
const TICKS = +(process.env.TICKS || 20);
const OUT = process.env.OUT_DIR || path.join(__dirname, 'video-probe-' + LIVE);
fs.mkdirSync(OUT, { recursive: true });
const hms = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' });
const write = (row) => fs.appendFileSync(path.join(OUT, 'ticks.jsonl'), JSON.stringify(row) + '\n');

/** Everything readable inside the plugin document. */
const readPlugin = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
  // Own text only (an icon next to a count makes the count's parent a non-leaf).
  const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const leaves = [...document.querySelectorAll('body *')].filter((el) => own(el) && vis(el));
  const labels = leaves.map((el) => {
    const r = el.getBoundingClientRect();
    return { text: own(el).slice(0, 80), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName, cls: String(el.className).slice(0, 60) };
  });
  const aria = [...document.querySelectorAll('[aria-label]')].filter(vis).map((el) => el.getAttribute('aria-label')).filter((t) => t && t.length < 120);
  const video = document.querySelector('video');
  return {
    text: document.body.innerText.slice(0, 2000),
    numbers: labels.filter((l) => /\d/.test(l.text) && l.text.length < 30),
    topLeft: labels.filter((l) => l.y < 80 && l.x < 160),
    aria: [...new Set(aria)],
    video: video ? { paused: video.paused, readyState: video.readyState, currentTime: Math.round(video.currentTime), duration: video.duration, w: video.videoWidth, h: video.videoHeight } : null,
    url: location.href,
  };
};

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookie = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const html = await (await fetch(`https://ec2.full2house.com/Ent/index.php?live_id=${LIVE}&a=EntLive&m=liveingManager`, { headers: { Cookie: cookie, 'User-Agent': UA } })).text();
  const m = html.match(/https:\/\/www\.facebook\.com\/plugins\/video\.php\?[^"]+/);
  if (!m) { console.log('no video embedded yet'); process.exit(3); }
  const plugin = m[0].replace(/&amp;/g, '&');
  console.log('plugin', plugin);

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const ctx = await browser.newContext({ viewport: { width: 267 + 40, height: 680 }, userAgent: UA, locale: 'en-US' });
  // Same box EC2 draws: the plugin in an iframe at the video column's width.
  const wrap = (src) => `<html><body style="margin:0;background:#555"><iframe id="f" src="${src}" width="267" height="640" style="border:none;overflow:hidden" scrolling="no" allow="autoplay; encrypted-media" allowfullscreen></iframe></body></html>`;
  const kept = await ctx.newPage();
  await kept.setContent(wrap(plugin), { waitUntil: 'load' });
  const fresh = await ctx.newPage();

  const frameOf = async (page) => {
    for (let i = 0; i < 40; i += 1) {
      const f = page.frames().find((x) => /plugins\/video\.php/.test(x.url()));
      if (f) { try { await f.waitForLoadState('domcontentloaded', { timeout: 15000 }); return f; } catch (e) { /* retry */ } }
      await page.waitForTimeout(500);
    }
    return null;
  };

  for (let t = 1; t <= TICKS; t += 1) {
    const at = hms();
    const row = { t: at, tick: t };
    try {
      const kf = await frameOf(kept);
      row.kept = kf ? await kf.evaluate(readPlugin) : null;
      await kept.screenshot({ path: path.join(OUT, `kept-${String(t).padStart(2, '0')}.png`) });

      await fresh.setContent(wrap(plugin + '&_=' + Date.now()), { waitUntil: 'load' });
      const ff = await frameOf(fresh);
      await fresh.waitForTimeout(6000);
      row.fresh = ff ? await ff.evaluate(readPlugin) : null;
      await fresh.screenshot({ path: path.join(OUT, `fresh-${String(t).padStart(2, '0')}.png`) });

      // Server HTML of the plugin: counters it ships without running any script.
      const src = await (await fetch(plugin, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' } })).text();
      const keys = {};
      for (const k of src.matchAll(/"([a-z_]*(?:viewer|watch|reaction|comment_count|share_count|total_count|live_status|is_live|seen_by|concurrent|feedback_count)[a-z_]*)"\s*:\s*("[^"]{0,40}"|[\d.]+|true|false|null)/gi)) {
        (keys[k[1]] = keys[k[1]] || new Set()).add(k[2]);
      }
      row.serverKeys = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [...v].slice(0, 5)]));
      if (t === 1) fs.writeFileSync(path.join(OUT, 'plugin-server.html'), src);
    } catch (err) {
      row.error = String(err.message || err);
    }
    write(row);
    console.log(`[${at}] tick ${t}: kept topLeft=${JSON.stringify((row.kept || {}).topLeft)} · fresh topLeft=${JSON.stringify((row.fresh || {}).topLeft)} · numbers=${JSON.stringify(((row.fresh || {}).numbers || []).map((n) => n.text))}`);
    if (t < TICKS) await kept.waitForTimeout(TICK);
  }
  await browser.close();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
