// One real Gemini transcription through voice-transcribe.js, from Node.
// Needs a Gemini API key and a real voice clip:
//   GEMINI_API_KEY=… CLIP_URL='https://cdn.fbsbx.com/…audioclip-….mp4?…' node voice-gemini-smoke.js
//   GEMINI_API_KEY=… CLIP_FILE=./clip.mp4 node voice-gemini-smoke.js
// Optional MODEL=gemini-3.8-flash to compare a general model with the prompt.
// Copy a CLIP_URL from DevTools → Network after pressing play on a voice message
// (it expires at its oe= time).
const fs = require('fs');
const { createVoiceTranscriber, MODEL } = require('./voice-transcribe.js');

const key = process.env.GEMINI_API_KEY;
const file = process.env.CLIP_FILE;
const url = file ? 'https://cdn.fbsbx.com/local-file' : process.env.CLIP_URL;
if (!key || !url) { console.error('Set GEMINI_API_KEY and CLIP_URL or CLIP_FILE'); process.exit(2); }

const fetchImpl = async (u, opts) => {
  if (file && u === url) { const b = fs.readFileSync(file); return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; }
  const res = await fetch(u, opts);
  if (!res.ok && !u.startsWith('https://cdn.fbsbx.com/')) console.error('Gemini said', res.status, await res.clone().text());
  return res;
};

(async () => {
  const model = process.env.MODEL || MODEL;
  const t = createVoiceTranscriber({ fetch: fetchImpl, getKey: async () => key, model });
  const t0 = Date.now();
  const res = await t.transcribe({ url, messageId: 'smoke' });
  console.log(JSON.stringify({ model, ms: Date.now() - t0, ...res }, null, 2));
  process.exit(res.ok ? 0 : 1);
})();
