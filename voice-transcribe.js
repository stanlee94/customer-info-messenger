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

  function buildRequest(model, base64) {
    const input = [{ type: 'audio', data: base64, mime_type: MIME }];
    const body = { model, input };
    if (/transcribe/.test(model)) body.generation_config = { transcription_config: { mode: { type: 'verbatim' } } };
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

  function createVoiceTranscriber({ fetch, getKey, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), model = MODEL, timeoutMs = TIMEOUT_MS }) {
    async function download(url) {
      let res;
      try { res = await fetch(url, { credentials: 'omit' }); } catch (e) {
        return { ok: false, error: 'download_failed', detail: String(e?.message || e) };
      }
      if (!res.ok) return { ok: false, error: 'download_failed', detail: 'HTTP ' + res.status };
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BYTES) return { ok: false, error: 'too_large' };
      if (!buf.byteLength) return { ok: false, error: 'download_failed', detail: 'empty' };
      return { ok: true, buf };
    }

    async function postOnce(key, body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
    }

    async function callGemini(key, body) {
      for (let attempt = 0; ; attempt++) {
        let retryable, detail;
        try {
          const res = await postOnce(key, body);
          if (res.ok) {
            const text = readText(await res.json().catch(() => null));
            return text === null ? { ok: false, error: 'bad_response' } : { ok: true, text };
          }
          retryable = res.status === 429 || res.status >= 500;
          detail = 'HTTP ' + res.status;
        } catch (e) {
          retryable = true;
          detail = String(e?.message || e);
        }
        if (!retryable || attempt >= RETRY_DELAYS.length) return { ok: false, error: 'gemini_failed', detail };
        await sleep(RETRY_DELAYS[attempt]);
      }
    }

    async function transcribe({ url } = {}) {
      if (!/^https:\/\/cdn\.fbsbx\.com\//.test(String(url || ''))) return { ok: false, error: 'bad_url' };
      const key = await getKey();
      if (!key) return { ok: false, error: 'no_key' };
      const dl = await download(url);
      if (!dl.ok) return dl;
      return callGemini(key, buildRequest(model, toBase64(dl.buf)));
    }

    return { transcribe };
  }

  const api = { createVoiceTranscriber, buildRequest, readText, MODEL, MIME, API, PROMPT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceTranscribe = api;
})(typeof self !== 'undefined' ? self : this);
