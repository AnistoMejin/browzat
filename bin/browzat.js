#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);

function run(command, commandArgs, cwd) {
  const r = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', windowsHide: true, shell: false });
  if (r.error) throw r.error;
  if (r.status) process.exit(r.status);
}

if (args[0] !== 'install') {
  run(process.execPath, [path.join(root, 'server', 'cli.js'), ...args], process.cwd());
  process.exit(0);
}

const at = args.indexOf('--dir');
const target = path.resolve(at >= 0 && args[at + 1] ? args[at + 1] : path.join(os.homedir(), '.mcp-servers', 'browser-mcp'));
if (target === path.parse(target).root || target === os.homedir()) throw new Error('refusing to install into a filesystem root or the home folder');
fs.mkdirSync(target, { recursive: true });
for (const name of ['server', 'extension', 'assets', 'bin']) fs.cpSync(path.join(root, name), path.join(target, name), { recursive: true, force: true });
for (const name of ['package.json', 'package-lock.json', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'install.ps1', 'install.sh']) {
  const source = path.join(root, name); if (fs.existsSync(source)) fs.copyFileSync(source, path.join(target, name));
}
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts'], target);
run(process.execPath, [path.join(target, 'extension', 'build.js')], target);
console.log(`browzat installed in ${target}`);
console.log(`MCP command: ${process.execPath} ${path.join(target, 'server', 'mcp.js')}`);
console.log(`Load the extension once from ${path.join(target, 'dist', 'chromium')} or ${path.join(target, 'dist', 'firefox', 'manifest.json')}`);
