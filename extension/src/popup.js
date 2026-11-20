'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const TEXT = {
  connected: 'Connected',
  offline: 'Paired, but the relay is not running (it starts with the next MCP session)',
  unpaired: 'Not paired yet',
  badtoken: 'The relay rejected the pairing token; pair again',
};

let loaded = false;
let shownHandoffs = '';

// Open handoffs, as a fallback for pages where the in-page card cannot be shown.
async function refreshHandoffs() {
  let list = [];
  try { list = (await api.runtime.sendMessage({ type: 'bmcp-handoffs' })).handoffs || []; } catch (e) {}
  const key = JSON.stringify(list.map((h) => [h.tabId, h.message, h.title]));
  if (key === shownHandoffs) return;
  shownHandoffs = key;
  const box = $('handoffs');
  box.textContent = '';
  for (const h of list) {
    const div = document.createElement('div');
    div.className = 'ho';
    const head = document.createElement('b');
    head.textContent = 'Your AI agent is waiting for you';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = h.message;
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.textContent = 'Tab: ' + (h.title || h.tabId);
    const row = document.createElement('div');
    row.className = 'row';
    for (const [label, decision] of [['Cancel', 'cancel'], ['Continue', 'continue']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', async () => {
        await api.runtime.sendMessage({ type: 'bmcp-handoff-done', tabId: h.tabId, decision });
        refreshHandoffs();
      });
      row.appendChild(b);
    }
    div.append(head, msg, tab, row);
    box.appendChild(div);
  }
}

async function refresh() {
  try {
    const s = await api.runtime.sendMessage({ type: 'bmcp-status' });
    $('st').textContent = TEXT[s.status] || s.status;
    $('st').className = s.status === 'connected' ? 'ok' : 'bad';
    if (!loaded) {
      $('name').value = s.name;
      $('port').value = s.port;
      loaded = true;
    }
  } catch (e) {
    $('st').textContent = 'The extension background is not responding';
    $('st').className = 'bad';
  }
}

$('save').addEventListener('click', async () => {
  const set = { name: $('name').value.trim().slice(0, 24), port: Number($('port').value) || 19789 };
  const token = $('token').value.trim();
  if (token) {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      $('st').textContent = 'That is not a valid token (64 hex characters expected)';
      $('st').className = 'bad';
      return;
    }
    set.token = token;
  }
  await api.storage.local.set(set);
  $('token').value = '';
  await api.runtime.sendMessage({ type: 'bmcp-reconnect' });
  refresh();
});

$('unpair').addEventListener('click', async () => {
  await api.storage.local.remove('token');
  await api.runtime.sendMessage({ type: 'bmcp-reconnect' });
  refresh();
});

refresh();
refreshHandoffs();
setInterval(() => { refresh(); refreshHandoffs(); }, 1000);
