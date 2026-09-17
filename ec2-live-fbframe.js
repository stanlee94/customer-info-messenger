// Runs inside Facebook's video plugin iframe (registered by background.js
// with allFrames). EC2's live page embeds that plugin; its LIVE + viewer badge
// is printed once at load and never updates, and it showed through behind
// ec2-live.js's own 5 s badge (.ddr-vstats). Hide it - but only when the
// plugin is embedded by EC2, never on any other site.
//
// Verified on live 557246: the badge is one absolutely placed box
//   <div class="_u_0 …"><div class="_u_g"><div class="_u_h">LIVE</div>…</div>
//   <div class="_1jb_ _u_l" data-store="{viewerCount…}">1.1K</div></div>
// Facebook's class names are obfuscated, so a text fallback finds a "LIVE"
// leaf near the top left and hides its positioned ancestor.
(() => {
  const anc = location.ancestorOrigins;
  if (window.top === window || !anc || !anc.length || anc[0] !== 'https://ec2.full2house.com') return;

  const style = document.createElement('style');
  style.textContent = '._u_0:has(._u_h), ._u_0:has(._1jb_), ._u_h, ._1jb_ { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);

  const fallback = () => {
    if (!document.body) return;
    for (const el of document.body.querySelectorAll('div, span')) {
      if (el.childElementCount || el.textContent.trim() !== 'LIVE') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || r.top > 80 || r.left > 120) continue;
      // Only a small absolutely placed box a few levels up - never the player.
      let box = el;
      for (let i = 0; i < 4 && box && getComputedStyle(box).position !== 'absolute'; i += 1) box = box.parentElement;
      if (!box || getComputedStyle(box).position !== 'absolute' || box.getBoundingClientRect().height > 80) continue;
      box.style.setProperty('display', 'none', 'important');
    }
  };
  // The badge is rendered after load; check for a short while, then stop.
  const obs = new MutationObserver(() => { clearTimeout(obs.t); obs.t = setTimeout(fallback, 200); });
  const start = () => {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 20000);
    fallback();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
