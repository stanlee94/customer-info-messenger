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
  const userDataDir = path.join(OUT, 'chrome-profile2');
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

  await page.goto('https://ec2.full2house.com/Ent/index.php?live_id=556923&a=EntLive&m=liveingManager',
    { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForSelector('.ddr-card', { timeout: 60000 });
  await page.waitForTimeout(16000);

  const r = await page.evaluate(() => {
    // --- WCAG contrast --------------------------------------------------
    const lum = (rgb) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const parse = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
    const ratio = (fg, bg) => {
      const a = lum(parse(fg)), b = lum(parse(bg));
      return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05))).toFixed(2);
    };
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        n = n.parentElement;
      }
      return 'rgb(255,255,255)';
    };
    const check = (sel, label) => {
      const el = document.querySelector(sel);
      if (!el) return { label, missing: true };
      const cs = getComputedStyle(el);
      return { label, size: cs.fontSize, ratio: ratio(cs.color, bgOf(el)) };
    };

    const rows = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')];
    const carded = rows.filter((x) => x.querySelector('.ddr-card'));
    const heights = carded.map((x) => Math.round(x.getBoundingClientRect().height));
    const median = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)];

    // how many rows fit in the visible table viewport
    const tb = document.querySelector('.tab-body');
    const visible = tb ? Math.floor(tb.getBoundingClientRect().height / median) : null;

    return {
      rowsTotal: rows.length,
      carded: carded.length,
      retired: rows.filter((x) => x.dataset.rfmDone === '1' && !x.querySelector('.ddr-card')).length,
      unhandled: rows.length - carded.length - rows.filter((x) => x.dataset.rfmDone === '1' && !x.querySelector('.ddr-card')).length,
      medianRowHeight: median,
      rowsVisibleInViewport: visible,
      tonightPills: document.querySelectorAll('.ddr-tonight:not(.ddr-hide)').length,
      hints: {
        winback: document.querySelectorAll('.ddr-hint-warn').length,
        vip: document.querySelectorAll('.ddr-hint-vip').length,
        firstbuy: document.querySelectorAll('.ddr-hint-good').length,
      },
      emojiInCard: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(
        [...document.querySelectorAll('.ddr-card')].slice(0, 80).map((e) => e.textContent).join('')
      ),
      svgIcons: document.querySelectorAll('.ddr-card svg.ddr-ico').length,
      psidHiddenByDefault: getComputedStyle(document.querySelector('.ddr-psid')).opacity,
      tabularNums: getComputedStyle(document.querySelector('.ddr-card')).fontVariantNumeric,
      bars: document.querySelectorAll('.ddr-bar').length,
      barsLit: [1,2,3,4,5].map((n) => document.querySelectorAll('.ddr-bar-' + n).length),
      recBands: ['hot','warm','cool','cold'].map((b) => document.querySelectorAll('.ddr-rec-' + b).length),
      tiers: ['whale','champion','loyal','potential','newcust','attention','sleepy','risk','cold','new','unknown']
        .map((t) => t + ':' + document.querySelectorAll('.ddr-card.ddr-' + t).length).join(' '),
      chipText: (() => {
        const m = {};
        document.querySelectorAll('.ddr-chip').forEach((e) => { m[e.textContent] = (m[e.textContent]||0)+1; });
        return m;
      })(),
      mismatch: [...document.querySelectorAll('.ddr-card')].filter((c) => {
        const t = [...c.classList].find((x) => x.startsWith('ddr-') && x !== 'ddr-card');
        const txt = (c.querySelector('.ddr-chip') || {}).textContent || '';
        const key = txt.toLowerCase().replace(/[^a-z]/g, '');
        const map = { whales:'ddr-whale', champions:'ddr-champion', loyalcustomers:'ddr-loyal',
          potentialloyalists:'ddr-potential', promising:'ddr-potential', newcustomers:'ddr-newcust', needattention:'ddr-attention', abouttosleep:'ddr-sleepy',
          atrisk:'ddr-risk', cantlosethem:'ddr-risk', losthighspender:'ddr-risk',
          hibernating:'ddr-cold', lostcustomers:'ddr-cold', new:'ddr-new' };
        return map[key] && map[key] !== t;
      }).length,
      ltvSize: getComputedStyle(document.querySelector('.ddr-ltv')).fontSize,
      col: (() => {
        const tr=document.querySelector('#liveMessageDiv tbody > tr[id^="win_tr_"]');
        const tds=[...tr.querySelectorAll('td')]; const W=tr.getBoundingClientRect().width;
        const cells=[...document.querySelectorAll('#liveMessageDiv tbody td:nth-child(4)')];
        const names=[...document.querySelectorAll('.ddr-won-name')];
        const overflow=names.filter(n=>n.scrollWidth>n.clientWidth+1);
        const wonCells=cells.filter(c=>c.querySelector('.ddr-won'));
        const statusWrap=[...document.querySelectorAll('td .action-buttons')].filter(a=>a.querySelector('.cancelWin')&&a.getBoundingClientRect().height>34).length;
        return {
          widthsPct:[0,1,3].map(i=>Math.round(tds[i].getBoundingClientRect().width/W*100)),
          wonCellPx:Math.round((wonCells[0]||cells[0]).getBoundingClientRect().width),
          priceTextInWonCells: wonCells.filter(c=>/RM\s*\d/.test(c.querySelector('.ddr-won').innerText)).length,
          nameSpans:names.length, cssEllipsisTriggered:overflow.length,
          truncatedWithMiddle:names.filter(n=>n.textContent.includes('…')).length,
          statusRowWrapped:statusWrap,
          samples:[...document.querySelectorAll('.ddr-won-row')].slice(0,6).map(r=>r.innerText.replace(/\s+/g,' ').trim()),
        };
      })(),
      win: (() => {
        const rows=[...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]')];
        const wonRows=rows.filter(r=>r.querySelector('.cancelWin'));
        const vis=el=>!!el&&getComputedStyle(el).display!=='none';
        const wonWithItem=wonRows.filter(r=>vis(r.querySelector('.ddr-won')));
        const itemButNotWon=rows.filter(r=>!r.querySelector('.cancelWin')&&vis(r.querySelector('.ddr-won')));
        // does the item code match the comment the customer typed?
        let agree=0,disagree=0,samples=[];
        wonWithItem.forEach(r=>{
          const code=(r.querySelector('.ddr-won-code')||{}).textContent||''; if(r.querySelectorAll('.ddr-won-row').length>1) return;
          const msg=(r.querySelectorAll('td')[1].textContent||'').trim().toUpperCase();
          if(!code) return;
          if(msg.startsWith(code.toUpperCase())) agree++; else {disagree++; if(samples.length<3) samples.push(code+' vs '+msg.slice(0,20));}
        });
        // replay okWin's own DOM walk: $(this).parent().parent().prev().prev()
        const ok=[...document.querySelectorAll('.okWin')];
        const walkOk=ok.filter(a=>{
          const td=a.parentElement&&a.parentElement.parentElement;
          const target=td&&td.previousElementSibling&&td.previousElementSibling.previousElementSibling;
          return target && target===td.parentElement.querySelectorAll('td')[1];
        }).length;
        const ex=wonWithItem[0];
        return {
          okWinButtons: ok.length, okWinWalkIntact: walkOk,
          wonChips: document.querySelectorAll('td .action-buttons > span.green').length,
          cancelLinks: document.querySelectorAll('.cancelWin').length,
          wonRows: wonRows.length, wonRowsShowingItem: wonWithItem.length,
          itemShownOnUnwonRow: itemButNotWon.length,
          codeMatchesComment: agree, codeMismatch: disagree, mismatchSamples: samples,
          okWinHeight: ok[0]?Math.round(ok[0].getBoundingClientRect().height):null,
          example: ex ? ex.querySelectorAll('td')[3].innerText.replace(/\n+/g,' | ') : null,
          pillTitle: (document.querySelector('.ddr-tonight:not(.ddr-hide)')||{}).title,
        };
      })(),
      sinceTags: document.querySelectorAll('.ddr-since').length,
      sinceSample: [...document.querySelectorAll('.ddr-since')].slice(0,6).map(e=>e.textContent),
      sinceYears: (()=>{const m={};document.querySelectorAll('.ddr-since').forEach(e=>{const y=e.textContent.replace(/\D/g,'');m[y]=(m[y]||0)+1;});return m;})(),
      tonightPillText: (document.querySelector('.ddr-tonight:not(.ddr-hide)')||{}).textContent,
      tonightPillLabel: (document.querySelector('.ddr-tonight:not(.ddr-hide)')||{getAttribute:()=>null}).getAttribute('aria-label'),
      tonightNumSize: document.querySelector('.ddr-tonight-n') ? getComputedStyle(document.querySelector('.ddr-tonight-n')).fontSize : null,
      tonightPillWidth: document.querySelector('.ddr-tonight:not(.ddr-hide)') ? Math.round(document.querySelector('.ddr-tonight:not(.ddr-hide)').getBoundingClientRect().width) : null,
      nameSize: getComputedStyle(document.querySelector('.ddr-name')).fontSize,
      contrast: [
        check('.ddr-name', 'name'),
        check('.ddr-ltv:not(.ddr-ltv-none)', 'LTV headline'),
        check('.ddr-m', 'metric'),
        check('.ddr-chip', 'tier chip'),
        check('.ddr-tonight', 'tonight pill'),
        check('.ddr-rec-hot', 'recency HOT'),
        check('.ddr-rec-warm', 'recency WARM'),
        check('.ddr-rec-cool', 'recency COOL'),
        check('.ddr-rec-cold', 'recency COLD'),
        check('.ddr-hint-warn', 'hint WIN BACK'),
        check('.ddr-hint-vip', 'hint VIP'),
        check('.ddr-hint-good', 'hint BACK'),
        check('.okWin', '得标 button'),
        check('.action-buttons > span.green', '已得标 chip'),
        check('.cancelWin', '取消得标 link'),
        check('.ddr-won-name', 'won item name'),
        check('.ddr-msg-head th', 'table header'),
      ],
      sample: carded.slice(0, 6).map((x) => {
        const c = x.querySelector('.ddr-card');
        return {
          r1: c.querySelector('.ddr-r1').innerText.replace(/\s+/g, ' ').trim(),
          r2: c.querySelector('.ddr-r2').innerText.replace(/\s+/g, ' ').trim(),
        };
      }),
    };
  });

  // --- WHO'S IN THE LIVE ---------------------------------------------------
  // A button in the dock opens a centred modal (big type, list scrolls inside);
  // ×, the backdrop and Escape close it.
  const hiddenAtRest = await page.evaluate(() => document.querySelector('.ddr-who-overlay').hidden);
  await page.hover('.ddr-who-btn');
  await page.waitForTimeout(300);
  const hoverOpens = await page.evaluate(() => !document.querySelector('.ddr-who-overlay').hidden);
  await page.click('.ddr-who-btn');
  await page.waitForTimeout(300);
  const overlap = await page.evaluate((a) => {
    const pa = document.querySelector(".ddr-panel").getBoundingClientRect();
    const body = document.querySelector(".ddr-panel-body");
    const name = document.querySelector(".ddr-pname");
    return {
      hiddenAtRest: a.hiddenAtRest,
      hoverOpens: a.hoverOpens,
      openOnClick: !document.querySelector(".ddr-who-overlay").hidden,
      panel: {x:Math.round(pa.left),y:Math.round(pa.top),w:Math.round(pa.width),h:Math.round(pa.height)},
      centred: Math.abs((pa.left + pa.right) / 2 - innerWidth / 2) < 2 && Math.abs((pa.top + pa.bottom) / 2 - innerHeight / 2) < 2,
      fitsWindow: pa.top >= 0 && pa.bottom <= innerHeight,
      scrolls: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
      nameFontPx: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
      vipRows: document.querySelectorAll(".ddr-prow").length,
    };
  }, { hiddenAtRest, hoverOpens });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  overlap.closedOnEscape = await page.evaluate(() => document.querySelector('.ddr-who-overlay').hidden);
  await page.click('.ddr-who-btn');
  await page.mouse.click(8, 8);
  await page.waitForTimeout(200);
  overlap.closedOnBackdrop = await page.evaluate(() => document.querySelector('.ddr-who-overlay').hidden);
  // --- MESSENGER HISTORY ---------------------------------------------------
  // Clicking a customer's 留言用户 cell opens their EC2 Messenger history
  // (GET a=FBUser&m=dialog, read-only); the PSID copy button does not.
  const chatRow = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]:not(.ddr-own)')].find((r) => r.querySelector('.ddr-name'));
    return tr && tr.id;
  });
  const chatReqs = [];
  page.on('request', (q) => { if (/m=dialog|sendMessage/.test(q.url())) chatReqs.push(q.method() + ' ' + q.url().replace(/^.*[?&]m=/, '')); });
  let chatCheck = { row: !!chatRow };
  if (chatRow) {
    await page.locator(`#${chatRow} > td:first-child .ddr-name`).click();
    await page.waitForFunction(() => { const t = document.querySelector('.ddr-chat-top'); return t && !/Loading/.test(t.textContent); }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    chatCheck = await page.evaluate(() => {
      const o = document.querySelector('.ddr-chat-overlay');
      const b = o.querySelector('.ddr-chat-body');
      const p = o.querySelector('.ddr-chat').getBoundingClientRect();
      return {
        open: !o.hidden,
        name: o.querySelector('.ddr-chat-name').textContent,
        bubbles: o.querySelectorAll('.ddr-chat-row').length,
        inAndOut: [o.querySelectorAll('.ddr-chat-in').length, o.querySelectorAll('.ddr-chat-out').length],
        atNewest: Math.abs(b.scrollHeight - b.clientHeight - b.scrollTop) < 4,
        fitsWindow: p.top >= 0 && p.bottom <= innerHeight,
      };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    chatCheck.closedOnEscape = await page.evaluate(() => document.querySelector('.ddr-chat-overlay').hidden);
    await page.locator(`#${chatRow} .ddr-psid`).click({ force: true });
    await page.waitForTimeout(300);
    chatCheck.psidCopyDoesNotOpen = await page.evaluate(() => document.querySelector('.ddr-chat-overlay').hidden);
  }
  chatCheck.onlyGets = chatReqs.length > 0 && chatReqs.every((r) => r.startsWith('GET dialog'));
  console.log("\n=== MESSENGER HISTORY ===");
  Object.entries(chatCheck).forEach(([k, v]) => console.log("  " + k.padEnd(22), JSON.stringify(v)));

  console.log("\n=== WHO'S IN THE LIVE ===");
  Object.entries(overlap).forEach(([k,v])=>console.log("  "+k.padEnd(22), JSON.stringify(v)));

  const p = (k, v) => console.log('  ' + String(k).padEnd(24), v);
  console.log('=== COVERAGE ===');
  p('rows on page', r.rowsTotal);
  p('cards rendered', r.carded);
  p('own-page retired', r.retired);
  p('UNHANDLED', r.unhandled);

  console.log('\n=== DENSITY ===');
  p('median row height', r.medianRowHeight + 'px');
  p('rows visible at once', r.rowsVisibleInViewport);

  console.log('\n=== SIGNALS ===');
  p('tonight pills shown', r.tonightPills);
  p('WIN BACK hints', r.hints.winback);
  p('VIP hints', r.hints.vip);
  p('FIRST BUY hints', r.hints.firstbuy);

  console.log('\n=== DESIGN COMPLIANCE ===');
  p('emoji inside cards', r.emojiInCard ? 'FOUND (bad)' : 'none');
  p('SVG icons rendered', r.svgIcons);
  p('psid opacity at rest', r.psidHiddenByDefault);
  p('tabular figures', r.tabularNums);
  p('spend bars drawn', r.bars);
  p('bars by quintile 1-5', JSON.stringify(r.barsLit));
  p('recency hot/warm/cool/cold', JSON.stringify(r.recBands));
  p('tiers on screen', r.tiers);
  p('chip label counts', JSON.stringify(r.chipText));
  p('text/colour MISMATCHES', r.mismatch);
  p('LTV font size', r.ltvSize);
  console.log('\n=== COLUMNS / 得标 ITEM ===');
  Object.entries(r.col).forEach(([k,v])=>p(k, JSON.stringify(v)));
  console.log('\n=== 得标 CELL ===');
  Object.entries(r.win).forEach(([k,v])=>p(k, typeof v==='string'?v:JSON.stringify(v)));
  p('since-year tags', r.sinceTags);
  p('since samples', JSON.stringify(r.sinceSample));
  p('since year spread', JSON.stringify(r.sinceYears));
  p('tonight pill text', JSON.stringify(r.tonightPillText));
  p('tonight aria-label', JSON.stringify(r.tonightPillLabel));
  p('tonight number size', r.tonightNumSize);
  p('tonight pill width', r.tonightPillWidth + 'px');
  p('name font size', r.nameSize);

  console.log('\n=== WCAG CONTRAST (AA needs 4.5) ===');
  r.contrast.forEach((c) =>
    console.log('  ' + c.label.padEnd(16), c.missing ? 'MISSING' : `${String(c.ratio).padStart(6)}:1  @${c.size}  ${c.ratio >= 4.5 ? 'PASS' : 'FAIL'}`));

  console.log('\n=== SAMPLE ROWS ===');
  r.sample.forEach((s) => { console.log('   ' + s.r1); console.log('      ' + s.r2); });

  console.log('\n' + (errs.length ? '--- console errors ---\n  ' + errs.slice(0, 5).join('\n  ') : 'no console errors'));

  await page.screenshot({ path: path.join(OUT, 'redesign-'+(process.env.VW||1440)+'.png') });
  const cell = await page.$('#liveMessageDiv tbody tr td');
  if (cell) await page.locator('#liveMessageDiv tbody tr').first().screenshot({ path: path.join(OUT, 'row.png') });

  await ctx.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
