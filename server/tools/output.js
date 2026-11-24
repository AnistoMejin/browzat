'use strict';
// Page output and environment emulation. Screenshot remains a built-in tool for backward-compatible ordering.
const fs = require('fs');
const path = require('path');
const { TAB } = require('../tool-modules');

const PAPERS = ['a4', 'letter', 'legal', 'a3', 'a5', 'tabloid'];

function targetFile(value, extensions, h, prefix) {
  let file;
  if (value) {
    file = path.isAbsolute(value) ? path.resolve(value) : path.join(h.C.OUTPUT_DIR, value);
    if (!extensions.includes(path.extname(file).toLowerCase())) throw new Error(`path must end with ${extensions.join(' or ')}`);
  } else {
    file = path.join(h.C.OUTPUT_DIR, `${prefix}-${Date.now()}${extensions[0]}`);
  }
  if (fs.existsSync(file)) throw new Error('the output file already exists; choose a new path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function sizeText(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function emulateArgs(a) {
  const out = { reset: !!a.reset };
  if (a.device != null) {
    if (!['iphone', 'android', 'ipad'].includes(a.device)) throw new Error('device must be iphone, android or ipad');
    out.device = a.device;
  }
  const viewport = {};
  for (const key of ['width', 'height']) if (a[key] != null) {
    const n = Math.round(Number(a[key]));
    if (!Number.isFinite(n) || n < 200 || n > 7680) throw new Error('width and height must be whole numbers from 200 to 7680');
    viewport[key] = n;
  }
  if (a.pixel_ratio != null) {
    const n = Number(a.pixel_ratio);
    if (!Number.isFinite(n) || n < 0.5 || n > 5) throw new Error('pixel_ratio must be a number from 0.5 to 5');
    viewport.ratio = n;
  }
  for (const key of ['mobile', 'touch', 'landscape']) if (a[key] != null) viewport[key] = !!a[key];
  if (Object.keys(viewport).length) out.viewport = viewport;
  if (a.user_agent != null) {
    const s = String(a.user_agent);
    if (!s || s.length > 500 || /[\r\n]/.test(s)) throw new Error('user_agent must be 1 to 500 characters on one line (reset: true removes overrides)');
    out.user_agent = s;
  }
  if (a.locale != null) {
    try { out.locale = Intl.getCanonicalLocales(String(a.locale))[0]; } catch (e) { throw new Error('locale must be a language tag such as en-GB or fr-FR'); }
  }
  if (a.timezone != null) {
    const s = String(a.timezone).trim();
    try { new Intl.DateTimeFormat('en', { timeZone: s }).format(); } catch (e) { throw new Error(`unknown time zone ${JSON.stringify(s)}; use an IANA name such as Asia/Kolkata or Europe/Berlin`); }
    out.timezone = s;
  }
  if (a.latitude != null || a.longitude != null || a.accuracy != null) {
    if (a.latitude == null || a.longitude == null) throw new Error('latitude and longitude are needed together');
    const latitude = Number(a.latitude); const longitude = Number(a.longitude); const accuracy = a.accuracy == null ? 50 : Number(a.accuracy);
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('latitude must be from -90 to 90 and longitude from -180 to 180');
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) throw new Error('accuracy must be from 0 to 100000 metres');
    out.geo = { latitude, longitude, accuracy };
  }
  const media = {};
  const enums = { color_scheme: ['light', 'dark'], reduced_motion: ['reduce', 'no-preference'], forced_colors: ['active', 'none'], contrast: ['more', 'less', 'no-preference'], media: ['print', 'screen'] };
  const map = { color_scheme: 'scheme', reduced_motion: 'motion', forced_colors: 'forced', contrast: 'contrast', media: 'type' };
  for (const [key, values] of Object.entries(enums)) if (a[key] != null) {
    if (!values.includes(a[key])) throw new Error(`${key} must be one of: ${values.join(', ')}`);
    media[map[key]] = a[key];
  }
  if (Object.keys(media).length) out.media = media;
  if (a.cpu != null) {
    const n = Number(a.cpu);
    if (!Number.isFinite(n) || n < 1 || n > 20) throw new Error('cpu must be a number from 1 to 20 (1 is normal speed)');
    out.cpu = n;
  }
  if (a.headers != null) {
    if (!a.headers || typeof a.headers !== 'object' || Array.isArray(a.headers)) throw new Error('headers must be an object of header name to value (null removes a header)');
    if (Object.keys(a.headers).length > 20) throw new Error('at most 20 headers');
    out.headers = {};
    for (const [name, value] of Object.entries(a.headers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`${JSON.stringify(name)} is not a valid header name`);
      if (value !== null && (typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value))) throw new Error(`the value of header ${name} must be one line of at most 2000 characters`);
      out.headers[name] = value;
    }
  }
  return out;
}

const tools = [
  {
    name: 'pdf',
    description: "Chrome and Edge: save a tab's page as a PDF file with its print styles. Firefox cannot save a PDF without opening a user dialog; use a full-page screenshot there.",
    inputSchema: { type: 'object', properties: {
      tab: TAB, path: { type: 'string' }, landscape: { type: 'boolean' }, paper: { type: 'string', enum: PAPERS }, pages: { type: 'string' },
      scale: { type: 'number' }, margin_mm: { type: 'number' }, background: { type: 'boolean' }, header_footer: { type: 'boolean' }, timeout_ms: { type: 'number' },
    }, required: ['tab'] },
  },
  {
    name: 'emulate',
    description: 'Make a tab behave like another device or environment. Settings stay until reset: true. Call with only tab to list active settings.',
    inputSchema: { type: 'object', properties: {
      tab: TAB, device: { type: 'string', enum: ['iphone', 'android', 'ipad'] }, width: { type: 'number' }, height: { type: 'number' },
      pixel_ratio: { type: 'number' }, mobile: { type: 'boolean' }, touch: { type: 'boolean' }, landscape: { type: 'boolean' }, user_agent: { type: 'string' },
      locale: { type: 'string' }, timezone: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, accuracy: { type: 'number' },
      color_scheme: { type: 'string', enum: ['light', 'dark'] }, reduced_motion: { type: 'string', enum: ['reduce', 'no-preference'] },
      forced_colors: { type: 'string', enum: ['active', 'none'] }, contrast: { type: 'string', enum: ['more', 'less', 'no-preference'] },
      media: { type: 'string', enum: ['print', 'screen'] }, cpu: { type: 'number' }, headers: { type: 'object' }, reset: { type: 'boolean' },
    }, required: ['tab'] },
  },
];

async function run(name, a, h) {
  if (name === 'pdf') {
    const paper = a.paper || 'a4';
    if (!PAPERS.includes(paper)) throw new Error('paper must be one of: ' + PAPERS.join(', '));
    const scale = a.scale == null ? 1 : Number(a.scale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) throw new Error('scale must be a number from 0.1 to 2');
    const margin = a.margin_mm == null ? 10 : Number(a.margin_mm);
    if (!Number.isFinite(margin) || margin < 0 || margin > 100) throw new Error('margin_mm must be a number from 0 to 100');
    if (a.pages && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(a.pages)) throw new Error('pages must look like "1-3, 5" (page numbers and ranges, counted from 1)');
    const file = targetFile(a.path, ['.pdf'], h, 'page');
    const { result: r } = await h.send('pdf', { tab: a.tab, landscape: !!a.landscape, paper, pages: String(a.pages || '').replace(/\s/g, ''), scale,
      margin_mm: margin, background: a.background !== false, header_footer: !!a.header_footer, timeout_ms: a.timeout_ms }, { waitMs: a.timeout_ms });
    const data = Buffer.from(r.data || '', 'base64');
    if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error('the browser returned no PDF');
    fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
    const pages = (data.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
    return h.text(`saved: ${file} (${pages ? pages + ' page' + (pages === 1 ? '' : 's') + ', ' : ''}${paper.toUpperCase()} ${a.landscape ? 'landscape' : 'portrait'}, ${sizeText(data.length)})\ntitle: ${r.title || ''}\nurl: ${r.url || ''}`);
  }
  const args = emulateArgs(a);
  const { result: r } = await h.send('emulate', Object.assign({ tab: a.tab }, args));
  const lead = r.on.length ? `emulation in ${a.tab}${r.reset === 'removed' ? ' (earlier settings removed)' : ''}: ${r.on.join('; ')}` :
    r.reset === 'removed' ? `emulation removed from ${a.tab}` : r.reset === 'nothing' ? `no emulation was active in ${a.tab}` : `no emulation is active in ${a.tab}`;
  return h.text(lead + (r.notes || []).map((x) => '\nnote: ' + x).join(''));
}

module.exports = { tools, run, emulateArgs, targetFile };
