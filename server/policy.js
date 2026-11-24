'use strict';
// Cross-cutting tool visibility, site policy, response shaping and secret-free audit records.
const fs = require('fs');
const path = require('path');

const SLIM = ['status', 'tabs', 'navigate', 'snapshot', 'click', 'type', 'press_key', 'wait_for', 'screenshot', 'handoff'];
const STANDARD = SLIM.concat(['hover', 'drag', 'mouse', 'upload', 'dialog', 'console_messages', 'verify', 'inspect', 'fill_form', 'scroll']);
const GROUPS = {
  storage: ['cookies', 'storage', 'storage_state', 'container'], output: ['screenshot', 'pdf', 'emulate'],
  performance: ['performance'], checks: ['verify', 'inspect', 'fill_form', 'scroll', 'highlight', 'audit', 'logpoints'],
  network: ['network_requests', 'network_request', 'network_route', 'network_conditions', 'console_messages'],
};

function list(value) { return Array.isArray(value) ? value.map(String) : String(value || '').split(',').map((x) => x.trim()).filter(Boolean); }
function bool(value, fallback) { if (value == null) return fallback; return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase()); }
function hostMatch(host, pattern) { pattern = String(pattern).toLowerCase().replace(/^\*\./, '.'); return pattern.startsWith('.') ? host === pattern.slice(1) || host.endsWith(pattern) : host === pattern; }

function loadConfig(C) {
  let file = {};
  const configPath = path.join(C.HOME, 'config.json');
  try { file = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read ${configPath}: ${e.message}`); }
  return {
    tools: process.env.BROWSER_MCP_TOOLS || file.tools || 'all',
    evaluate: bool(process.env.BROWSER_MCP_EVALUATE != null ? process.env.BROWSER_MCP_EVALUATE : file.evaluate, true),
    block: list(process.env.BROWSER_MCP_BLOCK || file.block), allow: list(process.env.BROWSER_MCP_ALLOW || file.allow),
    max: Math.min(Math.max(Number(process.env.BROWSER_MCP_MAX_RESULT_CHARS || file.max_result_chars) || 80000, 1000), 1000000),
    audit: bool(process.env.BROWSER_MCP_AUDIT != null ? process.env.BROWSER_MCP_AUDIT : file.audit, true),
  };
}

function selectTools(tools, setting, evaluate) {
  const all = new Set(tools.map((x) => x.name));
  let chosen;
  const parts = list(setting);
  if (!parts.length || parts.includes('all')) chosen = new Set(all);
  else if (parts.includes('slim')) chosen = new Set(SLIM);
  else if (parts.includes('standard')) chosen = new Set(STANDARD);
  else chosen = new Set(['status']);
  for (const part of parts) {
    const remove = part.startsWith('-'); const key = remove ? part.slice(1) : part;
    const names = GROUPS[key] || [key];
    for (const name of names) if (remove) chosen.delete(name); else if (all.has(name)) chosen.add(name);
  }
  if (!evaluate) chosen.delete('evaluate');
  chosen.add('status');
  return tools.filter((x) => chosen.has(x.name));
}

function create(tools, C) {
  const config = loadConfig(C);
  const visible = selectTools(tools, config.tools, config.evaluate);
  const names = new Set(visible.map((x) => x.name));
  const auditFile = path.join(C.HOME, 'audit.jsonl');
  function before(name, args) {
    if (!names.has(name)) throw new Error(`tool ${name} is disabled by this server's tool preset`);
    if (!config.evaluate && (name === 'evaluate' || args && (args.code != null || args.init_script != null || args.expression != null))) throw new Error('agent-supplied JavaScript is disabled on this server (evaluate: off)');
    for (const key of ['url']) if (args && args[key]) {
      let host = ''; try { host = new URL(args[key]).hostname.toLowerCase(); } catch (e) { continue; }
      if (config.allow.length && !config.allow.some((x) => hostMatch(host, x))) throw new Error(`site ${host} is outside this server's allow list`);
      if (config.block.some((x) => hostMatch(host, x))) throw new Error(`site ${host} is blocked on this server`);
    }
  }
  function shape(result) {
    if (!result || !Array.isArray(result.content)) return result;
    for (const item of result.content) if (item.type === 'text' && item.text.length > config.max) {
      fs.mkdirSync(C.OUTPUT_DIR, { recursive: true });
      const file = path.join(C.OUTPUT_DIR, `result-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`);
      fs.writeFileSync(file, item.text, { flag: 'wx', mode: 0o600 });
      item.text = item.text.slice(0, config.max) + `\n… cut at ${config.max} characters\nfull result: ${file}`;
    }
    return result;
  }
  function record(name, args, started, result, error) {
    if (!config.audit) return;
    try {
      fs.mkdirSync(C.HOME, { recursive: true });
      const chars = result && result.content ? result.content.reduce((n, x) => n + (x.text || '').length + (x.data || '').length, 0) : 0;
      const row = { time: new Date().toISOString(), tool: name, browser: args && args.browser || '', tab: args && args.tab || '', duration_ms: Date.now() - started,
        ok: !error && !(result && result.isError), result_chars: chars };
      if (error) row.error = String(error.message || error).slice(0, 300);
      fs.appendFileSync(auditFile, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (e) {}
  }
  return { config, tools: visible, before, shape, record };
}

module.exports = { create, loadConfig, selectTools };
