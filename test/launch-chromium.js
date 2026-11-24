'use strict';
// Test helper: starts a Chromium-family browser with a throwaway profile and the unpacked extension,
// reports the state of the extension's service worker over the DevTools protocol, then opens a start URL.
//   node test/launch-chromium.js <browserExe> <profileDir> <extensionDir> [startUrl]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [exe, profile, extDir, startUrl] = process.argv.slice(2);
// No fixed port: with port 0 the browser picks a free one and writes it to DevToolsActivePort in the profile.
// CDP_PORT=<n> asks for a certain port.
const WANT_PORT = Number(process.env.CDP_PORT) || 0;
const portFile = path.join(profile, 'DevToolsActivePort');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(profile, { recursive: true });
try { fs.unlinkSync(portFile); } catch (e) {} // left by an earlier run with this profile

function debugPort() {
  if (WANT_PORT) return WANT_PORT;
  try { return Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch (e) { return 0; }
}

const child = spawn(exe, [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--load-extension=${extDir}`,
  `--remote-debugging-port=${WANT_PORT}`,
  // Extra flags, for example CHROME_EXTRA_ARGS=--no-sandbox for a test build on Ubuntu 23.10+, where AppArmor
  // blocks the sandbox of browsers that are not installed as system packages. Throwaway test profiles only.
  ...String(process.env.CHROME_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
  'about:blank',
], { stdio: 'ignore' });
child.on('exit', (c) => { console.log('browser exited ' + c); process.exit(0); });

async function targets() {
  const port = debugPort();
  if (!port) return null;
  try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { return null; }
}

function evalIn(wsUrl, expression) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve('eval timeout'); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(t);
      ws.close();
      const r = m.result || {};
      resolve(r.exceptionDetails ? 'EXCEPTION ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text) : r.result && r.result.value);
    };
    ws.onerror = () => { clearTimeout(t); resolve('cannot connect to the worker'); };
  });
}

const PROBE = "JSON.stringify({ linkState: typeof linkState === 'undefined' ? 'core.js not loaded' : linkState, kind: typeof detectKind === 'function' ? detectKind() : '?' })";

async function worker() {
  const list = (await targets()) || [];
  return list.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/.*\/sw\.js$/.test(t.url));
}

(async () => {
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { up = await targets(); if (!up) await sleep(500); }
  if (!up) { console.log('LAUNCH FAILED: DevTools endpoint did not open'); return; }

  let sw = null;
  for (let i = 0; i < 30 && !sw; i++) { sw = await worker(); if (!sw) await sleep(500); }
  if (!sw) {
    console.log('NO EXTENSION WORKER: the extension did not load. Targets: ' + JSON.stringify(((await targets()) || []).map((t) => t.type + ' ' + t.url)));
    return;
  }
  console.log('worker: ' + sw.url);
  console.log('before pairing: ' + (await evalIn(sw.webSocketDebuggerUrl, PROBE)));

  if (startUrl) {
    await fetch(`http://127.0.0.1:${debugPort()}/json/new?${encodeURIComponent(startUrl)}`, { method: 'PUT' });
    console.log('opened start url');
    await sleep(5000);
    sw = (await worker()) || sw;
    console.log('after pairing: ' + (await evalIn(sw.webSocketDebuggerUrl, PROBE)));
  }
  console.log('CHROMIUM READY');
})();
