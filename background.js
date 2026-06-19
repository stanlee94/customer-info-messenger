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

function fetchRecentOrders(config, psid) {
  const filters = JSON.stringify({
    filter_type: 'AND',
    filters: [{ field: 'PSID', type: 'link_row_contains', value: psid }],
  });
  const url =
    `${config.baserowBaseUrl}/api/database/rows/table/${config.baserowOrdersTableId}/` +
    `?user_field_names=true&filters=${encodeURIComponent(filters)}&order_by=-Date&size=5`;

  return fetch(url, {
    headers: { Authorization: `Token ${config.baserowToken}` },
  })
    .then((res) => {
      if (!res.ok) return throwBaserowError(res);
      return res.json();
    })
    .then((json) =>
      (json?.results || []).map((row) => ({
        orderId: row.Order_ID,
        totalAmount: row.Total_Amount,
        orderDate: row.Date,
      }))
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

function getCustomerSummaryByPsid(psid) {
  return withBaserowConfig((config) => {
    if (!config.baserowOrdersTableId) {
      return Promise.reject(
        new Error('Baserow Orders table ID is not configured - set it up in extension options.')
      );
    }

    return findBaserowUserRowByPsid(config, psid).then((row) => {
      if (!row) return { notFound: true };

      return fetchRecentOrders(config, psid).then((recentOrders) => ({
        data: {
          totalSpending: row['Sum of Order'],
          totalPurchase: row['Order Count'],
          lastOrderDate: row['Last Order Date'],
          rawRecency: row['Raw_Recency'],
          yearsActive: row['Years_Active'],
          rank: row['RFM_Score'],
          address: row['Address'],
          recentOrders,
        },
      }));
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

  if (message?.type === 'GET_ORDER_STATUSES') {
    fetchOrderStatuses(message.orderIds || []).then(sendResponse);
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
