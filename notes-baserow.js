// Balance / Note backend on Baserow — loaded by background.js (importScripts)
// and by tests/notes-baserow.test.js (require). Pure: everything it touches
// comes in through createNotesBackend({ fetch, getConfig, now }).
//
// Storage: table 749 (Users) fields Balance / Note / Note_Updated_By /
// Note_Updated_At on the customer's own row, and the append-only
// Customer Note Log table (PSID, User → 749, Name, Field, Old_Value,
// New_Value, Changed_By, Changed_At, UID) — one log row per changed field.
//
// Rules (see docs/superpowers/specs/2026-09-29-balance-note-bar-design.md):
//  - Never create a Users row: a missing, duplicated, deleted or re-assigned
//    row blocks the save and says which.
//  - Field-level saves: only fields the agent changed are written, each
//    checked against the value the agent started from.
//  - Name check at save time against the FRESH Baserow name: a different or
//    blank name needs the agent to confirm that exact name.
//  - Baserow has no conditional write, so after writing we read the row back;
//    a field someone else overwrote in that instant comes back as `raced`.
(function (root) {
  const FIELDS = { balance: 'Balance', note: 'Note' };

  function normName(s) {
    return String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function sameName(a, b) {
    return !!normName(a) && normName(a) === normName(b);
  }

  const clean = (v) => String(v ?? '').trim();

  function notesOf(row) {
    return {
      balance: clean(row.Balance),
      note: clean(row.Note),
      updatedBy: clean(row.Note_Updated_By),
      updatedAt: row.Note_Updated_At || '',
    };
  }

  function fail(code, error, extra) {
    return { ok: false, code, error, ...extra };
  }

  // Agents read these, so they say what happened and what to do — never a raw
  // "Failed to fetch". `code` lets the caller tell them apart.
  function apiError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function httpError(status) {
    if (status >= 500) return apiError('server', `Baserow is having a problem (error ${status}). Try again in a minute.`);
    if (status === 401 || status === 403) {
      return apiError('error', `Baserow refused the request (error ${status}) — the extension’s Baserow token may not have permission.`);
    }
    return apiError('error', `Baserow rejected the request (error ${status}).`);
  }

  // timeoutMs: a Baserow that hangs instead of failing must not leave the bar
  // on "Saving…" for minutes. Retrying after a timeout is safe — a write that
  // did land already matches the agent's value, which is not a conflict.
  function createNotesBackend({ fetch, getConfig, now = () => new Date().toISOString(), timeoutMs = 15000 }) {
    async function api(config, method, path, body) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (ctrl) ctrl.abort();
          reject(apiError('timeout', 'Baserow isn’t answering. Press Retry.'));
        }, timeoutMs);
      });
      let res;
      try {
        res = await Promise.race([
          Promise.resolve().then(() => fetch(`${config.baseUrl}/api/database/rows/table/${path}`, {
            method,
            headers: { Authorization: `Token ${config.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            ...(ctrl ? { signal: ctrl.signal } : {}),
          })),
          timeout,
        ]);
        if (res.status === 404) return { notFound: true };
        if (!res.ok) throw httpError(res.status);
        return { data: await Promise.race([res.json(), timeout]) };
      } catch (err) {
        if (err && err.code) throw err;
        // fetch itself failed: no connection, DNS, CORS, connection reset.
        throw apiError('offline', 'Can’t reach Baserow. Check your internet, then press Retry.');
      } finally {
        clearTimeout(timer);
      }
    }

    async function withConfig(needLog, fn) {
      const config = await getConfig();
      if (!config.baseUrl || !config.token || !config.usersTableId || (needLog && !config.logTableId)) {
        return fail('not-configured', needLog && !config.logTableId && config.baseUrl && config.token
          ? 'The note log table id is not set — fill it in on the extension options page.'
          : 'Baserow is not configured — set it up on the extension options page.');
      }
      try {
        return await fn(config);
      } catch (err) {
        return fail((err && err.code) || 'error', String((err && err.message) || err));
      }
    }

    async function rowsByPsid(config, psid) {
      const r = await api(config, 'GET', `${config.usersTableId}/?user_field_names=true&size=10&filter__PSID__equal=${encodeURIComponent(psid)}`);
      return r.notFound ? [] : r.data.results || [];
    }

    async function rowById(config, rowId) {
      const r = await api(config, 'GET', `${config.usersTableId}/${encodeURIComponent(rowId)}/?user_field_names=true`);
      return r.notFound ? null : r.data;
    }

    async function load(psid) {
      if (!psid) return fail('bad-request', 'Missing PSID.');
      return withConfig(false, async (config) => {
        const rows = await rowsByPsid(config, psid);
        if (!rows.length) return fail('missing', 'Baserow has no Users row for this PSID.');
        if (rows.length > 1) return fail('duplicate', 'Baserow has more than one Users row for this PSID.', { rowIds: rows.map((r) => r.id) });
        const row = rows[0];
        return { ok: true, rowId: row.id, baserowName: clean(row.Name), notes: notesOf(row) };
      });
    }

    // opts.skipNameCheck — only for unlinkRevert, which writes to the row of
    // the customer the chat was wrongly linked to (whose name never matches).
    async function save(msg, opts = {}) {
      const psid = clean(msg && msg.psid);
      const changedBy = clean(msg && msg.changedBy);
      if (!changedBy) return fail('no-identity', 'No staff name — set it on the extension options page.');
      if (!psid || !msg.rowId) return fail('bad-request', 'Missing customer id.');
      const fields = Object.keys(FIELDS).filter((f) => msg.next && f in msg.next);
      if (!fields.length) return fail('bad-request', 'Nothing to save.');
      const expected = {};
      const next = {};
      for (const f of fields) {
        expected[f] = clean(msg.expected && msg.expected[f]);
        next[f] = clean(msg.next[f]);
      }

      return withConfig(true, async (config) => {
        // 1. The row must still exist and still be this customer's.
        const row = await rowById(config, msg.rowId);
        if (!row) return fail('row-deleted', 'This customer\'s Baserow row was deleted.');
        if (clean(row.PSID) !== psid) return fail('row-mismatch', 'This Baserow row now belongs to a different PSID.', { otherPsid: clean(row.PSID) });

        // 2. Name check against what Baserow says right now.
        if (!opts.skipNameCheck) {
          const baserowName = clean(row.Name);
          const confirmed = typeof msg.confirmedBaserowName === 'string' && clean(msg.confirmedBaserowName) === baserowName;
          if (!confirmed && (!baserowName || !sameName(baserowName, msg.name))) {
            return fail('name-check', baserowName ? 'Baserow names a different customer for this PSID.' : 'Baserow has no name for this PSID.', {
              reason: baserowName ? 'different' : 'blank', baserowName,
            });
          }
        }

        // 3. Field-level conflict check: a field is in conflict only if it
        // changed since the agent loaded it AND not to the agent's own value.
        const current = notesOf(row);
        const conflicted = fields.filter((f) => current[f] !== expected[f] && current[f] !== next[f]);
        if (conflicted.length) return fail('conflict', 'Changed by someone else while you were editing.', { fields: conflicted, current });

        // 4. Write only the changed fields, signed.
        const at = now();
        const body = { Note_Updated_By: changedBy, Note_Updated_At: at };
        for (const f of fields) body[FIELDS[f]] = next[f];
        const patched = await api(config, 'PATCH', `${config.usersTableId}/${encodeURIComponent(row.id)}/?user_field_names=true`, body);
        if (patched.notFound) return fail('row-deleted', 'This customer\'s Baserow row was deleted.');

        // 5. Read back: someone else may have written in the same instant.
        let after = null;
        try { after = await rowById(config, row.id); } catch (e) { after = null; }
        const stored = after ? notesOf(after) : { ...current, ...next, updatedBy: changedBy, updatedAt: at };
        const racedFields = after ? fields.filter((f) => stored[f] !== next[f]) : [];

        // 6. History: one row per field whose value really changed.
        const items = fields.filter((f) => current[f] !== next[f]).map((f) => ({
          PSID: psid, User: [row.id], Name: clean(msg.name), Field: FIELDS[f],
          Old_Value: current[f], New_Value: next[f], Changed_By: changedBy, Changed_At: at, UID: clean(msg.uid),
        }));
        let logged = true;
        if (items.length) {
          try {
            const r = await api(config, 'POST', `${config.logTableId}/batch/?user_field_names=true`, { items });
            if (r.notFound) logged = false;
          } catch (e) {
            logged = false;
          }
        }

        const out = { ok: true, logged, saved: stored };
        if (racedFields.length) out.raced = { fields: racedFields, by: stored.updatedBy, at: stored.updatedAt };
        return out;
      });
    }

    function logRowOut(r) {
      return {
        psid: clean(r.PSID),
        name: clean(r.Name),
        field: (r.Field && r.Field.value) || '',
        oldValue: r.Old_Value || '',
        newValue: r.New_Value || '',
        changedBy: clean(r.Changed_By),
        changedAt: r.Changed_At || '',
        uid: clean(r.UID),
      };
    }

    // Oldest first. Baserow can't sort by row id (`order_by=id` is a 400), so
    // sort here: ids only grow, so id order is the order the changes happened.
    async function logRows(config, psid, extraFilter) {
      const r = await api(config, 'GET', `${config.logTableId}/?user_field_names=true&size=200` +
        `&filter__PSID__equal=${encodeURIComponent(psid)}${extraFilter}`);
      return r.notFound ? [] : (r.data.results || []).slice().sort((a, b) => a.id - b.id).map(logRowOut);
    }

    async function history(psid) {
      if (!psid) return fail('bad-request', 'Missing PSID.');
      return withConfig(true, async (config) => ({ ok: true, rows: (await logRows(config, psid, '')).reverse() }));
    }

    // What this chat (UID) saved to this PSID, per field: the value before
    // the chat's first change, the chat's last value, and whether the field
    // still holds it (if not, someone changed it since and we leave it alone).
    async function unlinkReview({ psid, uid } = {}) {
      psid = clean(psid);
      uid = clean(uid);
      if (!psid || !uid) return fail('bad-request', 'Missing PSID or conversation id.');
      return withConfig(true, async (config) => {
        const entries = await logRows(config, psid, `&filter__UID__equal=${encodeURIComponent(uid)}`);
        const rows = entries.length ? await rowsByPsid(config, psid) : [];
        const row = rows.length === 1 ? rows[0] : null;
        const items = [];
        if (row) {
          const cur = notesOf(row);
          for (const [f, label] of Object.entries(FIELDS)) {
            const mine = entries.filter((e) => e.field === label);
            if (!mine.length) continue;
            const first = mine[0];
            const last = mine[mine.length - 1];
            if (first.oldValue === last.newValue) continue;
            items.push({
              field: f, before: first.oldValue, chatValue: last.newValue, current: cur[f],
              changedBy: last.changedBy, changedAt: last.changedAt, restorable: cur[f] === last.newValue,
            });
          }
        }
        return { ok: true, rowId: row ? row.id : null, baserowName: row ? clean(row.Name) : '', items };
      });
    }

    // Put back the values from before this chat's changes. Same checks as a
    // save (row still this PSID's, field unchanged since the review) except
    // the name check, and the history says it was an undo.
    async function unlinkRevert({ psid, rowId, uid, name, changedBy, fields } = {}) {
      const expected = {};
      const next = {};
      for (const [f, v] of Object.entries(fields || {})) {
        if (!(f in FIELDS)) continue;
        expected[f] = v.from;
        next[f] = v.to;
      }
      const by = clean(changedBy);
      return save({ psid, rowId, uid, name, expected, next, changedBy: by ? `${by} (undo on unlink)` : '' }, { skipNameCheck: true });
    }

    return { load, save, history, unlinkReview, unlinkRevert };
  }

  const api = { createNotesBackend, sameName, normName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NotesBaserow = api;
})(typeof self !== 'undefined' ? self : this);
