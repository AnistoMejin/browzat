'use strict';
// Relay daemon. Browser extensions connect over WebSocket (/ext); MCP processes call POST /rpc.
// Listens on 127.0.0.1 only. Extensions and the relay prove knowledge of the shared token to each other.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const C = require('./common');

const token = C.loadOrCreateToken();
const startedAt = Date.now();
const browsers = new Map(); // id -> { id, ws, info, pending, since, lastSeen }
const pairCodes = new Map(); // code -> { expires, redeemed: [] }
let seq = 1;

try { if (fs.statSync(C.LOG_FILE).size > 1e6) fs.renameSync(C.LOG_FILE, C.LOG_FILE + '.old'); } catch {}
// Log times are IST unless BROWSER_MCP_TZ names another zone, for example Europe/Berlin.
const LOG_TZ = process.env.BROWSER_MCP_TZ || 'Asia/Kolkata';
const LOG_TZ_LABEL = process.env.BROWSER_MCP_TZ ? LOG_TZ : 'IST';
function log(msg) {
  const ts = new Date().toLocaleString('en-GB', { timeZone: LOG_TZ, hour12: false });
  try { fs.appendFileSync(C.LOG_FILE, `${ts} ${LOG_TZ_LABEL}  ${msg}\n`); } catch {}
}

const isWebOrigin = (req) => /^https?:\/\//i.test(req.headers.origin || '');
const isExtOrigin = (req) => /^(chrome-extension|moz-extension):\/\//i.test(req.headers.origin || '');
const hostOk = (req) => {
  const h = String(req.headers.host || '').toLowerCase();
  return h === `127.0.0.1:${C.PORT}` || h === `localhost:${C.PORT}`;
};
const clip = (s, n = 40) => String(s || '').replace(/[^\w .-]/g, '').slice(0, n);

function send(res, code, obj, extra) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra));
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function validCode(code) {
  const e = pairCodes.get(String(code || ''));
  return e && e.expires > Date.now() ? e : null;
}

function pairPage(code) {
  const valid = !!validCode(code);
  const head = '<!doctype html><html><head><meta charset="utf-8"><title>Browser MCP pairing</title>' +
    '<style>body{font:16px system-ui;margin:48px;max-width:600px}.ok{color:#0a7d33}.bad{color:#b3261e}</style></head><body><h2>Browser MCP pairing</h2>';
  if (!valid) return head + '<p class="bad">This pairing link has expired or is not valid. Ask for a new one.</p></body></html>';
  const script = `
const code = ${JSON.stringify(code)};
const m = document.getElementById('m');
const t0 = Date.now();
const ua = navigator.userAgent;
const kind = /Firefox\\//.test(ua) ? 'firefox' : /Edg\\//.test(ua) ? 'edge' : 'chrome';
async function tick() {
  try {
    const j = await (await fetch('/pair/status?code=' + code, { cache: 'no-store' })).json();
    if (!j.valid) { m.textContent = 'This pairing link has expired.'; m.className = 'bad'; return; }
    const mine = j.redeemed.filter((x) => x.kind === kind || (kind === 'chrome' && /chrom|brave|opera/.test(x.kind)));
    if (mine.length) { m.textContent = 'Paired with this browser (' + (mine[0].name || mine[0].kind) + '). You can close this tab.'; m.className = 'ok'; return; }
    if (Date.now() - t0 > 6000) m.textContent = 'Still waiting. If nothing happens, the Browser MCP extension is not installed or not enabled in this browser.';
  } catch (e) {}
  setTimeout(tick, 1000);
}
tick();`;
  return head + '<p id="m">Waiting for the Browser MCP extension in this browser…</p><script>' + script + '</script></body></html>';
}

function statusObj() {
  return {
    version: C.VERSION,
    pid: process.pid,
    port: C.PORT,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    browsers: [...browsers.values()].map((b) => ({
      id: b.id,
      kind: b.info.kind,
      name: b.info.name,
      extension: b.info.version,
      connectedSec: Math.round((Date.now() - b.since) / 1000),
    })),
  };
}

function matchBrowsers(name) {
  const list = [...browsers.values()];
  if (!name) return list;
  const n = String(name).toLowerCase();
  const exact = list.filter((b) => b.id === n);
  return exact.length ? exact : list.filter((b) => b.info.kind === n);
}

// Extensions reconnect within a few seconds (up to 30 s for a sleeping Chromium worker), so wait a little.
async function resolveBrowser(name) {
  const fresh = Date.now() - startedAt < 45000;
  const deadline = Date.now() + (fresh ? 35000 : 6000);
  for (;;) {
    const m = matchBrowsers(name);
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new Error('several browsers are connected; pass browser as one of: ' + m.map((b) => b.id).join(', '));
    if (Date.now() > deadline) break;
    await C.sleep(250);
  }
  const have = [...browsers.keys()].join(', ') || 'none';
  throw new Error(
    (name ? `browser "${name}" is not connected` : 'no browser is connected') +
    ` (connected: ${have}). The browser must be running with the Browser MCP extension installed and paired.`
  );
}

async function callBrowser(p) {
  const b = await resolveBrowser(p.browser);
  const id = seq++;
  const ms = Math.min(Math.max(Number(p.timeoutMs) || 45000, 1000), 180000);
  const result = await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      b.pending.delete(id);
      reject(new Error(`timed out after ${ms} ms waiting for ${b.id}`));
    }, ms);
    b.pending.set(id, { resolve, reject, t });
    b.ws.send(JSON.stringify({ id, method: p.tool, params: p.args || {} }));
  });
  return { browser: b.id, result };
}

async function handleRpc(method, params) {
  switch (method) {
    case 'status':
      return statusObj();
    case 'pair_start': {
      const code = crypto.randomBytes(16).toString('hex');
      pairCodes.set(code, { expires: Date.now() + 10 * 60e3, redeemed: [] });
      return { code, url: `${C.BASE}/pair?code=${code}`, expiresInSec: 600 };
    }
    case 'pair_status': {
      const e = validCode(params.code);
      return { valid: !!e, redeemed: e ? e.redeemed : [] };
    }
    case 'shutdown':
      log('shutdown requested');
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    case 'call':
      return callBrowser(params);
    default:
      throw new Error('unknown method ' + method);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, C.BASE);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { name: 'browser-mcp-relay', version: C.VERSION, pid: process.pid });
    }
    if (req.method === 'GET' && p === '/pair') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      return res.end(pairPage(url.searchParams.get('code') || ''));
    }
    if (req.method === 'GET' && p === '/pair/status') {
      const e = validCode(url.searchParams.get('code'));
      return send(res, 200, { valid: !!e, redeemed: e ? e.redeemed.map((r) => ({ kind: r.kind, name: r.name })) : [] });
    }
    if (p === '/pair/redeem') {
      // Only an extension (or a local non-browser client holding the code) may redeem; web pages may not.
      if (isWebOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const cors = isExtOrigin(req)
        ? {
            'access-control-allow-origin': req.headers.origin,
            'access-control-allow-headers': 'content-type',
            'access-control-allow-methods': 'POST, OPTIONS',
            vary: 'origin',
          }
        : {};
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, cors);
      const body = await readBody(req, 4096);
      const e = validCode(body.code);
      if (!e) return send(res, 403, { error: 'invalid or expired code' }, cors);
      const entry = { kind: clip(body.kind, 20) || 'browser', name: clip(body.name, 24), at: Date.now() };
      e.redeemed.push(entry);
      log(`paired ${entry.kind}${entry.name ? ' (' + entry.name + ')' : ''}`);
      return send(res, 200, { token }, cors);
    }
    if (req.method === 'POST' && p === '/rpc') {
      if (req.headers.origin) return send(res, 403, { error: 'forbidden' });
      if (!C.safeEqual(req.headers.authorization || '', 'Bearer ' + token)) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      try {
        return send(res, 200, { result: await handleRpc(body.method, body.params || {}) });
      } catch (e) {
        return send(res, 200, { error: String((e && e.message) || e) });
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    try { send(res, 400, { error: String((e && e.message) || e) }); } catch {}
  }
});

function failPending(b, why) {
  for (const p of b.pending.values()) { clearTimeout(p.t); p.reject(new Error(why)); }
  b.pending.clear();
}

function register(ws, info) {
  const kind = String(info.kind || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'browser';
  const named = String(info.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  const inst = String(info.instanceId || '').slice(0, 64);
  for (const [id, old] of browsers) {
    if (inst && old.info.instanceId === inst) {
      browsers.delete(id);
      try { old.ws.terminate(); } catch {}
      failPending(old, 'browser reconnected');
    }
  }
  const base = named || kind;
  let id = base;
  for (let i = 2; browsers.has(id); i++) id = `${base}-${i}`;
  const b = {
    id,
    ws,
    info: { kind, name: named, instanceId: inst, version: clip(info.version, 16) },
    pending: new Map(),
    since: Date.now(),
    lastSeen: Date.now(),
  };
  browsers.set(id, b);
  log(`connected ${id} (${kind})`);
  return b;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, C.BASE).pathname; } catch {}
  if (!hostOk(req) || isWebOrigin(req) || pathname !== '/ext') {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onExtension(ws));
});

function onExtension(ws) {
  const nonce = crypto.randomBytes(16).toString('hex');
  let b = null;
  const authTimer = setTimeout(() => { if (!b) ws.close(4001, 'auth timeout'); }, 10000);
  ws.send(JSON.stringify({ type: 'challenge', nonce }));

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!b) {
      const ok = m && m.type === 'hello' && typeof m.proof === 'string' && typeof m.nonce === 'string' &&
        m.nonce.length >= 16 && C.safeEqual(m.proof, C.hmac(token, 'ext:' + nonce));
      if (!ok) {
        ws.send(JSON.stringify({ type: 'denied' }));
        ws.close(4003, 'bad token');
        return;
      }
      clearTimeout(authTimer);
      b = register(ws, m.info || {});
      ws.send(JSON.stringify({ type: 'welcome', proof: C.hmac(token, 'relay:' + m.nonce), id: b.id }));
      return;
    }
    b.lastSeen = Date.now();
    if (m.type === 'pong') return;
    const p = m.id && b.pending.get(m.id);
    if (p) {
      b.pending.delete(m.id);
      clearTimeout(p.t);
      if (m.error) p.reject(new Error(String(m.error)));
      else p.resolve(m.result);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (b && browsers.get(b.id) === b) {
      browsers.delete(b.id);
      failPending(b, 'browser disconnected');
      log(`disconnected ${b.id}`);
    }
  });
  ws.on('error', () => {});
}

// Keeps Chromium service workers awake and drops dead sockets.
setInterval(() => {
  const now = Date.now();
  for (const b of browsers.values()) {
    if (now - b.lastSeen > 65000) { try { b.ws.terminate(); } catch {} continue; }
    try { b.ws.send('{"type":"ping"}'); } catch {}
  }
  for (const [code, e] of pairCodes) if (e.expires < now) pairCodes.delete(code);
}, 20000);

process.on('uncaughtException', (e) => log('uncaught: ' + ((e && e.stack) || e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + ((e && e.stack) || e)));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);
  log('server error: ' + e.message);
  process.exit(1);
});
server.listen(C.PORT, '127.0.0.1', () => log(`relay ${C.VERSION} listening on 127.0.0.1:${C.PORT} pid ${process.pid}`));
