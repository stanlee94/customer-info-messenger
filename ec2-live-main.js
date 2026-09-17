// Runs in the EC2 live page's MAIN world (registered by background.js with the
// overlay, same on/off toggle). Only on m=liveingManager.
//
// Late comments (verified on live 557246, 17 Sep 2026): EC2 stores some
// comments 10-80 s after newer ones. living.js polls every 5 s with
//   $.post(getCommentUrl, { live_id, lastTime })
// where lastTime is the newest comment_created_time it has drawn, and the
// server filters on comment_created_time > lastTime - so a comment that lands
// late, with an older time, is never returned and never drawn until the page
// or the list is reloaded. A late 得标 comment is invisible to the host.
//
// Fix, without touching living.js's row drawing or its 得标 buttons: that one
// request asks for OVERLAP_S more (lastTime minus the overlap), and before
// living.js sees the answer, comments already in the list are removed (living.js
// prepends every row it receives, with no de-duplication). The cursor never
// moves backwards: after the callback, lastTime is the newest time returned.
// A late comment is drawn at the top of the list, like any new comment.
(function () {
  if (!/[?&]m=liveingManager\b/.test(location.search)) return;
  const OVERLAP_S = 180;

  const pad = (n) => String(n).padStart(2, '0');
  // comment_created_time is Malaysia time, "YYYY-MM-DD HH:MM:SS".
  const toMs = (t) => Date.parse(String(t).replace(' ', 'T') + '+08:00');
  const toStr = (ms) => {
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const onPage = (id) =>
    !!(document.getElementById('win_tr_' + id) || document.getElementById('win_str_' + id) ||
      document.querySelector(`#liveMessageDiv tbody > tr[data-index="${CSS.escape(String(id))}"]`));

  const wrap = () => {
    const $ = window.jQuery;
    if (!$ || !$.post || $.post.__ddrOverlap) return !!($ && $.post && $.post.__ddrOverlap);
    const orig = $.post;
    const patched = function (url, data, success, ...rest) {
      const isComments = typeof url === 'string' && /m=getLivingMessage\b/.test(url) &&
        data && typeof data === 'object' && typeof success === 'function' && url === window.getCommentUrl;
      const since = isComments ? String(data.lastTime || '') : '';
      const ms = since ? toMs(since) : NaN;
      // Empty (whole live) and the 9999 park used by the overlay's Refresh pass through.
      if (!isComments || !Number.isFinite(ms) || since.startsWith('9999')) return orig.call(this, url, data, success, ...rest);

      const req = { ...data, lastTime: toStr(ms - OVERLAP_S * 1000) };
      return orig.call(this, url, req, function (raw, ...cbRest) {
        let result;
        try {
          result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (err) {
          return success.call(this, raw, ...cbRest);
        }
        const list = result && result.data && Array.isArray(result.data.list) ? result.data.list : null;
        if (!list) return success.call(this, raw, ...cbRest);
        let newest = since;
        list.forEach((x) => { if (String(x.comment_created_time) > newest) newest = String(x.comment_created_time); });
        const fresh = list.filter((x) => !onPage(x.fb_comment_id));
        if (fresh.length !== list.length) {
          result.data.list = fresh;
          raw = JSON.stringify(result);
        }
        const out = success.call(this, raw, ...cbRest);
        // living.js set lastTime from the first row it drew; never behind what was read,
        // and never over a Refresh park that started meanwhile.
        if (!String(window.lastTime).startsWith('9999') && String(window.lastTime || '') < newest) window.lastTime = newest;
        return out;
      }, ...rest);
    };
    patched.__ddrOverlap = true;
    $.post = patched;
    return true;
  };

  if (!wrap()) {
    const t = setInterval(() => { if (wrap()) clearInterval(t); }, 200);
    setTimeout(() => clearInterval(t), 30000);
  }
})();
