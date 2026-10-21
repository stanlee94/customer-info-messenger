const MANYCHAT_API_BASE = 'https://api.manychat.com';
const CART_API_BASE = 'https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest';
const ORDER_STATUS_API_BASE = 'https://7n881aguj8.execute-api.ap-southeast-1.amazonaws.com';

importScripts('notes-baserow.js', 'voice-transcribe.js');

// Let content scripts read/write chrome.storage.session (default is
// trusted-contexts only). Used for browser-session prefs like the cart's
// Simple/Adv mode. Top-level so it runs on every service-worker start.
try {
  chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* older Chrome — content falls back to in-memory */ }

// EC2 live overlay (ec2-live.js/.css) is opt-in: registered as a dynamic
// content script only while `ec2LiveEnabled` is true in the options page.
// Not in manifest.json on purpose — its CSS restyles EC2's own page, so it
// must not load at all when off. Calls are chained so a quick on/off/on
// never races into a double register.
const EC2_LIVE_SCRIPT_ID = 'ec2-live';
const EC2_LIVE_MAIN_SCRIPT_ID = 'ec2-live-main';
const EC2_LIVE_FBFRAME_SCRIPT_ID = 'ec2-live-fbframe';
let ec2LiveSync = Promise.resolve();
function syncEc2LiveOverlay() {
  ec2LiveSync = ec2LiveSync.then(async () => {
    const { ec2LiveEnabled } = await chrome.storage.local.get('ec2LiveEnabled');
    // ec2-live: the overlay (isolated world). ec2-live-main: the late-comment
    // fix inside living.js's own comment poll (MAIN world, see that file).
    // ec2-live-fbframe: inside EC2's Facebook video plugin iframe, hides
    // Facebook's frozen LIVE/viewer badge under our 5 s one (see that file).
    const scripts = [{
      id: EC2_LIVE_SCRIPT_ID,
      matches: ['https://ec2.full2house.com/Ent/index.php*'],
      js: ['ec2-live.js'],
      css: ['ec2-live.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }, {
      id: EC2_LIVE_MAIN_SCRIPT_ID,
      matches: ['https://ec2.full2house.com/Ent/index.php*'],
      js: ['ec2-live-main.js'],
      runAt: 'document_idle',
      world: 'MAIN',
      persistAcrossSessions: true,
    }, {
      id: EC2_LIVE_FBFRAME_SCRIPT_ID,
      matches: ['https://www.facebook.com/plugins/video.php*'],
      js: ['ec2-live-fbframe.js'],
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: true,
    }];
    const ids = scripts.map((x) => x.id);
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids })).map((x) => x.id);
    if (ec2LiveEnabled === true) {
      const missing = scripts.filter((x) => !registered.includes(x.id));
      if (missing.length) await chrome.scripting.registerContentScripts(missing);
    } else if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: registered });
    }
  }).catch((e) => console.warn('[ec2-live] sync failed', e));
  return ec2LiveSync;
}
chrome.runtime.onInstalled.addListener(syncEc2LiveOverlay);
chrome.runtime.onStartup.addListener(syncEc2LiveOverlay);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'ec2LiveEnabled' in changes) syncEc2LiveOverlay();
});

function getAiHealth() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['aiApiUrl', 'aiApiToken'], ({ aiApiUrl, aiApiToken }) => {
      if (!aiApiUrl) { resolve({ ok: false }); return; }
      const headers = {};
      if (aiApiToken) headers['Authorization'] = `Bearer ${aiApiToken}`;
      fetch(`${aiApiUrl}/ai/health`, { headers })
        .then((res) => res.json())
        .then((json) => resolve({ ok: json?.ok === true }))
        .catch(() => resolve({ ok: false }));
    });
  });
}

function getAiReply(messages, mode, language) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['aiApiUrl', 'aiApiToken'], ({ aiApiUrl, aiApiToken }) => {
      if (!aiApiUrl) {
        resolve({ ok: false, error: 'AI API URL not configured. Set it in extension options.' });
        return;
      }

      const headers = { 'Content-Type': 'application/json' };
      if (aiApiToken) headers['Authorization'] = `Bearer ${aiApiToken}`;

      fetch(`${aiApiUrl}/ai/reply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages, mode, language }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`AI API error: ${res.status}`);
          return res.json();
        })
        .then((json) => {
          if (!json.ok || typeof json.text !== 'string') {
            throw new Error(json.error || 'Unexpected AI API response.');
          }
          resolve({ ok: true, text: json.text });
        })
        .catch((err) => resolve({ ok: false, error: err.message }));
    });
  });
}

function searchManyChatByName(name) {
  return new Promise((resolve) => {
    chrome.storage.local.get('manychatToken', ({ manychatToken }) => {
      if (!manychatToken) {
        resolve({
          ok: false,
          error: 'ManyChat API token not set - configure it in the extension options.',
        });
        return;
      }

      fetch(`${MANYCHAT_API_BASE}/fb/subscriber/findByName?name=${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${manychatToken}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error(`ManyChat API error: ${res.status}`);
          return res.json();
        })
        .then((json) => {
          const subscribers = Array.isArray(json?.data)
            ? json.data
            : json?.data
              ? [json.data]
              : [];

          resolve({
            ok: true,
            candidates: subscribers
              .map((s) => ({
                psid: String(s.id),
                name: s.name || `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim(),
                profilePic: s.profile_pic || '',
                lastMessage: s.last_input_text || '',
                lastInteraction: s.last_interaction || '',
              }))
              .sort((a, b) => new Date(b.lastInteraction) - new Date(a.lastInteraction)),
          });
        })
        .catch((err) => resolve({ ok: false, error: err.message }));
    });
  });
}

function getManyChatInfo(psid) {
  return new Promise((resolve) => {
    chrome.storage.local.get('manychatToken', ({ manychatToken }) => {
      if (!manychatToken) {
        resolve({ ok: false, error: 'ManyChat API token not set.' });
        return;
      }

      fetch(`${MANYCHAT_API_BASE}/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(psid)}`, {
        headers: { Authorization: `Bearer ${manychatToken}` },
      })
        .then((res) => {
          if (!res.ok) throw new Error(`ManyChat API error: ${res.status}`);
          return res.json();
        })
        .then((json) => {
          const d = json?.data;
          resolve({
            ok: true,
            phone: d?.phone || null,
            email: d?.email || null,
            whatsappPhone: d?.whatsapp_phone || null,
            tags: Array.isArray(d?.tags) ? d.tags.map((t) => ({ id: t.id, name: t.name })) : [],
          });
        })
        .catch((err) => resolve({ ok: false, error: err.message }));
    });
  });
}

function manyChatTagAction(action, psid, tagId) {
  return new Promise((resolve) => {
    chrome.storage.local.get('manychatToken', ({ manychatToken }) => {
      if (!manychatToken) {
        resolve({ ok: false, error: 'ManyChat API token not set.' });
        return;
      }

      const endpoint = action === 'add' ? 'addTag' : 'removeTag';
      fetch(`${MANYCHAT_API_BASE}/fb/subscriber/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${manychatToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ subscriber_id: psid, tag_id: tagId }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`ManyChat API error: ${res.status}`);
          return res.json();
        })
        .then(() => resolve({ ok: true }))
        .catch((err) => resolve({ ok: false, error: err.message }));
    });
  });
}

function checkSession() {
  return fetch(`${CART_API_BASE}/checkSession`)
    .then((res) => res.json().then((json) => ({ ok: true, valid: res.ok && json?.status === 'ok' })))
    // ok:false = network failure — distinguishable from a genuinely dead
    // session so the content script can retry instead of hiding the cart
    // features for the whole tab session.
    .catch(() => ({ ok: false, valid: false }));
}

function getCartSummary(psid, option) {
  return fetch(`${CART_API_BASE}/users/${encodeURIComponent(psid)}?option=${encodeURIComponent(option)}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Cart API error: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const text = json?.content?.messages?.[0]?.text;
      if (typeof text !== 'string') throw new Error('Unexpected cart API response.');
      return { ok: true, text, expiredAvailable: json.expiredAvailable === true, myrSum: json.myrSum ?? null, sgdSum: json.sgdSum ?? null };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

function getSelectedCartSummary(psid, recIds, option) {
  return fetch(`${CART_API_BASE}/users/${encodeURIComponent(psid)}/selected`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recIds, option }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Cart API error: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const text = json?.content?.messages?.[0]?.text;
      if (typeof text !== 'string') throw new Error('Unexpected cart API response.');
      return { ok: true, text, expiredAvailable: json.expiredAvailable === true, myrSum: json.myrSum ?? null, sgdSum: json.sgdSum ?? null, matched: json.matched || [], missing: json.missing || [] };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

function checkParcelPhotos(orderIds) {
  if (!orderIds.length) return Promise.resolve({ ok: true, results: {} });
  return fetch(`${CART_API_BASE}/parcelPhotos/check?ids=${encodeURIComponent(orderIds.join(','))}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Parcel photos API error: ${res.status}`);
      return res.json();
    })
    .then((json) => ({ ok: true, results: json.results || {} }))
    .catch((err) => ({ ok: false, error: err.message }));
}

function getCartItems(psid) {
  return fetch(`${CART_API_BASE}/api/cart?fbUserId=${encodeURIComponent(psid)}`)
    .then((res) => res.json())
    .then((json) => {
      if (!json.ok) return { ok: false, error: json.msg || 'Failed to load cart.' };
      return { ok: true, items: json.items || [], userId: json.userId, ecUserId: json.ecUserId };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

function deleteCartItems(recIds) {
  return fetch(`${CART_API_BASE}/api/cart/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recIds }),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Delete failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function refreshCartValidity(recIds) {
  return fetch(`${CART_API_BASE}/api/cart/refresh-validity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recIds }),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Renew failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function updateCartQty(recId, qty) {
  return fetch(`${CART_API_BASE}/api/cart/quantity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recId, qty }),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Update qty failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function addCartItem(fbUserId, goodsId, qty) {
  return fetch(`${CART_API_BASE}/api/cart/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fbUserId, goodsId, qty }),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Add to cart failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function searchGoods(keyword, page) {
  const params = new URLSearchParams({ page: String(page) });
  if (keyword) params.set('keyword', keyword);
  return fetch(`${CART_API_BASE}/api/goods?${params}`)
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true, result: json.result } : { ok: false, error: json.msg || 'Search failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function smartSearchGoods(words) {
  return fetch(`${CART_API_BASE}/api/goods/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words }),
  })
    .then((res) => res.json())
    .then((json) => json.ok
      ? { ok: true, items: json.items || [], total: json.total || 0 }
      : { ok: false, error: json.msg || 'Search failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function listLives(page, name) {
  const params = new URLSearchParams({ page: String(page || 1) });
  if (name) params.set('name', name);
  return fetch(`${CART_API_BASE}/api/lives?${params}`)
    .then((res) => res.json())
    .then((json) => json.ok
      ? { ok: true, page: json.page || 1, lastPage: json.lastPage || 1, lives: json.lives || [] }
      : { ok: false, error: json.msg || 'Failed to load lives.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

// Per-item ledger contract (live-code-per-item-explained.md): once the ledger
// exists the route always answers 200 ok:true — item failures live inside
// results[].status, never in the HTTP status. ok:false only means input
// validation or a failed session heal, i.e. nothing was attempted.
function addCartItemsByCode(liveId, fbUserId, items) {
  return fetch(`${CART_API_BASE}/api/cart/items-by-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liveId, fbUserId, items }),
  })
    .then((res) => res.json())
    .then((json) => json.ok
      ? { ok: true, summary: json.summary || null, results: json.results || [], warning: json.warning || null, cart: json.cart || null }
      : { ok: false, error: json.msg || 'Add by code failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function copyCart(fbUserId, sourceFbUserId, dryRun, includeExpired, mergeDuplicates) {
  const body = { fbUserId, sourceFbUserId };
  if (dryRun) body.dryRun = true;
  if (includeExpired) body.includeExpired = true;
  if (mergeDuplicates) body.mergeDuplicates = true;
  return fetch(`${CART_API_BASE}/api/cart/copy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => res.json())
    .then((json) => {
      if (!json.ok) return { ok: false, error: json.msg || 'Copy failed.' };
      return { ok: true, added: json.added || [], skipped: json.skipped || [], failed: json.failed || [], cart: json.cart || null };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

function fetchOrderList(psid) {
  return fetch(`${CART_API_BASE}/api/orders?fbUserId=${encodeURIComponent(psid)}&newStatus=0&noCancel=on`)
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true, orders: json.orders } : { ok: false, error: json.msg || 'Failed to load orders.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function getOrderDetail(orderId) {
  return fetch(`${CART_API_BASE}/api/orders/${encodeURIComponent(orderId)}`)
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true, ...json } : { ok: false, error: json.msg || 'Failed to load order.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function getOrderConsignee(orderId) {
  return fetch(`${CART_API_BASE}/api/orders/${encodeURIComponent(orderId)}/consignee`)
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true, form: json.form } : { ok: false, error: json.msg || 'Failed to load consignee form.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function updateOrderConsignee(orderId, data) {
  return fetch(`${CART_API_BASE}/api/orders/${encodeURIComponent(orderId)}/consignee`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Update failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function orderOperation(orderId, operation) {
  return fetch(`${CART_API_BASE}/api/orders/${encodeURIComponent(orderId)}/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation }),
  })
    .then((res) => res.json())
    .then((json) => json.ok ? { ok: true } : { ok: false, error: json.msg || 'Operation failed.' })
    .catch((err) => ({ ok: false, error: err.message }));
}

function getParcelPhotoOrder(orderId) {
  return fetch(`${CART_API_BASE}/parcelPhotos/order/${encodeURIComponent(orderId)}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Parcel photos API error: ${res.status}`);
      return res.json();
    })
    .then((json) => ({ ok: true, ...json }))
    .catch((err) => ({ ok: false, error: err.message }));
}

function getCheckoutForm(fbUserId, userId, recIds, goodsNumbers) {
  const params = new URLSearchParams({
    fbUserId,
    userId: String(userId || ''),
    recIds: recIds.join(','),
    goodsNumbers: goodsNumbers.join(','),
  });
  return fetch(`${CART_API_BASE}/api/checkout?${params}`)
    .then((res) => res.json())
    .then((json) => (json.ok ? { ok: true, customer: json.customer } : { ok: false, error: json.msg || 'Failed to load checkout.' }))
    .catch((err) => ({ ok: false, error: err.message }));
}

function createOrder(fbUserId, userId, items, customer, shippingIdType, confirm, pay, note) {
  const body = { fbUserId, userId, items, customer, shippingIdType, confirm, pay };
  if (note) body.note = note; // → EC2 create-order info[note] (order 备注)
  return fetch(`${CART_API_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => res.json())
    .then((json) =>
      json.ok
        ? { ok: true, orderId: json.orderId, orderSn: json.orderSn, status: json.status, via: json.via }
        : { ok: false, error: json.msg || 'Order creation failed.' }
    )
    .catch((err) => ({ ok: false, error: err.message }));
}

function orderAdjustment(orderId, price, type, note) {
  const body = { price, type };
  if (note) body.note = note;
  return fetch(`${CART_API_BASE}/api/orders/${encodeURIComponent(orderId)}/adjustments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => res.json())
    .then((json) => (json.ok ? { ok: true } : { ok: false, error: json.msg || 'Adjustment failed.' }))
    .catch((err) => ({ ok: false, error: err.message }));
}

function getRegionAreas(stateId) {
  return fetch(`${CART_API_BASE}/api/regions/areas?stateId=${encodeURIComponent(stateId)}`)
    .then((res) => res.json())
    .then((json) => (json.ok ? { ok: true, areas: json.areas || [] } : { ok: false, error: json.msg || 'Failed to load areas.' }))
    .catch((err) => ({ ok: false, error: err.message }));
}

function getRegionPostcode(areaId) {
  return fetch(`${CART_API_BASE}/api/regions/postcode?areaId=${encodeURIComponent(areaId)}`)
    .then((res) => res.json())
    .then((json) => (json.ok ? { ok: true, postcode: json.postcode } : { ok: false, error: json.msg || 'Failed to load postcode.' }))
    .catch((err) => ({ ok: false, error: err.message }));
}

// qianyi-api-query answers /orders/:ids with real ERP data only for this
// background script: it recognises Chrome's Sec-Fetch-Site: none +
// Sec-Fetch-Mode: cors here (no Origin is sent) and signs the ERP query
// (deployed 2026-10-07, its commit 30c9d31). Every other caller still gets
// 404 since the ERP retired its static signature. Keep this fetch HERE — from
// a content script or a page it would be cross-site and every tag NO DATA.
function fetchOrderStatuses(orderIds) {
  if (!orderIds.length) return Promise.resolve({ ok: true, statuses: {} });
  return fetch(`${ORDER_STATUS_API_BASE}/orders/${orderIds.join(',')}`)
    .then((res) => {
      // 404 = none of the SNs exist in the ERP yet (e.g. a customer whose
      // only orders were placed today). That's a valid "all NO DATA" answer,
      // not an API failure — mixed batches return 200 with notFound entries.
      if (res.status === 404) return { data: [] };
      if (!res.ok) throw new Error(`Order status API error: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const statuses = {};
      const items = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      items.forEach((item) => {
        const id = item.onlineOrderNumber;
        // aggregateStatus covers the whole split-order family (PARTIAL_AUDIT
        // when only some children shipped); legacy status is one child only.
        const st = item.aggregateStatus || item.status;
        if (id && st) statuses[String(id)] = st;
      });
      return { ok: true, statuses };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

// Bank statements for the panel's bank card: qianyi-api-query's
// /public-trans (the dashboard's Transactions tab) — `public` = Public Bank
// (MYR), `ocbc` = OCBC (SGD); { updatedTime, data: [{date, reference, method,
// amount, description}] }, newest first. 404 = that statement was never
// uploaded (an ordinary state, not a fault).
const BANK_IDS = ['public', 'ocbc'];
function fetchBankTransactions(bank) {
  if (!BANK_IDS.includes(bank)) return Promise.resolve({ ok: false, error: 'Unknown bank.' });
  return fetch(`${ORDER_STATUS_API_BASE}/public-trans?bank=${bank}`)
    .then((res) => {
      if (res.status === 404) return { missing: true };
      if (!res.ok) throw new Error(`Bank statement API error: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      if (json.missing) return { ok: true, missing: true, updatedTime: null, rows: [] };
      return { ok: true, updatedTime: json?.updatedTime || null, rows: Array.isArray(json?.data) ? json.data : [] };
    })
    .catch((err) => ({ ok: false, error: err.message }));
}

// Receipt bars (inbox-receipts.js): what the messenger-gatekeeper worker read
// from this customer's photos / PDFs in the last 60 days — { ts_ms, att_index,
// kind, file_key, receipt|null }. Bearer = options `analysisApiToken` (the
// worker's EXT_TOKEN); empty = off. Errors are codes only, never the URL.
const RECEIPTS_API_BASE = 'https://messenger-gatekeeper.stanlee19941218.workers.dev';
const RECEIPTS_TIMEOUT_MS = 10000;
async function fetchReceipts(psid) {
  if (!/^\d{5,25}$/.test(String(psid || ''))) return { ok: false, error: 'bad_psid' };
  const { analysisApiToken } = await chrome.storage.local.get('analysisApiToken');
  if (!analysisApiToken) return { ok: false, error: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RECEIPTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${RECEIPTS_API_BASE}/receipts?psid=${psid}`, {
      headers: { Authorization: `Bearer ${analysisApiToken}` },
      signal: ctl.signal,
    });
    if (res.status === 401) return { ok: false, error: 'unauthorized' };
    if (!res.ok) return { ok: false, error: 'server_' + res.status };
    const json = await res.json();
    return json && json.ok && Array.isArray(json.items) ? { ok: true, items: json.items } : { ok: false, error: 'bad_reply' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Customers with a payment slip and no staff reply since (worker GET
// /pending-slips) — for the "Slip" tag in the conversation list. Items carry the
// chat's last-message time (the row's own timestamp), never a PSID.
async function fetchPendingSlips() {
  const { analysisApiToken } = await chrome.storage.local.get('analysisApiToken');
  if (!analysisApiToken) return { ok: false, error: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RECEIPTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${RECEIPTS_API_BASE}/pending-slips`, {
      headers: { Authorization: `Bearer ${analysisApiToken}` },
      signal: ctl.signal,
    });
    if (res.status === 401) return { ok: false, error: 'unauthorized' };
    if (!res.ok) return { ok: false, error: 'server_' + res.status };
    const json = await res.json();
    return json && json.ok && Array.isArray(json.items) ? { ok: true, items: json.items } : { ok: false, error: 'bad_reply' };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Private reply to a live comment, from the EC2 live page's 💬 button (worker
// POST /private-reply → Meta's Private Replies with the Messenger Filter token).
// `commentIds` in order of preference: Meta allows one reply per comment, so the
// worker sends to the first one it accepts. A timeout here may still have been
// delivered — the page says so instead of retrying.
const PRIVATE_REPLY_TIMEOUT_MS = 30000;

async function sendLivePrivateReply(commentIds, text) {
  const { analysisApiToken } = await chrome.storage.local.get('analysisApiToken');
  if (!analysisApiToken) return { ok: false, error: 'off' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PRIVATE_REPLY_TIMEOUT_MS);
  try {
    const res = await fetch(`${RECEIPTS_API_BASE}/private-reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${analysisApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment_ids: commentIds, text }),
      signal: ctl.signal,
    });
    if (res.status === 401) return { ok: false, error: 'unauthorized' };
    const json = await res.json().catch(() => null);
    if (json && typeof json.ok === 'boolean') return json;
    return { ok: false, error: 'server_' + res.status };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function throwBaserowError(res) {
  return res.text().then((text) => {
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = json.detail || json.error || text;
    } catch (err) {
      // response wasn't JSON - fall back to raw text
    }
    throw new Error(`Baserow API error: ${res.status}${detail ? ` - ${detail}` : ''}`);
  });
}

function getBaserowConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['baserowBaseUrl', 'baserowToken', 'baserowUsersTableId', 'baserowOrdersTableId'],
      (config) => resolve(config)
    );
  });
}

function findBaserowUserRowByPsid(config, psid) {
  const url =
    `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowUsersTableId}/` +
    `?user_field_names=true&filter__PSID__equal=${encodeURIComponent(psid)}`;

  return fetch(url, {
    headers: { Authorization: `Token ${config.baserowToken}` },
  })
    .then((res) => {
      if (!res.ok) return throwBaserowError(res);
      return res.json();
    })
    .then((json) => json?.results?.[0] || null);
}

function findBaserowUserRowByUid(config, uid) {
  const url =
    `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowUsersTableId}/` +
    `?user_field_names=true&filter__UID__equal=${encodeURIComponent(uid)}`;

  return fetch(url, {
    headers: { Authorization: `Token ${config.baserowToken}` },
  })
    .then((res) => {
      if (!res.ok) return throwBaserowError(res);
      return res.json();
    })
    .then((json) => json?.results?.[0] || null);
}

function searchBaserowByUid(uid) {
  return withBaserowConfig((config) =>
    findBaserowUserRowByUid(config, uid).then((row) => {
      if (!row || !row.PSID) return { notFound: true };
      return { psid: String(row.PSID) };
    })
  );
}

function updateBaserowRowUid(config, rowId, uid) {
  const url = `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowUsersTableId}/${rowId}/?user_field_names=true`;

  return fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Token ${config.baserowToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ UID: uid }),
  }).then((res) => {
    if (!res.ok) return throwBaserowError(res);
    return res.json();
  });
}

function createBaserowUserRow(config, { psid, uid, name }) {
  const url = `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowUsersTableId}/?user_field_names=true`;

  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.baserowToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ PSID: psid, UID: uid, Name: name }),
  }).then((res) => {
    if (!res.ok) return throwBaserowError(res);
    return res.json();
  });
}

function withBaserowConfig(handler) {
  return getBaserowConfig().then((config) => {
    if (!config.baserowBaseUrl || !config.baserowToken || !config.baserowUsersTableId) {
      return {
        ok: false,
        error: 'Baserow is not configured - set it up in extension options.',
      };
    }
    return handler(config)
      .then((result) => ({ ok: true, ...result }))
      .catch((err) => ({ ok: false, error: err.message }));
  });
}

// ---------------------------------------------------------------------------
// EC2 live-page RFM lookup (used by ec2-live.js)
//
// Batched PSID -> RFM from the Baserow users table, with a persistent cache.
//
// The RFM rollups in table 749 are recomputed ONCE A DAY, so a value fetched
// during a live cannot change before the live ends. Re-fetching it is pure
// waste. Entries are therefore cached in chrome.storage.local and considered
// fresh for the rest of the Malaysia calendar day on which they were fetched
// (and never longer than 24h). First live of the day pays for the lookups;
// every later page load, tab and reload that day is free.
//
// Cache layout: one key per customer, "rfm:<psid>" -> { v, t } where v is the
// mapped record or null ("not in Baserow" = new customer, worth caching too -
// on a typical night that is a third of the room). One key per customer rather
// than a single blob so a lookup reads and writes only the PSIDs it touches.
// ---------------------------------------------------------------------------

// Baserow takes the whole OR filter in the query string. Benchmarked against
// table 749 (39k rows) with 613 real PSIDs: 20/chunk = 40.3s, 40 = 15.9s,
// 60 = 8.2s, 100 = 8.5s. 60 is the knee - past it the per-request cost starts
// growing faster than the request count falls.
const LIVE_RFM_CHUNK = 60;

const RFM_PREFIX = 'rfm:';
const RFM_MAX_ENTRIES = 15000;
const RFM_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RFM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Malaysia is UTC+8 and never observes DST, so this is exact. */
function malaysiaDay(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function rfmIsFresh(entry, now) {
  if (!entry || typeof entry.t !== 'number') return false;
  if (now - entry.t >= RFM_MAX_AGE_MS) return false;
  return malaysiaDay(entry.t) === malaysiaDay(now);
}

/**
 * Ship-to country from the customer's saved shipping address (table 749
 * 'Address', already in the row - no extra call). Returns 'sg', 'my' or ''.
 *
 * Scored, not keyword-matched, because the obvious keywords lie (measured on
 * 4,000 addresses):
 *  - "Sg" is usually Malaysian - Sungai: "Sg Siput, Perak", "Bandar Sg Long".
 *    "SG" only counts on its own, never followed by a word.
 *  - "Malaysia" is appended to Singapore addresses too
 *    ("…SINGAPORE 768859 district-state-768859-Malaysia"), so it is ignored.
 *  - Malaysian condos use "#09-09" unit numbers and postcodes get typed with 6
 *    digits ("209000 Kulim, Kedah"), so those are weak signals that a state or
 *    street word outweighs.
 * Result: 23 SG (all genuine), 3,932 MY, 45 blank ("-") -> no flag.
 */
function countryOfAddress(addr) {
  const t = String(addr || '');
  if (!t.replace(/[\s-]/g, '')) return '';
  let sg = 0;
  let my = 0;
  if (/\bsingapore\b|\bs[',.]?pore\b|\bsingore\b|\bsingapura\b/i.test(t)) sg += 3;
  if (/(?<![a-z])sg(?![a-z])(?!\s*\.?\s*[a-z])/i.test(t)) sg += 2;
  if (/#\s?\d{1,3}\s?-\s?\d{1,5}/.test(t)) sg += 2;
  if (/(?<!\d)\d{6}(?!\d)/.test(t)) sg += /\b(blk|block)\b/i.test(t) ? 2 : 1;
  if (/\b(johor|johore|selangor|kuala lumpur|wilayah persekutuan|penang|pulau pinang|perak|kedah|kelantan|terengganu|pahang|negeri sembilan|melaka|malacca|sabah|sarawak|perlis|putrajaya|labuan)\b/i.test(t)) my += 3;
  if (/\b(jalan|jln|taman|tmn|lorong|lrg|kampung|kg|persiaran|lebuh|bandar|lot)\b/i.test(t)) my += 2;
  if (/(?<!\d)\d{5}(?!\d)/.test(t)) my += 1;
  if (sg > my) return 'sg';
  if (my > sg) return 'my';
  return '';
}

function mapUserRowToRfm(row) {
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    psid: String(row.PSID),
    name: row.Name || '',
    segment: row['RFM_Score'] || '',
    rfm: row['RFM'] == null ? '' : String(row['RFM']),
    r: num(row['R_Score']),
    f: num(row['F_Score']),
    m: num(row['M_Score']),
    orderCount: num(row['Order Count']),
    ltv: num(row['Sum of Order']),
    lastOrderDate: row['Last Order Date'] || '',
    firstPurchaseDate: row['First_Purchase_Date'] || '',
    yearsActive: num(row['Years_Active']),
    latestOrderId: row['Latest Order ID'] || '',
    country: countryOfAddress(row['Address']),
    // Shown in the flag's tooltip. A bare "-" means no address.
    address: String(row['Address'] || '').replace(/\s+/g, ' ').trim().replace(/^-$/, ''),
  };
}

function rfmCacheRead(psids) {
  const keys = psids.map((p) => RFM_PREFIX + p);
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (stored) => {
      if (chrome.runtime.lastError) return resolve({ found: {}, misses: psids });
      const now = Date.now();
      const found = {};
      const misses = [];
      psids.forEach((psid) => {
        const entry = stored[RFM_PREFIX + psid];
        // Records cached before `country`/`address` existed are refetched once.
        const current = entry && (entry.v === null || (entry.v && 'address' in entry.v));
        if (rfmIsFresh(entry, now) && current) found[psid] = entry.v;
        else misses.push(psid);
      });
      resolve({ found, misses });
    });
  });
}

function rfmCacheWrite(records) {
  const now = Date.now();
  const patch = {};
  Object.keys(records).forEach((psid) => {
    patch[RFM_PREFIX + psid] = { v: records[psid], t: now };
  });
  if (!Object.keys(patch).length) return Promise.resolve();
  return new Promise((resolve) => {
    chrome.storage.local.set(patch, () => {
      void chrome.runtime.lastError; // a full quota must not break the lookup
      resolve();
    });
  });
}

/**
 * Drop expired entries, and the oldest ones if the cache has outgrown its cap.
 * Enumerating all of storage is comparatively expensive, so this runs at most
 * once an hour and never blocks a lookup.
 */
function rfmCachePrune() {
  chrome.storage.local.get(['rfmLastPrune'], (meta) => {
    const now = Date.now();
    if (meta && meta.rfmLastPrune && now - meta.rfmLastPrune < RFM_PRUNE_INTERVAL_MS) return;
    chrome.storage.local.set({ rfmLastPrune: now }, () => {
      chrome.storage.local.get(null, (all) => {
        if (chrome.runtime.lastError) return;
        const entries = Object.keys(all)
          .filter((k) => k.startsWith(RFM_PREFIX))
          .map((k) => ({ k, t: (all[k] && all[k].t) || 0 }));
        const expired = entries.filter((e) => now - e.t >= RFM_MAX_AGE_MS).map((e) => e.k);
        const live = entries.filter((e) => now - e.t < RFM_MAX_AGE_MS);
        let overflow = [];
        if (live.length > RFM_MAX_ENTRIES) {
          live.sort((a, b) => a.t - b.t);
          overflow = live.slice(0, live.length - RFM_MAX_ENTRIES).map((e) => e.k);
        }
        const drop = expired.concat(overflow);
        if (drop.length) chrome.storage.local.remove(drop);
      });
    });
  });
}

/**
 * One order from Baserow, with its items - for the live overlay's recency tag.
 *
 * Baserow, not EC2: EC2 archives old orders, while table 750 keeps the full
 * history (156k orders back to 2022-11). 750 holds the order (Order_ID = the
 * F-prefixed orderSn that table 749's 'Latest Order ID' names, Date in UTC,
 * Total_Amount); its items are rows of table 751 linked by Order_ID
 * (Product_Name lookup, Quantity, Product_Price, Subtotal, Description).
 * Two reads: the order row, then its items.
 */
const BASEROW_ORDER_ITEMS_TABLE_ID = '751';

function getBaserowOrderWithItems(orderSn) {
  return withBaserowConfig((config) => {
    const ordersTable = config.baserowOrdersTableId || '750';
    const H = { headers: { Authorization: 'Token ' + config.baserowToken } };
    const orderUrl =
      `${config.baserowBaseUrl}/api/database/rows/table/${ordersTable}/` +
      `?user_field_names=true&size=1&filter__Order_ID__equal=${encodeURIComponent(orderSn)}`;
    return fetch(orderUrl, H)
      .then((res) => (res.ok ? res.json() : throwBaserowError(res)))
      .then((json) => {
        const row = json && json.results && json.results[0];
        if (!row) return { found: false };
        const itemsUrl =
          `${config.baserowBaseUrl}/api/database/rows/table/${BASEROW_ORDER_ITEMS_TABLE_ID}/` +
          `?user_field_names=true&size=200&filter__Order_ID__link_row_has=${row.id}`;
        return fetch(itemsUrl, H)
          .then((res) => (res.ok ? res.json() : throwBaserowError(res)))
          .then((items) => ({
            found: true,
            order: {
              orderSn: row.Order_ID,
              date: row.Date || '',
              total: row.Total_Amount,
              items: ((items && items.results) || []).map((it) => ({
                name: ((it.Product_Name || [])[0] || {}).value || '',
                description: it.Description || '',
                qty: parseFloat(it.Quantity) || 0,
                price: it.Product_Price,
                subtotal: it.Subtotal,
              })),
            },
          }));
      });
  });
}

function fetchLiveRfmChunk(config, chunk) {
  const params = new URLSearchParams();
  params.set('user_field_names', 'true');
  params.set('filter_type', 'OR');
  params.set('size', String(Math.max(chunk.length, 1)));
  chunk.forEach((psid) => params.append('filter__PSID__equal', psid));

  const url =
    config.baserowBaseUrl +
    '/api/database/rows/table/' +
    config.baserowUsersTableId +
    '/?' +
    params.toString();

  return fetch(url, { headers: { Authorization: 'Token ' + config.baserowToken } })
    .then((res) => {
      if (!res.ok) return throwBaserowError(res);
      return res.json();
    })
    .then((json) => (json && json.results) || []);
}

function getLiveRfmBatch(psids) {
  const wanted = [...new Set((psids || []).map(String).filter(Boolean))];
  if (!wanted.length) {
    return Promise.resolve({ ok: true, found: {}, missing: [], stats: { requested: 0, cacheHits: 0, fetched: 0, requests: 0 } });
  }

  return rfmCacheRead(wanted).then(({ found: cached, misses }) => {
    const split = (records) => {
      const found = {};
      const missing = [];
      Object.keys(records).forEach((psid) => {
        if (records[psid]) found[psid] = records[psid];
        else missing.push(psid);
      });
      return { found, missing };
    };

    // Everything was already known today - no network at all.
    if (!misses.length) {
      const out = split(cached);
      return {
        ok: true,
        ...out,
        stats: { requested: wanted.length, cacheHits: wanted.length, fetched: 0, requests: 0 },
      };
    }

    return withBaserowConfig((config) => {
      const chunks = [];
      for (let i = 0; i < misses.length; i += LIVE_RFM_CHUNK) {
        chunks.push(misses.slice(i, i + LIVE_RFM_CHUNK));
      }
      // Sequential: Baserow here is self-hosted and a cold live can queue
      // hundreds of PSIDs.
      return chunks
        .reduce(
          (chain, chunk) =>
            chain.then((acc) =>
              fetchLiveRfmChunk(config, chunk).then((rows) => {
                rows.forEach((row) => {
                  if (row && row.PSID) acc[String(row.PSID)] = mapUserRowToRfm(row);
                });
                return acc;
              })
            ),
          Promise.resolve({})
        )
        .then((fetched) => {
          // Cache negatives too: "absent from 749" is a real, reusable answer.
          const toCache = {};
          misses.forEach((psid) => {
            toCache[psid] = fetched[psid] || null;
          });
          return rfmCacheWrite(toCache).then(() => {
            rfmCachePrune();
            const out = split(Object.assign({}, cached, toCache));
            return {
              ...out,
              stats: {
                requested: wanted.length,
                cacheHits: wanted.length - misses.length,
                fetched: misses.length,
                requests: chunks.length,
              },
            };
          });
        });
    });
  });
}

function linkBaserowUid(uid, psid, name) {
  return withBaserowConfig((config) =>
    findBaserowUserRowByPsid(config, psid).then((row) => {
      if (row) return updateBaserowRowUid(config, row.id, uid).then(() => ({}));
      return createBaserowUserRow(config, { psid, uid, name }).then(() => ({}));
    })
  );
}

function unlinkBaserowUid(psid) {
  return withBaserowConfig((config) =>
    findBaserowUserRowByPsid(config, psid).then((row) => {
      if (!row) return {};
      return updateBaserowRowUid(config, row.id, '').then(() => ({}));
    })
  );
}


function findBaserowOrderRowByOrderId(config, orderId) {
  const url =
    `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowOrdersTableId}/` +
    `?user_field_names=true&filter__Order_ID__equal=${encodeURIComponent(orderId)}`;

  return fetch(url, {
    headers: { Authorization: `Token ${config.baserowToken}` },
  })
    .then((res) => {
      if (!res.ok) return throwBaserowError(res);
      return res.json();
    })
    .then((json) => json?.results?.[0] || null);
}

function mapUserRowToCandidate(row) {
  return {
    psid: String(row.PSID),
    name: row.Name || '',
    lastOrderDate: row['Last Order Date'],
    rfmScore: row['RFM_Score'],
  };
}

function fetchBaserowUserRowById(config, rowId) {
  const url = `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowUsersTableId}/${rowId}/?user_field_names=true`;

  return fetch(url, {
    headers: { Authorization: `Token ${config.baserowToken}` },
  }).then((res) => {
    if (!res.ok) return throwBaserowError(res);
    return res.json();
  });
}

function searchBaserowByOrderId(orderId) {
  return withBaserowConfig((config) => {
    if (!config.baserowOrdersTableId) {
      return Promise.reject(
        new Error('Baserow Orders table ID is not configured - set it up in extension options.')
      );
    }

    const fallbackToPsid = () =>
      findBaserowUserRowByPsid(config, orderId).then((row) => ({
        candidates: row ? [mapUserRowToCandidate(row)] : [],
      }));

    return findBaserowOrderRowByOrderId(config, orderId).then((order) => {
      const linked = Array.isArray(order?.PSID) ? order.PSID[0] : null;
      if (!linked) return fallbackToPsid();

      return fetchBaserowUserRowById(config, linked.id).then((row) =>
        row?.PSID ? { candidates: [mapUserRowToCandidate(row)] } : fallbackToPsid()
      );
    });
  });
}

function searchBaserowUsersByPsid(psid) {
  return withBaserowConfig((config) =>
    findBaserowUserRowByPsid(config, psid).then((row) => ({
      candidates: row ? [mapUserRowToCandidate(row)] : [],
    }))
  );
}

function fetchBaserowRecentOrders(config, psid) {
  if (!config.baserowOrdersTableId) return Promise.resolve([]);
  const filters = JSON.stringify({
    filter_type: 'AND',
    filters: [{ field: 'PSID', type: 'link_row_contains', value: psid }],
  });
  const url =
    `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowOrdersTableId}/` +
    `?user_field_names=true&filters=${encodeURIComponent(filters)}&order_by=-Date&size=5`;
  return fetch(url, { headers: { Authorization: `Token ${config.baserowToken}` } })
    .then((res) => (res.ok ? res.json() : { results: [] }))
    .then((json) =>
      (json?.results || []).map((row) => ({
        orderId: row.Order_ID,
        orderSn: row.Order_ID,
        totalAmount: row.Total_Amount,
        orderDate: row.Date,
      }))
    )
    .catch(() => []);
}

function getCustomerSummaryByPsid(psid) {
  return withBaserowConfig((config) => {
    // Baserow row and EC2 order list are independent reads — run them
    // together. Serial was 300-800ms slower on every conversation switch.
    // (On notFound the order-list result is discarded — rare and harmless.)
    return Promise.all([
      findBaserowUserRowByPsid(config, psid),
      fetchOrderList(psid),
    ]).then(([row, res]) => {
      if (!row) return { notFound: true };

      return Promise.resolve().then(() => {
        const allOrders = res.ok ? res.orders : [];
        const ec2Recent = allOrders.slice(0, 5).map((o) => ({
          orderId: o.orderId,
          orderSn: o.orderSn,
          totalAmount: o.amount,
          orderDate: o.orderTime,
        }));

        const buildResult = (recentOrders) => ({
          data: {
            totalSpending: row['Sum of Order'],
            totalPurchase: row['Order Count'],
            lastOrderDate: row['Last Order Date'],
            rawRecency: row['Raw_Recency'],
            yearsActive: row['Years_Active'],
            rank: row['RFM_Score'],
            address: row['Address'],
            // Baserow's stored customer name — the panel checks it against
            // Meta's name to catch a conversation linked to the wrong PSID.
            baserowName: row['Name'] || '',
            recentOrders,
            allOrders,
          },
        });

        if (allOrders.length >= 5) return buildResult(ec2Recent);

        return fetchBaserowRecentOrders(config, psid).then((baserowOrders) => {
          const ec2Sns = new Set(ec2Recent.map((o) => String(o.orderSn)).filter(Boolean));
          const fill = baserowOrders
            .filter((o) => !ec2Sns.has(String(o.orderSn)))
            .slice(0, 5 - ec2Recent.length);
          return buildResult([...ec2Recent, ...fill]);
        });
      });
    });
  });
}

/**
 * Runs in the EC2 live page's MAIN world (chrome.scripting, world: 'MAIN') for
 * the overlay's big 刷新: re-runs living.js's own loaders for the comment list
 * (getCommentsPage, first page) and the bid list (freshGroupsFor4) without a
 * page reload, and resolves once both requests have landed (jQuery ajaxStop).
 * Must be self-contained - it is serialised into the page.
 *
 * living.js's 5 s comment poll prepends rows newer than `lastTime`. To keep it
 * from adding duplicates while the list is rebuilt: wait for an in-flight poll
 * to finish, then park `lastTime` in the far future (polls return nothing);
 * getCommentsPage(live_id, 1) sets the real cursor from the fresh first page.
 */
function ec2ReloadListsInPage() {
  return new Promise((resolve) => {
    const $ = window.jQuery;
    const liveId = window.live_id || new URLSearchParams(location.search).get('live_id');
    if (!$ || typeof window.getCommentsPage !== 'function' || typeof window.freshGroupsFor4 !== 'function' || !liveId) {
      resolve({ ok: false, error: 'EC2 page functions not found' });
      return;
    }
    const started = Date.now();
    const go = () => {
      const prevLastTime = window.lastTime;
      let finished = false;
      let timer = 0;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        $(document).off('ajaxStop', onStop);
        // The first page never arrived: give the poll its old cursor back.
        if (String(window.lastTime).startsWith('9999')) window.lastTime = prevLastTime;
        const rows = document.querySelectorAll('#liveMessageDiv tbody > tr[id^="win_tr_"]').length;
        const ok = !error && rows > 0;
        resolve({ ok, error: ok ? '' : error || 'no comments loaded', rows, ms: Date.now() - started });
      };
      const onStop = () => finish('');
      timer = setTimeout(() => finish('timeout'), 20000);
      window.lastTime = '9999-12-31 23:59:59';
      window.pageLastTime = '';
      window.pageReIds = [];
      $('#tr_page').remove();
      $('#liveMessageDiv tbody').empty();
      $(document).on('ajaxStop', onStop);
      window.getCommentsPage(liveId, 1);
      window.freshGroupsFor4();
    };
    const wait = (n) => {
      if (!$.active || n >= 50) go();
      else setTimeout(() => wait(n + 1), 100);
    };
    wait(0);
  });
}

/**
 * Counters of the Facebook video EC2 embeds, read from the plugin page's server
 * HTML (https://www.facebook.com/plugins/video.php?href=…) - no video reload.
 * The footer ships as <div title="Like">…719</div>, "Comment" and "Share";
 * is_live_stream says whether the broadcast is live. Numbers stay as Facebook
 * prints them ("2.3K"). viewers: the LIVE badge's viewerCount (only while live).
 */
const FB_PLUGIN_RE = /^https:\/\/www\.facebook\.com\/plugins\/video\.php\?/;

function parseFbCount(html, title) {
  const m = html.match(new RegExp(`title="${title}"[^>]*>(?:<i[^>]*></i>)*\\s*([\\d.,]+[KMB]?)\\s*<`));
  return m ? m[1] : null;
}

function parseFbViewers(html) {
  // Verified on live 557246: the LIVE badge ships as
  // <div class="_1jb_ _u_l" data-store="{&quot;viewerCount&quot;:273,…}">…273</div>
  const patterns = [
    /viewerCount(?:&quot;|")\s*:\s*(\d+)/,
    /class="_1jb_[^"]*"[^>]*>(?:<i[^>]*><\/i>)*\s*([\d,]+)\s*</,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * The live's Facebook description (the post text), as plain text with line
 * breaks. The plugin is embedded with show_text=1, so its server HTML carries
 * <div data-testid="post_message" class="_5pbx userContent"><p>我要飞啦<br /> 中秋节最后一场</p></div>
 * (verified on 557246, 556923 and 8 earlier lives). Long posts may add
 * Facebook's "See more" parts (text_exposed_hide / text_exposed_link), which
 * are dropped; text_exposed_show holds the rest and is kept. '' when there is
 * no post text, null when the block is not found. No DOMParser in a worker.
 */
function parseFbDescription(html) {
  const open = html.match(/<div[^>]*data-testid="post_message"[^>]*>/);
  if (!open) return null;
  // Walk to the matching </div>: the "See more" rest is itself a <div>.
  const start = open.index + open[0].length;
  const tagRe = /<\/?div\b[^>]*>/g;
  tagRe.lastIndex = start;
  let depth = 1;
  let end = -1;
  for (let m; (m = tagRe.exec(html));) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (!depth) { end = m.index; break; }
  }
  if (end < 0) return null;
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.slice(start, end)
    .replace(/<span[^>]*class="[^"]*text_exposed_(?:hide|link)[^"]*"[^>]*>[\s\S]*?<\/span>(?:\s*<\/span>)?/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, e) => {
      if (e[0] !== '#') return entities[e.toLowerCase()] ?? all;
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    })
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How long the broadcast has been public, in ms, from the live DASH manifest
 * the plugin HTML links (hd_src/sd_src …/live-dash/….mpd on *.fbcdn.net):
 * currentServerTimeMs (the manifest's own clock, so no local clock skew) minus
 * publishTime = the moment the live was published.
 *
 * NOT firstAvTimeMs: that is the encoder's first frame, which includes the
 * preview before going public. On 557246 PRISM streamed from 18:07:34 but the
 * live was published at 18:33:15 (publishTime; firstAvTimeMs + publishFrameTime
 * = 18:33:12, the fallback) and the first comment came at 18:38. The plugin's
 * own hover time (video.currentTime) counts from 18:07 too, so it is not the
 * reference. null when not live or not found. ~9 KB.
 */
async function getFbLiveElapsed(html) {
  const m = html.match(/"(?:hd_src|sd_src)"\s*:\s*"(https:[^"]*?\.mpd[^"]*)"/);
  if (!m) return null;
  const mpdUrl = m[1].replace(/\\\//g, '/');
  if (!/^https:\/\/[^/]+\.fbcdn\.net\//.test(mpdUrl)) return null;
  const res = await fetch(mpdUrl, { credentials: 'omit' });
  if (!res.ok) return null;
  const xml = await res.text();
  const attr = (k) => (xml.match(new RegExp(`\\s${k}="([^"]+)"`)) || [])[1];
  const now = Number(attr('currentServerTimeMs'));
  let published = Date.parse(attr('publishTime') || '');
  if (!Number.isFinite(published)) published = Number(attr('firstAvTimeMs')) + Number(attr('publishFrameTime'));
  if (!now || !Number.isFinite(published)) return null;
  const ms = now - published;
  return ms >= 0 ? ms : null;
}

async function getFbVideoStats(url, wantElapsed) {
  if (!FB_PLUGIN_RE.test(url)) return { ok: false, error: 'not a Facebook video plugin URL' };
  try {
    const res = await fetch(url, { credentials: 'omit', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!res.ok) return { ok: false, error: `Facebook returned HTTP ${res.status}` };
    const html = await res.text();
    const liveFlag = html.match(/"is_live_stream"\s*:\s*(true|false)/);
    const live = liveFlag ? liveFlag[1] === 'true' : null;
    let elapsedMs = null;
    if (wantElapsed && live) elapsedMs = await getFbLiveElapsed(html).catch(() => null);
    return {
      ok: true,
      live,
      elapsedMs,
      viewers: parseFbViewers(html),
      likes: parseFbCount(html, 'Like'),
      comments: parseFbCount(html, 'Comment'),
      shares: parseFbCount(html, 'Share'),
      description: parseFbDescription(html),
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ── Customer notes (Balance / Note bar) — Baserow ───────────────────────────
// Logic lives in notes-baserow.js (shared with tests/notes-baserow.test.js);
// this only supplies fetch + config. Log table = Customer Note Log (794).
const DEFAULT_NOTE_LOG_TABLE_ID = '794';

// The preview build kept test balances/notes in this browser only; they are
// not real data and nothing reads them any more. `staffName` was the typed
// fallback name, removed from the options page (2026-10-18).
// Live page 💬 messages (ec2-live.js, edited in Options). One test message
// until the host writes real ones; never overwrites what they saved.
const DEFAULT_LIVE_REPLIES = [{
  zh: '【测试】您好 {name}！我们看到您在直播的留言了～ 有任何问题可以直接在这里回复我们哦 ❤️🙏',
  en: '[Test] Hi {name}! We saw your comment on our live 😊 You can reply here anytime if you have any questions ❤️🙏',
}];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('liveReplyTemplates', ({ liveReplyTemplates }) => {
    if (!Array.isArray(liveReplyTemplates)) chrome.storage.local.set({ liveReplyTemplates: DEFAULT_LIVE_REPLIES });
  });
  chrome.storage.local.remove('staffName');
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all || {}).filter((k) => k.startsWith('noteMock:') || k === 'noteMockLog' || k === 'notesMockFail');
    if (keys.length) chrome.storage.local.remove(keys);
  });
});

const notesBackend = NotesBaserow.createNotesBackend({
  fetch: (...args) => fetch(...args),
  getConfig: () => new Promise((resolve) => {
    chrome.storage.local.get(['baserowBaseUrl', 'baserowToken', 'baserowUsersTableId', 'baserowNoteLogTableId'], (c) => resolve({
      baseUrl: c.baserowBaseUrl || '',
      token: c.baserowToken || '',
      usersTableId: c.baserowUsersTableId || '',
      logTableId: c.baserowNoteLogTableId || DEFAULT_NOTE_LOG_TABLE_ID,
    }));
  }),
});

// Voice message transcripts (inbox-voice.js → TRANSCRIBE_VOICE). Only
// cdn.fbsbx.com clips are fetched; off when no Gemini key is set.
const voiceTranscriber = VoiceTranscribe.createVoiceTranscriber({
  fetch: (...a) => fetch(...a),
  getKey: async () => (await chrome.storage.local.get('geminiApiKey')).geminiApiKey || '',
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TRANSCRIBE_VOICE') {
    voiceTranscriber.transcribe(message).then(sendResponse, (e) => sendResponse({ ok: false, error: 'internal', detail: String(e) }));
    return true;
  }

  if (message?.type === 'GET_CUSTOMER_NOTES') {
    notesBackend.load(String(message.psid || '')).then(sendResponse);
    return true;
  }

  if (message?.type === 'SAVE_CUSTOMER_NOTES') {
    notesBackend.save(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_CUSTOMER_NOTE_LOG') {
    notesBackend.history(String(message.psid || '')).then(sendResponse);
    return true;
  }

  if (message?.type === 'NOTES_UNLINK_REVIEW') {
    notesBackend.unlinkReview(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'NOTES_UNLINK_REVERT') {
    notesBackend.unlinkRevert(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'OPEN_OPTIONS_PAGE') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'EC2_RELOAD_LISTS') {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
        world: 'MAIN',
        func: ec2ReloadListsInPage,
      })
      .then((res) => sendResponse((res && res[0] && res[0].result) || { ok: false, error: 'no result' }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (message?.type === 'SEARCH_MANYCHAT_BY_NAME') {
    searchManyChatByName(message.name).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_ORDERS_BY_PSID') {
    getCustomerSummaryByPsid(message.psid).then(sendResponse);
    return true;
  }

  if (message?.type === 'LINK_BASEROW_UID') {
    linkBaserowUid(message.uid, message.psid, message.name).then(sendResponse);
    return true;
  }

  if (message?.type === 'UNLINK_BASEROW_UID') {
    unlinkBaserowUid(message.psid).then(sendResponse);
    return true;
  }

  if (message?.type === 'SEARCH_BASEROW_BY_ORDER_ID') {
    searchBaserowByOrderId(message.orderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'SEARCH_BASEROW_BY_PSID') {
    searchBaserowUsersByPsid(message.psid).then(sendResponse);
    return true;
  }

  if (message?.type === 'SEARCH_BASEROW_BY_UID') {
    searchBaserowByUid(message.uid).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_MANYCHAT_INFO') {
    getManyChatInfo(message.psid).then(sendResponse);
    return true;
  }

  if (message?.type === 'MANYCHAT_TAG_ACTION') {
    manyChatTagAction(message.action, message.psid, message.tagId).then(sendResponse);
    return true;
  }

  if (message?.type === 'CHECK_SESSION') {
    checkSession().then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_CART_SUMMARY') {
    getCartSummary(message.psid, message.option).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_SELECTED_CART_SUMMARY') {
    getSelectedCartSummary(message.psid, message.recIds || [], message.option).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_ORDER_STATUSES') {
    fetchOrderStatuses(message.orderIds || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_BANK_TRANSACTIONS') {
    fetchBankTransactions(message.bank).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_RECEIPTS') {
    fetchReceipts(message.psid).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  if (message?.type === 'LIVE_PRIVATE_REPLY') {
    sendLivePrivateReply(message.commentIds || [], String(message.text || '')).then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  if (message?.type === 'GET_PENDING_SLIPS') {
    fetchPendingSlips().then(sendResponse, () => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }

  if (message?.type === 'CHECK_PARCEL_PHOTOS') {
    checkParcelPhotos(message.orderIds || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_CART_ITEMS') {
    getCartItems(message.psid).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_DELETE_ITEMS') {
    deleteCartItems(message.recIds || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_REFRESH_VALIDITY') {
    refreshCartValidity(message.recIds || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_UPDATE_QTY') {
    updateCartQty(message.recId, message.qty).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_ADD_ITEM') {
    addCartItem(message.fbUserId, message.goodsId, message.qty).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_SPLIT_ITEM') {
    const { recId, goodsId, originalQty, splitQty, fbUserId } = message;
    updateCartQty(recId, originalQty - splitQty)
      .then((res) => res.ok ? addCartItem(fbUserId, goodsId, splitQty) : res)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'SEARCH_GOODS') {
    searchGoods(message.keyword || '', message.page || 1).then(sendResponse);
    return true;
  }

  if (message?.type === 'SMART_SEARCH_GOODS') {
    smartSearchGoods(message.words || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'LIST_LIVES') {
    listLives(message.page || 1, message.name || '').then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_ADD_BY_CODE') {
    addCartItemsByCode(message.liveId, message.fbUserId, message.items || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'CART_COPY_ITEMS') {
    copyCart(message.fbUserId, message.sourceFbUserId, message.dryRun || false, message.includeExpired || false, message.mergeDuplicates || false).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_ORDER_LIST') {
    fetchOrderList(message.psid).then((res) => {
      sendResponse(res);
    });
    return true;
  }

  if (message?.type === 'GET_ORDER_DETAIL') {
    getOrderDetail(message.orderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_ORDER_CONSIGNEE') {
    getOrderConsignee(message.orderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'UPDATE_ORDER_CONSIGNEE') {
    updateOrderConsignee(message.orderId, message.data).then(sendResponse);
    return true;
  }

  if (message?.type === 'ORDER_OPERATION') {
    orderOperation(message.orderId, message.operation).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_PARCEL_PHOTO_ORDER') {
    getParcelPhotoOrder(message.orderId).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_CHECKOUT_FORM') {
    getCheckoutForm(message.fbUserId, message.userId, message.recIds || [], message.goodsNumbers || []).then(sendResponse);
    return true;
  }

  if (message?.type === 'CREATE_ORDER') {
    createOrder(message.fbUserId, message.userId, message.items || [], message.customer, message.shippingIdType, !!message.confirm, !!message.pay, message.note || '').then(sendResponse);
    return true;
  }

  if (message?.type === 'ORDER_ADJUSTMENT') {
    orderAdjustment(message.orderId, message.price, message.adjType, message.note).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_REGION_AREAS') {
    getRegionAreas(message.stateId).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_REGION_POSTCODE') {
    getRegionPostcode(message.areaId).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_AI_HEALTH') {
    getAiHealth().then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_FB_VIDEO_STATS') {
    getFbVideoStats(String(message.url || ''), message.wantElapsed === true).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_BASEROW_ORDER') {
    getBaserowOrderWithItems(String(message.orderSn || '')).then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_LIVE_RFM_BATCH') {
    getLiveRfmBatch(message.psids).then(sendResponse);
    return true;
  }

  if (message?.type === 'AI_REPLY') {
    getAiReply(message.messages || [], message.mode || 'quick', message.language || 'chinese').then(sendResponse);
    return true;
  }
});
