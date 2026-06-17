(function () {
  const ALLOWED_ASSET_ID = '103550019254847';
  if (!location.href.includes(ALLOWED_ASSET_ID)) return;

  const PANEL_ID = 'cim-purchase-panel';
  const CHECK_ANCESTOR_DEPTH = 6;
  const DEBOUNCE_MS = 300;

  const CART_OPTIONS = [
    { option: '1', label: 'ALL', modifier: 'cim-cart-btn--both' },
    { option: '2', label: '🇲🇾 MYR', modifier: 'cim-cart-btn--myr' },
    { option: '3', label: '🇸🇬 SGD', modifier: 'cim-cart-btn--sgd' },
  ];
  const EMPTY_CART_MARKER = '您的购物车里暂无商品哦~';
  const DEFAULT_CART_PREFIX = '【多多直播人手结单 Manual Listing】 我们的直播是每一天汇款，超过24小时没有汇款购物车可能会被删除哦~ 🙏\nJust a gentle reminder to settle your payment on the same day for livestream orders. Unpaid carts may be removed after 24 hours. ❤️';

  let debounceTimer = null;
  let cartSessionValid = false;
  let cartPrefixText = '';
  let panelPosition = null; // {x, y} px — null means sidebar (default), set after first drag

  let sessionState = {
    uid: null,
    name: null,
    resolved: false,
    view: null,
    cartHasItems: null,
    expiredAvailable: null,
  };

  function getUserIdFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('selected_item_id');
    } catch (err) {
      return null;
    }
  }

  function findContactDetailsAnchor() {
    const candidates = document.querySelectorAll('div, span, h1, h2, h3, h4');
    for (const el of candidates) {
      if (el.children.length === 0 && el.textContent.trim() === 'Contact details') {
        let anchor = el;
        let depth = 0;
        while (anchor.parentElement && depth < CHECK_ANCESTOR_DEPTH) {
          if (anchor.parentElement.children.length > 1) {
            return anchor;
          }
          anchor = anchor.parentElement;
          depth++;
        }
        return anchor;
      }
    }
    return null;
  }

  function getCustomerNameFromDom() {
    // Strategy 1: sidebar "View profile" element
    const candidates = document.querySelectorAll('a, span, div');
    for (const el of candidates) {
      if (el.children.length === 0 && el.textContent.trim() === 'View profile') {
        let container = el.parentElement;
        for (let depth = 0; depth < 4 && container; depth++) {
          const leaves = container.querySelectorAll('span, div, h1, h2, h3, h4');
          for (const leaf of leaves) {
            const text = leaf.textContent.trim();
            if (leaf.children.length === 0 && text && text !== 'View profile') {
              return text;
            }
          }
          container = container.parentElement;
        }
      }
    }

    // Strategy 2: chat header (visible even when sidebar is hidden) — find a
    // line-clamped leaf inside a container that also has the assignment line.
    const clamped = document.querySelectorAll('div[style*="-webkit-line-clamp"], span[style*="-webkit-line-clamp"]');
    for (const el of clamped) {
      if (el.children.length > 0) continue;
      const text = el.textContent.trim();
      if (!text) continue;
      let container = el.parentElement;
      for (let depth = 0; depth < 4 && container; depth++) {
        if (container.textContent.includes('Assigned to ') || container.textContent.includes('Assign this conversation')) {
          return text;
        }
        container = container.parentElement;
      }
    }

    return null;
  }

  function getUidPsidMap() {
    return new Promise((resolve) => {
      chrome.storage.local.get('uidPsidMap', (result) => {
        resolve(result.uidPsidMap || {});
      });
    });
  }

  function setUidPsidLink(uid, psid) {
    return getUidPsidMap().then((map) => {
      map[uid] = psid;
      return new Promise((resolve) => {
        chrome.storage.local.set({ uidPsidMap: map }, resolve);
      });
    });
  }

  const ATTACHMENT_LABELS_BY_EXT = {
    jpg: 'Photo',
    jpeg: 'Photo',
    png: 'Photo',
    gif: 'Photo',
    webp: 'Photo',
    bmp: 'Photo',
    svg: 'Photo',
    heic: 'Photo',
    mp4: 'Video',
    mov: 'Video',
    webm: 'Video',
    avi: 'Video',
    mkv: 'Video',
    m4v: 'Video',
    pdf: 'PDF',
    mp3: 'Audio',
    wav: 'Audio',
    ogg: 'Audio',
    m4a: 'Audio',
    aac: 'Audio',
  };

  function getAttachmentLabel(text) {
    let url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const match = url.pathname.match(/\.([a-z0-9]+)$/i);
    const ext = match ? match[1].toLowerCase() : null;
    return (ext && ATTACHMENT_LABELS_BY_EXT[ext]) || 'Attachment';
  }

  function formatValue(value) {
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function formatCurrency(value) {
    const num = Number(value);
    if (Number.isNaN(num)) return 'RM —';
    return `RM ${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatRecency(days) {
    if (days === null || days === undefined || days === '') return '—';
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d < 0) return '—';
    const years = Math.floor(d / 365);
    const months = Math.floor((d % 365) / 30);
    const remDays = d % 30;
    const parts = [];
    if (years) parts.push(`${years}y`);
    if (months) parts.push(`${months}m`);
    if (remDays || parts.length === 0) parts.push(`${remDays}d`);
    return `${parts.join(' ')} ago`;
  }

  function removeUidPsidLink(uid) {
    return getUidPsidMap().then((map) => {
      delete map[uid];
      return new Promise((resolve) => {
        chrome.storage.local.set({ uidPsidMap: map }, resolve);
      });
    });
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="cim-drag-handle">· · · · ·</div>
      <div class="cim-row cim-uid"></div>
      <div class="cim-row cim-name"></div>
      <div class="cim-row cim-psid"></div>
      <div class="cim-body"></div>
    `;
    return panel;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = buildPanel();
    initDrag(panel);

    if (panelPosition) {
      document.body.appendChild(panel);
      panel.classList.add('cim-floating');
      panel.style.left = panelPosition.x + 'px';
      panel.style.top  = panelPosition.y + 'px';
    } else {
      const anchor = findContactDetailsAnchor();
      if (!anchor || !anchor.parentElement) return null;
      anchor.parentElement.insertBefore(panel, anchor);
    }

    return panel;
  }

  function initDrag(panel) {
    const handle = panel.querySelector('.cim-drag-handle');
    handle.addEventListener('mousedown', (e) => {
      const rect = panel.getBoundingClientRect();

      if (!panelPosition) {
        const floatLeft = rect.left;
        const floatTop  = rect.top;
        document.body.appendChild(panel);
        panel.classList.add('cim-floating');
        panel.style.left = floatLeft + 'px';
        panel.style.top  = floatTop  + 'px';
      }

      const offsetX = e.clientX - panel.getBoundingClientRect().left;
      const offsetY = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();

      function onMove(e) {
        const newLeft = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth  - panel.offsetWidth));
        const newTop  = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - panel.offsetHeight));
        panel.style.left = newLeft + 'px';
        panel.style.top  = newTop  + 'px';
      }

      function onUp() {
        panelPosition = { x: parseFloat(panel.style.left), y: parseFloat(panel.style.top) };
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  function renderPsidRow(panel, uid, psid) {
    const row = panel.querySelector('.cim-psid');
    row.innerHTML = '';

    const nameRow = panel.querySelector('.cim-name');
    const cartUrl = psid
      ? 'https://ec2.full2house.com/Ent/index.php?win_name=&fb_user_id=' +
        encodeURIComponent(psid) +
        '&a=EntLive&m=mallCartUserLists&live_id='
      : null;

    if (cartUrl) {
      nameRow.innerHTML = '';
      nameRow.append('Name: ');
      const nameLink = document.createElement('a');
      nameLink.className = 'cim-name-link';
      nameLink.href = cartUrl;
      nameLink.target = '_blank';
      nameLink.rel = 'noopener noreferrer';
      nameLink.textContent = sessionState.name || '';
      nameRow.append(nameLink);
    }

    if (psid) {
      row.append('PSID: ');
      const psidSpan = document.createElement('span');
      psidSpan.className = 'cim-psid-link';
      psidSpan.textContent = psid;
      psidSpan.style.cursor = 'pointer';

      const tooltip = document.createElement('span');
      tooltip.className = 'cim-copy-tooltip';
      tooltip.textContent = 'Copied!';

      psidSpan.addEventListener('click', () => {
        copyToClipboard(psid).then(() => {
          tooltip.classList.add('cim-copy-tooltip--visible');
          setTimeout(() => tooltip.classList.remove('cim-copy-tooltip--visible'), 1500);
        });
      });

      const psidWrap = document.createElement('span');
      psidWrap.style.position = 'relative';
      psidWrap.style.display = 'inline-block';
      psidWrap.append(psidSpan, tooltip);

      row.append(psidWrap, ' ');
      const unlink = document.createElement('a');
      unlink.href = '#';
      unlink.className = 'cim-unlink';
      unlink.textContent = '(unlink)';
      unlink.addEventListener('click', (event) => {
        event.preventDefault();
        handleUnlink(uid, panel);
      });
      row.append(unlink);
    } else {
      row.textContent = 'PSID: Not linked';
    }
  }

  function buildCandidateCard(candidate) {
    const card = document.createElement('div');
    card.className = 'cim-candidate';
    card.dataset.psid = candidate.psid;

    const avatar = document.createElement('img');
    avatar.className = 'cim-candidate-avatar';
    avatar.alt = '';
    if (candidate.profilePic) {
      avatar.src = candidate.profilePic;
      avatar.addEventListener('error', () => {
        avatar.style.visibility = 'hidden';
      });
    } else {
      avatar.style.visibility = 'hidden';
    }

    const info = document.createElement('div');
    info.className = 'cim-candidate-info';

    const name = document.createElement('div');
    name.className = 'cim-candidate-name';
    name.textContent = candidate.name || '(no name)';

    const lastMsg = document.createElement('div');
    lastMsg.className = 'cim-candidate-last-msg';
    const attachmentLabel = getAttachmentLabel(candidate.lastMessage || '');
    if (attachmentLabel) {
      const link = document.createElement('a');
      link.href = candidate.lastMessage;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'cim-candidate-attachment-link';
      link.textContent = attachmentLabel;
      lastMsg.appendChild(link);
    } else {
      lastMsg.textContent = candidate.lastMessage || '';
    }

    info.appendChild(name);
    info.appendChild(lastMsg);

    const linkBtn = document.createElement('button');
    linkBtn.className = 'cim-candidate-link-btn';
    linkBtn.textContent = 'Link';

    card.appendChild(avatar);
    card.appendChild(info);
    card.appendChild(linkBtn);
    return card;
  }

  function buildBaserowCandidateCard(candidate) {
    const card = document.createElement('div');
    card.className = 'cim-candidate cim-candidate--baserow';
    card.dataset.psid = candidate.psid;

    const info = document.createElement('div');
    info.className = 'cim-candidate-info';

    const name = document.createElement('div');
    name.className = 'cim-candidate-name';
    name.textContent = candidate.name || '(no name)';

    const meta = document.createElement('div');
    meta.className = 'cim-candidate-meta';

    const lastOrder = document.createElement('span');
    lastOrder.textContent = `Last Order: ${formatValue(candidate.lastOrderDate)}`;

    const rank = document.createElement('span');
    rank.textContent = `Rank: ${formatValue(candidate.rfmScore)}`;

    meta.append(lastOrder, rank);
    info.append(name, meta);

    const linkBtn = document.createElement('button');
    linkBtn.className = 'cim-candidate-link-btn';
    linkBtn.textContent = 'Link';

    card.append(info, linkBtn);
    return card;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      if (ok) resolve();
      else reject(new Error('Copy failed'));
    });
  }

  function buildCopyButton(text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cim-copy-btn';
    btn.title = 'Copy Order ID';
    btn.setAttribute('aria-label', 'Copy Order ID');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '9');
    rect.setAttribute('y', '9');
    rect.setAttribute('width', '13');
    rect.setAttribute('height', '13');
    rect.setAttribute('rx', '2');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

    svg.append(rect, path);
    btn.appendChild(svg);

    const tooltip = document.createElement('span');
    tooltip.className = 'cim-copy-tooltip';
    tooltip.textContent = 'Copied!';
    btn.appendChild(tooltip);

    let hideTimer = null;
    btn.addEventListener('click', () => {
      copyToClipboard(String(text)).then(() => {
        tooltip.classList.add('cim-copy-tooltip--visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          tooltip.classList.remove('cim-copy-tooltip--visible');
        }, 1500);
      });
    });

    return btn;
  }

  function buildCartOptionButton(psid, option, label, modifierClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cim-cart-btn ${modifierClass}`;

    const labelEl = document.createElement('span');
    labelEl.className = 'cim-cart-btn-label';
    labelEl.textContent = label;

    const tooltip = document.createElement('span');
    tooltip.className = 'cim-copy-tooltip';

    btn.append(labelEl, tooltip);

    let hideTimer = null;
    const showTooltip = (text) => {
      tooltip.textContent = text;
      tooltip.classList.add('cim-copy-tooltip--visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => tooltip.classList.remove('cim-copy-tooltip--visible'), 1500);
    };

    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const uid = sessionState.uid;
      btn.disabled = true;
      labelEl.textContent = 'Loading...';

      chrome.runtime.sendMessage({ type: 'GET_CART_SUMMARY', psid, option }, (response) => {
        if (getUserIdFromUrl() !== uid) return;
        btn.disabled = false;
        labelEl.textContent = label;

        if (chrome.runtime.lastError || !response || !response.ok) {
          showTooltip(response?.error || 'Failed.');
          return;
        }

        if (response.text.includes(EMPTY_CART_MARKER)) {
          showTooltip('Empty Cart!');
          return;
        }

        const customPrefix = document.getElementById(PANEL_ID)?.querySelector('.cim-cart-prefix')?.value.trim() || '';
        const textToCopy = customPrefix
          ? response.text.replace(DEFAULT_CART_PREFIX, customPrefix)
          : response.text;
        copyToClipboard(textToCopy).then(() => showTooltip('Copied!'));
      });
    });

    return btn;
  }

  function buildExpiredNotice() {
    const el = document.createElement('div');
    el.className = 'cim-expired-notice';
    el.textContent = '⚠️ Expired items available';
    return el;
  }

  function buildCartSection(psid) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cim-cart-section';

    const cartButtons = document.createElement('div');
    cartButtons.className = 'cim-cart-buttons';
    CART_OPTIONS.forEach(({ option, label, modifier }) => {
      cartButtons.appendChild(buildCartOptionButton(psid, option, label, modifier));
    });

    const prefixInput = document.createElement('textarea');
    prefixInput.className = 'cim-cart-prefix';
    prefixInput.placeholder = '【多多直播人手结单 Manual Listing】 (default)';
    prefixInput.value = cartPrefixText;
    prefixInput.addEventListener('input', () => {
      cartPrefixText = prefixInput.value;
    });

    wrapper.appendChild(cartButtons);
    wrapper.appendChild(prefixInput);
    return wrapper;
  }

  function probeCartAndShowButtons(uid, psid, panel) {
    if (!cartSessionValid || sessionState.cartHasItems !== null) return;

    chrome.runtime.sendMessage({ type: 'GET_CART_SUMMARY', psid, option: '1' }, (response) => {
      if (getUserIdFromUrl() !== uid) return;
      if (chrome.runtime.lastError || !response || !response.ok) return;

      const hasItems = !response.text.includes(EMPTY_CART_MARKER);
      sessionState.cartHasItems = hasItems;
      sessionState.expiredAvailable = response.expiredAvailable === true;

      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel || sessionState.view?.type !== 'orders') return;

      const body = livePanel.querySelector('.cim-body');

      if (sessionState.expiredAvailable && !body.querySelector('.cim-expired-notice')) {
        body.insertBefore(buildExpiredNotice(), body.firstChild);
      }

      const heading = body.querySelector('.cim-orders-heading');
      if (!heading || body.querySelector('.cim-cart-buttons') || body.querySelector('.cim-cart-empty')) return;

      if (hasItems) {
        body.insertBefore(buildCartSection(psid), heading);
      } else {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'cim-cart-empty';
        emptyEl.textContent = '🛒 Empty Cart';
        body.insertBefore(emptyEl, heading);
      }
    });
  }

  function renderCandidatesList(list, candidates, type) {
    list.innerHTML = '';
    const buildCard = type === 'baserow' ? buildBaserowCandidateCard : buildCandidateCard;
    candidates.forEach((candidate) => list.appendChild(buildCard(candidate)));
  }

  function renderState(panel, view) {
    sessionState.view = view;
    const body = panel.querySelector('.cim-body');
    body.innerHTML = '';

    switch (view.type) {
      case 'loading': {
        body.textContent = 'Loading...';
        break;
      }
      case 'searching': {
        body.textContent = 'No PSID linked. Searching ManyChat for matches...';
        break;
      }
      case 'linking': {
        body.textContent = 'Updating Baserow...';
        break;
      }
      case 'orders': {
        const data = view.data;

        if (sessionState.expiredAvailable === true) {
          body.appendChild(buildExpiredNotice());
        }

        const summary = document.createElement('div');
        summary.className = 'cim-summary';

        const addSummaryRow = (label, value, extraClass) => {
          const row = document.createElement('div');
          row.className = 'cim-summary-row';

          const labelEl = document.createElement('span');
          labelEl.className = 'cim-summary-label';
          labelEl.textContent = label;

          const valueEl = document.createElement('span');
          valueEl.className = extraClass ? `cim-summary-value ${extraClass}` : 'cim-summary-value';
          valueEl.textContent = value;

          row.append(labelEl, valueEl);
          summary.appendChild(row);
          return { row, valueEl };
        };

        addSummaryRow('Total Spending', formatCurrency(data.totalSpending));
        addSummaryRow('Total Purchase', formatValue(data.totalPurchase));

        const { valueEl: lastOrderEl } = addSummaryRow('Last Order', formatRecency(data.rawRecency));
        if (data.lastOrderDate !== null && data.lastOrderDate !== undefined && data.lastOrderDate !== '') {
          lastOrderEl.dataset.tooltip = String(data.lastOrderDate);
        }
        addSummaryRow('Years Active', formatValue(data.yearsActive));
        addSummaryRow('Rank', formatValue(data.rank));

        const { valueEl: addrEl } = addSummaryRow('Address', formatValue(data.address), 'cim-summary-value--address');
        if (data.address !== null && data.address !== undefined && data.address !== '') {
          addrEl.textContent = '';
          addrEl.append(String(data.address), buildCopyButton(data.address));
        }

        body.appendChild(summary);

        if (cartSessionValid && sessionState.cartHasItems === true) {
          body.appendChild(buildCartSection(view.psid));
        } else if (cartSessionValid && sessionState.cartHasItems === false) {
          const emptyEl = document.createElement('div');
          emptyEl.className = 'cim-cart-empty';
          emptyEl.textContent = '🛒 Empty Cart';
          body.appendChild(emptyEl);
        }

        const heading = document.createElement('div');
        heading.className = 'cim-orders-heading';

        const headingLink = document.createElement('a');
        headingLink.textContent = 'Recent Orders';
        headingLink.href =
          'https://ec2.full2house.com/Ent/index.php?order_sn=&fb_user_id=' +
          encodeURIComponent(view.psid) +
          '&consignee=&mobile=&user_name=&shipping_id=-1&first_letter=&composite_status=-1' +
          '&fromMode=&more_cart_id=-1&pay_id=-1&print_status_shipment=0&date_type=order_time' +
          '&start_time=&end_time=&a=EntMall&m=orderList&name_sort=&new_status=0&no_cancel=on';
        headingLink.target = '_blank';
        headingLink.rel = 'noopener noreferrer';
        heading.appendChild(headingLink);
        body.appendChild(heading);

        if (!data.recentOrders.length) {
          const empty = document.createElement('div');
          empty.className = 'cim-orders-empty';
          empty.textContent = 'No orders found.';
          body.appendChild(empty);
        } else {
          const list = document.createElement('ul');
          list.className = 'cim-orders-list';

          data.recentOrders.forEach((order) => {
            const li = document.createElement('li');

            const idWrap = document.createElement('span');
            idWrap.className = 'cim-order-id-wrap';

            const idEl = document.createElement('a');
            idEl.className = 'cim-order-id';
            idEl.textContent = formatValue(order.orderId);
            idEl.href = `https://ddherbs.com.my/track/${encodeURIComponent(order.orderId)}`;
            idEl.target = '_blank';
            idEl.rel = 'noopener noreferrer';

            if (order.orderDate) {
              const d = new Date(order.orderDate);
              const dateStr = `(${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()})`;
              const dateEl = document.createElement('span');
              dateEl.className = 'cim-order-date';
              dateEl.textContent = ' ' + dateStr;
              idWrap.append(idEl, dateEl, buildCopyButton(order.orderId));
            } else {
              idWrap.append(idEl, buildCopyButton(order.orderId));
            }

            const amountEl = document.createElement('span');
            amountEl.className = 'cim-order-amount';
            amountEl.textContent = formatCurrency(order.totalAmount);

            li.append(idWrap, amountEl);
            list.appendChild(li);
          });

          body.appendChild(list);

          const orderIds = data.recentOrders.map((o) => o.orderId).filter(Boolean);
          if (orderIds.length) {
            const capturedUid = sessionState.uid;
            chrome.runtime.sendMessage({ type: 'GET_ORDER_STATUSES', orderIds }, (response) => {
              if (getUserIdFromUrl() !== capturedUid) return;
              if (!response?.ok || !response.statuses) return;
              const livePanel = document.getElementById(PANEL_ID);
              if (!livePanel) return;
              livePanel.querySelectorAll('.cim-order-id').forEach((el) => {
                if (response.statuses[el.textContent] === 'WAIT_AUDIT') {
                  el.style.color = 'orange';
                }
              });
            });
          }
        }
        break;
      }
      case 'new-customer': {
        body.textContent = 'New customer — no purchase history found in Baserow yet.';
        break;
      }
      case 'candidates': {
        const list = document.createElement('div');
        list.className = 'cim-candidates-list';
        renderCandidatesList(list, view.candidates, view.candidatesType || 'manychat');
        body.appendChild(list);

        const searchBar = document.createElement('div');
        searchBar.className = 'cim-candidate-search';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'cim-search-input';
        searchInput.placeholder = 'Search Order ID or User ID...';

        const searchBtn = document.createElement('button');
        searchBtn.className = 'cim-search-btn';
        searchBtn.textContent = 'Search';

        searchBar.append(searchInput, searchBtn);
        body.appendChild(searchBar);

        const searchStatus = document.createElement('div');
        searchStatus.className = 'cim-search-status';
        body.appendChild(searchStatus);
        break;
      }
      case 'no-match': {
        body.textContent = `No ManyChat contact found matching "${view.name}".`;
        break;
      }
      case 'error': {
        body.textContent = view.message;
        break;
      }
    }
  }

  function loadOrders(uid, psid, panel, recreateAttempted) {
    renderState(panel, { type: 'loading' });

    chrome.runtime.sendMessage({ type: 'GET_ORDERS_BY_PSID', psid }, (response) => {
      if (getUserIdFromUrl() !== uid) return;
      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel) return;

      if (chrome.runtime.lastError || !response || !response.ok) {
        sessionState.resolved = true;
        renderState(livePanel, {
          type: 'error',
          message: response?.error || 'Failed to load orders.',
        });
        return;
      }

      if (response.notFound) {
        if (recreateAttempted) {
          sessionState.resolved = true;
          renderState(livePanel, { type: 'new-customer' });
          return;
        }

        // Already linked (uidPsidMap has this PSID) but the Baserow row is
        // missing - recreate it, same as the initial "Link" flow.
        chrome.runtime.sendMessage(
          { type: 'LINK_BASEROW_UID', uid, psid, name: sessionState.name },
          (linkResponse) => {
            if (getUserIdFromUrl() !== uid) return;
            const linkPanel = document.getElementById(PANEL_ID);
            if (!linkPanel) return;

            if (chrome.runtime.lastError || !linkResponse || !linkResponse.ok) {
              sessionState.resolved = true;
              renderState(linkPanel, {
                type: 'error',
                message: linkResponse?.error || 'Failed to recreate Baserow record.',
              });
              return;
            }

            loadOrders(uid, psid, linkPanel, true);
          }
        );
        return;
      }

      sessionState.resolved = true;
      renderState(livePanel, { type: 'orders', data: response.data, psid });
      probeCartAndShowButtons(uid, psid, livePanel);
    });
  }

  function searchManyChat(uid, name, panel) {
    renderState(panel, { type: 'searching' });

    chrome.runtime.sendMessage({ type: 'SEARCH_MANYCHAT_BY_NAME', name }, (response) => {
      if (getUserIdFromUrl() !== uid) return;
      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel) return;

      sessionState.resolved = true;

      if (chrome.runtime.lastError || !response || !response.ok) {
        renderState(livePanel, {
          type: 'error',
          message: response?.error || 'ManyChat search failed.',
        });
        return;
      }

      if (!response.candidates.length) {
        renderState(livePanel, { type: 'no-match', name });
      } else {
        renderState(livePanel, {
          type: 'candidates',
          candidates: response.candidates,
          candidatesType: 'manychat',
          manychatCandidates: response.candidates,
        });
      }
    });
  }

  function proceedWithLookup(uid, name, panel) {
    getUidPsidMap().then((map) => {
      if (getUserIdFromUrl() !== uid) return;
      const livePanel = document.getElementById(PANEL_ID) || panel;
      const psid = map[uid];
      if (psid) {
        renderPsidRow(livePanel, uid, psid);
        loadOrders(uid, psid, livePanel);
      } else {
        chrome.runtime.sendMessage({ type: 'SEARCH_BASEROW_BY_UID', uid }, (response) => {
          if (getUserIdFromUrl() !== uid) return;
          const currentPanel = document.getElementById(PANEL_ID) || livePanel;
          if (response?.ok && response.psid) {
            setUidPsidLink(uid, response.psid).then(() => {
              renderPsidRow(currentPanel, uid, response.psid);
              loadOrders(uid, response.psid, currentPanel);
            });
          } else {
            renderPsidRow(currentPanel, uid, null);
            searchManyChat(uid, name, currentPanel);
          }
        });
      }
    });
  }

  function handleCandidateLink(uid, psid, panel) {
    renderState(panel, { type: 'linking' });

    chrome.runtime.sendMessage(
      { type: 'LINK_BASEROW_UID', uid, psid, name: sessionState.name },
      (response) => {
        if (getUserIdFromUrl() !== uid) return;
        const livePanel = document.getElementById(PANEL_ID);
        if (!livePanel) return;

        if (chrome.runtime.lastError || !response || !response.ok) {
          renderState(livePanel, {
            type: 'error',
            message: response?.error || 'Failed to update Baserow record.',
          });
          return;
        }

        setUidPsidLink(uid, psid).then(() => {
          if (getUserIdFromUrl() !== uid) return;
          renderPsidRow(livePanel, uid, psid);
          loadOrders(uid, psid, livePanel);
        });
      }
    );
  }

  function handleUnlink(uid, panel) {
    getUidPsidMap().then((map) => {
      const psid = map[uid];
      if (!psid) return;

      renderState(panel, { type: 'linking' });

      chrome.runtime.sendMessage({ type: 'UNLINK_BASEROW_UID', psid }, (response) => {
        if (getUserIdFromUrl() !== uid) return;
        const livePanel = document.getElementById(PANEL_ID);
        if (!livePanel) return;

        if (chrome.runtime.lastError || !response || !response.ok) {
          renderState(livePanel, {
            type: 'error',
            message: response?.error || 'Failed to update Baserow record.',
          });
          return;
        }

        removeUidPsidLink(uid).then(() => {
          if (getUserIdFromUrl() !== uid) return;
          sessionState.resolved = false;
          sessionState.cartHasItems = null;
          renderPsidRow(livePanel, uid, null);
          if (sessionState.name) {
            proceedWithLookup(uid, sessionState.name, livePanel);
          } else {
            renderState(livePanel, { type: 'loading' });
          }
        });
      });
    });
  }

  function handleCandidateSearch(uid, query, panel) {
    const searchBtn = panel.querySelector('.cim-search-btn');
    const statusEl = panel.querySelector('.cim-search-status');
    const originalLabel = searchBtn ? searchBtn.textContent : 'Search';
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.classList.remove('cim-search-status--error');
    }

    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching...';
    }

    // Resolves the live panel and resets the search button after a response;
    // returns null if the panel/UID has changed since the request was sent.
    function getLivePanel() {
      if (getUserIdFromUrl() !== uid) return null;
      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel) return null;

      const liveBtn = livePanel.querySelector('.cim-search-btn');
      if (liveBtn) {
        liveBtn.disabled = false;
        liveBtn.textContent = originalLabel;
      }

      return livePanel;
    }

    if (!query) {
      chrome.runtime.sendMessage({ type: 'SEARCH_MANYCHAT_BY_NAME', name: sessionState.name }, (response) => {
        const livePanel = getLivePanel();
        if (!livePanel) return;

        const liveStatus = livePanel.querySelector('.cim-search-status');

        if (chrome.runtime.lastError || !response || !response.ok) {
          if (liveStatus) {
            liveStatus.textContent = response?.error || 'Search failed.';
            liveStatus.classList.add('cim-search-status--error');
          }
          return;
        }

        if (!response.candidates?.length) {
          if (liveStatus) {
            liveStatus.textContent = 'No matches found.';
            liveStatus.classList.add('cim-search-status--error');
          }
          return;
        }

        const list = livePanel.querySelector('.cim-candidates-list');
        if (!list) return;

        renderCandidatesList(list, response.candidates, 'manychat');
        if (sessionState.view && sessionState.view.type === 'candidates') {
          sessionState.view.candidates = response.candidates;
          sessionState.view.candidatesType = 'manychat';
          sessionState.view.manychatCandidates = response.candidates;
        }
      });
      return;
    }

    const messageType = /^f/i.test(query) ? 'SEARCH_BASEROW_BY_ORDER_ID' : 'SEARCH_BASEROW_BY_PSID';
    const payload = messageType === 'SEARCH_BASEROW_BY_ORDER_ID' ? { orderId: query } : { psid: query };

    chrome.runtime.sendMessage({ type: messageType, ...payload }, (response) => {
      const livePanel = getLivePanel();
      if (!livePanel) return;

      const liveStatus = livePanel.querySelector('.cim-search-status');

      if (chrome.runtime.lastError || !response || !response.ok) {
        if (liveStatus) {
          liveStatus.textContent = response?.error || 'Search failed.';
          liveStatus.classList.add('cim-search-status--error');
        }
        return;
      }

      if (!response.candidates?.length) {
        if (liveStatus) {
          liveStatus.textContent = 'No matches found.';
          liveStatus.classList.add('cim-search-status--error');
        }
        return;
      }

      const list = livePanel.querySelector('.cim-candidates-list');
      if (!list) return;

      renderCandidatesList(list, response.candidates, 'baserow');
      if (sessionState.view && sessionState.view.type === 'candidates') {
        sessionState.view.candidates = response.candidates;
        sessionState.view.candidatesType = 'baserow';
      }
    });
  }

  function rehydrate(panel) {
    panel.querySelector('.cim-name').textContent = `Name: ${sessionState.name}`;
    getUidPsidMap().then((map) => {
      renderPsidRow(panel, sessionState.uid, map[sessionState.uid] || null);
    });
    if (sessionState.view) {
      renderState(panel, sessionState.view);
      if (cartSessionValid && sessionState.view.type === 'orders' && sessionState.cartHasItems === null) {
        probeCartAndShowButtons(sessionState.uid, sessionState.view.psid, panel);
      }
    }
  }

  function check() {
    if (!location.href.includes(ALLOWED_ASSET_ID)) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }

    const uid = getUserIdFromUrl();
    if (!uid) return;

    const panelExisted = !!document.getElementById(PANEL_ID);
    const panel = ensurePanel();
    if (!panel) return;

    if (uid !== sessionState.uid) {
      sessionState = { uid, name: null, resolved: false, view: null, cartHasItems: null, expiredAvailable: null };
      panel.querySelector('.cim-uid').textContent = `UID: ${uid}`;
      panel.querySelector('.cim-name').textContent = 'Name: detecting...';
      panel.querySelector('.cim-psid').textContent = 'PSID: checking...';
      renderState(panel, { type: 'loading' });
      // Return immediately so the SPA has time to update the profile DOM before
      // we attempt name detection — otherwise we'd read the previous customer's name.
      return;
    } else if (!panelExisted) {
      panel.querySelector('.cim-uid').textContent = `UID: ${uid}`;
      panel.querySelector('.cim-name').textContent = sessionState.name
        ? `Name: ${sessionState.name}`
        : 'Name: detecting...';

      if (sessionState.resolved) {
        rehydrate(panel);
        return;
      }

      panel.querySelector('.cim-psid').textContent = 'PSID: checking...';
    }

    if (sessionState.resolved) return;

    if (sessionState.name == null) {
      const name = getCustomerNameFromDom();
      if (!name) return;
      sessionState.name = name;
      panel.querySelector('.cim-name').textContent = `Name: ${name}`;
      proceedWithLookup(uid, name, panel);
    }
  }

  function scheduleCheck() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(check, DEBOUNCE_MS);
  }

  document.addEventListener('click', (event) => {
    const linkBtn = event.target.closest('.cim-candidate-link-btn');
    if (linkBtn) {
      const card = linkBtn.closest('.cim-candidate');
      const panel = document.getElementById(PANEL_ID);
      if (!card || !panel || !sessionState.uid) return;
      handleCandidateLink(sessionState.uid, card.dataset.psid, panel);
      return;
    }

    const searchBtn = event.target.closest('.cim-search-btn');
    if (searchBtn) {
      const panel = document.getElementById(PANEL_ID);
      const input = searchBtn.closest('.cim-candidate-search')?.querySelector('.cim-search-input');
      if (!panel || !input || !sessionState.uid) return;
      handleCandidateSearch(sessionState.uid, input.value.trim(), panel);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const input = event.target.closest('.cim-search-input');
    if (!input) return;
    event.preventDefault();
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !sessionState.uid) return;
    handleCandidateSearch(sessionState.uid, input.value.trim(), panel);
  });

  function initCartSessionCheck() {
    chrome.runtime.sendMessage({ type: 'CHECK_SESSION' }, (response) => {
      cartSessionValid = !!(response && response.ok && response.valid);
      if (cartSessionValid && sessionState.view?.type === 'orders') {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) return;
        if (sessionState.cartHasItems === true) {
          renderState(panel, sessionState.view);
        } else if (sessionState.cartHasItems === null) {
          probeCartAndShowButtons(sessionState.uid, sessionState.view.psid, panel);
        }
      }
    });
  }

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  initCartSessionCheck();
  scheduleCheck();
})();
