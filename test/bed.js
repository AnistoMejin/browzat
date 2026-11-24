'use strict';
// The test bed: one command that runs the end-to-end suite on throwaway browsers.
//
//   node test/bed.js [--browsers chromium,firefox] [--only <group,...>] [--headed] [--keep] [--quiet]
//                    [--no-containers] [--timeout <seconds>]
//   node test/bed.js --stop <bed folder>      stops a bed that was started with --keep
//
// It builds the extension from this working copy into a temporary folder, starts its own relay on a free port with
// its own data folder, starts every chosen browser with a fresh profile and that build, pairs them, runs test/e2e.js
// for all of them at the same moment, and then removes everything it started: its browsers, its relay, its folder.
// It never uses the real relay (port 19789), the real data folder or a real browser profile, and it has no fixed
// port, so several beds can run at the same moment from different working copies.
//
// Options
//   --browsers <list>   chromium, edge, chrome, firefox, or all. Default: one Chromium-family browser (the first
//                       found of chromium, edge, chrome) and firefox.
//   --only <groups>     run only these groups of checks (the same as the environment variable E2E_ONLY);
//                       "core" is the built-in checks, the others are the files test/e2e/<nn>-<group>.js
//   --headed            show the browser windows (default: headless, nothing appears on screen)
//   --keep              after the run leave the relay and the browsers running, print how to use and stop them
//   --quiet             print only failed checks and the summary
//   --no-containers     Firefox: do not install test/mac-sim and do not run the container checks
//   --timeout <s>       give up on a browser's run after this many seconds (default 600)
// Environment
//   E2E_ONLY                                      see --only
//   CHROMIUM_BIN, EDGE_BIN, CHROME_BIN, FIREFOX_BIN   path of a browser that is not in its usual place
//   CHROME_EXTRA_ARGS                             extra flags for Chromium-family browsers, for example --no-sandbox
//   NODE_PATH                                     a node_modules folder with the ws package, when this working copy
//                                                 has none (the installed copy's node_modules is found by itself)
//   BED_DEBUG=1                                   print how long each step of starting and stopping takes
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const LIVE_PORT = 19789; // the real relay: never used, never chosen
const PREFIX = 'browzat-bed-';
const NAMES = ['chromium', 'edge', 'chrome', 'firefox'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const say = (m) => console.log('[bed] ' + m);
const T0 = Date.now();
const debug = (m) => { if (process.env.BED_DEBUG) console.log(`[bed] ${((Date.now() - T0) / 1000).toFixed(2)} s  ${m}`); };

// ---- processes and folders ----

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Kills processes, each with everything it started, in the order given.
function killPids(pids) {
  if (!pids.length) return;
  if (WIN) {
    const args = ['/T', '/F'];
    for (const p of pids) args.push('/PID', String(p));
    spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
  } else {
    for (const p of pids) {
      try { process.kill(-p, 'SIGKILL'); } catch (e) {}
      try { process.kill(p, 'SIGKILL'); } catch (e) {}
    }
  }
}

// Kills processes this bed started. Only those whose exit has not been seen yet: after that the system may have
// given the number to another program.
function killChildren(children) {
  killPids(children.filter((c) => c && c.pid && c.exitCode === null && c.signalCode === null).map((c) => c.pid));
}

// The processes whose command line names the bed folder. The relay, the browsers and the test runs of a bed all
// carry it, and nothing else does: the folder name is random.
function taggedProcesses(dir) {
  let lines = [];
  if (WIN) {
    const ps = "$d = $env:BED_DIR; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) } | " +
      "ForEach-Object { '{0} {1}' -f $_.ProcessId, $(if ($_.CommandLine -match 'e2e\\.js|mcp\\.js') { 'test' } else { 'other' }) }";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: Object.assign({}, process.env, { BED_DIR: dir }), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    lines = String(r.stdout || '').split(/\r?\n/);
  } else {
    const r = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 60000 });
    lines = String(r.stdout || '').split('\n').filter((l) => l.includes(dir)).map((l) => {
      const pid = l.trim().split(/\s+/)[0];
      return pid + (/e2e\.js|mcp\.js/.test(l) ? ' test' : ' other');
    });
  }
  return lines.map((l) => l.trim().split(' ')).filter((p) => /^\d+$/.test(p[0]) && Number(p[0]) !== process.pid)
    .map((p) => ({ pid: Number(p[0]), test: p[1] === 'test' }));
}

function isBedFolder(dir) {
  const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
  return path.basename(dir).startsWith(PREFIX) && same(path.resolve(path.dirname(dir)), path.resolve(os.tmpdir()));
}

function removeFolder(dir, withinMs) {
  const end = Date.now() + withinMs;
  for (;;) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    if (!fs.existsSync(dir)) return true;
    if (Date.now() >= end) return false;
    sleepSync(100);
  }
}

// Stops whatever still runs out of a bed folder and deletes the folder. The test runs go first: an MCP server that
// outlives its relay would start a new one.
// ownChildrenStopped: the caller has just killed the bed's own processes. On Windows a browser that still runs
// keeps files of its profile locked, so when the folder can be deleted nothing is left and the (slow) search for
// leftover processes is skipped.
function cleanFolder(dir, ownChildrenStopped) {
  if (!isBedFolder(dir)) throw new Error('not a bed folder: ' + dir);
  if (ownChildrenStopped && WIN && removeFolder(dir, 2500)) return true;
  for (let round = 0; round < 3; round++) {
    const procs = taggedProcesses(dir);
    if (!procs.length) break;
    killPids(procs.filter((x) => x.test).map((x) => x.pid));
    killPids(procs.filter((x) => !x.test).map((x) => x.pid));
    sleepSync(300);
  }
  return removeFolder(dir, 10000);
}

// Folders of beds that were killed before they could clean up (their owner is gone).
function cleanStale() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)); } catch (e) {}
  for (const n of names) {
    const dir = path.join(os.tmpdir(), n);
    try {
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'bed.json'), 'utf8')); } catch (e) {}
      if (owner ? alive(owner.pid) : Date.now() - fs.statSync(dir).mtimeMs < 120000) continue;
      if (cleanFolder(dir, false)) say('removed what a killed bed left behind: ' + dir);
    } catch (e) {}
  }
}

// Internal: `node test/bed.js --reap` watches a bed and cleans up after it if the bed is killed outright.
function reap() {
  const dir = process.env.BED_REAP_DIR;
  const owner = Number(process.env.BED_REAP_PID);
  if (!dir || !owner || !isBedFolder(dir)) process.exit(2);
  setInterval(() => {
    if (!fs.existsSync(dir)) process.exit(0);
    if (alive(owner)) return;
    try { cleanFolder(dir, false); } catch (e) {}
    process.exit(0);
  }, 250);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---- finding things ----

// A node_modules folder that holds the ws package (the relay's one dependency).
function findWs() {
  const has = (dir) => !!dir && fs.existsSync(path.join(dir, 'ws', 'package.json'));
  for (let d = ROOT; ; d = path.dirname(d)) {
    if (has(path.join(d, 'node_modules'))) return path.join(d, 'node_modules');
    if (path.dirname(d) === d) break;
  }
  const more = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)
    .concat([path.join(os.homedir(), '.mcp-servers', 'browser-mcp', 'node_modules'), path.join(os.homedir(), 'browser-mcp', 'node_modules')]);
  const hit = more.find(has);
  if (!hit) throw new Error('the ws package was not found. Run npm install here, or set NODE_PATH to a node_modules folder that contains ws.');
  return hit;
}

function onPath(names) {
  for (const n of names) {
    for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) {}
    }
  }
  return null;
}

// Chrome for Testing as installed by Playwright: the newest chromium-<revision> folder of its cache.
function playwrightChromium() {
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  const inside = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
  for (const c of caches) {
    let revs = [];
    try { revs = fs.readdirSync(c).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))); } catch (e) {}
    for (const r of revs) {
      for (const i of inside) {
        const p = path.join(c, r, i);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function findBrowser(name) {
  const set = process.env[name.toUpperCase() + '_BIN'];
  if (set) return set;
  const first = (list) => list.find((p) => p && fs.existsSync(p)) || null;
  if (WIN) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    if (name === 'chromium') return playwrightChromium() || first(pf.map((d) => path.join(d, 'Chromium', 'Application', 'chrome.exe')));
    if (name === 'edge') return first(pf.map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
    if (name === 'chrome') return first(pf.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    return first(pf.map((d) => path.join(d, 'Mozilla Firefox', 'firefox.exe')));
  }
  if (process.platform === 'darwin') {
    const app = (n, bin) => first([`/Applications/${n}.app/Contents/MacOS/${bin}`, path.join(os.homedir(), `Applications/${n}.app/Contents/MacOS/${bin}`)]);
    if (name === 'chromium') return playwrightChromium() || app('Chromium', 'Chromium');
    if (name === 'edge') return app('Microsoft Edge', 'Microsoft Edge');
    if (name === 'chrome') return app('Google Chrome', 'Google Chrome');
    return app('Firefox', 'firefox');
  }
  if (name === 'chromium') return playwrightChromium() || onPath(['chromium', 'chromium-browser']);
  if (name === 'edge') return onPath(['microsoft-edge', 'microsoft-edge-stable']);
  if (name === 'chrome') return onPath(['google-chrome', 'google-chrome-stable']);
  return onPath(['firefox', 'firefox-esr']);
}

// ---- options ----

function usage(code) {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const text = lines.slice(1, lines.findIndex((l) => !l.startsWith('//') && !l.startsWith("'use strict'"))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  console.log(text);
  process.exit(code);
}

function options(argv) {
  const o = { browsers: null, only: process.env.E2E_ONLY || '', headed: false, keep: false, quiet: false, containers: true, timeout: 600, stop: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) { console.error(`error: ${a} needs a value`); process.exit(2); }
      return argv[++i];
    };
    if (a === '--browsers') o.browsers = value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--only') o.only = value();
    else if (a === '--headed') o.headed = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (a === '--no-containers') o.containers = false;
    else if (a === '--timeout') o.timeout = Math.max(10, Number(value()) || 600);
    else if (a === '--stop') o.stop = value();
    else if (a === '--help' || a === '-h') usage(0);
    else { console.error('error: unknown option ' + a + ' (see --help)'); process.exit(2); }
  }
  return o;
}

// Which browsers to start: [{ name, exe }].
function chooseBrowsers(o) {
  let names = o.browsers;
  if (names && names.includes('all')) names = NAMES.filter((n) => findBrowser(n));
  if (names) {
    const bad = names.find((n) => !NAMES.includes(n));
    if (bad) throw new Error(`unknown browser "${bad}"; use ${NAMES.join(', ')} or all`);
    names = [...new Set(names)];
    const missing = names.find((n) => !findBrowser(n));
    if (missing) throw new Error(`${missing} was not found on this computer; set ${missing.toUpperCase()}_BIN to its program file`);
  } else {
    // Default: one Chromium-family browser plus Firefox. Chrome for Testing comes first because it is a separate
    // program that shares nothing with the user's own Chrome and Edge (no profile, updater or policy) and does not
    // update itself, so runs repeat; Edge and Chrome are used when it is not installed.
    const chromiumFamily = ['chromium', 'edge', 'chrome'].find((n) => findBrowser(n));
    names = [chromiumFamily, findBrowser('firefox') ? 'firefox' : null].filter(Boolean);
    if (!chromiumFamily) say('note: no Chromium-family browser was found (chromium, edge, chrome); it is skipped');
    if (!names.includes('firefox')) say('note: firefox was not found; it is skipped');
  }
  if (!names.length) throw new Error('no browser to test with was found');
  return names.map((name) => ({ name, exe: findBrowser(name) }));
}

// Refuses a group name that does not exist before anything is started (test/e2e.js checks the files in full).
function checkGroups(only) {
  let files = [];
  try { files = fs.readdirSync(path.join(__dirname, 'e2e')); } catch (e) {}
  const groups = ['core'].concat(files.map((f) => (/^\d+-([a-z0-9][a-z0-9-]*)\.js$/.exec(f) || [])[1]).filter(Boolean));
  const unknown = String(only || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).find((g) => !groups.includes(g));
  if (unknown) throw new Error(`there is no group "${unknown}"; the groups are: ${groups.join(', ')}`);
}

// ---- the relay ----

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const j = await r.json();
    return j && j.name === 'browser-mcp-relay' ? j : null;
  } catch (e) {
    return null;
  }
}

async function rpc(bed, method, params) {
  const r = await fetch(`http://127.0.0.1:${bed.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bed.token },
    body: JSON.stringify({ method, params: params || {} }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function tail(file, n) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch (e) { return ''; }
}

async function startRelay(bed) {
  const errFile = path.join(bed.dir, 'relay-stderr.log');
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = await freePort();
    if (port === LIVE_PORT) continue;
    const env = Object.assign({}, bed.env, { BROWSER_MCP_PORT: String(port) });
    const err = fs.openSync(errFile, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'relay.js'), '--bed=' + bed.dir], {
      env, stdio: ['ignore', 'ignore', err], windowsHide: true, detached: !WIN,
    });
    fs.closeSync(err);
    bed.children.push(child);
    for (let i = 0; i < 200 && child.exitCode === null; i++) {
      await sleep(50);
      const h = await health(port);
      if (!h) continue;
      if (h.pid !== child.pid) break; // another program took the port in between: try the next one
      bed.port = port;
      bed.relay = child;
      bed.env.BROWSER_MCP_PORT = String(port);
      bed.token = fs.readFileSync(path.join(bed.home, 'token'), 'utf8').trim();
      return;
    }
    killChildren([child]);
    const why = tail(errFile, 6);
    if (/Cannot find module/.test(why)) break;
  }
  throw new Error('the relay did not start.\n' + (tail(errFile, 12) || tail(path.join(bed.home, 'relay.log'), 12)));
}

// ---- Chromium-family browsers: the extension is loaded through the DevTools pipe (no port) ----

function pipeClient(child) {
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  let buf = '';
  let id = 0;
  const pending = new Map();
  fromBrowser.setEncoding('utf8');
  fromBrowser.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      let m = null;
      try { m = JSON.parse(buf.slice(0, i)); } catch (e) {}
      buf = buf.slice(i + 1);
      if (m && m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  fromBrowser.on('error', () => {});
  toBrowser.on('error', () => {});
  let gone = '';
  const lost = (why) => {
    gone = gone || why;
    for (const done of pending.values()) done({ error: { message: gone } });
    pending.clear();
  };
  child.on('exit', (code) => lost('the browser exited (code ' + code + ')'));
  child.on('error', (e) => lost('the browser did not start: ' + e.message));
  return (method, params) => new Promise((resolve, reject) => {
    if (gone) return reject(new Error(method + ': ' + gone));
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); reject(new Error(method + ': the browser did not answer')); }, 30000);
    pending.set(n, (m) => { clearTimeout(t); m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result); });
    toBrowser.write(JSON.stringify({ id: n, method, params: params || {} }) + '\0');
  });
}

async function launchChromium(b, bed) {
  const args = [
    `--user-data-dir=${b.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    ...(bed.opts.headed ? [] : ['--headless=new']),
    '--window-size=1280,900',
    // Extra flags, for example CHROME_EXTRA_ARGS=--no-sandbox for a test build on Ubuntu 23.10+.
    ...String(process.env.CHROME_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
    'about:blank',
  ];
  const child = spawn(b.exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], detached: !WIN });
  b.child = child;
  bed.children.push(child);
  child.on('error', (e) => { b.failed = 'could not start ' + b.exe + ': ' + e.message; });
  const cdp = pipeClient(child);
  debug(b.name + ' started');
  const v = await cdp('Browser.getVersion');
  debug(b.name + ' answers');
  b.version = String(v.product || '').replace(/^.*\//, '');
  try {
    await cdp('Extensions.loadUnpacked', { path: path.join(bed.dist, 'chromium') });
  } catch (e) {
    throw new Error(`${b.name} ${b.version} could not load the unpacked extension through the DevTools pipe (${e.message})`);
  }
  debug(b.name + ' extension loaded');
  b.openPairing = () => cdp('Target.createTarget', { url: b.pairUrl });
  await b.openPairing();
}

// ---- Firefox: the add-on is installed temporarily over Firefox's own debugging protocol, the way web-ext does ----
// (WebDriver BiDi, which test/launch-firefox.js uses, can do it too, but its first command waits several seconds
// for the end of Firefox's start-up, and it switches Firefox to its automation settings.)

// Packets are "<length>:<json>". Firefox speaks first; after that an answer comes from the actor that was asked.
function debuggerClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let gone = '';
    const waiting = []; // { from, done }
    const lost = (why) => {
      gone = gone || why;
      for (const w of waiting.splice(0)) w.done({ error: 'closed', message: gone });
    };
    sock.on('error', () => lost('the connection to Firefox failed'));
    sock.on('close', () => lost('Firefox closed the connection'));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(58); // ":"
        if (colon < 0) return;
        const len = Number(buf.subarray(0, colon).toString());
        if (!Number.isInteger(len)) { sock.destroy(); return; } // whatever answers here is not Firefox
        if (buf.length < colon + 1 + len) return;
        let m = null;
        try { m = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString('utf8')); } catch (e) {}
        buf = buf.subarray(colon + 1 + len);
        const i = m ? waiting.findIndex((w) => w.from === m.from) : -1;
        if (i >= 0) waiting.splice(i, 1)[0].done(m);
      }
    });
    const ask = (to, type, more) => new Promise((res, rej) => {
      if (gone) { rej(new Error(type + ': ' + gone)); return; }
      const w = { from: to };
      const t = setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); rej(new Error(type + ': Firefox did not answer')); }, 60000);
      w.done = (m) => { clearTimeout(t); m.error ? rej(new Error(type + ': ' + m.error + (m.message ? ' ' + m.message : ''))) : res(m); };
      waiting.push(w);
      const body = Buffer.from(JSON.stringify(Object.assign({ to, type }, more)), 'utf8');
      sock.write(Buffer.concat([Buffer.from(body.length + ':'), body]));
    });
    waiting.push({
      from: 'root',
      done: (m) => (m.error || m.applicationType !== 'browser' ? reject(new Error('not ready')) : resolve({ ask, close: () => sock.destroy() })),
    });
  });
}

async function launchFirefox(b, bed) {
  // The debugger port is chosen here and opened by Firefox a moment later. A preference only this profile has tells
  // whether the server that answers on the port is this Firefox; if not, start again on another port.
  const mark = path.basename(bed.dir);
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    if (port === LIVE_PORT) continue;
    fs.rmSync(b.profile, { recursive: true, force: true });
    fs.mkdirSync(b.profile, { recursive: true });
    fs.writeFileSync(path.join(b.profile, 'user.js'), [
      'user_pref("devtools.debugger.remote-enabled", true);',
      'user_pref("devtools.debugger.prompt-connection", false);',
      'user_pref("devtools.chrome.enabled", true);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("app.update.disabledForTesting", true);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("browser.aboutwelcome.enabled", false);',
      `user_pref("browzat.bed", ${JSON.stringify(mark)});`,
      '',
    ].join('\n'));
    // The pairing page is the start page: the add-on finds it when it is installed a moment later.
    const args = ['--profile', b.profile, '--no-remote', '--start-debugger-server', String(port),
      ...(bed.opts.headed ? [] : ['--headless']), ...(WIN ? ['--wait-for-browser'] : []), b.pairUrl];
    const child = spawn(b.exe, args, { stdio: 'ignore', detached: !WIN });
    b.child = child;
    bed.children.push(child);
    child.on('error', (e) => { b.failed = 'could not start ' + b.exe + ': ' + e.message; });
    debug('firefox started');

    let c = null;
    for (let i = 0; i < 1200 && !c && child.exitCode === null; i++) {
      if (b.failed) throw new Error(b.failed);
      try { c = await debuggerClient(port); } catch (e) { await sleep(50); }
    }
    const root = c && await c.ask('root', 'getRoot').catch(() => null);
    const pref = root && await c.ask(root.preferenceActor, 'getCharPref', { value: 'browzat.bed' }).catch(() => null);
    if (pref && pref.value === mark) {
      debug('firefox answers');
      b.closeControl = c.close;
      const last = await c.ask(root.preferenceActor, 'getCharPref', { value: 'extensions.lastAppVersion' }).catch(() => null);
      b.version = String((last && last.value) || '');
      await c.ask(root.addonsActor, 'installTemporaryAddon', { addonPath: path.join(bed.dist, 'firefox') });
      if (bed.opts.containers) await c.ask(root.addonsActor, 'installTemporaryAddon', { addonPath: path.join(__dirname, 'mac-sim') });
      debug('firefox add-on installed');
      b.openPairing = async () => {};
      return;
    }
    if (c) c.close();
    killChildren([child]);
    if (attempt >= 3) throw new Error('firefox did not open its debugger server' + (child.exitCode !== null ? ' (it exited with code ' + child.exitCode + ')' : ''));
    await sleep(500);
  }
}

// Starts one browser and waits until its extension has redeemed its pairing link.
async function startBrowser(b, bed) {
  const t0 = Date.now();
  b.profile = path.join(bed.dir, b.name);
  fs.mkdirSync(b.profile, { recursive: true });
  const pair = await rpc(bed, 'pair_start');
  b.pairUrl = pair.url;
  await (b.name === 'firefox' ? launchFirefox(b, bed) : launchChromium(b, bed));
  let reopened = Date.now();
  for (;;) {
    if (b.failed) throw new Error(b.failed);
    if (b.child.exitCode !== null) throw new Error(`${b.name} exited (code ${b.child.exitCode}) before it paired`);
    const st = await rpc(bed, 'pair_status', { code: pair.code });
    if (st.redeemed.length) { b.kind = st.redeemed[0].kind; debug(b.name + ' paired'); break; }
    if (Date.now() - t0 > 90000) throw new Error(`${b.name} did not pair within 90 s (extension not loaded, or it did not see the pairing page)`);
    if (Date.now() - reopened > 15000) { reopened = Date.now(); await b.openPairing().catch(() => {}); }
    await sleep(100);
  }
}

// ---- the test runs ----

function runE2e(b, bed) {
  return new Promise((resolve) => {
    const env = Object.assign({}, bed.env);
    if (b.name === 'firefox' && bed.opts.containers) env.E2E_CONTAINERS = 'sim';
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'e2e.js'), b.id, '--bed=' + bed.dir], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !WIN,
    });
    bed.children.push(child);
    const res = { name: b.name, pass: 0, fail: 0, code: null, seconds: 0, timedOut: false, noMemory: false };
    let hidden = false; // quiet: hide a passed check and the lines that belong to it
    const onLine = (line) => {
      if (/^PASS  /.test(line)) res.pass++;
      else if (/^FAIL  /.test(line)) res.fail++;
      else if (/out of memory/i.test(line)) res.noMemory = true;
      if (bed.opts.quiet) {
        if (/^(PASS  |---- )/.test(line)) { hidden = true; return; }
        if (hidden && /^\s/.test(line)) return;
        hidden = false;
      }
      console.log(`[${b.name}] ${line}`);
    };
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    readline.createInterface({ input: child.stderr }).on('line', onLine);
    const timer = setTimeout(() => {
      res.timedOut = true;
      console.log(`[${b.name}] FAIL  the run did not finish within ${bed.opts.timeout} s; stopped`);
      killChildren([child]);
    }, bed.opts.timeout * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res.code = code;
      res.seconds = (Date.now() - t0) / 1000;
      res.ok = code === 0 && !res.fail && res.pass > 0 && !res.timedOut;
      resolve(res);
    });
  });
}

// ---- the bed ----

let bed = null;
let tornDown = false;

// Stops everything this bed started and deletes its folder. Synchronous, so it also works on the way out of a
// signal handler or an uncaught error. Runs once.
function teardown() {
  if (tornDown || !bed) return;
  tornDown = true;
  debug('teardown starts');
  for (const b of bed.browsers) { if (b.closeControl) b.closeControl(); }
  // Newest first: the test runs, then the browsers, then the relay.
  killChildren(bed.children.slice().reverse());
  debug('own processes stopped');
  cleanFolder(bed.dir, true);
  debug('folder removed');
}

function waitForStop(dir) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'stop'))) { clearInterval(t); resolve(); }
    }, 300);
  });
}

async function stopBed(dir) {
  dir = path.resolve(dir);
  if (!isBedFolder(dir)) { console.error('error: not a bed folder: ' + dir); process.exit(2); }
  if (!fs.existsSync(dir)) { say('nothing to stop: ' + dir + ' does not exist'); return; }
  let owner = null;
  try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'bed.json'), 'utf8')); } catch (e) {}
  if (owner && alive(owner.pid)) {
    fs.writeFileSync(path.join(dir, 'stop'), '');
    for (let i = 0; i < 100 && fs.existsSync(dir); i++) await sleep(200);
  }
  if (fs.existsSync(dir)) cleanFolder(dir, false);
  say(fs.existsSync(dir) ? 'could not remove ' + dir : 'stopped and removed ' + dir);
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.stop) return stopBed(opts.stop);
  const t0 = Date.now();
  checkGroups(opts.only);
  const chosen = chooseBrowsers(opts);
  const wsDir = findWs();
  const freeGb = os.freemem() / 2 ** 30;
  if (freeGb < 1.5) say(`note: only ${freeGb.toFixed(1)} GB of memory is free; browsers and test processes fail when it runs out`);
  cleanStale();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const home = path.join(dir, 'home');
  const env = Object.assign({}, process.env, {
    BROWSER_MCP_HOME: home,
    NODE_PATH: [wsDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  });
  delete env.E2E_REAL; // throwaway profiles only
  delete env.E2E_CONTAINERS;
  if (opts.only) env.E2E_ONLY = opts.only; else delete env.E2E_ONLY;
  bed = { opts, dir, home, env, dist: path.join(dir, 'dist'), children: [], browsers: chosen, port: 0, token: '', relay: null };
  fs.writeFileSync(path.join(dir, 'bed.json'), JSON.stringify({ pid: process.pid, from: ROOT, started: new Date().toISOString() }) + '\n');
  spawn(process.execPath, [__filename, '--reap'], {
    env: Object.assign({}, process.env, { BED_REAP_DIR: dir, BED_REAP_PID: String(process.pid) }), detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();

  debug('folder ready');
  await startRelay(bed);
  debug('relay ready');
  require(path.join(ROOT, 'extension', 'build.js')).build({ out: bed.dist, port: bed.port });
  debug('extension built');
  await Promise.all(chosen.map((b) => startBrowser(b, bed)));

  // The relay names a browser after its kind (chromium, edge, chrome, firefox).
  const kinds = chosen.map((b) => b.kind);
  const twice = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (twice) throw new Error(`two of the chosen browsers are both "${twice}" to the relay; choose different browsers`);
  for (let i = 0; ; i++) {
    const ids = (await rpc(bed, 'status')).browsers.map((x) => x.id);
    for (const b of chosen) if (ids.includes(b.kind)) b.id = b.kind;
    if (chosen.every((b) => b.id)) break;
    if (i > 300) throw new Error('not connected to the relay after 30 s: ' + chosen.filter((b) => !b.id).map((b) => b.name).join(', '));
    await sleep(100);
  }
  const mode = opts.headed ? 'headed' : 'headless';
  say(`ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: own relay on 127.0.0.1:${bed.port}; ` +
    chosen.map((b) => `${b.name} ${b.version} (${mode})`).join(', ') + (opts.only ? `; only ${opts.only}` : ''));

  const results = await Promise.all(chosen.map((b) => runE2e(b, bed)));
  for (const r of results) {
    say(`${r.name}: ${r.pass}/${r.pass + r.fail} passed in ${r.seconds.toFixed(1)} s` + (r.ok ? '' : r.timedOut ? '  TIMED OUT' : '  FAILED'));
    r.why = r.timedOut ? `timed out after ${r.pass + r.fail} checks` : r.fail ? `${r.fail} of ${r.pass + r.fail} failed` : `no result, exit code ${r.code}`;
  }
  const bad = results.filter((r) => !r.ok);
  if (results.some((r) => r.noMemory)) say('note: a test process ran out of memory. Close other programs, or test fewer browsers at the same moment.');
  const checks = results.reduce((n, r) => n + r.pass + r.fail, 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const line = bad.length
    ? `RESULT: FAILED on ${bad.map((r) => `${r.name} (${r.why})`).join(', ')}` +
      (bad.length < results.length ? '; passed on ' + results.filter((r) => r.ok).map((r) => r.name).join(', ') : '') + `; ${secs} s`
    : `RESULT: all checks passed on ${results.map((r) => r.name).join(', ')} (${checks} checks, ${secs} s)`;
  console.log(line);

  if (opts.keep) {
    const e = (cmd) => `BROWSER_MCP_PORT=${bed.port} BROWSER_MCP_HOME="${home}" ${cmd}`;
    say('kept running. In another terminal:');
    for (const b of chosen) say('  run checks again:  ' + e((b.name === 'firefox' && opts.containers ? 'E2E_CONTAINERS=sim ' : '') + `E2E_ONLY=<group> node test/e2e.js ${b.id}`));
    say('  call one tool:     ' + e("node test/call.js tabs '{\"action\":\"list\"}'"));
    say(`  (PowerShell: $env:BROWSER_MCP_PORT='${bed.port}'; $env:BROWSER_MCP_HOME='${home}'; then the node command)`);
    say(`  stop everything:   node test/bed.js --stop "${dir}"   (or press Ctrl+C here)`);
    await waitForStop(dir);
    say('stopping');
  }
  teardown();
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[2] === '--reap') {
  reap();
} else {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => { say('interrupted (' + sig + '): cleaning up'); teardown(); process.exit(130); });
  }
  const crash = (e) => { console.error('[bed] error: ' + ((e && e.stack) || e)); teardown(); process.exit(1); };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  process.on('exit', teardown);
  main().catch((e) => {
    console.error('[bed] error: ' + ((e && e.message) || e));
    if (bed && bed.home) {
      const log = tail(path.join(bed.home, 'relay.log'), 8);
      if (log) console.error('[bed] the relay log ends with:\n' + log);
    }
    teardown();
    process.exit(1);
  });
}
