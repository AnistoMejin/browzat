'use strict';
// Builds store-ready unsigned extension archives with no external zip dependency.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { build } = require('../extension/build');
const pkg = require('../package.json');
const root = path.join(__dirname, '..');
const release = process.env.BROWSER_MCP_RELEASE_DIR || path.join(root, 'release');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data) { let c = 0xffffffff; for (const b of data) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function files(dir, base) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name), base) : [{ file: path.join(dir, e.name), name: path.relative(base, path.join(dir, e.name)).replace(/\\/g, '/') }]); }
function zip(dir, output) {
  const local = []; const central = []; let offset = 0;
  for (const item of files(dir, dir)) {
    const name = Buffer.from(item.name); const data = fs.readFileSync(item.file); const crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x800, 8); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, name); offset += head.length + name.length + data.length;
  }
  const center = Buffer.concat(central); const end = Buffer.alloc(22); const count = central.length / 2;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(output, Buffer.concat([...local, center, end]));
}

fs.rmSync(release, { recursive: true, force: true }); fs.mkdirSync(release, { recursive: true });
build();
const chromium = path.join(release, `browzat-${pkg.version}-chromium.zip`);
const firefox = path.join(release, `browzat-${pkg.version}-firefox.zip`);
zip(path.join(root, 'dist', 'chromium'), chromium); zip(path.join(root, 'dist', 'firefox'), firefox);
const sums = [chromium, firefox].map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(path.join(release, 'sha256sums.txt'), sums);
console.log(`built ${path.relative(root, chromium)}`); console.log(`built ${path.relative(root, firefox)}`); console.log('built release/sha256sums.txt');
