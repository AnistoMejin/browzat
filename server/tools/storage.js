'use strict';
// Storage and cookies (phase 3): cookies, localStorage and sessionStorage, storage state files, Firefox containers.
// The extension half is extension/src/feat-storage.js.
// Cookie and storage values are session secrets. They leave this file only in the text result of the call that asked
// for them and in a state file under OUTPUT_DIR. Nothing here logs, and no error text carries a value.
const fs = require('fs');
const path = require('path');
const { TAB } = require('../tool-modules');

const ACTIONS = ['list', 'get', 'set', 'delete', 'clear'];
const LIST_CUT = 80; // characters of a cookie value that list shows
const PREVIEW = 100; // characters of a storage value that list shows (cut in the page)
const SET_MAX_BYTES = 700000; // one storage value in one call; the relay accepts 1 MB per call
const BATCH_BYTES = 600000; // one restore batch
const UNIT_MAX_BYTES = 900000; // a single cookie or item that is larger cannot be sent at all
const PIECE_CHARS = 100000; // longer values travel in pieces (at most 600000 bytes of JSON each)
const FILE_MAX_BYTES = 64 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
const ISOLATED_HINT = 'For an isolated session use Firefox (container with action create), or pair a second Chrome or Edge profile with browzat and name it with browser.';
const FILE_WARNING = 'this file holds the login of this site in plain text (session cookies and tokens). Anyone who can read it can use that session. Keep it private and delete it when you are done.';

const tools = [
  {
    name: 'cookies',
    description:
      "Read and change the cookies of a tab's site in the user's real browser profile: list (default), get, set, delete or clear. " +
      "It works on the cookies the browser sends to the tab's host, HttpOnly ones included, in the tab's own cookie jar (a Firefox container, a private window). " +
      'domain names another host instead, for example the login server of the site. list cuts long values; get returns one cookie in full. ' +
      'clear removes every cookie of that host and signs the user out of it there, so use it only when that is the goal. ' +
      'Cookie values are login secrets: do not repeat them in your answers unless the user asks.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        action: { type: 'string', enum: ACTIONS, description: 'Default list.' },
        name: { type: 'string', description: 'get, set, delete: the cookie name. list: only cookies with this name.' },
        value: { type: 'string', description: 'set: the cookie value.' },
        domain: { type: 'string', description: 'A host name such as "example.com". list, get, delete, clear: work on the cookies sent to this host instead of the tab\'s host. set: make a domain cookie that subdomains receive too; without it the cookie belongs to the tab\'s host only.' },
        path: { type: 'string', description: 'set: the cookie path, default "/". list, get, delete: only cookies with exactly this path.' },
        secure: { type: 'boolean', description: 'set: send the cookie only over HTTPS.' },
        http_only: { type: 'boolean', description: "set: hide the cookie from the page's JavaScript." },
        same_site: { type: 'string', enum: ['lax', 'strict', 'none'], description: 'set: the SameSite rule. none needs secure.' },
        expires: { type: 'number', description: 'set: when the cookie ends, as Unix time in seconds. Without expires and max_age_s it is a session cookie.' },
        max_age_s: { type: 'number', description: 'set: seconds from now until the cookie ends (instead of expires).' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'storage',
    description:
      'Read and change localStorage or sessionStorage of the page in a tab (its origin, top page only): list (default), get, set, delete or clear. ' +
      'kind is local (default) or session. list shows the keys with the start of each value; get returns one value, cut at max_chars. ' +
      'It also works on sites that refuse evaluate. Values often hold login tokens: do not repeat them in your answers unless the user asks.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        kind: { type: 'string', enum: ['local', 'session'], description: 'local = localStorage (default), session = sessionStorage of this tab.' },
        action: { type: 'string', enum: ACTIONS, description: 'Default list.' },
        key: { type: 'string', description: 'get, set, delete: the key of the item.' },
        value: { type: 'string', description: 'set: the value to store.' },
        find: { type: 'string', description: 'list: only keys containing this text.' },
        limit: { type: 'number', description: 'list: at most this many items. Default 100.' },
        max_chars: { type: 'number', description: 'get: cut the value after this many characters. Default 20000.' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'storage_state',
    description:
      "Save a site's login state to a file, or put it back. save writes the cookies of the tab's host and the localStorage and sessionStorage of its page " +
      'to a JSON file in the browzat output folder and returns the path, never the values. restore reads such a file (or a Playwright storage state file) ' +
      "and applies the part that belongs to the tab's site: it first removes that site's current cookies and storage, unless merge is true. " +
      'Reload the page afterwards. The file holds session secrets in plain text: tell the user where it is, and delete it when it is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        action: { type: 'string', enum: ['save', 'restore'] },
        file: { type: 'string', description: 'restore: the path that save returned, or a file name inside the output folder. save: optional file name without folders, inside the output folder; default storage-state-<host>-<time>.json.' },
        merge: { type: 'boolean', description: "restore: keep the site's current cookies and storage and only add or overwrite what the file has. Default false: the site's state is replaced." },
      },
      required: ['tab', 'action'],
    },
  },
  {
    name: 'container',
    description:
      'Firefox only: make a container, a separate cookie jar and storage for the tabs opened in it (an isolated context, for a second account or a clean logged-out session). ' +
      'create makes one, or tells you it already exists; then open tabs in it with tabs (action new, container: the name). ' +
      'remove deletes a container you created, with its cookies and storage, and closes your tabs in it. list shows all containers and marks yours. ' +
      'Chrome and Edge have nothing like it: there a second browser profile paired with browzat is the separate session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'remove', 'list'] },
        name: { type: 'string', description: 'create, remove: the name of the container.' },
        browser: { type: 'string', description: 'Which Firefox, when several are connected. Default firefox.' },
      },
      required: ['action'],
    },
  },
];

// ---- small helpers ----

const q = (s) => JSON.stringify(String(s));
const few = (list, n) => list.slice(0, n).join(', ') + (list.length > n ? ', …' : '');
const where = (browser, jar) => `(${browser}${jar ? ', ' + jar : ''})`;
const given = (v) => v != null && String(v).trim() !== '';

function fmtIn(sec) {
  if (sec < 90) return Math.max(0, Math.round(sec)) + ' s';
  if (sec < 5400) return Math.round(sec / 60) + ' min';
  if (sec < 172800) return Math.round(sec / 3600) + ' h';
  return Math.round(sec / 86400) + ' d';
}
const life = (c, now) => (c.expires < 0 ? 'session' : 'expires in ' + fmtIn(c.expires - now));
const flags = (c) => [c.secure ? 'secure' : '', c.httpOnly ? 'httpOnly' : '', c.sameSite ? 'sameSite=' + c.sameSite : ''].filter(Boolean);
const partition = (c) => (c.partitionKey && c.partitionKey.topLevelSite) || '';

// ---- result texts (pure, so that test/check.js can prove that no value gets into them) ----

const fmt = {
  cookieList(a, r, browser) {
    const w = where(browser, r.jar);
    if (!r.cookies.length) {
      if (given(a.name)) return `no cookie named ${q(a.name)} for ${r.host} ${w}`;
      if (given(a.path)) return `no cookies with path ${q(a.path)} for ${r.host} ${w}`;
      return `no cookies for ${r.host} ${w}`;
    }
    const now = Date.now() / 1000;
    let cut = false;
    const lines = r.cookies.map((c) => {
      let v = c.value;
      if (v.length > LIST_CUT) { v = v.slice(0, LIST_CUT) + `…(${c.value.length} chars)`; cut = true; }
      const p = partition(c);
      return `${c.name}=${v}  domain=${c.domain} path=${c.path}` + flags(c).map((f) => ' ' + f).join('') + (p ? ' partitioned=' + p : '') + ' ' + life(c, now);
    });
    return `${r.cookies.length} cookie(s) for ${r.host} ${w}\n${lines.join('\n')}` +
      (cut ? '\nnote: long values are cut; cookies with action get and the name returns one in full' : '');
  },
  cookieGet(a, r, browser) {
    const w = where(browser, r.jar);
    if (!r.cookies.length) return `no cookie named ${q(a.name)} for ${r.host} ${w}`;
    const now = Date.now() / 1000;
    return r.cookies.map((c) => {
      const p = partition(c);
      return `${c.name}  for ${r.host} ${w}\nvalue: ${c.value}\ndomain: ${c.domain}${c.hostOnly ? ' (host only)' : ''}\npath: ${c.path}\nflags: ${flags(c).join(', ') || 'none'}` +
        (p ? '\npartitioned: ' + p : '') + `\nexpires: ${c.expires < 0 ? 'session' : `${c.expires} (in ${fmtIn(c.expires - now)})`}`;
    }).join('\n\n');
  },
  cookieSet(r, browser) {
    const c = r.cookie;
    return `set cookie ${c.name} for ${c.hostOnly ? r.host : c.domain} ${where(browser, r.jar)}: ` +
      ['path ' + c.path].concat(flags(c), [life(c, Date.now() / 1000)]).join(', ') +
      (r.fpd ? `\nnote: first-party isolation is on in this Firefox; the cookie was stored under the first-party domain ${q(r.fpd)}` : '');
  },
  cookieDelete(a, r, browser) {
    const w = where(browser, r.jar);
    if (!r.removed && !r.left) return `no cookie named ${q(a.name)} for ${r.host} ${w}`;
    return `deleted ${r.removed} cookie${r.removed === 1 ? '' : 's'} named ${q(a.name)} for ${r.host} ${w}` + (r.left ? `; ${r.left} could not be removed` : '');
  },
  cookieClear(r, browser) {
    const w = where(browser, r.jar);
    if (!r.removed && !r.left) return `no cookies for ${r.host} ${w}`;
    return `cleared ${r.removed} cookie(s) for ${r.host} ${w}. This host has lost its login in this browser profile.` + (r.left ? ` ${r.left} could not be removed.` : '');
  },
  storage(a, action, r) {
    const of = `${r.name} of ${r.origin}`;
    const item = `${r.name}[${q(r.key)}] of ${r.origin}`;
    if (action === 'list') {
      if (!r.count) return `no items in ${of}`;
      if (!r.matched) return `no key contains ${q(a.find)} in ${of} (${r.count} item(s))`;
      const head = (r.items.length < r.count ? `${r.items.length} of ${r.count}` : String(r.count)) + ` item(s) in ${of} (${r.chars} chars)`;
      return head + '\n' + r.items.map(([k, pv, len]) => `${k} = ${pv}` + (len > PREVIEW ? `…  (${len} chars)` : '')).join('\n');
    }
    if (action === 'get') {
      if (!r.found) return `no item ${q(r.key)} in ${of}`;
      return `${item} (${r.len} chars)\n${r.value}` + (r.len > r.value.length ? `\n… cut at ${r.value.length} of ${r.len} characters (raise max_chars)` : '');
    }
    if (action === 'set') return `set ${item} (${r.len} chars)` + (r.existed ? ', replacing the old value' : '');
    if (action === 'delete') return r.existed ? `deleted ${item}` : `no item ${q(r.key)} in ${of}`;
    return r.removed ? `cleared ${r.removed} item(s) from ${of}` : `no items in ${of}`;
  },
  save(file, r, browser) {
    const lines = [
      `saved: ${file}`,
      `site: ${r.origin} ${where(browser, r.jar)}`,
      `cookies: ${r.cookies.length}, localStorage: ${r.local.length} item(s), sessionStorage: ${r.session.length} item(s)`,
      'warning: ' + FILE_WARNING,
    ];
    if (r.idb && r.idb.length) lines.push(`note: this origin also keeps data in IndexedDB (${few(r.idb, 5)}), which is not saved; a login kept there will not come back with restore`);
    return lines.join('\n');
  },
  // x: { file, origin, jar, merge, entry, pick, total, tooLarge }
  restore(x, browser) {
    const store = (label, list, n) => `${label}: ${list ? n + ' item(s)' : 'not in the file'}`;
    const lines = [
      `restored ${x.origin} ${where(browser, x.jar)} from ${x.file}${x.merge ? ' (merged)' : ''}`,
      `cookies: ${x.total.cookies} set${x.merge ? '' : ` (${x.total.removed} removed first)`}, ` +
        `${store('localStorage', x.entry.local, x.total.local)}, ${store('sessionStorage', x.entry.session, x.total.session)}`,
    ];
    if (x.pick.skippedCookies || x.pick.skippedOrigins.length) {
      lines.push(`skipped: ${x.pick.skippedCookies} cookie(s) and ${x.pick.skippedOrigins.length} origin(s) of other sites in the file` +
        (x.pick.skippedOrigins.length ? ` (${few(x.pick.skippedOrigins, 5)})` : '') + '; open a tab on such a site and restore there');
    }
    if (x.pick.expired) lines.push(`skipped: ${x.pick.expired} expired cookie(s)`);
    if (x.total.cookiesFailed.length) lines.push(`could not set ${x.total.cookiesFailed.length} cookie(s): ${few(x.total.cookiesFailed, 10)} (the browser refused them)`);
    if (x.total.failed.length) lines.push(`could not store ${x.total.failed.length} item(s): ` + few(x.total.failed.map((f) => `${f.store}[${q(f.key)}] (${f.error})`), 10));
    if (x.tooLarge.length) {
      const label = (u) => (u.c ? 'cookie ' + q(u.c.name) : `${u.t === 'session' ? 'sessionStorage' : 'localStorage'}[${q(String(u.k).slice(0, 80))}]`);
      lines.push(`skipped: ${x.tooLarge.length} item(s) too large to send: ${few(x.tooLarge.map(label), 10)}`);
    }
    lines.push('note: reload the page (navigate with action reload) so the site reads the restored state');
    return lines.join('\n');
  },
  nothing(pick, state, origin) {
    const origins = state.origins.map((o) => o.origin);
    return `this file has nothing for ${origin}: it holds ${pick.otherHosts.length ? 'cookies for ' + few(pick.otherHosts, 5) : 'no cookies'} and ` +
      `${origins.length ? 'storage of ' + few(origins, 5) : 'no storage'}. Nothing was changed.`;
  },
};

// ---- state files ----

// The file name for save. name: what the agent gave (may be empty); host and now make the default name.
function saveName(name, host, now, dir) {
  if (name == null || name === '') return `storage-state-${String(host).toLowerCase().replace(/[^a-z0-9.-]/g, '_')}-${now}.json`;
  const n = String(name).trim();
  if (!FILE_NAME.test(n)) throw new Error(`file must be a plain file name without folders, like "github-login"; it is saved in ${dir || 'the output folder'}`);
  return /\.json$/i.test(n) ? n : n + '.json';
}

// Where restore reads from: an absolute path, or a file name inside the output folder.
function findFile(f, dir) {
  if (path.isAbsolute(f)) return f;
  if (!FILE_NAME.test(f)) throw new Error(`file not found: ${f} (give the path that storage_state save returned, or a file name inside ${dir})`);
  const p = path.join(dir, f);
  return /\.json$/i.test(f) || fs.existsSync(p) ? p : p + '.json';
}

function stamp(now) {
  const zone = process.env.BROWSER_MCP_TZ || 'Asia/Kolkata';
  try {
    return new Date(now).toLocaleString('en-GB', { timeZone: zone, hour12: false }) + ' ' + (process.env.BROWSER_MCP_TZ ? zone : 'IST');
  } catch (e) {
    return new Date(now).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
  }
}

// A cookie as the extension reports it -> a cookie in the file (the shape of a Playwright storage state).
function toFileCookie(c) {
  const o = { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: !!c.httpOnly, secure: !!c.secure };
  if (c.sameSite) o.sameSite = c.sameSite;
  if (c.partitionKey && c.partitionKey.topLevelSite) {
    o.partitionKey = c.partitionKey.topLevelSite;
    if (typeof c.partitionKey.hasCrossSiteAncestor === 'boolean') o._crHasCrossSiteAncestor = c.partitionKey.hasCrossSiteAncestor;
  }
  if (c.firstPartyDomain) o.firstPartyDomain = c.firstPartyDomain;
  return o;
}

function buildState(r, browser, now) {
  const pairs = (list) => list.map(([name, value]) => ({ name, value }));
  return {
    browzat: {
      warning: `SECRET: this file holds the login of ${r.origin} in plain text (session cookies and tokens). Anyone who can read it can use that session. Do not share it or commit it; delete it when you are done.`,
      version: 1,
      saved: stamp(now),
      savedAt: now,
      browser,
      url: r.url,
      origin: r.origin,
      jar: r.jar || 'default',
    },
    cookies: r.cookies.map(toFileCookie),
    origins: [{ origin: r.origin, localStorage: pairs(r.local), sessionStorage: pairs(r.session) }],
  };
}

// Reads the text of a state file. Throws 'not a storage state file' and never quotes the text.
// Returns { cookies: [file cookie], origins: [{ origin, local: [[k, v]] | null, session: [[k, v]] | null }] }.
function parseState(text) {
  const bad = () => new Error('not a storage state file');
  let j;
  try { j = JSON.parse(text); } catch (e) { throw bad(); }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.cookies) || !Array.isArray(j.origins)) throw bad();
  const str = (x) => typeof x === 'string';
  const items = (list) => (Array.isArray(list) ? list.filter((x) => x && str(x.name) && str(x.value)).map((x) => [x.name, x.value]) : null);
  return {
    cookies: j.cookies.filter((c) => c && str(c.name) && str(c.value) && str(c.domain) && c.domain.replace(/^\./, '') !== ''),
    origins: j.origins.filter((o) => o && str(o.origin)).map((o) => ({ origin: o.origin, local: items(o.localStorage), session: items(o.sessionStorage) })),
  };
}

// The same rule as stgHostMatch in the extension, for a cookie in the file: a leading dot means a domain cookie.
function hostMatches(domain, host) {
  const d = String(domain).replace(/^\./, '').toLowerCase();
  const h = String(host).toLowerCase();
  return String(domain).startsWith('.') ? h === d || h.endsWith('.' + d) : h === d;
}

// Is the site named by this URL (a partition key) the site of the host: the same host or a parent domain of it.
function siteOf(url, host) {
  let s = '';
  try { s = new URL(url).hostname.toLowerCase(); } catch (e) {}
  const h = String(host).toLowerCase();
  return !!s && (h === s || h.endsWith('.' + s));
}

// What a state holds for the tab's site. now is in seconds.
function selectForSite(state, host, origin, now) {
  const out = { cookies: [], entry: null, skippedCookies: 0, expired: 0, skippedOrigins: [], otherHosts: [] };
  for (const c of state.cookies) {
    const mine = hostMatches(c.domain, host) && (!c.partitionKey || siteOf(String(c.partitionKey), host)) &&
      (!c.firstPartyDomain || siteOf('http://' + c.firstPartyDomain, host));
    if (!mine) {
      out.skippedCookies++;
      const d = c.domain.replace(/^\./, '');
      if (!out.otherHosts.includes(d)) out.otherHosts.push(d);
    } else if (typeof c.expires === 'number' && c.expires >= 0 && c.expires <= now) {
      out.expired++;
    } else {
      out.cookies.push(c);
    }
  }
  for (const o of state.origins) {
    if (!out.entry && o.origin === origin && (o.local || o.session)) out.entry = o;
    else if (!out.skippedOrigins.includes(o.origin)) out.skippedOrigins.push(o.origin);
  }
  return out;
}

// Packs units ({ c: cookie } or { t: 'local' | 'session', k, v }) into batches of at most maxBytes of JSON.
// A value longer than piece characters is cut: every piece but the last has more: true, every piece but the first has
// cont: true. Returns { batches: [{ cookies, items }], tooLarge: [unit] }.
function packBatches(units, maxBytes, piece) {
  maxBytes = maxBytes || BATCH_BYTES;
  piece = piece || PIECE_CHARS;
  const out = { batches: [], tooLarge: [] };
  let cur = { cookies: [], items: [] };
  let size = 0;
  const add = (u) => {
    const n = Buffer.byteLength(JSON.stringify(u));
    if (n > UNIT_MAX_BYTES) return false;
    if (size && size + n > maxBytes) { out.batches.push(cur); cur = { cookies: [], items: [] }; size = 0; }
    if (u.c) cur.cookies.push(u.c); else cur.items.push(u);
    size += n;
    return true;
  };
  for (const u of units) {
    if (u.c || u.v.length <= piece) {
      if (!add(u)) out.tooLarge.push(u);
      continue;
    }
    // A key so long that one piece of the value would not fit next to it.
    if (Buffer.byteLength(JSON.stringify(u.k)) > UNIT_MAX_BYTES - 6 * piece - 100) { out.tooLarge.push(u); continue; }
    for (let i = 0; i < u.v.length; i += piece) {
      const p = { t: u.t, k: u.k, v: u.v.slice(i, i + piece) };
      if (i > 0) p.cont = true;
      if (i + piece < u.v.length) p.more = true;
      add(p);
    }
  }
  if (size || !out.batches.length) out.batches.push(cur);
  return out;
}

// ---- the tools ----

async function cookies(a, h) {
  const action = a.action || 'list';
  if (!ACTIONS.includes(action)) throw new Error('action must be list, get, set, delete or clear');
  if ((action === 'get' || action === 'set' || action === 'delete') && !given(a.name)) throw new Error('name is required for ' + action);
  if (action === 'set') {
    if (a.value == null) throw new Error('value is required for set (an empty string is allowed)');
    if (Buffer.byteLength(String(a.name) + String(a.value)) > 4096) throw new Error("a cookie's name and value together may be at most 4096 bytes");
  }
  const { browser, result: r } = await h.send('cookies', Object.assign({}, a, { action }));
  if (action === 'list') return fmt.cookieList(a, r, browser);
  if (action === 'get') return fmt.cookieGet(a, r, browser);
  if (action === 'set') return fmt.cookieSet(r, browser);
  if (action === 'delete') return fmt.cookieDelete(a, r, browser);
  return fmt.cookieClear(r, browser);
}

async function storage(a, h) {
  const kind = given(a.kind) ? String(a.kind) : 'local';
  if (kind !== 'local' && kind !== 'session') throw new Error('kind must be local or session');
  const action = a.action || 'list';
  if (!ACTIONS.includes(action)) throw new Error('action must be list, get, set, delete or clear');
  if ((action === 'get' || action === 'set' || action === 'delete') && a.key == null) throw new Error('key is required for ' + action);
  const args = { tab: a.tab, kind, action, find: a.find, limit: a.limit, max_chars: a.max_chars };
  if (a.key != null) args.key = String(a.key);
  if (action === 'set') {
    if (a.value == null) throw new Error('value is required for set (an empty string is allowed)');
    args.value = typeof a.value === 'string' ? a.value : typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
    const n = Buffer.byteLength(JSON.stringify(args.value));
    if (n > SET_MAX_BYTES) {
      throw new Error(`value is too long for one call (${n} bytes; the limit is ${SET_MAX_BYTES}). Put it in a storage state file and use storage_state restore, which sends long values in pieces.`);
    }
  }
  const { result: r } = await h.send('storage', args);
  return fmt.storage(a, action, r);
}

async function saveState(a, h) {
  const dir = h.C.OUTPUT_DIR;
  const fixed = given(a.file) ? saveName(String(a.file), '', 0, dir) : ''; // refuse a bad name before anything is read
  const { browser, result: r } = await h.send('storage_state', { tab: a.tab, op: 'read' }, { waitMs: 60000 });
  const now = Date.now();
  const file = path.join(dir, fixed || saveName('', r.host, now, dir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildState(r, browser, now), null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) {} // the mode option only applies to a new file
  return fmt.save(file, r, browser);
}

async function restoreState(a, h) {
  if (!given(a.file)) throw new Error('file is required: the path that storage_state save returned');
  const file = findFile(String(a.file).trim(), h.C.OUTPUT_DIR);
  let st = null;
  try { st = fs.statSync(file); } catch (e) {}
  if (!st || !st.isFile()) throw new Error('file not found: ' + file);
  if (st.size > FILE_MAX_BYTES) throw new Error(`file is too large (${Math.round(st.size / 1048576)} MB; the limit is 64 MB): ${file}`);
  let state;
  try {
    state = parseState(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`not a storage state file: ${file} (expected JSON with a "cookies" list and an "origins" list)`);
  }

  const { browser, result: w } = await h.send('storage_state', { tab: a.tab, op: 'where' });
  const pick = selectForSite(state, w.host, w.origin, Date.now() / 1000);
  if (!pick.cookies.length && !pick.entry) throw new Error(fmt.nothing(pick, state, w.origin));

  const entry = pick.entry || { local: null, session: null };
  const units = pick.cookies.map((c) => ({ c }));
  for (const [k, v] of entry.local || []) units.push({ t: 'local', k, v });
  for (const [k, v] of entry.session || []) units.push({ t: 'session', k, v });
  const { batches, tooLarge } = packBatches(units);
  const merge = !!a.merge;
  const total = { removed: 0, cookies: 0, cookiesFailed: [], local: 0, session: 0, failed: [] };
  for (let i = 0; i < batches.length; i++) {
    const args = { tab: a.tab, op: 'write', origin: w.origin, cookies: batches[i].cookies, items: batches[i].items };
    if (i === 0) {
      args.first = true;
      args.clear = merge ? {} : { cookies: true, local: !!entry.local, session: !!entry.session };
    }
    let r;
    try {
      r = (await h.send('storage_state', args, { waitMs: 60000 })).result;
    } catch (e) {
      if (i === 0) throw e;
      throw new Error(`restore stopped after batch ${i} of ${batches.length}: ${e.message}. The site now has part of the saved state; run the restore again.`);
    }
    total.removed += r.removed || 0;
    total.cookies += r.cookies || 0;
    total.local += r.local || 0;
    total.session += r.session || 0;
    total.cookiesFailed.push(...(r.cookiesFailed || []));
    total.failed.push(...(r.failed || []));
  }
  return fmt.restore({ file, origin: w.origin, jar: w.jar, merge, entry, pick, total, tooLarge }, browser);
}

async function container(a, h) {
  const action = a.action;
  if (!['create', 'remove', 'list'].includes(action)) throw new Error('action must be create, remove or list');
  if (!given(a.browser)) {
    // Say at once that containers are a Firefox feature when only other browsers are connected. With no browser at
    // all the relay's own wait and message are better (extensions reconnect within seconds).
    const st = await h.relayCall('status', {}, 10000);
    if (st.browsers.length && !st.browsers.some((b) => b.kind === 'firefox')) throw new Error('containers exist only in Firefox, and no Firefox is connected. ' + ISOLATED_HINT);
  }
  const { browser, result: r } = await h.send('container', { browser: given(a.browser) ? a.browser : 'firefox', action, name: a.name }, { tab: false });
  if (action === 'list') {
    return r.containers.length ? `containers in ${browser}: ` + r.containers.map((c) => c.name + (c.own ? ' (created by you)' : '')).join(', ') : `no containers are defined in ${browser}`;
  }
  const n = q(r.name);
  if (action === 'remove') return `removed container ${n} from ${browser} (closed ${r.closed} tab(s); its cookies and storage are deleted)`;
  if (r.created) return `created container ${n} in ${browser}. Open a tab in it with tabs: action new, container ${n}. Remove it with container: action remove when you are done.`;
  if (r.own) return `container ${n} already exists in ${browser} (created by you); open a tab in it with tabs: action new, container ${n}`;
  return `container ${n} already exists in ${browser}. It is the user's own container and holds their logins; open a tab in it with tabs: action new, container ${n}, or create one with another name for a clean session`;
}

async function run(name, a, h) {
  a = a || {};
  if (name === 'cookies') return h.text(await cookies(a, h));
  if (name === 'storage') return h.text(await storage(a, h));
  if (name === 'container') return h.text(await container(a, h));
  if (name === 'storage_state') {
    if (a.action === 'save') return h.text(await saveState(a, h));
    if (a.action === 'restore') return h.text(await restoreState(a, h));
    throw new Error('action must be save or restore');
  }
  throw new Error('unknown tool ' + name);
}

module.exports = {
  tools,
  run,
  // For test/check.js only.
  _test: { fmt, saveName, findFile, parseState, hostMatches, selectForSite, packBatches, toFileCookie, buildState },
};
