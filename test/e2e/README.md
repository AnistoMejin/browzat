# End-to-end sections

`test/e2e.js` holds the built-in checks (the group `core`). Every other feature keeps its checks in a file of its
own in this folder, so two features never edit the same test file.

- File name: `<nn>-<group>.js`, for example `30-storage.js`. Files run in name order, after the built-in checks and
  before the final tab-list and close checks. The group is the part after the number; it must be unique and not `core`.
- A file whose name starts with `_` is ignored (shared helpers). Any other `.js` name is an error.
- The file exports one function: `module.exports = async (t) => { ... };`
- A section that throws counts as one failed check and does not stop the other sections. The tabs it opened, its
  routes and its temporary folder are removed afterwards, also when it fails.
- A section must not depend on another section: `E2E_ONLY` runs them alone.

Run them:

```bash
node test/bed.js                                  # everything, on throwaway browsers
node test/bed.js --only storage                   # one group (E2E_ONLY=storage does the same)
node test/bed.js --only storage --browsers firefox
E2E_ONLY=core,storage node test/e2e.js firefox    # against a browser that is already running and paired
```

## What a section gets: `t`

| Member | What it is |
|---|---|
| `t.call(name, args)` | Calls an MCP tool. Resolves to `{ text, image, isError }`: `text` is the joined text content, `image` the base64 data of an image (or undefined). Tool errors do not throw; they come back with `isError: true`. |
| `t.check(name, ok, detail)` | Records one check. Prints `PASS  <group>: <name>` or `FAIL  <group>: <name>` followed by `detail`. |
| `t.open(path, args)` | Opens a new agent tab and resolves to its handle (`"firefox:12"`). `path` is a path on the test server (default `/form`, the built-in test form) or a full URL. `args` are extra `tabs` arguments such as `{ active: true }` or `{ container: 'Work' }`. Throws when the tab cannot be opened. |
| `t.close(tab)` | Closes a tab. Not needed at the end of a section: tabs the section opened are closed for it. |
| `t.route(pathPrefix, handler)` | Adds a page or an API to the local test server for the rest of this section and returns its full URL. `handler` is a function `(req, res, url)` (Node's request and response, `url` a parsed `URL`; it must end the response), or a string (served as an HTML page), or `{ status, headers, body }`. The longest matching prefix wins. Use a prefix of your own, such as `/<group>/...`. |
| `t.poll(fn, timeoutMs = 5000, everyMs = 200)` | Calls `fn` (may be async) until it returns something truthy or the time is up; resolves to the last value. Use it instead of a fixed sleep: background tabs run timers late. |
| `t.evaluate(tab, code)` | `evaluate` in the tab; resolves to the trimmed text of the result. |
| `t.snapshot(tab, args)` | `snapshot` of the tab; resolves to its text. |
| `t.refOf(snapshotText, regExp)` | The first capture group of `regExp` in the snapshot, or `null`. Example: `t.refOf(snap, /button "Save" \[(e\d+)\]/)`. |
| `t.sleep(ms)` | A promise that resolves after `ms`. |
| `t.base` | `http://127.0.0.1:<port>` of the local test server (a free port chosen at run time). |
| `t.browser` | The browser id the run was started with, for example `firefox` or `chromium`. |
| `t.firefox`, `t.chromium` | Whether the browser is Firefox, or a Chromium-family browser (Chrome, Edge, Chromium). |
| `t.real` | `true` under `E2E_REAL=1`: the browser is the user's real profile. Never list, change or close tabs the section did not open. |
| `t.tools` | The answer of `tools/list`: an array of `{ name, description, inputSchema }`. |
| `t.tmp` | A folder for this section's files (created on first use, deleted afterwards). |
| `t.group` | The group name of this section. |

## Example

```js
'use strict';
// test/e2e/30-storage.js
module.exports = async (t) => {
  t.route('/storage/page', '<!doctype html><title>Storage</title><button id="b">Go</button><p id="o">idle</p>' +
    '<script>b.onclick = () => fetch("/storage/api").then((r) => r.json()).then((j) => { o.textContent = "got " + j.n; });</script>');
  t.route('/storage/api', { headers: { 'content-type': 'application/json' }, body: '{"n":7}' });

  const tab = await t.open('/storage/page');
  await t.call('click', { tab, selector: '#b' });
  const text = await t.poll(async () => /got/.test(await t.evaluate(tab, 'document.getElementById("o").textContent')) && 'got', 5000);
  t.check('the page reads its API', text === 'got', text);
};
```
