# Tool modules

Every `*.js` file in this folder adds tools to the MCP server. `server/mcp.js` loads them in file-name order when it
starts and lists their tools after the built-in ones, so a feature adds tools without editing `mcp.js`.
(This README keeps the folder in the repository while it holds no module.)

```js
'use strict';
// server/tools/storage.js
const { TAB } = require('../tool-modules'); // the schema of the tab parameter

module.exports = {
  tools: [
    {
      name: 'cookies',
      description: 'List the cookies of a tab.',
      inputSchema: { type: 'object', properties: { tab: TAB, name: { type: 'string' } }, required: ['tab'] },
    },
  ],
  // name: the tool that was called (one of this module's tools); args: its arguments; h: the helpers below.
  async run(name, args, h) {
    const { browser, result } = await h.send('cookies', args); // runs handlers.cookies in the extension
    return h.text(`${result.cookies.length} cookie(s) in ${browser}`);
  },
};
```

Rules:

- A tool name is lower-case letters, digits and `_`, and is unique over all modules and the built-in tools. A
  duplicate, a missing description or a missing `inputSchema` of type `object` stops the server at start-up with a
  message that names the file; `npm run check` finds the same problems without a browser.
- A module must load without side effects (no timers, no network, no files): `test/check.js` and `test/e2e.js` load
  the modules only to read their tool lists.
- `run` returns `h.text(...)`, a plain string, or a full MCP result (`{ content: [...], isError? }`). An error it
  throws reaches the agent as `Error: <message>`.

## The helpers: `h`

| Member | What it does |
|---|---|
| `h.send(tool, args, opts)` | Sends a call to the extension handler named `tool` (see `extension/src/feat-*.js`) and resolves to `{ browser, result }`: the id of the browser that answered and what the handler returned. `args.tab` (`"firefox:12"`) is turned into `tabId` and picks the browser; without a tab, `args.browser` picks it; every other member of `args` is passed on. `opts.tab: false` makes the tab optional (otherwise a missing tab throws `tab is required`). `opts.waitMs` is how long the handler may take: default `args.timeout_ms` or 30000, at most 120000. |
| `h.text(value)` | The MCP result for a text answer: `{ content: [{ type: 'text', text: String(value) }] }`. |
| `h.relayCall(method, params, timeoutMs)` | A raw relay call; starts the relay when it is not running. `h.relayCall('status', {}, 10000)` resolves to `{ version, port, browsers: [{ id, kind, name, extension }] }`; `h.relayCall('call', { browser, tool, args, timeoutMs }, timeoutMs + 45000)` resolves to `{ browser, result }`. |
| `h.parseTab(tab)` | `"firefox:12"` → `{ browser: 'firefox', tabId: 12 }`; `"12"` → `{ browser: undefined, tabId: 12 }`; anything else throws `tab must look like "firefox:12"`. |
| `h.handle(browser, tabId)` | The tab handle string: `"firefox:12"`. |
| `h.tabInfo(browser, r)` | The text the tools use for a tab: `tab: …`, `url: …`, `title: …` and the notes, from a result with `tabId`, `url`, `title`. |
| `h.tabLine(browser, t)` | One line of a tab list. |
| `h.fmtDialogs(list, hint)` | The `dialog: …` lines for the dialogs an action reported (`''` when there were none). |
| `h.TAB` | The schema of the tab parameter (the same object as `require('../tool-modules').TAB`). |
| `h.C` | `server/common.js`: `VERSION`, `PORT`, `HOME`, `OUTPUT_DIR`, `sleep`, `rpc`, … |

The other half of a feature lives in the extension: `extension/src/feat-<name>.js` registers the handlers that
`h.send` calls, and `test/e2e/<nn>-<group>.js` holds its end-to-end checks.
