'use strict';
// Builds dist/chromium (MV3, for Chrome and Edge) and dist/firefox (MV2) from the shared sources.
//
// Feature modules: every src/feat-*.js is a background script, loaded after page.js and core.js in file-name order.
// The service-worker entry (sw.js) and the Firefox background list are generated here, so adding a feature file needs
// no edit to a shared file. Manifest entries a feature needs (a permission, for example) go in src/feat-<name>.json:
//   { "all": { "permissions": ["downloads"] }, "chromium": { "permissions": ["cookies"] }, "firefox": { ... } }
// Only items of manifest lists can be added, and each item is added once.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(__dirname, 'src');
const version = require(path.join(root, 'package.json')).version;
const BACKGROUND = ['page.js', 'core.js'];

function featFiles() {
  return fs.readdirSync(src).filter((f) => /^feat-.+\.js$/.test(f)).sort();
}

// The background scripts in load order: the same list for the service worker and for the Firefox background page.
function backgroundScripts() {
  return BACKGROUND.concat(featFiles());
}

function addToManifest(manifest, extra, from) {
  for (const [key, list] of Object.entries(extra || {})) {
    if (!Array.isArray(list) || (key in manifest && !Array.isArray(manifest[key]))) {
      throw new Error(`${from}: "${key}" is not a list; a feature file can only add items to manifest lists such as permissions`);
    }
    const have = manifest[key] || (manifest[key] = []);
    const seen = new Set(have.map((x) => JSON.stringify(x)));
    for (const item of list) {
      const k = JSON.stringify(item);
      if (!seen.has(k)) { seen.add(k); have.push(item); }
    }
  }
}

// opts.out   folder that receives chromium/ and firefox/ (default: <repository>/dist)
// opts.port  tests only: the relay port this build uses instead of the default, so that throwaway browsers pair with
//            an isolated relay and can never reach the real one (test/bed.js)
// opts.log   called with one line per built folder
function build(opts) {
  opts = opts || {};
  const outRoot = opts.out || path.join(root, 'dist');
  const scripts = backgroundScripts();
  const fragments = fs.readdirSync(src).filter((f) => /^feat-.+\.json$/.test(f)).sort();
  for (const target of ['chromium', 'firefox']) {
    const out = path.join(outRoot, target);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (f === 'sw.js' || fragments.includes(f)) continue;
      fs.copyFileSync(path.join(src, f), path.join(out, f));
    }
    // Toolbar and extension-page icons (made by assets/make-icons.py).
    fs.cpSync(path.join(__dirname, 'icons'), path.join(out, 'icons'), { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, `manifest.${target}.json`), 'utf8'));
    manifest.version = version;
    if (target === 'chromium') {
      fs.writeFileSync(path.join(out, 'sw.js'), '// Chromium MV3 service worker entry point.\n' +
        `importScripts(${scripts.map((f) => `'${f}'`).join(', ')});\n`);
    } else {
      manifest.background.scripts = scripts;
    }
    for (const f of fragments) {
      const extra = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
      const unknown = Object.keys(extra).filter((k) => !['all', 'chromium', 'firefox'].includes(k));
      if (unknown.length) throw new Error(`extension/src/${f}: unknown key "${unknown[0]}" (use all, chromium, firefox)`);
      addToManifest(manifest, extra.all, `extension/src/${f}`);
      addToManifest(manifest, extra[target], `extension/src/${f}`);
    }
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (opts.port) {
      const file = path.join(out, 'core.js');
      const code = fs.readFileSync(file, 'utf8');
      const line = /^const DEFAULT_PORT = \d+;/m;
      if (!line.test(code)) throw new Error('extension/src/core.js: the DEFAULT_PORT line was not found');
      fs.writeFileSync(file, code.replace(line, `const DEFAULT_PORT = ${Number(opts.port)};`));
    }
    if (opts.log) opts.log(`built ${out}`);
  }
  return { out: outRoot, scripts };
}

if (require.main === module) build({ log: console.log });

module.exports = { build, backgroundScripts, featFiles };
