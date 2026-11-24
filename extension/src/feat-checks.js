'use strict';
// Verification and inspection helpers (phase 6).
const chkLogpoints = new Map();

function chkPage(a) {
  try {
    const state = globalThis.__bmcp;
    const find = (target, optional) => {
      if (target && target.ref) {
        const el = state && state.els.get(target.ref);
        if (!el || !el.isConnected) throw new Error('ref ' + target.ref + ' is no longer on the page; take a new snapshot');
        return el;
      }
      if (target && target.selector) {
        const el = document.querySelector(target.selector);
        if (!el && !optional) throw new Error('selector matched nothing: ' + target.selector);
        return el;
      }
      if (optional) return null;
      throw new Error('ref or selector is required');
    };
    const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const label = (el) => el.localName + (el.id ? '#' + CSS.escape(el.id) : '');
    if (a.op === 'verify') {
      let ok = false; let message = '';
      if (a.kind === 'element') { const el = find(a); ok = visible(el); message = ok ? label(el) + ' is visible' : label(el) + ' is not visible'; }
      if (a.kind === 'text') {
        const root = find(a, true) || document.body; const actual = (root.innerText || '').replace(/\s+/g, ' ').trim(); const want = String(a.text || '');
        ok = a.exact ? actual === want : actual.toLowerCase().includes(want.toLowerCase()); message = ok ? JSON.stringify(want) + ' is visible' : 'text not visible: ' + JSON.stringify(want);
      }
      if (a.kind === 'list') {
        const actual = Array.from(document.querySelectorAll(a.selector || 'li')).filter(visible).map((x) => (x.innerText || '').trim());
        const want = (a.texts || []).map(String); ok = want.every((x) => actual.includes(x)); message = ok ? `${want.length} list item(s) are visible` : `expected ${JSON.stringify(want)}, saw ${JSON.stringify(actual.slice(0, 30))}`;
      }
      if (a.kind === 'value') { const el = find(a); const actual = 'value' in el ? el.value : el.textContent; ok = a.exact === false ? String(actual).includes(String(a.value)) : String(actual) === String(a.value); message = ok ? `value is ${JSON.stringify(actual)}` : `expected ${JSON.stringify(a.value)}, saw ${JSON.stringify(actual)}`; }
      return { ok: true, value: { ok, message } };
    }
    if (a.op === 'inspect') {
      if (a.what === 'frames') return { ok: true, value: { value: Array.from(document.querySelectorAll('iframe,frame')).map((x, i) => ({ index: i, name: x.name || '', src: x.src || '', title: x.title || '' })) } };
      const el = find(a);
      let value;
      if (a.what === 'text') value = el.innerText || el.textContent || '';
      if (a.what === 'html') value = el.outerHTML;
      if (a.what === 'attributes') value = Object.fromEntries(Array.from(el.attributes).map((x) => [x.name, x.value]));
      if (a.what === 'box') { const r = el.getBoundingClientRect(); value = { x: r.x, y: r.y, width: r.width, height: r.height, visible: visible(el) }; }
      if (a.what === 'locator') {
        if (el.id) value = '#' + CSS.escape(el.id);
        else { const name = el.getAttribute('name'); const aria = el.getAttribute('aria-label'); value = aria ? `${el.localName}[aria-label=${JSON.stringify(aria)}]` : name ? `${el.localName}[name=${JSON.stringify(name)}]` : el.localName; }
      }
      if (a.what === 'styles') { const s = getComputedStyle(el); value = { display: s.display, position: s.position, color: s.color, backgroundColor: s.backgroundColor, font: s.font, margin: s.margin, padding: s.padding, width: s.width, height: s.height, zIndex: s.zIndex }; }
      return { ok: true, value: { value } };
    }
    if (a.op === 'fill') {
      let last = null;
      for (const f of a.fields || []) {
        const el = find(f); last = el;
        if (el.localName === 'select') {
          const values = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)];
          for (const option of el.options) option.selected = values.includes(option.value) || values.includes(option.textContent.trim());
        } else if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!f.value;
        else el.value = f.value == null ? '' : typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (a.submit && last) { const form = last.form || last.closest('form'); if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); } }
      return { ok: true, value: { count: (a.fields || []).length, submitted: !!a.submit } };
    }
    if (a.op === 'scroll') {
      const el = find(a, true); const target = el || document.scrollingElement;
      if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      else if (a.direction === 'top') scrollTo(0, 0);
      else if (a.direction === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
      else { const n = Number(a.amount) || innerHeight * 0.8; scrollBy(Number(a.x) || (a.direction === 'left' ? -n : a.direction === 'right' ? n : 0), Number(a.y) || (a.direction === 'up' ? -n : n)); }
      const r = el ? el.getBoundingClientRect() : { x: scrollX, y: scrollY };
      return { ok: true, value: { x: el ? r.x : scrollX, y: el ? r.y : scrollY, target: el ? label(el) : '' } };
    }
    if (a.op === 'highlight') {
      const old = document.getElementById('__browzat_highlight'); if (old) old.remove();
      if (a.action === 'hide') return { ok: true, value: { hidden: true } };
      const el = find(a); const r = el.getBoundingClientRect(); const box = document.createElement('div'); box.id = '__browzat_highlight';
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:3px solid ${a.color || '#ff2d55'};z-index:2147483647;pointer-events:none;box-sizing:border-box`;
      if (a.label) { const span = document.createElement('span'); span.textContent = a.label; span.style.cssText = 'position:absolute;left:-3px;top:-24px;background:#ff2d55;color:white;padding:2px 6px;font:12px sans-serif'; box.append(span); }
      document.documentElement.append(box); return { ok: true, value: { hidden: false, target: label(el) } };
    }
    if (a.op === 'audit') {
      const issues = [];
      if (!document.title.trim()) issues.push('page has no title');
      if (!document.documentElement.lang) issues.push('html has no lang attribute');
      for (const img of document.images) if (!img.hasAttribute('alt')) issues.push('image has no alt text: ' + (img.src || '').slice(0, 100));
      for (const input of document.querySelectorAll('input,select,textarea')) if (!input.labels.length && !input.getAttribute('aria-label') && input.type !== 'hidden') issues.push('form field has no label: ' + label(input));
      const ids = new Set(); for (const el of document.querySelectorAll('[id]')) { if (ids.has(el.id)) issues.push('duplicate id: ' + el.id); ids.add(el.id); }
      for (const a of document.querySelectorAll('a[href]')) if ((a.innerText || '').trim().toLowerCase() === 'click here') issues.push('link has vague text: click here');
      return { ok: true, value: { passed: 6 - Math.min(6, issues.length), issues: issues.slice(0, 50) } };
    }
    throw new Error('unknown checks operation');
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

for (const [name, op] of [['verify', 'verify'], ['inspect', 'inspect'], ['fill_form', 'fill'], ['scroll', 'scroll'], ['highlight', 'highlight'], ['audit', 'audit']]) {
  handlers[name] = async (p) => unwrap((await run(need(p), chkPage, [Object.assign({ op }, p)], { frameId: 0 }))[0]);
}

handlers.logpoints = async (p) => {
  const id = need(p); const action = p.action || 'list';
  if (IS_FIREFOX) throw new Error('logpoints are not supported on Firefox: its extension API has no JavaScript debugger');
  let list = chkLogpoints.get(id) || [];
  if (action === 'add') {
    if (!p.url || !Number.isFinite(Number(p.line))) throw new Error('url and line are required for add');
    await cdpPin(id, 'checks-logpoints'); await cdp(id, 'Debugger.enable');
    const condition = `console.log(${JSON.stringify(p.expression || 'logpoint')}, typeof this === 'undefined' ? '' : this), false`;
    const r = await cdp(id, 'Debugger.setBreakpointByUrl', { url: p.url, lineNumber: Math.max(0, Math.round(Number(p.line)) - 1), condition });
    list.push({ id: r.breakpointId, url: p.url, line: Math.round(Number(p.line)), expression: p.expression || 'logpoint' }); chkLogpoints.set(id, list);
  } else if (action === 'remove') {
    if (!p.id) throw new Error('id is required for remove'); await cdp(id, 'Debugger.removeBreakpoint', { breakpointId: p.id }); list = list.filter((x) => x.id !== p.id); chkLogpoints.set(id, list);
  } else if (action === 'clear') {
    for (const x of list) { try { await cdp(id, 'Debugger.removeBreakpoint', { breakpointId: x.id }); } catch (e) {} }
    list = []; chkLogpoints.delete(id); cdpUnpin(id, 'checks-logpoints');
  }
  return { lines: list.map((x) => `${x.id}  ${x.url}:${x.line}  ${x.expression}`) };
};
