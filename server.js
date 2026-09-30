/* CKD Inventory & Logistics - Local Server (no external packages needed, only Node.js) */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), cp = require('child_process'), crypto = require('crypto');
const ONLINE = process.argv.includes('--online');

const APP_DIR = __dirname;                                   // where server.js / public live
const BASE = process.pkg ? path.dirname(process.execPath) : APP_DIR; // where data + config live
const PUB = path.join(APP_DIR, 'public');
const DATA = path.join(BASE, 'data'), PLDIR = path.join(DATA, 'packing'), BKDIR = path.join(DATA, 'backups');
const CONF = path.join(BASE, 'config.json');
[DATA, PLDIR, BKDIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

let config = { port: 3000, workerPin: '1234', adminPassword: '', publicUrl: '', cloudflaredPath: '', tunnel: 'auto', sshPath: '' };
try { config = Object.assign(config, JSON.parse(fs.readFileSync(CONF, 'utf8'))); } catch (e) { fs.writeFileSync(CONF, JSON.stringify(config, null, 2)); }
const saveConfig = () => fs.writeFileSync(CONF, JSON.stringify(config, null, 2));

// ---------- state ----------
let state = { rev: 0, batches: [], plans: [], transporter: [] };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'))); } catch (e) {}
const evLog = [];                       // recent worker events, used to merge with office edits
let saveTimer = null;
function saveState(now) {
  clearTimeout(saveTimer);
  const doSave = () => {
    const f = path.join(DATA, 'state.json'), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, f);
    const day = new Date().toISOString().slice(0, 10), bk = path.join(BKDIR, 'state-' + day + '.json');
    if (!fs.existsSync(bk)) { fs.copyFileSync(f, bk); pruneBackups(); }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}
function pruneBackups() {
  const files = fs.readdirSync(BKDIR).filter(f => f.startsWith('state-')).sort();
  files.slice(0, Math.max(0, files.length - 30)).forEach(f => fs.unlinkSync(path.join(BKDIR, f)));
}
const plFile = b => path.join(PLDIR, encodeURIComponent(b) + '.json');

// ---------- realtime (SSE) ----------
const clients = new Set();
function broadcast(obj, role) {
  const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
  clients.forEach(c => { if (!role || c.role === role) c.res.write(msg); });
}
function presence() {
  const workers = [...new Set([...clients].filter(c => c.role === 'worker').map(c => c.name || 'Worker'))];
  broadcast({ type: 'presence', workers });
}
setInterval(() => clients.forEach(c => c.res.write(': ping\n\n')), 25000);

// ---------- helpers ----------
const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'cf-ray'];
// "Local" = really on this PC: loopback socket, no proxy/tunnel headers, and Host is localhost.
function isLoop(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (PROXY_HEADERS.some(h => req.headers[h])) return false;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
}
const clientIP = req => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress);
const fails = new Map();
const isBlocked = req => { const f = fails.get(clientIP(req)); return !!(f && f.n >= 8 && Date.now() - f.t < 10 * 60000); };
function noteFail(req) { const ip = clientIP(req), f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 10 * 60000 ? { n: f.n + 1, t: Date.now() } : { n: 1, t: Date.now() }); }
setInterval(() => { const now = Date.now(); fails.forEach((f, k) => { if (now - f.t > 15 * 60000) fails.delete(k); }); }, 60000);
function isAdmin(req, url) {
  if (isLoop(req)) return true;
  if (!config.adminPassword) return false;
  const ok = (req.headers['x-admin-key'] || url.searchParams.get('key')) === config.adminPassword;
  if (!ok && (req.headers['x-admin-key'] || url.searchParams.get('key'))) noteFail(req);
  return ok;
}
function pinOk(req, url) {
  const ok = String(req.headers['x-worker-pin'] || url.searchParams.get('pin') || '') === String(config.workerPin);
  if (!ok) noteFail(req); else fails.delete(clientIP(req));
  return ok;
}
function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj)), h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (b.length > 1024 && /gzip/.test((res.req && res.req.headers['accept-encoding']) || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); return res.end(zlib.gzipSync(b)); }
  res.writeHead(code, h); res.end(b);
}
function body(req, limit = 200 * 1024 * 1024) {
  return new Promise((ok, no) => { let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { no(new Error('too big')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString() || '{}')); } catch (e) { no(e); } });
    req.on('error', no); });
}
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
function applyEvent(batches, ev) {
  const b = batches.find(x => x.batch === ev.batch); if (!b) return;
  b.gateMarkedContainers = b.gateMarkedContainers || {}; b.gateMarkedTimestamps = b.gateMarkedTimestamps || {};
  if (ev.type === 'offload') { (b.offloadedContainers = b.offloadedContainers || {})[ev.containerNo] = ev.record; b.gateMarkedContainers[ev.containerNo] = false; }
  if (ev.type === 'gate') { if (!(b.offloadedContainers || {})[ev.containerNo]) { b.gateMarkedContainers[ev.containerNo] = ev.marked; if (ev.marked && ev.ts) b.gateMarkedTimestamps[ev.containerNo] = ev.ts; } }
}
function lotLabel(b) {
  if (b.statusOverride === 'TRANSIT') return 'In Transit';
  if (b.statusOverride === 'RECEIVED') return 'Received';
  if (!b.arrivalDate) return 'Upcoming';
  return b.arrivalDate <= new Date().toISOString().split('T')[0] ? 'In Karachi' : 'Upcoming';
}
const isTransit = b => b.statusOverride === 'TRANSIT';

// slim, worker-safe view of the data (all containers: All Containers / Ramps / Transit screens)
function workerState() {
  const out = [];
  state.batches.forEach(b => {
    const off = b.offloadedContainers || {}, gate = b.gateMarkedContainers || {}, ts = b.gateMarkedTimestamps || {};
    const lot = lotLabel(b), transit = lot === 'In Transit';
    out.push({
      batch: b.batch, model: b.model, color: b.color, bl: b.bl, lc: b.lc, units: b.units, transit, arrivalDate: b.arrivalDate || '',
      containers: (b.containers || []).map(c => {
        const t = state.transporter.find(x => x.containerNo === c.containerNo), o = off[c.containerNo], g = ts[c.containerNo];
        const st = o ? 'off' : gate[c.containerNo] ? 'gate' : transit ? 'transit' : (lot === 'In Karachi' || lot === 'Received') ? 'karachi' : 'upcoming';
        return { containerNo: c.containerNo, type: c.type, seq: c.seq, sealNo: c.sealNo, color: c.color || b.color,
          vehicleNo: t ? t.vehicleNo : (c.vehicleNo || ''), mobileNo: t ? t.mobileNo : (c.mobileNo || ''), location: t ? t.location : (c.location || ''),
          transporter: t ? t.transporter : (c.transporter || b.transporter || ''),
          st, gateDate: g ? g.date : (b.arrivalDate || ''), gateTime: g ? g.time : '',
          off: o ? { date: o.offloadingDate, time: o.offloadingTime, condition: o.condition, remarks: o.remarks, by: o.offloadedBy || '' } : null };
      })
    });
  });
  return { rev: state.rev, batches: out };
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/ping') return send(res, 200, { ok: true, server: true, rev: state.rev, admin: isAdmin(req, url) });

  // ---- worker ----
  if ((p.startsWith('/api/worker/') || p === '/api/events') && isBlocked(req)) return send(res, 429, { error: 'Bohat zyada galat koshishen. 10 minute baad dobara try karein.' });
  if (p === '/api/worker/login' && m === 'POST') { const j = await body(req, 20000); if (String(j.pin) === String(config.workerPin)) { fails.delete(clientIP(req)); return send(res, 200, { ok: true }); } noteFail(req); return send(res, 401, { error: 'PIN galat hai' }); }
  if (p.startsWith('/api/worker/')) {
    if (!pinOk(req, url)) return send(res, 401, { error: 'PIN galat hai' });
    if (p === '/api/worker/state' && m === 'GET') return send(res, 200, workerState());
    if (p === '/api/worker/offload' && m === 'POST') {
      const j = await body(req, 100000);
      const b = state.batches.find(x => x.batch === j.batch); const c = b && (b.containers || []).find(x => x.containerNo === j.containerNo);
      if (!c) return send(res, 404, { error: 'Container nahi mila' });
      b.offloadedContainers = b.offloadedContainers || {}; b.gateMarkedContainers = b.gateMarkedContainers || {};
      if (b.offloadedContainers[c.containerNo]) return send(res, 200, { ok: true, duplicate: true, record: b.offloadedContainers[c.containerNo], rev: state.rev });
      const ts = (b.gateMarkedTimestamps || {})[c.containerNo] || { date: b.arrivalDate || '', time: '12:00:00 pm' };
      const d = String(j.offloadingDate || '').split('-');
      const rec = { containerNo: c.containerNo, batchNo: b.batch, type: c.type, seq: c.seq, arrivalDate: ts.date, arrivalTime: ts.time, sealNo: c.sealNo, bl: b.bl, lc: b.lc,
        offloadingDate: d.length === 3 ? `${d[2]}-${d[1]}-${d[0]}` : (j.offloadingDate || ''), offloadingTime: j.offloadingTime || '',
        status: 'Offloaded', condition: j.condition === 'Damage' ? 'Damage' : 'OK', remarks: String(j.remarks || '').trim().slice(0, 500) || '-',
        offloadedBy: String(j.worker || '').slice(0, 60), source: 'mobile', at: new Date().toISOString() };
      const ev = { type: 'offload', batch: b.batch, containerNo: c.containerNo, record: rec };
      applyEvent(state.batches, ev); state.rev++; ev.rev = state.rev; evLog.push(ev); if (evLog.length > 1000) evLog.shift();
      saveState(); broadcast(ev);
      return send(res, 200, { ok: true, record: rec, rev: state.rev });
    }
    if (p === '/api/worker/gate' && m === 'POST') {
      const j = await body(req, 20000);
      const b = state.batches.find(x => x.batch === j.batch); const c = b && (b.containers || []).find(x => x.containerNo === j.containerNo);
      if (!c) return send(res, 404, { error: 'Container nahi mila' });
      if ((b.offloadedContainers || {})[c.containerNo]) return send(res, 409, { error: 'Yeh container pehle hi offload ho chuka hai' });
      const marked = !!j.marked, now = new Date(), p2 = n => String(n).padStart(2, '0');
      const clean = v => String(v || '').replace(/[^0-9A-Za-z :\-.apmAPM]/g, '').slice(0, 24);
      const ts = marked ? { date: clean(j.date) || `${p2(now.getDate())}-${p2(now.getMonth() + 1)}-${now.getFullYear()}`, time: clean(j.time) || now.toLocaleTimeString() } : null;
      const ev = { type: 'gate', batch: b.batch, containerNo: c.containerNo, marked, ts, by: String(j.worker || '').slice(0, 60) };
      applyEvent(state.batches, ev); state.rev++; ev.rev = state.rev; evLog.push(ev); if (evLog.length > 1000) evLog.shift();
      saveState(); broadcast(ev);
      return send(res, 200, { ok: true, marked, ts, rev: state.rev });
    }
    return send(res, 404, { error: 'not found' });
  }

  // ---- events (SSE) ----
  if (p === '/api/events') {
    const role = url.searchParams.get('role') === 'worker' ? 'worker' : 'admin';
    if (role === 'admin' ? !isAdmin(req, url) : !pinOk(req, url)) return send(res, 401, { error: 'not allowed' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { res, role, name: url.searchParams.get('name') || '', cid: url.searchParams.get('cid') || '' };
    clients.add(c); res.write('retry: 3000\n\n: ' + ' '.repeat(2048) + '\n\n');
    res.write('data: ' + JSON.stringify({ type: 'hello', rev: state.rev }) + '\n\n');
    presence();
    req.on('close', () => { clients.delete(c); presence(); });
    return;
  }

  // ---- admin only (office PC) ----
  if (isBlocked(req)) return send(res, 429, { error: 'Bohat zyada galat koshishen. 10 minute baad try karein.' });
  if (!isAdmin(req, url)) return send(res, 403, { error: 'Yeh kaam sirf office PC se ho sakta hai (ya admin password chahiye)' });

  if (p === '/api/state' && m === 'GET') return send(res, 200, state);
  if (p === '/api/state' && m === 'PUT') {
    const j = await body(req);
    let batches = j.batches || [], merged = false;
    const base = Number(j.baseRev) || 0;
    if (base < state.rev) {                         // workers changed things after this PC last synced: re-apply them
      const missed = evLog.filter(e => e.rev > base);
      missed.forEach(e => applyEvent(batches, e)); merged = missed.length > 0;
    }
    state.batches = batches; state.plans = j.plans || []; state.transporter = j.transporter || [];
    state.rev++; saveState(); broadcast({ type: 'state', rev: state.rev, by: j.clientId || '' });
    return send(res, 200, { ok: true, rev: state.rev, merged, batches: merged ? batches : undefined });
  }
  let mm;
  if ((mm = p.match(/^\/api\/packing\/(.+)$/))) {
    const key = decodeURIComponent(mm[1]);
    if (m === 'GET') { try { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(fs.readFileSync(plFile(key))); } catch (e) { return send(res, 200, []); } }
    if (m === 'PUT') { const j = await body(req); fs.writeFileSync(plFile(key), JSON.stringify(j)); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/backup' && m === 'GET') {
    const packingLists = {}; state.batches.forEach(b => { try { packingLists[b.batch] = JSON.parse(fs.readFileSync(plFile(b.batch))); } catch (e) { packingLists[b.batch] = []; } });
    return send(res, 200, { app: 'ckd-lms', version: 1, exportedAt: new Date().toISOString(), batches: state.batches, plans: state.plans, transporter: state.transporter, packingLists });
  }
  if (p === '/api/restore' && m === 'POST') {
    const j = await body(req);
    fs.readdirSync(PLDIR).forEach(f => fs.unlinkSync(path.join(PLDIR, f)));
    Object.entries(j.packingLists || {}).forEach(([k, v]) => fs.writeFileSync(plFile(k), JSON.stringify(v)));
    state.batches = j.batches || []; state.plans = j.plans || []; state.transporter = j.transporter || [];
    state.rev++; evLog.length = 0; saveState(true); broadcast({ type: 'state', rev: state.rev, by: j.clientId || '' });
    return send(res, 200, { ok: true, rev: state.rev });
  }
  if (p === '/api/info' && m === 'GET') return send(res, 200, { port: config.port, ips: lanIPs(), workerPin: config.workerPin, adminProtected: !!config.adminPassword, online: ONLINE, publicUrl: publicUrl || config.publicUrl || '', permanent: !!config.publicUrl, tunnelMsg });
  if (p === '/api/config' && m === 'POST') {
    const j = await body(req);
    if (j.workerPin !== undefined) { if (!/^[A-Za-z0-9]{4,12}$/.test(String(j.workerPin))) return send(res, 400, { error: 'PIN 4 se 12 letters/numbers ka hona chahiye' }); config.workerPin = String(j.workerPin); }
    saveConfig(); return send(res, 200, { ok: true, workerPin: config.workerPin });
  }
  send(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css' };
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/worker') { res.writeHead(302, { Location: '/worker/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('sw.js') || f.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) api(req, res, url).catch(e => { console.error(e); if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); });
  else serveStatic(req, res, url);
});
let publicUrl = '', tunnelMsg = '';
function download(url, dest, cb, hops = 0) {
  const lib = url.startsWith('https') ? https : http;
  let done = false; const end = e => { if (!done) { done = true; cb(e); } };
  const req = lib.get(url, { headers: { 'User-Agent': 'ckd-lms' } }, r => {
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 6) { r.resume(); done = true; return download(new URL(r.headers.location, url).href, dest, cb, hops + 1); }
    if (r.statusCode !== 200) { r.resume(); return end(new Error('HTTP ' + r.statusCode)); }
    const total = Number(r.headers['content-length']) || 0, tmp = dest + '.part', f = fs.createWriteStream(tmp);
    let got = 0, lastPct = -1, stall = setTimeout(() => req.destroy(new Error('30 second se koi data nahi aaya')), 30000);
    r.on('data', c => {
      got += c.length; clearTimeout(stall); stall = setTimeout(() => req.destroy(new Error('30 second se koi data nahi aaya')), 30000);
      const pct = total ? Math.floor(got / total * 100) : Math.floor(got / 1048576);
      if (pct !== lastPct && (!total || pct % 10 === 0)) { lastPct = pct; process.stdout.write(total ? '  download: ' + pct + '%\r\n' : '  download: ' + pct + ' MB\r\n'); }
    });
    r.pipe(f);
    f.on('finish', () => f.close(() => { clearTimeout(stall); try { fs.renameSync(tmp, dest); end(null); } catch (e) { end(e); } }));
    f.on('error', e => { clearTimeout(stall); end(e); });
  });
  req.on('error', e => end(e));
}
// A real quick-tunnel link looks like https://word-word-word.trycloudflare.com  ("api.trycloudflare.com" is Cloudflare's own server, NOT a link)
const RE_CF = /https:\/\/(?!api\.|www\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i;
const RE_SSH = /https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i;
const cfExe = () => config.cloudflaredPath || path.join(BASE, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

function runTunnel(kind, done) {
  let exe, args;
  if (kind === 'cloudflare') { exe = cfExe(); args = ['tunnel', '--url', 'http://localhost:' + config.port, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4']; }
  else { exe = config.sshPath || 'ssh'; args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', '80:localhost:' + config.port, 'nokey@localhost.run']; }
  const label = kind === 'cloudflare' ? 'Cloudflare' : 'localhost.run (ssh)';
  console.log('Internet link ban raha hai via ' + label + ' ...');
  tunnelMsg = label + ' se internet link ban raha hai...';
  let got = false, finished = false, lastLine = '';
  let t;
  try { t = cp.spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { tunnelMsg = label + ' start nahi hua: ' + e.message; console.log(tunnelMsg); return done(false); }
  const finish = ok => { if (finished) return; finished = true; clearTimeout(timer); if (!ok) publicUrl = ''; done(ok); };
  const timer = setTimeout(() => { if (!got) { console.log(label + ': 60 second mein connect nahi hua, band kar ke agla tareeqa try ho raha hai.'); try { t.kill(); } catch (e) {} } }, 60000);
  const scan = d => {
    String(d).split(/\r?\n/).forEach(line => {
      const m = line.match(kind === 'cloudflare' ? RE_CF : RE_SSH);
      if (m) { got = true; clearTimeout(timer); tunnelMsg = ''; if (publicUrl !== m[0]) { publicUrl = m[0]; banner(); } }
      else if (/\bERR\b|error|failed|refused|timed? ?out|denied|could not|unable/i.test(line) && line.trim() !== lastLine) { lastLine = line.trim(); console.log('[' + label + '] ' + lastLine.slice(0, 220)); tunnelMsg = label + ': ' + lastLine.slice(0, 160); }
    });
  };
  t.stdout.on('data', scan); t.stderr.on('data', scan);
  t.on('error', e => { console.log(label + ' start nahi hua: ' + e.message); tunnelMsg = label + ' start nahi hua: ' + e.message; finish(false); });
  t.on('exit', () => finish(got));
  process.on('exit', () => { try { t.kill(); } catch (e) {} });
}
function startTunnel() {
  let order = config.tunnel === 'ssh' ? ['ssh'] : config.tunnel === 'cloudflare' ? ['cloudflare'] : ['cloudflare', 'ssh'];
  let i = 0, wait = 5000;
  const loop = () => {
    if (!order.length) { tunnelMsg = 'Koi tunnel start nahi ho saka.'; return; }
    const kind = order[i % order.length];
    runTunnel(kind, ok => {
      if (ok) wait = 5000; else { i++; wait = (order.length > 1 && i % order.length !== 0) ? 1000 : Math.min(wait * 2, 60000); }
      if (!ok && i >= order.length * 3) console.log('\n!!! Internet link nahi ban pa raha. Office WiFi link istemal karein, aur is window ka screenshot support ko bhejein.\n');
      console.log('Tunnel dobara ' + Math.round(wait / 1000) + ' second baad try hoga...');
      setTimeout(loop, wait);
    });
  };
  const needCf = order.includes('cloudflare');
  if (!needCf || fs.existsSync(cfExe())) return loop();
  if (process.platform !== 'win32' || config.cloudflaredPath) { order = order.filter(k => k !== 'cloudflare'); return loop(); }
  console.log('Pehli dafa: cloudflared download ho raha hai (~40 MB), thora intezar karein...');
  download('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', cfExe(), err => {
    if (err) { console.log('cloudflared download nahi ho saka (' + err.message + '). localhost.run se koshish karte hain.'); order = order.filter(k => k !== 'cloudflare'); }
    loop();
  });
}
function banner() {
  const base = publicUrl || config.publicUrl;
  console.log('\n=== CKD Inventory & Logistics Server chal raha hai ' + (ONLINE ? '(INTERNET MODE)' : '') + ' ===');
  console.log('Office PC (main software):  http://localhost:' + config.port);
  if (base) console.log('*** WORKERS KA INTERNET LINK:   ' + base + '/worker/   (PIN: ' + config.workerPin + ') ***');
  else if (ONLINE) console.log('(Internet link abhi ban raha hai. Jaise hi ban gaya, yahan nazar aayega.)');
  if (ONLINE) console.log('Admin password (doosri jagah se main software kholne ke liye): ' + config.adminPassword);
  lanIPs().forEach(ip => console.log('Office WiFi link:            http://' + ip + ':' + config.port + '/worker/'));
  console.log('Data folder: ' + DATA + '\nBand karne ke liye is window mein Ctrl+C dabayen.\n');
}
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log('\n!!! Port ' + config.port + ' pehle se istemal mein hai.\n    Matlab purani server wali kaali window abhi khuli hai. Usay band karein (Ctrl+C ya X), phir dobara chalayen.\n');
  else console.log('\n!!! Server start nahi hua: ' + e.message + '\n');
  process.exit(1);
});
console.log('Server start ho raha hai...');
server.listen(config.port, '0.0.0.0', () => {
  if (ONLINE) {
    let changed = false;
    if (!config.adminPassword) { config.adminPassword = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 10); changed = true; }
    if (config.workerPin === '1234' || String(config.workerPin).length < 4) { config.workerPin = String(crypto.randomInt(100000, 999999)); changed = true; }
    if (changed) saveConfig();
    if (!config.publicUrl) startTunnel();
  }
  banner();
  if (process.argv.includes('--open') && process.platform === 'win32') cp.exec('start "" "http://localhost:' + config.port + '"');
});
const bye = () => { try { saveState(true); } catch (e) {} process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
