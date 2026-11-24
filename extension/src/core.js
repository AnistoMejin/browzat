'use strict';
// Background logic shared by the Chromium MV3 service worker (loaded by sw.js) and the Firefox MV2 background page.
// It connects to the local relay, proves and checks the pairing token, and runs the tools the relay sends.

const api = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof api.runtime.getBrowserInfo === 'function';
const DEFAULT_PORT = 19789;
const badge = api.action || api.browserAction;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(Number(v) || 0, lo), hi);

let ws = null;
let linkState = 'offline'; // offline | unpaired | connected | badtoken
let relayId = '';
let connecting = false;
let retryTimer = null;
let lastPairCode = '';
// Open handoffs, by tab id: { hid, message, start, timer, resolve, shown }.
const handoffs = new Map();

function detectKind() {
  if (IS_FIREFOX) return 'firefox';
  const ua = navigator.userAgent;
  if (/\bEdg\//.test(ua)) return 'edge';
  if (/\bOPR\//.test(ua)) return 'opera';
  const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
  if (brands.includes('Brave')) return 'brave';
  if (brands.includes('Google Chrome')) return 'chrome';
  return 'chromium';
}

function randHex(n) {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(tokenHex, msg) {
  const keyBytes = new Uint8Array(tokenHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function setStatus(s) {
  linkState = s;
  try {
    if (handoffs.size) {
      // A handoff is waiting for the user: say so on the toolbar icon whatever the link state is.
      badge.setBadgeText({ text: '?' });
      badge.setBadgeBackgroundColor({ color: '#b26a00' });
      return;
    }
    badge.setBadgeText({ text: s === 'connected' ? 'on' : s === 'badtoken' ? '!' : '' });
    badge.setBadgeBackgroundColor({ color: s === 'connected' ? '#0a7d33' : '#b3261e' });
  } catch (e) {}
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 5000);
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  try {
    const cfg = await api.storage.local.get(['token', 'port', 'name', 'instanceId']);
    if (!cfg.instanceId) {
      cfg.instanceId = crypto.randomUUID();
      await api.storage.local.set({ instanceId: cfg.instanceId });
    }
    if (!cfg.token) { setStatus('unpaired'); return; }

    const sock = new WebSocket('ws://127.0.0.1:' + (cfg.port || DEFAULT_PORT) + '/ext');
    ws = sock;
    let nonce = '';
    let trusted = false; // set only after the relay has proved it knows the token

    sock.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      try {
        if (m.type === 'challenge') {
          nonce = randHex(16);
          sock.send(JSON.stringify({
            type: 'hello',
            proof: await hmacHex(cfg.token, 'ext:' + m.nonce),
            nonce,
            info: { kind: detectKind(), name: cfg.name || '', instanceId: cfg.instanceId, version: api.runtime.getManifest().version },
          }));
        } else if (m.type === 'welcome') {
          if (nonce && m.proof === (await hmacHex(cfg.token, 'relay:' + nonce))) {
            trusted = true;
            relayId = m.id || '';
            setStatus('connected');
          } else {
            setStatus('badtoken');
            sock.close();
          }
        } else if (m.type === 'denied') {
          setStatus('badtoken');
        } else if (m.type === 'ping') {
          sock.send('{"type":"pong"}');
        } else if (m.id && m.method && trusted) {
          let out;
          try {
            out = { id: m.id, result: await handle(m.method, m.params || {}) };
          } catch (e) {
            out = { id: m.id, error: String((e && e.message) || e) };
          }
          if (sock.readyState === 1) sock.send(JSON.stringify(out));
        }
      } catch (e) {}
    };
    sock.onclose = (ev) => {
      if (ws === sock) ws = null;
      if (ev.code === 4003) setStatus('badtoken');
      else if (linkState !== 'badtoken') setStatus('offline');
      scheduleRetry();
    };
    sock.onerror = () => {};
  } catch (e) {
    setStatus('offline');
    scheduleRetry();
  } finally {
    connecting = false;
  }
}

async function reconnect() {
  if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  linkState = 'offline';
  await connect();
}

// ---- tabs opened by the agent ----

const sessionStore = api.storage.session || null;
let agentTabs = null;

async function getAgentTabs() {
  if (agentTabs) return agentTabs;
  let arr = [];
  if (sessionStore) { try { arr = (await sessionStore.get('agentTabs')).agentTabs || []; } catch (e) {} }
  agentTabs = new Set(arr);
  return agentTabs;
}

async function saveAgentTabs() {
  if (sessionStore && agentTabs) { try { await sessionStore.set({ agentTabs: Array.from(agentTabs) }); } catch (e) {} }
}

// A tab the agent is about to open is marked as the agent's the moment the browser creates it, before its first
// request, so the network log and the dialog guard see the page from the start.
const pendingNewTabs = [];
api.tabs.onCreated.addListener((t) => {
  if (pendingNewTabs.length && agentTabs) {
    pendingNewTabs.shift();
    agentTabs.add(t.id);
    earlyMarked.add(t.id);
  }
});
const earlyMarked = new Set();

api.tabs.onRemoved.addListener(async (id) => {
  finishHandoff(id, 'closed', true);
  const s = await getAgentTabs();
  if (s.delete(id)) saveAgentTabs();
});

// ---- handoff: the agent waits while the user does something only a person can do ----

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return String(url || ''); }
}

async function showHandoffCard(tabId, ensure) {
  const h = handoffs.get(tabId);
  if (!h) return false;
  const tab = await api.tabs.get(tabId);
  const res = await run(tabId, bmcpHandoffCard, [{ id: h.hid, message: h.message, origin: originOf(tab.url), ensure: !!ensure }], { frameId: 0 });
  unwrap(res[0]);
  h.shown = true;
  return true;
}

function finishHandoff(tabId, decision, tabGone, via) {
  const h = handoffs.get(tabId);
  if (!h) return;
  handoffs.delete(tabId);
  clearTimeout(h.timer);
  setStatus(linkState);
  if (!tabGone) run(tabId, bmcpHandoffCard, [{ remove: true }], { frameId: 0 }).catch(() => {});
  h.resolve({ decision, via: via || '' });
}

// The page may navigate during the handoff (a login redirect, for example): put the card back on each new page.
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && handoffs.has(tabId)) showHandoffCard(tabId, true).catch(() => {});
});

// ---- helpers ----

function need(p) {
  if (typeof p.tabId !== 'number') throw new Error('tab is required');
  return p.tabId;
}

function normUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(u)) return 'http://' + u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return 'https://' + u;
}

function explain(e) {
  const m = String((e && e.message) || e);
  if (/Cannot access|Missing host permission|cannot be scripted|extensions gallery|chrome:\/\/|edge:\/\/|about:|Cannot script/i.test(m)) {
    return 'this page cannot be read or driven by an extension (' + m + ')';
  }
  return m;
}

function brief(t, agent, extra, cmap) {
  const b = { tabId: t.id, url: t.url || t.pendingUrl || '', title: t.title || '', agent: agent.has(t.id), active: !!t.active };
  const c = cmap && t.cookieStoreId && cmap.get(t.cookieStoreId);
  if (c) b.container = c;
  if (t.group) b.group = t.group;
  return Object.assign(b, extra);
}

// ---- Firefox containers (the feature behind the Multi-Account Containers add-on) ----

async function containerList() {
  if (!api.contextualIdentities) throw new Error('containers exist only in Firefox');
  let list = null;
  try { list = await api.contextualIdentities.query({}); } catch (e) {}
  if (!Array.isArray(list)) throw new Error('containers are switched off in this Firefox');
  return list;
}

async function containerMap() {
  try {
    return new Map((await containerList()).map((c) => [c.cookieStoreId, c.name]));
  } catch (e) {
    return new Map();
  }
}

async function containerId(name) {
  const list = await containerList();
  const want = String(name).trim().toLowerCase();
  const hit = list.find((c) => c.name.toLowerCase() === want);
  if (!hit) throw new Error('no container named ' + JSON.stringify(String(name)) + '; containers: ' + (list.map((c) => c.name).join(', ') || 'none'));
  return hit.cookieStoreId;
}

async function tabIds() {
  return new Set((await api.tabs.query({})).map((x) => x.id));
}

// Multi-Account Containers reopens an assigned site in a new container tab; find that tab.
async function findReplacement(before, goneId, waitMs) {
  const end = Date.now() + waitMs;
  for (;;) {
    const fresh = (await api.tabs.query({})).filter((x) => !before.has(x.id) && x.id !== goneId && /^firefox-container-/.test(x.cookieStoreId || ''));
    if (fresh.length) return fresh.sort((a, b) => b.id - a.id)[0];
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

async function waitForLoad(tabId, timeoutMs, expectLoad, graceMs = 1000) {
  const start = Date.now();
  let sawLoading = false;
  for (;;) {
    const tab = await api.tabs.get(tabId);
    if (tab.status === 'loading') sawLoading = true;
    else if (sawLoading || !expectLoad || Date.now() - start > graceMs) return { tab, timedOut: false };
    if (Date.now() - start > timeoutMs) return { tab, timedOut: true };
    await sleep(120);
  }
}

async function run(tabId, func, args, opts) {
  opts = opts || {};
  const inj = { target: { tabId }, func, args };
  if (opts.allFrames) inj.target.allFrames = true;
  else inj.target.frameIds = [opts.frameId || 0];
  if (opts.world) inj.world = opts.world;
  if (opts.immediate) inj.injectImmediately = true;
  try {
    return await api.scripting.executeScript(inj);
  } catch (e) {
    throw new Error(explain(e));
  }
}

function unwrap(r) {
  if (!r) throw new Error('no result from the page');
  if (r.error) throw new Error(explain(r.error));
  const v = r.result;
  if (!v || typeof v !== 'object' || !('ok' in v)) throw new Error('the page returned nothing (it may have navigated)');
  if (!v.ok) throw new Error(v.error);
  return v.value;
}

function frameOfRef(ref) {
  const m = /^f(\d+)e\d+$/.exec(String(ref || ''));
  return m ? Number(m[1]) : 0;
}

// Runs a page action, then reports whether the tab moved to another URL.
const PAGE_GONE = /navigated|Frame with ID|frame was removed|message port closed|context invalidated|No tab with id|Inspected target navigated|Cannot find context/i;

async function act(p, action) {
  const id = need(p);
  const before = await api.tabs.get(id);
  try { await runDialogs(id, { op: 'install' }); } catch (e) {}
  let done = null;
  let note = '';
  // Real input through the debugger on Chrome and Edge, for elements in the top frame.
  if (HAS_CDP && !p.simulated && frameOfRef(p.ref) === 0) {
    try {
      const r = await realAct(id, p, action);
      if (r && r.done) done = r.done;
      else if (r && r.fallback) note = 'simulated input was used because ' + r.fallback;
    } catch (e) {
      const m = String((e && e.message) || e);
      if (PAGE_GONE.test(m)) done = action + ' sent (the page navigated)';
      else if (/debugger|Cannot attach|Cannot access|another debugger/i.test(m)) note = 'simulated input was used: real input is unavailable here (' + m + ')';
      else throw e;
    }
  }
  if (done == null) {
    try {
      const res = await run(id, bmcpAct, [Object.assign({}, p, { action })], { frameId: frameOfRef(p.ref) });
      done = unwrap(res[0]);
    } catch (e) {
      // A click that starts a navigation can tear the page down before the answer comes back.
      if (!PAGE_GONE.test(String(e.message))) throw e;
      done = action + ' sent (the page navigated)';
    }
  }
  await sleep(350);
  // Firefox may defer an anchor's synthetic default navigation while its tab is in the background. Give links a
  // short loading grace period so click can still report the destination instead of returning the old URL.
  const expectsNavigation = action === 'click' && /^(?:double-)?clicked a(?: |$)/.test(String(done));
  const after = await waitForLoad(id, clamp(p.timeout_ms || 10000, 500, 60000), expectsNavigation, 2500);
  let dialogs = [];
  try { dialogs = await runDialogs(id, { op: 'take' }); } catch (e) {}
  return { done, note, dialogs, url: after.tab.url, title: after.tab.title, navigated: after.tab.url !== before.url };
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:' + blob.type + ';base64,' + btoa(bin);
}

function within(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('screenshot timed out while ' + what)), ms); }),
  ]);
}

async function downscale(dataUrl, maxW, format, quality) {
  try {
    const bmp = await within(createImageBitmap(await (await fetch(dataUrl)).blob()), 10000, 'decoding the image');
    const width = Math.min(bmp.width, maxW);
    const height = Math.round((bmp.height * width) / bmp.width);
    const wanted = format || 'jpeg';
    if (width === bmp.width && dataUrl.startsWith(`data:image/${wanted};`)) return { dataUrl, width: bmp.width, height: bmp.height };
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
    const out = await within(canvas.convertToBlob({ type: `image/${wanted}`, quality: (quality || 70) / 100 }), 10000, 'encoding the image');
    return { dataUrl: await toDataUrl(out), width, height };
  } catch (e) {
    if (/^screenshot timed out/.test(String(e && e.message))) throw e;
    return { dataUrl };
  }
}

async function cropImage(dataUrl, box, maxW, format, quality) {
  const bmp = await within(createImageBitmap(await (await fetch(dataUrl)).blob()), 10000, 'decoding the image');
  const sx = bmp.width / box.viewportWidth;
  const sy = bmp.height / box.viewportHeight;
  const srcX = Math.max(0, Math.round(box.x * sx));
  const srcY = Math.max(0, Math.round(box.y * sy));
  const srcW = Math.max(1, Math.min(bmp.width - srcX, Math.round(box.width * sx)));
  const srcH = Math.max(1, Math.min(bmp.height - srcY, Math.round(box.height * sy)));
  const width = Math.min(srcW, maxW);
  const height = Math.max(1, Math.round(srcH * width / srcW));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bmp, srcX, srcY, srcW, srcH, 0, 0, width, height);
  const out = await within(canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 }), 10000, 'encoding the image');
  return { dataUrl: await toDataUrl(out), width, height };
}

async function captureVisible(id, shot) {
  const t = await api.tabs.get(id);
  const prev = (await api.tabs.query({ active: true, windowId: t.windowId }))[0];
  let raised = false;
  let dataUrl;
  if (!t.active) { await api.tabs.update(id, { active: true }); await sleep(300); }
  try {
    try {
      dataUrl = await api.tabs.captureVisibleTab(t.windowId, shot);
    } catch (e) {
      // A covered or minimised window is not drawn and cannot be captured: bring it forward and retry once.
      const win = await api.windows.get(t.windowId);
      const wasMin = win.state === 'minimized';
      // Windows often refuses a plain focus request; restoring from minimised reliably puts the window on top.
      if (!wasMin) { try { await api.windows.update(t.windowId, { state: 'minimized' }); await sleep(300); } catch (e3) {} }
      const back = win.state === 'maximized' || win.state === 'fullscreen' ? win.state : 'normal';
      await api.windows.update(t.windowId, { state: back });
      try { await api.windows.update(t.windowId, { focused: true }); } catch (e3) {}
      raised = true;
      await sleep(700);
      try {
        dataUrl = await api.tabs.captureVisibleTab(t.windowId, shot);
      } catch (e2) {
        throw new Error('could not capture the tab; the browser window must be visible on screen (' + String((e2 && e2.message) || e2) + ')');
      } finally {
        if (wasMin) { try { await api.windows.update(t.windowId, { state: 'minimized' }); } catch (e3) {} }
      }
    }
  } finally {
    if (prev && prev.id !== id) { try { await api.tabs.update(prev.id, { active: true }); } catch (e) {} }
  }
  return { dataUrl, raised };
}

// ---- real input on Chrome and Edge, through the debugger ----
// Attached only while needed: each command restarts an idle timer, and the debugger detaches when it runs out, so
// the browser's "started debugging this browser" bar is shown only while the agent acts. Firefox has no debugger API
// for extensions and keeps the simulated input of page.js.

const HAS_CDP = !IS_FIREFOX && !!api.debugger;
const CDP_IDLE_MS = 8000;
const cdpTabs = new Map(); // tabId -> { timer }
const cdpWaiters = new Set();

async function cdpAttach(tabId) {
  let s = cdpTabs.get(tabId);
  if (!s) {
    await api.debugger.attach({ tabId }, '1.3');
    s = {};
    cdpTabs.set(tabId, s);
    // Agent tabs usually sit in the background, where Chrome ignores mouse presses and some keys. Focus emulation
    // makes the page behave as if it had focus, without bringing it to the front.
    try { await api.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  }
  clearTimeout(s.timer);
  // Pinned (routes, network conditions or body capture active): stay attached until unpinned.
  const pins = cdpPins.get(tabId);
  if (!pins || !pins.size) s.timer = setTimeout(() => cdpDetach(tabId), CDP_IDLE_MS);
}

const cdpPins = new Map(); // tabId -> Set of reasons ('routes', 'conditions', 'bodies')

async function cdpPin(tabId, reason) {
  if (!cdpPins.has(tabId)) cdpPins.set(tabId, new Set());
  cdpPins.get(tabId).add(reason);
  await cdpAttach(tabId);
}

function cdpUnpin(tabId, reason) {
  const pins = cdpPins.get(tabId);
  if (!pins) return;
  pins.delete(reason);
  if (!pins.size) {
    cdpPins.delete(tabId);
    const s = cdpTabs.get(tabId);
    if (s) { clearTimeout(s.timer); s.timer = setTimeout(() => cdpDetach(tabId), CDP_IDLE_MS); }
  }
}

async function cdpDetach(tabId) {
  const s = cdpTabs.get(tabId);
  if (!s) return;
  cdpTabs.delete(tabId);
  clearTimeout(s.timer);
  try { await api.debugger.detach({ tabId }); } catch (e) {}
}

async function cdp(tabId, method, params) {
  await cdpAttach(tabId);
  return api.debugger.sendCommand({ tabId }, method, params || {});
}

function cdpEvent(tabId, method, ms) {
  return new Promise((resolve) => {
    const w = { tabId, method, resolve };
    cdpWaiters.add(w);
    setTimeout(() => { if (cdpWaiters.delete(w)) resolve(null); }, ms);
  });
}

if (HAS_CDP) {
  api.debugger.onDetach.addListener((src, reason) => {
    const s = cdpTabs.get(src.tabId);
    if (s) { clearTimeout(s.timer); cdpTabs.delete(src.tabId); }
    // The user closed the debugging bar (or the tab went away): everything that needed the debugger is off now.
    if (cdpPins.has(src.tabId)) {
      cdpPins.delete(src.tabId);
      const n = netTab(src.tabId, false);
      if (n) {
        n.routes = [];
        n.conditions = null;
        n.bodies = false;
        n.notice = 'the debugger was detached (' + reason + '): routes, network conditions and body capture were switched off';
      }
    }
  });
  api.debugger.onEvent.addListener((src, method, params) => {
    for (const w of cdpWaiters) {
      if (w.tabId === src.tabId && w.method === method) { cdpWaiters.delete(w); w.resolve(params || {}); }
    }
  });
}

const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS = {
  Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Insert: [45],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34],
  Control: [17, null, 'ControlLeft'], Shift: [16, null, 'ShiftLeft'], Alt: [18, null, 'AltLeft'], Meta: [91, null, 'MetaLeft'],
  ' ': [32, ' ', 'Space'],
};
for (let i = 1; i <= 12; i++) KEYS['F' + i] = [111 + i];
const PUNCT = {
  '-': [189, 'Minus'], '=': [187, 'Equal'], ',': [188, 'Comma'], '.': [190, 'Period'], '/': [191, 'Slash'], ';': [186, 'Semicolon'],
  "'": [222, 'Quote'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'], '\\': [220, 'Backslash'], '`': [192, 'Backquote'],
};
const KEY_ALIAS = { esc: 'Escape', space: ' ', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta', cmd: 'Meta', win: 'Meta', pgup: 'PageUp', pgdn: 'PageDown' };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

function keyInfo(name) {
  const n = KEY_ALIAS[name.toLowerCase()] || name;
  if (KEYS[n]) return { key: n, code: KEYS[n][2] || n, kc: KEYS[n][0], text: KEYS[n][1] || undefined };
  if (n.length === 1) {
    if (/[a-z]/i.test(n)) return { key: n, code: 'Key' + n.toUpperCase(), kc: n.toUpperCase().charCodeAt(0), text: n };
    if (/\d/.test(n)) return { key: n, code: 'Digit' + n, kc: n.charCodeAt(0), text: n };
    if (PUNCT[n]) return { key: n, code: PUNCT[n][1], kc: PUNCT[n][0], text: n };
    return { key: n, code: '', kc: 0, text: n };
  }
  const k = Object.keys(KEYS).find((x) => x.toLowerCase() === n.toLowerCase());
  if (k) return keyInfo(k);
  throw new Error('unknown key ' + JSON.stringify(name));
}

async function cdpKeys(tabId, combo) {
  const raw = String(combo || '');
  const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
  if (raw.endsWith('+') && raw.length > 1) parts.push('+');
  const main = parts.pop();
  if (!main) throw new Error('key is required');
  const mods = parts.map((m) => keyInfo(m));
  let bits = 0;
  for (const m of mods) {
    if (MOD[m.key] == null) throw new Error(m.key + ' is not a modifier (use Control, Shift, Alt or Meta)');
    bits |= MOD[m.key];
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: bits, key: m.key, code: m.code, windowsVirtualKeyCode: m.kc, nativeVirtualKeyCode: m.kc });
  }
  const k = keyInfo(main);
  const shortcut = (bits & (MOD.Alt | MOD.Control | MOD.Meta)) !== 0;
  let text = shortcut ? undefined : k.text;
  if (text && (bits & MOD.Shift) && /^[a-z]$/.test(text)) text = text.toUpperCase();
  const ev = { modifiers: bits, key: text && text.length === 1 && text !== '\r' ? text : k.key, code: k.code, windowsVirtualKeyCode: k.kc, nativeVirtualKeyCode: k.kc };
  const cmd = shortcut && (bits & (MOD.Control | MOD.Meta)) ? EDIT_COMMANDS[k.key.toLowerCase()] : null;
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text }, ev, cmd ? { commands: [cmd] } : {}));
  await cdp(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, ev));
  for (const m of mods.reverse()) {
    bits &= ~MOD[m.key];
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: bits, key: m.key, code: m.code, windowsVirtualKeyCode: m.kc, nativeVirtualKeyCode: m.kc });
  }
}

const BUTTONS = { left: 1, right: 2, middle: 4 };
const mouseHeld = new Map(); // tabId -> button name while a mouse button is held down

async function cdpMouse(tabId, op, x, y, o) {
  o = o || {};
  const button = o.button || 'left';
  const held = mouseHeld.get(tabId);
  const send = (type, extra) => cdp(tabId, 'Input.dispatchMouseEvent', Object.assign({ type, x, y }, extra));
  if (op === 'move') return send('mouseMoved', { button: held || 'none', buttons: held ? BUTTONS[held] : 0 });
  if (op === 'wheel') return send('mouseWheel', { deltaX: Number(o.delta_x) || 0, deltaY: Number(o.delta_y) || 0 });
  if (op === 'down') {
    mouseHeld.set(tabId, button);
    return send('mousePressed', { button, buttons: BUTTONS[button], clickCount: 1 });
  }
  if (op === 'up') {
    mouseHeld.delete(tabId);
    return send('mouseReleased', { button, buttons: 0, clickCount: 1 });
  }
  // click
  await send('mouseMoved', { button: 'none' });
  await sleep(30);
  const n = o.double ? 2 : 1;
  for (let c = 1; c <= n; c++) {
    await send('mousePressed', { button, buttons: BUTTONS[button], clickCount: c });
    await send('mouseReleased', { button, buttons: 0, clickCount: c });
  }
}

async function locate(tabId, a) {
  return unwrap((await run(tabId, bmcpLocate, [a], { frameId: 0 }))[0]);
}

// Dialog guard: injected before agent actions; answers alert/confirm/prompt and records them.
function runDialogs(tabId, o) {
  return run(tabId, bmcpDialogs, [o], IS_FIREFOX ? { frameId: 0 } : { frameId: 0, world: 'MAIN' }).then((r) => unwrap(r[0]));
}

// Real input for click / type / key. Returns null to let the caller fall back to simulated input.
async function realAct(tabId, p, action) {
  if (action === 'click') {
    // Attaching the debugger can add Chrome's debugging bar and move the page in a headed window. Attach first,
    // then locate the element against the settled viewport; otherwise the first click in a new tab can use stale
    // coordinates and land above the target.
    const fresh = !cdpTabs.has(tabId);
    await cdpAttach(tabId);
    if (fresh) await sleep(150);
    const loc = await locate(tabId, { ref: p.ref, selector: p.selector });
    if (loc.disabled) throw new Error('the element is disabled');
    if (!loc.visible || !loc.reachable) return { fallback: loc.visible ? 'it is covered by ' + loc.cover : 'it has no visible area on screen' };
    await cdpMouse(tabId, 'click', loc.x, loc.y, { double: !!p.double, button: p.button });
    return { done: (p.double ? 'double-clicked ' : p.button === 'right' ? 'right-clicked ' : 'clicked ') + loc.desc };
  }
  if (action === 'type') {
    const prepare = p.clear === false ? 'focus-end' : 'focus-select';
    const loc = await locate(tabId, { ref: p.ref, selector: p.selector, focused: !p.ref && !p.selector, prepare });
    if (!loc.textField) return { fallback: '' }; // selects, checkboxes and non-fields keep the simulated path and its messages
    const text = String(p.text == null ? '' : p.text);
    if (text) await cdp(tabId, 'Input.insertText', { text });
    else if (p.clear !== false) await cdpKeys(tabId, 'Delete');
    if (p.submit) await cdpKeys(tabId, 'Enter');
    return { done: 'typed into ' + loc.desc + (p.submit ? ' and pressed Enter' : '') };
  }
  if (action === 'key') {
    let desc = 'the focused element';
    if (p.ref || p.selector) desc = (await locate(tabId, { ref: p.ref, selector: p.selector, focus: true })).desc;
    await cdpKeys(tabId, p.key);
    return { done: 'pressed ' + p.key + ' on ' + desc };
  }
  return null;
}

// ---- network and console ----
// Requests are recorded only for tabs the agent opened, and for tabs it asked to watch (by calling network_requests
// on them). The log lives in memory, at most NET_MAX requests per tab, and is dropped when the tab closes.

const NET_MAX = 500;
const BODY_MAX = 1024 * 1024;
const STATIC_TYPES = new Set(['image', 'imageset', 'font', 'stylesheet', 'media', 'object', 'ping', 'csp_report', 'beacon']);
const nets = new Map();

function netTab(tabId, create) {
  let n = nets.get(tabId);
  if (!n && create) {
    n = { seq: 0, list: [], byReq: new Map(), routes: [], routeSeq: 0, conditions: null, bodies: false, cdpBodies: [], cdpReqs: new Map(), watch: false, notice: '', consoleSince: 0 };
    nets.set(tabId, n);
  }
  return n || null;
}

function netWatched(tabId) {
  if (tabId == null || tabId < 0) return false;
  const n = nets.get(tabId);
  return !!((agentTabs && agentTabs.has(tabId)) || (n && n.watch));
}

function bytesOf(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
  return out;
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return null; }
}

function reqBodyText(rb) {
  if (!rb) return '';
  if (rb.error) return '[' + rb.error + ']';
  if (rb.formData) {
    // The browser hands form posts over as parsed fields, not as the bytes sent: the field order may differ.
    return Object.entries(rb.formData).map(([k, v]) => v.map((x) => encodeURIComponent(k) + '=' + encodeURIComponent(x)).join('&')).join('&') +
      '\n(parsed form fields; their order may differ from the request. For the exact body, record bodies with network_requests bodies: true)';
  }
  if (rb.raw) {
    const parts = rb.raw.map((r) => r.bytes || new ArrayBuffer(0));
    const files = rb.raw.filter((r) => r.file).map((r) => '[file ' + r.file + ']');
    const bytes = bytesOf(parts);
    const t = utf8(bytes.subarray(0, 65536));
    return (t != null ? t : '[' + bytes.length + ' bytes of binary data]') + (files.length ? ' ' + files.join(' ') : '') + (bytes.length > 65536 ? ' …(cut at 64 KB)' : '');
  }
  return '';
}

function patternRe(p) {
  const s = String(p || '');
  // /regex/flags only when the flags are real regex flags; "/api/data" is a path, not /api/ with flags "data".
  const m = /^\/(.+)\/([dgimsuy]*)$/.exec(s);
  if (m) { try { return new RegExp(m[1], m[2]); } catch (e) {} }
  const esc = (x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  if (s.includes('*')) return new RegExp('^' + s.split('*').map(esc).join('.*') + '$');
  return new RegExp(esc(s));
}

function matchRoute(n, url) {
  if (!n || !n.routes.length) return null;
  return n.routes.find((r) => r.re.test(url)) || null;
}

function addEntry(n, d) {
  const e = { n: ++n.seq, reqId: d.requestId, method: d.method, url: d.url, type: d.type, start: d.timeStamp };
  n.list.push(e);
  n.byReq.set(d.requestId, e);
  if (n.list.length > NET_MAX) {
    const old = n.list.shift();
    if (n.byReq.get(old.reqId) === old) n.byReq.delete(old.reqId);
  }
  return e;
}

const WR = api.webRequest;
if (WR) {
  const filter = { urls: ['<all_urls>'] };
  const spec = (base) => (IS_FIREFOX ? base : base.filter((x) => x !== 'blocking').concat(base.some((x) => /Headers$/.test(x)) ? ['extraHeaders'] : []));
  const entryOf = (d) => {
    const n = netWatched(d.tabId) ? netTab(d.tabId, true) : null;
    return n ? [n, n.byReq.get(d.requestId)] : [null, null];
  };

  WR.onBeforeRequest.addListener((d) => {
    if (!netWatched(d.tabId)) return undefined;
    const n = netTab(d.tabId, true);
    let e = n.byReq.get(d.requestId);
    if (!e || e.redirect) e = addEntry(n, d);
    if (d.requestBody) e.reqBody = reqBodyText(d.requestBody);
    if (!IS_FIREFOX) return undefined;
    // Firefox: routes and response bodies are handled here (Chrome and Edge use the debugger for both).
    const route = matchRoute(n, d.url);
    if (route) {
      route.hits++;
      e.route = route.action;
      if (route.action === 'block') { e.error = 'blocked by route ' + route.id; return { cancel: true }; }
      e.mock = route;
      try {
        const f = WR.filterResponseData(d.requestId);
        f.onstart = () => { f.write(new TextEncoder().encode(route.body || '')); f.close(); };
        f.onerror = () => {};
      } catch (err) {}
      return undefined;
    }
    if (n.bodies) {
      try {
        const f = WR.filterResponseData(d.requestId);
        const parts = [];
        let size = 0;
        f.ondata = (ev) => { size += ev.data.byteLength; if (size <= BODY_MAX) parts.push(ev.data); f.write(ev.data); };
        f.onstop = () => { f.close(); e.body = { bytes: bytesOf(parts), size, truncated: size > BODY_MAX }; };
        f.onerror = () => {};
      } catch (err) {}
    }
    return undefined;
  }, filter, spec(['blocking', 'requestBody']));

  WR.onSendHeaders.addListener((d) => {
    const [, e] = entryOf(d);
    if (e) e.reqHeaders = d.requestHeaders || [];
  }, filter, spec(['requestHeaders']));

  WR.onHeadersReceived.addListener((d) => {
    const [, e] = entryOf(d);
    if (!e) return undefined;
    e.status = d.statusCode;
    e.statusLine = d.statusLine || '';
    e.resHeaders = d.responseHeaders || [];
    if (IS_FIREFOX && e.mock) {
      // The mocked body replaces the server's: drop length and encoding, set the type and any extra headers.
      const r = e.mock;
      const drop = new Set(['content-length', 'content-encoding', 'content-type']);
      for (const h of Object.keys(r.headers || {})) drop.add(h.toLowerCase());
      const headers = (d.responseHeaders || []).filter((h) => !drop.has(h.name.toLowerCase()));
      headers.push({ name: 'Content-Type', value: r.contentType || 'text/plain' });
      for (const [k, v] of Object.entries(r.headers || {})) headers.push({ name: k, value: String(v) });
      e.resHeaders = headers;
      return { responseHeaders: headers };
    }
    return undefined;
  }, filter, spec(['blocking', 'responseHeaders']));

  WR.onBeforeRedirect.addListener((d) => {
    const [, e] = entryOf(d);
    if (e) { e.status = d.statusCode; e.redirect = d.redirectUrl; e.end = d.timeStamp; }
  }, filter);
  WR.onCompleted.addListener((d) => {
    const [, e] = entryOf(d);
    if (e) { e.status = d.statusCode; e.end = d.timeStamp; e.fromCache = !!d.fromCache; e.ip = d.ip || ''; }
  }, filter);
  WR.onErrorOccurred.addListener((d) => {
    const [, e] = entryOf(d);
    if (e) { e.error = e.error || d.error; e.end = d.timeStamp; }
  }, filter);
}

api.tabs.onRemoved.addListener((id) => { nets.delete(id); });

// Chrome and Edge: response bodies, routes and network conditions go through the debugger.
async function netNetworkDomain(tabId) {
  const n = netTab(tabId, true);
  if (n.bodies || n.conditions) await cdp(tabId, 'Network.enable', { maxTotalBufferSize: 20 * BODY_MAX, maxResourceBufferSize: BODY_MAX });
  else { try { await cdp(tabId, 'Network.disable'); } catch (e) {} }
}

async function netApplyRoutes(tabId) {
  const n = netTab(tabId, true);
  if (n.routes.length) {
    await cdpPin(tabId, 'routes');
    await cdp(tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  } else {
    try { await cdp(tabId, 'Fetch.disable'); } catch (e) {}
    cdpUnpin(tabId, 'routes');
  }
}

async function netCdpEvent(tabId, method, p) {
  const n = nets.get(tabId);
  if (!n) return;
  if (method === 'Fetch.requestPaused') {
    const route = matchRoute(n, p.request.url);
    const send = (m, params) => api.debugger.sendCommand({ tabId }, m, Object.assign({ requestId: p.requestId }, params)).catch(() => {});
    if (!route) return send('Fetch.continueRequest', {});
    route.hits++;
    if (route.action === 'block') return send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
    const headers = [{ name: 'Content-Type', value: route.contentType || 'text/plain' }];
    for (const [k, v] of Object.entries(route.headers || {})) headers.push({ name: k, value: String(v) });
    return send('Fetch.fulfillRequest', { responseCode: route.status || 200, responseHeaders: headers, body: b64(new TextEncoder().encode(route.body || '')) });
  }
  if (!n.bodies) return;
  if (method === 'Network.requestWillBeSent') {
    const r = { method: p.request.method, url: p.request.url, ts: (p.wallTime || Date.now() / 1000) * 1000, postData: p.request.postData || '' };
    n.cdpReqs.set(p.requestId, r);
    if (p.request.hasPostData && !r.postData) {
      api.debugger.sendCommand({ tabId }, 'Network.getRequestPostData', { requestId: p.requestId }).then((x) => { r.postData = (x && x.postData) || ''; }).catch(() => {});
    }
  } else if (method === 'Network.responseReceived') {
    const r = n.cdpReqs.get(p.requestId);
    if (r) r.mime = p.response.mimeType;
  } else if (method === 'Network.loadingFinished') {
    const r = n.cdpReqs.get(p.requestId);
    n.cdpReqs.delete(p.requestId);
    if (!r || p.encodedDataLength > BODY_MAX * 4) return;
    try {
      const body = await api.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: p.requestId });
      n.cdpBodies.push(Object.assign(r, { body: body.body, base64: !!body.base64Encoded }));
      if (n.cdpBodies.length > 200) n.cdpBodies.shift();
    } catch (e) {}
  } else if (method === 'Network.loadingFailed') {
    n.cdpReqs.delete(p.requestId);
  }
}

if (HAS_CDP) api.debugger.onEvent.addListener((src, method, params) => { netCdpEvent(src.tabId, method, params || {}); });

function bodyFor(n, e) {
  if (e.body) {
    const t = utf8(e.body.bytes);
    return t != null
      ? { text: t, size: e.body.size, truncated: e.body.truncated }
      : { binary: true, size: e.body.size, b64: e.body.size <= 65536 ? b64(e.body.bytes) : '' };
  }
  // Chrome and Edge: the debugger's copy of the same request (same method and URL, closest in time).
  let best = null;
  for (const c of n.cdpBodies) {
    if (c.method === e.method && c.url === e.url && (!best || Math.abs(c.ts - e.start) < Math.abs(best.ts - e.start))) best = c;
  }
  if (!best || Math.abs(best.ts - e.start) > 60000) return null;
  if (!best.base64) return { text: best.body, size: best.body.length, mime: best.mime, postData: best.postData };
  const bin = atob(best.body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const t = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))|\+json|\+xml/.test(best.mime || '') ? utf8(bytes) : null;
  return t != null ? { text: t, size: bytes.length, mime: best.mime, postData: best.postData } : { binary: true, size: bytes.length, mime: best.mime, b64: bytes.length <= 65536 ? best.body : '', postData: best.postData };
}

// Console on Chrome and Edge: enabling the Runtime and Log domains replays the page's stored console messages and
// errors (up to about 1000), including those from before browzat looked.
async function cdpConsole(tabId) {
  const out = [];
  const val = (o) => {
    if (!o) return '';
    if (o.type === 'string') return o.value;
    if (o.value !== undefined) { try { return JSON.stringify(o.value); } catch (e) { return String(o.value); } }
    if (o.unserializableValue) return o.unserializableValue;
    if (o.preview && o.preview.properties) {
      const props = o.preview.properties.map((p) => p.name + ': ' + (p.type === 'string' ? JSON.stringify(p.value) : p.value)).join(', ');
      return o.subtype === 'array' ? '[' + o.preview.properties.map((p) => p.value).join(', ') + ']' : '{' + props + (o.preview.overflow ? ', …' : '') + '}';
    }
    return o.description || o.type;
  };
  const where = (st) => {
    const f = st && st.callFrames && st.callFrames[0];
    return f ? f.url + ':' + (f.lineNumber + 1) : '';
  };
  const onEv = (src, method, p) => {
    if (src.tabId !== tabId || !p) return;
    if (method === 'Runtime.consoleAPICalled') {
      const level = p.type === 'warning' ? 'warn' : p.type === 'assert' ? 'error' : p.type;
      out.push({ level, text: (p.args || []).map(val).join(' ').slice(0, 2000), ts: p.timestamp, where: where(p.stackTrace) });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      out.push({ level: 'error', text: 'Uncaught ' + ((d.exception && d.exception.description) || d.text || 'exception').split('\n')[0], ts: p.timestamp, where: d.url ? d.url + ':' + (d.lineNumber + 1) : '' });
    } else if (method === 'Log.entryAdded') {
      const e = p.entry || {};
      out.push({ level: e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : e.level, text: e.text, ts: e.timestamp, where: e.url ? e.url + (e.lineNumber != null ? ':' + (e.lineNumber + 1) : '') : '', source: e.source });
    }
  };
  api.debugger.onEvent.addListener(onEv);
  try {
    await cdp(tabId, 'Runtime.enable');
    await cdp(tabId, 'Log.enable');
    await sleep(400);
  } finally {
    api.debugger.onEvent.removeListener(onEv);
    try { await cdp(tabId, 'Log.disable'); } catch (e) {}
    try { await cdp(tabId, 'Runtime.disable'); } catch (e) {}
  }
  const seen = new Set();
  return out.filter((m) => {
    const k = m.level + '|' + m.text + '|' + m.ts;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.ts - b.ts);
}

// Install the dialog guard (and on Firefox the console hook) as each new page starts, in tabs the agent works in.
if (api.webNavigation) {
  api.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || !netWatched(d.tabId)) return;
    const opts = { frameId: 0, immediate: true };
    run(d.tabId, bmcpDialogs, [{ op: 'install' }], IS_FIREFOX ? opts : Object.assign({ world: 'MAIN' }, opts)).catch(() => {});
    if (IS_FIREFOX) run(d.tabId, bmcpConsole, [{ op: 'install' }], opts).catch(() => {});
  });
}

// ---- tools ----

async function editTabs(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 9 || !/tabs cannot be edited right now|dragging a tab/i.test(String((e && e.message) || e))) throw e;
      await sleep(100);
    }
  }
}

const handlers = {
  async tabs(p) {
    const action = p.action || 'list';
    const agent = await getAgentTabs();
    if (action === 'containers') return { containers: (await containerList()).map((c) => c.name) };
    const cmap = await containerMap();
    if (action === 'list') {
      const all = await api.tabs.query({});
      return { tabs: all.filter((t) => p.all || agent.has(t.id)).map((t) => brief(t, agent, null, cmap)), total: all.length };
    }
    if (action === 'new') {
      const url = normUrl(p.url) || 'about:blank';
      const create = { url, active: !!p.active };
      if (p.container) create.cookieStoreId = await containerId(p.container);
      const before = await tabIds();
      let t;
      let group = '';
      pendingNewTabs.push(true);
      try {
        t = await api.tabs.create(create);
      } catch (e) {
        if (create.cookieStoreId) { pendingNewTabs.pop(); throw e; }
        const w = await api.windows.create({ url, focused: !!p.active });
        t = w.tabs[0];
      } finally {
        // If a different tab was created at the same moment and got marked by mistake, unmark it.
        for (const x of earlyMarked) if (x !== t?.id) agent.delete(x);
        earlyMarked.clear();
        pendingNewTabs.pop();
      }
      agent.add(t.id);
      await saveAgentTabs();
      if (!IS_FIREFOX && api.tabs.group && api.tabGroups) {
        try {
          const groupId = await editTabs(() => api.tabs.group({ tabIds: [t.id] }));
          await editTabs(() => api.tabGroups.update(groupId, { title: 'browzat', color: 'green', collapsed: false }));
          t.group = group = 'browzat';
        } catch (e) {}
      }
      if (url === 'about:blank') return brief(t, agent, null, cmap);
      const timeout = clamp(p.timeout_ms || 30000, 1000, 120000);
      let r;
      let reopened = false;
      try {
        r = await waitForLoad(t.id, timeout, true);
      } catch (e) {
        // The new tab vanished: the containers add-on closed it and reopened the site in its assigned container.
        const repl = await findReplacement(before, t.id, 1500);
        if (!repl) throw new Error('the new tab was closed before it loaded');
        agent.delete(t.id);
        agent.add(repl.id);
        await saveAgentTabs();
        r = await waitForLoad(repl.id, timeout, true);
        reopened = true;
      }
      return brief(r.tab, agent, { timedOut: r.timedOut, reopened, group }, cmap);
    }
    if (action === 'close') {
      const id = need(p);
      if (!agent.has(id) && !p.force) throw new Error('this tab was not opened by you; close it only if the user asks (force: true)');
      await api.tabs.remove(id);
      return { closed: id };
    }
    if (action === 'cleanup') {
      const ids = [...agent];
      const alive = [];
      for (const id of ids) { try { await api.tabs.get(id); alive.push(id); } catch (e) { agent.delete(id); } }
      if (alive.length) await editTabs(() => api.tabs.remove(alive));
      for (const id of alive) agent.delete(id);
      await saveAgentTabs();
      return { closed: alive };
    }
    if (action === 'activate') {
      const t = await api.tabs.update(need(p), { active: true });
      try { await api.windows.update(t.windowId, { focused: true }); } catch (e) {}
      return brief(t, agent, null, cmap);
    }
    throw new Error('unknown tabs action ' + action);
  },

  async navigate(p) {
    const id = need(p);
    const agent = await getAgentTabs();
    const timeout = clamp(p.timeout_ms || 30000, 1000, 120000);
    const start = await api.tabs.get(id);
    const before = api.contextualIdentities && p.url && !p.action ? await tabIds() : null;
    if (p.action === 'back' || p.action === 'forward') {
      const back = p.action === 'back';
      try {
        await (back ? api.tabs.goBack(id) : api.tabs.goForward(id));
      } catch (e) {
        // Chromium hides history entries the page left without a real user gesture; the page's own history still has them.
        const moved = (b) => {
          if (history.length < 2) return { ok: true, value: false };
          if (b) history.back(); else history.forward();
          return { ok: true, value: true };
        };
        if (!unwrap((await run(id, moved, [back], { frameId: 0 }))[0])) {
          throw new Error('there is no ' + (back ? 'previous' : 'next') + ' page in this tab');
        }
      }
    } else if (p.action === 'reload') await api.tabs.reload(id);
    else {
      const url = normUrl(p.url);
      if (!url) throw new Error('url or action is required');
      await api.tabs.update(id, { url });
    }
    let r = null;
    let reopened = false;
    try {
      r = await waitForLoad(id, timeout, true);
    } catch (e) {
      if (!before) throw e;
    }
    // If this tab did not move (or vanished) and a container tab appeared, the containers add-on took the site there.
    if (before && (!r || r.tab.url === start.url)) {
      const repl = await findReplacement(before, id, r ? 300 : 1500);
      if (repl) {
        if (!r) agent.delete(id);
        agent.add(repl.id);
        await saveAgentTabs();
        r = await waitForLoad(repl.id, timeout, true);
        reopened = true;
      }
    }
    if (!r) throw new Error('the tab was closed during navigation');
    return brief(r.tab, agent, { timedOut: r.timedOut, reopened }, await containerMap());
  },

  async snapshot(p) {
    const id = need(p);
    const opts = {
      interactive: !!p.interactive,
      find: p.find || '',
      selector: p.selector || '',
      hrefs: !!p.hrefs,
      maxChars: clamp(p.max_chars || 10000, 500, 60000),
      prefix: '',
    };
    const top = unwrap((await run(id, bmcpSnapshot, [opts], { frameId: 0 }))[0]);
    if (!p.frames) return top;
    let frames = [];
    try { frames = await run(id, () => location.href, [], { allFrames: true }); } catch (e) {}
    for (const f of frames.filter((x) => x.frameId !== 0).slice(0, 10)) {
      const left = opts.maxChars - top.text.length;
      if (left < 300) { top.truncated = true; break; }
      try {
        const sub = unwrap((await run(id, bmcpSnapshot, [Object.assign({}, opts, { selector: '', maxChars: left, prefix: 'f' + f.frameId })], { frameId: f.frameId }))[0]);
        if (sub.text) top.text += '\n--- iframe ' + sub.url + ' ---\n' + sub.text;
        if (sub.truncated) top.truncated = true;
      } catch (e) {}
    }
    return top;
  },

  click: (p) => act(p, 'click'),
  type: (p) => act(p, 'type'),
  press_key: (p) => act(p, 'key'),

  async evaluate(p) {
    const id = need(p);
    const code = String(p.code || '');
    if (!code.trim()) throw new Error('code is required');
    if (!IS_FIREFOX) {
      return { value: unwrap((await run(id, bmcpEval, [code], { frameId: 0, world: 'MAIN' }))[0]) };
    }
    const wrap = (body) =>
      '(async () => { const ser = (' + bmcpSer.toString() + '); try { return { ok: true, value: ser(await (async () => {' + body +
      '\n})()) }; } catch (e) { return { ok: false, error: String(e) }; } })()';
    let res;
    try {
      // First as an expression; if that does not parse, as a function body.
      res = await api.tabs.executeScript(id, { code: wrap('return (' + code + '\n);'), frameId: 0 });
    } catch (e1) {
      try {
        res = await api.tabs.executeScript(id, { code: wrap(code), frameId: 0 });
      } catch (e2) {
        throw new Error(explain(e2));
      }
    }
    const v = res && res[0];
    if (!v || typeof v !== 'object' || !('ok' in v)) throw new Error('the page returned nothing');
    if (!v.ok) throw new Error(v.error);
    return { value: v.value };
  },

  async wait_for(p) {
    const id = need(p);
    if (!p.text && !p.selector) {
      const ms = clamp(p.time_ms || 1000, 0, 60000);
      await sleep(ms);
      return { waited: ms };
    }
    const timeout = clamp(p.timeout_ms || 10000, 100, 120000);
    const start = Date.now();
    for (;;) {
      let hit = false;
      try { hit = unwrap((await run(id, bmcpCheck, [{ text: p.text, selector: p.selector }], { frameId: 0 }))[0]); } catch (e) {}
      if (p.gone ? !hit : hit) return { ms: Date.now() - start };
      if (Date.now() - start > timeout) {
        throw new Error('timed out after ' + timeout + ' ms waiting for ' + (p.selector ? 'selector ' + p.selector : JSON.stringify(p.text)) + (p.gone ? ' to disappear' : ''));
      }
      await sleep(250);
    }
  },

  async screenshot(p) {
    const id = need(p);
    const format = ['jpeg', 'png', 'webp'].includes(p.format) ? p.format : 'jpeg';
    const quality = clamp(p.quality || 70, 1, 100);
    const mode = p.ref || p.selector ? 'element' : p.full_page ? 'full' : 'viewport';
    let dataUrl;
    let raised = false;
    let desc = '';
    if (mode === 'element' && HAS_CDP && !p.transparent) {
      const box = unwrap((await run(id, function (a) {
        const state = globalThis.__bmcp;
        const el = a.ref ? state && state.els.get(a.ref) : document.querySelector(a.selector);
        if (!el || !el.isConnected) throw new Error(a.ref ? 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' : 'selector matched nothing: ' + a.selector);
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) throw new Error('the element has no visible area');
        const label = (el.getAttribute('aria-label') || el.innerText || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return { ok: true, value: { x: r.left, y: r.top, width: r.width, height: r.height,
          viewportWidth: innerWidth, viewportHeight: innerHeight, desc: el.localName + (label ? ' "' + label + '"' : '') } };
      }, [{ ref: p.ref, selector: p.selector }], { frameId: 0 }))[0]);
      const visible = await captureVisible(id, { format: 'png' });
      const cropped = await cropImage(visible.dataUrl, box, clamp(p.max_width || 1280, 320, 8192), format, quality);
      dataUrl = cropped.dataUrl;
      raised = visible.raised;
      desc = box.desc;
    } else if (mode !== 'viewport' && HAS_CDP) {
      await cdpPin(id, 'output-screenshot');
      let clip;
      if (mode === 'full') {
        const metrics = await cdp(id, 'Page.getLayoutMetrics');
        const box = metrics.cssContentSize || metrics.contentSize;
        clip = { x: 0, y: 0, width: Math.min(box.width, 16384), height: Math.min(box.height, 16384), scale: 1 };
      } else {
        const box = unwrap((await run(id, function (a) {
          const state = globalThis.__bmcp;
          let el = a.ref ? state && state.els.get(a.ref) : document.querySelector(a.selector);
          if (!el || !el.isConnected) throw new Error(a.ref ? 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' : 'selector matched nothing: ' + a.selector);
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) throw new Error('the element has no visible area');
          const label = (el.getAttribute('aria-label') || el.innerText || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          return { ok: true, value: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, desc: el.localName + (label ? ' "' + label + '"' : '') } };
        }, [{ ref: p.ref, selector: p.selector }], { frameId: 0 }))[0]);
        clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
        desc = box.desc;
      }
      try {
        if (p.transparent) await cdp(id, 'Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        // Some Google Chrome builds leave Page.captureScreenshot pending forever when CDP is asked for WebP.
        // Capture losslessly as PNG and let downscale() do the WebP encoding, as the other capture paths do.
        const captureFormat = format === 'webp' ? 'png' : format;
        const shot = { format: captureFormat, captureBeyondViewport: true, fromSurface: true, clip };
        if (captureFormat !== 'png') shot.quality = quality;
        const out = await within(cdp(id, 'Page.captureScreenshot', shot), 10000, 'capturing the page');
        dataUrl = `data:image/${captureFormat};base64,${out.data}`;
      } finally {
        if (p.transparent) { try { await cdp(id, 'Emulation.setDefaultBackgroundColorOverride'); } catch (e) {} }
        cdpUnpin(id, 'output-screenshot');
        // A second Page.captureScreenshot on the same debugger attachment can remain pending in Google Chrome
        // after a full-page capture. Screenshots do not benefit from the idle attachment cache, so start the next
        // one with a fresh session unless another feature (routes, conditions or bodies) still needs this session.
        if (!cdpPins.has(id)) await cdpDetach(id);
      }
    } else if (api.tabs.captureTab) {
      if (p.transparent) throw new Error('screenshot: transparent is not supported on Firefox');
      const shot = { format: format === 'webp' ? 'png' : format };
      if (shot.format === 'jpeg') shot.quality = quality;
      if (mode !== 'viewport') {
        const box = unwrap((await run(id, function (a) {
          if (!a.target) return { ok: true, value: { x: 0, y: 0, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
          const state = globalThis.__bmcp;
          const el = a.ref ? state && state.els.get(a.ref) : document.querySelector(a.selector);
          if (!el || !el.isConnected) throw new Error(a.ref ? 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' : 'selector matched nothing: ' + a.selector);
          const r = el.getBoundingClientRect();
          const label = (el.getAttribute('aria-label') || el.innerText || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          return { ok: true, value: { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height, desc: el.localName + (label ? ' "' + label + '"' : '') } };
        }, [{ target: mode === 'element', ref: p.ref, selector: p.selector }], { frameId: 0 }))[0]);
        shot.rect = { x: box.x, y: box.y, width: Math.min(box.width, 16384), height: Math.min(box.height, 16384) };
        desc = box.desc || '';
      }
      dataUrl = await api.tabs.captureTab(id, shot);
    } else {
      // Chromium can only capture the visible tab of a window: show it, capture, then put the user's tab back.
      const shot = { format: format === 'webp' ? 'png' : format };
      if (shot.format === 'jpeg') shot.quality = quality;
      const visible = await captureVisible(id, shot);
      dataUrl = visible.dataUrl;
      raised = visible.raised;
    }
    return Object.assign(await downscale(dataUrl, clamp(p.max_width || 1280, 320, 8192), format, quality), { raised, mode, desc });
  },
};

handlers.hover = async (p) => {
  const id = need(p);
  if (HAS_CDP && !p.simulated && frameOfRef(p.ref) === 0) {
    try {
      const loc = await locate(id, { ref: p.ref, selector: p.selector });
      if (loc.visible) {
        await cdpMouse(id, 'move', loc.x, loc.y);
        return { done: 'hovered over ' + loc.desc };
      }
    } catch (e) {
      if (/ref |selector /.test(String(e.message))) throw e;
    }
  }
  return { done: unwrap((await run(id, bmcpPointer, [{ action: 'hover', ref: p.ref, selector: p.selector }], { frameId: frameOfRef(p.ref) }))[0]) };
};

handlers.drag = async (p) => {
  const id = need(p);
  try { await runDialogs(id, { op: 'install' }); } catch (e) {}
  if (HAS_CDP && !p.simulated && frameOfRef(p.from_ref) === 0 && frameOfRef(p.to_ref) === 0) {
    let a = await locate(id, { ref: p.from_ref, selector: p.from_selector });
    let b = await locate(id, { ref: p.to_ref, selector: p.to_selector, noscroll: true });
    if (!b.visible) {
      b = await locate(id, { ref: p.to_ref, selector: p.to_selector });
      a = await locate(id, { ref: p.from_ref, selector: p.from_selector, noscroll: true });
    }
    if (a.visible && b.visible) {
      // HTML5 drag and drop: let the debugger intercept the drag so it can be replayed onto the target.
      await cdp(id, 'Input.setInterceptDrags', { enabled: true });
      let drag = null;
      let dropped = false;
      const intercepted = cdpEvent(id, 'Input.dragIntercepted', 2000);
      try {
        intercepted.then((d) => { drag = d; });
        await cdpMouse(id, 'move', a.x, a.y);
        await cdpMouse(id, 'down', a.x, a.y);
        const steps = 6;
        for (let i = 1; i <= steps && !drag; i++) {
          await cdpMouse(id, 'move', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
          await sleep(30);
        }
        // A fresh or busy browser can report the drag start late. Use the resolved value directly so cleanup and
        // fallback do not depend on the timing of the separate .then() callback above.
        if (!drag) drag = await intercepted;
        if (drag && drag.data) {
          // An HTML5 drag started: the browser handed it to us; replay it over the target and drop it there.
          await cdp(id, 'Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data: drag.data });
          await cdp(id, 'Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data: drag.data });
          await cdp(id, 'Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data: drag.data });
          dropped = true;
        } else {
          await cdpMouse(id, 'move', b.x, b.y);
          await cdpMouse(id, 'up', b.x, b.y);
          mouseHeld.delete(id);
          const fallback = unwrap((await run(id, bmcpPointer, [Object.assign({ action: 'drag' }, p)], { frameId: 0 }))[0]);
          return { done: fallback };
        }
        await cdpMouse(id, 'up', b.x, b.y);
        return { done: 'dragged ' + a.desc + ' onto ' + b.desc + (drag ? ' (HTML5 drag and drop)' : ' (mouse drag)') };
      } finally {
        mouseHeld.delete(id);
        // Never leave a drag half-finished: the tab would ignore mouse presses afterwards. A drag start that arrives
        // even later than the wait above is cancelled too.
        if (!dropped) {
          const late = drag || (await Promise.race([intercepted, sleep(300)]));
          if (late && late.data) { try { await cdp(id, 'Input.dispatchDragEvent', { type: 'dragCancel', x: b.x, y: b.y, data: late.data }); } catch (e) {} }
        }
        try { await cdp(id, 'Input.setInterceptDrags', { enabled: false }); } catch (e) {}
        // Chromium can keep its internal pointer in drag mode briefly after the command resolves. A neutral move
        // after disabling interception resets it so the next ordinary coordinate click is not swallowed.
        try { await cdpMouse(id, 'move', b.x, b.y); } catch (e) {}
        await sleep(100);
      }
    }
  }
  return { done: unwrap((await run(id, bmcpPointer, [Object.assign({ action: 'drag' }, p)], { frameId: 0 }))[0]) };
};

handlers.mouse = async (p) => {
  const id = need(p);
  const op = p.op || 'click';
  if (!['click', 'move', 'down', 'up', 'wheel'].includes(op)) throw new Error('op must be click, move, down, up or wheel');
  try { await runDialogs(id, { op: 'install' }); } catch (e) {}
  const before = await api.tabs.get(id);
  let done;
  if (HAS_CDP && !p.simulated) {
    await cdpMouse(id, op, Number(p.x) || 0, Number(p.y) || 0, p);
    done = (op === 'click' ? (p.double ? 'double-click' : p.button === 'right' ? 'right-click' : 'click') : op) + ' at ' + Math.round(p.x) + ',' + Math.round(p.y);
  } else {
    done = unwrap((await run(id, bmcpPointer, [Object.assign({ action: 'mouse', op }, p)], { frameId: 0 }))[0]);
  }
  await sleep(250);
  const after = await waitForLoad(id, 10000, false);
  let dialogs = [];
  try { dialogs = await runDialogs(id, { op: 'take' }); } catch (e) {}
  return { done, dialogs, url: after.tab.url, navigated: after.tab.url !== before.url };
};

handlers.upload = async (p) => {
  const id = need(p);
  const files = Array.isArray(p.files) ? p.files : [];
  if (!files.length) throw new Error('files is required');
  const names = files.map((f) => f.name).join(', ');
  if (HAS_CDP) {
    const mark = randHex(8);
    const found = unwrap((await run(id, bmcpFiles, [{ op: 'find', ref: p.ref, selector: p.selector, mark }], { frameId: 0 }))[0]);
    if (found.input) {
      if (files.length > 1 && !found.multiple) throw new Error('this file input takes one file only');
      try {
        const doc = await cdp(id, 'DOM.getDocument', { depth: 0 });
        const q = await cdp(id, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-bmcp-upload="' + mark + '"]' });
        if (!q || !q.nodeId) throw new Error('could not find the file input through the debugger');
        await cdp(id, 'DOM.setFileInputFiles', { files: files.map((f) => f.path), nodeId: q.nodeId });
      } finally {
        run(id, bmcpFiles, [{ op: 'unmark' }], { frameId: 0 }).catch(() => {});
      }
      return { done: 'attached ' + files.length + ' file(s) to the file input: ' + names };
    }
    // No file input to target directly: click the element and catch the file chooser it opens.
    const loc = await locate(id, { ref: p.ref, selector: p.selector });
    if (!loc.visible) throw new Error('found no file input, and the element is not visible to click');
    await cdp(id, 'Page.enable');
    await cdp(id, 'Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const opened = cdpEvent(id, 'Page.fileChooserOpened', 5000);
      await cdpMouse(id, 'click', loc.x, loc.y);
      const ev = await opened;
      if (!ev) throw new Error('clicking ' + loc.desc + ' did not open a file chooser; target the <input type=file> itself (snapshot with selector "input[type=file]")');
      if (files.length > 1 && ev.mode === 'selectSingle') throw new Error('this file chooser takes one file only');
      await cdp(id, 'DOM.setFileInputFiles', { files: files.map((f) => f.path), backendNodeId: ev.backendNodeId });
    } finally {
      try { await cdp(id, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch (e) {}
    }
    return { done: 'chose ' + files.length + ' file(s) in the file chooser of ' + loc.desc + ': ' + names };
  }
  // Firefox: the files travel as base64 and are put on the input in the page.
  if (files.some((f) => typeof f.data !== 'string')) throw new Error('file contents are missing');
  const r = unwrap((await run(id, bmcpFiles, [{ op: 'set', ref: p.ref, selector: p.selector, files }], { frameId: 0 }))[0]);
  if (r.input === false) throw new Error('found no file input for this element; target the <input type=file> itself (snapshot with selector "input[type=file]")');
  return { done: 'attached ' + r.count + ' file(s) to the file input: ' + names };
};

handlers.dialog = async (p) => {
  const id = need(p);
  const action = p.action === 'accept' ? 'accept' : 'dismiss';
  await runDialogs(id, { op: 'arm', action, text: p.text, keep: !!p.keep });
  const seen = await runDialogs(id, { op: 'take' });
  return {
    done: (p.keep ? 'from now on every dialog in this page will be ' : 'the next dialog will be ') +
      (action === 'accept' ? 'accepted' : 'dismissed') + (action === 'accept' && p.text != null ? ' with the text ' + JSON.stringify(String(p.text)) : ''),
    dialogs: seen,
  };
};

async function isAgentTab(id) {
  return (await getAgentTabs()).has(id);
}

handlers.network_requests = async (p) => {
  const id = need(p);
  await api.tabs.get(id); // fails clearly if the tab is gone
  const n = netTab(id, true);
  const startedNow = !n.watch && !(await isAgentTab(id));
  if (startedNow) n.watch = true;
  const notes = [];
  if (n.notice) { notes.push(n.notice); n.notice = ''; }
  if (p.bodies === true && !n.bodies) {
    n.bodies = true;
    if (HAS_CDP) { await cdpPin(id, 'bodies'); await netNetworkDomain(id); }
    notes.push('response bodies are now recorded for new requests in this tab' + (HAS_CDP ? ' (the debugging bar stays until bodies: false)' : ''));
  } else if (p.bodies === false && n.bodies) {
    n.bodies = false;
    if (HAS_CDP) { await netNetworkDomain(id); cdpUnpin(id, 'bodies'); }
    notes.push('response bodies are no longer recorded');
  }
  if (p.clear) { n.list = []; n.byReq.clear(); n.cdpBodies = []; }
  if (startedNow) notes.push('this is not a tab you opened: recording starts now, earlier requests are not available; reload the page to see them');
  let list = n.list.slice();
  if (!p.include_static) list = list.filter((e) => !STATIC_TYPES.has(e.type));
  if (p.type) { const want = new Set(String(p.type).split(',').map((s) => s.trim())); list = list.filter((e) => want.has(e.type)); }
  if (p.filter) { const re = patternRe(p.filter); list = list.filter((e) => re.test(e.url)); }
  if (p.failed) list = list.filter((e) => e.error || (e.status >= 400));
  const total = list.length;
  const limit = clamp(p.limit || 50, 1, NET_MAX);
  list = list.slice(-limit);
  return {
    requests: list.map((e) => ({
      n: e.n, method: e.method, url: e.url, type: e.type, status: e.status || 0, error: e.error || '',
      ms: e.end ? Math.round(e.end - e.start) : null, cache: !!e.fromCache, route: e.route || '', redirect: e.redirect || '',
    })),
    total, shown: list.length, bodies: n.bodies, routes: n.routes.length, notes,
  };
};

handlers.network_request = async (p) => {
  const id = need(p);
  const n = netTab(id, false);
  const e = n && n.list.find((x) => x.n === Number(p.request));
  if (!e) throw new Error('no request ' + p.request + ' in this tab; list them with network_requests');
  const out = {
    n: e.n, method: e.method, url: e.url, type: e.type, status: e.status || 0, statusLine: e.statusLine || '', error: e.error || '',
    ms: e.end ? Math.round(e.end - e.start) : null, cache: !!e.fromCache, ip: e.ip || '', redirect: e.redirect || '', route: e.route || '',
    reqHeaders: (e.reqHeaders || []).map((h) => [h.name, h.value]),
    resHeaders: (e.resHeaders || []).map((h) => [h.name, h.value]),
    reqBody: e.reqBody || '',
  };
  const body = bodyFor(n, e);
  if (body && body.postData) out.reqBody = body.postData; // the exact bytes, from the debugger
  if (body) { delete body.postData; out.body = body; }
  else out.bodyNote = n.bodies ? 'no response body was captured for this request (it may have had none, been cached, or been too large)' :
    'response bodies are not being recorded: call network_requests with bodies: true, then repeat the request';
  return out;
};

handlers.network_route = async (p) => {
  const id = need(p);
  const n = netTab(id, true);
  const action = p.action || 'add';
  if (action === 'list') {
    return { routes: n.routes.map((r) => ({ id: r.id, pattern: r.pattern, action: r.action, status: r.status, hits: r.hits })) };
  }
  if (action === 'clear' || action === 'remove') {
    const before = n.routes.length;
    n.routes = action === 'clear' ? [] : n.routes.filter((r) => r.id !== Number(p.id) && r.pattern !== p.pattern);
    if (HAS_CDP) await netApplyRoutes(id);
    return { done: 'removed ' + (before - n.routes.length) + ' route(s); ' + n.routes.length + ' left' };
  }
  if (action !== 'add') throw new Error('action must be add, remove, list or clear');
  if (!p.pattern) throw new Error('pattern is required (a substring, a glob with *, or /regex/)');
  const r = {
    id: ++n.routeSeq, pattern: String(p.pattern), re: patternRe(p.pattern), action: p.block ? 'block' : 'mock',
    status: p.block ? 0 : clamp(p.status || 200, 100, 599), body: p.body == null ? '' : String(p.body),
    contentType: p.content_type || (p.body && /^\s*[{[]/.test(String(p.body)) ? 'application/json' : 'text/plain'),
    headers: p.headers && typeof p.headers === 'object' ? p.headers : {}, hits: 0,
  };
  n.routes.push(r);
  if (!(await isAgentTab(id))) n.watch = true;
  if (HAS_CDP) await netApplyRoutes(id);
  const note = !HAS_CDP && r.action === 'mock' && r.status !== 200
    ? ' (Firefox cannot change the status code: the server\'s status is kept, the body and headers are replaced)' : '';
  return { done: 'route ' + r.id + ': ' + (r.action === 'block' ? 'blocking' : 'mocking with status ' + r.status) + ' requests matching ' + JSON.stringify(r.pattern) + note + (HAS_CDP ? '; the debugging bar stays while routes exist' : '') };
};

handlers.network_conditions = async (p) => {
  const id = need(p);
  if (!HAS_CDP) throw new Error('network conditions (offline, slow network) are not available in Firefox: it has no API for them');
  const n = netTab(id, true);
  if (p.reset) {
    n.conditions = null;
    try { await cdp(id, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch (e) {}
    await netNetworkDomain(id);
    cdpUnpin(id, 'conditions');
    return { done: 'network conditions reset to normal' };
  }
  const kbps = (v) => (v == null ? -1 : Math.max(1, Number(v)) * 1024 / 8);
  n.conditions = { offline: !!p.offline, latency: clamp(p.latency_ms || 0, 0, 60000), download: kbps(p.download_kbps), upload: kbps(p.upload_kbps) };
  await cdpPin(id, 'conditions');
  await netNetworkDomain(id);
  await cdp(id, 'Network.emulateNetworkConditions', { offline: n.conditions.offline, latency: n.conditions.latency, downloadThroughput: n.conditions.download, uploadThroughput: n.conditions.upload });
  return { done: n.conditions.offline ? 'this tab is now offline' : 'network conditions set: ' + n.conditions.latency + ' ms latency' +
    (p.download_kbps ? ', ' + p.download_kbps + ' kbit/s down' : '') + (p.upload_kbps ? ', ' + p.upload_kbps + ' kbit/s up' : '') + ' (reset with reset: true; the debugging bar stays until then)' };
};

handlers.console_messages = async (p) => {
  const id = need(p);
  const n = netTab(id, true);
  let entries;
  let note = '';
  if (HAS_CDP) {
    entries = await cdpConsole(id);
  } else {
    const r = unwrap((await run(id, bmcpConsole, [{ op: 'take' }], { frameId: 0 }))[0]);
    entries = r.entries;
    if (!(await isAgentTab(id)) && !n.watch) {
      n.watch = true;
      note = 'console capture in this tab starts now (Firefox records messages only from when browzat starts watching); reload the page to capture its start-up messages';
    }
  }
  entries = entries.filter((m) => m.ts > n.consoleSince);
  if (p.clear) n.consoleSince = Date.now();
  const lv = p.level || 'all';
  const rank = { error: 3, warn: 2, info: 1, log: 1, debug: 0 };
  if (lv === 'error') entries = entries.filter((m) => m.level === 'error');
  else if (lv === 'warn') entries = entries.filter((m) => (rank[m.level] || 0) >= 2);
  else if (lv !== 'all' && lv !== 'debug') entries = entries.filter((m) => (rank[m.level] || 0) >= 1);
  const total = entries.length;
  const limit = clamp(p.limit || 100, 1, 1000);
  return { messages: entries.slice(-limit), total, note };
};

handlers.handoff = async (p) => {
  const id = need(p);
  const message = String(p.message || '').trim().slice(0, 600) || 'Please finish this step in the page, then click Continue.';
  const timeoutMs = clamp((Number(p.timeout_s) || 300) * 1000, 10000, 600000);
  finishHandoff(id, 'replaced');

  // Bring the tab and its window to the front: the user has to act there.
  const tab = await api.tabs.update(id, { active: true });
  try { await api.windows.update(tab.windowId, { focused: true }); } catch (e) {}

  const start = Date.now();
  const decided = new Promise((resolve) => {
    handoffs.set(id, {
      hid: randHex(12), message, start, resolve, shown: false,
      timer: setTimeout(() => finishHandoff(id, 'timeout'), timeoutMs),
    });
  });
  setStatus(linkState);

  let cardError = '';
  try { await showHandoffCard(id, false); } catch (e) { cardError = String((e && e.message) || e); }

  const { decision, via } = await decided;
  let after = null;
  try { after = await api.tabs.get(id); } catch (e) {}
  return {
    decision,
    via,
    ms: Date.now() - start,
    url: after ? after.url : '',
    title: after ? after.title : '',
    cardError,
  };
};

// Internal (not an MCP tool): reloads this extension from disk so new code is picked up without a click.
handlers._reload = async () => {
  setTimeout(() => api.runtime.reload(), 300);
  return { reloading: true };
};

async function handle(method, params) {
  const h = handlers[method];
  if (!h) throw new Error('unknown tool ' + method);
  return h(params);
}

// ---- pairing: opening the relay's pairing link in this browser hands the token to this extension ----

async function redeem(port, code) {
  const cfg = await api.storage.local.get(['port', 'name']);
  if (port !== (cfg.port || DEFAULT_PORT)) return;
  const r = await fetch('http://127.0.0.1:' + port + '/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, kind: detectKind(), name: cfg.name || '' }),
  });
  if (!r.ok) return;
  const j = await r.json();
  if (!/^[a-f0-9]{64}$/.test(j.token || '')) return;
  await api.storage.local.set({ token: j.token, port });
  await reconnect();
}

function tryPair(url) {
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/pair\?code=([a-f0-9]{32})$/.exec(url || '');
  if (!m || m[2] === lastPairCode) return;
  lastPairCode = m[2];
  redeem(Number(m[1]), m[2]).catch(() => { lastPairCode = ''; });
}

api.tabs.onUpdated.addListener((tabId, info, tab) => tryPair(info.url || (tab && tab.url)));

// Covers a pairing page that was opened before this extension was installed or had finished starting.
async function scanForPairingTab() {
  try {
    if ((await api.storage.local.get('token')).token) return;
    for (const t of await api.tabs.query({})) tryPair(t.url);
  } catch (e) {}
}

// ---- popup ----

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== api.runtime.id) return undefined;
  if (msg.type === 'bmcp-status') {
    api.storage.local.get(['port', 'name', 'token']).then((cfg) =>
      sendResponse({ status: linkState, relayId, port: cfg.port || DEFAULT_PORT, name: cfg.name || '', kind: detectKind(), paired: !!cfg.token })
    );
    return true;
  }
  if (msg.type === 'bmcp-reconnect') {
    reconnect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'bmcp-watched') {
    // From early.js (Firefox): keep the console hook only in tabs the agent works in.
    sendResponse({ watched: !!(sender.tab && netWatched(sender.tab.id)) });
    return undefined;
  }
  if (msg.type === 'bmcp-handoffs') {
    // For the popup: the open handoffs, with the tab title to recognise them.
    Promise.all([...handoffs.entries()].map(async ([tabId, h]) => {
      let title = '';
      try { title = (await api.tabs.get(tabId)).title || ''; } catch (e) {}
      return { tabId, message: h.message, title, since: h.start };
    })).then((list) => sendResponse({ handoffs: list }));
    return true;
  }
  if (msg.type === 'bmcp-handoff-done') {
    const decision = msg.decision === 'continue' ? 'continue' : 'cancel';
    if (sender.tab) {
      // From the card in the page: it must name the handoff that is open in that same tab.
      const h = handoffs.get(sender.tab.id);
      if (h && msg.id === h.hid) finishHandoff(sender.tab.id, decision, false, 'card');
    } else if (typeof msg.tabId === 'number' && handoffs.has(msg.tabId)) {
      // From the popup, an extension page.
      finishHandoff(msg.tabId, decision, false, 'popup');
    }
    sendResponse({ ok: true });
    return undefined;
  }
  return undefined;
});

// ---- lifecycle ----

function ensureAlarm() {
  try { api.alarms.create('bmcp-reconnect', { periodInMinutes: 0.5 }); } catch (e) {}
}
api.alarms.onAlarm.addListener((a) => { if (a.name === 'bmcp-reconnect') connect(); });
api.runtime.onInstalled.addListener(() => { ensureAlarm(); connect(); scanForPairingTab(); });
api.runtime.onStartup.addListener(() => { ensureAlarm(); connect(); });
ensureAlarm();
getAgentTabs(); // loads the agent's tabs early, so the network log knows which tabs to record
connect();
scanForPairingTab();
