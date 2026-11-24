'use strict';
// Storage and cookies (phase 3): cookies, localStorage and sessionStorage, storage_state, Firefox containers.
// Everything happens on host names made up for this run (bz<random>.localhost), so nothing of a real profile is read
// or cleared, and the finally block removes what the checks created.
const fs = require('fs');
const path = require('path');
const C = require('../../server/common');

module.exports = async (t) => {
  const rnd = Math.random().toString(36).slice(2, 8);
  const SECRET = 'bzsecret' + rnd + Date.now();
  const port = new URL(t.base).port;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

  t.route('/storage/', (req, res, url) => {
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    let html = page('Storage test', '<p>storage test page</p>');
    if (url.pathname === '/storage/login') {
      headers['set-cookie'] = [`bz_sid=${SECRET}; Path=/; HttpOnly; SameSite=Lax`, 'bz_theme=dark; Path=/; Max-Age=3600', 'bz_deep=1; Path=/storage/deep'];
      html = page('Storage login', '<p>cookies set</p>');
    } else if (url.pathname === '/storage/echo') {
      html = page('Storage echo', '<pre id="c">' + esc(req.headers.cookie || '(none)') + '</pre>');
    }
    res.writeHead(200, headers);
    res.end(html);
  });

  let host = 'bz' + rnd + '.localhost';
  let site = `http://${host}:${port}`;
  let other = `http://bzo${rnd}.localhost:${port}`;
  let tab = null;
  try { tab = await t.open(site + '/storage/page'); } catch (e) {}
  const own = !!tab && (await t.evaluate(tab, 'document.title')) === 'Storage test';
  if (!own) {
    if (tab) await t.close(tab);
    if (t.real) {
      t.check('SKIPPED: *.localhost does not load in this browser; the 127.0.0.1 cookies of a real profile are not touched', true);
      return;
    }
    host = '127.0.0.1';
    site = t.base;
    other = `http://localhost:${port}`;
    tab = await t.open(site + '/storage/page');
  }

  const where = `(${t.browser})`;
  const cookies = (args) => t.call('cookies', Object.assign({ tab }, args));
  const storage = (args) => t.call('storage', Object.assign({ tab }, args));
  const state = (args) => t.call('storage_state', Object.assign({ tab }, args));
  const go = (p) => t.call('navigate', { tab, url: site + p });
  const echo = () => t.poll(async () => { const v = await t.evaluate(tab, "document.getElementById('c').textContent"); return /^Error/.test(v) ? '' : v; }, 3000);
  const files = [];
  let otab = null;
  let cname = '';
  let r;

  try {
    // ---- cookies ----
    r = await cookies();
    t.check('a fresh site has no cookies', r.text === `no cookies for ${host} ${where}`, r.text);

    await go('/storage/login');
    r = await cookies();
    const h = reEsc(host);
    t.check('cookies list shows server-set cookies with their flags',
      r.text.startsWith(`3 cookie(s) for ${host} ${where}`) &&
      new RegExp(`^bz_sid=${SECRET}  domain=${h} path=/ httpOnly sameSite=Lax session$`, 'm').test(r.text) &&
      new RegExp(`^bz_theme=dark  domain=${h} path=/ (sameSite=\\w+ )?expires in (59|60) min$`, 'm').test(r.text) &&
      new RegExp(`^bz_deep=1  domain=${h} path=/storage/deep (sameSite=\\w+ )?session$`, 'm').test(r.text), r.text);
    const dc = await t.evaluate(tab, 'document.cookie');
    t.check('an HttpOnly cookie is hidden from the page but listed', dc.includes('bz_theme=dark') && !dc.includes('bz_sid'), dc);

    r = await cookies({ action: 'get', name: 'bz_sid' });
    t.check('cookies get returns one cookie in full', r.text.includes(`\nvalue: ${SECRET}\n`) && r.text.includes(`\ndomain: ${host} (host only)\n`) &&
      r.text.includes('\nflags: httpOnly, sameSite=Lax\n') && /\nexpires: session$/.test(r.text), r.text);
    r = await cookies({ action: 'get', name: 'bz_nope' });
    t.check('cookies get of an unknown name says so', !r.isError && r.text === `no cookie named "bz_nope" for ${host} ${where}`, r.text);

    r = await cookies({ action: 'set', name: 'bz_set', value: 'set-' + rnd });
    await go('/storage/echo');
    let sent = await echo();
    t.check('cookies set makes a cookie that the server receives', r.text.startsWith(`set cookie bz_set for ${host} ${where}: path /`) && !r.text.includes('set-' + rnd) &&
      sent.includes('bz_set=set-' + rnd) && sent.includes('bz_sid=' + SECRET), r.text + '\n' + sent);

    await cookies({ action: 'set', name: 'bz_h', value: 'h1', http_only: true, same_site: 'strict', max_age_s: 600 });
    r = await cookies({ action: 'get', name: 'bz_h' });
    const dc2 = await t.evaluate(tab, 'document.cookie');
    t.check('cookies set with http_only, same_site and max_age_s', r.text.includes('\nflags: httpOnly, sameSite=Strict\n') &&
      /\nexpires: \d{10} \(in (9|10) min\)$/.test(r.text) && !dc2.includes('bz_h='), r.text + '\n' + dc2);
    r = await cookies({ action: 'set', name: 'bz_bad', value: '1', same_site: 'none' });
    t.check('same_site none without secure is refused', r.isError && /same_site none needs secure/.test(r.text), r.text);

    if (own) {
      r = await cookies({ action: 'set', name: 'bz_wide', value: 'w1', domain: host });
      const wide = await cookies({ name: 'bz_wide' });
      t.check('cookies set with domain makes a domain cookie', r.text.startsWith(`set cookie bz_wide for .${host} ${where}`) &&
        wide.text.includes(`bz_wide=w1  domain=.${host} path=/`), r.text + '\n' + wide.text);
      const sub = await t.open(`http://sub.${host}:${port}/storage/page`);
      r = await t.call('cookies', { tab: sub });
      t.check('a subdomain tab sees the domain cookie and not the host-only ones', r.text.startsWith(`1 cookie(s) for sub.${host} ${where}`) &&
        r.text.includes('bz_wide=w1') && !r.text.includes('bz_theme') && !r.text.includes('bz_sid'), r.text);
      r = await t.call('cookies', { tab: sub, domain: host });
      t.check('domain names another host', r.text.includes(`cookie(s) for ${host} ${where}`) && r.text.includes('bz_theme=dark') && r.text.includes('bz_sid='), r.text);
      await t.close(sub);
    }

    r = await cookies({ path: '/storage/deep' });
    const byName = await cookies({ name: 'bz_theme' });
    t.check('cookies list filters by path and by name', r.text.startsWith('1 cookie(s) for ') && r.text.includes('bz_deep=1') &&
      byName.text.startsWith('1 cookie(s) for ') && byName.text.includes('bz_theme=dark'), r.text + '\n' + byName.text);

    r = await cookies({ action: 'delete', name: 'bz_set' });
    const afterDelete = await cookies();
    t.check('cookies delete removes one cookie by name', r.text === `deleted 1 cookie named "bz_set" for ${host} ${where}` &&
      !afterDelete.text.includes('bz_set=') && afterDelete.text.includes('bz_theme=dark'), r.text + '\n' + afterDelete.text);
    r = await cookies({ action: 'delete', name: 'bz_set' });
    t.check('cookies delete of an unknown name says so', !r.isError && r.text === `no cookie named "bz_set" for ${host} ${where}`, r.text);

    const blank = (/^tab: (\S+)/m.exec((await t.call('tabs', { action: 'new', browser: t.browser })).text) || [])[1];
    r = blank ? await t.call('cookies', { tab: blank }) : { text: 'no blank tab' };
    t.check('a blank tab asks for a domain', !!r.isError && r.text.includes('this tab has no site (about:blank)') && r.text.includes('pass domain'), r.text);
    if (blank) await t.close(blank);

    // ---- localStorage and sessionStorage ----
    await go('/storage/page');
    const val = JSON.stringify({ a: 1, token: SECRET });
    r = await storage({ action: 'set', key: 'bz_k', value: val });
    const got = await storage({ action: 'get', key: 'bz_k' });
    const inPage = await t.evaluate(tab, "localStorage.getItem('bz_k')");
    t.check('storage set and get (localStorage)', r.text === `set localStorage["bz_k"] of ${site} (${val.length} chars)` &&
      got.text === `localStorage["bz_k"] of ${site} (${val.length} chars)\n${val}` && inPage === val, [r.text, got.text, inPage].join('\n'));

    await t.evaluate(tab, "localStorage.setItem('bz_page', 'from-page'); return 1;");
    r = await storage();
    t.check('storage list shows keys, previews and sizes', r.text.startsWith(`2 item(s) in localStorage of ${site} (`) &&
      /^bz_page = from-page$/m.test(r.text) && /^bz_k = \{"a":1,"token":"bzsecret/m.test(r.text), r.text);
    r = await storage({ find: 'PAGE' });
    t.check('storage list with find', r.text.startsWith(`1 of 2 item(s) in localStorage of ${site}`) && r.text.includes('bz_page = from-page') && !r.text.includes('bz_k ='), r.text);

    await storage({ kind: 'session', action: 'set', key: 'bz_s', value: 'tab-only' });
    r = await storage({ kind: 'session' });
    const local = await storage();
    const sPage = await t.evaluate(tab, "sessionStorage.getItem('bz_s')");
    t.check('sessionStorage is separate from localStorage', r.text.startsWith(`1 item(s) in sessionStorage of ${site}`) && /^bz_s = tab-only$/m.test(r.text) &&
      !local.text.includes('bz_s') && sPage === 'tab-only', [r.text, local.text, sPage].join('\n'));

    r = await storage({ action: 'get', key: 'bz_nope' });
    t.check('storage get of an unknown key says so', !r.isError && r.text === `no item "bz_nope" in localStorage of ${site}`, r.text);
    await storage({ action: 'set', key: 'bz_long', value: 'x'.repeat(5000) });
    r = await storage({ action: 'get', key: 'bz_long', max_chars: 300 });
    t.check('storage get cuts a long value at max_chars', r.text.includes('… cut at 300 of 5000 characters') && r.text.length < 700, r.text.slice(0, 200));
    r = await storage({ action: 'delete', key: 'bz_long' });
    const gone = await t.evaluate(tab, "String(localStorage.getItem('bz_long'))");
    t.check('storage delete removes one key', r.text === `deleted localStorage["bz_long"] of ${site}` && gone === 'null', r.text + ' ' + gone);
    r = await storage({ kind: 'cookies' });
    t.check('an unknown kind is refused', r.isError && /kind must be local or session/.test(r.text), r.text);

    // ---- storage_state ----
    r = await state({ action: 'save' });
    const file = (/^saved: (.+\.json)$/m.exec(r.text) || [])[1] || '';
    if (file) files.push(file);
    t.check('storage_state save writes a file and returns no secret', !!file && fs.existsSync(file) &&
      path.resolve(path.dirname(file)) === path.resolve(C.OUTPUT_DIR) && !r.text.includes(SECRET) && r.text.includes(`\nsite: ${site} ${where}\n`) &&
      /^cookies: \d+, localStorage: 2 item\(s\), sessionStorage: 1 item\(s\)$/m.test(r.text) && /^warning: /m.test(r.text), r.text);
    if (!file) throw new Error('no state file; the remaining checks need it');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = j.cookies.length;
    const sid = j.cookies.find((c) => c.name === 'bz_sid') || {};
    const o = j.origins[0] || {};
    t.check('the state file holds the cookies and both storages',
      typeof (j.browzat || {}).warning === 'string' && sid.value === SECRET && sid.httpOnly === true && sid.sameSite === 'Lax' && sid.expires === -1 && sid.domain === host &&
      j.origins.length === 1 && o.origin === site && (o.localStorage || []).some((x) => x.name === 'bz_k' && x.value === val) &&
      (o.sessionStorage || []).some((x) => x.name === 'bz_s' && x.value === 'tab-only') &&
      (process.platform === 'win32' || (fs.statSync(file).mode & 0o077) === 0), 'cookies: ' + j.cookies.map((c) => c.name).join(', ') + '; origins: ' + j.origins.map((x) => x.origin).join(', '));

    otab = await t.open(other + '/storage/page');
    await t.call('cookies', { tab: otab, action: 'set', name: 'bz_other', value: 'o1' });
    r = await cookies({ action: 'clear' });
    const mine = await cookies();
    let theirs = await t.call('cookies', { tab: otab });
    t.check("cookies clear removes this site's cookies and no other site's", r.text.startsWith(`cleared ${n} cookie(s) for ${host} `) &&
      mine.text === `no cookies for ${host} ${where}` && theirs.text.includes('bz_other=o1'), [r.text, mine.text, theirs.text].join('\n'));
    r = await storage({ action: 'clear' });
    const r2 = await storage({ kind: 'session', action: 'clear' });
    const empty = await storage();
    t.check('storage clear empties one store', r.text === `cleared 2 item(s) from localStorage of ${site}` &&
      r2.text === `cleared 1 item(s) from sessionStorage of ${site}` && empty.text === `no items in localStorage of ${site}`, [r.text, r2.text, empty.text].join('\n'));

    r = await state({ action: 'restore', file });
    const sid2 = await cookies({ action: 'get', name: 'bz_sid' });
    const k2 = await t.evaluate(tab, "localStorage.getItem('bz_k')");
    const s2 = await t.evaluate(tab, "sessionStorage.getItem('bz_s')");
    t.check('storage_state restore brings cookies and storage back', r.text.startsWith(`restored ${site} ${where} from ${file}`) &&
      r.text.includes(`\ncookies: ${n} set (0 removed first), localStorage: 2 item(s), sessionStorage: 1 item(s)`) && r.text.includes('\nnote: reload the page') &&
      !r.text.includes(SECRET) && sid2.text.includes('value: ' + SECRET) && sid2.text.includes('flags: httpOnly, sameSite=Lax') && k2 === val && s2 === 'tab-only', [r.text, k2, s2].join('\n'));
    await go('/storage/echo');
    sent = await echo();
    t.check('the restored login reaches the server', sent.includes('bz_sid=' + SECRET), sent);

    await go('/storage/page');
    await cookies({ action: 'set', name: 'bz_extra', value: 'x1' });
    await storage({ action: 'set', key: 'bz_extra', value: 'x1' });
    r = await state({ action: 'restore', file });
    let cl = await cookies();
    let sl = await storage();
    t.check('storage_state restore replaces what was there', r.text.includes(`set (${n + 1} removed first)`) && !cl.text.includes('bz_extra') &&
      !sl.text.includes('bz_extra') && sl.text.includes('bz_k =') && cl.text.includes('bz_sid='), [r.text, cl.text, sl.text].join('\n'));
    await cookies({ action: 'set', name: 'bz_extra', value: 'x1' });
    await storage({ action: 'set', key: 'bz_extra', value: 'x1' });
    r = await state({ action: 'restore', file, merge: true });
    cl = await cookies();
    sl = await storage();
    t.check('storage_state restore with merge keeps what was there', /\(merged\)$/m.test(r.text) && cl.text.includes('bz_extra=x1') &&
      cl.text.includes('bz_sid=') && sl.text.includes('bz_extra = x1'), [r.text, cl.text, sl.text].join('\n'));

    r = await t.call('storage_state', { tab: otab, action: 'restore', file });
    theirs = await t.call('cookies', { tab: otab });
    t.check('a file with nothing for this site changes nothing', r.isError && r.text.includes('this file has nothing for ') && r.text.includes('Nothing was changed') &&
      !r.text.includes(SECRET) && theirs.text.includes('bz_other=o1'), r.text + '\n' + theirs.text);
    const bad = path.join(t.tmp, 'not-a-state.json');
    fs.writeFileSync(bad, JSON.stringify({ password: SECRET + '-in-file' }));
    r = await state({ action: 'restore', file: bad });
    t.check('a file that is not a storage state is refused without quoting it', r.isError && r.text.includes('not a storage state file') && !r.text.includes(SECRET), r.text);
    r = await state({ action: 'restore', file: file + '.missing' });
    t.check('a missing file gives a clear error', r.isError && r.text.includes('file not found'), r.text);

    const j2 = JSON.parse(JSON.stringify(j));
    j2.origins[0].localStorage.push({ name: 'bz_big', value: 'A' + 'b'.repeat(1200000) + 'Z' });
    const bigFile = path.join(t.tmp, 'big-state.json');
    fs.writeFileSync(bigFile, JSON.stringify(j2));
    r = await state({ action: 'restore', file: bigFile, merge: true });
    const bigInPage = await t.evaluate(tab, "const v = localStorage.getItem('bz_big'); return v ? v.length + ':' + v[0] + v[v.length - 1] : 'missing';");
    t.check('a value over 1 MB is restored whole', !r.isError && bigInPage === '1200002:AZ', r.text + '\n' + bigInPage);
    await storage({ action: 'delete', key: 'bz_big' });

    const named = path.join(C.OUTPUT_DIR, 'bz-e2e-' + rnd + '.json');
    files.push(named);
    r = await state({ action: 'save', file: 'bz-e2e-' + rnd });
    const r3 = await state({ action: 'save', file: '../bz-e2e-' + rnd });
    t.check('storage_state save with a file name; folders are refused', r.text.startsWith('saved: ' + named + '\n') && fs.existsSync(named) &&
      r3.isError && r3.text.includes('plain file name without folders'), r.text + '\n' + r3.text);

    let log = '';
    for (const f of [C.LOG_FILE, C.LOG_FILE + '.old']) { try { log += fs.readFileSync(f, 'utf8'); } catch (e) {} }
    t.check('secrets do not reach relay.log', !log.includes(SECRET), 'the marker of this run is in ' + C.LOG_FILE);

    // ---- containers ----
    const name = 'bz-e2e-' + rnd;
    if (t.chromium) {
      r = await t.call('container', { action: 'create', name, browser: t.browser });
      t.check('container says it is not available in Chrome and Edge', r.isError && r.text.includes('not available in Chrome and Edge'), r.text);
    } else {
      r = await t.call('container', { action: 'create', name, browser: t.browser });
      if (!r.isError) cname = name;
      t.check('container create makes a container', r.text.startsWith(`created container "${name}" in ${t.browser}.`), r.text);
      r = await t.call('container', { action: 'create', name, browser: t.browser });
      t.check('container create again says it exists', !r.isError && r.text.startsWith(`container "${name}" already exists in ${t.browser} (created by you)`), r.text);

      const ctab = await t.open(site + '/storage/page', { container: name });
      r = await t.call('cookies', { tab: ctab });
      await t.call('cookies', { tab: ctab, action: 'set', name: 'bz_c', value: 'c1' });
      const inC = await t.call('cookies', { tab: ctab });
      const inDefault = await cookies();
      const lsC = await t.call('storage', { tab: ctab });
      t.check('a container has its own cookie jar and storage', r.text === `no cookies for ${host} (${t.browser}, container "${name}")` && inC.text.includes('bz_c=c1') &&
        !inDefault.text.includes('bz_c=') && inDefault.text.includes('bz_sid=') && lsC.text === `no items in localStorage of ${site}`, [r.text, inC.text, inDefault.text, lsC.text].join('\n'));

      r = await t.call('container', { action: 'list', browser: t.browser });
      t.check('container list marks the one it created', r.text.includes(name + ' (created by you)'), r.text);
      const foreign = ((/: (.+)$/.exec(r.text) || [])[1] || '').split(', ').find((x) => x && !x.includes('(created by you)'));
      const none = await t.call('container', { action: 'remove', name: 'bz-none-' + rnd, browser: t.browser });
      const refused = foreign ? await t.call('container', { action: 'remove', name: foreign, browser: t.browser }) : null;
      t.check('container remove refuses unknown and foreign containers', none.isError && none.text.includes('no container named') &&
        (!refused || (refused.isError && refused.text.includes('was not created by you'))), none.text + '\n' + (refused ? refused.text : 'this profile has no other container'));

      r = await t.call('container', { action: 'remove', name, browser: t.browser });
      if (!r.isError) cname = '';
      const left = await t.call('container', { action: 'list', browser: t.browser });
      const tabs = await t.call('tabs', { action: 'list', browser: t.browser });
      t.check('container remove deletes the container and closes its tab', r.text.startsWith(`removed container "${name}" from ${t.browser} (closed 1 tab(s)`) &&
        !left.text.includes(name) && !tabs.text.includes(ctab + ' '), [r.text, left.text, tabs.text].join('\n'));
    }
  } finally {
    // Leave nothing behind: the cookies and storage of this run's hosts, the container, the state files.
    for (const x of [tab, otab]) {
      if (!x) continue;
      await t.call('cookies', { tab: x, action: 'clear' }).catch(() => {});
      await t.call('storage', { tab: x, action: 'clear' }).catch(() => {});
      await t.call('storage', { tab: x, kind: 'session', action: 'clear' }).catch(() => {});
    }
    if (cname) await t.call('container', { action: 'remove', name: cname, browser: t.browser }).catch(() => {});
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} }
  }
};
