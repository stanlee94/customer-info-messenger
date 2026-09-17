/**
 * EC2 live-page RFM overlay.
 *
 * Why this file exists
 * -------------------
 * The EC2 live manager (ec2.full2house.com ... m=liveingManager) polls
 * `a=EntLive&m=getLivingMessage` every 5s and renders each comment into
 * `#liveMessageDiv tbody` as `<tr id="win_tr_<fb_comment_id>">`.
 *
 * That JSON carries `fb_user_id` - the customer's PSID - but living.js only
 * PRINTS it for a hardcoded whitelist of entIds (4406, 7467, 9850, 43, ...).
 * Our entId is 9558, so the rendered DOM contains no PSID at all and there is
 * nothing to scrape. The payload also carries `is_new`, but that is dead for
 * us: the page sets entIdShowNew='0' and every row comes back is_new=0.
 *
 * So we run our own poll of the same endpoint, keep a comment_id -> PSID map,
 * resolve each PSID against the Baserow users table (RFM, LTV, order count),
 * and render a compact customer card into the row the page drew.
 *
 * Design brief: the host reads this while talking to camera, so a row must be
 * decodable in well under a second and as many customers as possible must fit
 * on screen. Layout follows the data-dense dashboard pattern - 8px padding,
 * 12-14px type, fixed metric columns, tabular figures, row hover.
 *
 * Read-only: we never call any EC2 write endpoint.
 */
(() => {
  'use strict';

  const q = new URLSearchParams(location.search);
  if (q.get('m') !== 'liveingManager') return;

  const LIVE_ID = q.get('live_id');
  if (!LIVE_ID) return;

  const ENDPOINT = `${location.origin}${location.pathname}?a=EntLive&m=getLivingMessage`;
  const POLL_MS = 5000;
  const TBODY_SEL = '#liveMessageDiv tbody';

  /** comment_id (and win_id) -> psid */
  const commentPsid = new Map();
  /** psid -> rfm record, or null once confirmed absent from Baserow */
  const rfmCache = new Map();
  /** psid -> display name from the comment feed */
  const psidName = new Map();
  /** Our Facebook page id (the feed's fb_account_id) - needed for EC2's Messenger history. */
  let pageAccountId = '';
  /** Our page's name as the feed prints it on our own posts - the page's sender name in Messenger history. */
  let pageName = '';
  /** comment ids whose row is on screen but not yet badged */
  const pending = new Set();
  /** psids awaiting a Baserow lookup */
  const queue = new Set();
  /**
   * psids whose lookup is in flight right now. Without this, a psid stays
   * absent from rfmCache until its response lands, so every poll tick and every
   * re-badge in between queues it AGAIN - measured at 1,236 lookups for 613
   * actual people on a cold load.
   */
  const inflight = new Set();
  /** row keys belonging to our own page posts - never badged */
  const ownRows = new Set();
  /**
   * What each customer won, reconstructed from the comment feed we already
   * poll. EC2 sends no product list, but its auto-reply names the product.
   *
   * The reply comes in SIX shapes, and treating it as one broke things:
   *   665  得(J7)标 ... 标组名称：X  标组金额：108.00      normal single win
   *    21  恭喜您成功得标 ... 标组名称：X  标组金额：…      no code in title
   *     9  标组名称: X \n 标组名称: Y \n …                ONE comment winning
   *                                                     several products - no
   *                                                     price, one win_id only
   *     7  标组名称：X, no price
   *    14  成功修改…当前得标为：（J30）标,标组名称：（X），标组金额：（9.90）
   *                                                     a modified win,
   *                                                     bracketed fields
   * plus ~26% of wins with no reply at all (manual 得标).
   *
   * Two bugs came from reading it naively: a multi-product reply has no price
   * line, and parsing it as one set J16's price to 0 for everyone (36 rows
   * showed RM 0.00); and a comment like "J16+1 J17+1" showed only J16 because
   * EC2 puts a single win_id/group_id on the row.
   *
   * So: the catalogue (name -> code, price) is learned only from replies that
   * pin ONE product, a price is never invented from a missing field, and the
   * reply's product list - not the customer's text - decides what was won
   * ("J4 J5 J6 J7" can win only three). The message only supplies quantities.
   * Verified on live 556923: 980 of 981 won items fully resolved, 24 products.
   */
  const catalog = new Map();
  /** group_id -> product name, for wins that arrive with no reply */
  const groupName = new Map();
  /** win_id -> raw win, resolved at render time so later catalogue data applies */
  const winRaw = new Map();
  /** row key (comment id or win id) -> win_id */
  const rowWin = new Map();
  /** psid -> Map(productKey -> { code, name, qty, amount }) */
  let productsByPsid = new Map();
  /** fb_comment_id -> product codes in the comment text ("J7+2 J8+1" -> [J7, J8]) */
  const rowCodes = new Map();
  /** code -> product names, rebuilt with the products (reverse of catalog) */
  let codeNames = new Map();
  /** false until the first feed (the whole live) is in - its wins are covered by the full records load */
  let feedPrimed = false;

  /**
   * The parser state for one live. Tonight's lives in these maps; an earlier
   * live picked in the batch picker gets a fresh set, so both go through the
   * exact same harvest/winItems code and can never disagree.
   */
  const LIVE_CTX = { catalog, groupName, winRaw, rowWin };

  /** Baserow cost of this page load, shown in the panel header tooltip. */
  const lookupStats = { cacheHits: 0, fetched: 0, requests: 0 };

  let lastTime = '';
  let lookupBusy = false;
  let configError = null;

  // ---------------------------------------------------------------- icons
  // SVG, not emoji: emoji render differently per platform and cannot be
  // recoloured by the tier tokens.

  const ico = (paths, extra) =>
    `<svg class="ddr-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"` +
    `${extra || ''}>${paths}</svg>`;

  const ICO_CART = ico(
    '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>' +
      '<path d="M2 3h2.5l2.6 12.1a1.8 1.8 0 0 0 1.8 1.4h8.8a1.8 1.8 0 0 0 1.8-1.4L21 7H5.2"/>'
  );
  const ICO_ALERT = ico(
    '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>'
  );
  const ICO_CROWN = ico('<path d="M3 18h18"/><path d="M3 18 5 7l4.5 4L12 5l2.5 6L19 7l2 11"/>');
  const ICO_SPARK = ico('<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>');

  // ---------------------------------------------------------------- format

  /**
   * Compact currency. "RM 48.8k" is read in a glance; "RM 48,824.00" is not,
   * and at these widths the cents are noise. Exact figures stay in the tooltip.
   */
  const money = (n) => {
    // Round to the cent first: summed prices drift (501.4999… showed as RM 501
    // for a RM 501.50 total).
    const v = Math.round(Number(n || 0) * 100) / 100;
    if (v >= 1e6) return 'RM ' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
    if (v >= 1e3) return 'RM ' + (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return 'RM ' + v.toFixed(0);
  };

  const moneyFull = (n) =>
    'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const daysSince = (dateStr) => {
    if (!dateStr) return null;
    const t = Date.parse(String(dateStr).slice(0, 10) + 'T00:00:00+08:00');
    if (!Number.isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  };

  const agoLabel = (dateStr) => {
    const d = daysSince(dateStr);
    if (d === null) return '';
    if (d <= 0) return 'today';
    if (d < 60) return `${d}d`;
    const m = Math.floor(d / 30);
    return m < 24 ? `${m}mo` : `${Math.floor(d / 365)}y`;
  };

  /** Baserow segments carry a leading emoji; the chip supplies its own colour. */
  const segLabel = (seg) =>
    String(seg || 'Customer')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
      .trim() || 'Customer';

  /** Middle-truncate the PSID - the tail is what makes it recognisable. */
  const shortPsid = (p) => (p.length > 12 ? `${p.slice(0, 5)}…${p.slice(-4)}` : p);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Segmentation comes from Baserow's RFM_Score and nothing else.
   *
   * An earlier version re-derived a tier here from R_Score/M_Score. That was a
   * mistake: it produced a SECOND taxonomy that disagreed with the words on the
   * chip - 89% of customers labelled "At Risk" were being coloured as merely
   * dormant, and 37% of "Champions" were coloured as whales. The card now says
   * exactly what Baserow says, and this table only chooses the colour for each
   * of those labels. No arithmetic, no second opinion.
   *
   * Keys are the segment text lowercased with emoji, punctuation and spacing
   * removed, so "🚨 Cant Lose Them" and "Can't Lose Them" both resolve.
   *
   * All 13 values were taken from a full scan of table 749 (39,479 rows), not a
   * sample - an 8,000-row sample missed "New Customers" and "Promising". Any
   * value added to the Baserow formula later still renders, as `unknown`.
   */
  const SEGMENTS = {
    whales:             { tier: 'whale',     hint: 'vip' },
    champions:          { tier: 'champion' },
    loyalcustomers:     { tier: 'loyal' },
    potentialloyalists: { tier: 'potential' },
    promising:          { tier: 'potential' },
    newcustomers:       { tier: 'newcust' },
    needattention:      { tier: 'attention' },
    abouttosleep:       { tier: 'sleepy',    back: true },
    atrisk:             { tier: 'risk',      hint: 'winback' },
    cantlosethem:       { tier: 'risk',      hint: 'winback' },
    losthighspender:    { tier: 'risk',      hint: 'winback' },
    hibernating:        { tier: 'cold',      back: true },
    lostcustomers:      { tier: 'cold',      back: true },
  };

  const segKey = (seg) => segLabel(seg).toLowerCase().replace(/[^a-z]/g, '');

  /** Unknown labels still render - they just get a neutral chip. */
  const segInfo = (rfm) => {
    if (!rfm) return { tier: 'new' };
    return SEGMENTS[segKey(rfm.segment)] || { tier: 'unknown' };
  };

  const tierOf = (rfm) => segInfo(rfm).tier;

  /**
   * The one-word instruction, also driven by the Baserow segment.
   */
  const hintOf = (rfm, tier, tonight) => {
    const info = segInfo(rfm);
    if (info.hint === 'winback') return { text: 'WIN BACK', icon: ICO_ALERT, kind: 'warn' };
    if (info.hint === 'vip') return { text: 'VIP', icon: ICO_CROWN, kind: 'vip' };
    // A customer Baserow had written off is buying again right now.
    if (info.back && tonight > 0) return { text: 'BACK', icon: ICO_SPARK, kind: 'good' };
    return null;
  };

  const tonightLabel = (n) => `${n} product${n === 1 ? '' : 's'} won tonight`;

  /**
   * Tenure. The year they first bought is a stronger loyalty cue than a day
   * count - "since 2022" lands instantly where "1,378d" does not. Comes from
   * First_Purchase_Date, already in the record, so it costs no extra lookup.
   */
  const sinceTag = (firstDate) => {
    const year = String(firstDate || '').slice(0, 4);
    if (!/^\d{4}$/.test(year)) return '';
    const d = daysSince(firstDate);
    return `<span class="ddr-m ddr-since" ${tipAttr({
      h: `Customer since ${year}`,
      rows: [['First purchase', fmtDay(firstDate)], ['Tenure', d == null ? '—' : tenureLabel(d)]],
    })}>` +
      `${year}</span>`;
  };

  /**
   * Spend quintile as a 5-segment bar. Baserow already computes M_Score, so the
   * bar is the same number the RFM model uses - no invented scale. A bar is
   * read pre-attentively: from across the room it registers as a shape before
   * any digit is legible, which a line of grey text never does.
   */
  const QUINTILE = ['no purchases yet', 'bottom 20% of spenders', 'lower 40% of spenders',
    'middle 20% of spenders', 'top 40% of spenders', 'top 20% of spenders'];
  const spendBar = (m, ltv) => {
    const lit = Math.max(0, Math.min(5, Math.round(m || 0)));
    let seg = '';
    for (let i = 1; i <= 5; i += 1) seg += `<i class="${i <= lit ? 'on' : ''}"></i>`;
    const spec = lit
      ? { h: `Spend level ${lit} of 5`, s: QUINTILE[lit],
          rows: [['Lifetime spend', moneyFull(ltv)]], foot: 'Baserow M score (spend quintile)' }
      : { h: 'Spend level —', s: QUINTILE[0] };
    return `<span class="ddr-bar ddr-bar-${lit}" ${tipAttr(spec)} ` +
      `role="img" aria-label="spend level ${lit} of 5">${seg}</span>`;
  };

  /**
   * Recency as a colour-coded tag. The day count stays IN the tag - colour is
   * never the only carrier of meaning (WCAG 1.4.1).
   */
  const recencyTag = (dateStr, orderSn) => {
    const d = daysSince(dateStr);
    const label = agoLabel(dateStr);
    if (d === null || !label) return '';
    const band = d <= 7 ? 'hot' : d <= 30 ? 'warm' : d <= 90 ? 'cool' : 'cold';
    // The order itself (items, quantities) loads from Baserow on first hover -
    // see loadLastOrder.
    return `<span class="ddr-rec ddr-rec-${band}"` +
      (orderSn ? ` data-ddr-order="${escapeHtml(orderSn)}"` : '') +
      ` data-ddr-last="${escapeHtml(dateStr)}" ${tipAttr(lastOrderTip(dateStr, orderSn))}>` +
      `${escapeHtml(label)}</span>`;
  };

  // ------------------------------------------------------------ last order
  //
  // Hover the recency tag ("12d") -> the customer's latest order: order ID,
  // date and time, total, and every item with quantity and amount.
  //
  // Baserow, never EC2: EC2 archives old orders, Baserow keeps them all.
  // Table 749's 'Latest Order ID' (already in the RFM record) names the order;
  // background.js GET_BASEROW_ORDER reads it from 750 and its items from 751.
  // Loaded on first hover only (2 reads), then kept for the page's life.

  /** orderSn -> { state: 'loading' | 'done' | 'missing' | 'error', order } */
  const lastOrders = new Map();

  /** "2026-09-05T07:02:16Z" (UTC) -> "5 Sep 2026 · 15:02" Malaysia time. */
  const fmtOrderTime = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return fmtDay(iso);
    // Older rows carry a date only, stored as 00:00:00 UTC - no real time.
    if (/T00:00:00(\.0+)?Z$/.test(iso)) return fmtDay(iso);
    const m = new Date(t + 8 * 3600 * 1000).toISOString().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
    return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]} · ${m[4]}`;
  };

  function lastOrderTip(dateStr, orderSn) {
    const d = daysSince(dateStr);
    const h = d <= 0 ? 'Last purchase today' : `Last purchase ${d} day${d === 1 ? '' : 's'} ago`;
    const entry = orderSn && lastOrders.get(orderSn);
    if (!orderSn) return { h, rows: [['Date', fmtDay(dateStr)]] };
    if (!entry || entry.state === 'loading') {
      return { h, s: `Order ${orderSn}`, rows: [['Date', fmtDay(dateStr)]], foot: 'Loading order from Baserow…' };
    }
    if (entry.state !== 'done') {
      return {
        h, s: `Order ${orderSn}`, rows: [['Date', fmtDay(dateStr)]],
        foot: entry.state === 'missing' ? 'Order not found in Baserow.' : 'Could not load the order - hover again to retry.',
      };
    }
    const o = entry.order;
    const units = o.items.reduce((a, it) => a + it.qty, 0);
    const itemsSum = o.items.reduce((a, it) => a + (parseFloat(it.subtotal) || 0), 0);
    // Total_Amount includes postage, item subtotals do not (RM 10 on the
    // orders checked) - shown as its own line so the figures add up.
    const extra = (parseFloat(o.total) || 0) - itemsSum;
    const rows = [
      ['Date', fmtOrderTime(o.date)],
      ['Items', `${o.items.length} product${o.items.length === 1 ? '' : 's'} · ${units} unit${units === 1 ? '' : 's'}`],
    ];
    if (Math.abs(extra) >= 0.005) rows.push(['Items subtotal', moneyFull(itemsSum)], [extra > 0 ? 'Postage & fees' : 'Discount', moneyFull(Math.abs(extra))]);
    rows.push(['Total', moneyFull(o.total)]);
    return {
      h,
      s: `Order ${o.orderSn}`,
      rows,
      items: o.items.map((it) => ({
        code: '',
        name: it.description && !it.name.includes(it.description) ? `${it.description} ${it.name}` : it.name,
        qty: it.qty,
        amount: moneyFull(it.subtotal),
      })),
    };
  }

  function paintLastOrder(orderSn) {
    document.querySelectorAll(`.ddr-rec[data-ddr-order="${CSS.escape(orderSn)}"]`).forEach((el) => {
      el.dataset.ddrTip = JSON.stringify(lastOrderTip(el.dataset.ddrLast, orderSn));
    });
    refreshTip();
  }

  function loadLastOrder(orderSn) {
    const entry = lastOrders.get(orderSn);
    if (entry && (entry.state === 'loading' || entry.state === 'done' || entry.state === 'missing')) return;
    lastOrders.set(orderSn, { state: 'loading' });
    paintLastOrder(orderSn);
    chrome.runtime.sendMessage({ type: 'GET_BASEROW_ORDER', orderSn }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) lastOrders.set(orderSn, { state: 'error' });
      else if (!resp.found) lastOrders.set(orderSn, { state: 'missing' });
      else lastOrders.set(orderSn, { state: 'done', order: resp.order });
      paintLastOrder(orderSn);
    });
  }

  // Hover (or focus) starts the load; the bubble itself is the shared #ddr-tip.
  ['mouseover', 'focusin'].forEach((type) => {
    document.addEventListener(type, (e) => {
      const tag = e.target.closest && e.target.closest('.ddr-rec[data-ddr-order]');
      if (tag) loadLastOrder(tag.dataset.ddrOrder);
    });
  });

  // ---------------------------------------------------------------- polling

  /** One page of the comment feed; empty `since` = the whole live. null on failure. */
  async function fetchFeed(since, liveId = LIVE_ID) {
    const body = new URLSearchParams({ live_id: liveId, lastTime: since });
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: body.toString(),
      });
      if (!res.ok) return null;
      const json = JSON.parse(await res.text());
      return (json && json.data && json.data.list) || [];
    } catch (err) {
      return null; // transient - the next tick retries
    }
  }

  // EC2 stores some comments 10-80 s after newer ones (measured on 557246), and
  // lastTime filters on comment_created_time, so each poll asks for this much
  // overlap; ingest() is idempotent for comments it has already seen.
  const FEED_OVERLAP_MS = 180000;
  const feedSince = (t) => {
    const ms = Date.parse(String(t).replace(' ', 'T') + '+08:00');
    if (!t || !Number.isFinite(ms)) return t;
    const d = new Date(ms - FEED_OVERLAP_MS + 8 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  };

  async function poll() {
    const list = await fetchFeed(feedSince(lastTime));
    if (list && list.length) {
      list.forEach((x) => { if (String(x.comment_created_time || '') > lastTime) lastTime = String(x.comment_created_time); });
      ingest(list);
    }
    // Every tick, not only when comments arrive: the case it catches is an
    // old comment changing state, which brings no new comment with it.
    findOrphanWins();
    // Same for 取消得标 clicked on this page: living.js swaps the cell back to
    // 得标 without reloading, and on a quiet live no poll brings rows, so this
    // must not wait for ingest(). A DOM scan - no request unless a win flipped.
    reconcileCancelled();
  }

  /**
   * `full` = this list is the whole live, so any win it no longer carries has
   * been cancelled or moved and is dropped. An incremental page cannot say
   * that - it only holds new comments.
   */
  function ingest(list, full) {
    /** products whose EC2 wins may have changed in this batch of rows */
    const changed = new Set();
    for (const row of list) {
      if (row.fb_account_id && !pageAccountId) pageAccountId = String(row.fb_account_id);
      const psid = String(row.fb_user_id || '');
      if (!psid || psid === String(row.fb_account_id)) {
        // Our own broadcasts. Remember their row keys so badgeRow can retire
        // them instead of re-queueing every tick forever.
        if (row.fb_comment_id) ownRows.add(String(row.fb_comment_id));
        if (row.fb_user_name && !pageName) pageName = String(row.fb_user_name).trim();
        for (const winKey of [row.win_id, row.hit_live_win_id]) {
          if (winKey && String(winKey) !== '0') ownRows.add(String(winKey));
        }
        continue;
      }

      // Rows come in two shapes. Comments the page polls during the live are
      // drawn as id="win_tr_<fb_comment_id>". Rows rendered by the server on
      // load (and by "load more") use id="win_tr_<win_id>" and carry the
      // comment id in data-index. Index every key so both shapes resolve.
      const commentId = String(row.fb_comment_id);
      const seenBefore = commentPsid.has(commentId);
      const winBefore = rowWin.get(commentId) || '';
      commentPsid.set(commentId, psid);
      for (const winKey of [row.win_id, row.hit_live_win_id]) {
        if (winKey && String(winKey) !== '0') commentPsid.set(String(winKey), psid);
      }
      if (row.fb_user_name) psidName.set(psid, row.fb_user_name);
      const codes = Object.keys(qtyByCode(row.message));
      if (codes.length) rowCodes.set(String(row.fb_comment_id), codes);

      harvest(row, psid);
      // A win in the feed is only a hint that this customer's EC2 records
      // changed; the numbers come from 得标结果 (see "EC2 win records"). Only
      // what is NEW counts: a full re-read (findOrphanWins) re-delivers every
      // old win, and treating those as hints queued a read for ~394 customers.
      const winNow = row.win_id && String(row.win_id) !== '0' ? String(row.win_id) : '';
      if (feedPrimed && ((!seenBefore && (winNow || row.reply_message)) || (seenBefore && winNow !== winBefore))) {
        rowGroupIds(row).forEach((g) => changed.add(g));
      }

      if (!rfmCache.has(psid) && !inflight.has(psid)) queue.add(psid);
    }

    if (full) {
      // Collect first, then prune: a modified win keeps its win_id but moves
      // to a newer comment, so deleting while walking would drop it whenever
      // the old comment is visited after the new one.
      const current = new Set(list.map((r) => String(r.win_id || '')).filter((w) => w && w !== '0'));
      [...winRaw.keys()].forEach((w) => {
        if (!current.has(w)) winRaw.delete(w);
      });
    }

    changed.forEach(scheduleGroupWins);
    feedPrimed = true;
    rebuildProducts();
    drainQueue();
    badgeAll();
    reconcileCancelled();
    refreshTallies();
    renderPanel();
    fitWinCells();
  }

  /**
   * Safety net for a win we cannot see arrive.
   *
   * Every manual win path in living.js (得标, batch 得标, edit qty, edit price,
   * re-award after 取消) ends in window.location.reload(), and the page's own
   * win poll (getWinLists) is disabled - so in normal use a win always reaches
   * us through the feed. The one case the incremental poll would miss is a
   * win the server attaches to a comment the feed has ALREADY delivered
   * without one: its row shows 取消得标 but we hold no win for it.
   *
   * Only that exact state triggers one full re-read of the feed. Comments the
   * feed has not delivered yet are left to the next tick (that is just the
   * page drawing the row first), each row triggers at most one re-read, and
   * re-reads are at least RESYNC_MS apart - the full feed is ~2.2k rows.
   */
  const RESYNC_MS = 30000;
  const resyncTried = new Set();
  let resyncBusy = false;
  let lastResync = 0;

  function findOrphanWins() {
    if (resyncBusy || Date.now() - lastResync < RESYNC_MS) return;
    const orphans = [];
    document.querySelectorAll(TBODY_SEL + ' > tr[id^="win_tr_"]').forEach((tr) => {
      const key = tr.dataset.index || tr.id.replace(/^win_tr_/, '');
      if (!key || resyncTried.has(key) || ownRows.has(key) || !commentPsid.has(key)) return;
      const cell = tr.querySelectorAll('td')[3];
      if (!cell || !cell.querySelector('.cancelWin')) return;
      const winId = rowWin.get(key);
      if (winId && winRaw.has(winId)) return;
      orphans.push(key);
    });
    if (!orphans.length) return;

    orphans.forEach((k) => resyncTried.add(k));
    resyncBusy = true;
    lastResync = Date.now();
    fetchFeed('').then((list) => {
      resyncBusy = false;
      // Ingest without moving lastTime: the incremental cursor stays its own.
      if (list && list.length) ingest(list, true);
    });
  }

  function drainQueue() {
    if (lookupBusy || !queue.size || configError) return;
    lookupBusy = true;
    const psids = [...queue];
    queue.clear();
    psids.forEach((p) => inflight.add(p));

    chrome.runtime.sendMessage({ type: 'GET_LIVE_RFM_BATCH', psids }, (resp) => {
      lookupBusy = false;
      psids.forEach((p) => inflight.delete(p));
      if (chrome.runtime.lastError || !resp) return; // released above, will retry
      if (!resp.ok) {
        configError = resp.error || 'Baserow lookup failed';
        renderPanel();
        return;
      }
      Object.entries(resp.found || {}).forEach(([psid, rfm]) => rfmCache.set(psid, rfm));
      (resp.missing || []).forEach((psid) => rfmCache.set(psid, null));
      if (resp.stats) {
        lookupStats.cacheHits += resp.stats.cacheHits || 0;
        lookupStats.fetched += resp.stats.fetched || 0;
        lookupStats.requests += resp.stats.requests || 0;
      }
      badgeAll();
      renderPanel();
      if (queue.size) drainQueue();
    });
  }

  // ---------------------------------------------------------------- the card

  function tonightHtml(psid) {
    const n = productCount(psid);
    // Icon + quantity only. The word "tonight" was the widest part of the pill
    // and the least informative - the cart glyph already says what the number
    // counts. The full sentence stays in title/aria-label so the meaning is not
    // lost for screen readers or a first-time viewer.
    return (
      `<span class="ddr-tonight${n ? '' : ' ddr-hide'}" data-psid="${psid}" ` +
      `${tipAttr(tonightTip(psid, n))} aria-label="${tonightLabel(n)}">` +
      `${ICO_CART}<span class="ddr-tonight-n">${n}</span>` +
      `<span class="ddr-tonight-amt">${escapeHtml(tonightAmount(psid))}</span></span>`
    );
  }

  /** Tonight's total for the pill - blank until every won item has a known price. */
  function tonightAmount(psid) {
    const items = [...(productsByPsid.get(psid) || new Map()).values()];
    if (!items.length || items.some((it) => it.amount == null)) return '';
    return money(items.reduce((a, it) => a + it.amount, 0));
  }

  /**
   * "Already bought tonight" moves during the live but cards are built once,
   * so the count is refreshed in place on every poll.
   */
  // Once per customer, not per row (a customer's pill repeats on each of
  // their comments), and only changed values are written back to the DOM.
  function refreshTallies() {
    const memo = new Map();
    const setText = (node, v) => { if (node && node.textContent !== v) node.textContent = v; };
    document.querySelectorAll('.ddr-tonight').forEach((el) => {
      const psid = el.dataset.psid;
      let t = memo.get(psid);
      if (!t) {
        const n = productCount(psid);
        t = { n, num: String(n), amt: tonightAmount(psid), tip: JSON.stringify(tonightTip(psid, n)), label: tonightLabel(n) };
        memo.set(psid, t);
      }
      setText(el.querySelector('.ddr-tonight-n'), t.num);
      setText(el.querySelector('.ddr-tonight-amt'), t.amt);
      if (el.dataset.ddrTip !== t.tip) el.dataset.ddrTip = t.tip;
      if (el.getAttribute('aria-label') !== t.label) el.setAttribute('aria-label', t.label);
      if (el.classList.contains('ddr-hide') !== (t.n === 0)) el.classList.toggle('ddr-hide', t.n === 0);
    });
    refreshTip();
  }

  const COUNTRY = { my: 'Malaysia', sg: 'Singapore' };

  /** Round flag for where the customer ships to (Baserow address, see background.js). */
  function countryFlag(rfm) {
    const cc = rfm && rfm.country;
    if (!COUNTRY[cc]) return '';
    return `<span class="ddr-flag ddr-flag-${cc}" role="img" aria-label="Ships to ${COUNTRY[cc]}" ` +
      `${tipAttr({ h: `Ships to ${COUNTRY[cc]}`, s: rfm.address || '', foot: 'Latest shipping address' })}></span>`;
  }

  function cardHtml(psid, rfm, name) {
    const tier = tierOf(rfm);
    const tonight = productCount(psid);
    const hint = hintOf(rfm, tier, tonight);

    const r1 =
      countryFlag(rfm) +
      `<span class="ddr-name">${escapeHtml(name || psid)}</span>` +
      `<span class="ddr-chip">${escapeHtml(rfm ? segLabel(rfm.segment) : 'New')}</span>` +
      (hint ? `<span class="ddr-hint ddr-hint-${hint.kind}">${hint.icon}${hint.text}</span>` : '') +
      `<span class="ddr-grow"></span>` +
      // Zero-width slot before the pill: the button floats left over line 1's
      // spare width on hover, so it never costs the name any space.
      `<span class="ddr-psid-slot"><button type="button" class="ddr-psid" data-psid="${psid}" ` +
      `${tipAttr({ h: 'PSID', mono: psid, foot: 'Click to copy' })}>${escapeHtml(shortPsid(psid))}</button></span>` +
      tonightHtml(psid);

    let metrics;
    if (!rfm || rfm.orderCount === 0) {
      // Keep the empty bar so the money column still lines up down the table.
      metrics =
        '<span class="ddr-ltv ddr-ltv-none">—</span>' +
        spendBar(0, 0) +
        '<span class="ddr-m ddr-m-empty">no purchase yet</span>';
    } else {
      const aov = rfm.ltv / rfm.orderCount;
      // The RFM triplet moved to the tooltip: it is reference data, not
      // something to decode from two feet away.
      metrics =
        `<span class="ddr-ltv" ${tipAttr({
          h: 'Lifetime spend', v: moneyFull(rfm.ltv),
          rows: [['Orders', String(rfm.orderCount)], ['RFM score', String(rfm.rfm || '—')],
            ['Recency · Frequency · Money', `R${rfm.r} · F${rfm.f} · M${rfm.m}`]],
        })}>` +
        `${escapeHtml(money(rfm.ltv))}</span>` +
        spendBar(rfm.m, rfm.ltv) +
        `<span class="ddr-m ddr-aov" ${tipAttr({
          h: 'Average order value', v: moneyFull(aov),
          rows: [['Lifetime spend', moneyFull(rfm.ltv)], ['Orders', String(rfm.orderCount)]],
        })}>` +
        `<span class="ddr-u">Ø</span>${escapeHtml(money(aov))}</span>` +
        `<span class="ddr-m ddr-m-ord">${rfm.orderCount}<span class="ddr-u">×</span></span>` +
        sinceTag(rfm.firstPurchaseDate) +
        recencyTag(rfm.lastOrderDate, rfm.latestOrderId);
    }

    // Batch chip: filled in place by fillBatchChip, hidden until a ticked live has this customer.
    const r2 = metrics + '<span class="ddr-grow"></span>' +
      `<span class="ddr-batch ddr-hide" data-psid="${psid}"></span>`;

    return (
      `<div class="ddr-card ddr-${tier}">` +
      `<div class="ddr-r1">${r1}</div><div class="ddr-r2">${r2}</div>` +
      `</div>`
    );
  }

  const stripTags = (v) => String(v || '').replace(/<[^>]+>/g, '');

  /** Every 标组名称 in a reply - bracketed （NAME） or plain to end of line. */
  function replyNames(reply) {
    const out = [];
    const re = /标组名称\s*[：:]\s*(?:（(.*?)）(?=\s*[，,\r\n]|\s*$)|([^\r\n，,]+))/g;
    let m;
    while ((m = re.exec(String(reply || '')))) {
      const v = (m[1] != null ? m[1] : m[2]).trim();
      if (v) out.push(v);
    }
    return out;
  }

  const replyNumber = (reply, label) => {
    const m = String(reply || '').match(new RegExp(label + '\\s*[：:]\\s*（?\\s*([\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  };

  function replyCode(reply) {
    const r = String(reply || '');
    const m = r.match(/得\((\w+)\)标/) || r.match(/当前得标为\s*[：:]\s*（\s*(\w+)\s*）/);
    return m ? m[1].toUpperCase() : null;
  }

  /** "J16+1 j17+2" -> { J16: 1, J17: 2 }. HTML stripped, case folded. */
  function qtyByCode(message) {
    const o = {};
    const re = /([A-Za-z]+\d+)\s*\+\s*(\d+)/g;
    const text = stripTags(message);
    let m;
    while ((m = re.exec(text))) {
      const c = m[1].toUpperCase();
      o[c] = (o[c] || 0) + parseInt(m[2], 10);
    }
    return o;
  }

  const codeBelongsToOther = (code, name, cat) => {
    for (const [n, v] of cat) if (v.code === code && n !== name) return true;
    return false;
  };

  function harvest(row, psid, ctx = LIVE_CTX) {
    const { catalog, groupName, winRaw, rowWin } = ctx;
    const reply = row.reply_message || '';
    const names = replyNames(reply);
    const groupId = String(row.group_id || row.hit_live_group_id || '');

    // Learn the catalogue only from replies that pin exactly one product.
    if (names.length === 1) {
      const name = names[0];
      if (groupId && groupId !== '0') groupName.set(groupId, name);
      const prev = catalog.get(name) || {};
      let code = replyCode(reply);
      if (!code && !prev.code) {
        // No code anywhere in the reply (one product's replies never carry
        // it). Take the customer's code only when it is unambiguous and not
        // already claimed by a different product.
        const codes = Object.keys(qtyByCode(row.message));
        if (codes.length === 1 && !codeBelongsToOther(codes[0], name, catalog)) code = codes[0];
      }
      const price = replyNumber(reply, '标组金额');
      catalog.set(name, {
        code: code || prev.code || null,
        // Never invent a price from a missing field - that is the RM 0.00 bug.
        price: price != null ? price : prev.price != null ? prev.price : null,
      });
    }

    // win_id is the CURRENT win. hit_live_win_id is history: when the host
    // cancels a win (取消得标), EC2 clears win_id but leaves hit_live_win_id
    // behind. Falling back to it counted cancelled wins - 33 of them across 30
    // customers on live 556923, e.g. a J8 the customer had asked to swap for J9.
    const winId = String(row.win_id || '');
    if (!winId || winId === '0') return;
    winRaw.set(winId, {
      psid,
      groupId,
      names,
      qty: qtyByCode(row.message),
      winnum: parseInt(row.winnum, 10) || 0,
      // EC2's charged total, only meaningful when the reply is for one product.
      amount: names.length === 1 ? replyNumber(reply, '订单金额') : null,
    });
    rowWin.set(String(row.fb_comment_id), winId);
    rowWin.set(winId, winId);
  }

  /** The products one win covers - one for a normal win, several for "J16+1 J17+1". */
  function winItems(raw, ctx = LIVE_CTX) {
    const { catalog, groupName } = ctx;
    let names = raw.names;
    if (!names.length) {
      const n = groupName.get(raw.groupId);
      names = n ? [n] : [];
    }
    const multi = names.length > 1;
    return names.map((name) => {
      const c = catalog.get(name) || {};
      const code = c.code || null;
      // winnum only describes the first product of a multi-product comment,
      // so each product takes its own quantity from the message there.
      const qty = multi
        ? (code && raw.qty[code]) || 1
        : raw.winnum || (code && raw.qty[code]) || 1;
      let amount = null;
      if (!multi && raw.amount != null) amount = raw.amount;
      else if (c.price != null) amount = c.price * qty;
      return { key: code || name, code, name, qty, amount };
    });
  }

  /**
   * Group every win by customer and PRODUCT. The pill counts distinct products
   * (A1..A30 caps it at 30), so winning J29 in two comments counts once, with
   * the quantities summed. EC2 moves a win when a comment is modified rather
   * than leaving the old one behind (14 of 14 verified), so summing is safe.
   */
  function groupWins(ctx) {
    const next = new Map();
    ctx.winRaw.forEach((raw) => {
      let bucket = next.get(raw.psid);
      if (!bucket) next.set(raw.psid, (bucket = new Map()));
      winItems(raw, ctx).forEach((it) => {
        const cur = bucket.get(it.key);
        if (!cur) bucket.set(it.key, { ...it });
        else {
          cur.qty += it.qty;
          cur.amount = cur.amount != null && it.amount != null ? cur.amount + it.amount : null;
        }
      });
    });
    return next;
  }

  /**
   * code -> product names, for matching a comment's codes to products. EC2's
   * own records decide first (tonightWins.codes); the comment catalogue only
   * fills codes EC2 has no record for yet. productsByPsid is NOT built here -
   * it comes from EC2's 得标结果 records only (applyTonightWins).
   */
  function rebuildProducts() {
    codeNames = new Map();
    const add = (code, name) => {
      if (!code) return;
      const list = codeNames.get(code) || [];
      if (!list.includes(name)) list.push(name);
      codeNames.set(code, list);
    };
    tonightWins.codes.forEach((code, name) => add(code, name));
    catalog.forEach((v, name) => {
      if (!codeNames.has(v.code)) add(v.code, name);
    });
  }

  const productCount = (psid) => (productsByPsid.get(psid) || new Map()).size;

  /**
   * The poll only returns NEW comments, so a win cancelled after this page
   * loaded is never re-sent. The page itself shows it, though: EC2 swaps
   * 取消得标 back to a 得标 button. Read that instead of asking the server.
   * Only the unambiguous state counts - .okWin present and .cancelWin gone -
   * so a cell caught mid re-render is never mistaken for a cancellation.
   */
  function reconcileCancelled() {
    let changed = false;
    document.querySelectorAll(TBODY_SEL + ' > tr').forEach((tr) => {
      const key = tr.dataset.index || (tr.id || '').replace(/^win_tr_/, '');
      const winId = key && rowWin.get(key);
      if (!winId || !winRaw.has(winId)) return;
      const cell = tr.querySelectorAll('td')[3];
      if (!cell || cell.querySelector('.cancelWin') || !cell.querySelector('.okWin')) return;
      scheduleGroupWins(winRaw.get(winId).groupId);
      winRaw.delete(winId);
      changed = true;
    });
    if (changed) rebuildProducts();
  }

  /** Structured version of the 🛒 pill: totals, then one line per product. */
  /** J2 before J10, codes before unknowns - the order of EC2's goods list. */
  const byCode = (a, b) => {
    const pa = String(a.code || '').match(/^([A-Z]*)(\d*)/);
    const pb = String(b.code || '').match(/^([A-Z]*)(\d*)/);
    if (!a.code !== !b.code) return a.code ? -1 : 1;
    return pa[1].localeCompare(pb[1]) || (+pa[2] || 0) - (+pb[2] || 0) || String(a.name).localeCompare(String(b.name));
  };

  const tonightTip = (psid, n) => {
    // Sorted, not in arrival order: a win that lands mid-live used to go to the
    // end and, in a height-capped bubble, straight into "+ N more".
    const items = [...(productsByPsid.get(psid) || new Map()).values()].sort(byCode);
    const source = tonightWins.loadedAt
      ? `From EC2's win records · checked ${clock(tonightWins.polledAt)}`
      : 'Loading EC2 win records…';
    if (!items.length) return { h: tonightLabel(n), foot: source };
    const units = items.reduce((a, it) => a + it.qty, 0);
    const priced = items.every((it) => it.amount != null);
    const total = items.reduce((a, it) => a + (it.amount || 0), 0);
    return {
      h: 'Won tonight',
      v: priced ? moneyFull(total) : null,
      rows: [['Products', String(items.length)], ['Units', String(units)]],
      items: items.map((it) => ({
        code: it.code || '?', name: it.name, qty: it.qty,
        amount: it.amount != null ? moneyFull(it.amount) : null,
      })),
      foot: (priced ? '' : 'Some prices are missing, so no total. ') + source,
    };
  };

  /**
   * CJK glyphs render about twice as wide as Latin ones at the same size, so a
   * plain character count would truncate Chinese names far too late.
   */
  const glyphUnits = (ch) => (/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1);

  /**
   * "胎菊 Chrysanthemum Buds 100g" -> "胎菊 Chry…ds 100g". The middle goes, not
   * the end: the start names the product and the end is usually the pack size
   * (100g, 500g, 4罐), which is what tells two similar products apart.
   */
  function middleTruncate(text, maxUnits) {
    const chars = [...String(text || '')];
    const total = chars.reduce((a, c) => a + glyphUnits(c), 0);
    if (total <= maxUnits) return text;
    const room = Math.max(4, maxUnits - 1);
    const headRoom = Math.ceil(room * 0.56);
    const tailRoom = room - headRoom;
    let head = '';
    let used = 0;
    for (const c of chars) {
      if (used + glyphUnits(c) > headRoom) break;
      head += c;
      used += glyphUnits(c);
    }
    let tail = '';
    used = 0;
    for (let i = chars.length - 1; i >= 0; i -= 1) {
      if (used + glyphUnits(chars[i]) > tailRoom) break;
      tail = chars[i] + tail;
      used += glyphUnits(chars[i]);
    }
    return head.trimEnd() + '…' + tail.trimStart();
  }

  /**
   * How many glyph units fit in the name slot of this cell, from its real
   * width - the column is a percentage, so a fixed count would overflow on a
   * small screen and waste space on a large one.
   */
  // Every 得标 cell has the column's width, so it is measured once, not per
  // row: a getBoundingClientRect per won row after a new comment forced a
  // layout of the whole table each time (237 of 304 ms at 1,579 rows, live
  // 557246). Reset on resize/Flip; the 2 s tick re-checks it (checkWonWidth).
  let wonCellWidth = 0;

  function nameBudget(cell) {
    if (!wonCellWidth) wonCellWidth = cell.getBoundingClientRect().width || 0;
    const w = wonCellWidth || 190;
    // cell padding (10px + 20px, clear of the overlay scrollbar) + code tag +
    // ×qty + gaps; ~6.6px per unit at 12.5px
    return Math.max(8, Math.floor((w - 102) / 6.6));
  }

  /**
   * The products won, shown in the 得标 cell of the row that won them.
   *
   * It is appended to the cell BESIDE .action-buttons, never inside or around
   * it: living.js rewrites .action-buttons' innerHTML on every 得标/取消 click,
   * and its okWin handler finds the comment text by walking
   * .parent().parent().prev().prev() - so wrapping or reordering anything here
   * would break manual 得标. Visibility is left to CSS (:has(.cancelWin)), so a
   * cancelled win hides itself without us having to notice the click.
   */
  function decorateWin(tr) {
    const key = tr.dataset.index || (tr.id || '').replace(/^win_tr_/, '');
    const winId = rowWin.get(key) || rowWin.get((tr.id || '').replace(/^win_tr_/, '')) || '';
    const cell = tr.querySelectorAll('td')[3];
    if (!cell) return;

    // EC2's records for THIS comment (same customer + comment time, or the
    // row's own win id). Nothing is shown from the comment text.
    const items = rowWinItems(key, winId);
    if (!items.length) {
      const stale = cell.querySelector('.ddr-won');
      if (stale) stale.remove();
      return;
    }

    // Re-render when resolution improves or the column width changes.
    const budget = nameBudget(cell);
    const sig = key + '|' + budget + '|' + items.map((it) => it.key + ':' + it.qty).join(',');
    const existing = cell.querySelector('.ddr-won');
    if (existing && existing.dataset.sig === sig) return;
    if (existing) existing.remove();

    cell.insertAdjacentHTML(
      'beforeend',
      '<div class="ddr-won" data-sig="' + escapeHtml(sig) + '">' +
        items
          .map((it) =>
            '<div class="ddr-won-row" ' + tipAttr({
              h: it.name,
              rows: [['Code', it.code || '—'], ['Quantity', '×' + it.qty],
                ['Amount', it.amount != null ? moneyFull(it.amount) : 'price not known yet']],
            }) + '>' +
            (it.code ? '<b class="ddr-won-code">' + escapeHtml(it.code) + '</b>' : '') +
            // No price here by design - the cell answers "what did they take";
            // amounts live in the 🛒 tooltip.
            '<span class="ddr-won-name" data-full="' + escapeHtml(it.name) + '">' +
            escapeHtml(middleTruncate(it.name, budget)) + '</span>' +
            '<span class="ddr-won-qty">×' + it.qty + '</span>' +
            '</div>')
          .join('') +
      '</div>'
    );
    fitWonNames(cell);
  }

  /**
   * The unit budget is an estimate (glyph widths vary by script and weight).
   * Where a name still overflows, shorten it (from data-full) until it fits,
   * so the middle truncation is never topped with a second CSS ellipsis.
   *
   * A name drawn while its row was hidden measures 0 and cannot be fitted
   * then, and the column can settle a few px narrower after first render
   * (1280px: 38 names). So the 2s tick (fitAllWonNames) re-checks every
   * visible name; a name that fits costs one read and no write.
   */
  function fitWonNames(root) {
    root.querySelectorAll('.ddr-won-name').forEach((el) => {
      if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1) return;
      const full = el.dataset.full || el.textContent;
      // Floor of 4 units, not 8: at 1280px a CJK-heavy name like 【4罐…85g
      // still ran 2px over at 8.
      let b = [...full].length * 2;
      while (b > 4 && el.scrollWidth > el.clientWidth + 1) {
        b = Math.floor(Math.min(b, units(el.textContent)) * 0.9);
        el.textContent = middleTruncate(full, b);
      }
    });
  }

  const units = (s) => [...String(s)].reduce((a, c) => a + glyphUnits(c), 0);

  function fitAllWonNames() {
    const body = document.querySelector('.ddr-msg-body');
    if (body) fitWonNames(body);
  }

  /** One read every 2 s: when the 得标 column settled to another width, redraw the won names. */
  function checkWonWidth() {
    const cell = document.querySelector(`${TBODY_SEL} > tr > td:nth-child(4) .ddr-won`);
    const w = cell ? cell.parentElement.getBoundingClientRect().width : 0;
    if (!w || Math.abs(w - wonCellWidth) < 1) return;
    wonCellWidth = w;
    badgeAll();
  }

  /**
   * On a narrow screen (1280px: the 得标 cell is ~167px) "✓ 已得标" and
   * "取消得标" do not fit on one line, the link wraps and every won row grows
   * to 86px. The label cannot be rewritten - living.js owns .action-buttons -
   * so CSS swaps its visible text for "取消" under .ddr-win-compact (the real
   * text stays in the DOM for screen readers).
   *
   * Decided by measuring an actual wrap rather than a breakpoint, because the
   * cell width depends on the window, zoom and font. Re-decided on resize.
   */
  let winFitDone = false;

  function fitWinCells() {
    if (winFitDone) return;
    const body = document.querySelector('.ddr-msg-body');
    if (!body) return;
    const cells = [...body.querySelectorAll('td:nth-child(4) .action-buttons')]
      .filter((ab) => ab.querySelector(':scope > span.green') && ab.querySelector('.cancelWin'))
      .slice(0, 20);
    if (!cells.length) return; // no won row yet - try again next tick

    body.classList.remove('ddr-win-compact');
    const wraps = cells.some((ab) => {
      const s = ab.querySelector(':scope > span.green').getBoundingClientRect();
      const c = ab.querySelector('.cancelWin').getBoundingClientRect();
      return c.width > 0 && c.top >= s.bottom - 2;
    });
    body.classList.toggle('ddr-win-compact', wraps);
    winFitDone = true;
  }

  // ---------------------------------------------------------------- badging

  function badgeRow(tr) {
    if (tr.dataset.rfmDone === '1') return;
    // data-index holds the fb_comment_id on server-rendered rows; rows injected
    // during the live carry it only in the element id.
    const id = tr.dataset.index || (tr.id || '').replace(/^win_tr_/, '');
    if (!id) return;

    if (ownRows.has(id)) {
      decorateOwnRow(tr);
      tr.dataset.rfmDone = '1';
      pending.delete(id);
      return;
    }

    const psid = commentPsid.get(id);
    if (!psid) {
      pending.add(id); // row drawn before our poll saw it
      return;
    }
    if (!rfmCache.has(psid)) {
      pending.add(id);
      if (!inflight.has(psid)) queue.add(psid);
      return;
    }

    const cell = tr.querySelector('td');
    if (!cell) return;

    // EC2 prints the display name as a bare text node in this cell. Take it
    // over so the name can sit on the same line as the tier chip instead of
    // costing a line of its own - but keep the node in the DOM (hidden) rather
    // than deleting something living.js wrote.
    let name = '';
    const origin = document.createElement('span');
    origin.className = 'ddr-orig';
    [...cell.childNodes].forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE && n.textContent.trim()) {
        name += n.textContent.trim();
        origin.appendChild(n);
      }
    });
    if (!name) name = psidName.get(psid) || '';
    if (origin.childNodes.length) cell.insertBefore(origin, cell.firstChild);

    const rfm = rfmCache.get(psid);
    cell.insertAdjacentHTML('beforeend', cardHtml(psid, rfm, name));

    const chip = cell.querySelector('.ddr-batch');
    if (chip) fillBatchChip(chip);

    const btn = cell.querySelector('.ddr-psid');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(psid).then(() => {
          btn.classList.add('ddr-copied');
          setTimeout(() => btn.classList.remove('ddr-copied'), 900);
        });
      });
    }

    tr.dataset.rfmDone = '1';
    tr.classList.add(`ddr-row-${tierOf(rfm)}`);
    pending.delete(id);
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * "2026-09-16 23:05:33" -> "23:05:33", or "16 Sep · 23:05:33" when the comment
   * is not from today (a live that runs past midnight, or a replay next day).
   */
  function formatCommentTime(raw) {
    const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/);
    if (!m) return String(raw).trim();
    const now = new Date();
    const today = +m[1] === now.getFullYear() && +m[2] === now.getMonth() + 1 && +m[3] === now.getDate();
    return today ? m[4] : `${+m[3]} ${MONTHS[+m[2] - 1]} · ${m[4]}`;
  }

  /**
   * The 留言时间 column stays hidden (CSS) and in place - living.js walks cells
   * positionally. The time is shown under the comment via a data attribute and
   * ::after, NOT a child node: okWin posts the comment cell's .html() to EC2 as
   * the win message, so any element added inside it would be sent too.
   */
  function decorateTime(tr) {
    if (tr.dataset.ddrTime) return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 3 || cells[1].hasAttribute('colspan')) return;
    const raw = cells[2].textContent.trim();
    if (!raw) return;
    cells[1].dataset.ddrTime = formatCommentTime(raw);
    tr.dataset.ddrTime = '1';
  }

  // "J30+?" - the code-and-placeholder shape our price-list broadcasts use.
  const OWN_CODE_RE = /\b([A-Z]{1,3})(\d{1,3})\s*\+\s*\?/g;

  /**
   * One line standing in for a broadcast: the codes it lists when it is a
   * price list ("22 products · J1 J2 …"), otherwise its lines joined by " · ".
   */
  function ownPreview(text) {
    const seen = new Map();
    for (const m of text.matchAll(OWN_CODE_RE)) seen.set(m[1] + m[2], [m[1], +m[2]]);
    if (seen.size >= 2) {
      const codes = [...seen.values()]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
        .map(([p, n]) => p + n);
      return `${codes.length} products · ${codes.join(' ')}`;
    }
    return text.split('\n').map((s) => s.trim()).filter(Boolean).join(' · ');
  }

  /**
   * Our page's own comments (多多养身站 broadcasts) are mostly the full
   * J1-J30 price list, 1,400px+ a row, and say nothing about a customer.
   * Collapse them to a two-line preview with a Show more toggle.
   *
   * Same rule as decorateTime: the comment cell gets attributes only, never a
   * child node. The preview and the toggle label are ::before/::after, and
   * the original text is shrunk to nothing by CSS until expanded.
   */
  function decorateOwnRow(tr) {
    if (tr.classList.contains('ddr-own')) return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 3 || cells[1].hasAttribute('colspan')) return;
    tr.classList.add('ddr-own');
    const cell = cells[1];
    if (cell.dataset.ddrTime) cells[0].dataset.ddrTime = cell.dataset.ddrTime;

    const text = cell.textContent.trim();
    const lines = text.split('\n').filter((s) => s.trim());
    // A single-product post (name + two price lines, ~4 lines) is already
    // short: collapsing it just hides the same text behind a Show more that
    // reveals nothing new. Only the multi-product lists are worth folding.
    if (lines.length <= 6 && text.length <= 200) return;

    cell.dataset.ddrPreview = ownPreview(text);
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const open = tr.classList.toggle('ddr-own-open');
      cell.setAttribute('aria-expanded', String(open));
    };
    cell.addEventListener('click', () => {
      // Selecting text to copy it is not a request to collapse.
      if (String(window.getSelection() || '')) return;
      toggle();
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggle();
    });
  }

  /**
   * Two-colour banding by customer: consecutive comments from the same PSID
   * share a band, and the band flips when the customer changes. It replaces
   * EC2's positional zebra, which alternates regardless of who commented.
   *
   * Only two colours, never one per customer: with ~12 hues, 158 of 1,942
   * different-customer neighbours on live 556923 would share a colour - 3x the
   * 48 genuine same-customer pairs - so a per-PSID colour would mostly lie.
   *
   * A band is assigned once and never recomputed: new comments arrive at the
   * top, and deriving parity from the top would repaint every row on every
   * comment. Each new row takes its band from the neighbour that already has
   * one - the row below for new comments, the row above for "load more".
   * Own broadcasts and rows whose PSID is not known yet are skipped, so a run
   * continues across them.
   */
  function paintBands() {
    const chain = [];
    document.querySelectorAll(`${TBODY_SEL} > tr[id^="win_tr_"]`).forEach((tr) => {
      if (tr.classList.contains('ddr-own')) return;
      const psid = commentPsid.get(tr.dataset.index || tr.id.replace(/^win_tr_/, ''));
      if (psid) chain.push({ tr, psid });
    });
    if (!chain.length) return;

    const derive = (row, from) => {
      const band = from.tr.dataset.ddrBand;
      row.tr.dataset.ddrBand = row.psid === from.psid ? band : band === 'a' ? 'b' : 'a';
    };
    if (!chain.some((r) => r.tr.dataset.ddrBand)) chain[0].tr.dataset.ddrBand = 'a';
    for (let i = 1; i < chain.length; i += 1) {
      if (!chain[i].tr.dataset.ddrBand && chain[i - 1].tr.dataset.ddrBand) derive(chain[i], chain[i - 1]);
    }
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      if (!chain[i].tr.dataset.ddrBand && chain[i + 1].tr.dataset.ddrBand) derive(chain[i], chain[i + 1]);
    }
  }

  function decorateRow(tr) {
    decorateTime(tr);
    badgeRow(tr);
    decorateWin(tr);
    decoratePrev(tr);
  }

  function badgeAll() {
    document.querySelectorAll(`${TBODY_SEL} > tr[id^="win_tr_"]`).forEach(decorateRow);
    paintBands();
  }

  /**
   * New rows only. living.js prepends a row per comment and never removes one,
   * so re-decorating every row per comment grew with the live (76 ms freeze
   * per comment at 1,500 rows). Data changes (wins, RFM, batch) still run
   * badgeAll from their own paths; a big insert (Refresh, load more) does too.
   */
  function badgeAdded(records) {
    const rows = [];
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType === 1 && n.tagName === 'TR' && /^win_tr_/.test(n.id)) rows.push(n);
      });
    }
    if (!rows.length) return;
    if (rows.length > 100) return badgeAll();
    rows.forEach(decorateRow);
    paintBands();
  }

  // ------------------------------------------------------------ VIP panel

  let panel;

  /**
   * `N known · N new` sits beside the 留言用户 column label, not in the panel
   * bar, so the docked bar stays short. The header is a separate table that
   * living.js never reads (okWin walks the body rows), so a child span is safe.
   */
  function liveCountNode() {
    const th = document.querySelector('.ddr-msg-head thead th, .ddr-msg-head th');
    if (!th) return null;
    let node = th.querySelector('.ddr-live-count');
    if (!node) {
      node = document.createElement('span');
      node.className = 'ddr-live-count';
      th.appendChild(node);
    }
    return node;
  }

  function renderPanel() {
    if (!panel) return;

    if (configError) {
      panel.querySelector('.ddr-panel-body').innerHTML =
        `<div class="ddr-empty">${escapeHtml(configError)}</div>`;
      return;
    }

    const seen = new Map();
    for (const psid of new Set(commentPsid.values())) {
      const rfm = rfmCache.get(psid);
      if (rfm) seen.set(psid, rfm);
    }

    const ranked = [...seen.values()].sort((a, b) => b.ltv - a.ltv).slice(0, 15);
    const newCount = [...new Set(commentPsid.values())].filter((p) => rfmCache.get(p) === null).length;

    const count = liveCountNode();
    if (count) count.textContent = `${seen.size} known · ${newCount} new`;
    if (count) count.dataset.ddrTip = JSON.stringify({
      h: 'Customers in this live',
      rows: [['In Baserow', String(seen.size)], ['New (not in Baserow)', String(newCount)],
        ['RFM reused from cache', String(lookupStats.cacheHits)], ['RFM fetched', String(lookupStats.fetched)],
        ['Baserow requests', String(lookupStats.requests)]],
      foot: 'Values refresh once per day, matching the Baserow rollup.',
    });

    const body = panel.querySelector('.ddr-panel-body');
    let batchLine = '';
    if (batchActive()) {
      const { came, bought } = batchCounts();
      batchLine = `<div class="ddr-panel-batch">${ICO_CHAT}Batch · <b>${came}</b> came back · <b>${bought}</b> already won</div>`;
    }
    if (!ranked.length) {
      body.innerHTML = batchLine + '<div class="ddr-empty">Waiting for comments…</div>';
      return;
    }

    body.innerHTML = batchLine + ranked
      .map((r) => {
        const tier = tierOf(r);
        const n = productCount(r.psid);
        return (
          `<div class="ddr-prow ddr-${tier}">` +
          `<div class="ddr-pname">${escapeHtml(r.name || psidName.get(r.psid) || r.psid)}` +
          (n ? `<span class="ddr-ptonight">${ICO_CART}${n}</span>` : '') +
          `</div>` +
          `<div class="ddr-pmeta">${escapeHtml(segLabel(r.segment))} · ` +
          `<b>${escapeHtml(money(r.ltv))}</b> · ${r.orderCount}× · ` +
          `${escapeHtml(agoLabel(r.lastOrderDate) || '—')}</div>` +
          `</div>`
        );
      })
      .join('');
  }

  // The panel used to be a draggable, collapsible bar; it is now a modal
  // opened from the card's ··· tray. Drop what those versions stored.
  try {
    localStorage.removeItem('ddrPanelPos');
    localStorage.removeItem('ddrPanelCollapsed.v2');
  } catch (err) {
    /* ignore */
  }

  const FLIP_KEY = 'ddrLayoutFlip';
  let dock = null;
  let whoBtn = null;
  let panelOverlay = null;

  /**
   * "Who's in the live" is a centred modal opened from the ··· tray - big
   * type for reading at a distance, the list scrolls inside it. Closes on ×,
   * a click on the backdrop, or Escape.
   */
  function buildPanel() {
    panelOverlay = mk('div', 'ddr-who-overlay');
    panelOverlay.hidden = true;
    panel = document.createElement('div');
    panel.className = 'ddr-panel';
    panel.id = 'ddr-who-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'ddr-who-title');
    panel.innerHTML =
      '<div class="ddr-panel-head">' +
      '<span class="ddr-panel-title" id="ddr-who-title">Who\'s in the live</span>' +
      '<button class="ddr-panel-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="ddr-panel-body" tabindex="0"><div class="ddr-empty">Waiting for comments…</div></div>';
    panel.querySelector('.ddr-panel-close').addEventListener('click', hidePanel);
    panelOverlay.addEventListener('click', (e) => {
      if (e.target === panelOverlay) hidePanel();
    });
    panelOverlay.appendChild(panel);
    document.body.appendChild(panelOverlay);
  }

  function showPanel() {
    if (!panelOverlay || !panelOverlay.hidden) return;
    panelOverlay.hidden = false;
    whoBtn.setAttribute('aria-expanded', 'true');
    renderPanel();
    panel.querySelector('.ddr-panel-body').scrollTop = 0;
    panel.querySelector('.ddr-panel-close').focus();
  }

  function hidePanel() {
    if (!panelOverlay || panelOverlay.hidden) return;
    panelOverlay.hidden = true;
    whoBtn.setAttribute('aria-expanded', 'false');
    (whoBtn.offsetParent ? whoBtn : moreBtn || whoBtn).focus();
  }

  function applyFlip(on, flipBtn) {
    document.documentElement.classList.toggle('ddr-flip', on);
    flipBtn.setAttribute('aria-pressed', String(on));
  }

  /**
   * Card tools, in the live controls card (.l-group-btn): [⇄ Flip] and [···]
   * sit beside the live name; ··· opens the "More" tray inside the card with
   * the things not used during a live - 竞标开始 (run by someone else),
   * Who's in the live, EC2's 标组管理 / 新增标组 / 得标结果 / 抽奖, and the
   * 自动刷新 ▾ under 刷新. Only our nodes are added; EC2's buttons stay where
   * living.js put them and are shown or hidden by html.ddr-more-open (CSS).
   * The tray closes on a click outside it, Escape, or after any item in it.
   */
  let moreBtn = null;

  function setMore(open) {
    document.documentElement.classList.toggle('ddr-more-open', open);
    if (moreBtn) moreBtn.setAttribute('aria-expanded', String(open));
  }

  function installDock() {
    const group = document.querySelector('.ddr-col-left .l-group-btn');
    if (!group || dock) return;
    dock = group;

    const flipBtn = document.createElement('button');
    flipBtn.type = 'button';
    flipBtn.className = 'ddr-card-tool ddr-flip-btn';
    flipBtn.setAttribute('aria-label', 'Flip layout');
    flipBtn.innerHTML = ico('<path d="M7 4 3 8l4 4"/><path d="M3 8h13"/><path d="m17 12 4 4-4 4"/><path d="M21 16H8"/>');
    let flipped = false;
    try {
      flipped = localStorage.getItem(FLIP_KEY) === '1';
    } catch (err) {
      /* ignore */
    }
    applyFlip(flipped, flipBtn);
    flipBtn.addEventListener('click', () => {
      const on = !document.documentElement.classList.contains('ddr-flip');
      applyFlip(on, flipBtn);
      try {
        localStorage.setItem(FLIP_KEY, on ? '1' : '0');
      } catch (err) {
        /* ignore */
      }
      // Fixed-position pieces (composer button, open bubbles) follow the columns.
      window.dispatchEvent(new Event('resize'));
    });
    group.appendChild(flipBtn);

    moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'ddr-card-tool ddr-more-btn';
    moreBtn.setAttribute('aria-label', 'More: 竞标开始, Who\'s in the live, EC2 pages');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML = ico('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>');
    moreBtn.addEventListener('click', () => setMore(!document.documentElement.classList.contains('ddr-more-open')));
    group.appendChild(moreBtn);

    whoBtn = document.createElement('button');
    whoBtn.type = 'button';
    whoBtn.className = 'ddr-who-btn';
    whoBtn.setAttribute('aria-haspopup', 'dialog');
    whoBtn.setAttribute('aria-expanded', 'false');
    whoBtn.setAttribute('aria-controls', 'ddr-who-panel');
    whoBtn.innerHTML =
      ico('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.8c1.7.7 2.8 2.4 3 5.2"/>') +
      '<span>Who\'s in the live</span>';
    whoBtn.addEventListener('click', () => (panelOverlay.hidden ? showPanel() : hidePanel()));
    group.appendChild(whoBtn);

    const menu = document.querySelector('.ddr-goods .ddr-refresh-row .dropdown-menu');
    const trayItem = (el) =>
      el.closest('.ddr-who-btn, .ddr-col-left .l-group-btn > .btn') ||
      (menu && menu.contains(el) && el.closest('a, li'));
    // After the click has reached EC2's own handler.
    document.addEventListener('click', (e) => {
      if (document.documentElement.classList.contains('ddr-more-open') && trayItem(e.target)) setMore(false);
    });
    document.addEventListener('mousedown', (e) => {
      if (!document.documentElement.classList.contains('ddr-more-open')) return;
      if (group.contains(e.target)) return;
      const toggle = document.querySelector('.ddr-goods #refresh + .dropdown-toggle');
      if ((toggle && toggle.contains(e.target)) || (menu && menu.contains(e.target))) return;
      setMore(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelOverlay && !panelOverlay.hidden) {
        e.stopPropagation();
        hidePanel();
      } else if (e.key === 'Escape' && document.documentElement.classList.contains('ddr-more-open')) {
        e.stopPropagation();
        setMore(false);
        moreBtn.focus();
      }
    }, true);
  }

  /**
   * EC2's 结束直播 and 跑马灯 sit over the top of the video (absolutely placed
   * divs in the left column, click handlers bound by id in living.js) and
   * cover Facebook's LIVE / viewer badge. Both are hidden (CSS, never moved)
   * behind a small ··· button at the top right of the video; opening it shows
   * them stacked under it. Closes on a click outside, Escape, or after either.
   */
  let vidMenuBtn = null;

  function setVidMenu(open) {
    document.documentElement.classList.toggle('ddr-vid-menu-open', open);
    if (vidMenuBtn) vidMenuBtn.setAttribute('aria-expanded', String(open));
  }

  function installVideoMenu() {
    const col = document.querySelector('.ddr-col-left');
    if (!col || vidMenuBtn) return;
    vidMenuBtn = document.createElement('button');
    vidMenuBtn.type = 'button';
    vidMenuBtn.className = 'ddr-vid-more';
    vidMenuBtn.setAttribute('aria-label', 'More: 结束直播, 跑马灯');
    vidMenuBtn.setAttribute('aria-expanded', 'false');
    vidMenuBtn.innerHTML = ico('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>');
    vidMenuBtn.addEventListener('click', () => setVidMenu(!document.documentElement.classList.contains('ddr-vid-menu-open')));
    col.appendChild(vidMenuBtn);

    const items = () => [document.getElementById('endLiveBtnDiv'), document.getElementById('edit_marquee_div')].filter(Boolean);
    const isOpen = () => document.documentElement.classList.contains('ddr-vid-menu-open');
    document.addEventListener('click', (e) => {
      if (isOpen() && items().some((d) => d.contains(e.target) && e.target.closest('button'))) setVidMenu(false);
    });
    document.addEventListener('mousedown', (e) => {
      if (!isOpen() || vidMenuBtn.contains(e.target) || items().some((d) => d.contains(e.target))) return;
      setVidMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        e.stopPropagation();
        setVidMenu(false);
        vidMenuBtn.focus();
      }
    }, true);
  }

  /**
   * Video stats badge, top left of the video: LIVE + viewers, then likes ·
   * comments · shares. EC2's Facebook plugin prints these once at load and
   * never updates them; background.js GET_FB_VIDEO_STATS re-reads the
   * plugin page's server HTML every VSTATS_MS instead - the video itself is
   * never reloaded. Hidden until the first answer; the last figures stay
   * (dimmed) if a read fails.
   */
  const VSTATS_MS = 5000;
  let vstatsEl = null;

  function installVideoStats() {
    const col = document.querySelector('.ddr-col-left');
    const frame = document.querySelector('.l-iframe iframe[src*="facebook.com/plugins/video.php"]');
    if (!col || !frame || vstatsEl) return;
    const url = frame.getAttribute('src').replace(/&amp;/g, '&');

    vstatsEl = mk('div', 'ddr-vstats');
    vstatsEl.hidden = true;
    vstatsEl.setAttribute('role', 'status');
    vstatsEl.innerHTML =
      '<div class="ddr-vstats-top">' +
      '<span class="ddr-vstats-live">LIVE</span>' +
      '<span class="ddr-vstats-viewers">' + ico('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>') + '<b></b></span>' +
      '<span class="ddr-vstats-elapsed" hidden></span>' +
      '</div>' +
      '<div class="ddr-vstats-row">' +
      '<span data-k="likes">' + ico('<path d="M7 10v11H3V10h4z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v4h5.6a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.3 21H7"/>') + '<b></b></span>' +
      '<span data-k="comments">' + ico('<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>') + '<b></b></span>' +
      '<span data-k="shares">' + ico('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>') + '<b></b></span>' +
      '</div>';
    col.appendChild(vstatsEl);

    let last = null;
    let busy = false;
    // Broadcast start on this machine's clock, from the live manifest's
    // elapsed time (asked for only until known); the timer ticks locally.
    let startAt = null;
    const hh = (n) => String(n).padStart(2, '0');
    const elapsedText = () => {
      const s = Math.max(0, Math.floor((Date.now() - startAt) / 1000));
      const h = Math.floor(s / 3600);
      return (h ? `${h}:${hh(Math.floor(s / 60) % 60)}` : String(Math.floor(s / 60))) + ':' + hh(s % 60);
    };
    const tickElapsed = () => {
      const el = vstatsEl.querySelector('.ddr-vstats-elapsed');
      el.hidden = !(startAt && last && last.live === true);
      if (!el.hidden) el.textContent = elapsedText();
    };
    const render = (resp, at) => {
      if (resp && resp.ok) last = { ...resp, at };
      if (resp && resp.ok && (resp.description || '') !== liveDescription) {
        liveDescription = resp.description || '';
        setLiveNameTip();
      }
      if (resp && resp.ok && resp.elapsedMs != null && !startAt) startAt = at - resp.elapsedMs;
      vstatsEl.classList.toggle('ddr-vstats-stale', !(resp && resp.ok));
      if (!last) return;
      vstatsEl.hidden = false;
      vstatsEl.querySelector('.ddr-vstats-live').hidden = last.live !== true;
      const v = vstatsEl.querySelector('.ddr-vstats-viewers');
      v.hidden = last.viewers == null;
      v.querySelector('b').textContent = last.viewers == null ? '' : Number(last.viewers).toLocaleString('en-MY');
      vstatsEl.querySelector('.ddr-vstats-top').hidden = last.live !== true && last.viewers == null;
      ['likes', 'comments', 'shares'].forEach((k) => {
        const el = vstatsEl.querySelector(`[data-k="${k}"]`);
        el.hidden = last[k] == null;
        el.querySelector('b').textContent = last[k] || '';
      });
      const t = new Date(last.at);
      tickElapsed();
      const rows = [];
      if (startAt && last.live === true) {
        const s = new Date(startAt);
        rows.push(['Live since', `${hh(s.getHours())}:${hh(s.getMinutes())}:${hh(s.getSeconds())}`]);
      }
      if (last.viewers != null) rows.push(['Watching now', Number(last.viewers).toLocaleString('en-MY')]);
      rows.push(['Reactions', last.likes || '—'], ['Comments', last.comments || '—'], ['Shares', last.shares || '—']);
      vstatsEl.dataset.ddrTip = JSON.stringify({
        h: last.live ? 'Live on Facebook' : 'Facebook video',
        rows,
        foot: `Updated ${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())} · every ${VSTATS_MS / 1000} s` +
          (resp && resp.ok ? '' : ' · last read failed'),
      });
    };
    const read = () => {
      if (busy || document.hidden) return;
      busy = true;
      const sent = Date.now();
      chrome.runtime.sendMessage({ type: 'GET_FB_VIDEO_STATS', url, wantElapsed: !startAt }, (resp) => {
        busy = false;
        // elapsedMs was measured mid-request; the midpoint splits the error.
        render(chrome.runtime.lastError ? null : resp, Math.round((sent + Date.now()) / 2));
      });
    };
    read();
    setInterval(read, VSTATS_MS);
    setInterval(() => { if (startAt && !document.hidden) tickElapsed(); }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) read(); });
  }

  // ---------------------------------------------------------------- layout

  /**
   * Narrow the left column to 26% and give the rest to the comment table.
   *
   * EC2 lays the video and the goods list side by side there. They are
   * stacked instead: video + live controls on top, the goods list filling the
   * rest of the column (.ddr-goods, CSS). The list is EC2's own panel, in
   * place and untouched - only CSS changes how it looks - so its per-product
   * 开始/结束 icons, 🔍 search, 竞标开始 and the 刷新 / 自动刷新 dropdown all
   * keep working exactly as EC2 wrote them. CSS also hides the 库存 and 剩余
   * columns, leaving the code and 得标数.
   *
   * An earlier version hid this panel entirely and moved 竞标开始 and 刷新 out
   * of it; that silently removed the per-product bidding icons.
   */
  function reclaimSpace() {
    const goods = document.querySelector('#allGroup');
    const body = document.querySelector('#liveMessageDiv');
    if (!goods || !body) return false;

    const panelEl = goods.closest('.col-sm-5');
    const leftCol = panelEl && panelEl.closest('.col-sm-6');
    const rightCol = body.closest('.col-sm-6');
    if (!panelEl || !leftCol || !rightCol) return false;
    if (panelEl.classList.contains('ddr-goods')) return true;

    panelEl.classList.add('ddr-goods');
    leftCol.classList.add('ddr-col-left');
    rightCol.classList.add('ddr-col-right');
    const video = leftCol.querySelector('.col-sm-7');
    if (video) video.classList.add('ddr-col-video');
    return true;
  }

  /**
   * The comment header lives in a SEPARATE table from the body, so both must
   * be resized together. Tag them rather than matching on a generic class -
   * the goods list on the left uses the same Bootstrap markup.
   */
  function tagTables() {
    const body = document.querySelector('#liveMessageDiv');
    if (!body) return false;
    body.classList.add('ddr-msg-body');
    const wrap = body.closest('.l-table');
    const head = wrap && wrap.querySelector('.tab-head table');
    if (head) head.classList.add('ddr-msg-head');
    return true;
  }

  // ------------------------------------------------------------ goods list

  /**
   * Hover a goods row -> product name and price in MYR and SGD.
   *
   * Name and price: EC2's own a=EntLive&m=ajax_getGroups (POSTed by the page on
   * load, read-only) returns every group as { group_num: "J1", group_name,
   * price: "29.90", purchase_price, ... }. purchase_price is cost and is never
   * shown. SGD: the host's myr-sgd-price-api Worker (CORS *), deterministic, so
   * each MYR price is converted once and kept.
   */
  const GROUPS_URL =
    `${location.origin}${location.pathname}?live_id=${encodeURIComponent(LIVE_ID)}&a=EntLive&m=ajax_getGroups&search_status=0`;
  const SGD_API = 'https://myr-sgd-price-api.stanlee19941218.workers.dev/v1/convert';
  /** A reload for a code we do not know yet waits at least this long. */
  const GROUPS_RETRY_MS = 15000;

  /**
   * group_id -> { code, name, price: "29.90", stopped }. Keyed by product, not
   * code: a live can carry the same code twice (the host re-adds J3 mid-live;
   * the old product is left with stop_budan = 1 and its own win_num/price).
   */
  const goodsInfo = new Map();
  /** "29.90" -> "10.90" */
  const sgdByMyr = new Map();
  let groupsReq = null;
  let groupsTriedAt = 0;
  let sgdFailed = false;

  function loadGroups() {
    if (groupsReq || Date.now() - groupsTriedAt < GROUPS_RETRY_MS) return;
    groupsTriedAt = Date.now();
    groupsReq = fetch(GROUPS_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => {
        const list = (JSON.parse(text) || {}).data || [];
        list.forEach((g) => {
          if (g && g.group_id) setGoodsInfo(g);
        });
        return convertPrices();
      })
      .catch(() => {
        /* left unknown - the next hover or list refresh retries */
      })
      .finally(() => {
        groupsReq = null;
        decorateGoods();
        refreshTip();
      });
  }

  function setGoodsInfo(g) {
    goodsInfo.set(String(g.group_id), {
      code: String(g.group_num || '').trim().toUpperCase(),
      name: String(g.group_name || '').trim(),
      price: g.price,
      stopped: String(g.stop_budan) === '1',
    });
  }

  /**
   * The product a goods row belongs to: living.js prints its group_id in the
   * row's 开始/结束 icon (startEndComment('<group_id>', this)). Falls back to
   * the code only when that code is on one product.
   */
  function goodsRowGroupId(tr) {
    const icon = tr.querySelector('[onclick*="startEndComment"]');
    const m = icon && /startEndComment\(\s*['"]?(\d+)/.exec(icon.getAttribute('onclick') || '');
    if (m) return m[1];
    const code = ((tr.children[0] && tr.children[0].textContent) || '').trim().toUpperCase();
    if (!code) return null;
    const ids = [...goodsInfo].filter(([, g]) => g.code === code).map(([id]) => id);
    return ids.length === 1 ? ids[0] : null;
  }

  function convertPrices() {
    const missing = [...new Set([...goodsInfo.values()].map((g) => String(g.price)))]
      .filter((p) => p && !sgdByMyr.has(p));
    if (!missing.length) return null;
    return fetch(SGD_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prices: missing }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        (json.results || []).forEach((r) => {
          if (r && r.sgd != null) sgdByMyr.set(String(r.input), String(r.sgd));
        });
        sgdFailed = false;
      })
      .catch(() => {
        sgdFailed = true;
      });
  }

  const moneyTwo = (v) => Number(v).toFixed(2);

  function goodsTip(code, id) {
    const info = id && goodsInfo.get(id);
    if (!info) return { h: code, s: groupsReq ? 'Loading product…' : 'Product details not loaded yet' };
    const price = String(info.price);
    const sgd = sgdByMyr.get(price);
    return {
      h: info.name || code,
      s: info.stopped ? `${code} · Stopped` : code,
      rows: [
        ['MYR', moneyFull(price), 'my'],
        ['SGD', sgd != null ? `S$ ${moneyExact(sgd)}` : sgdFailed ? 'converter unavailable' : 'converting…', 'sg'],
      ],
    };
  }

  /**
   * Per goods row: .ddr-goods-zero (no wins yet, muted by CSS),
   * .ddr-goods-stopped (stop_budan = 1, red - the old copy of a re-added code) and the hover
   * tooltip spec. living.js rewrites #allGroup's tbody on refresh, dropping
   * both, so the list is watched and re-decorated; our attribute writes do not
   * re-trigger the observer (it does not watch attributes).
   */
  function decorateGoods() {
    let unknown = false;
    document.querySelectorAll('#allGroup tbody tr').forEach((tr) => {
      const cells = tr.children;
      const n = cells[2] ? parseInt(cells[2].textContent, 10) : NaN;
      if (!Number.isFinite(n)) return; // loading / "no groups" row
      tr.classList.toggle('ddr-goods-zero', n === 0);

      const code = (cells[0].textContent || '').trim();
      if (!code) return;
      const id = goodsRowGroupId(tr);
      const info = id && goodsInfo.get(id);
      if (!info) unknown = true;
      tr.classList.toggle('ddr-goods-stopped', !!(info && info.stopped));
      const spec = JSON.stringify(goodsTip(code, id));
      if (tr.dataset.ddrTip !== spec) tr.dataset.ddrTip = spec;
    });
    // A code we have not seen (a product added mid-live): reload, throttled.
    if (unknown) loadGroups();
  }

  let goodsWatched = false;
  function watchGoods() {
    const table = document.querySelector('#allGroup');
    if (goodsWatched || !table) return;
    goodsWatched = true;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        decorateGoods();
      });
    }).observe(table, { childList: true, subtree: true, characterData: true });
    // A failed SGD conversion is retried when the host next hovers the list.
    table.addEventListener('mouseover', () => {
      if (sgdFailed && !groupsReq) {
        groupsTriedAt = 0;
        loadGroups();
      }
    });
    loadGroups();
    decorateGoods();
  }

  // --------------------------------------------------------- comment composer
  //
  // EC2's 说点什么吧 bar (.tab-foot: #message + 留言 + 刷新) is rarely used mid-
  // live but costs a row of the comment list. It is hidden by a class on
  // .l-table (the list is a flex stack, so it takes the space back) and a
  // round chat button at the bottom right brings it back. Nothing is moved or
  // rebuilt - the bar, its textarea and both buttons stay EC2's own nodes.
  //
  // Auto-hide: once focus has left the bar, the textarea is empty and the
  // pointer is not over it. A draft is never hidden. Anything that focuses the
  // textarea (EC2's replyComment, Tab) reveals it first.

  let composerBtn = null;
  const COMPOSER_HIDE_MS = 700;

  function installComposerToggle() {
    if (composerBtn) return;
    const table = document.querySelector('.ddr-col-right .l-table');
    const foot = table && table.querySelector(':scope > .tab-foot');
    const text = foot && foot.querySelector('#message');
    if (!foot || !text) return;

    composerBtn = document.createElement('button');
    composerBtn.type = 'button';
    composerBtn.className = 'ddr-composer-btn';
    composerBtn.setAttribute('aria-controls', 'message');
    composerBtn.innerHTML = ico('<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9.5h8M8 12.5h5"/>');
    document.body.appendChild(composerBtn);

    let hideTimer = 0;
    let pointerIn = false;

    const place = () => {
      const open = !table.classList.contains('ddr-foot-hidden');
      const col = table.getBoundingClientRect();
      composerBtn.style.right = `${Math.max(12, Math.round(window.innerWidth - col.right + 18))}px`;
      composerBtn.style.bottom = open
        ? `${Math.round(window.innerHeight - foot.getBoundingClientRect().top + 10)}px`
        : '18px';
    };

    const setOpen = (open) => {
      clearTimeout(hideTimer);
      table.classList.toggle('ddr-foot-hidden', !open);
      composerBtn.classList.toggle('ddr-composer-open', open);
      composerBtn.setAttribute('aria-expanded', String(open));
      composerBtn.setAttribute('aria-label', open ? 'Hide comment box' : 'Show comment box');
      composerBtn.dataset.ddrTip = JSON.stringify({ h: open ? 'Hide 留言 box' : '留言 · Write a comment' });
      place();
      refreshTip();
    };

    const maybeHide = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (foot.contains(document.activeElement) || pointerIn || text.value.trim()) return;
        setOpen(false);
      }, COMPOSER_HIDE_MS);
    };

    composerBtn.addEventListener('click', () => {
      const open = table.classList.contains('ddr-foot-hidden');
      setOpen(open);
      if (open) text.focus();
    });
    text.addEventListener('focus', () => {
      if (table.classList.contains('ddr-foot-hidden')) setOpen(true);
    });
    // EC2 clears the textarea after 留言 posts, so re-check once focus leaves.
    foot.addEventListener('focusout', maybeHide);
    foot.addEventListener('click', maybeHide);
    foot.addEventListener('mouseenter', () => {
      pointerIn = true;
      clearTimeout(hideTimer);
    });
    foot.addEventListener('mouseleave', () => {
      pointerIn = false;
      maybeHide();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || text.value.trim()) return;
      text.blur();
      setOpen(false);
    });
    window.addEventListener('resize', place);

    setOpen(false);
  }

  // ------------------------------------------------------------- live sales
  //
  // A hover-only button beside 全部起标线 that shows this live's revenue and
  // items won in a large centred panel. The figures come from EC2's own
  // 得标结果 page (a=EntLive&m=liveAllWin), which computes them server-side on
  // every load and prints them as
  //   <span id="totalPrice">RM 117892.50</span>  <span id="totalNums">1333</span>
  // It is a plain GET of a report page (~200KB, ~1.1s) - read-only. The same
  // page also prints 总成本 (#totalPurchasePrice); deliberately not shown.

  const SALES_URL =
    `${location.origin}${location.pathname}?live_id=${encodeURIComponent(LIVE_ID)}&a=EntLive&m=liveAllWin`;
  /** A hover within this long of the last load reuses it instead of refetching. */
  const SALES_FRESH_MS = 5000;

  let salesEl = null;
  let salesReq = null;
  let salesOpen = false;
  const sales = { at: 0, revenue: null, count: null, error: null };

  const moneyExact = (n) =>
    Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function loadSales() {
    if (salesReq) return;
    if (sales.at && !sales.error && Date.now() - sales.at < SALES_FRESH_MS) return;
    salesReq = fetch(SALES_URL, { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`EC2 returned HTTP ${res.status}.`);
        return res.text();
      })
      .then((html) => {
        // DOMParser never runs the page's scripts.
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const price = doc.getElementById('totalPrice');
        const nums = doc.getElementById('totalNums');
        if (!price || !nums) {
          throw new Error('得标结果 did not include the totals - the EC2 session may have expired. Reload this page.');
        }
        const revenue = Number(price.textContent.replace(/[^\d.]/g, ''));
        const count = Number(nums.textContent.replace(/[^\d]/g, ''));
        if (!Number.isFinite(revenue) || !Number.isFinite(count)) throw new Error('Could not read the totals.');
        Object.assign(sales, { at: Date.now(), revenue, count, error: null });
      })
      .catch((err) => {
        sales.error = err && err.message ? err.message : 'Could not load 得标结果.';
      })
      .finally(() => {
        salesReq = null;
        renderSales();
      });
    renderSales();
  }

  function renderSales() {
    if (!salesEl) return;
    const loading = !!salesReq;
    const has = sales.revenue != null;
    salesEl.classList.toggle('ddr-sales-loading', loading && !has);
    salesEl.classList.toggle('ddr-sales-stale', loading && has);
    salesEl.querySelector('.ddr-sales-rev').textContent = has ? moneyExact(sales.revenue) : '—';
    salesEl.querySelector('.ddr-sales-cnt').textContent = has ? sales.count.toLocaleString('en-MY') : '—';

    const foot = salesEl.querySelector('.ddr-sales-foot');
    const err = salesEl.querySelector('.ddr-sales-err');
    err.textContent = sales.error && !loading ? sales.error : '';
    err.hidden = !err.textContent;
    if (loading) foot.textContent = has ? 'Updating from 得标结果…' : 'Loading from 得标结果…';
    else if (has) {
      const t = new Date(sales.at);
      const hh = (n) => String(n).padStart(2, '0');
      foot.textContent = `Updated ${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())} · from 得标结果`;
    } else foot.textContent = '';
  }

  function showSales() {
    if (salesOpen) return;
    salesOpen = true;
    salesEl.classList.add('ddr-sales-on');
    loadSales();
  }

  function hideSales() {
    salesOpen = false;
    if (salesEl) salesEl.classList.remove('ddr-sales-on');
  }

  /**
   * Hover on the live name (controls card): EC2's live title in full (the card
   * clamps it) and the live's Facebook description - the post text, which
   * background.js reads from the same plugin HTML as the video stats, so it
   * costs no extra request and follows edits within 5 s. Display-only: closes
   * the moment the pointer leaves (PASSIVE_TIP_SEL).
   * liveDescription: undefined = no read yet, '' = none on Facebook.
   */
  let liveDescription;

  function setLiveNameTip() {
    const p = document.querySelector('.ddr-col-left .l-group-btn > p[data-ddr-live]');
    if (!p) return;
    const desc = liveDescription === undefined ? 'Loading from Facebook…' : liveDescription || 'No description on Facebook';
    p.dataset.ddrTip = JSON.stringify({ blocks: [['Live title', p.dataset.ddrLive], ['Description', desc, !liveDescription]] });
    if (tipTarget === p) refreshTip();
  }

  function installSalesButton() {
    if (document.querySelector('.ddr-sales-btn')) return;
    const group = document.querySelector('.ddr-col-left .l-group-btn');
    if (!group) return;

    const liveName = ((group.querySelector('p') || {}).textContent || '').replace(/^\s*活动名称\s*[:：]\s*/, '').trim();
    // Attribute only (no child nodes): CSS shows it as the card title without
    // EC2's "活动名称:" prefix.
    const nameP = group.querySelector('p');
    if (nameP && liveName) nameP.dataset.ddrLive = liveName;
    setLiveNameTip();

    salesEl = mk('div', 'ddr-sales');
    salesEl.id = 'ddr-sales';
    salesEl.setAttribute('role', 'status');
    const card = mk('div', 'ddr-sales-card');
    const head = mk('div', 'ddr-sales-head');
    head.appendChild(mk('span', 'ddr-sales-dot'));
    head.appendChild(mk('span', 'ddr-sales-kicker', '本场销售 · Live sales'));
    card.appendChild(head);
    if (liveName) card.appendChild(mk('div', 'ddr-sales-live', liveName));

    const rev = mk('div', 'ddr-sales-stat');
    rev.appendChild(mk('div', 'ddr-sales-label', '标组总金额 · Revenue'));
    const revVal = mk('div', 'ddr-sales-value ddr-sales-value-lg');
    revVal.appendChild(mk('span', 'ddr-sales-cur', 'RM'));
    revVal.appendChild(mk('span', 'ddr-sales-rev', '—'));
    rev.appendChild(revVal);
    card.appendChild(rev);

    const cnt = mk('div', 'ddr-sales-stat ddr-sales-stat-2');
    cnt.appendChild(mk('div', 'ddr-sales-label', '得标总数量 · Items won'));
    const cntVal = mk('div', 'ddr-sales-value');
    cntVal.appendChild(mk('span', 'ddr-sales-cnt', '—'));
    cnt.appendChild(cntVal);
    card.appendChild(cnt);

    const err = mk('div', 'ddr-sales-err');
    err.hidden = true;
    card.appendChild(err);
    card.appendChild(mk('div', 'ddr-sales-foot'));
    salesEl.appendChild(card);
    document.body.appendChild(salesEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ddr-sales-btn';
    btn.setAttribute('aria-describedby', 'ddr-sales');
    btn.innerHTML =
      ico('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>') + '<span>Rev</span>';
    // Hover (or keyboard focus) only - a click does nothing, so it can never
    // be mistaken for one of EC2's action buttons.
    // Instant: leaving the button closes the panel at once (host's choice -
    // unlike the other bubbles, this one is not meant to be entered).
    btn.addEventListener('mouseenter', showSales);
    btn.addEventListener('mouseleave', hideSales);
    btn.addEventListener('focus', showSales);
    btn.addEventListener('blur', hideSales);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideSales();
    });
    // Beside EC2's buttons, never inside or around them.
    group.appendChild(btn);
  }

  /**
   * 竞标开始 in the buttons card, where 全部起标线 was (that one is CSS-hidden
   * at the host's request). The real node is moved, not copied: living.js binds
   * its click by id at load and toggles .btn-success on it by id, and nothing
   * rewrites the header it came from, so handler and state go with it.
   */
  function placeStartButton() {
    const group = document.querySelector('.ddr-col-left .l-group-btn');
    const startBtn = document.getElementById('oneClickStartBtn');
    if (!group || !startBtn || startBtn.parentElement === group) return;
    const allLines = group.querySelector('button[onclick^="startAllComment"]');
    group.insertBefore(startBtn, allLines ? allLines.nextSibling : null);
  }

  /**
   * The big 刷新 refreshes both lists in place, like a single-page app: the
   * comment list (first page) and the bid list are reloaded by living.js's own
   * loaders in the page's MAIN world (background.js ec2ReloadListsInPage), and
   * shown together only once both have landed and our cards are drawn. Our own
   * feed poll and tonight's win records are re-read alongside, so the cards and
   * 🛒 totals are current too. A capture listener on document runs before
   * living.js's jQuery handler on #refresh (which only re-read the bid list)
   * and stops the click there. Rows added with 点击加载更多 are not kept - the
   * list restarts at the newest page, as on a page load.
   */
  let reloadWired = false;
  let listsBusy = false;

  function reloadListsInPage() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'EC2_RELOAD_LISTS' }, (resp) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : resp || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) }); // extension reloaded under the page
      }
    });
  }

  async function refreshLists() {
    if (listsBusy) return;
    listsBusy = true;
    const btn = document.getElementById('refresh');
    const root = document.documentElement;
    root.classList.add('ddr-lists-loading');
    if (btn) {
      btn.classList.remove('ddr-refresh-failed');
      btn.setAttribute('aria-busy', 'true');
    }
    const feed = poll().catch(() => {});
    const res = await reloadListsInPage();
    await feed;
    badgeAll();
    const body = document.querySelector('.ddr-col-right .l-table > .tab-body');
    if (body) body.scrollTop = 0;
    // Two frames: MutationObserver work and layout land before the reveal.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    root.classList.remove('ddr-lists-loading');
    if (btn) {
      btn.removeAttribute('aria-busy');
      // Icon-only button: a failed refresh shows as a red outline for a few seconds.
      if (!res.ok) {
        btn.classList.add('ddr-refresh-failed');
        setTimeout(() => btn.classList.remove('ddr-refresh-failed'), 4000);
      }
    }
    listsBusy = false;
    loadAbandoned().then(loadTonightAll);
  }

  function wireReloadButton() {
    const btn = document.getElementById('refresh');
    if (!btn) return;
    // Icon only (host's request): EC2's 刷新 text stays in the node, hidden by
    // CSS (font-size 0); the button itself (bound by id in living.js) is untouched.
    btn.setAttribute('aria-label', 'Refresh comments and bid list');
    delete btn.dataset.ddrSub;
    if (reloadWired) return;
    reloadWired = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#refresh')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      refreshLists();
    }, true);
  }


  // ------------------------------------------------------------ MYR → SGD converter
  //
  // Beside the square Refresh: type a MYR price, the SGD price appears as you
  // type (no Enter). SGD comes from the host's Cloudflare Worker (SGD_API) - a
  // price formula, not a plain exchange rate (100 → 37.00, 128 → 48.00), so
  // no rate is shown. Answers are cached per input (sgdByMyr, shared with the
  // goods tooltips); a burst of keystrokes sends one request after a short
  // pause, and only the latest request's answer is ever shown.
  const FX_DEBOUNCE_MS = 180;
  let fxEl = null;

  /** "RM 1,234.50" -> "1234.50"; '' when empty; null when not a price. */
  function fxParse(raw) {
    const t = String(raw || '').replace(/rm|myr|,|\s/gi, '');
    if (!t) return '';
    if (!/^\d*\.?\d{0,2}$/.test(t) || t === '.') return null;
    const n = Number(t);
    return n > 0 ? String(n) : null;
  }

  function installConverter() {
    const header = document.querySelector('.ddr-goods .ddr-refresh-row');
    if (!header || fxEl) return;
    fxEl = mk('div', 'ddr-fx');
    fxEl.setAttribute('role', 'group');
    fxEl.setAttribute('aria-label', 'MYR to SGD price converter');
    fxEl.innerHTML =
      '<label class="ddr-fx-field">' +
      '<span class="ddr-fx-label">MYR price</span>' +
      '<span class="ddr-fx-row"><input class="ddr-fx-in" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0" aria-label="Price in MYR">' +
      '<span class="ddr-fx-cur"><span class="ddr-flag ddr-flag-my" aria-hidden="true"></span>MYR</span></span>' +
      '</label>' +
      '<div class="ddr-fx-field ddr-fx-field-out">' +
      '<span class="ddr-fx-label">SGD price</span>' +
      '<span class="ddr-fx-row"><button type="button" class="ddr-fx-out" aria-live="polite" aria-label="SGD price, click to copy">0.00</button>' +
      '<span class="ddr-fx-cur"><span class="ddr-flag ddr-flag-sg" aria-hidden="true"></span>SGD</span></span>' +
      '</div>';
    header.appendChild(fxEl);

    const input = fxEl.querySelector('.ddr-fx-in');
    const out = fxEl.querySelector('.ddr-fx-out');
    let timer = 0;
    let seq = 0;

    const show = (text, state) => {
      out.textContent = text;
      fxEl.dataset.state = state || '';
    };

    const run = () => {
      clearTimeout(timer);
      const myr = fxParse(input.value);
      const mine = ++seq;
      if (myr === '') return show('0.00', 'empty');
      if (myr === null) return show('—', 'invalid');
      if (sgdByMyr.has(myr)) return show(moneyTwo(sgdByMyr.get(myr)), 'ok');
      fxEl.dataset.state = 'busy'; // keep the last figure, dimmed, until the answer lands
      timer = setTimeout(() => {
        fetch(SGD_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prices: [myr] }),
        })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((json) => {
            const r = (json.results || [])[0];
            if (!r || r.sgd == null) throw new Error('no result');
            sgdByMyr.set(myr, String(r.sgd));
            if (mine === seq) show(moneyTwo(r.sgd), 'ok');
          })
          .catch(() => {
            if (mine === seq) show('—', 'error');
          });
      }, FX_DEBOUNCE_MS);
    };

    input.addEventListener('input', run);
    // Keys typed here are ours: EC2's page shortcuts (and our Escape handlers) never see them.
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        input.value = '';
        run();
      }
    });
    out.addEventListener('click', () => {
      if (fxEl.dataset.state !== 'ok') return;
      navigator.clipboard.writeText(out.textContent).then(() => {
        fxEl.classList.add('ddr-fx-copied');
        setTimeout(() => fxEl.classList.remove('ddr-fx-copied'), 900);
      }).catch(() => {});
    });
    show('0.00', 'empty');
  }

  // ------------------------------------------------------------ product timer
  //
  // A big stopwatch in the empty space under 刷新 + the converter, for timing
  // how long the host talks about one product: Start, Pause, Clear. Our own
  // node appended to that header (like .ddr-fx), spanning both of its columns
  // and filling the rest of the row. Time = accumulated ms + (now − start) while
  // running, so it never drifts with the tick; kept in sessionStorage per live,
  // so ⌘R or a crash does not lose a running timer.

  const TIMER_TICK_MS = 200;
  let timerEl = null;

  function installTimer() {
    const header = document.querySelector('.ddr-goods .ddr-refresh-row');
    if (!header || !fxEl || timerEl) return;
    const KEY = `ddrTimer:${LIVE_ID}`;
    let acc = 0;
    let startedAt = null;
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && Number.isFinite(saved.acc)) {
        acc = Math.max(0, saved.acc);
        startedAt = Number.isFinite(saved.startedAt) ? saved.startedAt : null;
      }
    } catch (err) { /* storage unavailable - start fresh */ }
    const save = () => {
      try { sessionStorage.setItem(KEY, JSON.stringify({ acc, startedAt })); } catch (err) { /* ignore */ }
    };

    timerEl = mk('div', 'ddr-timer');
    timerEl.setAttribute('role', 'group');
    timerEl.setAttribute('aria-label', 'Product timer');
    // Icon-only buttons, named by aria-label only - no hover tip (host's request). .ddr-timer is the size
    // container; .ddr-timer-in is what its container queries lay out.
    const btn = (cls, label, path) =>
      `<button type="button" class="ddr-timer-btn ${cls}" aria-label="${label}">${ico(path)}</button>`;
    timerEl.innerHTML =
      '<div class="ddr-timer-in">' +
      '<div class="ddr-timer-face">' +
      '<span class="ddr-timer-state"></span>' +
      '<span class="ddr-timer-time" role="timer" aria-live="off">00:00</span>' +
      '</div>' +
      '<div class="ddr-timer-btns">' +
      btn('ddr-timer-start', 'Start', '<path d="M7 4.5v15l12-7.5-12-7.5Z"/>') +
      btn('ddr-timer-pause', 'Pause', '<path d="M8 5v14M16 5v14"/>') +
      btn('ddr-timer-clear', 'Clear', '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>') +
      '</div>' +
      '</div>';
    header.appendChild(timerEl);

    const timeEl = timerEl.querySelector('.ddr-timer-time');
    const stateEl = timerEl.querySelector('.ddr-timer-state');
    const startBtn = timerEl.querySelector('.ddr-timer-start');
    const pauseBtn = timerEl.querySelector('.ddr-timer-pause');
    const clearBtn = timerEl.querySelector('.ddr-timer-clear');
    const p2 = (n) => String(n).padStart(2, '0');
    const elapsed = () => acc + (startedAt != null ? Math.max(0, Date.now() - startedAt) : 0);

    let shown = '';
    const render = () => {
      const s = Math.floor(elapsed() / 1000);
      const h = Math.floor(s / 3600);
      const text = h ? `${h}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}` : `${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
      if (text !== shown) {
        shown = text;
        timeEl.textContent = text;
        timerEl.classList.toggle('ddr-timer-hours', h > 0);
      }
    };
    let ticker = 0;
    const sync = () => {
      const running = startedAt != null;
      const state = running ? 'running' : acc > 0 ? 'paused' : 'idle';
      timerEl.dataset.state = state;
      stateEl.textContent = running ? 'Running' : acc > 0 ? 'Paused' : 'Timer';
      const startLabel = state === 'paused' ? 'Resume' : 'Start';
      startBtn.setAttribute('aria-label', startLabel);
      startBtn.disabled = running;
      pauseBtn.disabled = !running;
      clearBtn.disabled = state === 'idle';
      clearInterval(ticker);
      if (running) ticker = setInterval(render, TIMER_TICK_MS);
      render();
    };

    startBtn.addEventListener('click', () => {
      if (startedAt != null) return;
      startedAt = Date.now();
      save();
      sync();
      pauseBtn.focus();
    });
    pauseBtn.addEventListener('click', () => {
      if (startedAt == null) return;
      acc = elapsed();
      startedAt = null;
      save();
      sync();
      startBtn.focus();
    });
    clearBtn.addEventListener('click', () => {
      acc = 0;
      startedAt = null;
      save();
      sync();
      startBtn.focus();
    });
    // Keys pressed on our buttons are ours: EC2's page shortcuts never see them.
    timerEl.addEventListener('keydown', (e) => e.stopPropagation());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
    sync();
  }

  // ------------------------------------------------------------ Messenger history
  //
  // Click anywhere in a customer's 留言用户 cell -> a Messenger-style modal of
  // their conversation with our page, read from EC2's 讯息管理 dialog page:
  //   GET a=FBUser&m=dialog&fb_account_id=<page>&fb_user_id=<psid>&page=N
  // Server-rendered HTML (#sample_3), 10 messages per page, newest first,
  // #sample_1_paginate li.next while older pages exist (~180-350 ms a page).
  // Row cells: ID · 用户 sender (avatar + name) · content (text with its own newlines, img.pimg for images, blank
  // when EC2 could not show an attachment) · 状态 · 时间 (MYT).
  // Read-only: that page also has a send form (ajax_sendMessageContent), which
  // this never calls. Parsed with DOMParser (inert) and rendered as text nodes.

  let chatOverlay = null;
  const chat = { psid: '', seq: 0, page: 0, done: false, loading: false, error: false, msgs: [], name: '', avatar: '', back: null, stick: true };

  const dialogUrl = (psid, page) =>
    `${location.origin}${location.pathname}?fb_account_id=${encodeURIComponent(pageAccountId)}` +
    `&fb_user_id=${encodeURIComponent(psid)}&a=FBUser&m=dialog${page > 1 ? `&page=${page}` : ''}`;

  async function fetchDialogPage(psid, page) {
    let html;
    try {
      const res = await fetch(dialogUrl(psid, page), { credentials: 'same-origin' });
      if (!res.ok) return null;
      html = await res.text();
    } catch (err) {
      return null;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.getElementById('sample_3');
    if (!table) return null; // not the dialog page (logged out)
    const caption = doc.querySelector('.portlet-title .caption');
    const nameMatch = caption && caption.textContent.match(/与\s*\((.*)\)\s*聊天记录/);
    const name = nameMatch ? nameMatch[1].trim() : '';
    let avatar = '';
    const msgs = [];
    table.querySelectorAll('tbody > tr').forEach((tr) => {
      const td = tr.children;
      if (td.length < 5) return;
      const img = td[1].querySelector('img');
      const src = img ? img.getAttribute('src') || '' : '';
      const sender = ((td[1].querySelector('span') || {}).textContent || '').trim();
      // Who sent it = the 用户 column's name, the only reliable signal: on 394
      // rows of 55 customers it was always our page's name or exactly the
      // caption's customer name. Not the avatar - a customer without a profile
      // photo gets Facebook's default image with no psid= in the URL
      // (8323459854391014: all her messages were drawn as ours).
      const fromCustomer = sender && name ? sender === name
        : sender && pageName ? sender !== pageName
          : /[?&]psid=/.test(src);
      if (fromCustomer && src && !avatar) avatar = src;
      const images = [...td[2].querySelectorAll('img')].map((i) => i.getAttribute('src')).filter(Boolean);
      msgs.push({
        id: td[0].textContent.trim(),
        fromCustomer,
        text: td[2].textContent.replace(/^\s+|\s+$/g, ''),
        images,
        time: td[4].textContent.trim(),
      });
    });
    const pag = doc.getElementById('sample_1_paginate');
    return { msgs, hasNext: !!(pag && pag.querySelector('li.next')), name, avatar };
  }

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function chatDayLabel(day) {
    const today = new Date();
    const yest = new Date(Date.now() - 86400000);
    if (day === localDay(today)) return 'Today';
    if (day === localDay(yest)) return 'Yesterday';
    const [y, m, d] = day.split('-').map(Number);
    const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    return `${wd}, ${d} ${MONTHS[m - 1]}${y !== today.getFullYear() ? ` ${y}` : ''}`;
  }
  const chatMs = (t) => {
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):?(\d{2})?/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : 0;
  };

  /** Text with links made clickable - text nodes only, never HTML. */
  function linkified(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<>"']+|(?:www\.)?ddherbs\.com\.my\/[^\s<>"']*)/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = /^https?:/i.test(m[0]) ? m[0] : `https://${m[0]}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[0];
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function buildChat() {
    chatOverlay = mk('div', 'ddr-chat-overlay');
    chatOverlay.hidden = true;
    const box = mk('div', 'ddr-chat');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'ddr-chat-name');
    box.tabIndex = -1;
    box.innerHTML =
      '<div class="ddr-chat-head">' +
      '<span class="ddr-chat-avatar" aria-hidden="true"></span>' +
      '<div class="ddr-chat-who"><div class="ddr-chat-name" id="ddr-chat-name"></div>' +
      '<div class="ddr-chat-sub"></div></div>' +
      '<button type="button" class="ddr-chat-btn ddr-chat-reload" aria-label="Reload messages">↻</button>' +
      '<a class="ddr-chat-btn ddr-chat-ec2" target="_blank" rel="noopener">EC2 ↗</a>' +
      '<button type="button" class="ddr-chat-btn ddr-chat-close" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="ddr-chat-body" tabindex="0"><div class="ddr-chat-top"></div><div class="ddr-chat-list"></div></div>' +
      '<div class="ddr-chat-foot">Read-only · Messenger history from EC2 讯息管理</div>';
    chatOverlay.appendChild(box);
    document.body.appendChild(chatOverlay);

    box.querySelector('.ddr-chat-close').addEventListener('click', closeChat);
    box.querySelector('.ddr-chat-reload').addEventListener('click', () => openChat(chat.psid));
    chatOverlay.addEventListener('click', (e) => {
      if (e.target === chatOverlay) closeChat();
    });
    const body = box.querySelector('.ddr-chat-body');
    body.addEventListener('scroll', () => {
      // At the newest message = stay there while images finish loading.
      chat.stick = body.scrollHeight - body.clientHeight - body.scrollTop < 40;
      if (body.scrollTop < 160) loadOlderChat();
    }, { passive: true });
    box.querySelector('.ddr-chat-top').addEventListener('click', (e) => {
      if (e.target.closest('.ddr-chat-retry')) loadOlderChat();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && chatOverlay && !chatOverlay.hidden) {
        e.stopPropagation();
        closeChat();
      }
    }, true);
  }

  function setChatHead() {
    const box = chatOverlay.querySelector('.ddr-chat');
    const name = chat.name || psidName.get(chat.psid) || chat.psid;
    box.querySelector('.ddr-chat-name').textContent = name;
    const count = chat.msgs.length;
    box.querySelector('.ddr-chat-sub').textContent =
      `${chat.psid}${count ? ` · ${count}${chat.done ? '' : '+'} message${count === 1 ? '' : 's'}` : ''}`;
    const av = box.querySelector('.ddr-chat-avatar');
    av.textContent = '';
    av.style.backgroundImage = '';
    if (chat.avatar) av.style.backgroundImage = `url("${chat.avatar.replace(/["\\]/g, '')}")`;
    else av.textContent = (name.trim()[0] || '?').toUpperCase();
    box.querySelector('.ddr-chat-ec2').href = dialogUrl(chat.psid, 1);
  }

  function setChatTop() {
    const top = chatOverlay.querySelector('.ddr-chat-top');
    top.replaceChildren();
    if (chat.loading) top.appendChild(mk('span', 'ddr-chat-status', chat.msgs.length ? 'Loading older messages…' : 'Loading messages…'));
    else if (chat.error) {
      top.appendChild(mk('span', 'ddr-chat-status', 'Could not load messages from EC2.'));
      const retry = mk('button', 'ddr-chat-retry', 'Try again');
      retry.type = 'button';
      top.appendChild(retry);
    } else if (chat.done) {
      top.appendChild(mk('span', 'ddr-chat-status', chat.msgs.length
        ? 'Start of the conversation in EC2'
        : 'No Messenger messages in EC2 for this customer.'));
    }
  }

  function renderChatList() {
    const list = chatOverlay.querySelector('.ddr-chat-list');
    const frag = document.createDocumentFragment();
    const msgs = chat.msgs;
    let prevDay = '';
    for (let i = 0; i < msgs.length; i += 1) {
      const m = msgs[i];
      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const t = chatMs(m.time);
      const day = m.time.slice(0, 10);
      if (day !== prevDay) {
        frag.appendChild(mk('div', 'ddr-chat-sep', `${chatDayLabel(day)} · ${m.time.slice(11, 16)}`));
        prevDay = day;
      } else if (prev && t - chatMs(prev.time) > 3600000) {
        frag.appendChild(mk('div', 'ddr-chat-sep', m.time.slice(11, 16)));
      }
      // A group is one sender's run, a few minutes apart, on the same day.
      const joinsPrev = prev && prev.fromCustomer === m.fromCustomer && prev.time.slice(0, 10) === day && t - chatMs(prev.time) <= 300000;
      const joinsNext = next && next.fromCustomer === m.fromCustomer && next.time.slice(0, 10) === day && chatMs(next.time) - t <= 300000;
      const pos = joinsPrev && joinsNext ? 'mid' : joinsPrev ? 'last' : joinsNext ? 'first' : 'solo';

      const row = mk('div', `ddr-chat-row ${m.fromCustomer ? 'ddr-chat-in' : 'ddr-chat-out'} ddr-chat-${pos}`);
      if (m.fromCustomer) {
        const av = mk('span', 'ddr-chat-row-av');
        if (pos === 'last' || pos === 'solo') {
          if (chat.avatar) av.style.backgroundImage = `url("${chat.avatar.replace(/["\\]/g, '')}")`;
          else av.textContent = ((chat.name || '?').trim()[0] || '?').toUpperCase();
          av.classList.add('ddr-chat-row-av-on');
        }
        row.appendChild(av);
      }
      const stack = mk('div', 'ddr-chat-stack');
      m.images.forEach((src) => {
        const a = document.createElement('a');
        a.className = 'ddr-chat-img';
        a.href = src;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = 'Image';
        img.src = src;
        img.addEventListener('load', keepChatPinned, { once: true });
        img.addEventListener('error', () => {
          const gone = mk('div', 'ddr-chat-bubble ddr-chat-attach', 'Image no longer available');
          a.replaceWith(gone);
          keepChatPinned();
        }, { once: true });
        a.appendChild(img);
        stack.appendChild(a);
      });
      if (m.text) {
        const b = mk('div', 'ddr-chat-bubble');
        b.appendChild(linkified(m.text));
        stack.appendChild(b);
      } else if (!m.images.length) {
        const b = mk('div', 'ddr-chat-bubble ddr-chat-attach', 'Attachment · not shown by EC2');
        stack.appendChild(b);
      }
      row.appendChild(stack);
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
    setChatTop();
    setChatHead();
  }

  /** An image above the fold finished loading: newest message stays in view if it was. */
  function keepChatPinned() {
    if (!chat.stick || !chatOverlay || chatOverlay.hidden) return;
    const body = chatOverlay.querySelector('.ddr-chat-body');
    body.scrollTop = body.scrollHeight;
  }

  async function loadOlderChat() {
    if (!chatOverlay || chatOverlay.hidden || chat.loading || chat.done) return;
    const seq = chat.seq;
    const first = chat.page === 0;
    chat.loading = true;
    chat.error = false;
    setChatTop();
    const res = await fetchDialogPage(chat.psid, chat.page + 1);
    if (seq !== chat.seq) return; // another customer was opened meanwhile
    chat.loading = false;
    if (!res) {
      chat.error = true;
      setChatTop();
      return;
    }
    chat.page += 1;
    if (res.name) chat.name = res.name;
    if (res.avatar) chat.avatar = res.avatar;
    // A message that arrived since page 1 shifts every page by one: skip repeats.
    const have = new Set(chat.msgs.map((m) => m.id));
    const older = res.msgs.filter((m) => !have.has(m.id)).reverse();
    chat.done = !res.hasNext || !res.msgs.length;
    const body = chatOverlay.querySelector('.ddr-chat-body');
    const fromBottom = body.scrollHeight - body.scrollTop;
    chat.msgs = older.concat(chat.msgs);
    renderChatList();
    // Newest at the bottom on open; when older pages are prepended the view
    // stays on the message the host was reading.
    body.scrollTop = first || chat.stick ? body.scrollHeight : body.scrollHeight - fromBottom;
    // A short first page may not fill the box - keep going until it scrolls.
    if (!chat.done && body.scrollHeight <= body.clientHeight + 160) loadOlderChat();
  }

  function openChat(psid) {
    if (!psid) return;
    if (!chatOverlay) buildChat();
    if (chatOverlay.hidden) chat.back = document.activeElement;
    Object.assign(chat, { psid, seq: chat.seq + 1, page: 0, done: false, loading: false, error: false, msgs: [], name: psidName.get(psid) || '', avatar: '', stick: true });
    chatOverlay.querySelector('.ddr-chat-list').replaceChildren();
    chatOverlay.hidden = false;
    setChatHead();
    if (!pageAccountId) {
      chat.error = true;
      setChatTop();
      return;
    }
    // Focus the dialog itself: keyboard users land inside it (Tab reaches the
    // buttons, arrows scroll after one Tab) without a ring drawn on ×.
    chatOverlay.querySelector('.ddr-chat').focus({ preventScroll: true });
    loadOlderChat();
  }

  function closeChat() {
    if (!chatOverlay || chatOverlay.hidden) return;
    chatOverlay.hidden = true;
    chat.seq += 1; // drop any page still loading
    chat.loading = false;
    hideTip();
    if (chat.back && chat.back.focus && chat.back.isConnected) chat.back.focus();
  }

  /** Delegated: a click anywhere in a customer row's 留言用户 cell opens their chat. */
  function installChatClicks() {
    document.addEventListener('click', (e) => {
      if (e.button !== 0 || !e.target.closest) return;
      const cell = e.target.closest(`${TBODY_SEL} > tr[id^="win_tr_"] > td:first-child`);
      if (!cell) return;
      const tr = cell.parentElement;
      if (tr.classList.contains('ddr-own') || e.target.closest('a, button, .ddr-psid')) return;
      if (String(window.getSelection() || '')) return; // selecting a name to copy it
      const psid = commentPsid.get(tr.dataset.index || tr.id.replace(/^win_tr_/, ''));
      if (psid) openChat(psid);
    });
  }

  // -------------------------------------------------------- EC2 win records
  //
  // What a customer won is what EC2 stored, never a count of comments (see
  // handoff §28-29). EC2 holds the records per live on its server and exposes
  // them two ways, verified identical on 3 lives (1,399 records: same win ids,
  // PSIDs, 数量, and 小计 = product price x 数量 in every case):
  //   - 得标结果 page (a=EntLive&m=liveAllWin): server HTML, 50 records/page,
  //     ~200 KB a page (4.1 MB for live 556923), but the only place with 状态.
  //   - get_cur_wins (POST group_id, lastWinId=0): JSON wins of ONE product -
  //     win_id, fb_user_id, num, message, fb_comment_id - ~4-8 KB. EC2's own live
  //     page uses it. ajax_getGroups lists the products (group_id, group_num =
  //     code, group_name, price, win_num) in ~32 KB.
  // So: products + per-product wins (~0.3 MB for a whole live), and 得标结果
  // filtered to 弃标 (ordered=4, normally one page) only to drop abandoned wins.
  //
  // Tonight:
  //   load              products + every product's wins, 4 at a time; 弃标 list
  //   feed shows a win  re-read THAT product (from the feed row's group_id and the
  //                     comment's codes) at +1.5 s and +10 s
  //   every 5 s         products only; re-read the products whose win_num changed
  //                     (catches System Add, edits and cancels with no comment), and
  //                     write each win_num into EC2's goods list (patchGoodsCounts)
  //   every 5 min       弃标 list; every 10 min all products (safety net)
  // Read-only: only EC2's own read calls, nothing clicked or posted.

  const WINS_GROUPS_POLL_MS = 5000;
  const WINS_ABANDON_MS = 300000;
  const WINS_FULL_MS = 600000;
  const WINS_HOVER_STALE_MS = 20000;
  const WINS_CONCURRENCY = 4;

  const tonightWins = {
    groups: new Map(), // group id -> { id, code, name, price, winNum }
    winsByGroup: new Map(), // group id -> [record]
    abandoned: new Set(), // win ids with 状态 弃标
    codes: new Map(), // product name -> code
    groupAt: new Map(), // group id -> last read
    groupBusy: new Set(),
    groupTimers: new Map(),
    loadedAt: 0,
    polledAt: 0,
    pollBusy: false,
    error: '',
    stats: { groupLists: 0, productReads: 0, abandonReads: 0 },
  };

  const clock = (t) => {
    const d = new Date(t);
    const hh = (x) => String(x).padStart(2, '0');
    return `${hh(d.getHours())}:${hh(d.getMinutes())}:${hh(d.getSeconds())}`;
  };

  const ec2Post = async (query, body) => {
    try {
      const res = await fetch(`${location.origin}${location.pathname}?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(body || {}).toString(),
      });
      if (!res.ok) return null;
      return JSON.parse(await res.text());
    } catch (err) {
      return null;
    }
  };

  /** A live's products, or null. */
  async function fetchGroups(liveId) {
    const json = await ec2Post(`live_id=${encodeURIComponent(liveId)}&a=EntLive&m=ajax_getGroups&search_status=0`);
    if (!json || !Array.isArray(json.data)) return null;
    return json.data.filter((g) => g && g.group_id).map((g) => ({
      id: String(g.group_id),
      code: String(g.group_num || '').trim().toUpperCase() || null,
      name: String(g.group_name || '').trim(),
      price: Number.isFinite(parseFloat(g.price)) ? parseFloat(g.price) : null,
      winNum: String(g.win_num),
      stopped: String(g.stop_budan) === '1',
    }));
  }

  /** Every win of one product, as records; null on failure. */
  async function fetchGroupWins(group) {
    const json = await ec2Post('a=EntLive&m=get_cur_wins', { group_id: group.id, lastWinId: '0' });
    if (!json || String(json.error) !== '0') return null;
    const list = Array.isArray(json.data) ? json.data : [];
    return list.map((w) => {
      const qty = parseInt(w.num, 10) || 0;
      return {
        win: String(w.win_id), psid: String(w.fb_user_id || ''), groupId: group.id, product: group.name, code: group.code,
        qty, amount: group.price != null ? Math.round(group.price * qty * 100) / 100 : null,
        commentId: w.fb_comment_id ? String(w.fb_comment_id) : '', comment: String(w.message || ''),
      };
    }).filter((r) => r.win && r.psid);
  }

  /** Run fn over items, n at a time; resolves with the results in order. */
  async function inBatches(items, n, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
    return out;
  }

  /** One 得标结果 page -> { records, lastPage }, or null when it is not the list (e.g. logged out). */
  function parseWinPage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.getElementById('sample_3');
    if (!table) return null;
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.replace(/\s+/g, ''));
    const win = heads.findIndex((h) => h === '序号');
    if (win < 0) return null;
    const records = [];
    table.querySelectorAll('tbody > tr').forEach((tr) => {
      const td = tr.children;
      if (td.length < heads.length) return;
      const id = (td[win].textContent || '').trim();
      if (id) records.push(id);
    });
    let lastPage = 1;
    doc.querySelectorAll('a[href*="page="]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
      if (m) lastPage = Math.max(lastPage, +m[1]);
    });
    return { records, lastPage };
  }

  /**
   * Win ids EC2 marks 弃标, from 得标结果 filtered to that status (ordered=4) -
   * the one fact get_cur_wins does not carry. Normally a single page. null on failure.
   */
  async function fetchAbandoned(liveId) {
    const page = async (p) => {
      try {
        const res = await fetch(`${location.origin}${location.pathname}?live_id=${encodeURIComponent(liveId)}` +
          `&a=EntLive&m=liveAllWin&ordered=4${p > 1 ? `&page=${p}` : ''}`, { credentials: 'same-origin' });
        return res.ok ? parseWinPage(await res.text()) : null;
      } catch (err) {
        return null;
      }
    };
    const first = await page(1);
    if (!first) return null;
    const ids = new Set(first.records);
    for (let p = 2; p <= first.lastPage; p += 1) {
      const more = await page(p);
      if (!more) return null;
      more.records.forEach((id) => ids.add(id));
    }
    return ids;
  }

  /** Every non-abandoned win record of a live (for a ticked earlier live). null on failure. */
  async function fetchLiveWins(liveId) {
    const [groups, abandoned] = await Promise.all([fetchGroups(liveId), fetchAbandoned(liveId)]);
    if (!groups || !abandoned) return null;
    const lists = await inBatches(groups, WINS_CONCURRENCY, fetchGroupWins);
    if (lists.some((l) => !l)) return null;
    return lists.flat().filter((r) => !abandoned.has(r.win));
  }

  /** psid -> Map(product -> { key, code, name, qty, amount, records }). */
  function groupWinRecords(records) {
    const by = new Map();
    records.forEach((r) => {
      let bucket = by.get(r.psid);
      if (!bucket) by.set(r.psid, (bucket = new Map()));
      const key = r.groupId || r.product;
      const cur = bucket.get(key);
      if (!cur) {
        bucket.set(key, { key, code: r.code, name: r.product, qty: r.qty, amount: r.amount, records: [r] });
      } else {
        cur.qty += r.qty;
        cur.amount = cur.amount != null && r.amount != null ? Math.round((cur.amount + r.amount) * 100) / 100 : null;
        cur.records.push(r);
      }
    });
    return by;
  }

  /**
   * EC2's records for one comment row, by the record's own fb_comment_id. When
   * a customer comments again for a product EC2 updates the record and points
   * it at the new comment, so the old comment stops showing it. Records with no
   * comment id (System Add) fall back to the row's win id.
   */
  function rowWinItems(key, winId) {
    const psid = commentPsid.get(key);
    const bucket = psid && productsByPsid.get(psid);
    if (!bucket) return [];
    const out = [];
    bucket.forEach((it) => {
      const recs = it.records.filter((r) => (r.commentId ? r.commentId === key : !!winId && r.win === String(winId)));
      if (!recs.length) return;
      out.push({ key: it.key, code: it.code, name: it.name, qty: recs.reduce((a, r) => a + r.qty, 0),
        amount: recs.every((r) => r.amount != null) ? recs.reduce((a, r) => a + r.amount, 0) : null });
    });
    return out.sort(byCode);
  }

  function applyTonightWins() {
    const all = [];
    tonightWins.winsByGroup.forEach((list) => list.forEach((r) => {
      if (!tonightWins.abandoned.has(r.win)) all.push(r);
    }));
    tonightWins.codes = new Map([...tonightWins.groups.values()].filter((g) => g.code).map((g) => [g.name, g.code]));
    productsByPsid = groupWinRecords(all);
    rebuildProducts();
    refreshTallies();
    badgeAll();
    renderPanel();
  }

  function setGroups(groups) {
    tonightWins.groups = new Map(groups.map((g) => [g.id, g]));
    tonightWins.stats.groupLists += 1;
    groups.forEach((g) => {
      const info = goodsInfo.get(g.id);
      if (info) info.stopped = g.stopped;
    });
    patchGoodsCounts(groups);
  }

  /**
   * EC2's goods list (#allGroup, 关键字 | 得标数) is only redrawn by its own
   * 刷新 / 自动刷新 (freshGroupsFor4, which blanks the tbody to "...loading..."
   * and rebuilds it - a flicker every time). Instead, every product poll writes
   * the fresh win_num into the rows already there: the leading text node of
   * the 得标数 cell only (living.js appends <br/>style(n) lines after it), so
   * no node is added, moved or removed and EC2's icons and handlers stay. Rows
   * are matched by product id (goodsRowGroupId), never by code alone: a code
   * re-added mid-live is two products, and a code map wrote the new product's
   * count into the stopped row too (556923: old J3/J4 = 1/0 showed 141/167).
   * A product not in the list (added mid-live) still needs EC2's 刷新. The goods
   * observer re-applies .ddr-goods-zero.
   */
  function patchGoodsCounts(groups) {
    const byId = new Map(groups.map((g) => [g.id, g]));
    document.querySelectorAll('#allGroup tbody tr').forEach((tr) => {
      const cells = tr.children;
      if (cells.length < 3) return;
      const id = goodsRowGroupId(tr);
      const g = id && byId.get(id);
      if (!g) return;
      tr.classList.toggle('ddr-goods-stopped', g.stopped);
      const n = g.winNum;
      const text = cells[2].firstChild;
      if (!/^\d+$/.test(n) || !text || text.nodeType !== Node.TEXT_NODE) return;
      if (text.nodeValue.trim() !== n) text.nodeValue = n;
    });
  }

  async function readGroup(id) {
    const group = tonightWins.groups.get(id);
    if (!group || tonightWins.groupBusy.has(id)) return false;
    tonightWins.groupBusy.add(id);
    const list = await fetchGroupWins(group);
    tonightWins.groupBusy.delete(id);
    tonightWins.stats.productReads += 1;
    if (!list) return false;
    tonightWins.winsByGroup.set(id, list);
    tonightWins.groupAt.set(id, Date.now());
    return true;
  }

  async function loadTonightAll() {
    const groups = await fetchGroups(LIVE_ID);
    if (!groups) {
      tonightWins.error = 'Could not read EC2 wins - EC2 may have logged out.';
      return;
    }
    setGroups(groups);
    await inBatches(groups.map((g) => g.id), WINS_CONCURRENCY, readGroup);
    tonightWins.loadedAt = Date.now();
    tonightWins.polledAt = Date.now();
    tonightWins.error = '';
    applyTonightWins();
  }

  /** Products only; re-read those whose win_num moved (or that are new). */
  async function pollGroups() {
    if (tonightWins.pollBusy || !tonightWins.loadedAt) return;
    tonightWins.pollBusy = true;
    const groups = await fetchGroups(LIVE_ID);
    tonightWins.pollBusy = false;
    if (!groups) return;
    const changed = groups.filter((g) => {
      const old = tonightWins.groups.get(g.id);
      return !old || old.winNum !== g.winNum || old.price !== g.price;
    }).map((g) => g.id);
    setGroups(groups);
    tonightWins.polledAt = Date.now();
    if (!changed.length) return;
    await inBatches(changed, WINS_CONCURRENCY, readGroup);
    applyTonightWins();
  }

  async function loadAbandoned() {
    const ids = await fetchAbandoned(LIVE_ID);
    tonightWins.stats.abandonReads += 1;
    if (!ids) return;
    const same = ids.size === tonightWins.abandoned.size && [...ids].every((w) => tonightWins.abandoned.has(w));
    tonightWins.abandoned = ids;
    if (!same && tonightWins.loadedAt) applyTonightWins();
  }

  /**
   * The feed shows a win (or a reply) for this product: re-read just it, soon
   * and once more a little later - EC2 writes the win a moment after the
   * comment row (reply lag p50 2 s). Repeated hints for one product collapse.
   */
  function scheduleGroupWins(groupId) {
    if (!groupId || !tonightWins.groups.has(groupId) || tonightWins.groupTimers.has(groupId)) return;
    const run = () => readGroup(groupId).then((ok) => ok && applyTonightWins());
    const t1 = setTimeout(run, 1500);
    const t2 = setTimeout(() => {
      tonightWins.groupTimers.delete(groupId);
      run();
    }, 10000);
    tonightWins.groupTimers.set(groupId, [t1, t2]);
  }

  /** Product ids a feed row points at: its own group_id plus every code in the comment. */
  function rowGroupIds(row) {
    const ids = new Set();
    [row.group_id, row.hit_live_group_id].forEach((g) => {
      if (g && String(g) !== '0') ids.add(String(g));
    });
    const byCodeId = new Map([...tonightWins.groups.values()].filter((g) => g.code).map((g) => [g.code, g.id]));
    Object.keys(qtyByCode(row.message)).forEach((code) => {
      if (byCodeId.has(code)) ids.add(byCodeId.get(code));
    });
    return ids;
  }

  function startTonightWins() {
    loadAbandoned().then(loadTonightAll);
    setInterval(pollGroups, WINS_GROUPS_POLL_MS);
    setInterval(loadAbandoned, WINS_ABANDON_MS);
    setInterval(loadTonightAll, WINS_FULL_MS);
    let hoverPoll = 0;
    document.addEventListener('mouseover', (e) => {
      const pill = e.target.closest && e.target.closest('.ddr-tonight');
      if (!pill || !tonightWins.polledAt) return;
      if (Date.now() - tonightWins.polledAt > WINS_HOVER_STALE_MS && Date.now() - hoverPoll > 5000) {
        hoverPoll = Date.now();
        pollGroups();
      }
    });
  }

  // ------------------------------------------------------------ batch compare
  //
  // Our lives run in batches (e.g. 19-23 Sep) and a customer can combine what
  // they win across the batch into one order. The host ticks earlier lives in
  // the batch picker; each one is fetched ONCE with the same getLivingMessage
  // call (empty lastTime = the whole live, 2-5 MB, 6-12 s) and immediately
  // reduced to a per-customer summary (~100-140 KB), which is all we keep.
  //
  // Lifetime, as agreed with the operator:
  //   tick    -> fetch once, summary saved in chrome.storage.local
  //   untick  -> summary deleted at once
  //   reload  -> read back from storage, 0 requests
  //   never auto-refreshed; the ↻ button re-fetches every ticked live
  //   7 days without the page being opened with a selection -> all deleted
  // The selection is global, not per live: ticked 19 + 20 stay ticked when
  // the 21 Sep live is opened. The live on screen never counts against itself.
  //
  // Verified before building (ec2-live-batch-probe.js): EC2 still serves the
  // full feed for old lives, and its win state matched EC2's own page on
  // 3,490 of 3,490 comments. EC2 never marks a live as ended (everything is
  // 进行中) and replay comments keep arriving for days, which is why a
  // ticked live is a snapshot and ↻ exists.

  const BATCH_SEL_KEY = 'batch:sel';
  const BATCH_LIVE_PREFIX = 'batch:live:';
  const BATCH_IDLE_MS = 7 * 86400000;
  /** Bumped when the summary's meaning changes; older saved summaries are re-read. 3 = wins from EC2 per-product records. */
  const BATCH_VERSION = 3;

  const ICO_CHAT = ico('<path d="M4 5h16v11H9l-5 4V5Z"/>');
  const ICO_BAG = ico('<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>');

  /** { ids: [liveId], names: { liveId: name }, used: ms } */
  let batchSel = { ids: [], names: {}, used: 0 };
  /** liveId -> { t, name, first, by: { psid: [comments, firstTime, [[code, name, qty, amount]]] } } */
  const batchData = new Map();
  /** liveId -> token of the fetch in flight; a stale token means "unticked or re-fetched since" */
  const batchLoading = new Map();
  const batchErrors = new Map();
  let batchNote = '';
  /** psid -> { lives: [{ id, label, day, n }], items: [{ id, label, code, name, qty, amount }] } */
  let batchByPsid = new Map();
  let batchLabels = {};

  const store = {
    get(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (v) => resolve(chrome.runtime.lastError ? {} : v || {}));
        } catch (err) {
          resolve({}); // extension reloaded under the page
        }
      });
    },
    set(obj) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set(obj, () => resolve(!chrome.runtime.lastError));
        } catch (err) {
          resolve(false);
        }
      });
    },
    remove(keys) {
      try {
        chrome.storage.local.remove(keys);
      } catch (err) {
        /* ignore */
      }
    },
  };

  /** Names compare across lives by text only - codes are reassigned every live. */
  const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

  const batchIds = () => batchSel.ids.filter((id) => id !== LIVE_ID);
  const batchActive = () => batchIds().some((id) => batchData.has(id));

  /** "15-09-2026(PM) - ANGEL" -> { day: '15', full: '15 Sep (PM)' }; falls back to the first comment. */
  function liveDay(name, firstTime) {
    const m = String(name || '').match(/(\d{1,2})-(\d{1,2})-(\d{4})\s*(?:\((AM|PM)\))?/i);
    if (m) {
      const half = m[4] ? m[4].toUpperCase() : '';
      return { day: String(+m[1]), half, full: `${+m[1]} ${MONTHS[+m[2] - 1] || ''}${half ? ` (${half})` : ''}` };
    }
    const t = String(firstTime || '').match(/^\d{4}-(\d{2})-(\d{2})/);
    if (t) return { day: String(+t[2]), half: '', full: `${+t[2]} ${MONTHS[+t[1] - 1]}` };
    return { day: '#' + String(name || '').slice(-3), half: '', full: String(name || 'Live') };
  }

  /**
   * Another live -> the per-customer summary we keep. Comments (how many,
   * first time) come from its feed; what they WON comes only from that live's
   * EC2 得标结果 records (弃标 left out), exactly like tonight. A customer can
   * have wins and no comment ("System Add"), so they get an entry too.
   */
  function summariseLive(list, records) {
    const by = {};
    let first = '';
    for (const row of list) {
      const psid = String(row.fb_user_id || '');
      if (!psid || psid === String(row.fb_account_id)) continue; // our own broadcasts
      const t = String(row.comment_created_time || '');
      const c = by[psid] || (by[psid] = [0, t, []]);
      c[0] += 1;
      if (t && (!c[1] || t < c[1])) c[1] = t;
      if (t && (!first || t < first)) first = t;
    }
    groupWinRecords(records).forEach((bucket, psid) => {
      const c = by[psid] || (by[psid] = [0, '', []]);
      c[2] = [...bucket.values()].map((it) => [it.code || '', it.name, it.qty, it.amount]);
    });
    return { by, first };
  }

  function recomputeBatch() {
    const ids = batchIds().filter((id) => batchData.has(id)).sort((a, b) => Number(a) - Number(b));
    const days = {};
    ids.forEach((id) => {
      const d = batchData.get(id);
      days[id] = liveDay(d.name || batchSel.names[id], d.first);
    });
    // Two lives on the same date (AM + PM) keep their half in the short label.
    const perDay = {};
    ids.forEach((id) => (perDay[days[id].day] = (perDay[days[id].day] || 0) + 1));
    batchLabels = {};
    ids.forEach((id) => {
      const d = days[id];
      batchLabels[id] = { short: perDay[d.day] > 1 && d.half ? d.day + d.half : d.day, full: d.full };
    });

    const next = new Map();
    ids.forEach((id) => {
      const { by } = batchData.get(id);
      Object.entries(by).forEach(([psid, [n, , items]]) => {
        let b = next.get(psid);
        if (!b) next.set(psid, (b = { lives: [], items: [] }));
        if (n > 0) b.lives.push({ id, label: batchLabels[id], n });
        (items || []).forEach(([code, name, qty, amount]) =>
          b.items.push({ id, label: batchLabels[id], code, name, qty, amount }));
      });
    });
    batchByPsid = next;
    refreshBatchUi();
  }

  async function initBatch() {
    const got = await store.get(BATCH_SEL_KEY);
    const sel = got[BATCH_SEL_KEY];
    if (!sel || !Array.isArray(sel.ids)) return;
    if (sel.ids.length && Date.now() - (sel.used || 0) > BATCH_IDLE_MS) {
      // Forgotten after a batch ended: drop everything.
      store.remove([BATCH_SEL_KEY, ...sel.ids.map((id) => BATCH_LIVE_PREFIX + id)]);
      return;
    }
    batchSel = { ids: sel.ids.map(String), names: sel.names || {}, used: Date.now() };
    if (!batchSel.ids.length) return;
    store.set({ [BATCH_SEL_KEY]: batchSel });
    const stored = await store.get(batchSel.ids.map((id) => BATCH_LIVE_PREFIX + id));
    batchSel.ids.forEach((id) => {
      const entry = stored[BATCH_LIVE_PREFIX + id];
      // v2 = wins from EC2 records. A v1 summary counted comments, so re-read it.
      if (entry && entry.by && entry.v === BATCH_VERSION) batchData.set(id, entry);
      else if (id !== LIVE_ID) loadBatchLive(id); // ticked, but no current summary
    });
    recomputeBatch();
  }

  function saveSel() {
    batchSel.used = Date.now();
    return store.set({ [BATCH_SEL_KEY]: batchSel });
  }

  async function loadBatchLive(id) {
    const token = {};
    batchLoading.set(id, token);
    batchErrors.delete(id);
    renderBatchPicker();
    const [list, records] = await Promise.all([fetchFeed('', id), fetchLiveWins(id)]);
    if (batchLoading.get(id) !== token) return; // unticked or re-fetched meanwhile
    batchLoading.delete(id);
    if (!list || !records) {
      batchErrors.set(id, 'Could not load. EC2 may have logged out: reload this page.');
      renderBatchPicker();
      return;
    }
    const { by, first } = summariseLive(list, records);
    const entry = { v: BATCH_VERSION, t: Date.now(), name: batchSel.names[id] || '', first, by };
    batchData.set(id, entry);
    if (!(await store.set({ [BATCH_LIVE_PREFIX + id]: entry }))) {
      batchNote = 'Browser storage is full, so this batch is kept for this page only.';
    }
    // Unticked while saving: undo the write.
    if (!batchSel.ids.includes(id)) {
      batchData.delete(id);
      store.remove(BATCH_LIVE_PREFIX + id);
    }
    recomputeBatch();
  }

  function setBatchLive(id, name, on) {
    id = String(id);
    if (on) {
      if (!batchSel.ids.includes(id)) batchSel.ids.push(id);
      batchSel.names[id] = name;
      saveSel();
      loadBatchLive(id);
      return;
    }
    batchSel.ids = batchSel.ids.filter((x) => x !== id);
    delete batchSel.names[id];
    saveSel();
    batchLoading.delete(id);
    batchErrors.delete(id);
    batchData.delete(id);
    store.remove(BATCH_LIVE_PREFIX + id);
    recomputeBatch();
  }

  function refreshBatchAll() {
    batchNote = '';
    batchIds().forEach((id) => loadBatchLive(id));
  }

  function batchChipSpec(psid) {
    const b = batchByPsid.get(psid);
    // Ticked earlier lives only - tonight has its own 🛒 pill above.
    const wins = b.items;
    const products = new Set(wins.map((w) => normName(w.name))).size;
    const units = wins.reduce((a, w) => a + w.qty, 0);
    const priced = wins.every((w) => w.amount != null);
    const total = wins.reduce((a, w) => a + (w.amount || 0), 0);
    return {
      products, units, priced, total,
      tip: {
        h: 'Earlier lives in this batch',
        // Rendered by renderTip, which shortens the list when the bubble is tall.
        sPre: b.lives.length
          ? `Commented in ${b.lives.length} of ${batchIds().filter((id) => batchData.has(id)).length} ticked lives: `
          : 'No comments in the ticked lives - won without one (System Add).',
        sList: b.lives.map((l) => `${l.label.full} (${l.n}×)`),
        v: wins.length && priced ? moneyFull(total) : null,
        rows: wins.length ? [['Products won', String(products)], ['Units', String(units)]] : [['Won', 'nothing yet']],
        items: wins.map((w) => ({
          code: `${w.label.short} · ${w.code || '?'}`,
          name: w.name, qty: w.qty, amount: w.amount != null ? moneyFull(w.amount) : null,
        })),
        foot: (wins.length && !priced ? 'Some 小计 are missing, so no total. ' : '') +
          'Wins from each live\'s EC2 得标结果 (弃标 excluded). Tonight not included. Snapshot from when ticked.',
      },
    };
  }

  /** The chip in line 2 of the card: 💬 19·20 · 🛍 5 · RM 380. Refreshed in place. */
  function fillBatchChip(el) {
    const psid = el.dataset.psid;
    const b = batchByPsid.get(psid);
    if (!b) {
      if (!el.classList.contains('ddr-hide')) {
        el.classList.add('ddr-hide');
        el.replaceChildren();
        delete el.dataset.ddrTip;
      }
      return;
    }
    const spec = batchChipSpec(psid);
    // A count, not the dates: "8·9·10·11" grew with every ticked live. The
    // dates are in the tooltip.
    const days = b.lives.map((l) => l.label.short).join('·');
    const sig = [days, spec.products, spec.priced ? Math.round(spec.total) : '?'].join('|');
    el.dataset.ddrTip = JSON.stringify(spec.tip);
    el.setAttribute('aria-label',
      `Commented in ${b.lives.length} earlier live${b.lives.length === 1 ? '' : 's'} (${days})` +
        (spec.products ? `, won ${spec.products} products` : ''));
    el.classList.remove('ddr-hide');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML =
      (b.lives.length ? `${ICO_CHAT}<span class="ddr-batch-days">${b.lives.length}</span>` : '') +
      (spec.products
        ? (b.lives.length ? '<span class="ddr-batch-sep"></span>' : '') + `${ICO_BAG}<b>${spec.products}</b>` +
          (spec.priced ? `<span class="ddr-batch-amt">${escapeHtml(money(spec.total))}</span>` : '')
        : '');
  }

  /** Tonight's product names for one comment row: its codes, plus whatever it won. */
  function rowProductNames(key) {
    const out = new Set();
    (rowCodes.get(key) || []).forEach((code) => (codeNames.get(code) || []).forEach((n) => out.add(normName(n))));
    rowWinItems(key, rowWin.get(key)).forEach((it) => out.add(normName(it.name)));
    return out;
  }

  /**
   * "已在 19 得标 ×2" in the 得标 cell when tonight's comment is for a product the
   * customer already won earlier in the batch. Appended beside .action-buttons,
   * never inside it - the same rule as .ddr-won.
   */
  function decoratePrev(tr) {
    const cells = tr.querySelectorAll('td');
    const cell = cells[3];
    if (!cell || cell.hasAttribute('colspan')) return;
    const key = tr.dataset.index || (tr.id || '').replace(/^win_tr_/, '');
    const psid = commentPsid.get(key);
    const b = psid && batchByPsid.get(psid);
    let hits = [];
    if (b && b.items.length) {
      const names = rowProductNames(key);
      if (names.size) hits = b.items.filter((it) => names.has(normName(it.name)));
    }
    const existing = cell.querySelector(':scope > .ddr-prev');
    if (!hits.length) {
      if (existing) existing.remove();
      return;
    }
    const sig = hits.map((h) => `${h.id}:${h.code}:${h.qty}`).join('|');
    if (existing && existing.dataset.sig === sig) return;
    if (existing) existing.remove();
    const labels = [...new Set(hits.map((h) => h.label.short))];
    const qty = hits.reduce((a, h) => a + h.qty, 0);
    cell.insertAdjacentHTML(
      'beforeend',
      `<div class="ddr-prev" data-sig="${escapeHtml(sig)}" ${tipAttr({
        h: 'Already won this product in the batch',
        items: hits.map((h) => ({
          code: `${h.label.short} · ${h.code || '?'}`, name: h.name, qty: h.qty,
          amount: h.amount != null ? moneyFull(h.amount) : null,
        })),
        foot: 'Matched by product name - codes change every live.',
      })}>已在 ${escapeHtml(labels.join('·'))} 得标 ×${qty}</div>`
    );
  }

  function refreshBatchUi() {
    document.querySelectorAll('.ddr-batch').forEach(fillBatchChip);
    document.querySelectorAll(`${TBODY_SEL} > tr[id^="win_tr_"]`).forEach(decoratePrev);
    renderPanel();
    renderBatchPicker();
    refreshTip();
  }

  /** Tonight's commenters who were in the ticked lives, and how many of them won there. */
  function batchCounts() {
    let came = 0;
    let bought = 0;
    new Set(commentPsid.values()).forEach((psid) => {
      const b = batchByPsid.get(psid);
      if (!b) return;
      came += 1;
      if (b.items.length) bought += 1;
    });
    return { came, bought };
  }

  // --- picker ---------------------------------------------------------------

  let batchBtn = null;
  let batchPop = null;
  const livesList = { lives: [], page: 0, lastPage: 1, loading: false, error: '' };

  function loadLivesPage() {
    if (livesList.loading || livesList.page >= livesList.lastPage) return;
    livesList.loading = true;
    livesList.error = '';
    renderBatchPicker();
    try {
      chrome.runtime.sendMessage({ type: 'LIST_LIVES', page: livesList.page + 1 }, (res) => {
        livesList.loading = false;
        if (chrome.runtime.lastError || !res || !res.ok) {
          livesList.error = (res && res.error) || 'Could not load the live list.';
        } else {
          livesList.page = res.page || livesList.page + 1;
          livesList.lastPage = res.lastPage || livesList.page;
          const have = new Set(livesList.lives.map((l) => l.id));
          (res.lives || []).forEach((lv) => {
            const id = String(lv.id);
            if (!have.has(id)) livesList.lives.push({ id, name: String(lv.name || '').trim() });
          });
        }
        renderBatchPicker();
      });
    } catch (err) {
      livesList.loading = false;
      livesList.error = 'Extension was reloaded: reload this page.';
      renderBatchPicker();
    }
  }

  function renderBatchButton() {
    if (!batchBtn) return;
    const n = batchIds().length;
    const badge = batchBtn.querySelector('.ddr-batch-btn-n');
    badge.textContent = String(n);
    badge.hidden = !n;
    batchBtn.classList.toggle('ddr-batch-btn-on', n > 0);
  }

  function fetchedAt(t) {
    const d = new Date(t);
    const hh = (x) => String(x).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hh(d.getHours())}:${hh(d.getMinutes())}`;
  }

  function liveRow(id, name) {
    const row = mk('label', 'ddr-bp-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = batchSel.ids.includes(id);
    box.addEventListener('change', () => setBatchLive(id, name, box.checked));
    row.appendChild(box);
    const text = mk('span', 'ddr-bp-text');
    text.appendChild(mk('span', 'ddr-bp-name', name || `Live ${id}`));
    let status = '';
    let cls = 'ddr-bp-status';
    if (batchLoading.has(id)) {
      status = 'Loading…';
      cls += ' ddr-bp-loading';
    } else if (batchErrors.has(id)) {
      status = batchErrors.get(id);
      cls += ' ddr-bp-error';
    } else if (box.checked && batchData.has(id)) {
      const d = batchData.get(id);
      status = `${Object.keys(d.by).length} customers · saved ${fetchedAt(d.t)}`;
    }
    if (status) text.appendChild(mk('span', cls, status));
    row.appendChild(text);
    return row;
  }

  function renderBatchPicker() {
    renderBatchButton();
    if (!batchPop || batchPop.hidden) return;
    const body = batchPop.querySelector('.ddr-bp-body');
    const scroll = body.scrollTop;
    body.replaceChildren();

    const sum = batchPop.querySelector('.ddr-bp-sum');
    if (batchActive()) {
      const { came, bought } = batchCounts();
      sum.textContent = `Tonight: ${came} came back · ${bought} already won in the batch`;
    } else {
      sum.textContent = 'Tick the earlier lives of this batch.';
    }
    const note = batchPop.querySelector('.ddr-bp-note');
    note.textContent = batchNote;
    note.hidden = !batchNote;
    batchPop.querySelector('.ddr-bp-refresh').disabled = !batchIds().length;

    // Ticked lives first, even when their page of the list is not loaded.
    const ticked = batchIds();
    if (ticked.length) {
      body.appendChild(mk('div', 'ddr-bp-group', 'Ticked'));
      ticked.forEach((id) => body.appendChild(liveRow(id, batchSel.names[id])));
    }
    body.appendChild(mk('div', 'ddr-bp-group', 'Lives'));
    livesList.lives
      .filter((lv) => lv.id !== LIVE_ID && !ticked.includes(lv.id))
      .forEach((lv) => body.appendChild(liveRow(lv.id, lv.name)));
    if (livesList.error) body.appendChild(mk('div', 'ddr-bp-error ddr-bp-msg', livesList.error));
    if (livesList.loading) body.appendChild(mk('div', 'ddr-bp-msg', 'Loading lives…'));
    else if (livesList.page < livesList.lastPage) {
      const more = mk('button', 'ddr-bp-more', 'Load older lives');
      more.type = 'button';
      more.addEventListener('click', loadLivesPage);
      body.appendChild(more);
    }
    body.scrollTop = scroll;
  }

  function placeBatchPop() {
    const r = batchBtn.getBoundingClientRect();
    const w = batchPop.offsetWidth || 360;
    batchPop.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8)))}px`;
    // The button sits low in the left column, so on a short window the list
    // would be two rows tall. Open below it when there is room, otherwise
    // slide up (covering the column above, never the comment table).
    const h = Math.min(560, window.innerHeight - 16);
    batchPop.style.maxHeight = `${h}px`;
    batchPop.style.top = `${Math.round(Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)))}px`;
  }

  function openBatchPicker(open) {
    batchPop.hidden = !open;
    batchBtn.setAttribute('aria-expanded', String(open));
    if (!open) return;
    if (!livesList.page) loadLivesPage();
    renderBatchPicker();
    placeBatchPop();
  }

  function installBatchButton() {
    if (batchBtn) return;
    const group = document.querySelector('.ddr-col-left .l-group-btn');
    if (!group) return;

    batchBtn = document.createElement('button');
    batchBtn.type = 'button';
    batchBtn.className = 'ddr-batch-btn';
    batchBtn.setAttribute('aria-haspopup', 'dialog');
    batchBtn.setAttribute('aria-expanded', 'false');
    batchBtn.innerHTML = `${ICO_CHAT}<span>Live</span><span class="ddr-batch-btn-n" hidden></span>`;
    group.appendChild(batchBtn);

    batchPop = mk('div', 'ddr-bp');
    batchPop.hidden = true;
    batchPop.setAttribute('role', 'dialog');
    batchPop.setAttribute('aria-label', 'Compare with earlier lives in this batch');
    const head = mk('div', 'ddr-bp-head');
    head.appendChild(mk('span', 'ddr-bp-title', '批次对比 · Compare batch'));
    const refresh = mk('button', 'ddr-bp-refresh', '↻ Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', refreshBatchAll);
    head.appendChild(refresh);
    const close = mk('button', 'ddr-bp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => openBatchPicker(false));
    head.appendChild(close);
    batchPop.appendChild(head);
    batchPop.appendChild(mk('div', 'ddr-bp-sum'));
    const note = mk('div', 'ddr-bp-note ddr-bp-error');
    note.hidden = true;
    batchPop.appendChild(note);
    batchPop.appendChild(mk('div', 'ddr-bp-body'));
    batchPop.appendChild(mk('div', 'ddr-bp-foot',
      'Each ticked live is loaded once and kept until you untick it. ↻ reloads them. Removed after 7 days unused.'));
    document.body.appendChild(batchPop);

    batchBtn.addEventListener('click', () => openBatchPicker(batchPop.hidden));
    document.addEventListener('mousedown', (e) => {
      if (batchPop.hidden || batchPop.contains(e.target) || batchBtn.contains(e.target)) return;
      openBatchPicker(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !batchPop.hidden) openBatchPicker(false);
    });
    window.addEventListener('resize', () => {
      if (!batchPop.hidden) placeBatchPop();
    });
    renderBatchButton();
  }

  // ---------------------------------------------------------------- tooltips
  //
  // The host reads these mid-live from a distance, and the browser's native
  // title tooltip is ~12px grey-on-white after a one-second delay. Every hover
  // target carries a small JSON spec in data-ddr-tip instead:
  //   { h: heading, v: big value, s: subline, mono: monospace value,
  //     blocks: [[label, paragraph, muted?]],
  //     rows: [[label, value, flag?]], items: [{code, name, qty, amount}], foot }
  // and one shared bubble renders it. Strings go in via textContent only.
  // Targets live in our own nodes (card, 得标 .ddr-won, panel) - never in the
  // comment cell, which okWin sends verbatim.

  function tipAttr(spec) {
    return `data-ddr-tip="${escapeHtml(JSON.stringify(spec))}"`;
  }

  const fmtDay = (raw) => {
    const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : String(raw || '—');
  };

  const tenureLabel = (days) => {
    if (days < 31) return `${Math.max(days, 0)} day${days === 1 ? '' : 's'}`;
    const y = Math.floor(days / 365);
    const mo = Math.floor((days % 365) / 30.44);
    return [y ? `${y} yr` : '', mo ? `${mo} mo` : ''].filter(Boolean).join(' ') || '1 yr';
  };

  let tipEl = null;
  let tipTarget = null;
  let tipTimer = 0;
  /** Last pointer position, so a scroll can tell whether the bubble's target is still under it. */
  let lastPointer = null;
  /**
   * The bubble is interactive: the pointer can move into it to read or copy.
   * Leaving the target only starts a short grace period; entering the bubble
   * (or the target again) cancels it.
   */
  let tipHovered = false;
  let tipHideTimer = 0;
  /** The tip target currently under the pointer (null over anything else). */
  let hoverTarget = null;
  const TIP_GRACE_MS = 300;

  function scheduleHideTip() {
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(() => {
      if (!tipHovered) hideTip();
    }, TIP_GRACE_MS);
  }

  /** Text is selected inside the bubble - re-rendering would wipe it. */
  const tipHasSelection = () => {
    const sel = window.getSelection();
    return !!(sel && !sel.isCollapsed && tipEl && tipEl.contains(sel.anchorNode));
  };

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderTip(spec, maxItems = 12, maxLives = 6) {
    tipEl.replaceChildren();
    if (spec.h) tipEl.appendChild(mk('div', 'ddr-tip-h', spec.h));
    if (spec.v) tipEl.appendChild(mk('div', 'ddr-tip-v', spec.v));
    if (spec.s) tipEl.appendChild(mk('div', 'ddr-tip-s', spec.s));
    if (spec.sList && spec.sList.length) {
      // One entry per ticked live, so it grows with the batch: past the cap
      // the rest is counted instead of listed.
      const shown = spec.sList.slice(0, maxLives);
      const rest = spec.sList.length - shown.length;
      tipEl.appendChild(mk('div', 'ddr-tip-s',
        (spec.sPre || '') + shown.join(' · ') + (rest ? ` · … + ${rest} more live${rest === 1 ? '' : 's'}` : '')));
    }
    else if (spec.sPre) tipEl.appendChild(mk('div', 'ddr-tip-s', spec.sPre));
    if (spec.mono) tipEl.appendChild(mk('div', 'ddr-tip-mono', spec.mono));
    if (spec.blocks && spec.blocks.length) {
      // Labelled paragraphs kept as written (line breaks shown): [label, text, muted?].
      spec.blocks.forEach(([k, t, muted]) => {
        const b = mk('div', 'ddr-tip-block');
        b.appendChild(mk('div', 'ddr-tip-block-k', k));
        b.appendChild(mk('div', `ddr-tip-block-t${muted ? ' ddr-tip-block-muted' : ''}`, t));
        tipEl.appendChild(b);
      });
    }
    if (spec.rows && spec.rows.length) {
      const dl = mk('dl', 'ddr-tip-rows');
      spec.rows.forEach(([k, v, flag]) => {
        const dt = mk('dt', null);
        // Optional third item: a country code for a round flag (my, sg).
        if (flag) dt.appendChild(mk('span', `ddr-tip-flag ddr-tip-flag-${flag}`));
        dt.appendChild(document.createTextNode(k));
        dl.appendChild(dt);
        dl.appendChild(mk('dd', null, v));
      });
      tipEl.appendChild(dl);
    }
    if (spec.items && spec.items.length) {
      const list = mk('div', 'ddr-tip-items');
      // A whole batch can be 30+ products; the rest is summarised rather than
      // cut off. showTip lowers the cap until the bubble fits the window.
      const MAX_ITEMS = maxItems;
      spec.items.slice(0, MAX_ITEMS).forEach((it) => {
        const row = mk('div', 'ddr-tip-item');
        row.appendChild(mk('b', 'ddr-tip-code', it.code));
        row.appendChild(mk('span', 'ddr-tip-name', it.name));
        row.appendChild(mk('span', 'ddr-tip-qty', '×' + it.qty));
        row.appendChild(mk('span', 'ddr-tip-amt', it.amount || '—'));
        list.appendChild(row);
      });
      if (spec.items.length > MAX_ITEMS) {
        list.appendChild(mk('div', 'ddr-tip-more', `+ ${spec.items.length - MAX_ITEMS} more`));
      }
      tipEl.appendChild(list);
    }
    if (spec.foot) tipEl.appendChild(mk('div', 'ddr-tip-foot', spec.foot));
  }

  /**
   * Above the target, centred; below when it does not fit above. When it fits
   * on neither side (a long batch list near mid-screen) it goes on the side
   * with more room and is slid back inside the window, so it is never cut
   * off - covering the target is fine, the bubble ignores the pointer.
   */
  function placeTip(target) {
    const r = target.getBoundingClientRect();
    const t = tipEl.getBoundingClientRect();
    const gap = 10;
    const pad = 8;
    const vh = window.innerHeight;
    const fitsAbove = r.top - t.height - gap >= pad;
    const fitsBelow = r.bottom + gap + t.height <= vh - pad;
    const below = !fitsAbove && (fitsBelow || vh - r.bottom > r.top);
    let top = below ? r.bottom + gap : r.top - t.height - gap;
    const clamped = Math.max(pad, Math.min(top, vh - t.height - pad));
    tipEl.classList.toggle('ddr-tip-noarrow', clamped !== top);
    top = clamped;
    const cx = r.left + r.width / 2;
    const left = Math.max(pad, Math.min(cx - t.width / 2, window.innerWidth - t.width - pad));
    tipEl.style.left = `${Math.round(left)}px`;
    tipEl.style.top = `${Math.round(Math.max(pad, top))}px`;
    tipEl.style.setProperty('--ddr-tip-arrow', `${Math.round(Math.max(14, Math.min(cx - left, t.width - 14)))}px`);
    tipEl.classList.toggle('ddr-tip-below', below);
  }

  function showTip(target, keepPlace) {
    let spec;
    try {
      spec = JSON.parse(target.dataset.ddrTip);
    } catch (err) {
      return;
    }
    // A close scheduled on the way here (leaving a target the pointer only
    // crossed) must not close the bubble that is opening now.
    clearTimeout(tipHideTimer);
    tipTarget = target;
    // Bid list rows: display-only, closes the instant the pointer leaves.
    tipEl.classList.toggle('ddr-tip-passive', isPassiveTip(target));
    tipEl.classList.add('ddr-tip-on');
    tipEl.classList.remove('ddr-tip-capped');
    let cap = 12;
    let lives = 6;
    renderTip(spec, cap, lives);
    // Room on the roomier side of the target (gap 10 + edge 8), so a long
    // list fits beside the target instead of being slid over it.
    const tr = target.getBoundingClientRect();
    const room = Math.max(tr.top, window.innerHeight - tr.bottom) - 18;
    const tooTall = () => tipEl.getBoundingClientRect().height > room;
    // Items first (the bulk of the height), then the list of lives.
    while (cap > 3 && tooTall()) renderTip(spec, (cap -= 2), lives);
    while (lives > 2 && tooTall()) renderTip(spec, cap, (lives -= 2));
    // Last resort (a very short window): cap the bubble to the window and
    // fade its end, so it stops cleanly instead of running off screen.
    if (tipEl.getBoundingClientRect().height > window.innerHeight - 16) tipEl.classList.add('ddr-tip-capped');
    // While the pointer is inside the bubble it must not jump away from it.
    if (!keepPlace) placeTip(target);
    target.setAttribute('aria-describedby', 'ddr-tip');
  }

  /**
   * Display-only tooltips that close the instant the pointer leaves (host's
   * request): goods list rows, a card's Lifetime spend, Average order value
   * and Customer since, the `N known · N new` count beside 留言用户, and the
   * PSID button (clicking it still copies the PSID), and the live name on the
   * controls card (title + Facebook description).
   * Not enterable, no close grace, no fade.
   */
  const PASSIVE_TIP_SEL = '#allGroup, .ddr-vstats, .ddr-ltv, .ddr-aov, .ddr-since, .ddr-live-count, .ddr-psid, .l-group-btn > p[data-ddr-live]';
  const isPassiveTip = (target) => !!(target && target.closest && target.closest(PASSIVE_TIP_SEL));

  function hideTip() {
    clearTimeout(tipTimer);
    clearTimeout(tipHideTimer);
    tipHovered = false;
    if (tipTarget) tipTarget.removeAttribute('aria-describedby');
    tipTarget = null;
    if (tipEl) tipEl.classList.remove('ddr-tip-on');
  }

  /** Re-render in place when the target's data changed under the pointer (🛒 on a poll). */
  function refreshTip() {
    if (!tipTarget) return;
    // Being read from inside: keep it even if the row under it was redrawn,
    // and never re-render over a selection the host is about to copy.
    if (!tipTarget.isConnected) return tipHovered ? undefined : hideTip();
    if (tipHovered && tipHasSelection()) return;
    showTip(tipTarget, tipHovered);
  }

  function installTips() {
    tipEl = mk('div', 'ddr-tip');
    tipEl.id = 'ddr-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);

    tipEl.addEventListener('mouseenter', () => {
      tipHovered = true;
      clearTimeout(tipHideTimer);
      clearTimeout(tipTimer); // crossed another target on the way in - stay
    });
    tipEl.addEventListener('mouseleave', (e) => {
      tipHovered = false;
      const backToTarget = tipTarget && e.relatedTarget && tipTarget.contains(e.relatedTarget);
      if (!backToTarget) scheduleHideTip();
    });

    const arm = (target, delay) => {
      if (target === tipTarget) {
        clearTimeout(tipHideTimer);
        return;
      }
      clearTimeout(tipTimer);
      // The first bubble waits a beat so sweeping the mouse across the table
      // does not flash bubbles. Swapping to another target also waits a
      // little: on the way into an open bubble the pointer often crosses a
      // neighbouring target (the goods row above), and entering the bubble
      // cancels the swap. Either way it opens only if the pointer is still on
      // that target - one merely crossed on the way somewhere else never opens.
      tipTimer = setTimeout(() => {
        if (hoverTarget === target) showTip(target);
      }, tipTarget ? 150 : delay);
    };

    document.addEventListener('mousemove', (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    }, { passive: true, capture: true });
    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest && e.target.closest('[data-ddr-tip]');
      hoverTarget = target || null;
      if (target) arm(target, 120);
    });
    document.addEventListener('mouseout', (e) => {
      const from = e.target.closest && e.target.closest('[data-ddr-tip]');
      if (!from) return;
      const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-ddr-tip]');
      if (to === from) return;
      if (isPassiveTip(from)) {
        clearTimeout(tipTimer);
        if (from === tipTarget) hideTip();
        return;
      }
      if (e.relatedTarget && tipEl.contains(e.relatedTarget)) return; // into the bubble
      scheduleHideTip();
    });
    document.addEventListener('focusin', (e) => {
      const target = e.target.closest && e.target.closest('[data-ddr-tip]');
      if (target && target !== tipTarget) {
        clearTimeout(tipTimer);
        showTip(target);
      }
    });
    // Only a blur of the bubble's own target closes it (a keyboard-opened
    // bubble). Any focusout used to - EC2 and the page move focus on their
    // own, which closed a mouse-opened bubble within ~200ms at random, and
    // clicking into the bubble to select text blurs whatever had focus.
    document.addEventListener('focusout', (e) => {
      if (tipTarget && tipTarget.contains(e.target) && !tipHovered) scheduleHideTip();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tipTarget) hideTip();
    });
    // The comment list scrolls under a fixed bubble. Not every scroll is the
    // operator's: when living.js prepends a new comment, Chrome's scroll
    // anchoring shifts scrollTop to keep the view still, which used to close
    // an open bubble on every incoming comment (verified: +61px on a 1-row
    // prepend). So re-check on the next frame instead - keep and re-place the
    // bubble while its target is still under the pointer and on screen,
    // otherwise drop it rather than leave it pointing at the wrong row.
    // A resized window leaves an open bubble sized and placed for the old one,
    // and the pointer may now be outside the page, so no mouseout ever arrives.
    window.addEventListener('resize', hideTip);
    let scrollCheck = 0;
    document.addEventListener('scroll', () => {
      if (!tipTarget || scrollCheck) return;
      scrollCheck = requestAnimationFrame(() => {
        scrollCheck = 0;
        if (!tipTarget || tipHovered) return; // being read - leave it where it is
        const r = tipTarget.isConnected ? tipTarget.getBoundingClientRect() : null;
        const onScreen = r && r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
        const underPointer = onScreen && lastPointer &&
          lastPointer.x >= r.left && lastPointer.x <= r.right && lastPointer.y >= r.top && lastPointer.y <= r.bottom;
        if (underPointer) refreshTip();
        else hideTip();
      });
    }, true);
  }

  // ---------------------------------------------------------------- startup

  function watchTable() {
    const tbody = document.querySelector(TBODY_SEL);
    if (!tbody) return false;
    new MutationObserver(badgeAdded).observe(tbody, { childList: true });
    return true;
  }

  /**
   * One scroll area under the video: the controls card (.l-group-btn, with the
   * ··· tray) and the 刷新 + converter + timer row are moved into
   * .ddr-live-scroll, which scrolls when their total height is more than the
   * space left under the video; the video never scrolls. Two EC2 blocks can't
   * share a scroll container with CSS alone, so these two nodes are moved (like
   * 竞标开始 in placeStartButton). Safe: living.js reaches them only by id
   * (#refresh, #oneClickStartBtn) and inline onclick, Bootstrap's dropdown
   * is delegated on document, and nothing walks from their parents. The row is
   * tagged .ddr-refresh-row first - it is no longer .widget-box's first child.
   * The wrapper sits inside .ddr-goods .widget-box (display: contents) so it is
   * a grid item of the left column and .ddr-goods #refresh rules still match.
   */
  let liveScrollEl = null;

  function installLiveScroll() {
    if (liveScrollEl) return;
    const group = document.querySelector('.ddr-col-left .l-group-btn');
    const row = document.querySelector('.ddr-goods .widget-box > div:first-child');
    const box = row && row.parentElement;
    if (!group || !row || !box) return;
    row.classList.add('ddr-refresh-row');
    liveScrollEl = mk('div', 'ddr-live-scroll');
    box.insertBefore(liveScrollEl, row);
    liveScrollEl.appendChild(group);
    liveScrollEl.appendChild(row);
  }

  function start() {
    installTips();
    buildPanel();
    installChatClicks();

    const layout = () => {
      if (!(tagTables() && reclaimSpace())) return false;
      installLiveScroll();
      installDock();
      installVideoMenu();
      installVideoStats();
      installSalesButton();
      placeStartButton();
      wireReloadButton();
      installConverter();
      installTimer();
      watchGoods();
      installBatchButton();
      installComposerToggle();
      return true;
    };
    let refit;
    window.addEventListener('resize', () => {
      clearTimeout(refit);
      refit = setTimeout(() => {
        winFitDone = false;
        wonCellWidth = 0;
        fitWinCells();
        badgeAll();
      }, 250);
    });
    if (!layout()) {
      const t = setInterval(() => {
        if (layout()) clearInterval(t);
      }, 1000);
      setTimeout(() => clearInterval(t), 30000);
    }

    if (!watchTable()) {
      const iv = setInterval(() => {
        if (watchTable()) clearInterval(iv);
      }, 1000);
      setTimeout(() => clearInterval(iv), 30000);
    }

    initBatch();
    startTonightWins();
    poll();
    setInterval(poll, POLL_MS);
    setInterval(() => {
      if (pending.size) badgeAll();
      fitWinCells(); // a quiet live may draw its first won row between polls
      checkWonWidth();
      fitAllWonNames();
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
