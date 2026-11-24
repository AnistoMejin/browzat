'use strict';
// Test helper: starts the installed Firefox with a throwaway profile, installs the unpacked extension
// temporarily over WebDriver BiDi and opens a start URL. Stays running until killed.
//   node test/launch-firefox.js <profileDir> <extensionDir> [startUrl]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const [profile, extDir, startUrl] = process.argv.slice(2);
// No fixed port: with port 0 Firefox picks a free one and writes it to WebDriverBiDiServer.json in the profile.
// BIDI_PORT=<n> asks for a certain port.
const WANT_PORT = Number(process.env.BIDI_PORT) || 0;
const portFile = path.join(profile, 'WebDriverBiDiServer.json');
fs.mkdirSync(profile, { recursive: true });
try { fs.unlinkSync(portFile); } catch (e) {} // left by an earlier run with this profile

const ff = spawn(FIREFOX, ['--profile', profile, '--no-remote', '--remote-debugging-port', String(WANT_PORT), 'about:blank'], { stdio: 'ignore' });
ff.on('exit', (c) => { console.log('firefox exited ' + c); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    let port = WANT_PORT;
    if (!port) { try { port = JSON.parse(fs.readFileSync(portFile, 'utf8')).ws_port; } catch (e) {} }
    if (!port) { reject(new Error('not ready')); return; }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('not ready'));
  });
}

(async () => {
  let ws = null;
  for (let i = 0; i < 80 && !ws; i++) { try { ws = await open(); } catch (e) { await sleep(500); } }
  if (!ws) { console.log('LAUNCH FAILED: BiDi endpoint did not open'); process.exit(1); }

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const cmd = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.type === 'error' ? reject(new Error(method + ': ' + m.error + ' ' + m.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  try {
    await cmd('session.new', { capabilities: {} });
    const inst = await cmd('webExtension.install', { extensionData: { type: 'path', path: extDir } });
    console.log('extension installed: ' + inst.extension);
    if (process.env.EXTRA_EXT) {
      const extra = await cmd('webExtension.install', { extensionData: { type: 'path', path: process.env.EXTRA_EXT } });
      console.log('extra extension installed: ' + extra.extension);
    }
    if (startUrl) {
      await sleep(1500);
      const tree = await cmd('browsingContext.getTree', {});
      await cmd('browsingContext.navigate', { context: tree.contexts[0].context, url: startUrl, wait: 'none' });
      console.log('opened start url');
    }
    console.log('FIREFOX READY');
  } catch (e) {
    console.log('LAUNCH FAILED: ' + e.message);
  }
})();
