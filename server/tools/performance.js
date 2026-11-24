'use strict';
const fs = require('fs');
const path = require('path');
const { TAB } = require('../tool-modules');

const tools = [{
  name: 'performance',
  description: 'Inspect page performance, record a Chromium performance trace, or record a short visual sequence. actions: metrics, trace_start, trace_stop, record_start, record_stop.',
  inputSchema: { type: 'object', properties: {
    tab: TAB, action: { type: 'string', enum: ['metrics', 'trace_start', 'trace_stop', 'record_start', 'record_stop'] },
    interval_ms: { type: 'number', description: 'record_start: milliseconds between frames, 250 to 5000. Default 1000.' },
    max_frames: { type: 'number', description: 'record_start: 1 to 60. Default 20.' }, timeout_ms: { type: 'number' },
  }, required: ['tab'] },
}];

function safeName(prefix, ext, h) {
  fs.mkdirSync(h.C.OUTPUT_DIR, { recursive: true });
  return path.join(h.C.OUTPUT_DIR, `${prefix}-${Date.now()}${ext}`);
}

async function run(name, a, h) {
  const action = a.action || 'metrics';
  const { result: r } = await h.send('performance', { tab: a.tab, action, interval_ms: a.interval_ms, max_frames: a.max_frames, timeout_ms: a.timeout_ms }, { waitMs: a.timeout_ms });
  if (action === 'metrics') {
    const lines = [`url: ${r.url}`, `navigation: ${Math.round(r.navigation_ms || 0)} ms`, `DOM content loaded: ${Math.round(r.dom_ms || 0)} ms`, `load: ${Math.round(r.load_ms || 0)} ms`];
    if (r.fcp != null) lines.push(`first contentful paint: ${Math.round(r.fcp)} ms`);
    if (r.lcp != null) lines.push(`largest contentful paint: ${Math.round(r.lcp)} ms`);
    if (r.cls != null) lines.push(`layout shift: ${Number(r.cls).toFixed(3)}`);
    if (r.resources != null) lines.push(`resources: ${r.resources}`);
    if (r.heap != null) lines.push(`JavaScript heap: ${(r.heap / 1024 / 1024).toFixed(1)} MB`);
    return h.text(lines.join('\n'));
  }
  if (action === 'trace_start') return h.text(`performance trace started in ${a.tab}\nnote: call performance with action trace_stop when the activity is finished`);
  if (action === 'record_start') return h.text(`visual recording started in ${a.tab}: one frame every ${r.interval_ms} ms, at most ${r.max_frames}\nnote: call performance with action record_stop when finished`);
  if (action === 'trace_stop') {
    const file = safeName('trace', '.json', h);
    const data = Buffer.from(r.data || '', 'base64');
    fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
    return h.text(`saved: ${file} (${Math.max(1, Math.round(data.length / 1024))} KB)\nevents: ${r.events == null ? 'unknown' : r.events}\nnote: open this file in the Chrome or Edge DevTools Performance panel`);
  }
  const folder = safeName('recording', '', h);
  fs.mkdirSync(folder, { recursive: false, mode: 0o700 });
  for (let i = 0; i < r.frames.length; i++) {
    const m = /^data:image\/jpeg;base64,(.+)$/s.exec(r.frames[i].dataUrl || '');
    if (m) fs.writeFileSync(path.join(folder, `frame-${String(i + 1).padStart(3, '0')}.jpg`), Buffer.from(m[1], 'base64'), { mode: 0o600 });
  }
  const delay = Math.max(100, r.interval_ms || 1000);
  const html = `<!doctype html><meta charset="utf-8"><title>browzat recording</title><style>html,body{margin:0;background:#111;color:#eee;font:14px sans-serif}img{display:block;max-width:100vw;max-height:calc(100vh - 40px);margin:auto}p{text-align:center}</style><img id="f"><p id="s"></p><script>const n=${r.frames.length},d=${delay};let i=0;function go(){f.src='frame-'+String(i+1).padStart(3,'0')+'.jpg';s.textContent=(i+1)+' / '+n;i=(i+1)%n}go();setInterval(go,d)</script>`;
  const player = path.join(folder, 'index.html');
  fs.writeFileSync(player, html, { mode: 0o600 });
  return h.text(`saved: ${player}\nframes: ${r.frames.length}\nduration: ${((r.duration_ms || 0) / 1000).toFixed(1)} s`);
}

module.exports = { tools, run };
