'use strict';
// Quick checks that need no browser: every .js file parses, every JSON file parses, the extension builds,
// the built manifests carry the package version, and the feature modules fit together (tool modules load and their
// tool names are unique, the background scripts share one scope without a clash, the test sections are well formed).
// Used by `npm run check` and by CI.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// Not checked: dependencies, build output, and folders whose name starts with a dot: .git, and tool folders such as
// .claude, where git worktrees of this repository live (each worktree is checked by its own run). .github stays in.
const skip = new Set(['node_modules', 'dist']);
let failed = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    if (e.isDirectory() && e.name.startsWith('.') && e.name !== '.github') continue;
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
for (const f of files.filter((f) => /\.(js|json|md|html|ps1|sh|yml)$/.test(f))) {
  // A UTF-8 byte-order mark (Windows PowerShell 5.1 adds one) breaks npm and shell scripts.
  const b = fs.readFileSync(f);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) check(`no BOM  ${rel(f)}`, () => { throw new Error('file starts with a UTF-8 BOM'); });
}
for (const f of files.filter((f) => f.endsWith('.json'))) {
  check(`json    ${rel(f)}`, () => JSON.parse(fs.readFileSync(f, 'utf8')));
}

// URL patterns used by network_requests filters and network_route: substring, glob with *, or /regex/flags.
check('unit    URL patterns (network filter and routes)', () => {
  const core = fs.readFileSync(path.join(root, 'extension', 'src', 'core.js'), 'utf8');
  const fn = /function patternRe\(p\) \{[\s\S]*?\n\}/.exec(core);
  if (!fn) throw new Error('patternRe not found in core.js');
  const patternRe = new Function(fn[0] + '; return patternRe;')();
  const cases = [
    ['/api/data', 'http://x/api/data', true], ['/api/data', 'http://x/api/fail', false], ['*/api/data', 'http://x/api/data', true],
    ['*/api/data', 'http://x/api/data?x=1', false], ['/data\\?id=\\d+/', 'http://x/data?id=5', true], ['/API/i', 'http://x/api/z', true],
    ['example.com', 'https://example.com/a', true], ['example.com', 'https://exampleXcom/a', false],
  ];
  const wrong = cases.filter(([p, u, want]) => patternRe(p).test(u) !== want).map(([p, u]) => p + ' vs ' + u);
  if (wrong.length) throw new Error('wrong result for ' + wrong.join('; '));
});

const version = require(path.join(root, 'package.json')).version;
check('build   extension/build.js', () => execFileSync(process.execPath, [path.join(root, 'extension', 'build.js')], { stdio: 'pipe' }));
for (const target of ['chromium', 'firefox']) {
  check(`version dist/${target}/manifest.json = ${version}`, () => {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'dist', target, 'manifest.json'), 'utf8'));
    if (m.version !== version) throw new Error(`manifest has ${m.version}`);
  });
}

// ---- feature modules ----

// The background scripts of the extension: page.js, core.js, then every extension/src/feat-*.js in name order.
const scripts = require(path.join(root, 'extension', 'build.js')).backgroundScripts();
check(`build   load order: ${scripts.join(', ')}`, () => {
  const same = (got, where) => {
    if (JSON.stringify(got) !== JSON.stringify(scripts)) throw new Error(`${where} loads ${got.join(', ')}`);
  };
  const sw = fs.readFileSync(path.join(root, 'dist', 'chromium', 'sw.js'), 'utf8');
  same([...(/importScripts\(([^)]*)\)/.exec(sw) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), 'dist/chromium/sw.js');
  same(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'firefox', 'manifest.json'), 'utf8')).background.scripts, 'dist/firefox/manifest.json');
  for (const target of ['chromium', 'firefox']) {
    for (const f of scripts) if (!fs.existsSync(path.join(root, 'dist', target, f))) throw new Error(`dist/${target}/${f} is missing`);
  }
});

// They all run in one scope (the service worker, or the Firefox background page). There a name declared twice with
// const, let or class stops the extension from loading, and a function declared twice silently replaces the first.
check('scope   background scripts declare no top-level name twice', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'extension', 'src', f), 'utf8');
  try {
    new vm.Script(scripts.map(read).join('\n;\n'), { filename: 'the background scripts loaded together' });
  } catch (e) {
    throw new Error(e.message + ' (in ' + scripts.join(' + ') + ' loaded together; wrap a feature file in a function or rename)');
  }
  const seen = new Map();
  for (const f of scripts) {
    for (const m of read(f).matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== f) throw new Error(`function ${m[1]} is declared in ${seen.get(m[1])} and in ${f}`);
      seen.set(m[1], f);
    }
  }
});

// MCP server: every server/tools/*.js loads, and no tool name is used twice (built-in tools included).
check('tools   server/tools modules load and tool names are unique', () => {
  const mcp = require(path.join(root, 'server', 'mcp.js')); // only hands out its tool list when loaded with require()
  if (mcp.startError) throw mcp.startError;
  const names = mcp.TOOLS.map((t) => t.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`the tool name "${twice}" is used twice`);
  if (mcp.TOOLS.length < mcp.BUILTIN_TOOLS.length || mcp.BUILTIN_TOOLS.some((t, i) => mcp.TOOLS[i] !== t)) throw new Error('the built-in tools must come first, unchanged');
});

// End-to-end sections: test/e2e/<nn>-<group>.js, one group per file, each exporting a function.
check('e2e     test/e2e sections are well formed', () => {
  const dir = path.join(root, 'test', 'e2e');
  const groups = new Map();
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_')).sort() : []) {
    const m = /^(\d+)-([a-z0-9][a-z0-9-]*)\.js$/.exec(f);
    if (!m) throw new Error(`test/e2e/${f}: name it <nn>-<group>.js (helper files start with _)`);
    if (m[2] === 'core') throw new Error(`test/e2e/${f}: "core" is the name of the built-in checks`);
    if (groups.has(m[2])) throw new Error(`test/e2e/${f}: the group "${m[2]}" is already used by ${groups.get(m[2])}`);
    groups.set(m[2], f);
    if (typeof require(path.join(dir, f)) !== 'function') throw new Error(`test/e2e/${f}: must export async (t) => { ... }`);
  }
});

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
