'use strict';
const fs = require('fs');
const path = require('path');

module.exports = async (t) => {
  t.route('/output/page', '<!doctype html><title>Output test</title><style>body{margin:0;background:#fff}#hero{width:320px;height:140px;background:#1677ff;color:white;font:32px sans-serif}#tail{margin-top:1800px}</style><div id="hero">blue panel</div><div id="tail">end</div>');
  t.route('/output/print', '<!doctype html><title>Printable invoice</title><style>@page{size:A4}h1{color:#135}</style><h1>Invoice 42</h1><p>Printable page.</p>');
  t.route('/output/header', (req, res) => { res.setHeader('content-type', 'text/plain'); res.end(req.headers['x-browzat-test'] || 'missing'); });
  const files = [];
  const tab = await t.open('/output/page');
  try {
    const png = path.join(t.tmp, 'viewport.png'); files.push(png);
    let r = await t.call('screenshot', { tab, format: 'png', path: png, max_width: 900 });
    t.check('screenshot saves PNG to a requested path', !r.isError && fs.existsSync(png) && fs.readFileSync(png).subarray(1, 4).toString() === 'PNG' && r.text.includes('saved: ' + png), r.text);

    const full = path.join(t.tmp, 'full.jpg'); files.push(full);
    r = await t.call('screenshot', { tab, full_page: true, path: full, max_width: 900 });
    const dims = /\((\d+)x(\d+), full page/.exec(r.text);
    t.check('screenshot captures a full page', !r.isError && fs.existsSync(full) && dims && Number(dims[2]) > 1000, r.text);

    const element = path.join(t.tmp, 'element.webp'); files.push(element);
    r = await t.call('screenshot', { tab, selector: '#hero', path: element, max_width: 900 });
    t.check('screenshot captures one element as WebP', !r.isError && fs.existsSync(element) && fs.readFileSync(element).subarray(8, 12).toString() === 'WEBP' && r.text.includes('div "blue panel"'), r.text);

    await t.call('navigate', { tab, url: t.base + '/output/print' });
    const pdf = path.join(t.tmp, 'page.pdf'); files.push(pdf);
    r = await t.call('pdf', { tab, path: pdf, paper: 'a4', background: true });
    if (t.chromium) {
      t.check('pdf saves a valid printable page', !r.isError && fs.existsSync(pdf) && fs.readFileSync(pdf).subarray(0, 5).toString() === '%PDF-' && r.text.includes('Printable invoice'), r.text);
    } else {
      t.check('pdf explains the Firefox limitation', r.isError && r.text.includes('not supported on Firefox') && !fs.existsSync(pdf), r.text);
    }

    await t.call('navigate', { tab, url: t.base + '/output/page' });
    r = await t.call('emulate', { tab });
    t.check('emulate initially lists no settings', !r.isError && r.text === `no emulation is active in ${tab}`, r.text);

    if (t.chromium) {
      r = await t.call('emulate', { tab, width: 412, height: 700, pixel_ratio: 2, touch: true, color_scheme: 'dark', timezone: 'Asia/Tokyo' });
      const env = await t.evaluate(tab, "JSON.stringify({w:innerWidth,d:devicePixelRatio,dark:matchMedia('(prefers-color-scheme: dark)').matches,tz:Intl.DateTimeFormat().resolvedOptions().timeZone,touch:navigator.maxTouchPoints})");
      const e = JSON.parse(env);
      t.check('emulate applies viewport, touch and media and reports timezone support', !r.isError && e.w === 412 && Math.abs(e.d - 2) < 1e-6 && e.dark && e.touch > 0 &&
        (e.tz === 'Asia/Tokyo' || r.text.includes('does not allow extensions to override the time zone')), r.text + '\n' + env);
      r = await t.call('emulate', { tab, headers: { 'X-Browzat-Test': 'phase4' } });
      const header = await t.evaluate(tab, `return await fetch(${JSON.stringify(t.base + '/output/header')}).then(r=>r.text())`);
      t.check('emulate sets per-tab request headers', !r.isError && header === 'phase4' && !r.text.includes('phase4'), r.text + '\n' + header);
    } else {
      r = await t.call('emulate', { tab, width: 900, height: 600 });
      const width = Number(await t.evaluate(tab, 'innerWidth'));
      t.check('emulate resizes a Firefox viewport or reports the platform limit', !r.isError &&
        (Math.abs(width - 900) <= 4 || (r.text.includes('could not make the page exactly 900x600') && r.text.includes(`it is ${width}x`))), r.text + '\n' + width);
      const unsupported = await t.call('emulate', { tab, timezone: 'Asia/Tokyo' });
      t.check('emulate reports unsupported Firefox settings', unsupported.isError && unsupported.text.includes('not supported on Firefox'), unsupported.text);
    }

    r = await t.call('emulate', { tab, reset: true });
    const listed = await t.call('emulate', { tab });
    t.check('emulate reset removes every active setting', !r.isError && /emulation removed|no emulation was active/.test(r.text) && listed.text === `no emulation is active in ${tab}`, r.text + '\n' + listed.text);
  } finally {
    await t.call('emulate', { tab, reset: true }).catch(() => {});
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} }
  }
};
