# Reference map: where other projects implement what browzat is missing

Read-only clones (shallow, `--depth 1`, 2026-11-20) live outside this repository in
`C:\Entelegen\Projects\browzat-reference\<owner>__<repo>`. Nothing there is installed or run; it is for reading.
All ten are MIT or Apache-2.0. When code is adapted rather than re-written, keep the original copyright notice in
the file header (both licenses require it) and add a line to the commit message.

| Repository | Commit | License | Closest to browzat because |
|---|---|---|---|
| railsblueprint/blueprint-mcp | 699be5e | Apache-2.0 | Plain-JS extension with separate Chrome and Firefox builds, WebSocket to a local server |
| junyeong-nero/kitsune | 77ef481 | MIT | Firefox-first; handoff, tool approvals, audit |
| boot-industries/claudezilla | 5e4a237 | MIT | Firefox add-on; tab ownership per agent, lazy tool loading |
| eyalzh/browser-control-mcp | e53f0e5 | MIT | Firefox add-on; per-domain consent, audit log, tab groups |
| anomalyco/browse | ae5d9d0 | MIT | Chromium; handoff card, tab grouping, console and network capture |
| remorses/playwriter | cde94d0 | MIT | Chromium; trusted input through `chrome.debugger`, tab groups, several browsers |
| BrowserMCP/mcp | a51ddc4 | Apache-2.0 | Chromium; pairing, tab groups, file upload |
| mozilla/firefox-mcp | 02c5df8 | Apache-2.0 | Firefox through WebDriver BiDi; console, network, downloads, tool presets |
| ChromeDevTools/chrome-devtools-mcp | eb9b030 | Apache-2.0 | Console, network, performance; response shaping |
| microsoft/playwright-mcp | 2337aff | Apache-2.0 | Wrapper only; the code is in microsoft/playwright (`packages/playwright/src/mcp`) |

## Feature → where to look

| browzat roadmap item | Best reference (file) | Notes |
|---|---|---|
| 1. Handoff | kitsune `extension/background/background.js` (handoffs, handoffRequests, badge); browse `cli/src/execute.ts` (card text "Sign in to {origin}, then click Continue"), `cli/src/agent-guide.ts` (agent instructions) | browse blocks `bringToFront` and asks for a handoff instead |
| 2. Trusted input (Chromium) | playwriter `extension/src/background.ts`; blueprint `extensions/chrome/src/background-module.js`; browse `cli/src/execute/human-input.ts` | `chrome.debugger.sendCommand` with `Input.dispatchMouseEvent` / `Input.insertText`; Firefox has no `debugger` API |
| 3. File upload | blueprint `server/src/unifiedBackend.js`; kitsune `extension/content/content.js` (`DataTransfer`); BrowserMCP `packages/mcp/src/commands/commands.ts` | Chromium: `DOM.setFileInputFiles`; Firefox: build a `File` and set `input.files` through `DataTransfer` |
| 4. Agent tab group | browse `src/background/agent-relay/grouping.ts`; playwriter `extension/src/background.ts`; eyalzh `firefox-extension/message-handler.ts` (Firefox `tabGroups`) | |
| 6. Approvals, audit, presets | kitsune `extension/background/tool-approvals.js`; eyalzh `firefox-extension/extension-config.ts`; claudezilla `extension/background.js` (lazy mode); firefox-mcp tool presets | |
| 7. Network and console | kitsune `extension/background/background.js` (`webRequest`); blueprint `extensions/shared/handlers/captureCommands.js`; browse `cli/src/execute/console.ts`; firefox-mcp `src/firefox/events/console.ts` | |
