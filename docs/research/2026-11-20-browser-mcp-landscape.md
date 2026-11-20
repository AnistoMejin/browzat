# Browser MCP landscape (research, 2026-11-20)

How browzat compares with other MCP servers that let an AI agent use a browser, and what to build next.

## Method

- GitHub repository search through the API with a personal token, 24 queries (for example `browser mcp`,
  `mcp chrome extension`, `mcp firefox`, `topic:mcp topic:browser`), sorted by stars, up to 200 results each,
  paced at about one search every 2 s. No rate limit was hit.
- 2,727 unique repositories found; 2,512 left after keeping non-fork repositories whose name, description or
  topics mention both MCP and a browser term. 217 have 100 or more stars, 48 have 1,000 or more.
- The READMEs of the 18 closest competitors were downloaded and read. Feature statements below come from those
  READMEs only; the code was not tested. Star counts and dates are as of 2026-11-20.

## The field in three groups

### 1. Large projects that drive a separate or debug-enabled browser

| Repository | Stars | How it reaches the browser | Notes |
|---|---:|---|---|
| ChromeDevTools/chrome-devtools-mcp | 58,492 | Chrome DevTools Protocol | Chrome and Chrome for Testing only. Sends usage statistics to Google unless switched off. |
| microsoft/playwright-mcp | 39,933 | Playwright; `--extension` mode attaches to a running Chrome or Edge | Extension mode puts agent tabs in a named, coloured tab group, can stay in the background, and can pick a profile (`--profile-dir-name`). No Firefox in extension mode. |
| browser-use/browser-harness | 19,167 | Real Chrome through `chrome://inspect` remote debugging | Now the engine of browser-use. Chrome only. |

### 2. Extensions that drive your own logged-in Chromium browser

| Repository | Stars | Notes |
|---|---:|---|
| hangwin/mcp-chrome | 12,554 | Chrome extension, 20+ tools, history, bookmarks, network monitoring, semantic search over tabs. Last push 2026-01. |
| BrowserMCP/mcp | 7,391 | Chrome Web Store extension and `npx @browsermcp/mcp`. Per-server **Allow** in the popup. States that Firefox has no `debugger` API, so it stays Chromium-only. |
| epiral/bb-browser | 6,266 | Turns sites into commands (103 commands on 36 sites) through your logged-in Chrome. |
| remorses/playwriter | 4,109 | Chrome Web Store extension; agent runs Playwright snippets over CDP. Tab groups per session, `selectBrowser` when several browsers or profiles are connected, network interception, breakpoints. |
| opentabs-dev/opentabs | 1,027 | Calls the sites' own web APIs through your session; 100+ plugins. Off / Ask / Auto permission per tool, audit log. |
| anomalyco/browse | 949 | Chromium extension (Chrome, Edge, Brave, Arc, Vivaldi, Opera). **Handoff** card for logins and captchas, sticky tab groups. Already installed on this PC as the `browse` tool. |
| Hacker-Valley-Media/Interceptor | 638 | Chrome, Brave, Edge **and Safari**, plus desktop apps and a physical iPhone. Reads page traffic without the debugger, file uploads, vault secrets typed by name. |
| Unagi-cq/cdp-bridge-mcp | 307 | Several signed-in Chrome profiles at once; each MCP connection is routed to its own profile by token. |

### 3. Firefox

| Repository | Stars | How | Notes |
|---|---:|---|---|
| mozilla/firefox-mcp | 589 | WebDriver BiDi (launches Firefox; `--connect-existing` possible) | Official Mozilla. Network, console and download capture; tool presets (`slim` drops `evaluate_script`). Advises a **dedicated** profile, not your daily one. |
| eyalzh/browser-control-mcp | 353 | Firefox add-on, signed on addons.mozilla.org | Deliberately read-mostly: tabs, history, page text with per-domain consent, no clicking or scripting. Shared secret, audit log. |
| railsblueprint/blueprint-mcp | 110 | Extension for Chrome, Edge, Opera and Firefox, in both stores | Closest to browzat in browser coverage. Local WebSocket on port 5555; several browsers and a cloud relay only in the paid PRO tier. |
| boot-industries/claudezilla | 47 | Firefox add-on (signed) + native messaging host | Multi-agent tab pool with per-tab owners, `evaluate` off by default, lazy tool loading, autostart of Firefox. |
| junyeong-nero/kitsune | 44 | Firefox, Zen, LibreWolf extension | Agent works in background tabs; your own tabs are read-only to it until a handoff. Published a 26-task WebArena-Pro benchmark (fewest input tokens of four tools). |
| nanogenomic/ClaudeCodeBrowser | 121 | Firefox extension | Screenshots, clicks, typing for Claude Code. |

## Where browzat stands

What browzat already does that few or none of the reviewed projects do:

1. **Chrome, Edge and Firefox from one codebase, all on the user's real profiles.** Only blueprint-mcp covers the same
   three, and it needs the paid tier for more than one browser at a time. browzat connects all of them at once, free.
2. **Firefox Multi-Account Containers.** None of the 18 READMEs mentions containers (`contextualIdentities`).
3. **Several profiles of one browser at once**, each with a stable name set in the popup. Only playwriter
   (`selectBrowser`) and cdp-bridge-mcp offer something similar.
4. **Mutual HMAC pairing** between relay and extension, plus Origin and Host checks. Most projects use a plain
   shared secret or a popup **Allow** button.
5. No telemetry, no cloud relay, a single dependency (`ws`).

Where browzat is behind:

| Gap | Who does it | Why it matters (seen in real use on 2026-11-20) |
|---|---|---|
| Not in the Chrome Web Store or on addons.mozilla.org | BrowserMCP, playwriter, browse, blueprint, browser-control-mcp, claudezilla | Firefox drops the temporary add-on at every restart; that happened twice in one session. |
| No `npx` / package install | almost all | Install is clone + installer script. |
| No human **handoff** tool | browse, kitsune | Passkey confirmation and the GitHub "Copy token" click had to be asked for in chat. |
| Clicks and keys are synthetic (`isTrusted = false`) | CDP-based tools (playwriter, Chrome DevTools, Playwright) send trusted input | GitHub's delete confirmation and the clipboard copy refused synthetic input. |
| No file upload | Interceptor, Playwright, browser-harness | Could not set a profile picture. |
| No network or console capture | firefox-mcp, mcp-chrome, opentabs, Interceptor, browser-tools-mcp | Useful for debugging and for bug-bounty work. |
| No agent tab group / background-only mode / protection of the user's own tabs | Playwright `--extension`, playwriter, browse, kitsune | Keeps the agent out of the way and makes its tabs easy to close. |
| `evaluate` always on, all tools always loaded | firefox-mcp presets, claudezilla lazy mode | Smaller tool list costs fewer tokens and lowers prompt-injection risk. |
| No audit log or per-tool permission | browser-control-mcp, opentabs | Shows what the agent did; lets risky tools ask first. |
| No benchmark | kitsune | A number makes the README convincing. |

## Recommended roadmap

Ordered by value for effort. Each item is one change, to be approved before it is built.

1. **Handoff tool**: show a card in the page ("Please confirm with your passkey, then click Continue") and wait.
   Small change, removes the most common stall.
2. **Trusted input on Chrome and Edge** through the `chrome.debugger` API (`Input.dispatchMouseEvent`,
   `Input.insertText`), with the current synthetic events as fallback and for Firefox. Shows the "being debugged"
   bar while active.
3. **File upload**: `upload` tool; Chromium through `DOM.setFileInputFiles` (debugger), Firefox by building a
   `File` from bytes the relay sends and dispatching `change`.
4. **Agent tab group** (Chromium `tabGroups`, Firefox: a dedicated container) and an option that keeps the
   user's own tabs read-only.
5. **Firefox signing** (unlisted on addons.mozilla.org with `web-ext sign`) so the add-on survives restarts; then a
   Chrome Web Store listing.
6. **Tool presets and `evaluate` opt-in**, plus an audit log in `~/.browser-mcp/audit.log`.
7. **Network and console capture** per tab (Chromium debugger `Network.*`; Firefox `webRequest`).
8. **`npx` install** once the project is public: publish to npm as `browzat`.
9. A small **benchmark** (10 to 20 tasks) against Playwright MCP and browse.

## Data

The raw search results and READMEs were kept outside the repository (session scratch space). Re-run the search
with the same 24 queries to refresh this page.
