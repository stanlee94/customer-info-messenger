// Voice messages in the Business Suite inbox — page (MAIN world) half.
// Meta's play button (a[aria-label="Voice Message"]) carries no audio address:
// it lives in React props (AudioClip.src / duration / isFromViewer and
// BizInboxMessageAudioBubble.messageID), which only the page's own JS world
// can read. This script copies them onto the button as data-cim-voice-src /
// -id / -dur / -mine for inbox-voice.js (isolated world). Found by prop shape,
// never by depth or class name; nothing found → button left alone.
// Never moves Meta's nodes and sends nothing anywhere.
// Spec: docs/superpowers/specs/2026-10-02-voice-message-transcript-design.md
(() => {
  if (window.__cimVoiceMain) return;
  window.__cimVoiceMain = true;

  const SEL = 'a[aria-label="Voice Message"]:not([aria-hidden="true"])';
  const MAX_DEPTH = 40;
  const debug = (window.__cimVoiceDebug = { maxTagMs: 0, tags: 0 });

  function readVoice(anchor) {
    const key = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;
    let src = '', dur = '', mine = '0', id = '';
    for (let f = anchor[key], d = 0; f && d < MAX_DEPTH && !(src && id); f = f.return, d++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      if (!src && typeof p.src === 'string' && /audioclip|cdn\.fbsbx\.com/.test(p.src)) {
        src = p.src;
        dur = p.duration != null ? String(p.duration) : '';
        mine = p.isFromViewer ? '1' : '0';
      }
      if (!id && typeof p.messageID === 'string' && p.messageID) id = p.messageID;
    }
    return src && id ? { src, id, dur, mine } : null;
  }

  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // Re-reads every button each pass (plain object walks, no layout), so a node
  // React reuses for another message is re-tagged.
  function tagAll() {
    const t0 = performance.now();
    for (const a of document.querySelectorAll(SEL)) {
      const v = readVoice(a);
      if (!v) continue;
      setAttr(a, 'data-cim-voice-src', v.src);
      setAttr(a, 'data-cim-voice-dur', v.dur);
      setAttr(a, 'data-cim-voice-mine', v.mine);
      if (a.getAttribute('data-cim-voice-id') !== v.id) { a.setAttribute('data-cim-voice-id', v.id); debug.tags++; }
    }
    debug.maxTagMs = Math.max(debug.maxTagMs, performance.now() - t0);
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { tagAll(); } catch (e) { /* never throw into Meta's page */ }
    });
  }

  // ── Speed: html[data-cim-voice-rate] (set by inbox-voice.js) applied to
  // Meta's voice clips. Meta plays them through an <audio> it never attaches
  // to the DOM, so we catch it at play(). Only clips whose URL holds
  // "audioclip" are touched. defaultPlaybackRate too, so a load() keeps it.
  const clips = new Set();          // WeakRef<HTMLMediaElement>
  const seen = new WeakSet();
  debug.clips = clips;
  const rate = () => {
    const r = parseFloat(document.documentElement.dataset.cimVoiceRate);
    return r > 0 && r <= 4 ? r : 1;
  };
  const isClip = (el) => /audioclip/.test(el.currentSrc || el.src || '');
  function applyRate(el) {
    try {
      const r = rate();
      el.preservesPitch = true;
      if (el.defaultPlaybackRate !== r) el.defaultPlaybackRate = r;
      if (el.playbackRate !== r) el.playbackRate = r;
    } catch (e) { /* ignore */ }
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      if (isClip(this)) {
        applyRate(this);
        if (!seen.has(this)) { seen.add(this); clips.add(new WeakRef(this)); }
      }
    } catch (e) { /* never break Meta's player */ }
    return origPlay.apply(this, args);
  };
  new MutationObserver(() => {
    for (const ref of clips) {
      const el = ref.deref();
      if (!el) clips.delete(ref); else applyRate(el);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-cim-voice-rate'] });

  // childList + characterData only: our own attribute writes never re-trigger it.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule();
})();
