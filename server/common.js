'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = require('../package.json').version;
const PORT = Number(process.env.BROWSER_MCP_PORT) || 19789;
const HOME = process.env.BROWSER_MCP_HOME || path.join(os.homedir(), '.browser-mcp');
const TOKEN_FILE = path.join(HOME, 'token');
const OUTPUT_DIR = path.join(HOME, 'output');
const LOG_FILE = path.join(HOME, 'relay.log');
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

function loadOrCreateToken() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const existing = readToken();
  if (existing) return existing;
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600, flag: 'wx' });
    return t;
  } catch {
    const again = readToken();
    if (again) return again;
    throw new Error('cannot create ' + TOKEN_FILE);
  }
}

function hmac(token, msg) {
  return crypto.createHmac('sha256', Buffer.from(token, 'hex')).update(msg).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function health() {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j && j.name === 'browser-mcp-relay' ? j : null;
  } catch {
    return null;
  }
}

async function rpc(method, params = {}, timeoutMs = 70000) {
  const token = readToken();
  if (!token) throw new Error('relay token is missing; the relay has not been started yet');
  const r = await fetch(BASE + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('relay returned HTTP ' + r.status);
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Starts the relay as a detached background process unless one of this version is already running.
async function ensureRelay() {
  let h = await health();
  if (h && h.version !== VERSION) {
    try { await rpc('shutdown', {}, 3000); } catch {}
    for (let i = 0; i < 20 && h; i++) { await sleep(200); h = await health(); }
  }
  if (!h) {
    const child = spawn(process.execPath, [path.join(__dirname, 'relay.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 40 && !h; i++) { await sleep(250); h = await health(); }
    if (!h) throw new Error('the relay did not start; see ' + LOG_FILE);
  }
  return h;
}

module.exports = {
  VERSION, PORT, HOME, TOKEN_FILE, OUTPUT_DIR, LOG_FILE, BASE,
  sleep, readToken, loadOrCreateToken, hmac, safeEqual, health, rpc, ensureRelay,
};
