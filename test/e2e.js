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
<button id="real">Real click test</button> <span id="realOut">none</span>
<input type="file" id="file" multiple aria-label="Attach files"> <span id="fileOut">no files</span>
<button id="ask">Ask confirm</button> <button id="pr">Ask prompt</button> <span id="dlgOut">no dialog</span>
<div id="hov" style="display:inline-block;padding:8px;border:1px solid #888">Hover me</div> <span id="hovOut">not hovered</span>
<div id="src" draggable="true" style="display:inline-block;padding:8px;background:#ddd">Drag me</div>
<div id="dst" style="display:inline-block;padding:20px;border:2px dashed #888">Drop here</div> <span id="dropOut">not dropped</span>
<div id="pad" style="width:120px;height:60px;background:#cde">Mouse pad</div> <span id="padOut">no mouse</span>
<button id="load">Load data</button> <button id="failb">Load failing</button> <button id="post">Post data</button> <span id="netOut">no data</span>
<script>
document.getElementById('load').addEventListener('click', () => fetch('/api/data').then((r) => r.json()).then((j) => { document.getElementById('netOut').textContent = 'data=' + j.answer; }).catch(() => { document.getElementById('netOut').textContent = 'fetch failed'; }));
document.getElementById('failb').addEventListener('click', () => fetch('/api/fail').then((r) => { document.getElementById('netOut').textContent = 'status=' + r.status; }).catch(() => { document.getElementById('netOut').textContent = 'fetch failed'; }));
document.getElementById('post').addEventListener('click', () => fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=zed&n=1' }).then((r) => r.text()).then((t) => { document.getElementById('netOut').textContent = t; }));
</script>
<script>
const $ = (id) => document.getElementById(id);
$('real').addEventListener('click', (e) => { $('realOut').textContent = 'click trusted=' + e.isTrusted; });
$('file').addEventListener('change', () => { $('fileOut').textContent = 'files: ' + [...$('file').files].map((f) => f.name + ':' + f.size).join(','); });
$('ask').addEventListener('click', () => { $('dlgOut').textContent = 'confirm=' + confirm('Delete it?'); });
$('pr').addEventListener('click', () => { $('dlgOut').textContent = 'prompt=' + prompt('Your name?', 'nobody'); });
$('hov').addEventListener('mouseenter', () => { $('hovOut').textContent = 'hovered'; });
$('src').addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'payload-42'); });
$('dst').addEventListener('dragover', (e) => e.preventDefault());
$('dst').addEventListener('drop', (e) => { e.preventDefault(); $('dropOut').textContent = 'dropped ' + e.dataTransfer.getData('text/plain'); });
$('pad').addEventListener('click', (e) => { $('padOut').textContent = 'pad click at ' + Math.round(e.offsetX) + ',' + Math.round(e.offsetY); });
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

const CONSOLE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Console test</title></head><body><h1>Console test</h1>
<script>
console.log('hello-log', { a: 1 });
console.warn('careful-warn');
console.error('bad-thing-error');
Promise.reject(new Error('nobody-caught-me'));
setTimeout(() => { throw new Error('boom-uncaught'); }, 50);
</script></body></html>`;

const pages = http.createServer((req, res) => {
  if (req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'browzat' });
    return res.end('{"answer":42}');
  }
  if (req.url.startsWith('/api/fail')) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('server exploded');
  }
  if (req.url.startsWith('/api/echo')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('echo:' + body); });
    return undefined;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/second') ? SECOND : req.url.startsWith('/console') ? CONSOLE_PAGE : FORM);
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
    check('MCP handshake and tool list', init.result.serverInfo.name === 'browser-mcp' && tools.result.tools.length === 21, JSON.stringify(init.result));

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
    // A real End key scrolls smoothly on Chrome and Edge, as it does for a person: give the animation time.
    let y = { text: '0' };
    for (let i = 0; i < 10 && Number(y.text) <= 500; i++) {
      await new Promise((res) => setTimeout(res, 200));
      y = await call('evaluate', { tab, code: 'Math.round(window.scrollY)' });
    }
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

    // Phase 1: real input, upload, dialogs, hover, drag, mouse.
    {
      const real = browser !== 'firefox' && !/^firefox/.test(browser);
      r = await call('tabs', { action: 'new', browser, url: base + '/form' });
      const ptab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
      const read = async (id) => (await call('evaluate', { tab: ptab, code: `document.getElementById('${id}').textContent` })).text.trim();

      r = await call('click', { tab: ptab, selector: '#real' });
      const rc = await read('realOut');
      check(real ? 'click is real input (isTrusted) on Chrome/Edge' : 'click is simulated on Firefox', rc === 'click trusted=' + real, rc + ' | ' + r.text);

      r = await call('type', { tab: ptab, selector: '#name', text: 'Real typing' });
      const typed = (await call('evaluate', { tab: ptab, code: "document.getElementById('name').value" })).text.trim();
      check('type replaces the field value', typed === 'Real typing', typed + ' | ' + r.text);
      r = await call('type', { tab: ptab, selector: '#name', text: ' more', clear: false });
      const typed2 = (await call('evaluate', { tab: ptab, code: "document.getElementById('name').value" })).text.trim();
      check('type with clear:false appends', typed2 === 'Real typing more', typed2);

      const tmp = path.join(require('os').tmpdir(), 'browzat-e2e-upload.txt');
      fs.writeFileSync(tmp, 'hello from browzat\n');
      r = await call('upload', { tab: ptab, selector: '#file', files: [tmp] });
      const up = await read('fileOut');
      check('upload a file into a file input', up === 'files: browzat-e2e-upload.txt:19', up + ' | ' + r.text);
      r = await call('upload', { tab: ptab, selector: '#file', files: [tmp + '.missing'] });
      check('upload reports a missing file', r.isError && /file not found/.test(r.text), r.text);
      fs.unlinkSync(tmp);

      r = await call('click', { tab: ptab, selector: '#ask' });
      check('a confirm is dismissed by default and reported', (await read('dlgOut')) === 'confirm=false' && /dialog: confirm "Delete it\?" -> dismissed/.test(r.text), r.text);
      r = await call('dialog', { tab: ptab, action: 'accept' });
      r = await call('click', { tab: ptab, selector: '#ask' });
      check('dialog accept makes the next confirm return true', (await read('dlgOut')) === 'confirm=true', r.text);
      await call('dialog', { tab: ptab, action: 'accept', text: 'Zed' });
      r = await call('click', { tab: ptab, selector: '#pr' });
      check('dialog accept answers a prompt with text', (await read('dlgOut')) === 'prompt=Zed', r.text);

      r = await call('hover', { tab: ptab, selector: '#hov' });
      check('hover fires mouseenter', (await read('hovOut')) === 'hovered', r.text);

      r = await call('drag', { tab: ptab, from_selector: '#src', to_selector: '#dst' });
      const dropped = await read('dropOut');
      check('drag and drop (HTML5) carries the data', dropped === 'dropped payload-42', dropped + ' | ' + r.text);

      const box = JSON.parse((await call('evaluate', { tab: ptab, code: "(() => { const e = document.getElementById('pad'); e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return JSON.stringify({ x: b.left, y: b.top }); })()" })).text.trim());
      r = await call('mouse', { tab: ptab, x: box.x + 30, y: box.y + 20 });
      const pad = await read('padOut');
      // ±1 px: Firefox rounds the coordinates of script-made mouse events to whole pixels.
      const pm = /^pad click at (-?\d+),(-?\d+)$/.exec(pad);
      check('mouse click at coordinates', !!pm && Math.abs(pm[1] - 30) <= 1 && Math.abs(pm[2] - 20) <= 1, pad + ' | ' + r.text);

      await call('tabs', { action: 'close', tab: ptab });
    }

    // Phase 2: network log, request details and bodies, routes, network conditions, console.
    {
      const chromium = browser !== 'firefox' && !/^firefox/.test(browser);
      r = await call('tabs', { action: 'new', browser, url: base + '/form' });
      const ntab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
      const out = async () => (await call('evaluate', { tab: ntab, code: "document.getElementById('netOut').textContent" })).text.trim();
      const waitOut = async (want) => { let v = ''; for (let i = 0; i < 15; i++) { v = await out(); if (want.test(v)) break; await new Promise((res) => setTimeout(res, 200)); } return v; };
      const numOf = (txt, re) => { const m = new RegExp('^#(\\d+) ' + re.source, 'm').exec(txt); return m ? Number(m[1]) : null; };

      await call('click', { tab: ntab, selector: '#load' });
      check('fetch through the page works', (await waitOut(/data=/)) === 'data=42', await out());
      r = await call('network_requests', { tab: ntab });
      const dataN = numOf(r.text, /GET 200 xmlhttprequest \S+\/api\/data/);
      check('network_requests lists the fetch with status and type', dataN != null, r.text);
      check('network_requests lists the page itself', /GET 200 main_frame \S+\/form/.test(r.text), r.text);
      r = await call('network_request', { tab: ntab, request: dataN });
      check('network_request shows response headers', /x-test: browzat/i.test(r.text) && /content-type: application\/json/i.test(r.text), r.text);
      check('network_request says bodies are not recorded yet', /bodies are not being recorded/.test(r.text), r.text);

      r = await call('network_requests', { tab: ntab, bodies: true });
      check('network_requests bodies:true switches body recording on', /response bodies are now recorded/.test(r.text), r.text);
      await call('click', { tab: ntab, selector: '#load' });
      await waitOut(/data=42/);
      await new Promise((res) => setTimeout(res, 500));
      r = await call('network_requests', { tab: ntab, filter: '/api/data' });
      const all = [...r.text.matchAll(/^#(\d+) GET 200/gm)].map((m) => Number(m[1]));
      r = await call('network_request', { tab: ntab, request: all[all.length - 1] });
      check('network_request shows the response body', /"answer":42/.test(r.text), r.text);

      await call('click', { tab: ntab, selector: '#post' });
      check('POST through the page works', (await waitOut(/echo:/)) === 'echo:name=zed&n=1', await out());
      r = await call('network_requests', { tab: ntab, filter: '/api/echo' });
      r = await call('network_request', { tab: ntab, request: numOf(r.text, /POST/) });
      // Body recording was on for this request, so the exact body (field order kept) comes from the debugger on
      // Chrome and Edge, and from the request bytes on Firefox.
      check('network_request shows the exact request body', /request body:\nname=zed&n=1(\n|$)/.test(r.text), r.text);

      await call('click', { tab: ntab, selector: '#failb' });
      await waitOut(/status=/);
      r = await call('network_requests', { tab: ntab, failed: true });
      check('network_requests failed:true lists the HTTP 500', /GET 500 xmlhttprequest \S+\/api\/fail/.test(r.text) && !/\/api\/data/.test(r.text), r.text);
      await call('network_requests', { tab: ntab, bodies: false });

      r = await call('network_route', { tab: ntab, pattern: '*/api/data', body: '{"answer":7}' });
      check('network_route adds a mock', /^route 1: mocking/.test(r.text), r.text);
      await call('click', { tab: ntab, selector: '#load' });
      check('the mocked response reaches the page', (await waitOut(/data=7/)) === 'data=7', await out());
      r = await call('network_route', { tab: ntab, pattern: '/api/fail', block: true });
      await call('click', { tab: ntab, selector: '#failb' });
      check('a blocked request fails in the page', (await waitOut(/fetch failed/)) === 'fetch failed', await out());
      r = await call('network_route', { tab: ntab, action: 'list' });
      check('network_route list shows both routes with hits', /route 1: mock 200 "\*\/api\/data" \(1 hit/.test(r.text) && /route 2: block "\/api\/fail" \(1 hit/.test(r.text), r.text);
      r = await call('network_route', { tab: ntab, action: 'clear' });
      await call('click', { tab: ntab, selector: '#load' });
      check('after clear the real response is back', (await waitOut(/data=42/)) === 'data=42', await out());

      r = await call('network_conditions', { tab: ntab, offline: true });
      if (chromium) {
        check('network_conditions offline', /now offline/.test(r.text), r.text);
        await call('click', { tab: ntab, selector: '#load' });
        check('offline makes the fetch fail', (await waitOut(/fetch failed/)) === 'fetch failed', await out());
        await call('network_conditions', { tab: ntab, reset: true });
        await call('click', { tab: ntab, selector: '#load' });
        check('reset brings the network back', (await waitOut(/data=42/)) === 'data=42', await out());
      } else {
        check('network_conditions explains it is not available in Firefox', r.isError && /not available in Firefox/.test(r.text), r.text);
      }

      await call('navigate', { tab: ntab, url: base + '/console' });
      // The page throws from a 50 ms timer, but agent tabs sit in the background, where browsers delay timers (Firefox
      // to about a second): wait for that error to arrive, up to 4 s.
      for (let i = 0; i < 20; i++) {
        await new Promise((res) => setTimeout(res, 200));
        r = await call('console_messages', { tab: ntab });
        if (/boom-uncaught/.test(r.text)) break;
      }
      check('console_messages has log, warn and error', /\[log\] hello-log/.test(r.text) && /\[warn\] careful-warn/.test(r.text) && /\[error\] bad-thing-error/.test(r.text), r.text);
      check('console_messages has the uncaught error and the unhandled rejection', /boom-uncaught/.test(r.text) && /nobody-caught-me/.test(r.text), r.text);
      r = await call('console_messages', { tab: ntab, level: 'error' });
      check('console_messages level:error hides log and warn', /bad-thing-error/.test(r.text) && !/hello-log/.test(r.text) && !/careful-warn/.test(r.text), r.text);
      await call('console_messages', { tab: ntab, clear: true });
      r = await call('console_messages', { tab: ntab });
      check('console_messages clear hides earlier messages', /no console messages/.test(r.text), r.text);

      await call('tabs', { action: 'close', tab: ntab });
    }

    // Handoff. Nobody clicks here, so this covers the card, its isolation, navigation, timeout and tab close.
    {
      const cardThere = async (t) => {
        const e = await call('evaluate', {
          tab: t,
          code: "[...document.body.children].some((x) => x.tagName === 'DIV' && x.style.zIndex === '2147483647')",
        });
        return e.text.trim();
      };
      r = await call('tabs', { action: 'new', browser, url: base + '/form' });
      const htab = (/^tab: (\S+)/m.exec(r.text) || [])[1];
      const waiting = call('handoff', { tab: htab, message: 'E2E test: nobody needs to click this.', timeout_s: 10 });
      await new Promise((res) => setTimeout(res, 2000));
      check('handoff shows a card in the page', (await cardThere(htab)) === 'true', 'card not found');
      const inner = await call('evaluate', {
        tab: htab,
        code: "const h = [...document.body.children].find((x) => x.style.zIndex === '2147483647'); return h ? String(h.shadowRoot) : 'no host';",
      });
      check('the page cannot reach into the card (closed shadow root)', inner.text.trim() === 'null', inner.text);
      r = await waiting;
      check('handoff times out when nobody answers', r.isError && /nobody answered/.test(r.text), r.text);
      check('the card is removed after the handoff', (await cardThere(htab)) === 'false', 'card still there');

      const closing = call('handoff', { tab: htab, message: 'E2E test: the tab will move, then close.', timeout_s: 60 });
      await new Promise((res) => setTimeout(res, 1500));
      await call('navigate', { tab: htab, url: base + '/second' });
      await new Promise((res) => setTimeout(res, 1500));
      check('the card comes back after the page navigates', (await cardThere(htab)) === 'true', 'card not found on the new page');
      await call('tabs', { action: 'close', tab: htab });
      r = await closing;
      check('closing the tab ends the handoff', r.isError && /tab was closed/.test(r.text), r.text);
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
