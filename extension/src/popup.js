'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const TEXT = {
  connected: 'Connected to the relay',
  offline: 'Paired, but the relay is not running (it starts with the next MCP session)',
  unpaired: 'Not paired yet',
  badtoken: 'The relay rejected the pairing token; pair again',
};

let loaded = false;

async function refresh() {
  try {
    const s = await api.runtime.sendMessage({ type: 'bmcp-status' });
    $('st').textContent = (TEXT[s.status] || s.status) + (s.status === 'connected' ? ' as "' + s.relayId + '"' : '');
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
setInterval(refresh, 1000);
