'use strict';
// Test helper: starts the installed Firefox with a throwaway profile, installs the unpacked extension
// temporarily over WebDriver BiDi and opens a start URL. Stays running until killed.
//   node test/launch-firefox.js <profileDir> <extensionDir> [startUrl]
const { spawn } = require('child_process');
const fs = require('fs');

const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const [profile, extDir, startUrl] = process.argv.slice(2);
const PORT = 9334;
fs.mkdirSync(profile, { recursive: true });

const ff = spawn(FIREFOX, ['--profile', profile, '--no-remote', '--remote-debugging-port', String(PORT), 'about:blank'], { stdio: 'ignore' });
ff.on('exit', (c) => { console.log('firefox exited ' + c); process.exit(0); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
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
