'use strict';
// Test helper for Google Chrome, which ignores --load-extension: starts Chrome with a throwaway profile and
// loads the unpacked extension through the DevTools pipe, then opens a start URL. Chrome closes when this exits.
//   node test/launch-chrome-pipe.js <chromeExe> <profileDir> <extensionDir> [startUrl]
const { spawn } = require('child_process');

const [exe, profile, extDir, startUrl] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
child.on('exit', (c) => { console.log('browser exited ' + c); process.exit(0); });

const toBrowser = child.stdio[3];
const fromBrowser = child.stdio[4];
let buf = '';
let id = 0;
const pending = new Map();
fromBrowser.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const cmd = (method, params) => new Promise((resolve, reject) => {
  const n = ++id;
  const t = setTimeout(() => reject(new Error(method + ': no answer')), 15000);
  pending.set(n, (m) => { clearTimeout(t); m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result); });
  toBrowser.write(JSON.stringify({ id: n, method, params }) + '\0');
});

(async () => {
  try {
    const v = await cmd('Browser.getVersion', {});
    console.log('browser: ' + v.product);
    const ext = await cmd('Extensions.loadUnpacked', { path: extDir });
    console.log('extension loaded: ' + ext.id);
    if (startUrl) {
      await sleep(2500);
      await cmd('Target.createTarget', { url: startUrl });
      console.log('opened start url');
    }
    console.log('CHROME READY');
  } catch (e) {
    console.log('LAUNCH FAILED: ' + e.message);
  }
})();
