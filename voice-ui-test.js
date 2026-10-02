// Voice message transcript + speed — UI test, no network.
// Loads inbox-voice-main.js + inbox-voice.js + styles.css into
// voice-ui-fixture.html (a stand-in thread whose voice bubbles carry fake
// __reactFiber$ chains shaped like Meta's, verified 2026-10-02) with chrome.*
// stubbed: storage in memory, TRANSCRIBE_VOICE answered by a fake that records
// calls and concurrency. It proves logic, not that Meta's real DOM matches —
// check a real tab after any change (Task 6 checklist in the plan).
// Run: node voice-ui-test.js        Screenshots → $OUT_DIR (default <tmp>/voice-ui-shots)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');

const EXT = __dirname;
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), 'voice-ui-shots');
fs.mkdirSync(OUT, { recursive: true });

function silentWav(seconds = 3, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const CLIP_FILE = path.join(OUT, 'audioclip-1790930407000-5271.wav');
const OTHER_FILE = path.join(OUT, 'notification.wav');
fs.writeFileSync(CLIP_FILE, silentWav());
fs.writeFileSync(OTHER_FILE, silentWav());

const src = (id) => `https://cdn.fbsbx.com/v/t59.3654-21/${id}_n.mp4/audioclip-1790930407000-${id}.mp4?oe=6AC55855&dl=1`;

const stub = `
(() => {
  const store = Object.assign({}, window.__seed || {});
  const listeners = [];
  const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
  window.__getNull = 0;
  const local = {
    get(keys, cb) {
      let out = {};
      if (keys == null) { window.__getNull++; out = clone(store); }
      else (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) out[k] = clone(store[k]); });
      const p = new Promise((r) => setTimeout(() => r(out), 0));
      if (cb) p.then(cb);
      return p;
    },
    getKeys(cb) { const p = Promise.resolve(Object.keys(store)); if (cb) p.then(cb); return p; },
    set(obj, cb) {
      const changes = {};
      for (const k in obj) { changes[k] = { oldValue: store[k], newValue: clone(obj[k]) }; store[k] = clone(obj[k]); }
      setTimeout(() => { listeners.forEach((l) => l(changes, 'local')); cb && cb(); }, 0);
      return Promise.resolve();
    },
    remove(keys, cb) {
      const changes = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { changes[k] = { oldValue: store[k] }; delete store[k]; });
      setTimeout(() => { listeners.forEach((l) => l(changes, 'local')); cb && cb(); }, 0);
      return Promise.resolve();
    },
  };
  window.__store = store;
  // Fake background: answers TRANSCRIBE_VOICE after __tx.delay ms.
  window.__tx = { delay: 150, calls: [], inflight: 0, maxInflight: 0, fail: new Set(), mode: '' };
  window.chrome = { storage: { local, onChanged: { addListener: (l) => listeners.push(l) } }, runtime: { lastError: undefined } };
  chrome.runtime.sendMessage = (msg, cb) => {
    if (window.__tx.mode === 'throw') throw new Error('Extension context invalidated.');
    if (msg.type !== 'TRANSCRIBE_VOICE') { cb && cb({ ok: false, error: 'stub' }); return; }
    const tx = window.__tx;
    tx.calls.push({ id: msg.messageId, url: msg.url });
    tx.inflight++; tx.maxInflight = Math.max(tx.maxInflight, tx.inflight);
    setTimeout(() => {
      tx.inflight--;
      if (tx.mode === 'undefined') return cb && cb(undefined);
      const res = tx.fail.has(msg.messageId) ? { ok: false, error: 'gemini_failed', detail: 'HTTP 500' } : { ok: true, text: 'T:' + msg.messageId };
      cb && cb(res);
    }, tx.delay);
  };
})();
`;

const results = [];
function check(name, cond, extra) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function openPage(browser, seed, initial, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await page.addInitScript((s) => { window.__seed = s.seed; window.__cimVoicePruneDelay = s.pruneDelay; }, seed);
  await page.addInitScript(stub);
  await page.goto('file://' + path.join(EXT, 'voice-ui-fixture.html'));
  await page.evaluate((items) => window.swapConversation(items), initial);
  // Optional: park the thread mid-way (top of message `scrollToId`) before our scripts run.
  if (opts.scrollToId) await page.evaluate((id) => { const t = document.getElementById('thread'); t.scrollTop = t.querySelector(`[data-message-id="${id}"]`).offsetTop - t.offsetTop - 4; }, opts.scrollToId);
  page.visibleAtLoad = await page.evaluate(() => [...document.querySelectorAll('a[aria-label="Voice Message"]:not([aria-hidden])')].filter((a) => { const r = a.getBoundingClientRect(), t = document.getElementById('thread').getBoundingClientRect(); return r.bottom > t.top && r.top < t.bottom; }).map((a) => a.__fixtureId));
  await page.addStyleTag({ path: path.join(EXT, 'styles.css') });
  await page.addScriptTag({ path: path.join(EXT, 'inbox-voice-main.js') });
  if (fs.existsSync(path.join(EXT, 'inbox-voice.js'))) await page.addScriptTag({ path: path.join(EXT, 'inbox-voice.js') });
  await page.waitForTimeout(300);
  return page;
}
const settle = (page, ms = 300) => page.waitForTimeout(ms);

// m1 (oldest) … m6 (newest) with text between; the thread shows the bottom only.
const THREAD = [];
for (let i = 1; i <= 6; i++) { THREAD.push({ text: 'hello ' + i }); THREAD.push({ id: 'm' + i, src: src('m' + i), dur: i, mine: i % 2 === 0 }); }

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ── A. Tagging (inbox-voice-main.js) ──
  {
    const page = await openPage(browser, { seed: {} }, THREAD);
    const tags = await page.evaluate(() => [...document.querySelectorAll('a[data-cim-voice-id]')].map((a) => ({
      hidden: a.getAttribute('aria-hidden'), id: a.dataset.cimVoiceId, src: a.dataset.cimVoiceSrc, dur: a.dataset.cimVoiceDur, mine: a.dataset.cimVoiceMine })));
    check('A1 every visible voice button tagged, hidden progress copies not', tags.length === 6 && tags.every((t) => t.hidden === null), JSON.stringify(tags.map((t) => t.id)));
    check('A2 id/src/dur/mine copied from the props', tags.every((t, i) => t.id === 'm' + (i + 1) && t.src === src('m' + (i + 1)) && t.dur === String(i + 1) && t.mine === ((i + 1) % 2 === 0 ? '1' : '0')));
    await page.evaluate((s) => window.addVoice({ id: 'm7', src: s, dur: 3 }), src('m7'));
    await settle(page);
    check('A3 a voice message added later is tagged', await page.evaluate(() => window.anchorOf('m7').dataset.cimVoiceId === 'm7'));
    await page.evaluate((s) => window.reuseVoice('m7', { id: 'm8', src: s, dur: 4 }), src('m8'));
    await settle(page);
    check('A4 node reused for another message is re-tagged', await page.evaluate((s) => { const a = window.anchorOf('m8'); return a.dataset.cimVoiceId === 'm8' && a.dataset.cimVoiceSrc === s; }, src('m8')));
    await page.evaluate(() => { const a = document.createElement('a'); a.setAttribute('aria-label', 'Voice Message'); a.id = 'nofiber'; document.getElementById('thread').append(a); });
    await settle(page);
    check('A5 a voice button without React props is left alone', await page.evaluate(() => !document.getElementById('nofiber').hasAttribute('data-cim-voice-id')));
    check('A6 Meta nodes not moved: hidden copy still inside its wrapper', await page.evaluate(() => [...document.querySelectorAll('a[aria-hidden="true"]')].every((a) => a.parentElement.classList.contains('_1mj4'))));
    await page.close();
  }

  // ── B. Rows, cache, queue, retry (inbox-voice.js) ──
  let savedStore;
  {
    const page = await openPage(browser, { seed: { geminiApiKey: 'k' } }, THREAD, { scrollToId: 'm2' });
    const row = (id) => page.evaluate((i) => { const r = document.querySelector(`.cim-voice[data-cim-voice-for="${i}"]`); return r ? { state: r.dataset.state, text: r.querySelector('.cim-voice-text').textContent, mine: r.classList.contains('cim-voice--mine'), placed: window.clipRootOf(i)?.nextElementSibling === r } : null; }, id);
    const r1 = await row('m1');
    check('B1 a row under each voice message, right after the bubble', (await page.locator('.cim-voice').count()) === 6 && r1 && r1.placed);
    check('B2 pending text before the answer', (await row('m1')).text.startsWith('📝 Transcribing'));
    check('B3 own messages aligned right (mine class)', (await row('m2')).mine && !(await row('m1')).mine);
    await page.waitForFunction(() => window.__tx.calls.length === 6 && window.__tx.inflight === 0, null, { timeout: 8000 });
    const order = await page.evaluate(() => window.__tx.calls.map((c) => c.id));
    const visible = page.visibleAtLoad;
    check('B4 the first request is a message on screen, not the newest off-screen one', visible.length > 0 && !visible.includes('m6') && visible.includes(order[0]), `order ${order} visible at load ${visible}`);
    const rest = order.filter((id) => !visible.includes(id));
    check('B5 the rest newest-first', rest.join() === rest.slice().sort().reverse().join(), rest.join());
    check('B6 never more than 2 in flight', (await page.evaluate(() => window.__tx.maxInflight)) <= 2);
    await settle(page);
    check('B7 every row shows its own transcript', (await Promise.all(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(row))).every((r, i) => r.state === 'done' && r.text === 'T:m' + (i + 1)));
    check('B8 cached per message id', await page.evaluate(() => window.__store['voiceTx:m3']?.t === 'T:m3' && typeof window.__store['voiceTx:m3'].at === 'number'));
    // React drops our row → re-inserted, no new request
    await page.evaluate(() => document.querySelector('.cim-voice[data-cim-voice-for="m2"]').remove());
    await settle(page);
    check('B9 row removed by a re-render comes back with its text, no new request', (await row('m2'))?.text === 'T:m2' && (await page.evaluate(() => window.__tx.calls.length)) === 6);
    // Same message rendered twice → one request, both rows filled
    await page.evaluate((s) => { window.addVoice({ id: 'd1', src: s }); window.addVoice({ id: 'd1', src: s }); }, src('d1'));
    await page.waitForFunction(() => document.querySelectorAll('.cim-voice[data-cim-voice-for="d1"][data-state="done"]').length === 2, null, { timeout: 5000 }).catch(() => {});
    check('B10 same message twice → 1 request, both rows show the text', (await page.evaluate(() => window.__tx.calls.filter((c) => c.id === 'd1').length)) === 1 && (await page.locator('.cim-voice[data-cim-voice-for="d1"][data-state="done"]').count()) === 2);
    // Failure → Retry → success; failures are not cached
    await page.evaluate((s) => { window.__tx.fail.add('f1'); window.addVoice({ id: 'f1', src: s }); window.scrollThread('bottom'); }, src('f1'));
    await page.waitForSelector('.cim-voice[data-cim-voice-for="f1"][data-state="failed"]', { timeout: 5000 });
    check('B11 failure shows "Transcription failed · Retry" and is not cached', (await row('f1')).text === 'Transcription failed · Retry' && !(await page.evaluate(() => 'voiceTx:f1' in window.__store)));
    await page.evaluate(() => window.__tx.fail.delete('f1'));
    await page.click('.cim-voice[data-cim-voice-for="f1"] .cim-voice-retry');
    await page.waitForSelector('.cim-voice[data-cim-voice-for="f1"][data-state="done"]', { timeout: 5000 });
    check('B12 Retry → transcript', (await row('f1')).text === 'T:f1');
    // Service worker died mid-request → undefined → failed
    await page.evaluate((s) => { window.__tx.mode = 'undefined'; window.addVoice({ id: 'u1', src: s }); window.scrollThread('bottom'); }, src('u1'));
    await page.waitForSelector('.cim-voice[data-cim-voice-for="u1"][data-state="failed"]', { timeout: 5000 });
    check('B13 no answer (worker killed) → failed with Retry', !!(await row('u1')));
    // Extension reloaded → sendMessage throws → failed, no page error
    await page.evaluate((s) => { window.__tx.mode = 'throw'; window.addVoice({ id: 'x1', src: s }); window.scrollThread('bottom'); }, src('x1'));
    await page.waitForSelector('.cim-voice[data-cim-voice-for="x1"][data-state="failed"]', { timeout: 5000 });
    check('B14 extension context gone → failed, nothing thrown into the page', !results.some((r) => r.startsWith('PAGEERROR')));
    await page.evaluate(() => { window.__tx.mode = ''; });
    // Late answer must not land on another customer's message
    await page.evaluate((s) => { window.__tx.delay = 800; window.addVoice({ id: 'late1', src: s }); window.scrollThread('bottom'); }, src('late1'));
    await page.waitForFunction(() => window.__tx.calls.some((c) => c.id === 'late1'), null, { timeout: 5000 });
    await page.evaluate((s) => window.swapConversation([{ text: 'other customer' }, { id: 'y1', src: s }]), src('y1'));
    await page.waitForTimeout(1800);
    check('B15 answer for a closed chat never shows under the new chat', (await row('y1'))?.text === 'T:y1' && !(await page.evaluate(() => [...document.querySelectorAll('.cim-voice')].some((r) => r.textContent.includes('T:late1')))));
    // React reuses the y1 node for z1 → row follows
    await page.evaluate((s) => { window.__tx.delay = 150; window.reuseVoice('y1', { id: 'z1', src: s }); }, src('z1'));
    await page.waitForFunction(() => document.querySelector('.cim-voice[data-cim-voice-for="z1"]')?.dataset.state === 'done', null, { timeout: 5000 }).catch(() => {});
    check('B16 reused node → row switches to the new message', (await row('z1'))?.text === 'T:z1' && !(await row('y1')));
    // Key removed → feature off; key back → on
    await page.evaluate(() => chrome.storage.local.set({ geminiApiKey: '' }));
    await settle(page);
    check('B17 no Gemini key → no rows', (await page.locator('.cim-voice').count()) === 0);
    await page.evaluate(() => chrome.storage.local.set({ geminiApiKey: 'k' }));
    await settle(page, 500);
    check('B18 key set again → rows back from cache, no new request', (await row('z1'))?.text === 'T:z1' && (await page.evaluate(() => window.__tx.calls.filter((c) => c.id === 'z1').length)) === 1);
    check('B19 never read the whole store', (await page.evaluate(() => window.__getNull)) === 0);
    await page.screenshot({ path: path.join(OUT, 'B-rows.png') });
    savedStore = await page.evaluate(() => JSON.parse(JSON.stringify(window.__store)));
    await page.close();
  }
  {
    const page = await openPage(browser, { seed: savedStore }, THREAD);
    await settle(page, 600);
    check('B20 reload: transcripts from cache, 0 requests', (await page.evaluate(() => window.__tx.calls.length)) === 0 && (await page.locator('.cim-voice[data-state="done"]').count()) === 6);
    await page.close();
  }
  {
    const page = await openPage(browser, { seed: {} }, THREAD);
    check('B21 no key from the start → no rows, no requests', (await page.locator('.cim-voice').count()) === 0 && (await page.evaluate(() => window.__tx.calls.length)) === 0);
    await page.close();
  }

  // ── C. Speed ──
  {
    const page = await openPage(browser, { seed: { geminiApiKey: 'k' } }, THREAD);
    await page.waitForSelector('.cim-voice .cim-voice-speed button');
    check('C1 chips 1× 1.5× 2× under each voice message, 1× pressed by default', (await page.evaluate(() => [...document.querySelector('.cim-voice .cim-voice-speed').children].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(' '))) === '1×* 1.5× 2×');
    check('C2 default rate attribute = 1', (await page.evaluate(() => document.documentElement.dataset.cimVoiceRate)) === '1');
    await page.click('.cim-voice[data-cim-voice-for="m6"] .cim-voice-speed button[data-rate="2"]');
    await settle(page);
    check('C3 2× saved and mirrored to the page', (await page.evaluate(() => [document.documentElement.dataset.cimVoiceRate, window.__store.voiceSpeed].join())) === '2,2');
    check('C4 every row shows 2× pressed', await page.evaluate(() => [...document.querySelectorAll('.cim-voice')].every((r) => r.querySelector('button[aria-pressed="true"]').dataset.rate === '2')));
    const clipUrl = 'file://' + CLIP_FILE;
    await page.evaluate((u) => window.playClip(u), clipUrl);
    await settle(page, 200);
    check('C5 a voice clip started after choosing 2× plays at 2×, pitch kept', await page.evaluate(() => window.__clip.playbackRate === 2 && window.__clip.preservesPitch === true));
    await page.click('.cim-voice[data-cim-voice-for="m6"] .cim-voice-speed button[data-rate="1.5"]');
    await settle(page);
    check('C6 changing speed while it plays changes the playing clip', (await page.evaluate(() => window.__clip.playbackRate)) === 1.5);
    await page.evaluate(() => window.__clip.load());
    await page.evaluate(() => window.__clip.play().catch(() => {}));
    await settle(page, 200);
    check('C7 rate survives Meta reloading the element (defaultPlaybackRate)', (await page.evaluate(() => window.__clip.playbackRate)) === 1.5);
    await page.evaluate((u) => { window.__other = new Audio(u); window.__other.play().catch(() => {}); }, 'file://' + OTHER_FILE);
    await settle(page, 200);
    check('C8 other sounds on the page are not sped up', (await page.evaluate(() => window.__other.playbackRate)) === 1);
    await page.evaluate(() => chrome.storage.local.set({ geminiApiKey: '' }));
    await settle(page);
    check('C9 feature off → rate attribute removed', (await page.evaluate(() => document.documentElement.dataset.cimVoiceRate)) === undefined);
    await page.close();
  }
  {
    const page = await openPage(browser, { seed: { geminiApiKey: 'k', voiceSpeed: 2 } }, THREAD);
    await page.waitForSelector('.cim-voice .cim-voice-speed button');
    check('C10 saved speed applied on load', (await page.evaluate(() => [document.documentElement.dataset.cimVoiceRate, document.querySelector('.cim-voice button[aria-pressed="true"]').dataset.rate].join())) === '2,2');
    await page.close();
  }

  // ── D. Scrolling up through a long history ──
  {
    const page = await openPage(browser, { seed: { geminiApiKey: 'k' } }, THREAD);
    await page.evaluate(() => { window.__tx.delay = 20; });
    await page.waitForFunction(() => window.__tx.calls.length === 6 && window.__tx.inflight === 0, null, { timeout: 8000 });
    await page.evaluate(() => { window.__cimVoiceStats.maxSyncMs = 0; window.__cimVoiceDebug.maxTagMs = 0; });
    // Meta loads older messages 20 at a time as the agent scrolls up.
    for (let batch = 0; batch < 10; batch++) {
      await page.evaluate((b) => {
        for (let i = 0; i < 20; i++) {
          const n = b * 20 + i;
          window.addText('older ' + n, { prepend: true });
          window.addVoice({ id: 'h' + n, src: `https://cdn.fbsbx.com/v/t59.3654-21/h${n}_n.mp4/audioclip-1-h${n}.mp4?oe=1&dl=1`, prepend: true });
        }
        window.scrollThread('top');
      }, batch);
      await settle(page, 120);
    }
    // While older ones are still queued, the one now at the top must jump ahead.
    await page.evaluate(() => { window.__tx.delay = 300; });
    const before = await page.evaluate(() => window.__tx.calls.length);
    await page.evaluate((s) => { window.addVoice({ id: 'top1', src: s, prepend: true }); window.scrollThread('top'); }, src('top1'));
    await page.waitForFunction(() => window.__tx.calls.some((c) => c.id === 'top1'), null, { timeout: 15000 });
    const pos = await page.evaluate((b) => window.__tx.calls.slice(b).findIndex((c) => c.id === 'top1'), before);
    check('D1 a message scrolled into view jumps the queue', pos >= 0 && pos <= 2, `position ${pos}`);
    await page.evaluate(() => { window.__tx.delay = 20; });
    await page.waitForFunction(() => window.__tx.calls.length === 207 && window.__tx.inflight === 0, null, { timeout: 30000 }).catch(() => {});
    const s = await page.evaluate(() => ({
      tagged: document.querySelectorAll('a[data-cim-voice-id]').length,
      rows: document.querySelectorAll('.cim-voice').length,
      calls: window.__tx.calls.length,
      unique: new Set(window.__tx.calls.map((c) => c.id)).size,
      sync: window.__cimVoiceStats.maxSyncMs,
      tag: window.__cimVoiceDebug.maxTagMs,
      getNull: window.__getNull,
      maxInflight: window.__tx.maxInflight,
    }));
    check('D2 207 voice messages: every one tagged and given one row', s.tagged === 207 && s.rows === 207, JSON.stringify(s));
    check('D3 each transcribed exactly once', s.calls === 207 && s.unique === 207);
    check('D4 isolated sync stays under 5 ms', s.sync < 5, s.sync.toFixed(2) + ' ms');
    check('D5 page-side tagging stays under 5 ms', s.tag < 5, s.tag.toFixed(2) + ' ms');
    check('D6 still ≤2 in flight, whole store never read', s.maxInflight <= 2 && s.getNull === 0);
    await page.close();
  }

  // ── E. Cache pruning ──
  {
    const seed = { geminiApiKey: 'k' };
    for (let i = 0; i < 3010; i++) seed['voiceTx:old' + i] = { t: 'x', at: 1000 + i };
    seed['rfm:123'] = { v: 1, t: 1 };
    const page = await openPage(browser, { seed, pruneDelay: 400 }, THREAD);
    await page.waitForFunction(() => Object.keys(window.__store).filter((k) => k.startsWith('voiceTx:')).length < 3000, null, { timeout: 5000 }).catch(() => {});
    const left = await page.evaluate(() => {
      const keys = Object.keys(window.__store).filter((k) => k.startsWith('voiceTx:old'));
      return { n: keys.length, oldestGone: !('voiceTx:old0' in window.__store) && !('voiceTx:old499' in window.__store), keptNext: 'voiceTx:old500' in window.__store, rfm: 'rfm:123' in window.__store, getNull: window.__getNull };
    });
    check('E1 above 3,000 transcripts → oldest 500 dropped', left.n === 2510 && left.oldestGone && left.keptNext, JSON.stringify(left));
    check('E2 pruning leaves other keys alone and never reads the whole store', left.rfm && left.getNull === 0);
    await page.close();
  }

  // ── more sections above this line ──

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
