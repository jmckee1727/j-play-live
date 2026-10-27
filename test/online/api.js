// Thin REST helpers against the live service, for the online tests (signin, read a table).
const URL = 'https://ckcgupksgfadhtyhycdl.supabase.co';
const KEY = 'sb_publishable_yuyifKD-n51bRtmdzH_vlA_EdUgeJWX';

async function signin(email, pw) {
  const r = await fetch(URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify({ email, password: pw }) });
  let body = {}; try { body = await r.json(); } catch (e) { }
  return { status: r.status, body };
}
async function select(table, query, token) {
  const r = await fetch(URL + '/rest/v1/' + table + '?' + query, { headers: { apikey: KEY, Authorization: 'Bearer ' + (token || KEY) } });
  let body = []; try { body = await r.json(); } catch (e) { }
  return { status: r.status, body };
}
async function rpc(fn, args, token) {
  const r = await fetch(URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + (token || KEY) }, body: JSON.stringify(args || {}) });
  let body = null; try { body = await r.json(); } catch (e) { }
  return { status: r.status, body };
}
module.exports = { URL, KEY, signin, select, rpc };
