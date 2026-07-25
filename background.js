const MANYCHAT_API_BASE = 'https://api.manychat.com';
const CART_API_BASE = 'https://yxch9n4n6e.execute-api.ap-southeast-1.amazonaws.com/latest';
const ORDER_STATUS_API_BASE = 'https://7n881aguj8.execute-api.ap-southeast-1.amazonaws.com';

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
    .catch(() => ({ ok: true, valid: false }));
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

function createOrder(fbUserId, userId, items, customer, shippingIdType, confirm, pay) {
  return fetch(`${CART_API_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fbUserId, userId, items, customer, shippingIdType, confirm, pay }),
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

function fetchOrderStatuses(orderIds) {
  if (!orderIds.length) return Promise.resolve({ ok: true, statuses: {} });
  return fetch(`${ORDER_STATUS_API_BASE}/orders/${orderIds.join(',')}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Order status API error: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const statuses = {};
      const items = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      items.forEach((item) => {
        const id = item.onlineOrderNumber;
        if (id && item.status) statuses[String(id)] = item.status;
      });
      return { ok: true, statuses };
    })
    .catch((err) => ({ ok: false, error: err.message }));
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
    return findBaserowUserRowByPsid(config, psid).then((row) => {
      if (!row) return { notFound: true };

      return fetchOrderList(psid).then((res) => {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    createOrder(message.fbUserId, message.userId, message.items || [], message.customer, message.shippingIdType, !!message.confirm, !!message.pay).then(sendResponse);
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

  if (message?.type === 'AI_REPLY') {
    getAiReply(message.messages || [], message.mode || 'quick', message.language || 'chinese').then(sendResponse);
    return true;
  }
});
