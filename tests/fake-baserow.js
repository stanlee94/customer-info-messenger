// In-memory stand-in for the slice of Baserow's REST API the notes backend
// uses (rows list with filters, get/patch one row, batch create). Responses
// mimic Baserow's shapes with user_field_names=true: single select →
// {id, value, color}, link row → [{id, value}]. Test utility only — loaded by
// tests/notes-baserow.test.js (Node) and notebar-ui-test.js (browser page).
//
// Hooks:
//   fake.before(fn)  fn({method, table, rowId, body}) runs before each request
//                    is handled; return a {status, body} to answer instead
//                    (failure injection), or mutate fake.tables to simulate
//                    another agent writing between two of our requests.
//   fake.requests    every request handled, in order.
(function (root) {
  function createFakeBaserow(opts = {}) {
    const usersTable = String(opts.usersTableId || '749');
    const logTable = String(opts.logTableId || '794');
    const tables = { [usersTable]: [], [logTable]: [] };
    const nextId = { [usersTable]: 1000, [logTable]: 1 };
    const selectIds = { Balance: 3001, Note: 3002 };
    const hooks = [];
    const requests = [];

    function addRow(table, fields) {
      const row = { id: nextId[table]++, ...fields };
      tables[table].push(row);
      return row;
    }

    // Stored values are what a client wrote; the response shape is Baserow's.
    function present(table, row) {
      const out = { id: row.id, order: String(row.id) };
      for (const [k, v] of Object.entries(row)) {
        if (k === 'id') continue;
        if (table === logTable && k === 'Field') out[k] = v ? { id: selectIds[v], value: v, color: 'blue' } : null;
        else if (table === logTable && k === 'User') {
          out[k] = (v || []).map((id) => {
            const u = tables[usersTable].find((r) => r.id === id);
            return { id, value: u ? String(u.PSID || '') : '' };
          });
        } else out[k] = v;
      }
      if (table === usersTable) {
        for (const f of ['Name', 'PSID', 'UID', 'Balance', 'Note', 'Note_Updated_By']) if (!(f in out)) out[f] = '';
        if (!('Note_Updated_At' in out)) out.Note_Updated_At = null;
      }
      return out;
    }

    function json(status, body) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }

    function normalizeSelect(v) {
      if (v == null || v === '') return null;
      if (typeof v === 'number') return Object.keys(selectIds).find((k) => selectIds[k] === v) || null;
      return Object.prototype.hasOwnProperty.call(selectIds, v) ? v : undefined;
    }

    function writeFields(table, target, body) {
      for (const [k, v] of Object.entries(body || {})) {
        if (k === 'id') continue;
        if (table === logTable && k === 'Field') {
          const s = normalizeSelect(v);
          if (s === undefined) throw Object.assign(new Error('bad select'), { status: 400 });
          target[k] = s;
        } else if (table === logTable && k === 'User') {
          target[k] = (v || []).map((x) => (typeof x === 'object' ? x.id : Number(x)));
        } else target[k] = v == null ? (k === 'Note_Updated_At' ? null : '') : v;
      }
    }

    async function fetchImpl(url, init = {}) {
      const u = new URL(url);
      const method = (init.method || 'GET').toUpperCase();
      const m = u.pathname.match(/^\/api\/database\/rows\/table\/(\d+)\/(?:(\d+)\/|(batch)\/)?$/);
      let body = null;
      if (init.body) body = JSON.parse(init.body);
      const req = { method, url, table: m && m[1], rowId: m && m[2] ? Number(m[2]) : null, batch: !!(m && m[3]), body, auth: (init.headers || {}).Authorization };
      requests.push(req);
      for (const h of hooks) {
        const r = await h(req);
        if (r) return json(r.status, r.body || {});
      }
      if (!m || !tables[req.table]) return json(404, { error: 'ERROR_TABLE_DOES_NOT_EXIST' });
      if (u.searchParams.get('user_field_names') !== 'true') return json(400, { error: 'user_field_names required by the fake' });
      const table = req.table;
      const rows = tables[table];

      try {
        if (req.rowId != null) {
          const row = rows.find((r) => r.id === req.rowId);
          if (!row) return json(404, { error: 'ERROR_ROW_DOES_NOT_EXIST', detail: `The row ${req.rowId} does not exist.` });
          if (method === 'GET') return json(200, present(table, row));
          if (method === 'PATCH') { writeFields(table, row, body); return json(200, present(table, row)); }
          if (method === 'DELETE') { rows.splice(rows.indexOf(row), 1); return json(204, {}); }
        }
        if (req.batch && method === 'POST') {
          const created = (body.items || []).map((item) => {
            const row = { id: nextId[table]++ };
            writeFields(table, row, item);
            return row;
          });
          rows.push(...created);
          return json(200, { items: created.map((r) => present(table, r)) });
        }
        if (method === 'POST') {
          const row = { id: nextId[table]++ };
          writeFields(table, row, body);
          rows.push(row);
          return json(200, present(table, row));
        }
        if (method === 'GET') {
          let out = rows.slice();
          for (const [k, v] of u.searchParams) {
            const f = k.match(/^filter__(.+)__equal$/);
            if (f) out = out.filter((r) => String(r[f[1]] ?? '') === v);
          }
          // Real Baserow only sorts by fields — `order_by=id` is a 400
          // (ERROR_ORDER_BY_FIELD_NOT_FOUND, seen on 794). Unsorted = row order.
          const order = u.searchParams.get('order_by');
          if (order && /^-?id$/.test(order)) return json(400, { error: 'ERROR_ORDER_BY_FIELD_NOT_FOUND', detail: `The field ${order} was not found in the table.` });
          out.sort((a, b) => a.id - b.id);
          const size = Number(u.searchParams.get('size') || 100);
          return json(200, { count: out.length, next: out.length > size ? 'more' : null, previous: null, results: out.slice(0, size).map((r) => present(table, r)) });
        }
      } catch (err) {
        return json(err.status || 500, { error: 'ERROR_REQUEST_BODY_VALIDATION', detail: err.message });
      }
      return json(405, { error: 'method not allowed' });
    }

    return {
      fetch: fetchImpl,
      tables,
      requests,
      usersTable,
      logTable,
      before(fn) { hooks.push(fn); },
      addUser(fields) { return addRow(usersTable, fields); },
      addLog(fields) { return addRow(logTable, fields); },
      user(id) { return tables[usersTable].find((r) => r.id === id); },
      logRows() { return tables[logTable]; },
      writes() { return requests.filter((r) => r.method !== 'GET'); },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createFakeBaserow };
  else root.createFakeBaserow = createFakeBaserow;
})(typeof self !== 'undefined' ? self : this);
