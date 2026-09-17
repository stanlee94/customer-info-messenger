// Standalone copy of the reply parser, validated here before it goes into ec2-live.js.
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '');
const unbracket = (s) => String(s || '').trim().replace(/^（\s*/, '').replace(/\s*）$/, '').trim();

/** Every 标组名称 in a reply, bracketed (（NAME）) or plain (NAME to end of line). */
function replyNames(reply) {
  const out = [];
  const re = /标组名称\s*[：:]\s*(?:（(.*?)）(?=\s*[，,\r\n]|\s*$)|([^\r\n，,]+))/g;
  let m;
  while ((m = re.exec(String(reply || '')))) out.push(unbracket(m[1] != null ? m[1] : m[2]));
  return out.filter(Boolean);
}
function replyPrice(reply) {
  const m = String(reply || '').match(/标组金额\s*[：:]\s*（?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}
function replyAmount(reply) {
  const m = String(reply || '').match(/订单金额\s*[：:]\s*（?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}
function replyCode(reply) {
  const r = String(reply || '');
  const m = r.match(/得\((\w+)\)标/) || r.match(/当前得标为\s*[：:]\s*（\s*(\w+)\s*）/);
  return m ? m[1].toUpperCase() : null;
}
function qtyByCode(message) {
  const o = {};
  for (const m of stripTags(message).matchAll(/([A-Za-z]+\d+)\s*\+\s*(\d+)/g)) {
    const c = m[1].toUpperCase();
    o[c] = (o[c] || 0) + parseInt(m[2], 10);
  }
  return o;
}
module.exports = { replyNames, replyPrice, replyAmount, replyCode, qtyByCode, stripTags, unbracket };
