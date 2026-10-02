// Voice message transcription — loaded by background.js (importScripts) and
// by tests/voice-transcribe.test.js (require). Pure: everything it touches
// comes in through createVoiceTranscriber({ fetch, getKey, sleep }).
//
// Downloads Meta's voice clip (cdn.fbsbx.com …/audioclip-….mp4 — AAC in an
// MP4 container, sent as-is, no MP3 conversion) and asks Gemini for a
// word-for-word transcript. Spec:
// docs/superpowers/specs/2026-10-02-voice-message-transcript-design.md
(function (root) {
  const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const MODEL = 'gemini-3.5-transcribe';
  // Meta's clip is MP4/AAC; Gemini's audio list has audio/m4a (= MP4 audio).
  const MIME = 'audio/m4a';
  const MAX_BYTES = 15 * 1024 * 1024;   // Gemini inline limit is 20 MB per request
  const RETRY_DELAYS = [2000, 6000];
  const TIMEOUT_MS = 60000;
  const DOWNLOAD_TIMEOUT_MS = 30000;
  // Only used with a general model; the transcribe model takes no prompt.
  const PROMPT = 'Transcribe this voice message word for word in the language(s) actually spoken. ' +
    'Do not translate, summarise or add anything. Write Mandarin and Cantonese in Chinese characters; ' +
    'keep English and Malay as spoken. Return only the transcript; if there is no speech, return an empty string.';

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Live product codes (J3, C5, A12…). Without them the transcribe model wrote
  // Mandarin "J3" as 健三 and "C5" as 西五 (test clips, 2026-10-02).
  const LIVE_CODES = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (let n = 1; n <= 30; n++) LIVE_CODES.push(letter + n);

  function buildRequest(model, base64) {
    const input = [{ type: 'audio', data: base64, mime_type: MIME }];
    const body = { model, input };
    if (/transcribe/.test(model)) body.generation_config = { transcription_config: { mode: { type: 'verbatim' }, custom_vocabulary: LIVE_CODES } };
    else input.unshift({ type: 'text', text: PROMPT });
    return body;
  }

  // null = the response holds no model output at all (not the same as silence).
  function readText(json) {
    if (!json || typeof json !== 'object') return null;
    if (typeof json.output_text === 'string') return json.output_text.trim();
    let found = false;
    const parts = [];
    for (const step of json.steps || []) {
      if (step?.type !== 'model_output') continue;
      found = true;
      for (const c of step.content || []) if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    }
    return found ? parts.join('').trim() : null;
  }

  // Runs fn(signal) with an abort after ms. The deadline covers the body read
  // too (arrayBuffer/json), not just the response headers.
  async function withDeadline(ms, fn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try { return await fn(ctrl.signal); } finally { clearTimeout(timer); }
  }

  function createVoiceTranscriber({ fetch, getKey, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), model = MODEL, timeoutMs = TIMEOUT_MS, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS }) {
    async function download(url) {
      try {
        return await withDeadline(downloadTimeoutMs, async (signal) => {
          const res = await fetch(url, { credentials: 'omit', signal });
          if (!res.ok) return { ok: false, error: 'download_failed', detail: 'HTTP ' + res.status };
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_BYTES) return { ok: false, error: 'too_large' };
          if (!buf.byteLength) return { ok: false, error: 'download_failed', detail: 'empty' };
          return { ok: true, buf };
        });
      } catch (e) {
        return { ok: false, error: 'download_failed', detail: String(e?.message || e) };
      }
    }

    // One Gemini attempt: { ok, text } | { ok: false, status } | throws (network, timeout).
    function postOnce(key, body) {
      return withDeadline(timeoutMs, async (signal) => {
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) return { ok: false, status: res.status };
        let json = null;
        try { json = await res.json(); } catch (e) { if (signal.aborted) throw e; }
        return { ok: true, text: readText(json) };
      });
    }

    async function callGemini(key, body) {
      for (let attempt = 0; ; attempt++) {
        let retryable, detail;
        try {
          const r = await postOnce(key, body);
          if (r.ok) return r.text === null ? { ok: false, error: 'bad_response' } : { ok: true, text: r.text };
          retryable = r.status === 429 || r.status >= 500;
          detail = 'HTTP ' + r.status;
        } catch (e) {
          retryable = true;
          detail = String(e?.message || e);
        }
        if (!retryable || attempt >= RETRY_DELAYS.length) return { ok: false, error: 'gemini_failed', detail };
        await sleep(RETRY_DELAYS[attempt]);
      }
    }

    // Never rejects: background.js passes the result straight to sendResponse.
    async function transcribe({ url } = {}) {
      try {
        if (!/^https:\/\/cdn\.fbsbx\.com\//.test(String(url || ''))) return { ok: false, error: 'bad_url' };
        const key = await getKey();
        if (!key) return { ok: false, error: 'no_key' };
        const dl = await download(url);
        if (!dl.ok) return dl;
        return await callGemini(key, buildRequest(model, toBase64(dl.buf)));
      } catch (e) {
        return { ok: false, error: 'internal', detail: String(e?.message || e) };
      }
    }

    return { transcribe };
  }

  const api = { createVoiceTranscriber, buildRequest, readText, MODEL, MIME, API, PROMPT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceTranscribe = api;
})(typeof self !== 'undefined' ? self : this);
