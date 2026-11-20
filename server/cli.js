'use strict';
// node server/cli.js start | status | pair [--open firefox,edge,chrome] [--profile "Profile 1"] [--wait 120] [--count N]
//                    | reload [browser|all] | stop | copy-token
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./common');

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, def) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : def;
};

const WINDOWS_NAMES = { firefox: 'firefox', chrome: 'chrome', edge: 'msedge' };
const LINUX_NAMES = {
  firefox: ['firefox', 'firefox-esr'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable'],
};

function onPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  }
  return null;
}

// Opens the pairing page in a named browser. --profile picks a Chrome or Edge profile folder such as "Profile 1".
function openIn(browser, url, profile) {
  const extra = profile && browser !== 'firefox' ? ['--profile-directory=' + profile] : [];
  if (process.platform === 'win32') {
    const exe = WINDOWS_NAMES[browser];
    if (!exe) return console.log(`cannot open "${browser}" (use firefox, edge or chrome)`);
    spawn('cmd', ['/c', 'start', '', exe, ...extra, url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'linux') {
    if (!LINUX_NAMES[browser]) return console.log(`cannot open "${browser}" (use firefox, edge or chrome)`);
    const exe = onPath(LINUX_NAMES[browser]);
    if (!exe) return console.log(`${browser} was not found on PATH; open the link in it yourself`);
    spawn(exe, [...extra, url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    return console.log(`opening a browser is not supported on ${process.platform}; open the link in ${browser} yourself`);
  }
  console.log(`opened the pairing page in ${browser}${extra.length ? ' (' + profile + ')' : ''}`);
}

function copyToClipboard(text) {
  if (process.platform === 'win32') return execFileSync('clip', { input: text });
  for (const [bin, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]) {
    if (onPath([bin])) return execFileSync(bin, args, { input: text });
  }
  throw new Error('no clipboard tool found; install wl-clipboard, xclip or xsel');
}

async function printStatus() {
  const s = await C.rpc('status');
  console.log(`relay ${s.version} on 127.0.0.1:${s.port}, pid ${s.pid}, up ${s.uptimeSec} s`);
  if (!s.browsers.length) console.log('browsers: none connected');
  for (const b of s.browsers) console.log(`browser: ${b.id}  (${b.kind}, extension ${b.extension || '?'}, connected ${b.connectedSec} s)`);
}

(async () => {
  if (cmd === 'start') {
    await C.ensureRelay();
    return printStatus();
  }
  if (cmd === 'status') {
    if (!(await C.health())) return console.log('relay: not running (it starts with the next MCP session, `start` or `pair`)');
    return printStatus();
  }
  if (cmd === 'pair') {
    await C.ensureRelay();
    const p = await C.rpc('pair_start');
    console.log('Pairing link (valid 10 minutes, usable in every browser that has the extension):');
    console.log(p.url);
    const open = opt('open');
    if (open) for (const b of open.split(',')) openIn(b.trim().toLowerCase(), p.url, opt('profile'));
    const waitSec = Number(opt('wait', '120'));
    const want = Number(opt('count', open ? String(open.split(',').length) : '0'));
    const seen = new Set();
    const end = Date.now() + waitSec * 1000;
    while (Date.now() < end) {
      const st = await C.rpc('pair_status', { code: p.code });
      for (const r of st.redeemed) {
        const key = r.kind + '@' + r.at;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(`paired: ${r.kind}${r.name ? ' (' + r.name + ')' : ''}`);
        }
      }
      if (want && seen.size >= want) break;
      await C.sleep(1000);
    }
    if (waitSec > 0 && !seen.size) console.log('no browser paired within the wait time');
    return;
  }
  if (cmd === 'stop') {
    if (!(await C.health())) return console.log('relay: not running');
    await C.rpc('shutdown', {}, 3000);
    return console.log('relay stopped');
  }
  if (cmd === 'reload') {
    // Makes the extension reload itself from disk (after a rebuild) in one browser or in all connected ones.
    if (!(await C.health())) return console.log('relay: not running');
    const s = await C.rpc('status');
    const targets = rest[0] && rest[0] !== 'all' ? [rest[0]] : s.browsers.map((b) => b.id);
    if (!targets.length) return console.log('no browser is connected');
    for (const b of targets) {
      try {
        await C.rpc('call', { browser: b, tool: '_reload', args: {}, timeoutMs: 5000 }, 15000);
        console.log(`${b}: reloading the extension`);
      } catch (e) {
        console.log(`${b}: ${e.message}`);
      }
    }
    return;
  }
  if (cmd === 'copy-token') {
    await C.ensureRelay();
    copyToClipboard(C.readToken());
    return console.log('token copied to the clipboard (not shown); paste it into the extension popup');
  }
  console.log('usage: node server/cli.js start | status | pair [--open firefox,edge,chrome] [--profile "Profile 1"] [--wait 120] [--count N] | reload [browser|all] | stop | copy-token');
})().catch((e) => {
  console.error('error: ' + ((e && e.message) || e));
  process.exit(1);
});
