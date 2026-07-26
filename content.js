(function () {
  const ALLOWED_ASSET_ID = '103550019254847';
  if (!location.href.includes(ALLOWED_ASSET_ID)) return;

  const PANEL_ID = 'cim-purchase-panel';
  const AI_BUTTONS_ID = 'cim-ai-buttons';
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
  let aiHealthy = null;        // null = unchecked, true/false = result
  let aiHealthPending = false;
  let aiPreviousText = '';
  let aiLanguage = 'chinese';
  let cartPrefixText = '';
  let panelPosition = null; // {x, y} px — null means sidebar (default), set after first drag

  const PARCEL_DRAWER_ID = 'cim-parcel-drawer';
  const PARCEL_OVERLAY_ID = 'cim-parcel-overlay';
  const GALLERY_MODAL_ID = 'cim-gallery-modal';
  let galleryImages = [];
  let galleryIndex = 0;

  const CART_MODAL_ID = 'cim-cart-modal';
  const CART_MODAL_OVERLAY_ID = 'cim-cart-modal-overlay';

  const ORDER_LIST_MODAL_ID = 'cim-order-list-modal';
  const ORDER_LIST_OVERLAY_ID = 'cim-order-list-overlay';
  let orderListModalPsid = null;
  let orderDetailOrderId = null;

  let sessionState = {
    uid: null,
    name: null,
    resolved: false,
    view: null,
    cartHasItems: null,
    expiredAvailable: null,
    myrSum: null,
    sgdSum: null,
    manychatInfo: null,
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
    const ANCHOR_TEXTS = ['Contact details', 'About', 'Facebook profile', 'Data sharing'];
    const candidates = document.querySelectorAll('div, span, h1, h2, h3, h4');
    for (const text of ANCHOR_TEXTS) {
      for (const el of candidates) {
        if (el.children.length === 0 && el.textContent.trim() === text) {
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

  // ── AI reply helpers ────────────────────────────────────────────────────────

  // Find the Lexical reply box. Primary: data-lexical-editor + aria-placeholder
  // containing "Messenger". Fallback: aria-placeholder containing "reply".
  function findMessengerReplyBox() {
    for (const el of document.querySelectorAll('[data-lexical-editor="true"]')) {
      if (el.closest(`#${PANEL_ID}`)) continue;
      const ph = el.getAttribute('aria-placeholder') || '';
      if (ph.includes('Messenger') || ph.includes('Reply')) return el;
    }
    for (const el of document.querySelectorAll('[contenteditable="true"]')) {
      if (el.closest(`#${PANEL_ID}`)) continue;
      const ph = (el.getAttribute('aria-placeholder') || '').toLowerCase();
      if (ph.includes('reply') || ph.includes('messenger')) return el;
    }
    return null;
  }

  // Walk up from the reply box to find the INPUT ROW — the container that holds
  // the profile pic + editor. We look for the first wide ancestor that has a
  // nextElementSibling (the toolbar row). Inserting after this element puts our
  // buttons between the text input and the icon toolbar.
  function findComposerInsertionPoint() {
    const replyBox = findMessengerReplyBox();
    if (!replyBox) return null;

    let ancestor = replyBox;
    for (let depth = 0; depth < 12; depth++) {
      if (!ancestor.parentElement) break;
      ancestor = ancestor.parentElement;
      const rect = ancestor.getBoundingClientRect();
      // Wide row that has a next sibling (the toolbar row follows it)
      if (rect.width > 200 && rect.height > 20 && rect.height < 150 && ancestor.nextElementSibling) {
        return ancestor;
      }
    }

    // Fallback: 5 levels up
    ancestor = replyBox;
    for (let i = 0; i < 5; i++) {
      if (!ancestor.parentElement) break;
      ancestor = ancestor.parentElement;
    }
    return ancestor;
  }

  // Scrape the last ~20 visible message texts from the conversation thread.
  // Fragile: relies on dir="auto" being present on message text nodes in
  // Facebook's obfuscated DOM — may need retuning after a layout change.
  function scrapeConversationMessages() {
    const composerEl = findComposerInsertionPoint();
    const seen = new Set();
    const results = [];
    const candidates = document.querySelectorAll('[dir="auto"]');
    for (const el of candidates) {
      if (el.closest(`#${PANEL_ID}`) || el.closest(`#${AI_BUTTONS_ID}`)) continue;
      if (composerEl && composerEl.contains(el)) continue;
      if (el.closest('button, [role="button"], [role="menuitem"], [role="menu"]')) continue;
      const text = el.textContent.trim();
      if (!text || text.length < 2 || seen.has(text) || text.length > 1500) continue;
      seen.add(text);
      results.push(text);
    }
    return results.slice(-20);
  }

  // Empty when Lexical has only its managed linebreak placeholder.
  function isReplyBoxEmpty() {
    const box = findMessengerReplyBox();
    if (!box) return true;
    return !!box.querySelector('br[data-lexical-managed-linebreak]');
  }

  function clearReplyBox() {
    const editor = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!editor) return false;
    editor.focus();
    const charsToDelete = editor.textContent.length + 2;
    for (let i = 0; i < charsToDelete; i++) {
      const selection = window.getSelection();
      selection.selectAllChildren(editor);
      selection.collapseToEnd();
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true,
      }));
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
      }));
      document.execCommand('delete', false, null);
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true,
      }));
      editor.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true,
      }));
    }
    return true;
  }

  function insertTextIntoMessenger(text) {
    const editor = document.querySelector('[contenteditable="true"][role="textbox"]');
    if (!editor) return false;
    editor.focus();
    const cleanText = text.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', cleanText);
    editor.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: dataTransfer, bubbles: true, cancelable: true,
    }));
    return true;
  }

  function replaceReplyBoxText(text) {
    const box = findMessengerReplyBox();
    if (!box) return false;
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    // Yield one event-loop tick so Lexical can process the select-all
    // before the insertText replaces the selection.
    setTimeout(() => document.execCommand('insertText', false, text), 0);
    return true;
  }

  function getReplyBoxText() {
    const box = findMessengerReplyBox();
    if (!box) return '';
    return Array.from(box.querySelectorAll('[data-lexical-text="true"]'))
      .map(el => el.textContent)
      .join('');
  }

  // Prepend text to the Lexical reply box.
  // - Empty box: just insert text (cursor is already at start).
  // - Filled box: move cursor to the start of the first text node and insert,
  //   so the prefix appears before whatever the agent already typed.
  function injectTextIntoReplyBox(text) {
    const box = findMessengerReplyBox();
    if (!box) return false;
    box.focus();

    if (isReplyBoxEmpty()) {
      document.execCommand('insertText', false, text);
    } else {
      const firstSpan = box.querySelector('[data-lexical-text="true"]');
      const sel = window.getSelection();
      const range = document.createRange();
      if (firstSpan && firstSpan.firstChild) {
        range.setStart(firstSpan.firstChild, 0);
      } else {
        range.setStart(box, 0);
      }
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text + ' ');
    }

    return true;
  }

  // Dim buttons when the reply box is empty; enable when it has content.
  function updateAiButtonState() {
    const wrapper = document.getElementById(AI_BUTTONS_ID);
    if (!wrapper) return;
    const empty = isReplyBoxEmpty();
    wrapper.querySelectorAll('.cim-ai-btn').forEach((btn) => { btn.disabled = empty; });
  }

  function ensureAiButtons() {
    // Health check on first call — buttons hidden until backend confirms ok.
    if (aiHealthy === null) {
      if (!aiHealthPending) {
        aiHealthPending = true;
        chrome.runtime.sendMessage({ type: 'GET_AI_HEALTH' }, (result) => {
          aiHealthy = !!(result?.ok);
          aiHealthPending = false;
          if (aiHealthy) ensureAiButtons();
        });
      }
      return;
    }
    if (!aiHealthy) return;

    const existing = document.getElementById(AI_BUTTONS_ID);

    // If buttons are already live in the DOM, leave them alone.
    // Re-insertion only happens when Facebook removes them (SPA navigation).
    if (existing && document.contains(existing)) return;

    const insertionPoint = findComposerInsertionPoint();
    if (!insertionPoint) return;

    existing?.remove();

    const wrapper = document.createElement('div');
    wrapper.id = AI_BUTTONS_ID;

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'cim-ai-btn cim-ai-btn--back';
    backBtn.title = 'Restore previous text';
    backBtn.textContent = '↩';
    backBtn.disabled = false;
    backBtn.setAttribute('aria-label', 'Restore previous text');

    const quickBtn = document.createElement('button');
    quickBtn.type = 'button';
    quickBtn.className = 'cim-ai-btn cim-ai-btn--quick';
    quickBtn.textContent = '✨ AI Rewrite';

    const langToggle = document.createElement('div');
    langToggle.className = 'cim-ai-lang';
    const langChips = [
      { value: 'chinese', label: '华语' },
      { value: 'english', label: 'English' },
    ];
    langChips.forEach(({ value, label }) => {
      const chip = document.createElement('span');
      const isInitiallyActive = aiLanguage === value;
      chip.className = 'cim-ai-lang-chip ' + (isInitiallyActive ? 'cim-ai-lang-chip--active' : 'cim-ai-lang-chip--inactive');
      chip.textContent = label;
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('aria-pressed', isInitiallyActive ? 'true' : 'false');
      const activateChip = () => {
        if (aiLanguage === value) return;
        aiLanguage = value;
        langToggle.querySelectorAll('.cim-ai-lang-chip').forEach((c, i) => {
          const isActive = langChips[i].value === aiLanguage;
          c.className = 'cim-ai-lang-chip ' + (isActive ? 'cim-ai-lang-chip--active' : 'cim-ai-lang-chip--inactive');
          c.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      };
      chip.addEventListener('click', activateChip);
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateChip(); }
      });
      langToggle.appendChild(chip);
    });

    wrapper.append(backBtn, quickBtn, langToggle);
    insertionPoint.insertAdjacentElement('afterend', wrapper);

    backBtn.addEventListener('click', () => {
      chrome.storage.local.get(['aiLastInput'], ({ aiLastInput }) => {
        if (!aiLastInput) return;
        clearReplyBox();
        insertTextIntoMessenger(aiLastInput);
      });
    });

    const handleAiClick = (clickedBtn) => {
      const text = getReplyBoxText();
      if (!text) return;
      const messages = [text];
      quickBtn.disabled = true;
      backBtn.disabled = true;
      clickedBtn.classList.add('cim-ai-btn--loading');

      chrome.storage.local.set({ aiLastInput: text }, () => {
        chrome.runtime.sendMessage({ type: 'AI_REPLY', messages, mode: 'quick', language: aiLanguage }, (result) => {
          clickedBtn.classList.remove('cim-ai-btn--loading');
          quickBtn.disabled = false;
          if (result?.ok) {
            clearReplyBox();
            insertTextIntoMessenger(result.text);
          }
        });
      });
    };

    quickBtn.addEventListener('click', () => handleAiClick(quickBtn));

    updateAiButtonState();
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="cim-drag-handle" title="Drag to move"></div>
      <button class="cim-close-btn" title="Return to sidebar">&#x2715;</button>
      <div class="cim-row cim-uid"></div>
      <div class="cim-row cim-name"></div>
      <div class="cim-row cim-psid"></div>
      <div class="cim-lang-tags"></div>
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
    const closeBtn = panel.querySelector('.cim-close-btn');
    closeBtn.addEventListener('click', () => {
      const anchor = findContactDetailsAnchor();
      if (!anchor || !anchor.parentElement) return;
      panelPosition = null;
      panel.classList.remove('cim-floating', 'cim-sidebar-visible');
      panel.style.left = panel.style.top = '';
      anchor.parentElement.insertBefore(panel, anchor);
    });

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

  const LANG_TAGS = [
    { id: 35385444, label: 'Chinese' },
    { id: 35385464, label: 'English' },
  ];

  function renderLangTags(panel, tags, psid) {
    const container = panel.querySelector('.cim-lang-tags');
    if (!container) return;
    container.innerHTML = '';

    const tagIds = new Set((tags || []).map((t) => t.id));
    const activeTag = LANG_TAGS.find((t) => tagIds.has(t.id)) || null;

    container.classList.toggle('cim-lang-tags--none', !activeTag);

    LANG_TAGS.forEach((tag) => {
      const chip = document.createElement('span');
      const isActive = activeTag?.id === tag.id;
      chip.className = isActive ? 'cim-lang-tag cim-lang-tag--active' : 'cim-lang-tag cim-lang-tag--inactive';
      chip.textContent = tag.label;
      chip.style.cursor = 'pointer';

      chip.addEventListener('click', () => {
        if (isActive || chip.dataset.loading) return;

        chip.dataset.loading = '1';
        const prevClass = chip.className;
        chip.className = 'cim-lang-tag cim-lang-tag--loading';

        const removeFirst = activeTag
          ? new Promise((resolve) =>
              chrome.runtime.sendMessage(
                { type: 'MANYCHAT_TAG_ACTION', action: 'remove', psid, tagId: activeTag.id },
                resolve
              )
            )
          : Promise.resolve({ ok: true });

        const showError = (removeAlreadySucceeded) => {
          if (removeAlreadySucceeded && activeTag && sessionState.manychatInfo) {
            // Remove went through in ManyChat but add failed — strip the old tag from local state
            // so the UI reflects the real state (neither tag) after the error flash
            sessionState.manychatInfo = {
              ...sessionState.manychatInfo,
              tags: (sessionState.manychatInfo.tags || []).filter((t) => t.id !== activeTag.id),
            };
          }
          chip.className = 'cim-lang-tag cim-lang-tag--error';
          setTimeout(() => {
            delete chip.dataset.loading;
            const livePanel = document.getElementById(PANEL_ID);
            if (livePanel) renderLangTags(livePanel, sessionState.manychatInfo?.tags || [], psid);
            else chip.className = prevClass;
          }, 1500);
        };

        removeFirst.then((res) => {
          if (!res?.ok) {
            showError(false);
            return;
          }
          chrome.runtime.sendMessage(
            { type: 'MANYCHAT_TAG_ACTION', action: 'add', psid, tagId: tag.id },
            (addRes) => {
              if (!addRes?.ok) {
                showError(true);
                return;
              }
              if (sessionState.manychatInfo) {
                const filtered = (sessionState.manychatInfo.tags || []).filter(
                  (t) => t.id !== (activeTag?.id)
                );
                filtered.push({ id: tag.id, name: tag.label });
                sessionState.manychatInfo = { ...sessionState.manychatInfo, tags: filtered };
              }
              const livePanel = document.getElementById(PANEL_ID);
              if (livePanel) renderLangTags(livePanel, sessionState.manychatInfo?.tags || [], psid);
            }
          );
        });
      });

      container.appendChild(chip);
    });
  }

  function renderPsidRow(panel, uid, psid) {
    const row = panel.querySelector('.cim-psid');
    row.innerHTML = '';
    panel.querySelector('.cim-lang-tags').innerHTML = '';

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
      nameLink.href = '#';
      nameLink.textContent = sessionState.name || '';
      nameLink.addEventListener('click', (e) => {
        e.preventDefault();
        openCartModal(psid);
      });
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

  function buildCartOptionButton(psid, option, label, modifierClass, subLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cim-cart-btn ${modifierClass}`;

    const labelEl = document.createElement('span');
    labelEl.className = 'cim-cart-btn-label';
    labelEl.textContent = label;

    const tooltip = document.createElement('span');
    tooltip.className = 'cim-copy-tooltip';

    if (subLabel != null) {
      const subLabelEl = document.createElement('span');
      subLabelEl.className = 'cim-cart-btn-sublabel';
      subLabelEl.textContent = subLabel;
      btn.append(labelEl, subLabelEl, tooltip);
    } else {
      btn.append(labelEl, tooltip);
    }

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

  function buildCartSection(psid, prices) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cim-cart-section';

    const cartButtons = document.createElement('div');
    cartButtons.className = 'cim-cart-buttons';
    CART_OPTIONS.forEach(({ option, label, modifier }) => {
      let subLabel = null;
      if (option === '2' && prices?.myrSum != null) subLabel = `RM ${prices.myrSum}`;
      if (option === '3' && prices?.sgdSum != null) subLabel = `S$ ${prices.sgdSum}`;
      cartButtons.appendChild(buildCartOptionButton(psid, option, label, modifier, subLabel));
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
      sessionState.myrSum = response.myrSum ?? null;
      sessionState.sgdSum = response.sgdSum ?? null;

      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel || sessionState.view?.type !== 'orders') return;

      const body = livePanel.querySelector('.cim-body');

      if (sessionState.expiredAvailable && !body.querySelector('.cim-expired-notice')) {
        body.insertBefore(buildExpiredNotice(), body.firstChild);
      }

      const heading = body.querySelector('.cim-orders-heading');
      if (!heading || body.querySelector('.cim-cart-buttons') || body.querySelector('.cim-cart-empty')) return;

      if (hasItems) {
        body.insertBefore(buildCartSection(psid, { myrSum: sessionState.myrSum, sgdSum: sessionState.sgdSum }), heading);
      } else {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'cim-cart-empty';
        emptyEl.textContent = '🛒 Empty Cart';
        body.insertBefore(emptyEl, heading);
      }
    });
  }

  // ── Parcel photo icon ───────────────────────────────────────────────────────

  function buildPhotoIconBtn(orderId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cim-photo-icon';
    btn.title = 'View parcel photos';
    btn.setAttribute('aria-label', 'View parcel photos');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const camPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    camPath.setAttribute('d', 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z');
    const camCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    camCircle.setAttribute('cx', '12');
    camCircle.setAttribute('cy', '13');
    camCircle.setAttribute('r', '4');
    svg.append(camPath, camCircle);
    btn.appendChild(svg);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openParcelDrawer(orderId);
    });
    return btn;
  }

  // ── Cart modal ──────────────────────────────────────────────────────────────

  let cartModalPsid = null;
  let cartUserId = null;
  let cartSelectedRecIds = new Set();
  let cartTotalItemCount = 0;
  let cartGroups = new Map(); // groupId → { color, label, recIds: Set<recId> }
  let cartGroupsNextId = 1;
  let cartGroupsPsid = null;
  const GROUP_COLORS = ['#7c3aed', '#0891b2', '#d97706', '#059669', '#e11d48'];
  let goodsKeyword = '';
  let goodsPage = 1;
  let goodsTotalPages = 1;
  let goodsQtys = {};
  let goodsSearchMode = 'normal'; // 'normal' | 'smart'
  let goodsSelectedIds = new Set();
  let goodsDataMap = {}; // goodsId → { name, price }
  let copySourceId = '';

  function ensureCartModal() {
    if (document.getElementById(CART_MODAL_ID)) return document.getElementById(CART_MODAL_ID);

    const overlay = document.createElement('div');
    overlay.id = CART_MODAL_OVERLAY_ID;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCartModal(); });

    const modal = document.createElement('div');
    modal.id = CART_MODAL_ID;
    modal.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'cim-drawer-header';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'cim-cart-back-btn';
    backBtn.setAttribute('aria-label', 'Back to cart');
    backBtn.textContent = '← Back';
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', () => showCartView(cartModalPsid));

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cim-drawer-title-wrap';
    const title = document.createElement('span');
    title.className = 'cim-drawer-title';
    title.textContent = 'Cart';
    const subtitle = document.createElement('span');
    subtitle.className = 'cim-drawer-subtitle';
    titleWrap.append(title, subtitle);

    const headerRight = document.createElement('div');
    headerRight.className = 'cim-cart-header-right';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'cim-cart-add-btn';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => showGoodsPicker(cartModalPsid));

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cim-cart-copy-btn';
    copyBtn.textContent = '↙ Copy';
    copyBtn.setAttribute('aria-label', 'Copy from another customer');
    copyBtn.addEventListener('click', () => showCopyCartView(cartModalPsid));

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'cim-cart-refresh-btn';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', () => showCartView(cartModalPsid));

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cim-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeCartModal);

    headerRight.append(addBtn, copyBtn, refreshBtn, closeBtn);
    header.append(backBtn, titleWrap, headerRight);

    const drawerBody = document.createElement('div');
    drawerBody.className = 'cim-drawer-body';

    const footer = document.createElement('div');
    footer.className = 'cim-drawer-footer';
    const footerClose = document.createElement('button');
    footerClose.type = 'button';
    footerClose.className = 'cim-drawer-footer-close';
    footerClose.textContent = 'Close';
    footerClose.addEventListener('click', closeCartModal);
    footer.appendChild(footerClose);

    const totalBar = document.createElement('div');
    totalBar.className = 'cim-cart-total-bar';
    totalBar.style.display = 'none';

    const totalBarLeft = document.createElement('div');
    totalBarLeft.className = 'cim-cart-total-left';
    const totalBarLabel = document.createElement('span');
    totalBarLabel.className = 'cim-cart-total-label';
    totalBarLabel.textContent = 'Total';
    const totalBarValue = document.createElement('span');
    totalBarValue.className = 'cim-cart-total-value';
    totalBarLeft.append(totalBarLabel, totalBarValue);

    const listBtnsGroup = document.createElement('div');
    listBtnsGroup.className = 'cim-cart-list-btns';

    CART_OPTIONS.forEach(({ option, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cim-cart-list-btn';
      btn.dataset.listOption = option;
      const btnLabel = document.createElement('span');
      btnLabel.className = 'cim-cart-list-btn-label';
      btnLabel.textContent = label;
      const btnTooltip = document.createElement('span');
      btnTooltip.className = 'cim-copy-tooltip';
      btn.append(btnLabel, btnTooltip);
      let btnTimer = null;
      const showTip = (text) => {
        btnTooltip.textContent = text;
        btnTooltip.classList.add('cim-copy-tooltip--visible');
        clearTimeout(btnTimer);
        btnTimer = setTimeout(() => btnTooltip.classList.remove('cim-copy-tooltip--visible'), 1500);
      };
      btn.addEventListener('click', () => {
        const isPartial = cartSelectedRecIds.size > 0 && cartSelectedRecIds.size < cartTotalItemCount;
        const recIds = isPartial ? [...cartSelectedRecIds] : [];
        const psid = cartModalPsid;
        const uid = sessionState.uid;
        const handleResponse = (response) => {
          if (getUserIdFromUrl() !== uid) return;
          if (chrome.runtime.lastError || !response || !response.ok) { showTip(response?.error || 'Failed.'); return; }
          if (response.text.includes(EMPTY_CART_MARKER)) { showTip('Empty Cart!'); return; }
          const customPrefix = document.getElementById(PANEL_ID)?.querySelector('.cim-cart-prefix')?.value.trim() || '';
          const textToCopy = customPrefix ? response.text.replace(DEFAULT_CART_PREFIX, customPrefix) : response.text;
          copyToClipboard(textToCopy).then(() => showTip('Copied!'));
        };
        if (isPartial) {
          chrome.runtime.sendMessage({ type: 'GET_SELECTED_CART_SUMMARY', psid, recIds, option }, handleResponse);
        } else {
          chrome.runtime.sendMessage({ type: 'GET_CART_SUMMARY', psid, option }, handleResponse);
        }
      });
      listBtnsGroup.appendChild(btn);
    });

    totalBar.append(totalBarLeft, listBtnsGroup);

    modal.append(header, drawerBody, totalBar, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', (e) => {
      if (!overlay.classList.contains('cim-cart-modal-overlay--visible')) return;
      if (e.key === 'Escape') { closeCartModal(); return; }
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const liveModal = document.getElementById(CART_MODAL_ID);
      if (!liveModal?.querySelector('.cim-cart-toolbar')) return;
      if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const selAll = liveModal.querySelector('.cim-cart-select-all input[type="checkbox"]');
        if (selAll) {
          selAll.checked = !(selAll.checked && !selAll.indeterminate);
          selAll.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });

    return modal;
  }

  function openCartModal(psid) {
    cartModalPsid = psid;
    cartSelectedRecIds = new Set();
    goodsQtys = {};
    if (cartGroupsPsid !== psid) {
      cartGroups = new Map();
      cartGroupsNextId = 1;
      cartGroupsPsid = psid;
    }
    ensureCartModal();
    document.getElementById(CART_MODAL_OVERLAY_ID).classList.add('cim-cart-modal-overlay--visible');
    showCartView(psid);
  }

  function closeCartModal() {
    const overlay = document.getElementById(CART_MODAL_OVERLAY_ID);
    if (overlay) overlay.classList.remove('cim-cart-modal-overlay--visible');

    if (sessionState.view?.type === 'orders' && sessionState.view?.psid) {
      const panel = document.getElementById(PANEL_ID);
      if (panel) {
        panel.querySelector('.cim-cart-section')?.remove();
        panel.querySelector('.cim-cart-empty')?.remove();
        panel.querySelector('.cim-expired-notice')?.remove();
        sessionState.cartHasItems = null;
        sessionState.myrSum = null;
        sessionState.sgdSum = null;
        sessionState.expiredAvailable = null;
        probeCartAndShowButtons(sessionState.uid, sessionState.view.psid, panel);
      }
    }
  }

  function setCartHeaderMode(mode) {
    const modal = document.getElementById(CART_MODAL_ID);
    if (!modal) return;
    const isGoods = mode === 'goods';
    const isCopy = mode === 'copy';
    const isCheckout = mode === 'checkout';
    const isCart = mode === 'cart';
    modal.querySelector('.cim-cart-back-btn').style.display = (isGoods || isCopy || isCheckout) ? '' : 'none';
    modal.querySelector('.cim-cart-add-btn').style.display = isCart ? '' : 'none';
    modal.querySelector('.cim-cart-copy-btn').style.display = isCart ? '' : 'none';
    modal.querySelector('.cim-cart-refresh-btn').style.display = isCart ? '' : 'none';
    modal.querySelector('.cim-drawer-title').textContent = isGoods ? 'Add Product' : isCopy ? 'Copy Cart' : isCheckout ? 'Create Order' : (sessionState.name || 'Cart');
    modal.querySelector('.cim-drawer-subtitle').textContent = '';
    const totalBar = modal.querySelector('.cim-cart-total-bar');
    if (totalBar) totalBar.style.display = isCart ? '' : 'none';
  }

  function setCartBodyBusy(busy) {
    document.getElementById(CART_MODAL_ID)?.querySelector('.cim-drawer-body')?.classList.toggle('cim-cart-body--busy', busy);
  }

  function showCartError(modal, msg) {
    const body = modal?.querySelector('.cim-drawer-body');
    if (!body) return;
    body.querySelector('.cim-cart-error-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'cim-cart-error-toast';
    toast.textContent = msg;
    body.insertBefore(toast, body.firstChild);
    setTimeout(() => toast.remove(), 3000);
  }

  function showCartView(psid) {
    const modal = ensureCartModal();
    const body = modal.querySelector('.cim-drawer-body');
    cartSelectedRecIds = new Set();
    setCartHeaderMode('cart');
    body.innerHTML = '<div class="cim-drawer-loading">Loading cart…</div>';
    chrome.runtime.sendMessage({ type: 'GET_CART_ITEMS', psid }, (res) => {
      const liveModal = document.getElementById(CART_MODAL_ID);
      if (!liveModal) return;
      const liveBody = liveModal.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Failed to load cart.'}</div>`;
        return;
      }
      cartUserId = res.userId || null;
      renderCartContent(liveBody, liveModal, res, psid);
    });
  }

  function showDeleteConfirm(triggerEl, onConfirm, labelText = 'Delete?') {
    document.querySelector('.cim-delete-confirm')?.remove();
    const pop = document.createElement('div');
    pop.className = 'cim-delete-confirm';
    const label = document.createElement('span');
    label.textContent = labelText;
    const yesBtn = document.createElement('button');
    yesBtn.className = 'cim-delete-confirm-yes';
    yesBtn.textContent = 'Yes';
    const noBtn = document.createElement('button');
    noBtn.className = 'cim-delete-confirm-no';
    noBtn.textContent = 'No';
    pop.append(label, yesBtn, noBtn);
    document.body.appendChild(pop);
    const rect = triggerEl.getBoundingClientRect();
    pop.style.cssText = `position:fixed;left:${rect.left + rect.width / 2}px;top:${rect.top - 6}px;transform:translate(-50%,-100%);z-index:2147483647`;
    const dismiss = () => pop.remove();
    yesBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); onConfirm(); });
    noBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    setTimeout(() => document.addEventListener('click', dismiss, { once: true }), 0);
  }

  function showSplitPopup(triggerEl, item, psid) {
    document.querySelector('.cim-split-popup')?.remove();
    const originalQty = parseInt(item.qty, 10);
    const modal = ensureCartModal();

    const pop = document.createElement('div');
    pop.className = 'cim-split-popup';
    pop.addEventListener('click', (e) => e.stopPropagation());

    const labelEl = document.createElement('div');
    labelEl.className = 'cim-split-label';
    labelEl.textContent = `Split off (1–${originalQty - 1}):`;

    const row = document.createElement('div');
    row.className = 'cim-split-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.className = 'cim-split-input';
    input.placeholder = '1';
    input.autocomplete = 'off';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'cim-split-confirm-btn';
    confirmBtn.textContent = 'Split';
    confirmBtn.disabled = true;

    const validate = () => {
      input.value = input.value.replace(/\D/g, '').replace(/^0+(\d)/, '$1');
      const v = parseInt(input.value, 10);
      confirmBtn.disabled = !v || v < 1 || v >= originalQty;
    };
    input.addEventListener('input', validate);

    const doSplit = () => {
      const splitQty = parseInt(input.value, 10);
      if (!splitQty || splitQty < 1 || splitQty >= originalQty) return;
      pop.remove();
      setCartBodyBusy(true);
      chrome.runtime.sendMessage(
        { type: 'CART_SPLIT_ITEM', recId: item.recId, goodsId: item.goodsId, originalQty, splitQty, fbUserId: psid },
        (res) => {
          if (res?.ok) { showCartView(psid); }
          else { setCartBodyBusy(false); showCartError(modal, res?.error || 'Split failed.'); }
        }
      );
    };

    confirmBtn.addEventListener('click', doSplit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSplit(); }
      if (e.key === 'Escape') { e.preventDefault(); pop.remove(); }
    });

    row.append(input, confirmBtn);
    pop.append(labelEl, row);
    document.body.appendChild(pop);

    const rect = triggerEl.getBoundingClientRect();
    pop.style.cssText = `position:fixed;left:${rect.left + rect.width / 2}px;top:${rect.top - 6}px;transform:translate(-50%,-100%);z-index:2147483647`;
    requestAnimationFrame(() => input.focus());
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
  }

  function showListOptionsPopup(triggerEl, showTooltip) {
    document.querySelector('.cim-list-options-popup')?.remove();

    const isPartial = cartSelectedRecIds.size > 0 && cartSelectedRecIds.size < cartTotalItemCount;
    const recIds = isPartial ? [...cartSelectedRecIds] : [];
    const psid = cartModalPsid;
    const uid = sessionState.uid;

    const pop = document.createElement('div');
    pop.className = 'cim-list-options-popup';

    CART_OPTIONS.forEach(({ option, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cim-list-option-btn';
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.remove();

        const handleResponse = (response) => {
          if (getUserIdFromUrl() !== uid) return;
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
        };

        if (isPartial) {
          chrome.runtime.sendMessage({ type: 'GET_SELECTED_CART_SUMMARY', psid, recIds, option }, handleResponse);
        } else {
          chrome.runtime.sendMessage({ type: 'GET_CART_SUMMARY', psid, option }, handleResponse);
        }
      });
      pop.appendChild(btn);
    });

    document.body.appendChild(pop);
    const rect = triggerEl.getBoundingClientRect();
    pop.style.cssText = `position:fixed;right:${window.innerWidth - rect.right}px;bottom:${window.innerHeight - rect.top + 6}px;z-index:2147483647`;
    setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
  }

  function renderCartContent(body, modal, data, psid) {
    setCartBodyBusy(false);
    body.innerHTML = '';
    const subtitleEl = modal.querySelector('.cim-drawer-subtitle');
    const items = data.items || [];

    // Clean stale recIds from groups (items may have been deleted/renewed away)
    const existingRecIds = new Set(items.map((it) => it.recId));
    for (const [gid, g] of cartGroups) {
      for (const rid of [...g.recIds]) { if (!existingRecIds.has(rid)) g.recIds.delete(rid); }
      if (g.recIds.size === 0) cartGroups.delete(gid);
    }

    if (items.length === 0) {
      if (subtitleEl) subtitleEl.textContent = 'Empty cart';
      const empty = document.createElement('div');
      empty.className = 'cim-drawer-empty';
      empty.textContent = '🛒 Cart is empty';
      body.appendChild(empty);
      return;
    }

    cartTotalItemCount = items.length;
    modal.querySelectorAll('.cim-cart-list-btn').forEach((btn) => btn.classList.remove('cim-cart-list-btn--partial'));

    const total = items.reduce((sum, it) => sum + (parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 0), 0);
    if (subtitleEl) subtitleEl.textContent = '0 items · RM0.00';

    const itemLineTotals = new Map(
      items.map((it) => [it.recId, (parseFloat(it.price) || 0) * (parseInt(it.qty, 10) || 0)])
    );

    // ── Toolbar ───────────────────────────────────────────────────────────────
    const toolbar = document.createElement('div');
    toolbar.className = 'cim-cart-toolbar';

    const selectAllLabel = document.createElement('label');
    selectAllLabel.className = 'cim-cart-select-all';
    selectAllLabel.title = 'Select all (A)';
    const selectAllChk = document.createElement('input');
    selectAllChk.type = 'checkbox';
    selectAllChk.className = 'cim-cart-checkbox';
    selectAllLabel.append(selectAllChk, document.createTextNode(' All'));

    const bulkActions = document.createElement('div');
    bulkActions.className = 'cim-cart-bulk-actions';
    const bulkDeleteBtn = document.createElement('button');
    bulkDeleteBtn.type = 'button';
    bulkDeleteBtn.className = 'cim-cart-bulk-btn cim-cart-bulk-btn--delete';
    bulkDeleteBtn.textContent = 'Delete';
    bulkDeleteBtn.disabled = true;
    const bulkRenewBtn = document.createElement('button');
    bulkRenewBtn.type = 'button';
    bulkRenewBtn.className = 'cim-cart-bulk-btn cim-cart-bulk-btn--renew';
    bulkRenewBtn.textContent = 'Renew';
    bulkRenewBtn.disabled = true;
    const bulkOrderBtn = document.createElement('button');
    bulkOrderBtn.type = 'button';
    bulkOrderBtn.className = 'cim-cart-bulk-btn cim-cart-bulk-btn--order';
    bulkOrderBtn.textContent = '+ Order';
    bulkOrderBtn.disabled = true;
    const bulkGroupBtn = document.createElement('button');
    bulkGroupBtn.type = 'button';
    bulkGroupBtn.className = 'cim-cart-bulk-btn cim-cart-bulk-btn--group';
    bulkGroupBtn.textContent = '⊞ Group';
    bulkGroupBtn.disabled = true;
    bulkActions.append(bulkDeleteBtn, bulkRenewBtn, bulkOrderBtn, bulkGroupBtn);
    toolbar.append(selectAllLabel, bulkActions);
    body.appendChild(toolbar);

    const hasExpired = items.some((it) => it.expired);
    if (hasExpired) {
      const renewAllRow = document.createElement('div');
      renewAllRow.className = 'cim-cart-renew-all-row';
      const renewAllBtn = document.createElement('button');
      renewAllBtn.type = 'button';
      renewAllBtn.className = 'cim-cart-renew-all-btn';
      renewAllBtn.textContent = '↺ Renew All Expired';
      renewAllBtn.addEventListener('click', () => {
        const expiredIds = items.filter((it) => it.expired).map((it) => it.recId);
        setCartBodyBusy(true);
        chrome.runtime.sendMessage({ type: 'CART_REFRESH_VALIDITY', recIds: expiredIds }, (res) => {
          if (res?.ok) { showCartView(psid); }
          else { setCartBodyBusy(false); showCartError(modal, res?.error || 'Renew failed.'); }
        });
      });
      renewAllRow.appendChild(renewAllBtn);
      body.appendChild(renewAllRow);
    }

    function syncBulkButtons() {
      const allChks = body.querySelectorAll('.cim-cart-item-check');
      const checked = body.querySelectorAll('.cim-cart-item-check:checked').length;
      bulkDeleteBtn.disabled = cartSelectedRecIds.size === 0;
      bulkRenewBtn.disabled = cartSelectedRecIds.size === 0;
      bulkOrderBtn.disabled = cartSelectedRecIds.size === 0;
      bulkGroupBtn.disabled = cartSelectedRecIds.size < 2;
      selectAllChk.indeterminate = checked > 0 && checked < allChks.length;
      selectAllChk.checked = allChks.length > 0 && checked === allChks.length;
      const selTotal = [...cartSelectedRecIds].reduce((sum, id) => sum + (itemLineTotals.get(id) || 0), 0);
      const n = cartSelectedRecIds.size;
      if (subtitleEl) subtitleEl.textContent = `${n} item${n === 1 ? '' : 's'} · RM${selTotal.toFixed(2)}`;
      const isPartial = n > 0 && n < cartTotalItemCount;
      modal.querySelectorAll('.cim-cart-list-btn').forEach((btn) => btn.classList.toggle('cim-cart-list-btn--partial', isPartial));
      body.querySelectorAll('.cim-cart-group').forEach((groupEl) => {
        const groupChk = groupEl.querySelector('.cim-cart-group-select-chk');
        if (!groupChk) return;
        const itemChks = groupEl.querySelectorAll('.cim-cart-item-check');
        const total = itemChks.length;
        const checkedInGroup = [...itemChks].filter((c) => c.checked).length;
        groupChk.indeterminate = checkedInGroup > 0 && checkedInGroup < total;
        groupChk.checked = total > 0 && checkedInGroup === total;
      });
    }

    selectAllChk.addEventListener('change', () => {
      body.querySelectorAll('.cim-cart-item-check').forEach((chk) => {
        chk.checked = selectAllChk.checked;
        if (selectAllChk.checked) cartSelectedRecIds.add(chk.dataset.recId);
        else cartSelectedRecIds.delete(chk.dataset.recId);
      });
      syncBulkButtons();
    });

    bulkDeleteBtn.addEventListener('click', () => {
      const recIds = [...cartSelectedRecIds];
      if (!recIds.length) return;
      showDeleteConfirm(bulkDeleteBtn, () => {
        setCartBodyBusy(true);
        chrome.runtime.sendMessage({ type: 'CART_DELETE_ITEMS', recIds }, (res) => {
          if (res?.ok) { showCartView(psid); }
          else { setCartBodyBusy(false); showCartError(modal, res?.error || 'Delete failed.'); }
        });
      });
    });

    bulkRenewBtn.addEventListener('click', () => {
      const recIds = [...cartSelectedRecIds];
      if (!recIds.length) return;
      setCartBodyBusy(true);
      chrome.runtime.sendMessage({ type: 'CART_REFRESH_VALIDITY', recIds }, (res) => {
        if (res?.ok) { showCartView(psid); }
        else { setCartBodyBusy(false); showCartError(modal, res?.error || 'Renew failed.'); }
      });
    });

    bulkOrderBtn.addEventListener('click', () => {
      if (!cartSelectedRecIds.size) return;
      const selectedItems = items
        .filter((it) => cartSelectedRecIds.has(it.recId))
        .map((it) => ({ recId: it.recId, qty: parseInt(it.qty, 10) || 1, price: parseFloat(it.price) || 0 }));
      showCheckoutView(psid, selectedItems);
    });

    bulkGroupBtn.addEventListener('click', () => {
      if (cartSelectedRecIds.size < 2) return;
      const currentCount = cartGroups.size;
      const groupId = `g${cartGroupsNextId}`;
      cartGroups.set(groupId, {
        color: GROUP_COLORS[currentCount % GROUP_COLORS.length],
        recIds: new Set(cartSelectedRecIds),
      });
      cartGroupsNextId++;
      cartSelectedRecIds = new Set();
      renderCartContent(body, modal, data, psid);
    });

    // ── Item rows ─────────────────────────────────────────────────────────────
    const rowMap = new Map(); // recId → DOM row element
    let lastCheckedIndex = -1;
    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'cim-cart-item-row' + (item.expired ? ' cim-cart-item-row--expired' : '');

      const chkLabel = document.createElement('label');
      chkLabel.className = 'cim-cart-item-chk-wrap';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'cim-cart-checkbox cim-cart-item-check';
      chk.dataset.recId = item.recId;
      chk.addEventListener('click', (e) => {
        if (e.shiftKey && lastCheckedIndex >= 0 && idx !== lastCheckedIndex) {
          const start = Math.min(lastCheckedIndex, idx);
          const end = Math.max(lastCheckedIndex, idx);
          items.slice(start, end + 1).forEach((it) => {
            const c = body.querySelector(`.cim-cart-item-check[data-rec-id="${it.recId}"]`);
            if (c) {
              c.checked = chk.checked;
              if (chk.checked) cartSelectedRecIds.add(it.recId);
              else cartSelectedRecIds.delete(it.recId);
            }
          });
        } else {
          if (chk.checked) cartSelectedRecIds.add(item.recId);
          else cartSelectedRecIds.delete(item.recId);
        }
        lastCheckedIndex = idx;
        syncBulkButtons();
      });
      chkLabel.appendChild(chk);

      const content = document.createElement('div');
      content.className = 'cim-cart-item-content';

      // Name + badges
      const top = document.createElement('div');
      top.className = 'cim-cart-item-top';
      const name = document.createElement('span');
      name.className = 'cim-cart-item-name';
      name.textContent = item.name || '(Unknown product)';
      const badges = document.createElement('div');
      badges.className = 'cim-cart-item-badges';
      if (item.origin) {
        const ob = document.createElement('span');
        ob.className = `cim-cart-origin-badge cim-cart-origin-badge--${item.origin}`;
        ob.textContent = item.origin === 'live' ? 'LIVE' : 'SYS';
        badges.appendChild(ob);
      }
      if (item.expired) {
        const eb = document.createElement('span');
        eb.className = 'cim-cart-expired-badge';
        eb.textContent = '⚠ Expired';
        badges.appendChild(eb);
      }
      top.append(name, badges);

      // Controls row
      const bottom = document.createElement('div');
      bottom.className = 'cim-cart-item-bottom';

      const price = parseFloat(item.price) || 0;
      const priceEl = document.createElement('span');
      priceEl.className = 'cim-cart-item-price';
      priceEl.textContent = `RM ${price.toFixed(2)}/ea`;

      // Qty stepper
      const stepper = document.createElement('div');
      stepper.className = 'cim-cart-stepper';
      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'cim-cart-stepper-btn';
      minusBtn.textContent = '−';
      minusBtn.disabled = parseInt(item.qty, 10) <= 1;
      const qtyDisplay = document.createElement('input');
      qtyDisplay.type = 'text';
      qtyDisplay.inputMode = 'numeric';
      qtyDisplay.className = 'cim-cart-stepper-qty';
      qtyDisplay.value = String(item.qty);
      qtyDisplay.setAttribute('aria-label', 'Quantity');
      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'cim-cart-stepper-btn';
      plusBtn.textContent = '+';

      const doQtyChange = (newQty) => {
        if (newQty < 1) return;
        minusBtn.disabled = true;
        plusBtn.disabled = true;
        qtyDisplay.disabled = true;
        chrome.runtime.sendMessage({ type: 'CART_UPDATE_QTY', recId: item.recId, qty: newQty }, (res) => {
          if (res?.ok) { showCartView(psid); }
          else {
            minusBtn.disabled = parseInt(qtyDisplay.value, 10) <= 1;
            plusBtn.disabled = false;
            qtyDisplay.disabled = false;
            showCartError(modal, res?.error || 'Failed to update quantity.');
          }
        });
      };
      minusBtn.addEventListener('click', () => doQtyChange(parseInt(qtyDisplay.value, 10) - 1));
      plusBtn.addEventListener('click', () => doQtyChange(parseInt(qtyDisplay.value, 10) + 1));

      qtyDisplay.addEventListener('input', () => {
        qtyDisplay.value = qtyDisplay.value.replace(/\D/g, '').replace(/^0+(\d)/, '$1');
      });
      qtyDisplay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); qtyDisplay.blur(); }
        if (e.key === 'Escape') { qtyDisplay.value = String(item.qty); qtyDisplay.blur(); }
      });
      qtyDisplay.addEventListener('blur', () => {
        const val = parseInt(qtyDisplay.value, 10);
        if (!val || val < 1) { qtyDisplay.value = String(item.qty); return; }
        if (val !== parseInt(item.qty, 10)) doQtyChange(val);
      });
      stepper.append(minusBtn, qtyDisplay, plusBtn);

      const lineTotal = price * (parseInt(item.qty, 10) || 0);
      const lineTotalEl = document.createElement('span');
      lineTotalEl.className = 'cim-cart-item-line-total';
      lineTotalEl.textContent = `RM ${lineTotal.toFixed(2)}`;

      const actions = document.createElement('div');
      actions.className = 'cim-cart-item-actions';

      if (item.expired) {
        const renewBtn = document.createElement('button');
        renewBtn.type = 'button';
        renewBtn.className = 'cim-cart-item-renew-btn';
        renewBtn.textContent = 'Renew';
        renewBtn.addEventListener('click', () => {
          renewBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'CART_REFRESH_VALIDITY', recIds: [item.recId] }, (res) => {
            if (res?.ok) { showCartView(psid); }
            else { renewBtn.disabled = false; showCartError(modal, res?.error || 'Renew failed.'); }
          });
        });
        actions.appendChild(renewBtn);
      }

      if (parseInt(item.qty, 10) > 1) {
        const splitBtn = document.createElement('button');
        splitBtn.type = 'button';
        splitBtn.className = 'cim-cart-item-split-btn';
        splitBtn.textContent = 'Split';
        splitBtn.addEventListener('click', () => showSplitPopup(splitBtn, item, psid));
        actions.appendChild(splitBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'cim-cart-item-delete-btn';
      deleteBtn.setAttribute('aria-label', 'Delete');
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', () => {
        showDeleteConfirm(deleteBtn, () => {
          deleteBtn.disabled = true;
          chrome.runtime.sendMessage({ type: 'CART_DELETE_ITEMS', recIds: [item.recId] }, (res) => {
            if (res?.ok) { showCartView(psid); }
            else { deleteBtn.disabled = false; showCartError(modal, res?.error || 'Delete failed.'); }
          });
        });
      });
      actions.appendChild(deleteBtn);

      bottom.append(priceEl, stepper, lineTotalEl, actions);
      content.append(top, bottom);

      const thumb = document.createElement('div');
      thumb.className = 'cim-cart-item-thumb';
      if (item.img) {
        const thumbImg = document.createElement('img');
        thumbImg.src = item.img;
        thumbImg.alt = '';
        thumb.appendChild(thumbImg);
        thumb.classList.add('cim-cart-item-thumb--clickable');
        thumb.addEventListener('click', () => openGalleryModal([{ url: item.img, id: String(item.goodsId), label: item.name }], 0));
      }

      row.append(chkLabel, thumb, content);
      rowMap.set(item.recId, row);
    });

    // ── Render rows: groups first (top), then ungrouped items ────────────────
    const groupedRecIds = new Set();
    for (const g of cartGroups.values()) g.recIds.forEach((rid) => groupedRecIds.add(rid));

    // Pass 1: render all group wrappers in creation order
    for (const [gid, group] of cartGroups) {
      const wrapper = document.createElement('div');
      wrapper.className = 'cim-cart-group';
      wrapper.style.setProperty('--group-color', group.color);

      const groupHeader = document.createElement('div');
      groupHeader.className = 'cim-cart-group-header';

      const groupSelectLabel = document.createElement('label');
      groupSelectLabel.className = 'cim-cart-group-select-label';
      const groupSelectChk = document.createElement('input');
      groupSelectChk.type = 'checkbox';
      groupSelectChk.className = 'cim-cart-checkbox cim-cart-group-select-chk';
      const groupRecIds = [...group.recIds];
      const initChecked = groupRecIds.filter((rid) => cartSelectedRecIds.has(rid)).length;
      groupSelectChk.checked = initChecked === groupRecIds.length;
      groupSelectChk.indeterminate = initChecked > 0 && initChecked < groupRecIds.length;
      groupSelectChk.addEventListener('change', () => {
        groupRecIds.forEach((rid) => {
          if (groupSelectChk.checked) cartSelectedRecIds.add(rid);
          else cartSelectedRecIds.delete(rid);
        });
        groupHeader.closest('.cim-cart-group').querySelectorAll('.cim-cart-item-check').forEach((c) => {
          c.checked = groupSelectChk.checked;
        });
        syncBulkButtons();
      });
      groupSelectLabel.appendChild(groupSelectChk);

      const groupLabel = document.createElement('span');
      groupLabel.className = 'cim-cart-group-label';
      groupLabel.textContent = `Group (Total: ${group.recIds.size} items)`;
      const ungroupBtn = document.createElement('button');
      ungroupBtn.type = 'button';
      ungroupBtn.className = 'cim-cart-group-ungroup-btn';
      ungroupBtn.textContent = 'Ungroup';
      ungroupBtn.addEventListener('click', () => {
        cartGroups.delete(gid);
        renderCartContent(body, modal, data, psid);
      });
      groupHeader.append(groupSelectLabel, groupLabel, ungroupBtn);

      const groupItems = document.createElement('div');
      groupItems.className = 'cim-cart-group-items';
      items.filter((it) => group.recIds.has(it.recId)).forEach((it) => {
        groupItems.appendChild(rowMap.get(it.recId));
      });

      wrapper.append(groupHeader, groupItems);
      body.appendChild(wrapper);
    }

    // Pass 2: render ungrouped items in their original order
    items.forEach((item) => {
      if (!groupedRecIds.has(item.recId)) body.appendChild(rowMap.get(item.recId));
    });

    // Update the sticky total bar (outside the scroll body)
    const totalBarValue = modal.querySelector('.cim-cart-total-bar .cim-cart-total-value');
    if (totalBarValue) totalBarValue.textContent = `RM ${total.toFixed(2)}`;
  }

  // ── Goods picker ─────────────────────────────────────────────────────────────

  function showGoodsPicker(psid) {
    goodsKeyword = '';
    goodsPage = 1;
    goodsTotalPages = 1;
    goodsQtys = {};
    goodsSearchMode = 'smart';
    goodsSelectedIds = new Set();
    goodsDataMap = {};
    const modal = ensureCartModal();
    setCartHeaderMode('goods');
    renderGoodsPicker(modal.querySelector('.cim-drawer-body'), psid);
  }

  function renderGoodsPicker(body, psid) {
    body.innerHTML = '';

    // tracks goodsIds visible in the current result set (for select-all)
    let visibleGoodsIds = [];

    // Mode toggle
    const modeRow = document.createElement('div');
    modeRow.className = 'cim-goods-mode-row';
    const normalModeBtn = document.createElement('button');
    normalModeBtn.type = 'button';
    normalModeBtn.className = 'cim-goods-mode-btn' + (goodsSearchMode === 'normal' ? ' cim-goods-mode-btn--active' : '');
    normalModeBtn.textContent = 'Normal';
    const smartModeBtn = document.createElement('button');
    smartModeBtn.type = 'button';
    smartModeBtn.className = 'cim-goods-mode-btn' + (goodsSearchMode === 'smart' ? ' cim-goods-mode-btn--active' : '');
    smartModeBtn.textContent = '✦ Smart';
    modeRow.append(normalModeBtn, smartModeBtn);
    body.appendChild(modeRow);

    // Search bar
    const searchRow = document.createElement('div');
    searchRow.className = 'cim-goods-search-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'cim-goods-search-input';
    searchInput.placeholder = goodsSearchMode === 'smart' ? '红枣 去核 500g，枸杞 250g，菊花 朵' : 'Search products…';
    searchInput.value = goodsSearchMode === 'normal' ? goodsKeyword : '';
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.className = 'cim-goods-search-btn';
    searchBtn.textContent = 'Search';
    searchRow.append(searchInput, searchBtn);
    body.appendChild(searchRow);

    // Smart hint
    const smartHint = document.createElement('div');
    smartHint.className = 'cim-smart-hint';
    smartHint.textContent = 'Separate products with commas (，or ,): 红枣 去核 500g，枸杞 250g';
    smartHint.style.display = goodsSearchMode === 'smart' ? '' : 'none';
    body.appendChild(smartHint);

    // Multi-select toolbar
    const toolbarRow = document.createElement('div');
    toolbarRow.className = 'cim-goods-toolbar';
    const selectAllLabel = document.createElement('label');
    selectAllLabel.className = 'cim-goods-select-all';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.className = 'cim-goods-checkbox';
    const selectAllText = document.createElement('span');
    selectAllText.textContent = 'All';
    selectAllLabel.append(selectAllCb, selectAllText);
    const quoteBtn = document.createElement('button');
    quoteBtn.type = 'button';
    quoteBtn.className = 'cim-goods-quote-btn';
    quoteBtn.textContent = 'Quote';
    quoteBtn.disabled = true;
    const addSelectedBtn = document.createElement('button');
    addSelectedBtn.type = 'button';
    addSelectedBtn.className = 'cim-goods-add-selected-btn';
    addSelectedBtn.textContent = 'Add Selected';
    addSelectedBtn.disabled = true;
    const btnGroup = document.createElement('div');
    btnGroup.className = 'cim-goods-btn-group';
    btnGroup.append(quoteBtn, addSelectedBtn);
    toolbarRow.append(selectAllLabel, btnGroup);
    body.appendChild(toolbarRow);

    const listEl = document.createElement('div');
    listEl.className = 'cim-goods-list';
    body.appendChild(listEl);

    const pagerEl = document.createElement('div');
    pagerEl.className = 'cim-goods-pager';
    pagerEl.style.display = goodsSearchMode === 'smart' ? 'none' : '';
    body.appendChild(pagerEl);

    function syncToolbar() {
      const count = goodsSelectedIds.size;
      addSelectedBtn.disabled = count === 0;
      addSelectedBtn.textContent = count === 0 ? 'Add Selected' : `Add Selected (${count})`;
      quoteBtn.disabled = count === 0;
      const allChecked = visibleGoodsIds.length > 0 && visibleGoodsIds.every((id) => goodsSelectedIds.has(id));
      const someChecked = visibleGoodsIds.some((id) => goodsSelectedIds.has(id));
      selectAllCb.checked = allChecked;
      selectAllCb.indeterminate = !allChecked && someChecked;
    }

    selectAllCb.addEventListener('change', () => {
      if (selectAllCb.checked) visibleGoodsIds.forEach((id) => goodsSelectedIds.add(id));
      else visibleGoodsIds.forEach((id) => goodsSelectedIds.delete(id));
      listEl.querySelectorAll('.cim-goods-item-cb').forEach((cb) => {
        cb.checked = goodsSelectedIds.has(cb.dataset.goodsId);
      });
      syncToolbar();
    });

    quoteBtn.addEventListener('click', () => {
      const lines = [...goodsSelectedIds].map((id) => {
        const d = goodsDataMap[id];
        return d ? `${d.name} - RM ${d.price.toFixed(2)}` : null;
      }).filter(Boolean);
      if (!lines.length) return;
      navigator.clipboard.writeText(lines.join('\n')).then(() => {
        quoteBtn.textContent = 'Copied!';
        clearTimeout(quoteBtn._resetTimer);
        quoteBtn._resetTimer = setTimeout(() => { quoteBtn.textContent = 'Quote'; }, 1800);
      });
    });

    addSelectedBtn.addEventListener('click', () => {
      const selectedArray = [...goodsSelectedIds];
      if (!selectedArray.length) return;
      addSelectedBtn.disabled = true;
      addSelectedBtn.textContent = 'Adding…';
      selectAllCb.disabled = true;
      let done = 0, failed = 0, remaining = selectedArray.length;
      selectedArray.forEach((goodsId) => {
        const qty = goodsQtys[goodsId] || 1;
        chrome.runtime.sendMessage({ type: 'CART_ADD_ITEM', fbUserId: psid, goodsId, qty }, (res) => {
          if (res?.ok) {
            done++;
            const cb = listEl.querySelector(`.cim-goods-item-cb[data-goods-id="${CSS.escape(goodsId)}"]`);
            const cardAddBtn = cb?.closest('.cim-goods-item')?.querySelector('.cim-goods-add-btn');
            if (cardAddBtn) { cardAddBtn.textContent = '✓ Added'; cardAddBtn.classList.add('cim-goods-add-btn--done'); }
          } else {
            failed++;
            showCartError(document.getElementById(CART_MODAL_ID), res?.error || 'Add failed.');
          }
          remaining--;
          if (remaining > 0) return;
          goodsSelectedIds.clear();
          listEl.querySelectorAll('.cim-goods-item-cb').forEach((cb) => { cb.checked = false; });
          selectAllCb.checked = false;
          selectAllCb.indeterminate = false;
          selectAllCb.disabled = false;
          syncToolbar();
          addSelectedBtn.textContent = failed === 0 ? `✓ ${done} added` : `${done} ok · ${failed} failed`;
          setTimeout(() => { addSelectedBtn.textContent = 'Add Selected'; }, 2000);
        });
      });
    });

    function setMode(mode) {
      goodsSearchMode = mode;
      normalModeBtn.classList.toggle('cim-goods-mode-btn--active', mode === 'normal');
      smartModeBtn.classList.toggle('cim-goods-mode-btn--active', mode === 'smart');
      pagerEl.style.display = mode === 'smart' ? 'none' : '';
      smartHint.style.display = mode === 'smart' ? '' : 'none';
      searchInput.placeholder = mode === 'smart' ? '红枣 去核 500g，枸杞 250g，菊花 朵' : 'Search products…';
      searchInput.value = '';
      listEl.innerHTML = '';
      pagerEl.innerHTML = '';
      goodsKeyword = '';
      goodsSelectedIds.clear();
      visibleGoodsIds = [];
      syncToolbar();
      searchInput.focus();
      if (mode === 'normal') doSearch('', 1); // restore initial list
    }

    normalModeBtn.addEventListener('click', () => { if (goodsSearchMode !== 'normal') setMode('normal'); });
    smartModeBtn.addEventListener('click', () => { if (goodsSearchMode !== 'smart') setMode('smart'); });

    // Shared card builder
    function buildGoodsCard(goods) {
      const card = document.createElement('div');
      card.className = 'cim-goods-item';

      const checkWrap = document.createElement('label');
      checkWrap.className = 'cim-goods-item-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'cim-goods-item-cb cim-goods-checkbox';
      checkbox.dataset.goodsId = goods.goodsId;
      checkbox.checked = goodsSelectedIds.has(goods.goodsId);
      goodsDataMap[goods.goodsId] = { name: goods.name || '(Unknown)', price: parseFloat(goods.price) || 0 };
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) goodsSelectedIds.add(goods.goodsId);
        else goodsSelectedIds.delete(goods.goodsId);
        syncToolbar();
      });
      checkWrap.appendChild(checkbox);

      const thumb = document.createElement('div');
      thumb.className = 'cim-goods-thumb';
      if (goods.img) {
        const img = document.createElement('img');
        img.src = goods.img;
        img.alt = '';
        img.addEventListener('error', () => { img.style.display = 'none'; thumb.classList.add('cim-goods-thumb--empty'); });
        thumb.appendChild(img);
        thumb.classList.add('cim-goods-thumb--clickable');
        thumb.addEventListener('click', (e) => {
          e.stopPropagation();
          openGalleryModal([{ url: goods.img, id: String(goods.goodsId), label: goods.name }], 0);
        });
      } else {
        thumb.classList.add('cim-goods-thumb--empty');
      }

      const info = document.createElement('div');
      info.className = 'cim-goods-info';
      const goodsName = document.createElement('div');
      goodsName.className = 'cim-goods-name';
      goodsName.textContent = goods.name || '(Unknown)';
      const meta = document.createElement('div');
      meta.className = 'cim-goods-meta';
      meta.textContent = `RM ${(parseFloat(goods.price) || 0).toFixed(2)} · Stock: ${goods.stock ?? '—'}`;
      if (!goods.onSale) {
        const off = document.createElement('span');
        off.className = 'cim-goods-off-badge';
        off.textContent = 'OFF';
        meta.append(' ', off);
      }
      info.append(goodsName, meta);

      const right = document.createElement('div');
      right.className = 'cim-goods-item-right';

      const stepper = document.createElement('div');
      stepper.className = 'cim-cart-stepper';
      const gQty = goodsQtys[goods.goodsId] || 1;
      const minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'cim-cart-stepper-btn';
      minusBtn.textContent = '−';
      minusBtn.disabled = gQty <= 1;
      const qtyEl = document.createElement('input');
      qtyEl.type = 'text';
      qtyEl.inputMode = 'numeric';
      qtyEl.className = 'cim-cart-stepper-qty';
      qtyEl.value = String(gQty);
      qtyEl.setAttribute('aria-label', 'Quantity');
      const plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'cim-cart-stepper-btn';
      plusBtn.textContent = '+';
      minusBtn.addEventListener('click', () => {
        const cur = parseInt(qtyEl.value, 10);
        if (cur <= 1) return;
        qtyEl.value = String(cur - 1);
        goodsQtys[goods.goodsId] = cur - 1;
        minusBtn.disabled = cur - 1 <= 1;
      });
      plusBtn.addEventListener('click', () => {
        const cur = parseInt(qtyEl.value, 10);
        qtyEl.value = String(cur + 1);
        goodsQtys[goods.goodsId] = cur + 1;
        minusBtn.disabled = false;
      });
      qtyEl.addEventListener('input', () => {
        qtyEl.value = qtyEl.value.replace(/\D/g, '').replace(/^0+(\d)/, '$1');
      });
      qtyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); qtyEl.blur(); }
        if (e.key === 'Escape') { qtyEl.value = String(goodsQtys[goods.goodsId] || 1); qtyEl.blur(); }
      });
      qtyEl.addEventListener('blur', () => {
        const val = parseInt(qtyEl.value, 10);
        const clamped = (!val || val < 1) ? 1 : val;
        qtyEl.value = String(clamped);
        goodsQtys[goods.goodsId] = clamped;
        minusBtn.disabled = clamped <= 1;
      });
      stepper.append(minusBtn, qtyEl, plusBtn);

      const outOfStock = goods.stock !== null && goods.stock !== undefined && parseInt(goods.stock, 10) === 0;
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'cim-goods-add-btn';
      addBtn.textContent = 'Add';
      addBtn.disabled = outOfStock || !goods.onSale;

      addBtn.addEventListener('click', () => {
        const qty = parseInt(qtyEl.value, 10) || 1;
        addBtn.disabled = true;
        addBtn.textContent = '…';
        chrome.runtime.sendMessage({ type: 'CART_ADD_ITEM', fbUserId: psid, goodsId: goods.goodsId, qty }, (res) => {
          if (res?.ok) {
            addBtn.textContent = '✓ Added';
            addBtn.classList.add('cim-goods-add-btn--done');
          } else {
            addBtn.disabled = false;
            addBtn.textContent = 'Add';
            showCartError(document.getElementById(CART_MODAL_ID), res?.error || 'Add failed.');
          }
        });
      });

      right.append(stepper, addBtn);
      card.append(checkWrap, thumb, info, right);
      return card;
    }

    // Normal search (GET, paginated)
    const doSearch = (keyword, page) => {
      goodsKeyword = keyword;
      goodsPage = page;
      goodsSelectedIds.clear();
      visibleGoodsIds = [];
      listEl.innerHTML = '<div class="cim-drawer-loading">Searching…</div>';
      pagerEl.innerHTML = '';
      syncToolbar();
      chrome.runtime.sendMessage({ type: 'SEARCH_GOODS', keyword, page }, (res) => {
        if (!res?.ok) {
          listEl.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Search failed.'}</div>`;
          return;
        }
        const result = res.result || {};
        goodsTotalPages = result.pages || 1;
        listEl.innerHTML = '';

        if (result.noResult || !result.items || result.items.length === 0) {
          listEl.innerHTML = '<div class="cim-drawer-empty">No products found.</div>';
          return;
        }

        visibleGoodsIds = result.items.map((g) => g.goodsId);
        result.items.forEach((goods) => listEl.appendChild(buildGoodsCard(goods)));
        syncToolbar();

        if (goodsTotalPages > 1) {
          const prevBtn = document.createElement('button');
          prevBtn.type = 'button';
          prevBtn.className = 'cim-goods-pager-btn';
          prevBtn.textContent = '‹ Prev';
          prevBtn.disabled = goodsPage <= 1;
          prevBtn.addEventListener('click', () => doSearch(goodsKeyword, goodsPage - 1));
          const pageInfo = document.createElement('span');
          pageInfo.className = 'cim-goods-pager-info';
          pageInfo.textContent = `${goodsPage} / ${goodsTotalPages}`;
          const nextBtn = document.createElement('button');
          nextBtn.type = 'button';
          nextBtn.className = 'cim-goods-pager-btn';
          nextBtn.textContent = 'Next ›';
          nextBtn.disabled = goodsPage >= goodsTotalPages;
          nextBtn.addEventListener('click', () => doSearch(goodsKeyword, goodsPage + 1));
          pagerEl.append(prevBtn, pageInfo, nextBtn);
        }
      });
    };

    // Smart search (POST, parallel fan-out per comma-segment)
    const doSmartSearch = (sentence) => {
      const segments = sentence.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
      if (!segments.length) return;

      goodsSelectedIds.clear();
      visibleGoodsIds = [];
      syncToolbar();
      listEl.innerHTML = '<div class="cim-drawer-loading">Searching…</div>';

      let completed = 0;
      const results = new Array(segments.length).fill(null);

      segments.forEach((seg, i) => {
        const words = seg.split(/\s+/).filter(Boolean);
        chrome.runtime.sendMessage({ type: 'SMART_SEARCH_GOODS', words }, (res) => {
          results[i] = { seg, res };
          completed++;
          if (completed < segments.length) return;

          listEl.innerHTML = '';
          results.forEach(({ seg: segLabel, res: segRes }) => {
            const group = document.createElement('div');
            group.className = 'cim-smart-group';

            const groupHeader = document.createElement('div');
            groupHeader.className = 'cim-smart-group-header';
            const queryLabel = document.createElement('span');
            queryLabel.className = 'cim-smart-group-query';
            queryLabel.textContent = segLabel;
            const countBadge = document.createElement('span');
            countBadge.className = 'cim-smart-group-count';

            if (!segRes?.ok) {
              countBadge.textContent = 'Error';
              countBadge.classList.add('cim-smart-group-count--error');
            } else {
              const total = segRes.total || 0;
              countBadge.textContent = total === 0 ? 'No match' : String(total);
              if (total === 0) countBadge.classList.add('cim-smart-group-count--empty');
              else countBadge.classList.add('cim-smart-group-count--found');
            }

            groupHeader.append(queryLabel, countBadge);
            group.appendChild(groupHeader);

            if (segRes?.ok && segRes.items?.length > 0) {
              segRes.items.forEach((goods) => {
                visibleGoodsIds.push(goods.goodsId);
                group.appendChild(buildGoodsCard(goods));
              });
            }

            listEl.appendChild(group);
          });
          syncToolbar();
        });
      });
    };

    const triggerSearch = () => {
      const val = searchInput.value.trim();
      if (goodsSearchMode === 'smart') doSmartSearch(val);
      else doSearch(val, 1);
    };

    searchBtn.addEventListener('click', triggerSearch);
    // !e.isComposing prevents Chinese IME Enter (character confirmation) from firing search
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) triggerSearch(); });

    if (goodsSearchMode === 'normal') doSearch(goodsKeyword, goodsPage);
  }

  // ── Copy cart view ──────────────────────────────────────────────────────────

  function showCopyCartView(psid) {
    copySourceId = '';
    const modal = ensureCartModal();
    const body = modal.querySelector('.cim-drawer-body');
    setCartHeaderMode('copy');
    renderCopyCartView(body, psid);
  }

  function buildCopySection(title, count, variant) {
    const section = document.createElement('div');
    section.className = `cim-copy-section cim-copy-section--${variant}`;
    const header = document.createElement('div');
    header.className = 'cim-copy-section-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'cim-copy-section-title';
    titleEl.textContent = title;
    const badge = document.createElement('span');
    badge.className = 'cim-copy-section-badge';
    badge.textContent = String(count);
    header.append(titleEl, badge);
    const list = document.createElement('div');
    list.className = 'cim-copy-section-list';
    section.append(header, list);
    return section;
  }

  function renderCopyCartView(body, psid) {
    body.innerHTML = '';

    const helpText = document.createElement('p');
    helpText.className = 'cim-copy-help';
    helpText.textContent = 'Copy all items from another customer\'s cart into this one. Duplicate products are added as separate rows by default.';
    body.appendChild(helpText);

    const labelEl = document.createElement('label');
    labelEl.className = 'cim-copy-label';
    labelEl.textContent = 'Source Customer ID (fbUserId)';
    body.appendChild(labelEl);

    const inputRow = document.createElement('div');
    inputRow.className = 'cim-copy-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cim-copy-input';
    input.placeholder = 'e.g. 1234567890…';
    input.value = copySourceId;
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'cim-copy-preview-btn';
    previewBtn.textContent = 'Preview';
    inputRow.append(input, previewBtn);
    body.appendChild(inputRow);

    const expiredRow = document.createElement('label');
    expiredRow.className = 'cim-copy-expired-row';
    const expiredChk = document.createElement('input');
    expiredChk.type = 'checkbox';
    expiredChk.className = 'cim-copy-expired-chk';
    const expiredSpan = document.createElement('span');
    expiredSpan.textContent = 'Include expired items';
    expiredRow.append(expiredChk, expiredSpan);
    body.appendChild(expiredRow);

    const mergeRow = document.createElement('label');
    mergeRow.className = 'cim-copy-expired-row';
    const mergeChk = document.createElement('input');
    mergeChk.type = 'checkbox';
    mergeChk.className = 'cim-copy-expired-chk';
    const mergeSpan = document.createElement('span');
    mergeSpan.textContent = 'Merge duplicate quantities';
    mergeRow.append(mergeChk, mergeSpan);
    body.appendChild(mergeRow);

    const resultsEl = document.createElement('div');
    resultsEl.className = 'cim-copy-results';
    body.appendChild(resultsEl);

    const confirmRow = document.createElement('div');
    confirmRow.className = 'cim-copy-confirm-row';
    confirmRow.style.display = 'none';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cim-copy-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'cim-copy-confirm-btn';
    confirmBtn.textContent = '✓ Confirm Copy';
    confirmRow.append(cancelBtn, confirmBtn);
    body.appendChild(confirmRow);

    let previewData = null;

    function renderPreviewResults(data) {
      previewData = data;
      resultsEl.innerHTML = '';

      const hasItems = data.added.length > 0 || data.skipped.length > 0;

      if (!hasItems) {
        const empty = document.createElement('div');
        empty.className = 'cim-drawer-empty';
        empty.textContent = 'Source cart is empty or has no items to copy.';
        resultsEl.appendChild(empty);
        confirmRow.style.display = 'none';
        return;
      }

      if (data.added.length > 0) {
        const section = buildCopySection('✓ Will be added', data.added.length, 'added');
        const list = section.querySelector('.cim-copy-section-list');
        data.added.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'cim-copy-item';
          row.textContent = `${item.name || item.goodsId} × ${item.qty}`;
          list.appendChild(row);
        });
        resultsEl.appendChild(section);
      }

      if (data.skipped.length > 0) {
        const section = buildCopySection('⏭ Will be skipped', data.skipped.length, 'skipped');
        const list = section.querySelector('.cim-copy-section-list');
        data.skipped.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'cim-copy-item';
          row.textContent = `${item.name || item.goodsId} × ${item.qty}${item.reason ? ` — ${item.reason}` : ''}`;
          list.appendChild(row);
        });
        resultsEl.appendChild(section);
      }

      confirmRow.style.display = data.added.length > 0 ? '' : 'none';
    }

    function renderCopySuccess(data) {
      resultsEl.innerHTML = '';
      confirmRow.style.display = 'none';

      const banner = document.createElement('div');
      banner.className = 'cim-copy-success-banner';
      const parts = [`Added ${data.added.length}`];
      if (data.skipped.length) parts.push(`skipped ${data.skipped.length}`);
      if (data.failed.length) parts.push(`failed ${data.failed.length}`);
      banner.textContent = `✓ Copy complete — ${parts.join(' · ')}`;
      resultsEl.appendChild(banner);

      if (data.failed.length > 0) {
        const section = buildCopySection('⚠ Failed to add', data.failed.length, 'failed');
        const list = section.querySelector('.cim-copy-section-list');
        data.failed.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'cim-copy-item';
          row.textContent = `${item.name || item.goodsId} × ${item.qty}${item.error ? ` — ${item.error}` : ''}`;
          list.appendChild(row);
        });
        resultsEl.appendChild(section);
      }

      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'cim-copy-view-cart-btn';
      viewBtn.textContent = 'View Cart';
      viewBtn.addEventListener('click', () => showCartView(psid));
      resultsEl.appendChild(viewBtn);
    }

    function doPreview() {
      const sourceId = input.value.trim();
      if (!sourceId) { input.focus(); return; }
      copySourceId = sourceId;
      previewBtn.disabled = true;
      previewBtn.textContent = '…';
      resultsEl.innerHTML = '<div class="cim-drawer-loading">Checking source cart…</div>';
      confirmRow.style.display = 'none';
      previewData = null;
      chrome.runtime.sendMessage(
        { type: 'CART_COPY_ITEMS', fbUserId: psid, sourceFbUserId: sourceId, dryRun: true, includeExpired: expiredChk.checked, mergeDuplicates: mergeChk.checked },
        (res) => {
          previewBtn.disabled = false;
          previewBtn.textContent = 'Preview';
          if (!res?.ok) {
            resultsEl.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Preview failed.'}</div>`;
            return;
          }
          renderPreviewResults(res);
        }
      );
    }

    previewBtn.addEventListener('click', doPreview);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doPreview(); });

    cancelBtn.addEventListener('click', () => {
      resultsEl.innerHTML = '';
      confirmRow.style.display = 'none';
      previewData = null;
    });

    confirmBtn.addEventListener('click', () => {
      if (!previewData || previewData.added.length === 0) return;
      const sourceId = input.value.trim();
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = '…';
      chrome.runtime.sendMessage(
        { type: 'CART_COPY_ITEMS', fbUserId: psid, sourceFbUserId: sourceId, includeExpired: expiredChk.checked, mergeDuplicates: mergeChk.checked },
        (res) => {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          confirmBtn.textContent = '✓ Confirm Copy';
          if (!res?.ok) {
            showCartError(document.getElementById(CART_MODAL_ID), res?.error || 'Copy failed.');
            return;
          }
          renderCopySuccess(res);
        }
      );
    });

    input.focus();
  }

  // ── Checkout view ───────────────────────────────────────────────────────────

  function showCheckoutView(psid, selectedItems) {
    const modal = ensureCartModal();
    const body = modal.querySelector('.cim-drawer-body');
    setCartHeaderMode('checkout');
    body.innerHTML = '<div class="cim-drawer-loading">Loading checkout…</div>';
    const recIds = selectedItems.map((it) => it.recId);
    const goodsNumbers = selectedItems.map((it) => it.qty);
    chrome.runtime.sendMessage(
      { type: 'GET_CHECKOUT_FORM', fbUserId: psid, userId: cartUserId, recIds, goodsNumbers },
      (res) => {
        const liveModal = document.getElementById(CART_MODAL_ID);
        if (!liveModal) return;
        const liveBody = liveModal.querySelector('.cim-drawer-body');
        if (!res?.ok) {
          liveBody.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Failed to load checkout form.'}</div>`;
          return;
        }
        renderCheckoutForm(liveBody, liveModal, psid, res.customer, selectedItems);
      }
    );
  }

  function renderCheckoutForm(body, modal, psid, customer, selectedItems) {
    body.innerHTML = '';

    const itemTotal = selectedItems.reduce((s, it) => s + it.price * it.qty, 0);
    const summary = document.createElement('div');
    summary.className = 'cim-checkout-summary';
    summary.textContent = `${selectedItems.length} item${selectedItems.length === 1 ? '' : 's'} · RM${itemTotal.toFixed(2)}`;
    body.appendChild(summary);

    function makeField(labelText, input, required) {
      const row = document.createElement('div');
      row.className = 'cim-checkout-field';
      const lbl = document.createElement('label');
      lbl.className = 'cim-checkout-label';
      lbl.textContent = labelText + (required ? ' *' : '');
      row.append(lbl, input);
      return row;
    }

    const consigneeInput = document.createElement('input');
    consigneeInput.type = 'text';
    consigneeInput.className = 'cim-checkout-input';
    consigneeInput.value = customer.consignee || '';
    body.appendChild(makeField('Name', consigneeInput, true));

    const mobileInput = document.createElement('input');
    mobileInput.type = 'text';
    mobileInput.className = 'cim-checkout-input';
    mobileInput.value = customer.mobile || '';
    body.appendChild(makeField('Mobile', mobileInput, true));

    const addressInput = document.createElement('textarea');
    addressInput.className = 'cim-checkout-textarea';
    addressInput.rows = 2;
    addressInput.value = customer.address || '';
    body.appendChild(makeField('Address', addressInput, true));

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.className = 'cim-checkout-input';
    emailInput.value = customer.email || '';
    body.appendChild(makeField('Email', emailInput, false));

    const stateSelect = document.createElement('select');
    stateSelect.className = 'cim-checkout-select';
    (customer.stateOptions || []).forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.name;
      if (String(opt.id) === String(customer.regionCity)) o.selected = true;
      stateSelect.appendChild(o);
    });
    body.appendChild(makeField('State', stateSelect, true));

    const areaSelect = document.createElement('select');
    areaSelect.className = 'cim-checkout-select';
    (customer.areaOptions || []).forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.name;
      if (String(opt.id) === String(customer.regionArea)) o.selected = true;
      areaSelect.appendChild(o);
    });
    body.appendChild(makeField('Area', areaSelect, true));

    const postcodeInput = document.createElement('input');
    postcodeInput.type = 'text';
    postcodeInput.className = 'cim-checkout-input';
    postcodeInput.value = customer.regionCode || '';
    body.appendChild(makeField('Postcode', postcodeInput, true));

    stateSelect.addEventListener('change', () => {
      areaSelect.innerHTML = '<option>Loading…</option>';
      chrome.runtime.sendMessage({ type: 'GET_REGION_AREAS', stateId: stateSelect.value }, (res) => {
        areaSelect.innerHTML = '';
        if (res?.ok && res.areas?.length) {
          res.areas.forEach((a) => {
            const o = document.createElement('option');
            o.value = a.id;
            o.textContent = a.name;
            areaSelect.appendChild(o);
          });
          postcodeInput.value = res.areas[0].code || '';
        }
      });
    });

    areaSelect.addEventListener('change', () => {
      chrome.runtime.sendMessage({ type: 'GET_REGION_POSTCODE', areaId: areaSelect.value }, (res) => {
        if (res?.ok && res.postcode) postcodeInput.value = res.postcode;
      });
    });

    const shippingSection = document.createElement('div');
    shippingSection.className = 'cim-checkout-shipping';
    const shippingLbl = document.createElement('div');
    shippingLbl.className = 'cim-checkout-label';
    shippingLbl.textContent = 'Shipping *';
    shippingSection.appendChild(shippingLbl);
    let selectedShippingId = null;
    (customer.shippingOptions || []).forEach((opt) => {
      const optRow = document.createElement('label');
      optRow.className = 'cim-checkout-shipping-opt';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'cim-checkout-shipping';
      radio.value = opt.id;
      if (opt.checked) { radio.checked = true; selectedShippingId = opt.id; }
      radio.addEventListener('change', () => { if (radio.checked) selectedShippingId = opt.id; });
      optRow.append(radio, document.createTextNode(' ' + opt.label));
      shippingSection.appendChild(optRow);
    });
    body.appendChild(shippingSection);

    const btnRow = document.createElement('div');
    btnRow.className = 'cim-checkout-actions';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'cim-checkout-btn cim-checkout-btn--create';
    createBtn.textContent = 'Create Order';
    btnRow.appendChild(createBtn);
    body.appendChild(btnRow);

    function collectCustomer() {
      return {
        consignee: consigneeInput.value.trim(),
        mobile: mobileInput.value.trim(),
        address: addressInput.value.trim(),
        email: emailInput.value.trim() || undefined,
        regionCity: stateSelect.value,
        regionArea: areaSelect.value,
        regionCode: postcodeInput.value.trim(),
        paymentId: customer.paymentId,
      };
    }

    createBtn.addEventListener('click', () => {
      const c = collectCustomer();
      if (!c.consignee) { showCartError(modal, 'Name is required.'); return; }
      if (!c.mobile) { showCartError(modal, 'Mobile is required.'); return; }
      if (!c.address) { showCartError(modal, 'Address is required.'); return; }
      if (!c.regionCity) { showCartError(modal, 'State is required.'); return; }
      if (!c.regionArea) { showCartError(modal, 'Area is required.'); return; }
      if (!selectedShippingId) { showCartError(modal, 'Shipping method is required.'); return; }
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      const orderItems = selectedItems.map((it) => ({ recId: it.recId, qty: it.qty, price: it.price }));
      chrome.runtime.sendMessage(
        { type: 'CREATE_ORDER', fbUserId: psid, userId: cartUserId, items: orderItems, customer: c, shippingIdType: selectedShippingId, confirm: false, pay: false },
        (res) => {
          const liveModal = document.getElementById(CART_MODAL_ID);
          if (!liveModal) return;
          if (!res?.ok) {
            createBtn.disabled = false;
            createBtn.textContent = 'Create Order';
            showCartError(liveModal, res?.error || 'Order creation failed.');
            return;
          }
          renderCheckoutSuccess(liveModal.querySelector('.cim-drawer-body'), liveModal, psid, res);
          chrome.runtime.sendMessage({ type: 'GET_ORDER_LIST', psid }, (r) => {
            if (r?.ok && r.orders?.length) {
              renderRecentOrdersInPanel(r.orders.slice(0, 5).map((o) => ({
                orderId: o.orderId,
                orderSn: o.orderSn,
                totalAmount: o.amount,
                orderDate: o.orderTime,
              })));
            }
          });
        }
      );
    });
  }

  function renderCheckoutSuccess(body, modal, psid, result) {
    body.innerHTML = '';

    const successHeader = document.createElement('div');
    successHeader.className = 'cim-checkout-success-header';
    successHeader.textContent = '✓ Order Created';
    body.appendChild(successHeader);

    const snRow = document.createElement('div');
    snRow.className = 'cim-checkout-sn-row';
    const snEl = document.createElement('span');
    snEl.className = 'cim-checkout-sn';
    snEl.textContent = result.orderSn;
    snRow.appendChild(snEl);
    if (result.via === 'exact') {
      const viaBadge = document.createElement('span');
      viaBadge.className = 'cim-checkout-via cim-checkout-via--safe';
      viaBadge.textContent = '🔒 exact';
      snRow.appendChild(viaBadge);
    } else if (result.via) {
      const viaBadge = document.createElement('span');
      viaBadge.className = 'cim-checkout-via cim-checkout-via--warn';
      viaBadge.title = result.via === 'fallback' ? 'ID may be wrong — verify in Orders before trusting.' : 'Two simultaneous orders; newest taken.';
      viaBadge.textContent = result.via === 'fallback' ? '⚠ fallback — verify' : '⚠ multi-newest';
      snRow.appendChild(viaBadge);
    }
    body.appendChild(snRow);

    const statusEl = document.createElement('div');
    statusEl.className = 'cim-checkout-status';
    statusEl.textContent = result.status || '待确认';
    body.appendChild(statusEl);

    const payableEl = document.createElement('div');
    payableEl.className = 'cim-checkout-payable';
    payableEl.textContent = 'Loading amount…';
    body.appendChild(payableEl);

    // Adjustment section
    const adjSection = document.createElement('div');
    adjSection.className = 'cim-checkout-adj';
    const adjTitle = document.createElement('div');
    adjTitle.className = 'cim-checkout-adj-title';
    adjTitle.textContent = 'Adjustment (optional)';
    adjSection.appendChild(adjTitle);

    const adjTypeRow = document.createElement('div');
    adjTypeRow.className = 'cim-checkout-adj-type';
    const discountLabel = document.createElement('label');
    const discountRadio = document.createElement('input');
    discountRadio.type = 'radio';
    discountRadio.name = 'cim-adj-type-' + result.orderId;
    discountRadio.value = '1';
    discountRadio.checked = true;
    discountLabel.append(discountRadio, document.createTextNode(' Discount (−)'));
    const addLabel = document.createElement('label');
    const addRadio = document.createElement('input');
    addRadio.type = 'radio';
    addRadio.name = 'cim-adj-type-' + result.orderId;
    addRadio.value = '2';
    addLabel.append(addRadio, document.createTextNode(' Add Amount (+)'));
    adjTypeRow.append(discountLabel, addLabel);
    adjSection.appendChild(adjTypeRow);

    const adjAmountInput = document.createElement('input');
    adjAmountInput.type = 'number';
    adjAmountInput.min = '0';
    adjAmountInput.step = '0.01';
    adjAmountInput.className = 'cim-checkout-input';
    adjAmountInput.placeholder = 'Amount (RM)';
    adjSection.appendChild(adjAmountInput);

    const adjNoteInput = document.createElement('input');
    adjNoteInput.type = 'text';
    adjNoteInput.className = 'cim-checkout-input';
    adjNoteInput.placeholder = 'Note (optional)';
    adjSection.appendChild(adjNoteInput);

    const adjApplyBtn = document.createElement('button');
    adjApplyBtn.type = 'button';
    adjApplyBtn.className = 'cim-checkout-btn cim-checkout-btn--adj';
    adjApplyBtn.textContent = 'Apply';
    adjSection.appendChild(adjApplyBtn);
    body.appendChild(adjSection);

    // Action buttons
    const actRow = document.createElement('div');
    actRow.className = 'cim-checkout-actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'cim-checkout-btn cim-checkout-btn--confirm';
    confirmBtn.textContent = 'Confirm';
    const confirmPaidBtn = document.createElement('button');
    confirmPaidBtn.type = 'button';
    confirmPaidBtn.className = 'cim-checkout-btn cim-checkout-btn--paid';
    confirmPaidBtn.textContent = 'Confirm+Paid';
    const viewOrderBtn = document.createElement('button');
    viewOrderBtn.type = 'button';
    viewOrderBtn.className = 'cim-checkout-btn cim-checkout-btn--view';
    viewOrderBtn.textContent = 'View Order';
    actRow.append(confirmBtn, confirmPaidBtn, viewOrderBtn);
    body.appendChild(actRow);

    const orderId = result.orderId;

    function refreshPayable() {
      chrome.runtime.sendMessage({ type: 'GET_ORDER_DETAIL', orderId }, (res) => {
        if (!res?.ok) return;
        payableEl.textContent = `Payable: RM${parseFloat(res.payable || 0).toFixed(2)}`;
        payableEl.classList.remove('cim-payable--flash');
        void payableEl.offsetWidth;
        payableEl.classList.add('cim-payable--flash');
        statusEl.textContent = res.statusText || res.status || '';
        const parts = res.statusParts || {};
        const confirmedAlready = !parts.confirm?.startsWith('待');
        confirmBtn.style.display = confirmedAlready ? 'none' : '';
        confirmPaidBtn.style.display = confirmedAlready ? 'none' : '';
      });
    }
    refreshPayable();

    adjApplyBtn.addEventListener('click', () => {
      const amount = parseFloat(adjAmountInput.value);
      if (!amount || amount <= 0) { showCartError(modal, 'Enter a valid amount.'); return; }
      const adjType = parseInt(adjTypeRow.querySelector('input[type="radio"]:checked')?.value || '1', 10);
      const note = adjNoteInput.value.trim() || undefined;
      adjApplyBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'ORDER_ADJUSTMENT', orderId, price: amount, adjType, note }, (res) => {
        adjApplyBtn.disabled = false;
        if (!res?.ok) { showCartError(modal, res?.error || 'Adjustment failed.'); return; }
        adjAmountInput.value = '';
        adjNoteInput.value = '';
        refreshPayable();
      });
    });

    confirmBtn.addEventListener('click', () => {
      confirmBtn.disabled = true;
      confirmPaidBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'ORDER_OPERATION', orderId, operation: 'confirm' }, (res) => {
        if (!res?.ok) {
          confirmBtn.disabled = false;
          confirmPaidBtn.disabled = false;
          showCartError(modal, res?.error || 'Confirm failed.');
          return;
        }
        refreshPayable();
      });
    });

    confirmPaidBtn.addEventListener('click', () => {
      confirmBtn.disabled = true;
      confirmPaidBtn.disabled = true;
      chrome.runtime.sendMessage({ type: 'ORDER_OPERATION', orderId, operation: 'confirm' }, (res1) => {
        if (!res1?.ok) {
          confirmBtn.disabled = false;
          confirmPaidBtn.disabled = false;
          showCartError(modal, res1?.error || 'Confirm failed.');
          return;
        }
        chrome.runtime.sendMessage({ type: 'ORDER_OPERATION', orderId, operation: 'pay' }, (res2) => {
          if (!res2?.ok) showCartError(modal, res2?.error || 'Pay failed.');
          refreshPayable();
        });
      });
    });

    viewOrderBtn.addEventListener('click', () => {
      closeCartModal();
      openOrderDetail(orderId);
    });
  }

  // ── Order list modal ────────────────────────────────────────────────────────

  function ensureOrderListModal() {
    if (document.getElementById(ORDER_LIST_MODAL_ID)) return document.getElementById(ORDER_LIST_MODAL_ID);

    const overlay = document.createElement('div');
    overlay.id = ORDER_LIST_OVERLAY_ID;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeOrderListModal(); });

    const modal = document.createElement('div');
    modal.id = ORDER_LIST_MODAL_ID;
    modal.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'cim-drawer-header';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'cim-ol-back-btn';
    backBtn.setAttribute('aria-label', 'Back to list');
    backBtn.textContent = '← Back';
    backBtn.hidden = true;
    backBtn.addEventListener('click', () => {
      if (modal._backAction) modal._backAction();
    });

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cim-drawer-title-wrap';
    const title = document.createElement('span');
    title.className = 'cim-drawer-title';
    title.textContent = 'Orders';
    const subtitle = document.createElement('span');
    subtitle.className = 'cim-drawer-subtitle';
    titleWrap.append(title, subtitle);

    const headerRight = document.createElement('div');
    headerRight.className = 'cim-cart-header-right';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'cim-cart-refresh-btn';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    refreshBtn.textContent = '↻';
    refreshBtn.addEventListener('click', () => {
      if (modal._refreshAction) modal._refreshAction();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cim-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeOrderListModal);

    headerRight.append(refreshBtn, closeBtn);
    header.append(backBtn, titleWrap, headerRight);

    const drawerBody = document.createElement('div');
    drawerBody.className = 'cim-drawer-body';

    const footer = document.createElement('div');
    footer.className = 'cim-drawer-footer';

    const footerActions = document.createElement('div');
    footerActions.className = 'cim-ol-footer-actions';

    const footerClose = document.createElement('button');
    footerClose.type = 'button';
    footerClose.className = 'cim-drawer-footer-close';
    footerClose.textContent = 'Close';
    footerClose.addEventListener('click', closeOrderListModal);
    footer.append(footerActions, footerClose);

    modal.append(header, drawerBody, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('cim-order-list-overlay--visible')) {
        closeOrderListModal();
      }
    });

    return modal;
  }

  function setOrderListHeaderMode(mode, modal) {
    const backBtn = modal.querySelector('.cim-ol-back-btn');
    const refreshBtn = modal.querySelector('.cim-cart-refresh-btn');
    if (mode === 'list') {
      if (backBtn) backBtn.hidden = true;
      if (refreshBtn) refreshBtn.hidden = false;
    } else {
      if (backBtn) backBtn.hidden = false;
      if (refreshBtn) refreshBtn.hidden = true;
    }
  }

  function openOrderListModal(psid, preloadedOrders) {
    orderListModalPsid = psid;
    const modal = ensureOrderListModal();
    modal._noBack = false;
    document.getElementById(ORDER_LIST_OVERLAY_ID).classList.add('cim-order-list-overlay--visible');
    showOrderList(psid, preloadedOrders);
  }

  function openOrderDetailNoBack(orderId) {
    const modal = ensureOrderListModal();
    modal._noBack = true;
    document.getElementById(ORDER_LIST_OVERLAY_ID).classList.add('cim-order-list-overlay--visible');
    showOrderDetail(orderId);
  }

  function closeOrderListModal() {
    const overlay = document.getElementById(ORDER_LIST_OVERLAY_ID);
    if (overlay) overlay.classList.remove('cim-order-list-overlay--visible');
  }

  function mapShippingLabel(method) {
    if (!method) return null;
    if (method.includes('西马')) return '西马';
    if (method.includes('东马')) return '东马';
    if (method.includes('新加坡')) return '新加坡';
    if (/system|自取/i.test(method)) return '自取';
    return method;
  }

  function formatOrderDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }

  function renderOrderCards(orders, body) {
    body.innerHTML = '';
    orders.forEach((order) => {
        const card = document.createElement('div');
        card.className = 'cim-ol-card cim-ol-card--clickable';
        card.addEventListener('click', () => openOrderDetail(order.orderId));

        const topRow = document.createElement('div');
        topRow.className = 'cim-ol-top';
        const sn = document.createElement('span');
        sn.className = 'cim-ol-sn';
        sn.textContent = order.orderSn;
        if (order.orderSn) sn.dataset.orderId = order.orderSn;
        const amount = document.createElement('span');
        amount.className = 'cim-ol-amount';
        amount.textContent = order.amount ? `RM ${parseFloat(order.amount).toFixed(2)}` : '—';
        topRow.append(sn, amount);

        const midRow = document.createElement('div');
        midRow.className = 'cim-ol-mid';
        const parts = [order.consignee, order.mobile].filter(Boolean);
        midRow.textContent = parts.join(' · ');

        const infoRow = document.createElement('div');
        infoRow.className = 'cim-ol-info';
        const infoParts = [
          formatOrderDate(order.orderTime),
          mapShippingLabel(order.shippingMethod),
        ].filter(Boolean);
        if (infoParts.length) infoRow.textContent = infoParts.join(' · ');

        const botRow = document.createElement('div');
        botRow.className = 'cim-ol-bot';
        if (order.statusParts) {
          ['confirm', 'payment', 'shipping'].forEach((key) => {
            const val = order.statusParts[key];
            if (!val) return;
            const badge = document.createElement('span');
            badge.className = 'cim-ol-status-badge';
            if (val.startsWith('已')) badge.classList.add('cim-ol-status--done');
            else if (val.startsWith('未')) badge.classList.add('cim-ol-status--pending');
            else if (val.startsWith('待')) badge.classList.add('cim-ol-status--waiting');
            badge.textContent = val;
            botRow.appendChild(badge);
          });
        } else if (order.statusText) {
          const badge = document.createElement('span');
          badge.className = 'cim-ol-status-badge';
          badge.textContent = order.statusText;
          botRow.appendChild(badge);
        }

        card.append(topRow, midRow);
        if (infoParts.length) card.appendChild(infoRow);
        card.appendChild(botRow);
        body.appendChild(card);
    });

    // Ship-status colouring — same legend as the panel's recent-orders list.
    // One batched call for the whole list; orders missing from the ERP response
    // (>60-day lookup window) keep the default dark SN colour.
    const snIds = orders.map((o) => o.orderSn).filter(Boolean);
    if (!snIds.length) return;
    chrome.runtime.sendMessage({ type: 'GET_ORDER_STATUSES', orderIds: snIds }, (response) => {
      if (!response?.ok || !response.statuses) return;
      if (!body.isConnected) return;
      body.querySelectorAll('.cim-ol-sn[data-order-id]').forEach((el) => {
        const st = response.statuses[el.dataset.orderId];
        if (!st) {
          el.title = 'No ERP activity in the last 60 days — status unknown (old order, likely shipped long ago)';
          return;
        }
        if (st === 'WAIT_AUDIT') el.style.color = 'orange';
        else if (st === 'PARTIAL_AUDIT') el.style.color = '#9333ea';
        else el.style.color = '#0a7cff';
      });
    });
  }

  function renderRecentOrdersInPanel(orders) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const section = panel.querySelector('.cim-recent-orders-section');
    if (!section) return;
    section.innerHTML = '';

    if (!orders.length) {
      const empty = document.createElement('div');
      empty.className = 'cim-orders-empty';
      empty.textContent = 'No orders found.';
      section.appendChild(empty);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'cim-orders-list';
    orders.forEach((order) => {
      const li = document.createElement('li');

      // Amount floats right — must be first in DOM for float to work
      const amountEl = document.createElement('span');
      amountEl.className = 'cim-order-amount';
      amountEl.textContent = formatCurrency(order.totalAmount ?? order.amount);
      li.appendChild(amountEl);

      // Baserow-only orders: orderId is the F-prefixed string (same as orderSn).
      // EC2 orders: orderId is a numeric id distinct from orderSn.
      const isBaserow = !order.orderId || String(order.orderId) === String(order.orderSn);
      const displaySn = order.orderSn || order.orderId;

      let idEl;
      if (isBaserow) {
        idEl = document.createElement('a');
        idEl.href = `https://ddherbs.com.my/track/${encodeURIComponent(displaySn)}`;
        idEl.target = '_blank';
        idEl.rel = 'noopener noreferrer';
        idEl.className = 'cim-order-id cim-order-id--baserow';
      } else {
        idEl = document.createElement('span');
        idEl.className = 'cim-order-id';
        idEl.setAttribute('role', 'button');
        idEl.tabIndex = 0;
        idEl.addEventListener('click', () => openOrderDetailNoBack(order.orderId));
        idEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openOrderDetailNoBack(order.orderId); });
      }
      idEl.dataset.orderId = displaySn;
      idEl.textContent = displaySn;
      li.appendChild(idEl);

      const dateVal = order.orderDate || order.orderTime;
      if (dateVal) {
        const d = new Date(dateVal);
        const dateEl = document.createElement('span');
        dateEl.className = 'cim-order-date';
        dateEl.textContent = ` (${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()})`;
        li.appendChild(dateEl);
      }

      li.appendChild(buildCopyButton(displaySn));
      list.appendChild(li);
    });
    section.appendChild(list);

    const orderIds = orders.map((o) => o.orderSn || o.orderId).filter(Boolean);
    if (!orderIds.length) return;
    const capturedUid = sessionState.uid;
    chrome.runtime.sendMessage({ type: 'GET_ORDER_STATUSES', orderIds }, (response) => {
      if (getUserIdFromUrl() !== capturedUid) return;
      if (!response?.ok || !response.statuses) return;
      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel) return;
      livePanel.querySelectorAll('.cim-order-id').forEach((el) => {
        const st = response.statuses[el.dataset.orderId];
        if (st === 'WAIT_AUDIT') el.style.color = 'orange';
        else if (st === 'PARTIAL_AUDIT') el.style.color = '#9333ea';
      });
    });
    chrome.runtime.sendMessage({ type: 'CHECK_PARCEL_PHOTOS', orderIds }, (photoRes) => {
      if (getUserIdFromUrl() !== capturedUid) return;
      if (!photoRes?.ok || !photoRes.results) return;
      const livePanel = document.getElementById(PANEL_ID);
      if (!livePanel) return;
      Object.entries(photoRes.results).forEach(([orderId, info]) => {
        if (!info.hasPhotos) return;
        const idEl = livePanel.querySelector(`.cim-order-id[data-order-id="${CSS.escape(orderId)}"]`);
        if (!idEl) return;
        const li = idEl.closest('li');
        if (!li || li.querySelector('.cim-photo-icon')) return;
        li.appendChild(buildPhotoIconBtn(orderId));
      });
    });
  }

  function showOrderList(psid, preloadedOrders) {
    const modal = ensureOrderListModal();
    modal._refreshAction = () => showOrderList(psid);
    setOrderListHeaderMode('list', modal);
    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    if (footerActions) footerActions.innerHTML = '';
    const body = modal.querySelector('.cim-drawer-body');
    modal.querySelector('.cim-drawer-title').textContent = sessionState.name || 'Orders';

    if (preloadedOrders) {
      modal.querySelector('.cim-drawer-subtitle').textContent = `${preloadedOrders.length} order${preloadedOrders.length !== 1 ? 's' : ''}`;
      if (!preloadedOrders.length) {
        body.innerHTML = '<div class="cim-drawer-empty">No orders found.</div>';
      } else {
        renderOrderCards(preloadedOrders, body);
      }
      return;
    }

    modal.querySelector('.cim-drawer-subtitle').textContent = '';
    body.innerHTML = '<div class="cim-drawer-loading">Loading orders…</div>';
    chrome.runtime.sendMessage({ type: 'GET_ORDER_LIST', psid }, (res) => {
      const liveModal = document.getElementById(ORDER_LIST_MODAL_ID);
      if (!liveModal) return;
      const liveBody = liveModal.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Failed to load orders.'}</div>`;
        return;
      }
      const orders = res.orders || [];
      liveModal.querySelector('.cim-drawer-subtitle').textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;
      if (!orders.length) {
        liveBody.innerHTML = '<div class="cim-drawer-empty">No orders found.</div>';
        return;
      }
      renderOrderCards(orders, liveBody);
      renderRecentOrdersInPanel(orders.slice(0, 5).map((o) => ({
        orderId: o.orderId,
        orderSn: o.orderSn,
        totalAmount: o.amount,
        orderDate: o.orderTime,
      })));
    });
  }

  // ── Order detail view ───────────────────────────────────────────────────────

  function openOrderDetail(orderId) {
    ensureOrderListModal();
    document.getElementById(ORDER_LIST_OVERLAY_ID).classList.add('cim-order-list-overlay--visible');
    showOrderDetail(orderId);
  }

  function showOrderDetail(orderId) {
    orderDetailOrderId = orderId;
    const modal = ensureOrderListModal();
    if (!modal._noBack) {
      modal._backAction = () => { setOrderListHeaderMode('list', modal); showOrderList(orderListModalPsid); };
    }
    modal._refreshAction = () => showOrderDetail(orderId);
    setOrderListHeaderMode('detail', modal);
    if (modal._noBack) {
      const backBtn = modal.querySelector('.cim-ol-back-btn');
      if (backBtn) backBtn.hidden = true;
    }
    const body = modal.querySelector('.cim-drawer-body');
    body.innerHTML = '<div class="cim-drawer-loading">Loading order…</div>';
    modal.querySelector('.cim-drawer-title').textContent = 'Loading…';
    modal.querySelector('.cim-drawer-subtitle').textContent = '';
    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    if (footerActions) footerActions.innerHTML = '';

    chrome.runtime.sendMessage({ type: 'GET_ORDER_DETAIL', orderId }, (res) => {
      const liveModal = document.getElementById(ORDER_LIST_MODAL_ID);
      if (!liveModal || orderDetailOrderId !== orderId) return;
      const liveBody = liveModal.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Failed to load order.'}</div>`;
        return;
      }
      renderOrderDetail(liveBody, liveModal, res);
    });
  }

  function renderOrderDetail(body, modal, data) {
    body.innerHTML = '';
    modal.querySelector('.cim-drawer-title').textContent = data.orderSn;
    modal.querySelector('.cim-drawer-subtitle').textContent = data.statusText || '';

    function mkEl(tag, cls, txt) {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (txt != null) el.textContent = txt;
      return el;
    }

    function mkInfoCard(rows) {
      const card = mkEl('div', 'cim-drawer-info-card');
      rows.forEach(([label, value]) => {
        if (!value) return;
        const row = mkEl('div', 'cim-drawer-info-row');
        row.append(mkEl('span', 'cim-drawer-info-label', label), mkEl('span', 'cim-drawer-info-value', value));
        card.appendChild(row);
      });
      return card;
    }

    function mkSection(titleText) {
      const sect = mkEl('div', 'cim-od-section');
      const hdr = mkEl('div', 'cim-od-section-header');
      hdr.appendChild(mkEl('span', 'cim-od-section-title', titleText));
      sect.appendChild(hdr);
      return { sect, hdr };
    }

    // Status badges
    if (data.statusParts) {
      const statusRow = mkEl('div', 'cim-od-status-row');
      ['confirm', 'payment', 'shipping'].forEach((key) => {
        const val = data.statusParts[key];
        if (!val) return;
        const badge = mkEl('span', 'cim-ol-status-badge', val);
        if (val.startsWith('已')) badge.classList.add('cim-ol-status--done');
        else if (val.startsWith('未')) badge.classList.add('cim-ol-status--pending');
        else badge.classList.add('cim-ol-status--waiting');
        statusRow.appendChild(badge);
      });
      body.appendChild(statusRow);
    }

    // Order meta info
    const metaCard = mkInfoCard([
      ['Order Time', data.orderTime ? formatOrderDate(data.orderTime) : null],
      ['Payment', data.paymentMethod],
      ['Pay Time', data.payTime && data.payTime !== '未付款' ? data.payTime : null],
      ['Shipping', data.shippingMethod ? (mapShippingLabel(data.shippingMethod) || data.shippingMethod) : null],
      ['Ship Time', data.shipTime && data.shipTime !== '未出货' ? data.shipTime : null],
      ['Buyer', data.buyer?.name],
    ]);
    if (metaCard.children.length) body.appendChild(metaCard);

    // Recipient
    const { sect: recipSect, hdr: recipHdr } = mkSection('Recipient');
    const editBtn = mkEl('button', 'cim-od-edit-btn', 'Edit');
    editBtn.type = 'button';
    editBtn.addEventListener('click', () => showEditConsigneeDialog(modal, data.orderId, data));
    recipHdr.appendChild(editBtn);
    const recip = data.recipient || {};
    recipSect.appendChild(mkInfoCard([
      ['Name', recip.consignee],
      ['Mobile', recip.mobile],
      ['Email', recip.email],
      ['Address', recip.address],
    ]));
    body.appendChild(recipSect);

    // Items
    if (data.items && data.items.length) {
      const { sect: itemsSect, hdr: itemsHdr } = mkSection(`Items · ${data.itemsCount || data.items.length} pcs`);
      const list = mkEl('div', 'cim-od-items-list');
      const itemImgList = data.items.filter((it) => it.img).map((it, i) => ({ url: it.img, id: `item-${i}`, label: it.name }));
      let imgCounter = 0;
      data.items.forEach((item) => {
        const row = mkEl('div', 'cim-od-item-row');
        const imgWrap = mkEl('div', 'cim-od-item-img-wrap');
        if (item.img) {
          const img = mkEl('img', 'cim-od-item-img');
          img.src = item.img;
          img.alt = item.name || '';
          const capturedIdx = imgCounter++;
          imgWrap.classList.add('cim-od-item-img-wrap--clickable');
          imgWrap.addEventListener('click', (e) => {
            e.stopPropagation();
            openGalleryModal(itemImgList, capturedIdx);
          });
          imgWrap.appendChild(img);
        }
        const info = mkEl('div', 'cim-od-item-info');
        info.appendChild(mkEl('span', 'cim-od-item-name', item.name));
        const meta = mkEl('div', 'cim-od-item-meta');
        if (item.note) meta.appendChild(mkEl('span', 'cim-od-item-code', item.note));
        if (item.origin && item.origin !== '--') meta.appendChild(mkEl('span', 'cim-od-item-origin', item.origin));
        if (item.shipState) {
          const sb = mkEl('span', 'cim-od-item-ship', item.shipState);
          sb.classList.add(item.shipState.startsWith('已') ? 'cim-od-ship--done' : 'cim-od-ship--pending');
          meta.appendChild(sb);
        }
        info.appendChild(meta);
        const priceCol = mkEl('div', 'cim-od-item-price-col');
        priceCol.append(
          mkEl('span', 'cim-od-item-qty', `× ${item.qty}`),
          mkEl('span', 'cim-od-item-linetotal', `RM ${parseFloat(item.lineTotal || 0).toFixed(2)}`)
        );
        row.append(imgWrap, info, priceCol);
        list.appendChild(row);
      });
      itemsSect.appendChild(list);
      body.appendChild(itemsSect);
    }

    // Summary / fees
    const { sect: sumSect } = mkSection('Summary');
    const feeList = mkEl('div', 'cim-od-fee-list');
    const addFee = (label, value, cls) => {
      const row = mkEl('div', 'cim-od-fee-row' + (cls ? ' ' + cls : ''));
      row.append(mkEl('span', 'cim-od-fee-label', label), mkEl('span', 'cim-od-fee-value', value));
      feeList.appendChild(row);
    };
    if (data.itemsTotal != null) addFee('Subtotal', `RM ${parseFloat(data.itemsTotal).toFixed(2)}`);
    if (data.shipping != null) addFee('Shipping', `RM ${parseFloat(data.shipping).toFixed(2)}`);
    if (data.discount) addFee(`Discount${data.discount.note ? ` (${data.discount.note})` : ''}`, `-RM ${parseFloat(data.discount.amount).toFixed(2)}`, 'cim-od-fee-row--discount');
    if (data.addAmount) addFee(`Add Amount${data.addAmount.note ? ` (${data.addAmount.note})` : ''}`, `+RM ${parseFloat(data.addAmount.amount).toFixed(2)}`, 'cim-od-fee-row--add');
    addFee('Payable', `RM ${parseFloat(data.payable || 0).toFixed(2)}`, 'cim-od-fee-row--payable');
    sumSect.appendChild(feeList);
    body.appendChild(sumSect);

    // Adjustment section — hidden once order is shipped (已出货)
    if (!data.statusParts?.shipping?.startsWith('已')) {
      const adjSect = mkEl('div', 'cim-checkout-adj');
      const adjTitle = mkEl('div', 'cim-checkout-adj-title', 'Adjustment (optional)');
      adjSect.appendChild(adjTitle);

      const adjTypeRow = mkEl('div', 'cim-checkout-adj-type');
      const discountLabel = document.createElement('label');
      const discountRadio = document.createElement('input');
      discountRadio.type = 'radio';
      discountRadio.name = 'cim-od-adj-type-' + data.orderId;
      discountRadio.value = '1';
      discountRadio.checked = true;
      discountLabel.append(discountRadio, document.createTextNode(' Discount (−)'));
      const addLabel = document.createElement('label');
      const addRadio = document.createElement('input');
      addRadio.type = 'radio';
      addRadio.name = 'cim-od-adj-type-' + data.orderId;
      addRadio.value = '2';
      addLabel.append(addRadio, document.createTextNode(' Add Amount (+)'));
      adjTypeRow.append(discountLabel, addLabel);
      adjSect.appendChild(adjTypeRow);

      const adjAmountInput = mkEl('input', 'cim-checkout-input');
      adjAmountInput.type = 'number';
      adjAmountInput.min = '0';
      adjAmountInput.step = '0.01';
      adjAmountInput.placeholder = 'Amount (RM)';
      adjSect.appendChild(adjAmountInput);

      const adjNoteInput = mkEl('input', 'cim-checkout-input');
      adjNoteInput.type = 'text';
      adjNoteInput.placeholder = 'Note (optional)';
      adjSect.appendChild(adjNoteInput);

      const adjApplyBtn = mkEl('button', 'cim-checkout-btn cim-checkout-btn--adj', 'Apply');
      adjApplyBtn.type = 'button';
      adjSect.appendChild(adjApplyBtn);
      body.appendChild(adjSect);

      adjApplyBtn.addEventListener('click', () => {
        const amount = parseFloat(adjAmountInput.value);
        if (!amount || amount <= 0) { showOrderDetailToast(modal, 'Enter a valid amount.'); return; }
        const adjType = parseInt(adjTypeRow.querySelector('input[type="radio"]:checked')?.value || '1', 10);
        const note = adjNoteInput.value.trim() || undefined;
        adjApplyBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'ORDER_ADJUSTMENT', orderId: data.orderId, price: amount, adjType, note }, (res) => {
          adjApplyBtn.disabled = false;
          if (!res?.ok) { showOrderDetailToast(modal, res?.error || 'Adjustment failed.'); return; }
          showOrderDetail(data.orderId);
        });
      });
    }

    // Notes
    if (data.note || data.csNote) {
      const { sect: notesSect } = mkSection('Notes');
      if (data.note) notesSect.appendChild(mkInfoCard([['Order Note', data.note]]));
      if (data.csNote) notesSect.appendChild(mkInfoCard([['CS Note', data.csNote]]));
      body.appendChild(notesSect);
    }

    // Parcel Photos (async)
    const capturedOdId = data.orderId;
    const photoPlaceholder = mkEl('div', 'cim-od-photo-placeholder');
    body.appendChild(photoPlaceholder);
    chrome.runtime.sendMessage({ type: 'GET_PARCEL_PHOTO_ORDER', orderId: data.orderSn }, (photoRes) => {
      if (orderDetailOrderId !== capturedOdId) return;
      const liveBody = modal.querySelector('.cim-drawer-body');
      if (!liveBody) return;
      const livePh = liveBody.querySelector('.cim-od-photo-placeholder');
      if (!livePh) return;
      if (!photoRes?.ok || !photoRes.found || !photoRes.orders?.length) { livePh.remove(); return; }
      const { sect: photoSect } = mkSection('Parcel Photos');
      const singleWms = photoRes.orders.length === 1;
      photoRes.orders.forEach((wmsOrder, wmsIdx) => {
        const contentEls = buildWmsContent(wmsOrder);
        if (singleWms) {
          const wrapper = mkEl('div', 'cim-parcel-section-body');
          wrapper.style.display = 'flex';
          contentEls.forEach((el) => wrapper.appendChild(el));
          photoSect.appendChild(wrapper);
        } else {
          const wmsSection = mkEl('div', 'cim-parcel-section');
          const wmsHeader = mkEl('div', 'cim-parcel-section-header');
          const wmsTitle = mkEl('span', 'cim-parcel-section-title', wmsOrder.wmsId || `Parcel ${wmsIdx + 1}`);
          const chevron = mkEl('span', 'cim-parcel-section-chevron', '▸');
          wmsHeader.append(wmsTitle, chevron);
          const wmsBody = mkEl('div', 'cim-parcel-section-body');
          contentEls.forEach((el) => wmsBody.appendChild(el));
          if (wmsIdx === 0) { wmsBody.style.display = 'flex'; chevron.style.transform = 'rotate(90deg)'; }
          wmsHeader.addEventListener('click', () => {
            const open = wmsBody.style.display === 'none' || wmsBody.style.display === '';
            wmsBody.style.display = open ? 'flex' : 'none';
            chevron.style.transform = open ? 'rotate(90deg)' : '';
          });
          wmsSection.append(wmsHeader, wmsBody);
          photoSect.appendChild(wmsSection);
        }
      });
      livePh.replaceWith(photoSect);
    });

    // Footer action buttons (derive from statusParts)
    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    if (footerActions) {
      footerActions.innerHTML = '';
      const sp = data.statusParts || {};

      function mkOpBtn(text, cls, onClick) {
        const btn = mkEl('button', `cim-od-op-btn ${cls}`, text);
        btn.type = 'button';
        btn.addEventListener('click', onClick);
        return btn;
      }

      if (sp.confirm?.startsWith('待')) {
        footerActions.append(
          mkOpBtn('Confirm', 'cim-od-op-btn--confirm', () => doOrderOperations(data.orderId, ['confirm'], modal)),
          mkOpBtn('Confirm+Paid', 'cim-od-op-btn--confirm-paid', () => doOrderOperations(data.orderId, ['confirm', 'pay'], modal))
        );
      } else {
        const isConfirmed = sp.confirm && !sp.confirm.startsWith('待');
        if (isConfirmed && sp.payment?.startsWith('未')) {
          footerActions.appendChild(mkOpBtn('Pay', 'cim-od-op-btn--pay', () => doOrderOperations(data.orderId, ['pay'], modal)));
        }
        if (sp.payment?.startsWith('已') && sp.shipping?.startsWith('未')) {
          const shipBtn = mkOpBtn('Ship', 'cim-od-op-btn--ship', () => showDeleteConfirm(shipBtn, () => doOrderOperations(data.orderId, ['shiped'], modal), 'Confirm ship order 确认更改状态至 [已出货] ?'));
          footerActions.appendChild(shipBtn);
        }
      }
    }
  }

  function doOrderOperations(orderId, operations, modal) {
    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    const btns = footerActions ? [...footerActions.querySelectorAll('button')] : [];
    btns.forEach((b) => { b.disabled = true; });

    const runNext = (ops) => {
      if (!ops.length) {
        showOrderDetail(orderId);
        return;
      }
      const [op, ...rest] = ops;
      chrome.runtime.sendMessage({ type: 'ORDER_OPERATION', orderId, operation: op }, (res) => {
        if (!res?.ok) {
          btns.forEach((b) => { b.disabled = false; });
          showOrderDetailToast(modal, res?.error || `Operation "${op}" failed.`);
          return;
        }
        runNext(rest);
      });
    };
    runNext(operations);
  }

  function showOrderDetailToast(modal, msg) {
    let toast = modal.querySelector('.cim-od-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'cim-od-toast';
      const body = modal.querySelector('.cim-drawer-body');
      if (body) body.insertBefore(toast, body.firstChild);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { if (toast) toast.style.display = 'none'; }, 4000);
  }

  function showEditConsigneeDialog(modal, orderId, detailData) {
    modal._backAction = () => showOrderDetail(orderId);
    const body = modal.querySelector('.cim-drawer-body');
    body.innerHTML = '<div class="cim-drawer-loading">Loading form…</div>';
    modal.querySelector('.cim-drawer-title').textContent = 'Edit Recipient';
    modal.querySelector('.cim-drawer-subtitle').textContent = '';
    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    if (footerActions) footerActions.innerHTML = '';

    chrome.runtime.sendMessage({ type: 'GET_ORDER_CONSIGNEE', orderId }, (res) => {
      const liveModal = document.getElementById(ORDER_LIST_MODAL_ID);
      if (!liveModal) return;
      const liveBody = liveModal.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = `<div class="cim-drawer-error">${res?.error || 'Failed to load form.'}</div>`;
        return;
      }
      renderEditConsigneeForm(liveBody, liveModal, orderId, res.form, detailData);
    });
  }

  function renderEditConsigneeForm(body, modal, orderId, form, detailData) {
    body.innerHTML = '';

    function mkInput(val, placeholder) {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'cim-od-form-input';
      inp.value = val || '';
      if (placeholder) inp.placeholder = placeholder;
      return inp;
    }

    function mkTextarea(val, placeholder, rows) {
      const ta = document.createElement('textarea');
      ta.className = 'cim-od-form-textarea';
      ta.value = val || '';
      ta.rows = rows || 2;
      if (placeholder) ta.placeholder = placeholder;
      return ta;
    }

    function mkGroup(labelText, input) {
      const grp = document.createElement('div');
      grp.className = 'cim-od-form-group';
      const lbl = document.createElement('label');
      lbl.className = 'cim-od-form-label';
      lbl.textContent = labelText;
      grp.append(lbl, input);
      return grp;
    }

    const consigneeInp = mkInput(form.consignee, 'Required');
    const mobileInp = mkInput(form.mobile, 'Required');
    const emailInp = mkInput(form.email, 'Optional');
    const addressInp = mkTextarea(form.address, 'Required', 2);
    const postcodeInp = mkInput(form.regionCode, 'Postcode');
    const noteInp = mkTextarea(form.note, '', 2);
    const csNoteInp = mkTextarea(form.serviceNote, '', 2);

    body.append(
      mkGroup('Consignee *', consigneeInp),
      mkGroup('Mobile *', mobileInp),
      mkGroup('Email', emailInp),
      mkGroup('Address *', addressInp),
      mkGroup('Postcode *', postcodeInp),
      mkGroup('Order Note', noteInp),
      mkGroup('CS Note', csNoteInp)
    );

    const footerActions = modal.querySelector('.cim-ol-footer-actions');
    if (!footerActions) return;
    footerActions.innerHTML = '';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'cim-od-op-btn cim-od-op-btn--cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => renderOrderDetail(modal.querySelector('.cim-drawer-body'), modal, detailData));

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'cim-od-op-btn cim-od-op-btn--save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const consignee = consigneeInp.value.trim();
      const mobile = mobileInp.value.trim();
      const address = addressInp.value.trim();
      const regionCode = postcodeInp.value.trim();
      if (!consignee || !mobile || !address || !regionCode) {
        showOrderDetailToast(modal, 'Consignee, Mobile, Address and Postcode are required.');
        return;
      }
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      const payload = {
        consignee, mobile, address,
        regionCity: form.regionCity,
        regionArea: form.regionArea,
        regionCode,
      };
      if (form.regionCountry) payload.regionCountry = form.regionCountry;
      const email = emailInp.value.trim();
      if (email) payload.email = email;
      const note = noteInp.value.trim();
      if (note) payload.note = note;
      const serviceNote = csNoteInp.value.trim();
      if (serviceNote) payload.serviceNote = serviceNote;

      chrome.runtime.sendMessage({ type: 'UPDATE_ORDER_CONSIGNEE', orderId, data: payload }, (res) => {
        if (!res?.ok) {
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
          saveBtn.textContent = 'Save';
          showOrderDetailToast(modal, res?.error || 'Update failed.');
          return;
        }
        showOrderDetail(orderId);
      });
    });

    footerActions.append(cancelBtn, saveBtn);
  }

  // ── Parcel photo drawer ─────────────────────────────────────────────────────

  function ensureParcelDrawer() {
    if (document.getElementById(PARCEL_DRAWER_ID)) return document.getElementById(PARCEL_DRAWER_ID);

    const overlay = document.createElement('div');
    overlay.id = PARCEL_OVERLAY_ID;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeParcelDrawer(); });

    const modal = document.createElement('div');
    modal.id = PARCEL_DRAWER_ID;
    modal.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'cim-drawer-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cim-drawer-title-wrap';

    const title = document.createElement('span');
    title.className = 'cim-drawer-title';
    title.textContent = 'Parcel Photos';

    const subtitle = document.createElement('span');
    subtitle.className = 'cim-drawer-subtitle';

    titleWrap.append(title, subtitle);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cim-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeParcelDrawer);

    header.append(titleWrap, closeBtn);

    const drawerBody = document.createElement('div');
    drawerBody.className = 'cim-drawer-body';

    const footer = document.createElement('div');
    footer.className = 'cim-drawer-footer';
    const footerClose = document.createElement('button');
    footerClose.type = 'button';
    footerClose.className = 'cim-drawer-footer-close';
    footerClose.textContent = 'Close';
    footerClose.addEventListener('click', closeParcelDrawer);
    footer.appendChild(footerClose);

    modal.append(header, drawerBody, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('cim-parcel-overlay--visible')) {
        closeParcelDrawer();
      }
    });

    return modal;
  }

  function openParcelDrawer(orderId) {
    const modal = ensureParcelDrawer();
    const overlay = document.getElementById(PARCEL_OVERLAY_ID);
    const drawerBody = modal.querySelector('.cim-drawer-body');
    const titleEl = modal.querySelector('.cim-drawer-title');

    if (titleEl) titleEl.textContent = 'Parcel Photos';
    const subtitleElReset = modal.querySelector('.cim-drawer-subtitle');
    if (subtitleElReset) subtitleElReset.textContent = '';
    drawerBody.innerHTML = '<div class="cim-drawer-loading">Loading…</div>';
    overlay.classList.add('cim-parcel-overlay--visible');

    chrome.runtime.sendMessage({ type: 'GET_PARCEL_PHOTO_ORDER', orderId }, (res) => {
      const liveModal = document.getElementById(PARCEL_DRAWER_ID);
      if (!liveModal) return;
      const liveBody = liveModal.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = '<div class="cim-drawer-error">Failed to load photos.</div>';
        return;
      }
      renderDrawerContent(liveBody, liveModal, res, orderId);
    });
  }

  function closeParcelDrawer() {
    const overlay = document.getElementById(PARCEL_OVERLAY_ID);
    if (overlay) overlay.classList.remove('cim-parcel-overlay--visible');
  }

  function renderDrawerContent(body, modal, data, orderId) {
    body.innerHTML = '';

    if (!data.found || !data.orders || !data.orders.length) {
      const empty = document.createElement('div');
      empty.className = 'cim-drawer-empty';
      empty.textContent = 'No parcel photos found.';
      body.appendChild(empty);
      return;
    }

    const titleEl = modal.querySelector('.cim-drawer-title');
    if (titleEl) titleEl.textContent = data.orders[0].customerName || orderId;

    const subtitleEl = modal.querySelector('.cim-drawer-subtitle');
    if (subtitleEl) {
      const n = data.orders.filter((o) => o.trackingNumber).length;
      subtitleEl.textContent = `${n} parcel${n === 1 ? '' : 's'}`;
    }

    const singleWms = data.orders.length === 1;

    data.orders.forEach((wmsOrder, wmsIdx) => {
      const contentEls = buildWmsContent(wmsOrder);

      if (singleWms) {
        contentEls.forEach((el) => body.appendChild(el));
      } else {
        const section = document.createElement('div');
        section.className = 'cim-parcel-section';

        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'cim-parcel-section-header';

        const hasTracking = !!wmsOrder.trackingNumber;

        const sectionTitle = document.createElement('span');
        sectionTitle.className = 'cim-parcel-section-title' + (hasTracking ? '' : ' cim-parcel-section-title--no-tracking');
        sectionTitle.textContent = wmsOrder.wmsId || `Parcel ${wmsIdx + 1}`;

        const right = document.createElement('div');
        right.className = 'cim-parcel-section-right';

        if (!hasTracking) {
          const noTrackTag = document.createElement('span');
          noTrackTag.className = 'cim-parcel-no-tracking';
          noTrackTag.textContent = 'No tracking';
          right.appendChild(noTrackTag);
        }

        const cnt = wmsOrder.imageCount || 0;
        const countEl = document.createElement('span');
        countEl.className = 'cim-parcel-section-count';
        countEl.textContent = `${cnt} photo${cnt === 1 ? '' : 's'}`;

        const chevron = document.createElement('span');
        chevron.className = 'cim-parcel-section-chevron';
        chevron.textContent = '▸';

        right.append(countEl, chevron);
        sectionHeader.append(sectionTitle, right);

        const sectionBody = document.createElement('div');
        sectionBody.className = 'cim-parcel-section-body';
        contentEls.forEach((el) => sectionBody.appendChild(el));

        // First parcel open by default
        if (wmsIdx === 0) {
          sectionBody.style.display = 'flex';
          chevron.style.transform = 'rotate(90deg)';
        }

        sectionHeader.addEventListener('click', () => {
          const open = sectionBody.style.display === 'none' || sectionBody.style.display === '';
          sectionBody.style.display = open ? 'flex' : 'none';
          chevron.style.transform = open ? 'rotate(90deg)' : '';
        });

        section.append(sectionHeader, sectionBody);
        body.appendChild(section);
      }
    });
  }

  function buildWmsContent(wmsOrder) {
    const els = [];

    // Info card
    const card = document.createElement('div');
    card.className = 'cim-drawer-info-card';

    const fields = [
      ['Customer', wmsOrder.customerName, false],
      ['WMS ID', wmsOrder.wmsId, false],
      ['ERP ID', wmsOrder.erpId, false],
      ['EC2 Order', wmsOrder.ec2OrderId, true],
      ['Task ID', wmsOrder.taskId, false],
      ['Tracking', wmsOrder.trackingNumber || null, false, !wmsOrder.trackingNumber],
    ];

    fields.forEach(([label, value, isLink, noTracking]) => {
      if (!value && !noTracking) return;
      const row = document.createElement('div');
      row.className = 'cim-drawer-info-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'cim-drawer-info-label';
      labelEl.textContent = label;
      let valueEl;
      if (isLink) {
        valueEl = document.createElement('a');
        valueEl.href = `https://ddherbs.com.my/track/${value}`;
        valueEl.target = '_blank';
        valueEl.rel = 'noopener noreferrer';
        valueEl.className = 'cim-drawer-info-value cim-drawer-info-value--link';
        valueEl.appendChild(document.createTextNode(value));
        const icon = document.createElement('span');
        icon.className = 'cim-drawer-ext-icon';
        icon.textContent = ' ↗';
        valueEl.appendChild(icon);
      } else if (noTracking) {
        valueEl = document.createElement('span');
        valueEl.className = 'cim-drawer-info-value cim-drawer-info-value--no-tracking';
        valueEl.textContent = 'No tracking number';
      } else {
        valueEl = document.createElement('span');
        valueEl.className = 'cim-drawer-info-value';
        valueEl.textContent = value;
      }
      row.append(labelEl, valueEl);
      card.appendChild(row);
    });

    els.push(card);

    // Meta: ⏱ time · uploader
    if (wmsOrder.lastPhotoAt || wmsOrder.createdBy) {
      const meta = document.createElement('div');
      meta.className = 'cim-drawer-meta';
      const parts = [];
      if (wmsOrder.lastPhotoAt) {
        const d = new Date(wmsOrder.lastPhotoAt);
        const h = d.getHours(), m = d.getMinutes();
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 || 12;
        parts.push(`${h12}:${String(m).padStart(2, '0')} ${ampm}`);
      }
      if (wmsOrder.createdBy) parts.push(wmsOrder.createdBy);
      meta.appendChild(document.createTextNode('⏱ ' + parts.join(' · ')));
      els.push(meta);
    }

    // Photo sections
    const allImages = wmsOrder.images || [];
    if (!allImages.length) {
      const noPhotos = document.createElement('div');
      noPhotos.className = 'cim-drawer-no-photos';
      noPhotos.textContent = 'No photos yet.';
      els.push(noPhotos);
    } else {
      const KINDS = [
        { kind: 'internal', badge: 'Internal', desc: '内部存档', cls: 'cim-drawer-badge--internal' },
        { kind: 'customer', badge: 'Customer', desc: '客户可见', cls: 'cim-drawer-badge--customer' },
        { kind: null,       badge: 'Other',    desc: '',         cls: 'cim-drawer-badge--other' },
      ];

      KINDS.forEach(({ kind, badge, desc, cls }) => {
        const kindPhotos = allImages.filter((img) => img.kind === kind);
        if (!kindPhotos.length) return;

        const section = document.createElement('div');
        section.className = 'cim-drawer-kind-section';

        const kindHeader = document.createElement('div');
        kindHeader.className = 'cim-drawer-kind-header';

        const badgeEl = document.createElement('span');
        badgeEl.className = `cim-drawer-badge ${cls}`;
        badgeEl.textContent = badge;

        const kindDesc = document.createElement('span');
        kindDesc.className = 'cim-drawer-kind-desc';
        kindDesc.textContent = (desc ? desc + ' · ' : '') + kindPhotos.length;

        kindHeader.append(badgeEl, kindDesc);
        section.appendChild(kindHeader);

        const grid = document.createElement('div');
        grid.className = 'cim-drawer-photo-grid';

        kindPhotos.forEach((img) => {
          const thumb = document.createElement('div');
          thumb.className = 'cim-drawer-thumb';
          const imgEl = document.createElement('img');
          imgEl.src = img.url;
          imgEl.alt = '';
          imgEl.loading = 'lazy';
          thumb.appendChild(imgEl);
          thumb.addEventListener('click', () => {
            const startIdx = allImages.findIndex((i) => i.id === img.id);
            openGalleryModal(allImages, startIdx >= 0 ? startIdx : 0);
          });
          grid.appendChild(thumb);
        });

        section.appendChild(grid);
        els.push(section);
      });
    }

    return els;
  }

  // ── Gallery / lightbox modal ────────────────────────────────────────────────

  function buildGalleryModal() {
    const modal = document.createElement('div');
    modal.id = GALLERY_MODAL_ID;
    modal.addEventListener('click', (e) => {
      if (!e.target.closest('button, img, .cim-gallery-thumbs')) closeGalleryModal();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cim-gallery-close';
    closeBtn.setAttribute('aria-label', 'Close gallery');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeGalleryModal);

    const counter = document.createElement('div');
    counter.className = 'cim-gallery-counter';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'cim-gallery-nav cim-gallery-nav--prev';
    prevBtn.setAttribute('aria-label', 'Previous');
    prevBtn.textContent = '‹';
    prevBtn.addEventListener('click', () => galleryStep(-1));

    const mainArea = document.createElement('div');
    mainArea.className = 'cim-gallery-main';
    const mainImg = document.createElement('img');
    mainImg.className = 'cim-gallery-img';
    mainImg.alt = '';
    mainArea.appendChild(mainImg);

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'cim-gallery-nav cim-gallery-nav--next';
    nextBtn.setAttribute('aria-label', 'Next');
    nextBtn.textContent = '›';
    nextBtn.addEventListener('click', () => galleryStep(1));

    const caption = document.createElement('div');
    caption.className = 'cim-gallery-caption';

    const thumbStrip = document.createElement('div');
    thumbStrip.className = 'cim-gallery-thumbs';

    modal.append(closeBtn, counter, prevBtn, mainArea, nextBtn, caption, thumbStrip);
    document.body.appendChild(modal);
    return modal;
  }

  function openGalleryModal(images, startIndex) {
    galleryImages = images;
    galleryIndex = startIndex;

    let modal = document.getElementById(GALLERY_MODAL_ID);
    if (!modal) modal = buildGalleryModal();

    modal.classList.add('cim-gallery-modal--open');
    renderGalleryImage(modal);
    renderGalleryThumbs(modal);

    modal._onKeyDown = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); galleryStep(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); galleryStep(1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeGalleryModal(); }
    };
    document.addEventListener('keydown', modal._onKeyDown, true);
  }

  function closeGalleryModal() {
    const modal = document.getElementById(GALLERY_MODAL_ID);
    if (!modal) return;
    modal.classList.remove('cim-gallery-modal--open');
    if (modal._onKeyDown) {
      document.removeEventListener('keydown', modal._onKeyDown, true);
      modal._onKeyDown = null;
    }
  }

  function galleryStep(dir) {
    if (!galleryImages.length) return;
    galleryIndex = (galleryIndex + dir + galleryImages.length) % galleryImages.length;
    const modal = document.getElementById(GALLERY_MODAL_ID);
    if (!modal) return;
    renderGalleryImage(modal);
    renderGalleryThumbs(modal);
  }

  function renderGalleryImage(modal) {
    const img = modal.querySelector('.cim-gallery-img');
    if (img && galleryImages[galleryIndex]) img.src = galleryImages[galleryIndex].url;
    const counter = modal.querySelector('.cim-gallery-counter');
    if (counter) counter.textContent = `${galleryIndex + 1} / ${galleryImages.length}`;
    const single = galleryImages.length <= 1;
    const prev = modal.querySelector('.cim-gallery-nav--prev');
    const next = modal.querySelector('.cim-gallery-nav--next');
    if (prev) prev.style.display = single ? 'none' : '';
    if (next) next.style.display = single ? 'none' : '';
    const caption = modal.querySelector('.cim-gallery-caption');
    if (caption) caption.textContent = galleryImages[galleryIndex]?.label || '';
  }

  function renderGalleryThumbs(modal) {
    const strip = modal.querySelector('.cim-gallery-thumbs');
    if (!strip) return;
    strip.innerHTML = '';
    galleryImages.forEach((img, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'cim-gallery-thumb' + (i === galleryIndex ? ' cim-gallery-thumb--active' : '');
      const imgEl = document.createElement('img');
      imgEl.src = img.url;
      imgEl.alt = '';
      imgEl.loading = 'lazy';
      thumb.appendChild(imgEl);
      thumb.addEventListener('click', () => {
        galleryIndex = i;
        renderGalleryImage(modal);
        renderGalleryThumbs(modal);
      });
      strip.appendChild(thumb);
    });
    const active = strip.querySelector('.cim-gallery-thumb--active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
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
        const { row: rankRow } = addSummaryRow('Rank', formatValue(data.rank));
        rankRow.classList.add('cim-summary-row--full');

        const { row: addrRow, valueEl: addrEl } = addSummaryRow('Address', formatValue(data.address), 'cim-summary-value--address');
        addrRow.classList.add('cim-summary-row--full');
        if (data.address !== null && data.address !== undefined && data.address !== '') {
          addrEl.textContent = '';
          addrEl.append(String(data.address), buildCopyButton(data.address));
        }

        body.appendChild(summary);

        if (cartSessionValid && sessionState.cartHasItems === true) {
          body.appendChild(buildCartSection(view.psid, { myrSum: sessionState.myrSum, sgdSum: sessionState.sgdSum }));
        } else if (cartSessionValid && sessionState.cartHasItems === false) {
          const emptyEl = document.createElement('div');
          emptyEl.className = 'cim-cart-empty';
          emptyEl.textContent = '🛒 Empty Cart';
          body.appendChild(emptyEl);
        }

        const heading = document.createElement('div');
        heading.className = 'cim-orders-heading';

        const headingBtn = document.createElement('button');
        headingBtn.type = 'button';
        headingBtn.className = 'cim-orders-heading-btn';
        headingBtn.textContent = 'Recent Orders ↗';
        headingBtn.addEventListener('click', () => openOrderListModal(view.psid, data.allOrders));
        heading.appendChild(headingBtn);
        body.appendChild(heading);

        const ordersSection = document.createElement('div');
        ordersSection.className = 'cim-recent-orders-section';
        body.appendChild(ordersSection);
        renderRecentOrdersInPanel(data.recentOrders);
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
      fetchAndRenderManyChatInfo(uid, psid);
    });
  }

  function renderManyChatInfoRows(info) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || sessionState.view?.type !== 'orders') return;

    renderLangTags(panel, info.tags || [], sessionState.view?.psid);

    const summary = panel.querySelector('.cim-summary');
    if (!summary) return;

    const addInfoRow = (labelText, val) => {
      const row = document.createElement('div');
      row.className = 'cim-summary-row cim-summary-row--full';
      const label = document.createElement('span');
      label.className = 'cim-summary-label';
      label.textContent = labelText;
      const value = document.createElement('span');
      value.className = 'cim-summary-value';
      value.append(val, buildCopyButton(val));
      row.append(label, value);
      summary.appendChild(row);
    };

    if (info.phone) addInfoRow('Phone', info.phone);
    if (info.email) addInfoRow('Email', info.email);
    if (info.whatsappPhone) addInfoRow('WhatsApp', info.whatsappPhone);
  }

  function fetchAndRenderManyChatInfo(uid, psid) {
    if (sessionState.manychatInfo) {
      renderManyChatInfoRows(sessionState.manychatInfo);
      return;
    }

    chrome.runtime.sendMessage({ type: 'GET_MANYCHAT_INFO', psid }, (response) => {
      if (getUserIdFromUrl() !== uid) return;
      if (chrome.runtime.lastError || !response || !response.ok) return;

      sessionState.manychatInfo = response;
      renderManyChatInfoRows(response);
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
      if (sessionState.view.type === 'orders' && sessionState.manychatInfo) {
        fetchAndRenderManyChatInfo(sessionState.uid, sessionState.view.psid);
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
      sessionState = { uid, name: null, resolved: false, view: null, cartHasItems: null, expiredAvailable: null, myrSum: null, sgdSum: null, manychatInfo: null };
      aiPreviousText = '';
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

  function syncCloseBtnVisibility() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !panelPosition) return;
    panel.classList.toggle('cim-sidebar-visible', !!findContactDetailsAnchor());
  }

  function scheduleCheck() {
    syncCloseBtnVisibility();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { check(); ensureAiButtons(); updateAiButtonState(); }, DEBOUNCE_MS);
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
