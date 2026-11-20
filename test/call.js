'use strict';
// Calls one tool through the MCP server and prints the text result:  node test/call.js <tool> '<json arguments>'
const { spawn } = require('child_process');
const path = require('path');

const [tool, json] = process.argv.slice(2);
const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
mcp.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === 1) {
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: JSON.parse(json || '{}') } }) + '\n');
    } else if (m.id === 2) {
      const c = (m.result && m.result.content) || [];
      for (const x of c) console.log(x.type === 'text' ? x.text : `[${x.type}, ${x.data.length} base64 characters]`);
      if (m.error) console.log('RPC ERROR ' + JSON.stringify(m.error));
      mcp.kill();
      process.exit(m.result && m.result.isError ? 1 : 0);
    }
  }
});
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'call', version: '1' } } }) + '\n');
