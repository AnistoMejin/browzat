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

async function waitForLoad(tabId, timeoutMs, expectLoad) {
  const start = Date.now();
  let sawLoading = false;
  for (;;) {
    const tab = await api.tabs.get(tabId);
    if (tab.status === 'loading') sawLoading = true;
    else if (sawLoading || !expectLoad || Date.now() - start > 1000) return { tab, timedOut: false };
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
  const after = await waitForLoad(id, clamp(p.timeout_ms || 10000, 500, 60000), false);
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

async function downscale(dataUrl, maxW) {
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    if (bmp.width <= maxW) return { dataUrl, width: bmp.width, height: bmp.height };
    const h = Math.round((bmp.height * maxW) / bmp.width);
    const canvas = new OffscreenCanvas(maxW, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, maxW, h);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return { dataUrl: await toDataUrl(out), width: maxW, height: h };
  } catch (e) {
    return { dataUrl };
  }
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
  s.timer = setTimeout(() => cdpDetach(tabId), CDP_IDLE_MS);
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
  api.debugger.onDetach.addListener((src) => {
    const s = cdpTabs.get(src.tabId);
    if (s) { clearTimeout(s.timer); cdpTabs.delete(src.tabId); }
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

// ---- tools ----

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
      try {
        t = await api.tabs.create(create);
      } catch (e) {
        if (create.cookieStoreId) throw e;
        const w = await api.windows.create({ url, focused: !!p.active });
        t = w.tabs[0];
      }
      agent.add(t.id);
      await saveAgentTabs();
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
      return brief(r.tab, agent, { timedOut: r.timedOut, reopened }, cmap);
    }
    if (action === 'close') {
      const id = need(p);
      if (!agent.has(id) && !p.force) throw new Error('this tab was not opened by you; close it only if the user asks (force: true)');
      await api.tabs.remove(id);
      return { closed: id };
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
    let dataUrl;
    let raised = false;
    if (api.tabs.captureTab) {
      dataUrl = await api.tabs.captureTab(id, { format: 'jpeg', quality: 70 });
    } else {
      // Chromium can only capture the visible tab of a window: show it, capture, then put the user's tab back.
      const t = await api.tabs.get(id);
      const prev = (await api.tabs.query({ active: true, windowId: t.windowId }))[0];
      const shot = { format: 'jpeg', quality: 70 };
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
    }
    return Object.assign(await downscale(dataUrl, clamp(p.max_width || 1280, 320, 2560)), { raised });
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
      try {
        const intercepted = cdpEvent(id, 'Input.dragIntercepted', 2000);
        intercepted.then((d) => { drag = d; });
        await cdpMouse(id, 'move', a.x, a.y);
        await cdpMouse(id, 'down', a.x, a.y);
        const steps = 6;
        for (let i = 1; i <= steps && !drag; i++) {
          await cdpMouse(id, 'move', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
          await sleep(30);
        }
        // A fresh or busy browser can report the drag start late: give it up to a second.
        if (!drag) await Promise.race([intercepted, sleep(1000)]);
        if (drag && drag.data) {
          // An HTML5 drag started: the browser handed it to us; replay it over the target and drop it there.
          await cdp(id, 'Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data: drag.data });
          await cdp(id, 'Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data: drag.data });
          await cdp(id, 'Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data: drag.data });
          dropped = true;
        } else {
          await cdpMouse(id, 'move', b.x, b.y);
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
connect();
scanForPairingTab();
