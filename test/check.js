'use strict';
// Quick checks that need no browser: every .js file parses, every JSON file parses, the extension builds,
// and the built manifests carry the package version. Used by `npm run check` and by CI.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const skip = new Set(['.git', 'node_modules', 'dist']);
let failed = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function check(label, fn) {
  try {
    fn();
    console.log(`ok    ${label}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${label}\n      ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
}

const files = walk(root);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

for (const f of files.filter((f) => f.endsWith('.js'))) {
  check(`syntax  ${rel(f)}`, () => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }));
}
for (const f of files.filter((f) => f.endsWith('.json'))) {
  check(`json    ${rel(f)}`, () => JSON.parse(fs.readFileSync(f, 'utf8')));
}

const version = require(path.join(root, 'package.json')).version;
check('build   extension/build.js', () => execFileSync(process.execPath, [path.join(root, 'extension', 'build.js')], { stdio: 'pipe' }));
for (const target of ['chromium', 'firefox']) {
  check(`version dist/${target}/manifest.json = ${version}`, () => {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'dist', target, 'manifest.json'), 'utf8'));
    if (m.version !== version) throw new Error(`manifest has ${m.version}`);
  });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
