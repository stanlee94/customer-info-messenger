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

async function openPage(browser, seed, initial) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => results.push('PAGEERROR ' + e.message));
  await page.addInitScript((s) => { window.__seed = s.seed; window.__cimVoicePruneDelay = s.pruneDelay; }, seed);
  await page.addInitScript(stub);
  await page.goto('file://' + path.join(EXT, 'voice-ui-fixture.html'));
  await page.evaluate((items) => window.swapConversation(items), initial);
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

  // ── more sections above this line ──

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter((r) => !r.startsWith('PASS')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
