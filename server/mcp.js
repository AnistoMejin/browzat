'use strict';
// MCP server (stdio). Thin: every tool call is forwarded to the relay, which forwards it to a browser extension.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const C = require('./common');

const TAB = { type: 'string', description: 'Tab handle returned by tabs, like "firefox:12".' };
const TOOLS = [
  {
    name: 'status',
    description: "Show which of the user's browsers (firefox, chrome, edge) are connected. Call it when a tool says no browser is connected.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs',
    description: "List, open, close or focus tabs in the user's real, logged-in browser. new opens a background tab and returns its handle. list shows only the tabs you opened unless all is true. Close only tabs you opened. In Firefox, containers lists the Multi-Account Containers and new can open a tab in one.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'activate', 'containers'] },
        container: { type: 'string', description: 'new, Firefox only: name of the container to open the tab in.' },
        browser: { type: 'string', description: 'firefox, chrome or edge. Needed for new when several browsers are connected.' },
        url: { type: 'string', description: 'new: the page to open.' },
        tab: TAB,
        all: { type: 'boolean', description: "list: include the user's own tabs." },
        active: { type: 'boolean', description: 'new: bring the tab to the front.' },
        force: { type: 'boolean', description: 'close: allow closing a tab you did not open, only when the user asks.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'navigate',
    description: 'Go to a URL in a tab, or go back, forward or reload. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        url: { type: 'string' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
        timeout_ms: { type: 'number' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'snapshot',
    description: 'Read a page as a compact text outline. Interactive elements carry refs like [e12] that click and type accept. Password values are masked. Prefer this over screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        interactive: { type: 'boolean', description: 'Only interactive elements.' },
        find: { type: 'string', description: 'Only lines containing this text.' },
        selector: { type: 'string', description: 'CSS selector: read only this part of the page.' },
        frames: { type: 'boolean', description: 'Also read iframes.' },
        hrefs: { type: 'boolean', description: 'Show link targets.' },
        max_chars: { type: 'number', description: 'Default 10000.' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'click',
    description: 'Click an element by snapshot ref or CSS selector. Chrome and Edge use real mouse input (pages trust it); Firefox simulates it. Reports the new URL if the page navigated, and any alert/confirm/prompt the click caused.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        ref: { type: 'string' },
        selector: { type: 'string' },
        double: { type: 'boolean' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
      },
      required: ['tab'],
    },
  },
  {
    name: 'type',
    description: 'Set the text of a field, or choose an option of a select by its label. Replaces the current value unless clear is false. submit presses Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        submit: { type: 'boolean' },
      },
      required: ['tab', 'text'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a key such as Enter, Escape, Tab, ArrowDown, PageDown or Control+a on an element, or on the focused element when no ref is given.',
    inputSchema: {
      type: 'object',
      properties: { tab: TAB, key: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' } },
      required: ['tab', 'key'],
    },
  },
  {
    name: 'evaluate',
    description: "Run JavaScript in the page and return the result. Give an expression, or a function body with return. Firefox runs it in the extension's content-script world (page variables are under window.wrappedJSObject). Chrome and Edge run it in the page, which fails on sites whose CSP forbids eval.",
    inputSchema: {
      type: 'object',
      properties: { tab: TAB, code: { type: 'string' } },
      required: ['tab', 'code'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until text or a CSS selector appears (or disappears, with gone), or simply wait time_ms.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        text: { type: 'string' },
        selector: { type: 'string' },
        gone: { type: 'boolean' },
        timeout_ms: { type: 'number', description: 'Default 10000.' },
        time_ms: { type: 'number' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible part of a tab as an image. Costs far more than snapshot; use it only when layout or visuals matter.',
    inputSchema: {
      type: 'object',
      properties: { tab: TAB, max_width: { type: 'number', description: 'Default 1280.' } },
      required: ['tab'],
    },
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (menus, tooltips). Real mouse on Chrome and Edge; simulated events on Firefox (CSS :hover does not apply there).',
    inputSchema: {
      type: 'object',
      properties: { tab: TAB, ref: { type: 'string' }, selector: { type: 'string' } },
      required: ['tab'],
    },
  },
  {
    name: 'drag',
    description: 'Drag one element onto another (HTML5 drag and drop or mouse-based sortable lists).',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        from_ref: { type: 'string' },
        from_selector: { type: 'string' },
        to_ref: { type: 'string' },
        to_selector: { type: 'string' },
      },
      required: ['tab'],
    },
  },
  {
    name: 'mouse',
    description: 'Mouse action at viewport coordinates in CSS pixels: click (default), move, down, up or wheel. For canvases, maps and sliders where there is no element to target.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        op: { type: 'string', enum: ['click', 'move', 'down', 'up', 'wheel'] },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean' },
        delta_x: { type: 'number', description: 'wheel: horizontal scroll in pixels.' },
        delta_y: { type: 'number', description: 'wheel: vertical scroll in pixels.' },
      },
      required: ['tab', 'x', 'y'],
    },
  },
  {
    name: 'upload',
    description: 'Put local files into a file input. Target the <input type=file> or the button that opens the file chooser. files are absolute paths on this computer.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        ref: { type: 'string' },
        selector: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to upload.' },
      },
      required: ['tab', 'files'],
    },
  },
  {
    name: 'dialog',
    description: "Set how the page's next alert/confirm/prompt is answered, before the action that opens it. Without this, alerts are accepted and confirm/prompt are dismissed, and the action's result reports each dialog. keep applies the answer to every dialog on this page.",
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        text: { type: 'string', description: 'prompt: the text to answer with.' },
        keep: { type: 'boolean' },
      },
      required: ['tab', 'action'],
    },
  },
  {
    name: 'handoff',
    description:
      'Ask the user to do something only a person can do in a tab (log in, 2FA, passkey, captcha, payment or delete ' +
      'confirmation, a click the site refuses from the agent), then wait. The tab comes to the front with a card showing ' +
      'your message and Continue / Cancel. Returns when the user answers, the tab closes, or timeout_s passes. ' +
      'Never solve a captcha yourself; hand off instead.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: TAB,
        message: { type: 'string', description: 'What the user should do, in one or two short sentences.' },
        timeout_s: { type: 'number', description: 'How long to wait. Default 300, maximum 600.' },
      },
      required: ['tab', 'message'],
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const INSTRUCTIONS =
  "Drives the user's own logged-in Firefox, Chrome and Edge through the browzat extension. " +
  'Open a tab with tabs (action new), read it with snapshot, then act on refs like e12 with click and type. ' +
  'Work only in tabs you opened unless the user asks for one of theirs. ' +
  'When only a person can proceed (login, 2FA, passkey, captcha, a confirmation the site will not accept from you), ' +
  'call handoff with a short instruction and wait, instead of asking in chat or retrying.';

const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
const handle = (browser, id) => `${browser}:${id}`;

function tabLine(browser, t) {
  return `${handle(browser, t.tabId)}${t.container ? ' [' + t.container + ']' : ''}${t.agent ? '' : ' (user tab)'}${t.active ? ' *' : ''}  ${t.title || ''}  ${t.url || ''}`;
}

function tabInfo(browser, r) {
  return `tab: ${handle(browser, r.tabId)}\nurl: ${r.url || ''}\ntitle: ${r.title || ''}` +
    (r.container ? `\ncontainer: ${r.container}` : '') +
    (r.reopened ? '\nnote: the containers add-on reopened this site in its assigned container; this is the new tab, use this handle' : '') +
    (r.timedOut ? '\nnote: the page was still loading when the wait ended' : '');
}

function fmtDialogs(list, hint) {
  if (!Array.isArray(list) || !list.length) return '';
  const lines = list.map((d) => `\ndialog: ${d.kind} ${JSON.stringify(d.message)} -> ${d.answer}${d.text != null ? ' with ' + JSON.stringify(d.text) : ''}`);
  const dismissed = list.some((d) => d.answer === 'dismissed');
  return lines.join('') + (hint && dismissed ? '\nnote: to accept it instead, call dialog with action accept, then repeat the action' : '');
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
  zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const UPLOAD_LIMIT = 50 * 1024 * 1024;

// Checks the files exist. Chrome and Edge read them from disk themselves; Firefox gets their contents.
async function uploadFiles(list, browser) {
  list = (Array.isArray(list) ? list : [list]).filter((f) => f != null && String(f).trim());
  if (!list.length) throw new Error('files is required: absolute paths of the files to upload');
  const st = await relayCall('status', {}, 10000);
  const b = st.browsers.find((x) => x.id === browser) || st.browsers.find((x) => x.kind === browser);
  const firefox = (b ? b.kind : browser) === 'firefox';
  let total = 0;
  return list.map((f) => {
    const p = path.resolve(String(f).trim());
    let s;
    try { s = fs.statSync(p); } catch { throw new Error('file not found: ' + p); }
    if (!s.isFile()) throw new Error('not a file: ' + p);
    total += s.size;
    if (firefox && total > UPLOAD_LIMIT) throw new Error('Firefox uploads are limited to 50 MB in total');
    const o = { path: p, name: path.basename(p), size: s.size, type: MIME[path.extname(p).slice(1).toLowerCase()] || '', mtime: Math.round(s.mtimeMs) };
    if (firefox) o.data = fs.readFileSync(p).toString('base64');
    return o;
  });
}

async function relayCall(method, params, timeoutMs) {
  try {
    return await C.rpc(method, params, timeoutMs);
  } catch (e) {
    // Relay not running (first call, or it was stopped): start it and retry once.
    if (!/fetch failed|ECONNREFUSED|token is missing/i.test(String((e && e.message) || e) + String((e && e.cause) || ''))) throw e;
    await C.ensureRelay();
    return C.rpc(method, params, timeoutMs);
  }
}

function fmtStatus(s) {
  const lines = [`relay ${s.version} on 127.0.0.1:${s.port}`];
  if (!s.browsers.length) {
    lines.push('no browser is connected. The browser must be running with the browzat extension installed and paired.');
  } else {
    for (const b of s.browsers) lines.push(`${b.id}  (${b.kind}, extension ${b.extension || '?'})`);
  }
  return lines.join('\n');
}

async function listAllTabs(a) {
  const s = await relayCall('status', {}, 10000);
  if (!s.browsers.length) return text(fmtStatus(s));
  const lines = [];
  for (const b of s.browsers) {
    try {
      const out = await relayCall('call', { browser: b.id, tool: 'tabs', args: { action: 'list', all: !!a.all } }, 30000);
      const r = out.result;
      if (r.tabs.length) for (const t of r.tabs) lines.push(tabLine(b.id, t));
      else lines.push(`${b.id}: no tabs opened by you (${r.total} tabs in total; pass all:true to see the user's)`);
    } catch (e) {
      lines.push(`${b.id}: ${e.message}`);
    }
  }
  return text(lines.join('\n'));
}

async function runTool(name, a) {
  if (!TOOL_NAMES.has(name)) throw new Error('unknown tool ' + name);
  if (name === 'status') return text(fmtStatus(await relayCall('status', {}, 10000)));
  if (name === 'tabs' && (a.action || 'list') === 'list' && !a.browser) return listAllTabs(a);

  let browser = a.browser;
  if (!browser && name === 'tabs' && (a.action === 'containers' || a.container)) browser = 'firefox'; // containers are a Firefox feature
  const args = Object.assign({}, a);
  delete args.browser;
  delete args.tab;
  if (a.tab != null && a.tab !== '') {
    const m = /^(?:([a-z0-9-]+):)?(\d+)$/i.exec(String(a.tab).trim());
    if (!m) throw new Error('tab must look like "firefox:12"');
    if (m[1]) browser = m[1].toLowerCase();
    args.tabId = Number(m[2]);
  } else if (name !== 'tabs' || a.action === 'close' || a.action === 'activate') {
    throw new Error('tab is required');
  }

  if (name === 'upload') args.files = await uploadFiles(a.files, browser);

  const wait = name === 'handoff'
    ? Math.min(Math.max((Number(a.timeout_s) || 300) * 1000, 10000), 600000)
    : Math.min(Math.max(Number(a.timeout_ms || a.time_ms) || 30000, 1000), 120000);
  const out = await relayCall('call', { browser, tool: name, args, timeoutMs: wait + 15000 }, wait + 60000);
  const b = out.browser;
  const r = out.result || {};

  switch (name) {
    case 'tabs':
      if (a.action === 'new') return text(tabInfo(b, r));
      if (a.action === 'close') return text(`closed ${handle(b, r.closed)}`);
      if (a.action === 'activate') return text(`focused ${handle(b, r.tabId)}`);
      if (a.action === 'containers') return text(r.containers.length ? `containers in ${b}: ${r.containers.join(', ')}` : `no containers are defined in ${b}`);
      return text(
        r.tabs.length
          ? r.tabs.map((t) => tabLine(b, t)).join('\n')
          : `${b}: no tabs opened by you (${r.total} tabs in total; pass all:true to see the user's)`
      );
    case 'navigate':
      return text(tabInfo(b, r));
    case 'snapshot':
      return text(
        `${r.url}\n${r.title}\n\n${r.text}` +
        (r.truncated ? '\n… cut off here. Narrow it with find, selector or interactive, or raise max_chars.' : '')
      );
    case 'click':
    case 'type':
    case 'press_key':
    case 'hover':
    case 'drag':
    case 'mouse':
    case 'upload':
    case 'dialog':
      return text(r.done + (r.note ? `\nnote: ${r.note}` : '') + fmtDialogs(r.dialogs, name !== 'dialog') + (r.navigated ? `\nurl now: ${r.url}` : ''));
    case 'evaluate': {
      const v = String(r.value);
      return text(v.length > 20000 ? v.slice(0, 20000) + '\n… cut off at 20000 characters' : v);
    }
    case 'wait_for':
      return text(r.waited != null ? `waited ${r.waited} ms` : `ok after ${r.ms} ms`);
    case 'screenshot': {
      const m = /^data:(image\/\w+);base64,(.+)$/s.exec(r.dataUrl || '');
      if (!m) throw new Error('the browser returned no image');
      fs.mkdirSync(C.OUTPUT_DIR, { recursive: true });
      const file = path.join(C.OUTPUT_DIR, `shot-${Date.now()}.${m[1] === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      return {
        content: [
          { type: 'image', data: m[2], mimeType: m[1] },
          {
            type: 'text',
            text: `saved: ${file}${r.width ? ` (${r.width}x${r.height})` : ''}` +
              (r.raised ? '\nnote: the browser window was covered or minimised, so it was brought to the front to capture it' : ''),
          },
        ],
      };
    }
    case 'handoff': {
      const secs = Math.round((r.ms || 0) / 1000);
      const where = `\nurl now: ${r.url || ''}\ntitle: ${r.title || ''}`;
      const card = r.cardError ? `\nnote: the in-page card could not be shown (${r.cardError}); the user answered from the extension's toolbar popup` : '';
      const via = r.via ? ` (in the ${r.via === 'popup' ? "toolbar popup" : 'card on the page'})` : '';
      if (r.decision === 'continue') return text(`the user clicked Continue${via} after ${secs} s${where}${card}`);
      const why = {
        cancel: `the user clicked Cancel${via}`,
        timeout: `nobody answered within ${secs} s`,
        closed: 'the tab was closed',
        replaced: 'a newer handoff replaced this one',
      }[r.decision] || `handoff ended: ${r.decision}`;
      return { content: [{ type: 'text', text: `${why}. Do not continue this step; tell the user.${where}${card}` }], isError: true };
    }
    default:
      return text(JSON.stringify(r));
  }
}

const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18'];
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to something we never asked
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      const want = params && params.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[SUPPORTED.length - 1],
        capabilities: { tools: {} },
        serverInfo: { name: 'browser-mcp', version: C.VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try {
        return reply(id, await runTool(params && params.name, (params && params.arguments) || {}));
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'Error: ' + String((e && e.message) || e) }], isError: true });
      }
    }
    return replyError(id, -32601, 'method not found: ' + method);
  } catch (e) {
    return replyError(id, -32603, String((e && e.message) || e));
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  onMessage(msg);
});
rl.on('close', () => process.exit(0));

// Start the relay early so the extensions are connected before the first tool call.
C.ensureRelay().catch(() => {});
