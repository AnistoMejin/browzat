'use strict';
// Storage and cookies (phase 3). Background handlers: cookies, storage, storage_state, container.
// The server half is server/tools/storage.js. Loaded after core.js in both builds; it uses api, IS_FIREFOX, handlers,
// need, clamp, sleep, run, unwrap, containerList, containerMap and getAgentTabs from there.
// No debugger is used: the cookies API and a function injected into the page do everything.
// Cookie and storage values are session secrets: nothing in this file logs, and no error text carries a value.

const STG_ACTIONS = ['list', 'get', 'set', 'delete', 'clear'];
const STG_NO_CONTAINERS = 'containers are not available in Chrome and Edge: an extension cannot create a separate cookie jar there. ' +
  'For an isolated session use Firefox (container with action create), or pair a second Chrome or Edge profile with browzat and name it with browser.';
// "<tabId>|<store>|<key>" -> the start of a value that storage_state restore sends in pieces.
const stgParts = new Map();

api.tabs.onRemoved.addListener((id) => {
  for (const k of [...stgParts.keys()]) if (k.startsWith(id + '|')) stgParts.delete(k);
});

// ---- which cookies belong to a tab ----

// Does the browser send this cookie to this host (whatever the path and the scheme)?
function stgHostMatch(c, host) {
  const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!d || !h) return false;
  return c.hostOnly ? h === d : h === d || h.endsWith('.' + d);
}

// Is this cookie unpartitioned, or in the partition of the tab's own site? The site of a partition key is a
// registrable domain, so "the tab's host is that domain or below it" needs no public suffix list.
function stgInPartition(c, tabHost) {
  const t = String(tabHost || '').toLowerCase();
  const under = (h) => !!h && !!t && (t === h || t.endsWith('.' + h));
  if (c.firstPartyDomain && !under(String(c.firstPartyDomain).toLowerCase())) return false;
  const top = c.partitionKey && c.partitionKey.topLevelSite;
  if (!top) return true;
  let h = '';
  try { h = new URL(top).hostname.toLowerCase(); } catch (e) {}
  return under(h);
}

function stgHost(d) {
  let s = String(d).trim().toLowerCase();
  if (s.includes('://')) { try { s = new URL(s).hostname; } catch (e) { s = ''; } }
  s = s.replace(/^\./, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s)) throw new Error('domain must be a host name like "example.com"');
  return s;
}

// The site a call works on: host is the domain argument or the tab's host; tabHost decides the partition.
function stgSite(tab, domain, what) {
  let u = null;
  try { u = new URL(tab.url || ''); } catch (e) {}
  const web = !!u && (u.protocol === 'http:' || u.protocol === 'https:');
  const site = { host: '', tabHost: web ? u.hostname.toLowerCase() : '', https: web && u.protocol === 'https:', origin: web ? u.origin : '' };
  if (domain != null && String(domain).trim() !== '') site.host = stgHost(domain);
  else if (web) site.host = site.tabHost;
  else throw new Error('this tab has no site (' + (tab.url || 'about:blank') + '); ' + what);
  return site;
}

// The cookie jar of the tab: { storeId, label }. Firefox: the default jar, a container or the private-window jar.
// Chrome and Edge: the store that lists the tab ("0" normal, "1" incognito).
async function stgJar(tab) {
  if (IS_FIREFOX) {
    const id = tab.cookieStoreId || 'firefox-default';
    if (id === 'firefox-default') return { storeId: id, label: '' };
    if (id === 'firefox-private') return { storeId: id, label: 'private window' };
    return { storeId: id, label: 'container ' + JSON.stringify((await containerMap()).get(id) || id) };
  }
  let storeId;
  try {
    const hit = (await api.cookies.getAllCookieStores()).find((s) => (s.tabIds || []).includes(tab.id));
    if (hit) storeId = hit.id;
  } catch (e) {}
  return { storeId, label: tab.incognito ? 'incognito window' : '' };
}

// Every cookie of site.host as seen in the tab, as the browser's own cookie objects, sorted by name.
async function stgCookies(site, jar) {
  const query = { partitionKey: {} }; // partitioned and unpartitioned together
  if (jar.storeId) query.storeId = jar.storeId;
  if (IS_FIREFOX) query.firstPartyDomain = null; // every first-party domain; also valid when isolation is off
  let all;
  try {
    all = await api.cookies.getAll(query);
  } catch (e) {
    delete query.partitionKey;
    try {
      all = await api.cookies.getAll(query);
    } catch (e2) {
      delete query.firstPartyDomain;
      all = await api.cookies.getAll(query);
    }
  }
  return all.filter((c) => stgHostMatch(c, site.host) && stgInPartition(c, site.tabHost))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : b.path.length - a.path.length || (a.domain < b.domain ? -1 : 1)));
}

// A browser cookie -> the cookie sent to the server module.
function stgWire(c) {
  const o = {
    name: c.name, value: c.value, domain: c.domain, hostOnly: !!c.hostOnly, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly,
    sameSite: { no_restriction: 'None', lax: 'Lax', strict: 'Strict' }[c.sameSite] || '',
    expires: c.session || c.expirationDate == null ? -1 : Math.round(c.expirationDate),
  };
  if (c.partitionKey && c.partitionKey.topLevelSite) o.partitionKey = c.partitionKey;
  if (c.firstPartyDomain) o.firstPartyDomain = c.firstPartyDomain;
  return o;
}

// Removes the cookies of the site that pick() accepts. Both browsers remove one cookie per call ("the first that
// matches URL and name"), so this runs in passes and counts what is really gone.
async function stgRemove(site, jar, pick) {
  let list = (await stgCookies(site, jar)).filter(pick);
  const before = list.length;
  for (let pass = 0; pass < 3 && list.length; pass++) {
    for (const c of list) {
      const d = { url: (c.secure ? 'https://' : 'http://') + String(c.domain).replace(/^\./, '') + (c.path || '/'), name: c.name };
      if (jar.storeId) d.storeId = jar.storeId;
      if (c.partitionKey && c.partitionKey.topLevelSite) d.partitionKey = c.partitionKey;
      if (IS_FIREFOX) d.firstPartyDomain = c.firstPartyDomain || '';
      try { await api.cookies.remove(d); } catch (e) {}
    }
    list = (await stgCookies(site, jar)).filter(pick);
  }
  return { removed: before - list.length, left: list.length };
}

// Firefox with first-party isolation wants a first-party domain for a new cookie: take it from a cookie the site
// already has, else guess the last two labels of the tab's host.
async function stgGuessFpd(site, jar) {
  const t = site.tabHost || site.host;
  let all = [];
  try { all = await api.cookies.getAll({ storeId: jar.storeId, firstPartyDomain: null }); } catch (e) {}
  const hit = all.find((c) => c.firstPartyDomain && (t === c.firstPartyDomain || t.endsWith('.' + c.firstPartyDomain)));
  if (hit) return hit.firstPartyDomain;
  const labels = t.split('.');
  return /^[\d.]+$/.test(t) || labels.length < 2 ? t : labels.slice(-2).join('.');
}

// Sets one cookie from the details object of cookies.set. Resolves to { ok, fpd }. The browser's own error message
// never leaves this function: Firefox quotes the whole cookie in it, value included.
async function stgPut(d, site, jar) {
  const attempt = async (x) => {
    try { return (await api.cookies.set(x)) ? '' : 'refused'; } catch (e) { return String((e && e.message) || e) || 'refused'; }
  };
  let err = await attempt(d);
  let fpd = '';
  if (err && IS_FIREFOX && d.firstPartyDomain == null && /first-party/i.test(err)) {
    fpd = await stgGuessFpd(site, jar);
    err = await attempt(Object.assign({}, d, { firstPartyDomain: fpd }));
  }
  return { ok: !err, fpd: err ? '' : fpd };
}

// Sets a cookie that comes from a state file (the Playwright shape). Resolves to true when the browser took it.
async function stgSetSaved(c, site, jar) {
  const host = String(c.domain).replace(/^\./, '');
  const path = typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/';
  const d = { url: (c.secure ? 'https://' : 'http://') + host + path, name: c.name, value: c.value, path, secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (String(c.domain).startsWith('.')) d.domain = host;
  const sameSite = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }[c.sameSite];
  if (sameSite) d.sameSite = sameSite;
  if (typeof c.expires === 'number' && c.expires >= 0) d.expirationDate = c.expires;
  if (jar.storeId) d.storeId = jar.storeId;
  if (typeof c.partitionKey === 'string' && c.partitionKey) {
    d.partitionKey = { topLevelSite: c.partitionKey };
    if (!IS_FIREFOX && typeof c._crHasCrossSiteAncestor === 'boolean') d.partitionKey.hasCrossSiteAncestor = c._crHasCrossSiteAncestor;
  }
  if (IS_FIREFOX && c.firstPartyDomain) d.firstPartyDomain = String(c.firstPartyDomain);
  if ((await stgPut(d, site, jar)).ok) return true;
  // Once more in a form that another browser, or an older one, accepts.
  const e = Object.assign({}, d);
  let changed = false;
  if (e.partitionKey && 'hasCrossSiteAncestor' in e.partitionKey) { e.partitionKey = { topLevelSite: c.partitionKey }; changed = true; }
  if (e.sameSite === 'no_restriction' && !e.secure) { delete e.sameSite; changed = true; }
  return changed ? (await stgPut(e, site, jar)).ok : false;
}

// ---- functions injected into the page (self-contained; they return { ok, value } or { ok: false, error }) ----

// localStorage and sessionStorage of the page. op: list, get, set, delete, clear (one store, o.kind), dump (both
// stores, for storage_state save) or load (both stores, for storage_state restore).
function bmcpStorage(o) {
  try {
    const names = { local: 'localStorage', session: 'sessionStorage' };
    const open = (kind) => {
      try {
        const s = kind === 'session' ? window.sessionStorage : window.localStorage;
        void s.length;
        return s;
      } catch (e) {
        throw new Error('this page has no ' + names[kind] + ' (' + ((e && e.name) || 'error') + '): its origin is opaque, or the browser blocks storage for this site');
      }
    };
    const all = (s) => {
      const out = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push([k, s.getItem(k) || '']); }
      return out;
    };
    const full = (e) => (e && e.name === 'QuotaExceededError') || /quota/i.test(String((e && e.name) || ''));
    const origin = location.origin;

    if (o.op === 'dump') return { ok: true, value: { origin, local: all(open('local')), session: all(open('session')) } };

    if (o.op === 'load') {
      const out = { origin, local: 0, session: 0, failed: [] };
      for (const kind of ['local', 'session']) {
        const items = o[kind] || [];
        const clear = !!(o.clear && o.clear[kind]);
        if (!items.length && !clear) continue;
        let s;
        try { s = open(kind); } catch (e) { out.failed.push({ store: names[kind], key: '', error: 'no ' + names[kind] + ' on this page' }); continue; }
        if (clear) s.clear();
        for (const [k, v] of items) {
          try { s.setItem(k, v); out[kind]++; } catch (e) { out.failed.push({ store: names[kind], key: String(k).slice(0, 120), error: full(e) ? 'QuotaExceededError' : String((e && e.name) || 'error') }); }
        }
      }
      return { ok: true, value: out };
    }

    const s = open(o.kind);
    const name = names[o.kind];
    if (o.op === 'list') {
      const find = String(o.find || '').toLowerCase();
      const items = all(s).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const hit = find ? items.filter((x) => x[0].toLowerCase().includes(find)) : items;
      let chars = 0;
      for (const [k, v] of items) chars += k.length + v.length;
      return { ok: true, value: { origin, name, count: items.length, matched: hit.length, chars, items: hit.slice(0, o.limit).map(([k, v]) => [k.slice(0, 120), v.slice(0, o.preview).replace(/\s+/g, ' '), v.length]) } };
    }
    const key = String(o.key);
    const old = s.getItem(key);
    if (o.op === 'get') return { ok: true, value: { origin, name, key, found: old !== null, len: old === null ? 0 : old.length, value: old === null ? '' : old.slice(0, o.max) } };
    if (o.op === 'set') {
      const v = String(o.value);
      try {
        s.setItem(key, v);
      } catch (e) {
        throw new Error('could not store ' + JSON.stringify(key.slice(0, 120)) + ': ' + (full(e) ? 'the storage of this site is full' : String((e && e.name) || 'error')));
      }
      return { ok: true, value: { origin, name, key, len: v.length, existed: old !== null } };
    }
    if (o.op === 'delete') { s.removeItem(key); return { ok: true, value: { origin, name, key, existed: old !== null } }; }
    if (o.op === 'clear') { const n = s.length; s.clear(); return { ok: true, value: { origin, name, removed: n } }; }
    return { ok: false, error: 'unknown storage action ' + o.op };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// The names of the origin's IndexedDB databases (nothing is opened or read), so that storage_state save can say that
// they are not part of the file. Any failure counts as "none".
async function bmcpStorageIdb() {
  try {
    if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') return { ok: true, value: [] };
    const list = await Promise.race([window.indexedDB.databases(), new Promise((r) => setTimeout(() => r([]), 1500))]);
    return { ok: true, value: Array.from(list || []).map((d) => String(d && d.name)).filter(Boolean).slice(0, 20) };
  } catch (e) {
    return { ok: true, value: [] };
  }
}

// ---- handlers ----

handlers.cookies = async (p) => {
  const id = need(p);
  const action = p.action || 'list';
  if (!STG_ACTIONS.includes(action)) throw new Error('action must be list, get, set, delete or clear');
  const named = p.name != null && String(p.name) !== '';
  if ((action === 'get' || action === 'set' || action === 'delete') && !named) throw new Error('name is required for ' + action);
  const tab = await api.tabs.get(id);
  const site = stgSite(tab, p.domain, 'cookies work on http and https pages, or pass domain');
  const jar = await stgJar(tab);
  const out = { host: site.host, jar: jar.label };

  if (action === 'set') {
    const name = String(p.name);
    if (p.value == null) throw new Error('value is required for set (an empty string is allowed)');
    const path = p.path == null || p.path === '' ? '/' : String(p.path);
    if (!path.startsWith('/')) throw new Error('path must start with /');
    const ss = p.same_site == null || p.same_site === '' ? '' : String(p.same_site).toLowerCase();
    if (ss && !['lax', 'strict', 'none'].includes(ss)) throw new Error('same_site must be lax, strict or none');
    const secure = !!p.secure;
    if (ss === 'none' && !secure) throw new Error('same_site none needs secure: true (browsers refuse the cookie otherwise)');
    const now = Date.now() / 1000;
    const exp = p.expires != null ? Number(p.expires) : p.max_age_s != null ? now + Number(p.max_age_s) : null;
    if (exp != null && !(exp > now)) throw new Error('expires is in the past; to remove a cookie use action delete');
    const wide = p.domain != null && String(p.domain).trim() !== ''; // a domain cookie; without domain it is host-only
    const d = { url: (secure || (!wide && site.https) ? 'https://' : 'http://') + site.host + path, name, value: String(p.value), path, secure, httpOnly: !!p.http_only };
    if (wide) d.domain = site.host;
    if (ss) d.sameSite = ss === 'none' ? 'no_restriction' : ss;
    if (exp != null) d.expirationDate = exp;
    if (jar.storeId) d.storeId = jar.storeId;
    const put = await stgPut(d, site, jar);
    const same = put.ok ? (await stgCookies(site, jar)).filter((c) => c.name === name && c.path === path) : [];
    const made = same.find((c) => !!c.hostOnly === !wide) || same[0];
    if (!made) throw new Error('the browser refused the cookie ' + JSON.stringify(name) + ' (check secure, same_site, the domain and the __Host- / __Secure- name rules)');
    out.cookie = stgWire(made);
    delete out.cookie.value;
    if (put.fpd) out.fpd = put.fpd;
    return out;
  }

  const pick = (c) => (!named || c.name === String(p.name)) && (p.path == null || p.path === '' || c.path === String(p.path));
  if (action === 'list' || action === 'get') {
    out.cookies = (await stgCookies(site, jar)).filter(pick).map(stgWire);
    return out;
  }
  // delete: the cookies with that name (and path); clear: every cookie of the host.
  return Object.assign(out, await stgRemove(site, jar, action === 'clear' ? () => true : pick));
};

handlers.storage = async (p) => {
  const id = need(p);
  const kind = p.kind == null || p.kind === '' ? 'local' : String(p.kind);
  if (kind !== 'local' && kind !== 'session') throw new Error('kind must be local or session');
  const action = p.action || 'list';
  if (!STG_ACTIONS.includes(action)) throw new Error('action must be list, get, set, delete or clear');
  if ((action === 'get' || action === 'set' || action === 'delete') && p.key == null) throw new Error('key is required for ' + action);
  if (action === 'set' && p.value == null) throw new Error('value is required for set (an empty string is allowed)');
  const o = {
    kind, op: action, key: p.key == null ? '' : String(p.key), value: p.value == null ? '' : String(p.value), find: p.find == null ? '' : String(p.find),
    limit: clamp(p.limit || 100, 1, 1000), preview: 100, max: clamp(p.max_chars || 20000, 200, 200000),
  };
  return unwrap((await run(id, bmcpStorage, [o], { frameId: 0 }))[0]);
};

// Internal steps of the storage_state tool: where (which site is the tab on), read (everything, for save),
// write (one batch of a restore).
handlers.storage_state = async (p) => {
  const id = need(p);
  const tab = await api.tabs.get(id);
  const site = stgSite(tab, null, 'storage_state works on http and https pages');
  const jar = await stgJar(tab);
  const base = { url: tab.url, origin: site.origin, host: site.host, jar: jar.label };
  if (p.op === 'where') return base;

  if (p.op === 'read') {
    let d;
    try {
      d = unwrap((await run(id, bmcpStorage, [{ op: 'dump' }], { frameId: 0 }))[0]);
    } catch (e) {
      throw new Error(String((e && e.message) || e) + '; nothing was saved');
    }
    let idb = [];
    try { idb = unwrap((await run(id, bmcpStorageIdb, [], { frameId: 0 }))[0]); } catch (e) {}
    return Object.assign(base, { origin: d.origin, cookies: (await stgCookies(site, jar)).map(stgWire), local: d.local, session: d.session, idb: Array.isArray(idb) ? idb : [] });
  }

  if (p.op === 'write') {
    if (p.origin !== site.origin) throw new Error('the tab moved to another site during the restore (now ' + site.origin + '); nothing more was written');
    const out = { removed: 0, cookies: 0, cookiesFailed: [], local: 0, session: 0, failed: [] };
    const clear = p.clear || {};
    if (p.first) for (const k of [...stgParts.keys()]) if (k.startsWith(id + '|')) stgParts.delete(k);
    if (clear.cookies) out.removed = (await stgRemove(site, jar, () => true)).removed;
    for (const c of p.cookies || []) {
      if (await stgSetSaved(c, site, jar)) out.cookies++;
      else out.cookiesFailed.push(String(c.name).slice(0, 80));
    }
    // Join the pieces of long values; a value goes to the page only when its last piece is here.
    const done = { local: [], session: [] };
    for (const u of p.items || []) {
      if (u.t !== 'local' && u.t !== 'session') continue;
      const pk = id + '|' + u.t + '|' + u.k;
      if (u.cont && !stgParts.has(pk)) throw new Error('the extension restarted during the restore; run storage_state restore again');
      const v = (u.cont ? stgParts.get(pk) : '') + u.v;
      if (u.more) stgParts.set(pk, v);
      else { stgParts.delete(pk); done[u.t].push([u.k, v]); }
    }
    if (clear.local || clear.session || done.local.length || done.session.length) {
      const r = unwrap((await run(id, bmcpStorage, [{ op: 'load', clear: { local: !!clear.local, session: !!clear.session }, local: done.local, session: done.session }], { frameId: 0 }))[0]);
      out.local = r.local;
      out.session = r.session;
      out.failed = r.failed;
    }
    return out;
  }
  throw new Error('unknown storage_state step ' + p.op);
};

// Firefox containers created on request: the isolated context of this project. Only containers that browzat created
// (remembered in storage.local, because they outlive a browser restart) can be removed.
handlers.container = async (p) => {
  if (!IS_FIREFOX || !api.contextualIdentities) throw new Error(STG_NO_CONTAINERS);
  const action = p.action;
  if (!['create', 'remove', 'list'].includes(action)) throw new Error('action must be create, remove or list');
  const list = await containerList();
  let own = [];
  try { own = (await api.storage.local.get('stgContainers')).stgContainers || []; } catch (e) {}
  own = own.filter((id) => list.some((c) => c.cookieStoreId === id)); // forget containers that are gone
  if (action === 'list') return { containers: list.map((c) => ({ name: c.name, own: own.includes(c.cookieStoreId) })) };

  const name = String(p.name == null ? '' : p.name).trim();
  if (!name) throw new Error('name is required');
  if (name.length > 40) throw new Error('name is too long (at most 40 characters)');
  const hit = list.find((c) => c.name.toLowerCase() === name.toLowerCase());

  if (action === 'create') {
    if (hit) return { name: hit.name, existed: true, own: own.includes(hit.cookieStoreId) };
    const c = await api.contextualIdentities.create({ name, color: 'orange', icon: 'fence' });
    await api.storage.local.set({ stgContainers: own.concat(c.cookieStoreId) });
    return { name: c.name, created: true };
  }

  if (!hit) throw new Error('no container named ' + JSON.stringify(name) + '; containers: ' + (list.map((c) => c.name).join(', ') || 'none'));
  if (!own.includes(hit.cookieStoreId)) throw new Error('container ' + JSON.stringify(hit.name) + ' was not created by you; browzat removes only containers it created');
  const inside = await api.tabs.query({ cookieStoreId: hit.cookieStoreId });
  const agent = await getAgentTabs();
  const theirs = inside.filter((t) => !agent.has(t.id));
  if (theirs.length) throw new Error('the user has ' + theirs.length + ' tab(s) of their own open in container ' + JSON.stringify(hit.name) + '; ask the user before removing it');
  // Removing a container deletes its cookies and site data but leaves its tabs open, so close them first.
  if (inside.length) {
    await api.tabs.remove(inside.map((t) => t.id));
    for (let i = 0; i < 20 && (await api.tabs.query({ cookieStoreId: hit.cookieStoreId })).length; i++) await sleep(100);
  }
  await api.contextualIdentities.remove(hit.cookieStoreId);
  await api.storage.local.set({ stgContainers: own.filter((id) => id !== hit.cookieStoreId) });
  return { name: hit.name, removed: true, closed: inside.length };
};
