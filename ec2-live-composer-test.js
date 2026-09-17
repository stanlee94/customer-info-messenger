// Composer toggle check (read-only). NEVER clicks 留言 or presses Enter in
// #message - that would post a comment to the live. Typed text is local only
// and cleared before exit.
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
const VW = +(process.env.VW || 1440);
const VH = +(process.env.VH || 900);
let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

(async () => {
  const r = await fetch(process.env.BASEROW_URL.replace(/\/+$/, '') + `/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`,
    { headers: { Authorization: 'Token ' + process.env.BASEROW_TOKEN, 'User-Agent': UA } });
  const cookieStr = String(((await r.json()).results || []).find((x) => String(x.Name) === 'EC2').Value || '');
  const dir = path.join(EXT, 'chrome-profile-composer');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], viewport: { width: VW, height: VH } });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ ec2LiveEnabled: true }, res)));
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in
  await opt.close();
  await ctx.addCookies(cookieStr.split(';').map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: 'ec2.full2house.com', path: '/' }; }).filter((c) => c.name));
  const page = await ctx.newPage();
  const posts = [];
  // Only EC2 matters here: reads are the feed polls; anything else would be a write.
  page.on('request', (req) => { if (req.method() === 'POST' && /ec2\.full2house\.com/.test(req.url()) && !/getLivingMessage|getWinLists|liveGoods|getGroup|getLastGroups|get_cur_wins|ajax_getGroups/i.test(req.url())) posts.push(req.url() + ' ' + (req.postData() || '').slice(0, 80)); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('https://ec2.full2house.com/Ent/index.php?live_id=' + (process.env.TONIGHT || '556923') + '&a=EntLive&m=liveingManager', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.ddr-composer-btn', { timeout: 60000 });
  await page.waitForTimeout(8000);

  const state = () => page.evaluate(() => {
    const table = document.querySelector('.ddr-col-right .l-table');
    const foot = table.querySelector(':scope > .tab-foot');
    const body = table.querySelector(':scope > .tab-body');
    const btn = document.querySelector('.ddr-composer-btn');
    const f = foot.getBoundingClientRect(); const b = btn.getBoundingClientRect(); const bd = body.getBoundingClientRect();
    return { hidden: f.height < 1, footTop: f.top, bodyH: bd.height, btn: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
      expanded: btn.getAttribute('aria-expanded'), focused: document.activeElement && document.activeElement.id === 'message' };
  });

  console.log('\n== default ==');
  const s0 = await state();
  check(s0.hidden && s0.expanded === 'false', 'bar hidden on load');
  check(s0.btn.right <= VW && s0.btn.bottom <= VH && s0.btn.right > VW - 80 && s0.btn.bottom > VH - 80, 'round button at bottom right', JSON.stringify(s0.btn));
  await page.screenshot({ path: path.join(EXT, `composer-hidden-${VW}.png`) });

  // Last row reachable: scroll the list to the end, its 得标 cell must clear the button.
  const clear = await page.evaluate(() => {
    const body = document.querySelector('.ddr-col-right .l-table > .tab-body');
    body.scrollTop = body.scrollHeight;
    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr')];
    const last = rows[rows.length - 1].querySelectorAll('td');
    const cell = (last[3] || last[last.length - 1]).getBoundingClientRect();
    const b = document.querySelector('.ddr-composer-btn').getBoundingClientRect();
    return { overlap: !(cell.bottom <= b.top || cell.top >= b.bottom || cell.right <= b.left || cell.left >= b.right), cell: [Math.round(cell.top), Math.round(cell.bottom)], btn: [Math.round(b.top), Math.round(b.bottom)] };
  });
  check(!clear.overlap, 'scrolled to the end, the last row is not under the button', JSON.stringify(clear));
  await page.evaluate(() => { document.querySelector('.ddr-col-right .l-table > .tab-body').scrollTop = 0; });

  console.log('\n== reveal ==');
  await page.click('.ddr-composer-btn');
  await page.waitForTimeout(300);
  const s1 = await state();
  check(!s1.hidden && s1.focused && s1.expanded === 'true', 'button shows the bar and focuses the textarea');
  check(s1.bodyH < s0.bodyH, 'list gives the space back when hidden', `${Math.round(s0.bodyH)}px hidden vs ${Math.round(s1.bodyH)}px shown`);
  check(s1.btn.bottom <= s1.footTop, 'button moves above the bar', `btn bottom ${Math.round(s1.btn.bottom)} / bar top ${Math.round(s1.footTop)}`);
  await page.screenshot({ path: path.join(EXT, `composer-open-${VW}.png`) });

  // "Pointer off the bar": a point on EC2's own page (the comment table header).
  // Not (10, 10) - that is the Facebook video iframe since 结束直播 moved into the
  // video ···, and a headless jump straight into a cross-process iframe never
  // sends the page the bar's mouseleave.
  const awayFromBar = async () => {
    const p = await page.evaluate(() => { const r = document.querySelector('.ddr-msg-head, #searchMsg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(p.x, p.y, { steps: 5 });
  };
  console.log('\n== auto-hide ==');
  await page.keyboard.type('draft only');
  await page.evaluate(() => document.activeElement.blur());
  await awayFromBar();
  await page.waitForTimeout(1200);
  check(!(await state()).hidden, 'a draft keeps the bar open');
  await page.evaluate(() => { const t = document.getElementById('message'); t.value = ''; t.focus(); t.blur(); });
  await page.waitForTimeout(1200);
  check((await state()).hidden, 'empty + focus gone -> hides');

  await page.evaluate(() => document.getElementById('message').focus()); // e.g. EC2 replyComment
  await page.waitForTimeout(300);
  check(!(await state()).hidden, 'focusing the textarea from elsewhere reveals it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check((await state()).hidden, 'Escape on an empty box hides it');

  await page.click('.ddr-composer-btn');
  await page.waitForTimeout(200);
  await page.click('.ddr-composer-btn');
  await page.waitForTimeout(300);
  check((await state()).hidden, 'button toggles it closed again');

  check(posts.length === 0, 'no write requests', posts.slice(0, 3).join(' | '));
  check(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  await page.evaluate(() => { document.getElementById('message').value = ''; });
  console.log(`\n${failures ? failures + ' FAILED' : 'ALL PASSED'}`);
  await ctx.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
