// One-off check of notes-baserow.js against the REAL Baserow (tables 749 +
// 794). Writes only to a throwaway Users row it creates itself (PSID
// TEST-NOTEBAR-<time>), and deletes that row and its log rows at the end,
// even when a check fails. Never touches a real customer.
//
// Run: node tests/notes-real-baserow.js
// Credentials: BASEROW_URL + BASEROW_TOKEN from the environment, else from
// ../../ec2-login/lambda/.env. The token needs create/update/delete on 749
// and create/read/delete on 794 (delete only for the clean-up).
const fs = require('fs');
const path = require('path');
const { createNotesBackend } = require('../notes-baserow.js');

function env() {
  const out = { ...process.env };
  if (out.BASEROW_URL && out.BASEROW_TOKEN) return out;
  const file = path.join(__dirname, '../../../ec2-login/lambda/.env');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !out[m[1]]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const E = env();
const BASE = E.BASEROW_URL.replace(/\/+$/, '');
const USERS = E.NOTES_USERS_TABLE || '749';
const LOG = E.NOTES_LOG_TABLE || '794';
const H = { Authorization: 'Token ' + E.BASEROW_TOKEN, 'Content-Type': 'application/json' };
const PSID = 'TEST-NOTEBAR-' + Date.now();
const UID = 'test-uid-' + Date.now();

const results = [];
const check = (name, ok, extra) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);

async function rest(method, p, body) {
  const r = await fetch(`${BASE}/api/database/rows/table/${p}`, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const backend = createNotesBackend({
    fetch,
    getConfig: async () => ({ baseUrl: BASE, token: E.BASEROW_TOKEN, usersTableId: USERS, logTableId: LOG }),
  });
  let row = null;
  try {
    row = await rest('POST', `${USERS}/?user_field_names=true`, { PSID, UID, Name: 'Notebar Test' });
    check('throwaway Users row created', !!row.id, `row #${row.id}, PSID ${PSID}`);

    const loaded = await backend.load(PSID);
    check('load reads the new fields', loaded.ok && loaded.rowId === row.id && loaded.notes.balance === '' && loaded.baserowName === 'Notebar Test', JSON.stringify(loaded));

    const msg = { psid: PSID, rowId: row.id, uid: UID, name: 'Notebar Test', changedBy: 'Notebar Test Script' };
    const saved = await backend.save({ ...msg, expected: { balance: '' }, next: { balance: 'RM 1.23 test' } });
    check('save writes and logs', saved.ok && saved.logged === true && saved.saved.balance === 'RM 1.23 test' && !saved.raced, JSON.stringify(saved));

    const after = await rest('GET', `${USERS}/${row.id}/?user_field_names=true`);
    check('row holds the value + signature', after.Balance === 'RM 1.23 test' && after.Note_Updated_By === 'Notebar Test Script' && !!after.Note_Updated_At, JSON.stringify({ b: after.Balance, by: after.Note_Updated_By, at: after.Note_Updated_At }));

    const logs = await rest('GET', `${LOG}/?user_field_names=true&filter__PSID__equal=${encodeURIComponent(PSID)}`);
    const l = logs.results[0] || {};
    check('one log row with every field', logs.count === 1 && l.Field?.value === 'Balance' && l.Old_Value === '' && l.New_Value === 'RM 1.23 test' &&
      l.Changed_By === 'Notebar Test Script' && !!l.Changed_At && l.UID === UID && l.Name === 'Notebar Test' && l.User?.[0]?.id === row.id, JSON.stringify(l));

    await rest('PATCH', `${USERS}/${row.id}/?user_field_names=true`, { Balance: 'changed elsewhere' });
    const conflict = await backend.save({ ...msg, expected: { balance: 'RM 1.23 test' }, next: { balance: 'RM 9' } });
    check('conflict when the field changed meanwhile', conflict.code === 'conflict' && conflict.current.balance === 'changed elsewhere', JSON.stringify(conflict));

    const named = await backend.save({ ...msg, name: 'Someone Else', expected: { note: '' }, next: { note: 'x' } });
    check('name check uses the real Baserow name', named.code === 'name-check' && named.baserowName === 'Notebar Test', JSON.stringify(named));

    const hist = await backend.history(PSID);
    check('history reads the log', hist.ok && hist.rows.length === 1 && hist.rows[0].field === 'Balance', JSON.stringify(hist));

    const review = await backend.unlinkReview({ psid: PSID, uid: UID });
    check('unlink review sees this chat\'s change', review.ok && review.items.length === 1 && review.items[0].chatValue === 'RM 1.23 test' && review.items[0].restorable === false, JSON.stringify(review));
  } catch (err) {
    results.push('FAIL  ' + err.message);
  } finally {
    // Clean up: log rows for the throwaway PSID, then the row itself.
    try {
      const logs = await rest('GET', `${LOG}/?user_field_names=true&size=200&filter__PSID__equal=${encodeURIComponent(PSID)}`);
      for (const r of logs.results) await rest('DELETE', `${LOG}/${r.id}/`);
      if (row) await rest('DELETE', `${USERS}/${row.id}/`);
      const left = await rest('GET', `${USERS}/?user_field_names=true&filter__PSID__equal=${encodeURIComponent(PSID)}`);
      check('clean-up: throwaway row and its log rows deleted', left.count === 0);
    } catch (err) {
      results.push(`FAIL  clean-up — ${err.message}. Delete PSID ${PSID} from tables ${USERS} and ${LOG} by hand.`);
    }
  }
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(failed ? failed + ' FAILED' : 'ALL ' + results.length + ' PASS');
  process.exit(failed ? 1 : 0);
})();
