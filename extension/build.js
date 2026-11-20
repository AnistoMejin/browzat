'use strict';
// Builds dist/chromium (MV3, for Chrome and Edge) and dist/firefox (MV2) from the shared sources.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(__dirname, 'src');
const version = require(path.join(root, 'package.json')).version;

for (const target of ['chromium', 'firefox']) {
  const out = path.join(root, 'dist', target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (target === 'firefox' && f === 'sw.js') continue;
    fs.copyFileSync(path.join(src, f), path.join(out, f));
  }
  // Toolbar and extension-page icons (made by assets/make-icons.py).
  fs.cpSync(path.join(__dirname, 'icons'), path.join(out, 'icons'), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, `manifest.${target}.json`), 'utf8'));
  manifest.version = version;
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`built ${out}`);
}
