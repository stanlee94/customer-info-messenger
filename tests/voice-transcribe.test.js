// Voice transcription module (voice-transcribe.js) against a fake fetch.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceTranscriber, buildRequest, readText, MODEL, MIME, API, PROMPT } = require('../voice-transcribe.js');

const CLIP = 'https://cdn.fbsbx.com/v/t59.3654-21/1_n.mp4/audioclip-1790930407000-5271.mp4?oe=6AC55855&dl=1';
const okJson = (text) => ({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });

// responses: array of handlers for the Gemini endpoint, consumed in order.
function setup({ key = 'k-123', clip = { status: 200, bytes: [104, 105] }, responses = [], timeoutMs } = {}) {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.startsWith('https://cdn.fbsbx.com/')) {
      if (clip.throws) throw new Error('offline');
      const body = () => (clip.byteLength != null ? { byteLength: clip.byteLength } : Uint8Array.from(clip.bytes || []).buffer);
      return { ok: clip.status < 300, status: clip.status, arrayBuffer: async () => body() };
    }
    const h = responses.shift();
    if (!h) throw new Error('unexpected Gemini call');
    return h(opts);
  };
  const t = createVoiceTranscriber({ fetch, getKey: async () => key, sleep: async (ms) => { sleeps.push(ms); }, timeoutMs });
  return { t, calls, sleeps, gemini: () => calls.filter((c) => c.url === API) };
}
const reply = (status, json) => async () => ({ ok: status < 300, status, json: async () => json });

test('buildRequest: transcribe model sends audio only, verbatim mode', () => {
  const body = buildRequest('gemini-3.5-transcribe', 'QUJD');
  assert.equal(body.model, 'gemini-3.5-transcribe');
  assert.deepEqual(body.input, [{ type: 'audio', data: 'QUJD', mime_type: MIME }]);
  assert.deepEqual(body.generation_config, { transcription_config: { mode: { type: 'verbatim' } } });
});

test('buildRequest: a general model gets the prompt first and no transcription config', () => {
  const body = buildRequest('gemini-3.8-flash', 'QUJD');
  assert.deepEqual(body.input[0], { type: 'text', text: PROMPT });
  assert.deepEqual(body.input[1], { type: 'audio', data: 'QUJD', mime_type: MIME });
  assert.equal(body.generation_config, undefined);
});

test('readText: joins model_output text blocks, prefers output_text, null when no output', () => {
  assert.equal(readText(okJson(' 我要 J3 两包 ')), '我要 J3 两包');
  assert.equal(readText({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }), 'ab');
  assert.equal(readText({ output_text: ' hi ' }), 'hi');
  assert.equal(readText({ steps: [{ type: 'model_output', content: [] }] }), '');
  assert.equal(readText({ steps: [] }), null);
  assert.equal(readText(null), null);
});

test('default model is the transcribe model', () => {
  assert.equal(MODEL, 'gemini-3.5-transcribe');
});

test('success: downloads the clip, sends base64 with the key header, returns the text', async () => {
  const { t, calls, gemini } = setup({ responses: [reply(200, okJson('hello'))] });
  const res = await t.transcribe({ url: CLIP, messageId: 'm1' });
  assert.deepEqual(res, { ok: true, text: 'hello' });
  assert.equal(calls[0].url, CLIP);
  assert.equal(calls[0].opts.credentials, 'omit');
  const g = gemini()[0];
  assert.equal(g.opts.method, 'POST');
  assert.equal(g.opts.headers['x-goog-api-key'], 'k-123');
  assert.equal(JSON.parse(g.opts.body).input.at(-1).data, 'aGk=');   // bytes "hi"
});

test('empty transcript is a success with empty text', async () => {
  const { t } = setup({ responses: [reply(200, okJson(''))] });
  assert.deepEqual(await t.transcribe({ url: CLIP }), { ok: true, text: '' });
});

test('only cdn.fbsbx.com URLs are fetched', async () => {
  const { t, calls } = setup();
  for (const url of ['https://evil.example/audioclip.mp4', 'http://cdn.fbsbx.com/x.mp4', '', undefined]) {
    assert.equal((await t.transcribe({ url })).error, 'bad_url');
  }
  assert.equal(calls.length, 0);
});

test('no key → no_key, nothing fetched', async () => {
  const { t, calls } = setup({ key: '' });
  assert.equal((await t.transcribe({ url: CLIP })).error, 'no_key');
  assert.equal(calls.length, 0);
});

test('expired clip (403) → download_failed, Gemini not called, not retried', async () => {
  const { t, gemini, sleeps } = setup({ clip: { status: 403 } });
  const res = await t.transcribe({ url: CLIP });
  assert.equal(res.error, 'download_failed');
  assert.equal(res.detail, 'HTTP 403');
  assert.equal(gemini().length, 0);
  assert.deepEqual(sleeps, []);
});

test('clip download network error → download_failed', async () => {
  const { t } = setup({ clip: { throws: true } });
  assert.equal((await t.transcribe({ url: CLIP })).error, 'download_failed');
});

test('clip over 15 MB → too_large, Gemini not called', async () => {
  const { t, gemini } = setup({ clip: { status: 200, byteLength: 15 * 1024 * 1024 + 1 } });
  assert.equal((await t.transcribe({ url: CLIP })).error, 'too_large');
  assert.equal(gemini().length, 0);
});

test('429 then 200 → retried once after 2 s', async () => {
  const { t, sleeps, gemini } = setup({ responses: [reply(429, {}), reply(200, okJson('ok'))] });
  assert.deepEqual(await t.transcribe({ url: CLIP }), { ok: true, text: 'ok' });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(gemini().length, 2);
});

test('500 three times → gemini_failed after 2 s and 6 s waits', async () => {
  const { t, sleeps, gemini } = setup({ responses: [reply(500, {}), reply(503, {}), reply(500, {})] });
  const res = await t.transcribe({ url: CLIP });
  assert.equal(res.error, 'gemini_failed');
  assert.equal(res.detail, 'HTTP 500');
  assert.deepEqual(sleeps, [2000, 6000]);
  assert.equal(gemini().length, 3);
});

test('400 (bad key / bad request) → not retried', async () => {
  const { t, sleeps, gemini } = setup({ responses: [reply(400, { error: { message: 'API key not valid' } })] });
  const res = await t.transcribe({ url: CLIP });
  assert.equal(res.error, 'gemini_failed');
  assert.deepEqual(sleeps, []);
  assert.equal(gemini().length, 1);
});

test('network error is retried', async () => {
  const { t, sleeps } = setup({ responses: [async () => { throw new Error('reset'); }, reply(200, okJson('ok'))] });
  assert.deepEqual(await t.transcribe({ url: CLIP }), { ok: true, text: 'ok' });
  assert.deepEqual(sleeps, [2000]);
});

test('a Gemini call that never answers times out and is retried', async () => {
  const hang = (opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const { t, sleeps, gemini } = setup({ timeoutMs: 30, responses: [hang, reply(200, okJson('late ok'))] });
  assert.deepEqual(await t.transcribe({ url: CLIP }), { ok: true, text: 'late ok' });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(gemini().length, 2);
});

test('200 with an unreadable body → bad_response', async () => {
  const { t } = setup({ responses: [reply(200, { status: 'failed' })] });
  assert.equal((await t.transcribe({ url: CLIP })).error, 'bad_response');
});

// ── Fixes from the final review (I2): nothing may hang or reject ──
test('a clip download that never answers times out → download_failed', async () => {
  const calls = [];
  const fetch = (url, opts) => { calls.push(url); return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))); };
  const t = createVoiceTranscriber({ fetch, getKey: async () => 'k', sleep: async () => {}, downloadTimeoutMs: 30 });
  const res = await t.transcribe({ url: CLIP });
  assert.equal(res.error, 'download_failed');
  assert.equal(calls.length, 1);
});

test('a clip body that stalls mid-read times out → download_failed', async () => {
  const fetch = async (url, opts) => ({ ok: true, status: 200, arrayBuffer: () => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const t = createVoiceTranscriber({ fetch, getKey: async () => 'k', sleep: async () => {}, downloadTimeoutMs: 30 });
  assert.equal((await t.transcribe({ url: CLIP })).error, 'download_failed');
});

test('a Gemini body that stalls after the headers times out and is retried', async () => {
  let n = 0;
  const fetch = async (url, opts) => {
    if (url.startsWith('https://cdn.fbsbx.com/')) return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from([1]).buffer };
    n++;
    if (n === 1) return { ok: true, status: 200, json: () => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))) };
    return { ok: true, status: 200, json: async () => okJson('ok') };
  };
  const t = createVoiceTranscriber({ fetch, getKey: async () => 'k', sleep: async () => {}, timeoutMs: 30 });
  assert.deepEqual(await t.transcribe({ url: CLIP }), { ok: true, text: 'ok' });
  assert.equal(n, 2);
});

test('transcribe never rejects: an unexpected throw becomes {ok:false, error:"internal"}', async () => {
  const t = createVoiceTranscriber({ fetch: async () => { throw new Error('x'); }, getKey: async () => { throw new Error('storage gone'); } });
  const res = await t.transcribe({ url: CLIP });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'internal');
});
