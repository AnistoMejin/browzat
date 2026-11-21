'use strict';
// Functions injected into pages. Each one must be self-contained: only its own source is sent to the page.
// Every function returns { ok: true, value } or { ok: false, error } and never throws.

function bmcpSnapshot(o) {
  try {
    const S = globalThis.__bmcp || (globalThis.__bmcp = { n: 0, els: new Map(), refs: new Map() });
    for (const [ref, el] of S.els) if (!el.isConnected) { S.els.delete(ref); S.refs.delete(el); }

    const prefix = o.prefix || '';
    const cap = o.find ? 400000 : o.maxChars;
    const out = [];
    let size = 0;
    let truncated = false;
    let textOff = 0;

    const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'svg', 'br', 'hr', 'wbr', 'canvas', 'video', 'audio', 'object', 'embed', 'datalist', 'option', 'optgroup']);
    const INLINE = new Set(['span', 'b', 'i', 'em', 'strong', 'code', 'small', 'sub', 'sup', 'mark', 'u', 's', 'abbr', 'time', 'kbd', 'var', 'q', 'cite', 'font', 'bdi', 'bdo', 'a', 'del', 'ins']);
    const NATIVE_LEAF = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
    const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
    const LANDMARK = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', dialog: 'dialog', ul: 'list', ol: 'list', table: 'table', fieldset: 'group', menu: 'list' };
    const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog', 'list', 'table', 'grid', 'group', 'menu', 'menubar', 'tablist', 'toolbar', 'region', 'search', 'tree', 'listbox', 'radiogroup', 'alert', 'status', 'tabpanel']);
    const ISEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role],[onclick],[tabindex],[contenteditable]';

    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const q = (s, n) => JSON.stringify(cut(clean(s), n || 160));
    const noText = () => o.interactive || textOff > 0;
    const hasInteractive = (el) => !!el.querySelector(ISEL);

    function emit(depth, line) {
      if (truncated) return;
      const l = ' '.repeat(Math.min(depth, 8)) + line;
      if (size + l.length + 1 > cap) { truncated = true; return; }
      out.push(l);
      size += l.length + 1;
    }

    function refOf(el) {
      let r = S.refs.get(el);
      if (!r) {
        r = prefix + 'e' + ++S.n;
        S.refs.set(el, r);
        S.els.set(r, el);
      }
      return r;
    }

    function labelOwnText(lab) {
      let t = '';
      for (const c of lab.childNodes) {
        if (c.nodeType === 3) t += c.nodeValue;
        else if (c.nodeType === 1 && !/^(input|select|textarea|button)$/.test(c.localName)) t += ' ' + c.textContent;
      }
      return t;
    }

    function labelText(el) {
      const aria = el.getAttribute('aria-label');
      if (clean(aria)) return aria;
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map((id) => { const x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
        if (clean(t)) return t;
      }
      if (el.labels && el.labels.length) return labelOwnText(el.labels[0]);
      return '';
    }

    function nameOf(el, tag) {
      const n = labelText(el);
      if (clean(n)) return n;
      if (tag === 'input') {
        const t = el.type;
        if (t === 'submit' || t === 'button' || t === 'reset') return el.value || t;
        if (t === 'image') return el.alt || 'image';
        return el.placeholder || el.title || el.name || '';
      }
      if (tag === 'textarea' || tag === 'select') return el.placeholder || el.title || el.name || '';
      if (el.isContentEditable) return el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || el.title || '';
      const txt = el.innerText;
      if (clean(txt)) return txt;
      const img = el.querySelector('img[alt]');
      if (img && clean(img.alt)) return img.alt;
      const st = el.querySelector('svg title');
      if (st && clean(st.textContent)) return st.textContent;
      return el.title || el.getAttribute('data-tooltip') || el.getAttribute('name') || '';
    }

    function roleOf(el, tag) {
      const r = el.getAttribute('role');
      if (r) return r.split(' ')[0];
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const t = el.type;
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'file') return 'file';
        return t === 'text' || t === 'search' || t === 'email' || t === 'url' || t === 'tel' ? 'textbox' : 'textbox:' + t;
      }
      if (el.isContentEditable) return 'textbox';
      return 'clickable';
    }

    // true = certainly interactive, 'weak' = only looks clickable (pointer cursor), false = not interactive
    function interactive(el, tag, st) {
      if (tag === 'a') return el.hasAttribute('href');
      if (tag === 'input') return el.type !== 'hidden';
      if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
      const r = el.getAttribute('role');
      if (r && INTERACTIVE_ROLES.has(r.split(' ')[0])) return true;
      if (el.isContentEditable) return !(el.parentElement && el.parentElement.isContentEditable);
      if (el.hasAttribute('onclick')) return true;
      const ti = el.getAttribute('tabindex');
      if (ti !== null && ti !== '-1') return true;
      if (st.cursor === 'pointer') {
        const p = el.parentElement;
        if (!p || getComputedStyle(p).cursor !== 'pointer') return 'weak';
      }
      return false;
    }

    function extras(el, tag) {
      let x = '';
      if (tag === 'input' || tag === 'textarea') {
        const t = el.type;
        if (t === 'checkbox' || t === 'radio') { if (el.checked) x += ' checked'; }
        else if (t === 'password') { if (el.value) x += ' value=•••'; }
        else if (t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'file' && t !== 'image' && el.value) x += ' value=' + q(el.value, 80);
      } else if (tag === 'select') {
        const so = el.selectedOptions && el.selectedOptions[0];
        if (so) x += ' value=' + q(so.textContent, 80);
        const opts = Array.from(el.options).slice(0, 12).map((op) => clean(op.textContent)).filter(Boolean);
        if (opts.length > 1) x += ' options=[' + cut(opts.join(' | '), 200) + (el.options.length > 12 ? ' | …' : '') + ']';
      } else if (el.isContentEditable) {
        const v = clean(el.innerText);
        if (v) x += ' value=' + q(v, 80);
      }
      if (el.getAttribute('aria-checked') === 'true') x += ' checked';
      const ae = el.getAttribute('aria-expanded');
      if (ae) x += ' expanded=' + ae;
      if (el.getAttribute('aria-selected') === 'true') x += ' selected';
      if (el.getAttribute('aria-pressed') === 'true') x += ' pressed';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') x += ' disabled';
      if (o.hrefs && tag === 'a') x += ' → ' + cut(el.getAttribute('href') || '', 120);
      return x;
    }

    function kids(el) {
      if (el.localName === 'slot' && el.assignedNodes) {
        const a = el.assignedNodes({ flatten: true });
        if (a.length) return a;
      }
      return el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
    }

    function walk(node, depth) {
      let buf = '';
      const flush = () => {
        const t = clean(buf);
        buf = '';
        if (t && !noText()) emit(depth, 'text ' + JSON.stringify(cut(t, 300)));
      };
      for (const ch of kids(node)) {
        if (truncated) return;
        if (ch.nodeType === 3) { buf += ch.nodeValue; continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.localName;
        if (SKIP.has(tag)) { if (tag === 'br') buf += ' '; continue; }
        const st = getComputedStyle(ch);
        if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || ch.getAttribute('aria-hidden') === 'true' || ch.inert) continue;
        const inter = interactive(ch, tag, st);
        if (!inter && INLINE.has(tag) && !hasInteractive(ch)) { buf += ch.innerText || ch.textContent || ''; continue; }
        flush();
        visit(ch, tag, st, inter, depth);
      }
      flush();
    }

    function visit(el, tag, st, inter, depth) {
      if (tag === 'iframe' || tag === 'frame') {
        if (!noText()) emit(depth, 'iframe ' + q(el.title || el.name || '') + ' src=' + cut(el.src || '', 100));
        return;
      }
      if (tag === 'img') {
        if (clean(el.alt) && !noText()) emit(depth, 'img ' + q(el.alt));
        return;
      }
      if (tag === 'label' && el.control) {
        // The control's own line already carries this label's text.
        if (hasInteractive(el)) { textOff++; walk(el, depth); textOff--; }
        return;
      }
      if (tag === 'details' && !el.open) {
        const s = el.querySelector(':scope > summary');
        if (s) visit(s, 'summary', getComputedStyle(s), true, depth);
        return;
      }
      if (inter) {
        const nested = hasInteractive(el);
        if (inter === true || !nested) {
          const rendered = el.getClientRects().length > 0 || st.display === 'contents';
          if (rendered) {
            emit(depth, roleOf(el, tag) + ' ' + q(nameOf(el, tag)) + ' [' + refOf(el) + ']' + extras(el, tag));
            if (!nested || NATIVE_LEAF.has(tag)) return;
            walk(el, depth + 1);
            return;
          }
          if (!nested) return;
        }
      }
      if (/^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading') {
        if (!hasInteractive(el)) {
          const t = clean(el.innerText);
          if (t && !noText()) emit(depth, 'heading ' + q(t) + ' [' + tag + ']');
          return;
        }
        walk(el, depth);
        return;
      }
      if (tag === 'tr') {
        const cells = Array.from(el.children).filter((c) => c.localName === 'td' || c.localName === 'th').map((c) => cut(clean(c.innerText), 80));
        if (cells.some(Boolean) && !noText()) emit(depth, 'row: ' + cells.join(' | '));
        if (hasInteractive(el)) { textOff++; walk(el, depth + 1); textOff--; }
        return;
      }
      const role = el.getAttribute('role');
      const lm = (role && LANDMARK_ROLES.has(role) && role) || LANDMARK[tag];
      if (lm && !noText()) {
        let label = el.getAttribute('aria-label') || '';
        if (!label && tag === 'fieldset') { const lg = el.querySelector(':scope > legend'); if (lg) label = lg.innerText; }
        const before = out.length;
        emit(depth, lm + (clean(label) ? ' ' + q(label) : '') + ':');
        walk(el, depth + 1);
        if (out.length === before + 1 && !truncated) { size -= out[before].length + 1; out.pop(); }
        return;
      }
      walk(el, depth);
    }

    let root = document.body || document.documentElement;
    if (o.selector) {
      root = document.querySelector(o.selector);
      if (!root) return { ok: false, error: 'selector matched nothing: ' + o.selector };
    }
    walk(root, 0);

    let lines = out;
    if (o.find) {
      const f = String(o.find).toLowerCase();
      lines = [];
      let n = 0;
      let cutOff = false;
      for (const l of out) {
        if (!l.toLowerCase().includes(f)) continue;
        const t = l.trimStart();
        if (n + t.length + 1 > o.maxChars) { cutOff = true; break; }
        lines.push(t);
        n += t.length + 1;
      }
      truncated = cutOff;
      if (!lines.length) lines.push('(no line contains ' + JSON.stringify(o.find) + ')');
    }
    return { ok: true, value: { url: location.href, title: document.title, text: lines.join('\n'), truncated } };
  } catch (e) {
    return { ok: false, error: 'snapshot failed: ' + String((e && e.message) || e) };
  }
}

function bmcpAct(a) {
  try {
    const S = globalThis.__bmcp;
    let el = null;
    if (a.ref) {
      el = S && S.els.get(a.ref);
      if (!el || !el.isConnected) return { ok: false, error: 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' };
    } else if (a.selector) {
      el = document.querySelector(a.selector);
      if (!el) return { ok: false, error: 'selector matched nothing: ' + a.selector };
    }

    const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const desc = (e) => {
      if (!e || e === document.body) return 'the page';
      const field = /^(input|textarea|select)$/.test(e.localName);
      const label = e.getAttribute('aria-label') || (field ? e.placeholder || e.name || e.id : e.innerText) || '';
      return e.localName + (short(label) ? ' "' + short(label) + '"' : '');
    };
    const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, Home: 36, End: 35, PageUp: 33, PageDown: 34 };

    function pressKey(t, key, mods) {
      const kc = KEYCODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const code = key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : '') : key;
      const init = Object.assign({ key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true }, mods);
      const go = t.dispatchEvent(new KeyboardEvent('keydown', init));
      if (key === 'Enter' || key.length === 1) t.dispatchEvent(new KeyboardEvent('keypress', init));
      if (go && key === 'Enter') {
        // Synthetic key events have no default action, so do what Enter would do.
        const tag = t.localName;
        const form = t.form || (t.closest && t.closest('form'));
        if (tag === 'input' && form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
        else if (tag === 'button' || tag === 'a' || tag === 'summary' || t.getAttribute('role') === 'button') t.click();
      }
      if (go) {
        if (key === 'PageDown') window.scrollBy(0, window.innerHeight * 0.9);
        else if (key === 'PageUp') window.scrollBy(0, -window.innerHeight * 0.9);
        else if (key === 'End') window.scrollTo(0, document.documentElement.scrollHeight);
        else if (key === 'Home') window.scrollTo(0, 0);
      }
      t.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    if (a.action === 'click') {
      if (!el) return { ok: false, error: 'click needs ref or selector' };
      if (el.disabled) return { ok: false, error: 'the element is disabled' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      const fire = (Ctor, type, extra) => el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra)));
      fire(PointerEvent, 'pointerover', { pointerType: 'mouse' });
      fire(MouseEvent, 'mouseover');
      fire(PointerEvent, 'pointerdown', { pointerType: 'mouse', isPrimary: true, buttons: 1 });
      fire(MouseEvent, 'mousedown', { buttons: 1 });
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      fire(PointerEvent, 'pointerup', { pointerType: 'mouse', isPrimary: true });
      fire(MouseEvent, 'mouseup');
      if (typeof el.click === 'function') el.click(); else fire(MouseEvent, 'click');
      if (a.double) {
        if (typeof el.click === 'function') el.click(); else fire(MouseEvent, 'click');
        fire(MouseEvent, 'dblclick', { detail: 2 });
      }
      return { ok: true, value: (a.double ? 'double-clicked ' : 'clicked ') + desc(el) };
    }

    if (a.action === 'type') {
      if (!el) el = document.activeElement;
      if (!el || el === document.body) return { ok: false, error: 'type needs ref or selector (nothing is focused)' };
      const tag = el.localName;
      const text = String(a.text == null ? '' : a.text);
      if (tag === 'select') {
        const want = text.trim().toLowerCase();
        const opts = Array.from(el.options);
        const opt = opts.find((op) => op.value.toLowerCase() === want || op.textContent.trim().toLowerCase() === want) ||
          opts.find((op) => op.textContent.trim().toLowerCase().includes(want));
        if (!opt) return { ok: false, error: 'no option matches ' + JSON.stringify(text) + '; options: ' + opts.slice(0, 20).map((op) => op.textContent.trim()).join(' | ') };
        el.value = opt.value;
        opt.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: 'selected ' + JSON.stringify(opt.textContent.trim()) + ' in ' + desc(el) };
      }
      if (tag === 'input' || tag === 'textarea') {
        if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return { ok: false, error: 'cannot type into a ' + el.type + ' input; use click' };
        if (el.disabled || el.readOnly) return { ok: false, error: 'the field is disabled or read-only' };
        el.focus();
        // The native setter keeps frameworks such as React aware of the change.
        const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, a.clear === false ? el.value + text : text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (a.clear === false) range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        if (!document.execCommand('insertText', false, text)) {
          if (a.clear === false) el.append(text); else el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      } else {
        return { ok: false, error: '<' + tag + '> is not a text field' };
      }
      if (a.submit) pressKey(el, 'Enter', {});
      return { ok: true, value: 'typed into ' + desc(el) + (a.submit ? ' and pressed Enter' : '') };
    }

    if (a.action === 'key') {
      const parts = String(a.key || '').split('+').map((s) => s.trim()).filter(Boolean);
      if (String(a.key).endsWith('+')) parts.push('+');
      let key = parts.pop();
      if (!key) return { ok: false, error: 'key is required' };
      if (key === 'Space') key = ' ';
      if (key === 'Esc') key = 'Escape';
      const mods = {};
      for (const m of parts) {
        const k = m.toLowerCase();
        if (k === 'control' || k === 'ctrl') mods.ctrlKey = true;
        else if (k === 'shift') mods.shiftKey = true;
        else if (k === 'alt') mods.altKey = true;
        else if (k === 'meta' || k === 'cmd' || k === 'win') mods.metaKey = true;
      }
      const t = el || document.activeElement || document.body;
      pressKey(t, key, mods);
      return { ok: true, value: 'pressed ' + a.key + ' on ' + desc(t) };
    }

    return { ok: false, error: 'unknown action ' + a.action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function bmcpCheck(a) {
  try {
    if (a.selector) {
      const el = document.querySelector(a.selector);
      return { ok: true, value: !!el && el.getClientRects().length > 0 };
    }
    const t = (document.body && document.body.innerText) || '';
    return { ok: true, value: t.toLowerCase().includes(String(a.text || '').toLowerCase()) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function bmcpSer(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x && x.nodeType === 1 ? '<' + x.localName + '>' : x));
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
}

// Chromium only, runs in the page's own world. Firefox evaluates through tabs.executeScript instead.
async function bmcpEval(code) {
  const ser = (v) => {
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    try {
      const s = JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x && x.nodeType === 1 ? '<' + x.localName + '>' : x));
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let f;
    try {
      f = new AsyncFunction('return (' + code + '\n);');
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      f = new AsyncFunction(code);
    }
    return { ok: true, value: ser(await f()) };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if ((e && e.name === 'EvalError') || /unsafe-eval|Content Security Policy|Trusted/i.test(msg)) {
      return { ok: false, error: "this site's security policy (CSP) blocks evaluate in Chrome and Edge; use snapshot, click and type instead" };
    }
    return { ok: false, error: String(e) };
  }
}

// Shows (or removes) the handoff card: a small panel asking the user to do something only a person can do, with
// Continue and Cancel. Styles are set through the CSSOM inside a closed shadow root, so the page's CSS cannot reach it
// and a strict style-src policy does not block it. Only a real click (isTrusted) counts, so neither the page nor the
// agent's synthetic click tool can answer for the user.
function bmcpHandoffCard(o) {
  try {
    const api = globalThis.browser || globalThis.chrome;
    const KEY = '__bmcpHandoff';
    const old = globalThis[KEY];
    if (o.ensure && old && old.id === o.id && old.host.isConnected) return { ok: true, value: 'present' };
    if (old && old.host && old.host.isConnected) old.host.remove();
    globalThis[KEY] = null;
    if (o.remove) return { ok: true, value: 'removed' };

    const css = (el, s) => { for (const k in s) el.style.setProperty(k, s[k], 'important'); return el; };
    const make = (tag, s, text) => { const el = css(document.createElement(tag), s); if (text != null) el.textContent = text; return el; };

    const host = document.createElement('div');
    css(host, { all: 'initial', position: 'fixed', right: '18px', bottom: '18px', 'z-index': '2147483647', display: 'block' });
    const root = host.attachShadow({ mode: 'closed' });
    const font = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const card = make('div', {
      width: '340px', 'box-sizing': 'border-box', padding: '14px 16px', 'border-radius': '10px',
      background: '#0d1117', color: '#e6edf3', border: '1px solid #3fb950', 'box-shadow': '0 8px 28px rgba(0,0,0,.45)',
      'font-family': font, 'font-size': '14px', 'line-height': '1.45', 'text-align': 'left',
    });
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Action needed from you');
    card.appendChild(make('div', { 'font-weight': '600', 'font-size': '13px', color: '#3fb950', margin: '0 0 6px' }, 'browzat · your AI agent is waiting for you'));
    card.appendChild(make('div', { 'white-space': 'pre-wrap', margin: '0 0 8px', 'font-family': font }, String(o.message || '')));
    card.appendChild(make('div', { 'font-size': '12px', color: '#8b949e', margin: '0 0 12px', 'word-break': 'break-all', 'font-family': font }, 'Site: ' + (o.origin || location.origin)));

    const row = make('div', { display: 'flex', gap: '8px', 'justify-content': 'flex-end' });
    const btn = (label, primary) => make('button', {
      cursor: 'pointer', padding: '6px 14px', 'border-radius': '6px', 'font-family': font, 'font-size': '13px', 'font-weight': '600',
      border: primary ? '1px solid #3fb950' : '1px solid #30363d', background: primary ? '#238636' : '#21262d', color: '#ffffff',
    }, label);
    const cancel = btn('Cancel', false);
    const go = btn('Continue', true);
    row.appendChild(cancel);
    row.appendChild(go);
    card.appendChild(row);
    root.appendChild(card);

    const answer = (decision) => (ev) => {
      if (!ev.isTrusted) return; // ignore scripted clicks
      ev.preventDefault();
      ev.stopPropagation();
      go.disabled = true;
      cancel.disabled = true;
      Promise.resolve(api.runtime.sendMessage({ type: 'bmcp-handoff-done', id: o.id, decision }))
        .catch(() => {})
        .then(() => { if (host.isConnected) host.remove(); });
    };
    go.addEventListener('click', answer('continue'));
    cancel.addEventListener('click', answer('cancel'));

    (document.body || document.documentElement).appendChild(host);
    globalThis[KEY] = { id: o.id, host };
    return { ok: true, value: 'shown' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Finds the element of a ref or selector, scrolls it into view and reports where it is, for real (debugger) input.
// prepare: 'focus-select' focuses a text field and selects its content (so inserted text replaces it),
// 'focus-end' focuses it with the caret at the end.
function bmcpLocate(a) {
  try {
    const S = globalThis.__bmcp;
    let el = null;
    if (a.ref) {
      el = S && S.els.get(a.ref);
      if (!el || !el.isConnected) return { ok: false, error: 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' };
    } else if (a.selector) {
      el = document.querySelector(a.selector);
      if (!el) return { ok: false, error: 'selector matched nothing: ' + a.selector };
    } else if (a.focused) {
      el = document.activeElement;
    }
    if (!el) return { ok: false, error: 'ref or selector is required' };
    const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const desc = (e) => {
      if (!e || e === document.body || e === document.documentElement) return 'the page';
      const field = /^(input|textarea|select)$/.test(e.localName);
      const label = e.getAttribute('aria-label') || (field ? e.placeholder || e.name || e.id : e.innerText) || '';
      return e.localName + (short(label) ? ' "' + short(label) + '"' : '');
    };
    if (!a.noscroll && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const visible = r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
    let hit = visible ? document.elementFromPoint(x, y) : null;
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const reachable = !!hit && (hit === el || el.contains(hit));
    const tag = el.localName;
    const textField = (tag === 'input' && !/^(checkbox|radio|file|button|submit|reset|image|range|color)$/i.test(el.type)) || tag === 'textarea' || !!el.isContentEditable;
    if (a.prepare && textField) {
      if (el.disabled || el.readOnly) return { ok: false, error: 'the field is disabled or read-only' };
      el.focus({ preventScroll: true });
      if (el.isContentEditable) {
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (a.prepare === 'focus-end') range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else if (a.prepare === 'focus-select') {
        el.select();
      } else {
        const n = el.value.length;
        try { el.setSelectionRange(n, n); } catch (e) {}
      }
    }
    if (a.focus && !a.prepare && typeof el.focus === 'function') el.focus({ preventScroll: true });
    return {
      ok: true,
      value: {
        x, y, visible, reachable, desc: desc(el), cover: reachable || !hit ? '' : desc(hit),
        tag, type: el.type || '', textField, disabled: !!el.disabled, isFile: tag === 'input' && el.type === 'file',
      },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Upload helper. op 'find' resolves the file input for a target (the input itself, a label's control, an input inside
// it, or the only file input on the page) and, with mark, tags it so the debugger can find it. op 'unmark' removes the
// tag. op 'set' (Firefox) puts files given as base64 on the input and fires input and change.
function bmcpFiles(a) {
  try {
    const ATTR = 'data-bmcp-upload';
    if (a.op === 'unmark') {
      for (const e of document.querySelectorAll('[' + ATTR + ']')) e.removeAttribute(ATTR);
      return { ok: true, value: true };
    }
    const S = globalThis.__bmcp;
    let el = null;
    if (a.ref) {
      el = S && S.els.get(a.ref);
      if (!el || !el.isConnected) return { ok: false, error: 'ref ' + a.ref + ' is no longer on the page; take a new snapshot' };
    } else if (a.selector) {
      el = document.querySelector(a.selector);
      if (!el) return { ok: false, error: 'selector matched nothing: ' + a.selector };
    }
    const isFile = (e) => !!e && e.localName === 'input' && e.type === 'file';
    let input = null;
    if (isFile(el)) input = el;
    else if (el && el.control && isFile(el.control)) input = el.control;
    else if (el && el.querySelector && isFile(el.querySelector('input[type=file]'))) input = el.querySelector('input[type=file]');
    else {
      const all = document.querySelectorAll('input[type=file]');
      if (all.length === 1) input = all[0];
    }
    if (!input) return { ok: true, value: { input: false } };
    if (input.disabled) return { ok: false, error: 'the file input is disabled' };
    if (a.op === 'find') {
      if (a.mark) input.setAttribute(ATTR, a.mark);
      return { ok: true, value: { input: true, multiple: !!input.multiple, accept: input.accept || '' } };
    }
    if (a.op === 'set') {
      if (a.files.length > 1 && !input.multiple) return { ok: false, error: 'this file input takes one file only' };
      const dt = new DataTransfer();
      for (const f of a.files) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type || '', lastModified: f.mtime || Date.now() }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: { count: input.files.length } };
    }
    return { ok: false, error: 'unknown op ' + a.op };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Answers alert / confirm / prompt in agent tabs so the page never blocks, and records each one. Runs in the page's
// own world on Chrome and Edge, and in the content-script world on Firefox (through exportFunction). Default answers:
// alert OK, confirm Cancel, prompt Cancel; op 'arm' sets the answer for the next dialog. op 'take' returns the record.
function bmcpDialogs(o) {
  try {
    const FF = typeof exportFunction === 'function' && window.wrappedJSObject;
    const G = globalThis.__bmcpDlg || (globalThis.__bmcpDlg = { log: [], arm: null, installed: false });
    const handle = (kind, msg, def) => {
      const arm = G.arm;
      if (arm && !arm.keep) G.arm = null;
      const accept = arm ? arm.action === 'accept' : kind === 'alert';
      let ret;
      if (kind === 'confirm') ret = accept;
      else if (kind === 'prompt') ret = accept ? String(arm && arm.text != null ? arm.text : def == null ? '' : def) : null;
      const entry = { kind, message: String(msg == null ? '' : msg).slice(0, 300), answer: accept ? (kind === 'alert' ? 'ok' : 'accepted') : 'dismissed' };
      if (kind === 'prompt' && accept) entry.text = ret;
      G.log.push(entry);
      if (G.log.length > 20) G.log.shift();
      return ret;
    };
    if (!G.installed) {
      if (FF) {
        const w = window.wrappedJSObject;
        exportFunction(function (m) { handle('alert', m); }, w, { defineAs: 'alert' });
        exportFunction(function (m) { return handle('confirm', m); }, w, { defineAs: 'confirm' });
        exportFunction(function (m, d) { return handle('prompt', m, d); }, w, { defineAs: 'prompt' });
      } else {
        window.alert = function (m) { handle('alert', m); };
        window.confirm = function (m) { return handle('confirm', m); };
        window.prompt = function (m, d) { return handle('prompt', m, d); };
      }
      G.installed = true;
    }
    if (o.op === 'arm') G.arm = { action: o.action === 'accept' ? 'accept' : 'dismiss', text: o.text, keep: !!o.keep };
    if (o.op === 'take') {
      const l = G.log;
      G.log = [];
      return { ok: true, value: l };
    }
    return { ok: true, value: { armed: G.arm } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Simulated pointer input for Firefox, and the fallback elsewhere: hover, drag (HTML5 and mouse based), and mouse
// actions at viewport coordinates.
function bmcpPointer(a) {
  try {
    const S = globalThis.__bmcp;
    const find = (ref, selector) => {
      if (ref) {
        const e = S && S.els.get(ref);
        if (!e || !e.isConnected) throw new Error('ref ' + ref + ' is no longer on the page; take a new snapshot');
        return e;
      }
      if (selector) {
        const e = document.querySelector(selector);
        if (!e) throw new Error('selector matched nothing: ' + selector);
        return e;
      }
      return null;
    };
    const center = (e) => {
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const base = (p, extra) => Object.assign({ bubbles: true, cancelable: true, composed: true, view: window, clientX: p.x, clientY: p.y }, extra);
    const mouse = (t, type, p, extra) => t.dispatchEvent(new MouseEvent(type, base(p, extra)));
    const ptr = (t, type, p, extra) => t.dispatchEvent(new PointerEvent(type, base(p, Object.assign({ pointerType: 'mouse', isPrimary: true }, extra))));
    const at = (p) => document.elementFromPoint(p.x, p.y) || document.body;

    if (a.action === 'hover') {
      const el = find(a.ref, a.selector);
      if (!el) throw new Error('hover needs ref or selector');
      const p = center(el);
      ptr(el, 'pointerover', p);
      ptr(el, 'pointerenter', p, { bubbles: false });
      mouse(el, 'mouseover', p);
      mouse(el, 'mouseenter', p, { bubbles: false });
      ptr(el, 'pointermove', p);
      mouse(el, 'mousemove', p);
      return { ok: true, value: 'hovered (simulated)' };
    }
    if (a.action === 'drag') {
      const src = find(a.from_ref, a.from_selector);
      const dst = find(a.to_ref, a.to_selector);
      if (!src || !dst) throw new Error('drag needs a source and a target');
      const p1 = center(src);
      const p2 = center(dst);
      const dt = new DataTransfer();
      const drag = (t, type, p) => t.dispatchEvent(new DragEvent(type, base(p, { dataTransfer: dt })));
      ptr(src, 'pointerdown', p1, { buttons: 1 });
      mouse(src, 'mousedown', p1, { buttons: 1 });
      drag(src, 'dragstart', p1);
      ptr(dst, 'pointermove', p2, { buttons: 1 });
      mouse(dst, 'mousemove', p2, { buttons: 1 });
      drag(dst, 'dragenter', p2);
      drag(dst, 'dragover', p2);
      drag(dst, 'drop', p2);
      drag(src, 'dragend', p2);
      ptr(dst, 'pointerup', p2);
      mouse(dst, 'mouseup', p2);
      return { ok: true, value: 'dragged (simulated)' };
    }
    if (a.action === 'mouse') {
      const p = { x: Number(a.x) || 0, y: Number(a.y) || 0 };
      const t = at(p);
      const button = a.button === 'right' ? 2 : a.button === 'middle' ? 1 : 0;
      if (a.op === 'move') {
        ptr(t, 'pointermove', p);
        mouse(t, 'mousemove', p);
      } else if (a.op === 'down') {
        ptr(t, 'pointerdown', p, { button, buttons: 1 });
        mouse(t, 'mousedown', p, { button, buttons: 1 });
      } else if (a.op === 'up') {
        ptr(t, 'pointerup', p, { button });
        mouse(t, 'mouseup', p, { button });
      } else if (a.op === 'wheel') {
        t.dispatchEvent(new WheelEvent('wheel', base(p, { deltaX: Number(a.delta_x) || 0, deltaY: Number(a.delta_y) || 0 })));
        window.scrollBy(Number(a.delta_x) || 0, Number(a.delta_y) || 0);
      } else {
        ptr(t, 'pointerdown', p, { button, buttons: 1 });
        mouse(t, 'mousedown', p, { button, buttons: 1 });
        ptr(t, 'pointerup', p, { button });
        mouse(t, 'mouseup', p, { button });
        if (button === 2) mouse(t, 'contextmenu', p, { button });
        else {
          mouse(t, 'click', p, { button, detail: 1 });
          if (a.double) {
            mouse(t, 'click', p, { detail: 2 });
            mouse(t, 'dblclick', p, { detail: 2 });
          }
        }
      }
      return { ok: true, value: (a.op || 'click') + ' at ' + Math.round(p.x) + ',' + Math.round(p.y) + ' on ' + String(t.localName || 'page') + ' (simulated)' };
    }
    throw new Error('unknown pointer action ' + a.action);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Console capture for Firefox (Chrome and Edge read the console through the debugger instead): wraps the page's
// console methods with exportFunction, and records page errors and unhandled promise rejections.
// op 'install' only installs; op 'take' returns the entries (and clears them with clear: true).
function bmcpConsole(o) {
  try {
    const G = globalThis.__bmcpCon || (globalThis.__bmcpCon = { log: [], installed: false, since: Date.now() });
    const text = (a) => {
      if (typeof a === 'string') return a;
      if (a === undefined) return 'undefined';
      try {
        const raw = typeof XPCNativeWrapper !== 'undefined' && a && typeof a === 'object' ? XPCNativeWrapper.unwrap(a) : a;
        if (raw instanceof Error || (raw && raw.stack && raw.message)) return String(raw.name || 'Error') + ': ' + raw.message;
        const s = JSON.stringify(raw);
        return s === undefined ? String(raw) : s;
      } catch (e) {
        try { return String(a); } catch (e2) { return '[object]'; }
      }
    };
    const push = (level, args, where) => {
      if (G.off) return; // switched off in a tab the agent does not work in: pass-through only
      // Never let recording break the page's own script.
      try {
        const parts = [];
        for (let i = 0; i < args.length; i++) parts.push(text(args[i]));
        G.log.push({ level, text: parts.join(' ').slice(0, 2000), ts: Date.now(), where: where || '' });
        if (G.log.length > 500) G.log.shift();
      } catch (e) {}
    };
    if (o.op === 'uninstall') {
      // Not a tab the agent works in: put the page's console back and forget what was recorded.
      if (G.installed) {
        const w = typeof exportFunction === 'function' && window.wrappedJSObject;
        const c = w ? w.console : console;
        const same = (a, b) => {
          try { return typeof XPCNativeWrapper !== 'undefined' ? XPCNativeWrapper.unwrap(a) === XPCNativeWrapper.unwrap(b) : a === b; } catch (e) { return false; }
        };
        for (const [level, orig] of Object.entries(G.orig || {})) {
          // Put the original back only if our wrapper is still the one in place. If the site has wrapped it since,
          // leave the site's chain alone; our layer turns into a plain pass-through (G.off).
          try { if (same(c[level], G.fns[level])) c[level] = orig; } catch (e) {}
        }
        for (const [type, fn] of G.listeners || []) (w || window).removeEventListener(type, fn, true);
      }
      G.off = true;
      G.log = [];
      delete globalThis.__bmcpCon;
      return { ok: true, value: true };
    }
    if (!G.installed) {
      G.orig = {};
      G.fns = {};
      G.listeners = [];
      const w = typeof exportFunction === 'function' && window.wrappedJSObject;
      if (w) {
        const c = w.console;
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
          const orig = c[level];
          G.orig[level] = orig;
          // Rest parameters give a content-script array; the page's `arguments` object is not readable from here.
          const fn = exportFunction(function (...args) {
            push(level, args);
            return Function.prototype.apply.call(orig, c, args);
          }, w);
          c[level] = fn;
          G.fns[level] = c[level];
        }
      } else {
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
          const orig = console[level];
          G.orig[level] = orig;
          console[level] = function () { push(level, arguments); return orig.apply(console, arguments); };
          G.fns[level] = console[level];
        }
      }
      const onError = (e) => {
        try {
          const t = e.target;
          if (t && t.localName && t.localName !== 'html') {
            push('error', ['Failed to load ' + t.localName + ': ' + (t.src || t.href || '')]);
          } else {
            push('error', ['Uncaught ' + (e.message || 'error')], e.filename ? e.filename + ':' + e.lineno : '');
          }
        } catch (err) {}
      };
      const onRejection = (e) => { try { push('error', ['Unhandled promise rejection: ' + text(e.reason)]); } catch (err) {} };
      // On Firefox the listeners are added in the page's own world (exportFunction): Firefox stops delivering the
      // page's later error events to listeners that live in the content-script world.
      const target = w || window;
      for (const [type, fn] of [['error', onError], ['unhandledrejection', onRejection]]) {
        const h = w ? exportFunction(fn, w) : fn;
        target.addEventListener(type, h, true);
        G.listeners.push([type, h]);
      }
      G.installed = true;
    }
    if (o.op === 'take') {
      const out = G.log.slice();
      if (o.clear) G.log = [];
      return { ok: true, value: { entries: out, since: G.since } };
    }
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
