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
  const s = await getAgentTabs();
  if (s.delete(id)) saveAgentTabs();
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
async function act(p, action) {
  const id = need(p);
  const before = await api.tabs.get(id);
  let done;
  try {
    const res = await run(id, bmcpAct, [Object.assign({}, p, { action })], { frameId: frameOfRef(p.ref) });
    done = unwrap(res[0]);
  } catch (e) {
    // A click that starts a navigation can tear the page down before the answer comes back.
    if (!/navigated|Frame with ID|frame was removed|message port closed|context invalidated/i.test(String(e.message))) throw e;
    done = action + ' sent (the page navigated)';
  }
  await sleep(350);
  const after = await waitForLoad(id, clamp(p.timeout_ms || 10000, 500, 60000), false);
  return { done, url: after.tab.url, title: after.tab.title, navigated: after.tab.url !== before.url };
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
