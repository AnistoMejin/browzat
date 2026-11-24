'use strict';
// Feature modules of the MCP server: every server/tools/*.js adds tools without an edit to mcp.js.
//   module.exports = { tools: [{ name, description, inputSchema }, ...], run: async (name, args, h) => result };
// The contract is described in server/tools/README.md.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'tools');
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
// The schema of the tab parameter, shared by the built-in tools and the modules.
const TAB = { type: 'string', description: 'Tab handle returned by tabs, like "firefox:12".' };

// Loads the modules in file-name order: [{ file, tools, run }]. Throws with a clear message on a broken module.
function loadToolModules(dir) {
  dir = dir || DIR;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return files.map((f) => {
    const file = 'server/tools/' + f;
    let m;
    try {
      m = require(path.join(dir, f));
    } catch (e) {
      throw new Error(`${file} did not load: ${(e && e.message) || e}`);
    }
    if (!m || !Array.isArray(m.tools) || typeof m.run !== 'function') {
      throw new Error(`${file} must export { tools: [...], run: async (name, args, h) => result }`);
    }
    for (const t of m.tools) {
      const name = t && t.name;
      if (typeof name !== 'string' || !NAME.test(name)) {
        throw new Error(`${file}: a tool name must be lower-case letters, digits and "_", starting with a letter (got ${JSON.stringify(name)})`);
      }
      if (typeof t.description !== 'string' || !t.description.trim()) throw new Error(`${file}: the tool "${name}" needs a description`);
      if (!t.inputSchema || t.inputSchema.type !== 'object') throw new Error(`${file}: the tool "${name}" needs an inputSchema of type "object"`);
    }
    return { file, tools: m.tools, run: m.run };
  });
}

// The built-in tools followed by the modules' tools, and who runs each module tool.
// Throws when two tools have the same name.
function mergeTools(builtin, modules) {
  const tools = builtin.slice();
  const from = new Map(builtin.map((t) => [t.name, 'server/mcp.js (built in)']));
  const owner = new Map(); // tool name -> its module
  for (const m of modules) {
    for (const t of m.tools) {
      if (from.has(t.name)) throw new Error(`the tool name "${t.name}" is used twice: in ${from.get(t.name)} and in ${m.file}`);
      from.set(t.name, m.file);
      owner.set(t.name, m);
      tools.push(t);
    }
  }
  return { tools, owner };
}

module.exports = { loadToolModules, mergeTools, TAB };
