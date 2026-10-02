// Balance / Note backend (notes-baserow.js) against an in-memory Baserow.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBaserow } = require('./fake-baserow.js');
const { createNotesBackend, sameName } = require('../notes-baserow.js');

const PSID = '25881234561194';
const OTHER = '25889999990077';
const UID = '111';
const NOW = '2026-10-02T03:00:00.000Z';

function setup(config = {}, opts = {}) {
  const fake = createFakeBaserow();
  const backend = createNotesBackend({
    fetch: fake.fetch,
    getConfig: async () => ({ baseUrl: 'https://baserow.test', token: 'tok', usersTableId: '749', logTableId: '794', ...config }),
    now: () => NOW,
    ...opts,
  });
  return { fake, backend };
}

const never = () => new Promise(() => {});

function customer(fake, extra = {}) {
  return fake.addUser({ PSID, UID, Name: 'Tan Mei Ling', Balance: '', Note: '', Note_Updated_By: '', Note_Updated_At: null, ...extra });
}

function saveMsg(row, extra = {}) {
  return { psid: PSID, rowId: row.id, uid: UID, name: 'Tan Mei Ling', changedBy: 'Angel Chok', expected: { balance: '' }, next: { balance: 'RM 19.90 credit' }, ...extra };
}

// ── load ────────────────────────────────────────────────────────────────────

test('load returns the stored balance, note, signature, row id and Baserow name', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Balance: 'RM 5', Note: 'call first', Note_Updated_By: 'Siti', Note_Updated_At: '2026-10-01T02:00:00Z' });
  const res = await backend.load(PSID);
  assert.deepEqual(res, {
    ok: true, rowId: row.id, baserowName: 'Tan Mei Ling',
    notes: { balance: 'RM 5', note: 'call first', updatedBy: 'Siti', updatedAt: '2026-10-01T02:00:00Z' },
  });
});

test('load reports a PSID with no Users row as missing', async () => {
  const { backend } = setup();
  const res = await backend.load(PSID);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing');
});

test('load refuses a PSID that has two Users rows', async () => {
  const { fake, backend } = setup();
  const a = customer(fake);
  const b = customer(fake);
  const res = await backend.load(PSID);
  assert.equal(res.code, 'duplicate');
  assert.deepEqual(res.rowIds, [a.id, b.id]);
});

test('load without Baserow settings says so instead of calling out', async () => {
  const { fake, backend } = setup({ token: '' });
  const res = await backend.load(PSID);
  assert.equal(res.code, 'not-configured');
  assert.equal(fake.requests.length, 0);
});

test('load explains a Baserow server error in plain words', async () => {
  const { fake, backend } = setup();
  fake.before(() => ({ status: 503, body: { detail: 'down' } }));
  const res = await backend.load(PSID);
  assert.equal(res.code, 'server');
  assert.equal(res.error, 'Baserow is having a problem (error 503). Try again in a minute.');
});

test('load gives up on a Baserow that does not answer', async () => {
  const { fake, backend } = setup({}, { timeoutMs: 30 });
  fake.before(never);
  const started = Date.now();
  const res = await backend.load(PSID);
  assert.ok(Date.now() - started < 1000);
  assert.equal(res.code, 'timeout');
  assert.equal(res.error, 'Baserow isn’t answering. Press Retry.');
});

test('a refused token is reported as a permission problem', async () => {
  const { fake, backend } = setup();
  fake.before(() => ({ status: 403, body: { error: 'ERROR_NO_PERMISSION_TO_TABLE' } }));
  const res = await backend.load(PSID);
  assert.equal(res.code, 'error');
  assert.equal(res.error, 'Baserow refused the request (error 403) — the extension’s Baserow token may not have permission.');
});

// ── save ────────────────────────────────────────────────────────────────────

test('save writes only the changed field, signs it, and logs one row', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Note: 'keep me' });
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, true);
  assert.equal(res.logged, true);
  assert.deepEqual(res.saved, { balance: 'RM 19.90 credit', note: 'keep me', updatedBy: 'Angel Chok', updatedAt: NOW });

  const patch = fake.writes().find((r) => r.method === 'PATCH');
  assert.deepEqual(patch.body, { Balance: 'RM 19.90 credit', Note_Updated_By: 'Angel Chok', Note_Updated_At: NOW });

  assert.deepEqual(fake.logRows().map(({ id, ...r }) => r), [{
    PSID, User: [row.id], Name: 'Tan Mei Ling', Field: 'Balance', Old_Value: '', New_Value: 'RM 19.90 credit',
    Changed_By: 'Angel Chok', Changed_At: NOW, UID,
  }]);
});

test('save leaves a field it did not change alone, even if someone else changed it', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.user(row.id).Note = 'Siti: refunded'; // another agent, after our load
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, true);
  assert.equal(fake.user(row.id).Note, 'Siti: refunded');
  assert.equal(res.saved.note, 'Siti: refunded');
});

test('save with both fields changed writes two log rows in one request', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Balance: 'RM 5', Note: 'old' });
  const res = await backend.save(saveMsg(row, { expected: { balance: 'RM 5', note: 'old' }, next: { balance: '', note: 'new' } }));
  assert.equal(res.ok, true);
  const batches = fake.writes().filter((r) => r.batch);
  assert.equal(batches.length, 1);
  assert.deepEqual(fake.logRows().map((r) => [r.Field, r.Old_Value, r.New_Value]), [['Balance', 'RM 5', ''], ['Note', 'old', 'new']]);
});

test('save refuses when the same field changed since the agent loaded it', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  Object.assign(fake.user(row.id), { Balance: 'RM 10', Note_Updated_By: 'Siti', Note_Updated_At: '2026-10-02T02:59:00Z' });
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'conflict');
  assert.deepEqual(res.fields, ['balance']);
  assert.deepEqual(res.current, { balance: 'RM 10', note: '', updatedBy: 'Siti', updatedAt: '2026-10-02T02:59:00Z' });
  assert.equal(fake.writes().length, 0);
});

test('save is not a conflict when the other agent typed the same value', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.user(row.id).Balance = 'RM 19.90 credit';
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, true);
  assert.equal(fake.logRows().length, 0); // nothing actually changed
});

test('save refuses when the row was deleted after the chat opened', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.tables['749'].length = 0;
  const res = await backend.save(saveMsg(row));
  assert.equal(res.code, 'row-deleted');
  assert.equal(fake.writes().length, 0);
});

test('save refuses when the row now belongs to another PSID', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.user(row.id).PSID = OTHER;
  const res = await backend.save(saveMsg(row));
  assert.equal(res.code, 'row-mismatch');
  assert.equal(res.otherPsid, OTHER);
  assert.equal(fake.writes().length, 0);
});

test('save without a staff name makes no request', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  const res = await backend.save(saveMsg(row, { changedBy: '  ' }));
  assert.equal(res.code, 'no-identity');
  assert.equal(fake.requests.length, 0);
});

test('save trims whitespace before comparing and writing', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Balance: 'RM 5' });
  const res = await backend.save(saveMsg(row, { expected: { balance: ' RM 5 ' }, next: { balance: '  RM 6\n' } }));
  assert.equal(res.ok, true);
  assert.equal(fake.user(row.id).Balance, 'RM 6');
});

test('save refuses when Baserow names a different customer', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Name: 'Lim Ah Kow' });
  const res = await backend.save(saveMsg(row));
  assert.equal(res.code, 'name-check');
  assert.equal(res.reason, 'different');
  assert.equal(res.baserowName, 'Lim Ah Kow');
  assert.equal(fake.writes().length, 0);
});

test('save goes ahead once the agent confirmed that exact Baserow name', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Name: 'Lim Ah Kow' });
  const res = await backend.save(saveMsg(row, { confirmedBaserowName: 'Lim Ah Kow' }));
  assert.equal(res.ok, true);
});

test('save asks again when the Baserow name changed after the agent confirmed', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Name: 'Lim Ah Kow' });
  fake.user(row.id).Name = 'Someone Else';
  const res = await backend.save(saveMsg(row, { confirmedBaserowName: 'Lim Ah Kow' }));
  assert.equal(res.code, 'name-check');
  assert.equal(res.baserowName, 'Someone Else');
});

test('save asks for confirmation when Baserow has no name, and accepts it', async () => {
  const { fake, backend } = setup();
  const row = customer(fake, { Name: '' });
  const first = await backend.save(saveMsg(row));
  assert.equal(first.code, 'name-check');
  assert.equal(first.reason, 'blank');
  const second = await backend.save(saveMsg(row, { confirmedBaserowName: '' }));
  assert.equal(second.ok, true);
});

test('names match across case, spacing and Unicode width', async () => {
  assert.equal(sameName('Tan  Mei LING', 'tan mei ling'), true);
  assert.equal(sameName('ＴＡＮ Mei Ling', 'Tan Mei Ling'), true);
  assert.equal(sameName('', ''), false);
  const { fake, backend } = setup();
  const row = customer(fake, { Name: ' tan  MEI ling ' });
  assert.equal((await backend.save(saveMsg(row))).ok, true);
});

test('save still succeeds when only the history write fails', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.before((r) => (r.table === '794' ? { status: 500, body: { detail: 'boom' } } : null));
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, true);
  assert.equal(res.logged, false);
  assert.equal(fake.user(row.id).Balance, 'RM 19.90 credit');
});

test('save reports another agent who wrote the same field right after us', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  let patched = false;
  fake.before((r) => {
    if (r.method === 'PATCH') patched = true;
    else if (patched && r.method === 'GET' && r.rowId === row.id) {
      Object.assign(fake.user(row.id), { Balance: 'RM 20', Note_Updated_By: 'Siti', Note_Updated_At: '2026-10-02T03:00:01Z' });
    }
  });
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, true);
  assert.deepEqual(res.raced, { fields: ['balance'], by: 'Siti', at: '2026-10-02T03:00:01Z' });
  assert.equal(res.saved.balance, 'RM 20'); // the agent sees what is really stored
});

test('save without internet says so in plain words, not a throw', async () => {
  const { fake, backend } = setup();
  const row = customer(fake);
  fake.before(() => { throw new TypeError('Failed to fetch'); });
  const res = await backend.save(saveMsg(row));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'offline');
  assert.equal(res.error, 'Can’t reach Baserow. Check your internet, then press Retry.');
});

test('save gives up on a Baserow that does not answer', async () => {
  const { fake, backend } = setup({}, { timeoutMs: 30 });
  const row = customer(fake);
  fake.before(never);
  const res = await backend.save(saveMsg(row));
  assert.equal(res.code, 'timeout');
});

test('retrying a timed-out save that did land is not a conflict', async () => {
  const { fake, backend } = setup({}, { timeoutMs: 30 });
  const row = customer(fake);
  let hang = true;
  fake.before((r) => {
    if (hang && r.method === 'PATCH') {
      hang = false;
      Object.assign(fake.user(row.id), r.body); // the write lands, the answer never comes
      return never();
    }
    return null;
  });
  const first = await backend.save(saveMsg(row));
  assert.equal(first.code, 'timeout');
  const retry = await backend.save(saveMsg(row));
  assert.equal(retry.ok, true);
  assert.equal(fake.user(row.id).Balance, 'RM 19.90 credit');
});

test('save needs the log table id', async () => {
  const { fake, backend } = setup({ logTableId: '' });
  const row = customer(fake);
  const res = await backend.save(saveMsg(row));
  assert.equal(res.code, 'not-configured');
  assert.equal(fake.writes().length, 0);
});

// ── history ─────────────────────────────────────────────────────────────────

test('history lists this customer only, newest first', async () => {
  const { fake, backend } = setup();
  fake.addLog({ PSID, Field: 'Balance', Old_Value: '', New_Value: 'RM 5', Changed_By: 'Siti', Changed_At: '2026-10-01T01:00:00Z', UID, Name: 'Tan Mei Ling', User: [] });
  fake.addLog({ PSID: OTHER, Field: 'Note', Old_Value: '', New_Value: 'x', Changed_By: 'Siti', Changed_At: '2026-10-01T02:00:00Z', UID: '222', Name: 'Lim', User: [] });
  fake.addLog({ PSID, Field: 'Note', Old_Value: '', New_Value: 'hi', Changed_By: 'Angel', Changed_At: '2026-10-01T03:00:00Z', UID, Name: 'Tan Mei Ling', User: [] });
  const res = await backend.history(PSID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows.map((r) => [r.field, r.newValue, r.changedBy]), [['Note', 'hi', 'Angel'], ['Balance', 'RM 5', 'Siti']]);
});

// ── unlink clean-up ─────────────────────────────────────────────────────────

function wrongLinkSetup() {
  const s = setup();
  // The chat (UID 111) was linked to the wrong customer, Lim Ah Kow.
  const row = s.fake.addUser({ PSID: OTHER, UID, Name: 'Lim Ah Kow', Balance: 'RM 50 credit', Note: 'Lim: VIP', Note_Updated_By: 'Angel', Note_Updated_At: NOW });
  s.fake.addLog({ PSID: OTHER, UID: '999', Field: 'Note', Old_Value: '', New_Value: 'Lim: VIP', Changed_By: 'Siti', Changed_At: '2026-09-01T00:00:00Z', Name: 'Lim Ah Kow', User: [row.id] });
  s.fake.addLog({ PSID: OTHER, UID, Field: 'Balance', Old_Value: '', New_Value: 'RM 19.90 credit', Changed_By: 'Angel', Changed_At: '2026-10-02T02:00:00Z', Name: 'Tan Mei Ling', User: [row.id] });
  s.fake.addLog({ PSID: OTHER, UID, Field: 'Balance', Old_Value: 'RM 19.90 credit', New_Value: 'RM 50 credit', Changed_By: 'Angel', Changed_At: '2026-10-02T02:30:00Z', Name: 'Tan Mei Ling', User: [row.id] });
  return { ...s, row };
}

test('unlink review lists what this chat saved to the customer, with the value before it', async () => {
  const { backend, row } = wrongLinkSetup();
  const res = await backend.unlinkReview({ psid: OTHER, uid: UID });
  assert.equal(res.ok, true);
  assert.equal(res.rowId, row.id);
  assert.equal(res.baserowName, 'Lim Ah Kow');
  assert.deepEqual(res.items, [{
    field: 'balance', before: '', chatValue: 'RM 50 credit', current: 'RM 50 credit',
    changedBy: 'Angel', changedAt: '2026-10-02T02:30:00Z', restorable: true,
  }]);
});

test('unlink review marks a field another chat changed since as not restorable', async () => {
  const { fake, backend, row } = wrongLinkSetup();
  fake.user(row.id).Balance = 'RM 0';
  const res = await backend.unlinkReview({ psid: OTHER, uid: UID });
  assert.equal(res.items[0].restorable, false);
  assert.equal(res.items[0].current, 'RM 0');
});

test('unlink review skips a field this chat set and then put back', async () => {
  const { fake, backend } = setup();
  fake.addUser({ PSID: OTHER, UID, Name: 'Lim Ah Kow', Note: '' });
  fake.addLog({ PSID: OTHER, UID, Field: 'Note', Old_Value: '', New_Value: 'oops', Changed_By: 'Angel', Changed_At: NOW, Name: '', User: [] });
  fake.addLog({ PSID: OTHER, UID, Field: 'Note', Old_Value: 'oops', New_Value: '', Changed_By: 'Angel', Changed_At: NOW, Name: '', User: [] });
  const res = await backend.unlinkReview({ psid: OTHER, uid: UID });
  assert.deepEqual(res.items, []);
});

test('unlink review with nothing saved from this chat returns no items', async () => {
  const { fake, backend } = setup();
  customer(fake);
  const res = await backend.unlinkReview({ psid: PSID, uid: UID });
  assert.deepEqual(res.items, []);
});

test('unlink revert puts the old value back without the name check, and logs it', async () => {
  const { fake, backend, row } = wrongLinkSetup();
  const res = await backend.unlinkRevert({
    psid: OTHER, rowId: row.id, uid: UID, name: 'Tan Mei Ling', changedBy: 'Angel',
    fields: { balance: { from: 'RM 50 credit', to: '' } },
  });
  assert.equal(res.ok, true);
  assert.equal(fake.user(row.id).Balance, '');
  assert.equal(fake.user(row.id).Note, 'Lim: VIP');
  const last = fake.logRows().at(-1);
  assert.deepEqual([last.Field, last.Old_Value, last.New_Value, last.Changed_By], ['Balance', 'RM 50 credit', '', 'Angel (undo on unlink)']);
});

test('unlink revert does not overwrite a field changed in the meantime', async () => {
  const { fake, backend, row } = wrongLinkSetup();
  fake.user(row.id).Balance = 'RM 0';
  const res = await backend.unlinkRevert({
    psid: OTHER, rowId: row.id, uid: UID, name: 'Tan Mei Ling', changedBy: 'Angel',
    fields: { balance: { from: 'RM 50 credit', to: '' } },
  });
  assert.equal(res.code, 'conflict');
  assert.equal(fake.user(row.id).Balance, 'RM 0');
});
