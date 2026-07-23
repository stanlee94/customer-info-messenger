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

  // ── Parcel photo drawer ─────────────────────────────────────────────────────

  function ensureParcelDrawer() {
    if (document.getElementById(PARCEL_DRAWER_ID)) return document.getElementById(PARCEL_DRAWER_ID);

    const overlay = document.createElement('div');
    overlay.id = PARCEL_OVERLAY_ID;
    overlay.addEventListener('click', closeParcelDrawer);
    document.body.appendChild(overlay);

    const drawer = document.createElement('div');
    drawer.id = PARCEL_DRAWER_ID;

    const header = document.createElement('div');
    header.className = 'cim-drawer-header';

    const title = document.createElement('span');
    title.className = 'cim-drawer-title';
    title.textContent = '📦 Parcel Photos';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cim-drawer-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', closeParcelDrawer);

    header.append(title, closeBtn);

    const drawerBody = document.createElement('div');
    drawerBody.className = 'cim-drawer-body';

    drawer.append(header, drawerBody);
    document.body.appendChild(drawer);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('cim-parcel-drawer--open')) {
        closeParcelDrawer();
      }
    });

    return drawer;
  }

  function openParcelDrawer(orderId) {
    const drawer = ensureParcelDrawer();
    const overlay = document.getElementById(PARCEL_OVERLAY_ID);
    const drawerBody = drawer.querySelector('.cim-drawer-body');

    drawerBody.innerHTML = '<div class="cim-drawer-loading">Loading…</div>';
    overlay.classList.add('cim-parcel-overlay--visible');
    drawer.classList.add('cim-parcel-drawer--open');

    chrome.runtime.sendMessage({ type: 'GET_PARCEL_PHOTO_ORDER', orderId }, (res) => {
      const liveDrawer = document.getElementById(PARCEL_DRAWER_ID);
      if (!liveDrawer) return;
      const liveBody = liveDrawer.querySelector('.cim-drawer-body');
      if (!res?.ok) {
        liveBody.innerHTML = '<div class="cim-drawer-error">Failed to load photos.</div>';
        return;
      }
      renderDrawerContent(liveBody, res, orderId);
    });
  }

  function closeParcelDrawer() {
    const drawer = document.getElementById(PARCEL_DRAWER_ID);
    const overlay = document.getElementById(PARCEL_OVERLAY_ID);
    if (drawer) drawer.classList.remove('cim-parcel-drawer--open');
    if (overlay) overlay.classList.remove('cim-parcel-overlay--visible');
  }

  function renderDrawerContent(body, data, orderId) {
    body.innerHTML = '';

    if (!data.found || !data.orders || !data.orders.length) {
      const empty = document.createElement('div');
      empty.className = 'cim-drawer-empty';
      empty.textContent = 'No parcel photos found.';
      body.appendChild(empty);
      return;
    }

    const orderIdEl = document.createElement('div');
    orderIdEl.className = 'cim-drawer-order-id';
    orderIdEl.textContent = orderId;
    body.appendChild(orderIdEl);

    data.orders.forEach((wmsOrder, wmsIdx) => {
      const group = document.createElement('div');
      group.className = 'cim-drawer-wms-group';

      const wmsHeader = document.createElement('div');
      wmsHeader.className = 'cim-drawer-wms-header';

      const wmsIdEl = document.createElement('span');
      wmsIdEl.className = 'cim-drawer-wms-id';
      wmsIdEl.textContent = wmsOrder.wmsId || `WMS #${wmsIdx + 1}`;

      const countEl = document.createElement('span');
      countEl.className = 'cim-drawer-wms-count';
      const cnt = wmsOrder.imageCount || 0;
      countEl.textContent = `${cnt} photo${cnt === 1 ? '' : 's'}`;

      wmsHeader.append(wmsIdEl, countEl);
      group.appendChild(wmsHeader);

      const meta = document.createElement('div');
      meta.className = 'cim-drawer-meta';
      const addChip = (text, muted) => {
        const chip = document.createElement('span');
        chip.className = 'cim-drawer-chip' + (muted ? ' cim-drawer-chip--muted' : '');
        chip.textContent = text;
        meta.appendChild(chip);
      };
      if (wmsOrder.taskId) addChip('TASK: ' + wmsOrder.taskId, false);
      if (wmsOrder.trackingNumber) addChip('📦 ' + wmsOrder.trackingNumber, false);
      if (wmsOrder.createdBy) addChip('👤 ' + wmsOrder.createdBy, true);
      if (wmsOrder.lastPhotoAt) {
        const d = new Date(wmsOrder.lastPhotoAt);
        addChip(`🕐 ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`, true);
      }
      group.appendChild(meta);

      const allImages = wmsOrder.images || [];

      if (!allImages.length) {
        const noPhotos = document.createElement('div');
        noPhotos.className = 'cim-drawer-no-photos';
        noPhotos.textContent = 'No photos yet.';
        group.appendChild(noPhotos);
      } else {
        ['internal', 'customer', null].forEach((kind) => {
          const kindPhotos = allImages.filter((img) => img.kind === kind);
          if (!kindPhotos.length) return;

          const section = document.createElement('div');
          section.className = 'cim-drawer-kind-section';

          const label = document.createElement('div');
          label.className = 'cim-drawer-kind-label';
          label.textContent = kind === 'internal' ? '内部存档 Internal'
            : kind === 'customer' ? '客户可见 Customer'
            : 'Other';
          section.appendChild(label);

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
          group.appendChild(section);
        });
      }

      body.appendChild(group);
    });
  }

  // ── Gallery / lightbox modal ────────────────────────────────────────────────

  function buildGalleryModal() {
    const modal = document.createElement('div');
    modal.id = GALLERY_MODAL_ID;
    modal.addEventListener('click', (e) => { if (e.target === modal) closeGalleryModal(); });

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

    const thumbStrip = document.createElement('div');
    thumbStrip.className = 'cim-gallery-thumbs';

    modal.append(closeBtn, counter, prevBtn, mainArea, nextBtn, thumbStrip);
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
      if (e.key === 'ArrowLeft') { e.preventDefault(); galleryStep(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); galleryStep(1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeGalleryModal(); }
    };
    document.addEventListener('keydown', modal._onKeyDown);
  }

  function closeGalleryModal() {
    const modal = document.getElementById(GALLERY_MODAL_ID);
    if (!modal) return;
    modal.classList.remove('cim-gallery-modal--open');
    if (modal._onKeyDown) {
      document.removeEventListener('keydown', modal._onKeyDown);
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
            idEl.dataset.orderId = order.orderId || '';
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

            chrome.runtime.sendMessage({ type: 'CHECK_PARCEL_PHOTOS', orderIds }, (photoRes) => {
              if (getUserIdFromUrl() !== capturedUid) return;
              if (!photoRes?.ok || !photoRes.results) return;
              const livePanel = document.getElementById(PANEL_ID);
              if (!livePanel) return;
              Object.entries(photoRes.results).forEach(([orderId, info]) => {
                if (!info.hasPhotos) return;
                const idEl = livePanel.querySelector(`.cim-order-id[data-order-id="${CSS.escape(orderId)}"]`);
                if (!idEl) return;
                const wrap = idEl.closest('.cim-order-id-wrap');
                if (!wrap || wrap.querySelector('.cim-photo-icon')) return;
                wrap.appendChild(buildPhotoIconBtn(orderId));
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
