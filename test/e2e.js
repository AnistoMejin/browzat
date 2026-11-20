'use strict';
// End-to-end test through the real MCP server:  node test/e2e.js <browser-id>
// The browser must be running with the extension installed and paired.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const browser = process.argv[2];
if (!browser) { console.error('usage: node test/e2e.js <browser-id>'); process.exit(2); }

const PAGE_PORT = 19791;
const base = `http://127.0.0.1:${PAGE_PORT}`;
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>BMCP test</title></head><body>
<h1>Test form</h1>
<form id="f">
<label for="name">Your name</label> <input id="name">
<label>Color <select id="color"><option>Red</option><option>Green</option><option>Blue</option></select></label>
<label><input type="checkbox" id="agree"> I agree</label>
<input type="password" id="pw" aria-label="Secret" value="hunter2secret">
<button type="submit">Send form</button>
</form>
<div id="out">idle</div>
<p>Go to the <a href="/second">Second page</a> now.</p>
<button id="late">Load late</button>
<table><tr><th>Host</th><th>Role</th></tr><tr><td>alpha</td><td>primary</td></tr></table>
<div style="display:none">hidden text must not show</div>
<script>
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('out').textContent = 'submitted:' + document.getElementById('name').value + ':' +
    document.getElementById('color').value + ':' + document.getElementById('agree').checked;
});
document.getElementById('late').addEventListener('click', () => setTimeout(() => {
  const p = document.createElement('p'); p.textContent = 'late content arrived'; document.body.append(p);
}, 800));
</script></body></html>`;
const SECOND = '<!doctype html><html><head><meta charset="utf-8"><title>Second</title></head><body><h1>Second page content</h1><p style="margin-top:3000px">bottom</p></body></html>';

const pages = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/second') ? SECOND : FORM);
});

const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let nextId = 1;
const pending = new Map();
mcp.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout: ' + method)), 120000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args) {
  const m = await request('tools/call', { name, arguments: args });
  if (m.error) return { text: 'RPC ERROR ' + JSON.stringify(m.error), isError: true };
  const c = m.result.content || [];
  return {
    text: c.filter((x) => x.type === 'text').map((x) => x.text).join('\n'),
    image: (c.find((x) => x.type === 'image') || {}).data,
    isError: !!m.result.isError,
  };
}

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '\n      ' + String(detail).replace(/\n/g, '\n      ').slice(0, 1500)));
}
const refOf = (snap, re) => { const m = re.exec(snap); return m ? m[1] : null; };

(async () => {
  await new Promise((r) => pages.listen(PAGE_PORT, '127.0.0.1', r));
  let tab = null;
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request('tools/list', {});
    check('MCP handshake and tool list', init.result.serverInfo.name === 'browser-mcp' && tools.result.tools.length === 10, JSON.stringify(init.result));

    let r = await call('status', {});
    check(`status lists ${browser}`, new RegExp('^' + browser + '\\b', 'm').test(r.text), r.text);

    r = await call('tabs', { action: 'new', browser, url: base + '/form' });
    tab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
    check('open a tab', !!tab && r.text.includes('BMCP test'), r.text);
    if (!tab) throw new Error('no tab; stopping');

    const snap = (await call('snapshot', { tab })).text;
    check('snapshot outline',
      /heading "Test form" \[h1\]/.test(snap) && /textbox "Your name" \[e\d+\]/.test(snap) && /combobox "Color" \[e\d+\] value="Red"/.test(snap) &&
      /checkbox "I agree" \[e\d+\]/.test(snap) && /button "Send form" \[e\d+\]/.test(snap) && /row: alpha \| primary/.test(snap) &&
      /link "Second page" \[e\d+\]/.test(snap) && !snap.includes('hidden text'), snap);
    check('password value is masked', !snap.includes('hunter2secret') && snap.includes('value=•••'), snap);

    const rName = refOf(snap, /textbox "Your name" \[(e\d+)\]/);
    const rColor = refOf(snap, /combobox "Color" \[(e\d+)\]/);
    const rAgree = refOf(snap, /checkbox "I agree" \[(e\d+)\]/);
    const rSend = refOf(snap, /button "Send form" \[(e\d+)\]/);
    const rLate = refOf(snap, /button "Load late" \[(e\d+)\]/);
    const rLink = refOf(snap, /link "Second page" \[(e\d+)\]/);

    r = await call('type', { tab, ref: rName, text: 'Anisto test' });
    check('type into a field', /^typed into/.test(r.text), r.text);
    r = await call('type', { tab, ref: rColor, text: 'Green' });
    check('choose a select option', /selected "Green"/.test(r.text), r.text);
    r = await call('click', { tab, ref: rAgree });
    check('click a checkbox', /^clicked/.test(r.text), r.text);
    await call('click', { tab, ref: rSend });
    r = await call('wait_for', { tab, text: 'submitted:Anisto test:Green:true', timeout_ms: 5000 });
    check('form submitted with all three values', !r.isError, r.text + '\n' + (await call('snapshot', { tab, find: 'submitted' })).text);

    await call('click', { tab, ref: rLate });
    r = await call('wait_for', { tab, text: 'late content arrived', timeout_ms: 5000 });
    check('wait_for content that appears later', !r.isError, r.text);
    r = await call('wait_for', { tab, text: 'this never appears', timeout_ms: 800 });
    check('wait_for reports a timeout', r.isError && /timed out/.test(r.text), r.text);

    await call('type', { tab, ref: rName, text: 'second', submit: true });
    r = await call('wait_for', { tab, text: 'submitted:second:Green:true', timeout_ms: 5000 });
    check('type with submit (Enter)', !r.isError, r.text);

    r = await call('evaluate', { tab, code: 'document.title' });
    check('evaluate an expression', r.text.trim() === 'BMCP test', r.text);
    r = await call('evaluate', { tab, code: 'const n = document.querySelectorAll("option").length; return n * 2;' });
    check('evaluate a function body', r.text.trim() === '6', r.text);

    r = await call('snapshot', { tab, find: 'load late' });
    check('snapshot with find', /button "Load late"/.test(r.text) && !/Send form/.test(r.text), r.text);
    r = await call('snapshot', { tab, interactive: true });
    check('snapshot interactive only', !/heading/.test(r.text) && /button "Send form"/.test(r.text), r.text);
    r = await call('click', { tab, ref: 'e9999' });
    check('stale ref gives a clear error', r.isError && /new snapshot/.test(r.text), r.text);

    r = await call('click', { tab, ref: rLink });
    check('click a link and report navigation', /url now: .*\/second/.test(r.text), r.text);
    r = await call('snapshot', { tab });
    check('read the second page', /heading "Second page content"/.test(r.text), r.text);
    r = await call('press_key', { tab, key: 'End' });
    const y = await call('evaluate', { tab, code: 'Math.round(window.scrollY)' });
    check('press_key End scrolls the page', /^pressed End/.test(r.text) && Number(y.text) > 500, r.text + ' scrollY=' + y.text);
    r = await call('navigate', { tab, action: 'back' });
    check('navigate back', /url: .*\/form/.test(r.text), r.text);
    r = await call('navigate', { tab, url: base + '/second' });
    check('navigate to a URL', /url: .*\/second/.test(r.text) && /title: Second/.test(r.text), r.text);

    r = await call('screenshot', { tab });
    const file = (/saved: (.+?\.(?:jpg|png))/.exec(r.text) || [])[1];
    check('screenshot', !!r.image && r.image.length > 2000 && !!file && fs.existsSync(file), r.text);
    if (file) { try { fs.unlinkSync(file); } catch {} }

    // Firefox containers. E2E_CONTAINERS=1 tests the basics; =sim also needs the test/mac-sim add-on (throwaway profile only).
    if (process.env.E2E_CONTAINERS) {
      r = await call('tabs', { action: 'containers', browser });
      const names = ((/: (.+)$/.exec(r.text) || [])[1] || '').split(', ').filter(Boolean);
      check('list containers', names.length > 0, r.text);
      const c = names.includes('Work') ? 'Work' : names[0];
      r = await call('tabs', { action: 'new', browser, url: base + '/second', container: c });
      const ctab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
      check('open a tab in a container', !!ctab && r.text.includes('container: ' + c), r.text);
      if (ctab) {
        await call('evaluate', { tab: ctab, code: 'document.cookie = "bmcp_c=1; path=/"; document.cookie' });
        const inC = await call('evaluate', { tab: ctab, code: 'document.cookie' });
        const plain = await call('evaluate', { tab, code: 'document.cookie' });
        check('container cookies are separate from the plain tab', /bmcp_c=1/.test(inC.text) && !/bmcp_c=1/.test(plain.text), 'container: ' + inC.text + ' | plain: ' + plain.text);
        await call('evaluate', { tab: ctab, code: 'document.cookie = "bmcp_c=; max-age=0; path=/"; 1' });
        r = await call('tabs', { action: 'list', browser });
        check('tab list shows the container', r.text.includes(ctab + ' [' + c + ']'), r.text);
        await call('tabs', { action: 'close', tab: ctab });
      }
      r = await call('tabs', { action: 'new', browser, url: base + '/second', container: 'no-such-container-xyz' });
      check('unknown container gives a clear error', r.isError && /no container named/.test(r.text), r.text);
      if (process.env.E2E_CONTAINERS === 'sim') {
        r = await call('tabs', { action: 'new', browser, url: base + '/reopen-in-container' });
        const rtab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
        check('follows a new tab that the containers add-on reopens', !!rtab && /container: Work/.test(r.text) && /reopened/.test(r.text), r.text);
        if (rtab) {
          const s2 = await call('snapshot', { tab: rtab });
          check('the reopened tab is usable', /heading "Test form"/.test(s2.text), s2.text);
          await call('tabs', { action: 'close', tab: rtab });
        }
        r = await call('navigate', { tab, url: base + '/reopen-in-container?nav' });
        const ntab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
        check('follows a navigation that the containers add-on moves to a container', !!ntab && ntab !== tab && /container: Work/.test(r.text) && /reopened/.test(r.text), r.text);
        if (ntab && ntab !== tab) await call('tabs', { action: 'close', tab: ntab });
      }
    }

    r = await call('tabs', { action: 'list', browser });
    check('tabs list shows the tab I opened', r.text.includes(tab) && !r.text.includes('(user tab)'), r.text);
    r = await call('tabs', { action: 'list' });
    check('tabs list across all connected browsers', r.text.includes(tab), r.text);
    // On a real profile (E2E_REAL=1) never list or try to close the user's own tabs.
    r = process.env.E2E_REAL ? { text: '' } : await call('tabs', { action: 'list', browser, all: true });
    const userTab = (/^(\S+) \(user tab\)/m.exec(r.text) || [])[1];
    if (userTab) {
      r = await call('tabs', { action: 'close', tab: userTab });
      check("refuses to close a tab it did not open", r.isError && /not opened by you/.test(r.text), r.text);
    }
    r = await call('tabs', { action: 'close', tab });
    check('close the tab', /^closed/.test(r.text), r.text);
    tab = null;
  } catch (e) {
    failed++;
    console.log('FAIL  test run stopped: ' + e.message);
  } finally {
    if (tab) await call('tabs', { action: 'close', tab }).catch(() => {});
    console.log(failed ? `RESULT: ${failed} check(s) FAILED on ${browser}` : `RESULT: all checks passed on ${browser}`);
    mcp.kill();
    pages.close();
    process.exit(failed ? 1 : 0);
  }
})();
