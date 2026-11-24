# Changelog

All notable changes to browzat are listed here. Versions follow [Semantic Versioning](https://semver.org/);
the version in `package.json` is also the extension version.

## [Unreleased]

## [1.0.0] - 2026-11-24

First stable browzat release. It promotes the verified cross-browser MCP server, local relay and browser extensions
from the 0.x roadmap to a stable public package and GitHub release.

- Improved GitHub and npm discoverability with a descriptive Browser MCP title, search-focused package metadata,
  a public-facing feature summary, common use cases and accurate repository/package details.
- Added a 1280x640 GitHub social preview and prepared the public repository, release archives and npm package for
  stable distribution.

## [0.10.0] - 2026-11-24

Phase 7 of the all-in-one roadmap: agent comfort, tool policies and distribution preparation.

- Added tool presets, an evaluate switch, site allow/block rules, response shaping and metadata-only audit logging.
- Agent-created tabs are grouped in Chromium browsers and can be closed with one cleanup action.
- Added the `browzat` npm command, local installation, unsigned browser archives, checksums and a tag-driven GitHub release workflow.
- Added Firefox AMO, Chrome Web Store and privacy policy submission material. Publishing and signing remain owner-run steps.
- Fixed tab ownership when browser tabs are opened concurrently and reports timezone overrides unsupported by Chromium extension clients.
- Verified all feature suites on Chrome, Edge, Chromium and Firefox in pairs. Four-browser concurrent runs can time out under local resource pressure.

## [0.9.0] - 2026-11-23

Phase 6 of the all-in-one roadmap: checks and helpers.

- Added `verify`, `inspect`, `fill_form`, `scroll`, `highlight`, `audit` and Chromium `logpoints`.
- Verification failures are tool errors containing the expected and observed state.
- The audit runs locally and checks titles, page language, image alternatives, field labels, duplicate IDs and vague
  link text without sending page content to an external service.
- Added 24 isolated end-to-end checks across Chromium and Firefox.

## [0.8.0] - 2026-11-23

Phase 5 of the all-in-one roadmap: recording and performance.

- Added `performance` metrics for navigation, DOM readiness, load, paint, layout shift, resources and JavaScript heap.
- Chrome and Edge can save a DevTools-compatible performance trace.
- All browsers can save a short visual recording as private JPEG frames and a self-contained HTML player.
- Added 8 isolated end-to-end checks across Chromium and Firefox.

## [0.7.0] - 2026-11-23

Phase 4 of the all-in-one roadmap: page output and emulation.

- Upgraded `screenshot` with full-page and element capture, JPEG/PNG/WebP, quality, transparent backgrounds on
  Chromium, wider images and explicit new output paths.
- Added `pdf` on Chrome and Edge with paper size, orientation, scale, margins, page ranges and backgrounds. Firefox
  reports its extension limitation and points to full-page screenshots.
- Added `emulate` for viewport and device presets, user agent, language, time zone, location, media preferences, CPU
  throttling and per-tab request headers. Reset removes every override.
- Firefox supports headers and window-based viewport sizing and reports the actual size when the platform refuses the
  requested dimensions.
- Added 16 isolated end-to-end checks for output and emulation on Chromium and Firefox.

## [0.6.0] - 2026-11-23

Phase 3 of the all-in-one roadmap: storage and cookies.

- Added `cookies` for site-scoped cookie listing, reading, setting, deletion and clearing in the tab's cookie jar.
- Added `storage` for localStorage and sessionStorage on the top page's origin.
- Added `storage_state` to save and restore one site's cookies and storage without exposing values in its summary.
- Added `container` to create and remove isolated Firefox containers owned by browzat.
- Chrome and Edge now request the `cookies` permission. State files are private and remain under the output folder.
- Added feature-module extension points and a parallel throwaway-browser test bed for faster phase development.
- Fixed Chrome and Edge drag cleanup when the browser reports an HTML5 drag start late or does not intercept it.
- Tests: Phase 3 adds 38 checks on Chromium and 43 on Firefox. The full pre-Phase-3 suite also passes on Chrome,
  Edge, Chromium and Firefox.

## [0.5.0] - 2026-11-21

Phase 2 of the all-in-one roadmap: network and console.

- New tools:
  - `network_requests`: the requests a tab made (method, status, type, duration, URL, a number for details), with
    filters (URL substring, glob or /regex/, types, failed only), static files hidden unless asked, and `bodies: true`
    to start recording response bodies.
  - `network_request`: one request in detail: request and response headers, request body, response body.
  - `network_route`: block requests, or answer them with a mock (status, body, content type, headers), by URL pattern;
    list, remove and clear routes, with hit counts.
  - `network_conditions` (Chrome and Edge): offline, latency, download and upload speed; reset.
  - `console_messages`: console output plus uncaught errors, unhandled promise rejections and failed loads, filtered
    by level, with `clear`.
- How it works: the request log uses the browsers' webRequest API, so it needs no debugger. Response bodies, routes
  and network conditions use the debugger on Chrome and Edge (the debugging bar stays while they are on), and
  webRequest response filters on Firefox (Firefox keeps the server's status code for mocks). The console comes from the
  debugger on Chrome and Edge, which replays the page's whole history; on Firefox a recorder starts with each page.
- Privacy: requests and console messages are recorded only in tabs the agent opened, or tabs it was explicitly asked
  to watch. On Firefox a tiny recorder starts in every page (to catch a page's first messages) and removes itself at
  once from tabs the agent does not work in, leaving the page's console as it was.
- The dialog guard now installs as each agent page starts, so alerts during page load no longer block.
- Tabs the agent opens are marked as the agent's the moment the browser creates them, so their first request is
  recorded too.
- Chrome and Edge ask for `webRequest` and `webNavigation`; Firefox also for `webRequestBlocking`.
- `npm run check` now unit-tests the URL patterns used by filters and routes (a path such as `/api/data` is plain text,
  not a regex).
- Tests: 21 new end-to-end checks; all pass on Windows (Chrome, Edge, Firefox, real profiles) and Ubuntu 24.04
  (Chromium, Firefox).

## [0.4.0] - 2026-11-21

Phase 1 of the all-in-one roadmap: real input, uploads and dialogs.

- **Real input on Chrome and Edge.** `click`, `type` and `press_key` now go through the browser's debugger API, so
  pages see trusted events (`isTrusted`), the same as a person's mouse and keyboard. The debugger attaches only for
  the action and detaches after 8 s idle; meanwhile the browser shows "browzat started debugging this browser".
  Focus emulation keeps it working in background tabs. Simulated input is still used on Firefox (no debugger API for
  extensions), for elements inside iframes, when the element is covered by something else (the result says by what),
  and when another debugger (DevTools) is attached to the tab.
- New tools:
  - `hover`: real mouse move on Chrome and Edge, simulated events on Firefox.
  - `drag`: HTML5 drag and drop (the drag is intercepted and replayed onto the target, then always finished or
    cancelled) and mouse-based dragging.
  - `mouse`: click, move, down, up or wheel at viewport coordinates, with left/right/middle button and double click.
  - `upload`: put local files into a file input, or into the file chooser a button opens (Chrome and Edge read the
    files from disk; Firefox receives them, up to 50 MB in total).
  - `dialog`: set the answer for the next alert/confirm/prompt (accept or dismiss, prompt text, or keep for every
    dialog on the page).
- **Dialogs never block an agent tab:** before each action alert/confirm/prompt are answered automatically (alert OK,
  confirm and prompt Cancel unless `dialog` says otherwise), and the action's result lists each dialog.
- `click` takes `button` (left, right, middle).
- Chrome and Edge extensions ask for the `debugger` permission.
- Tests: 12 new end-to-end checks (real input, typing, upload, missing file, dialogs, hover, drag, mouse); all pass on
  real Chrome, Edge and Firefox profiles.
- **Linux verified** on an Ubuntu 24.04 server: `install.sh`, Chrome for Testing 159 and Firefox 160 under Xvfb, and
  two Chromium profiles at once all pass the full suite.
- `install.sh` works without npm: it fetches `ws` from the registry at the pinned version and verifies its sha512.
- Fixed: a drag whose start the browser reported late (seen on a fresh, slower browser) was left unfinished, and the
  tab then ignored clicks. browzat now waits up to a second for the drag to start and always cancels a late one.
- `test/launch-chromium.js` takes `CHROME_EXTRA_ARGS` (for `--no-sandbox` on Ubuntu 23.10+ test builds); the
  coordinate check allows ±1 px for Firefox's whole-pixel rounding; the End-key check waits for smooth scrolling.

## [0.3.0] - 2026-11-20

- New tool **`handoff`**: the agent asks the user to do something only a person can do (login, 2FA, passkey,
  captcha, a confirmation the site refuses from the agent). The tab comes to the front with a card showing the
  message, the site and **Continue** / **Cancel**; the tool returns when the user answers, the tab closes, or the
  time runs out (default 300 s, at most 600 s). The card sits in a closed shadow root styled through the CSSOM, comes
  back after the page navigates, and accepts only real (trusted) clicks. The toolbar badge shows `?` while a handoff
  is open, and the popup lists open handoffs with the same buttons as a fallback.
- **Logo and name:** the extension is now called **browzat** in the browser and has its own icon (a terminal prompt
  in a browser window; `assets/logo.svg`, icons drawn by `assets/make-icons.py`). The popup, the handoff card, the
  pairing page and the error messages use the new name. The Firefox add-on id, the MCP entry and the folders keep
  `browser-mcp`, so existing installs and pairings keep working.
- The relay now allows a single call to wait up to 11 minutes (was 3), for the handoff.
- `npm run check` also fails on files that start with a UTF-8 byte-order mark.
- Research notes: `docs/research/` (landscape of browser MCP projects, and where each one implements what).
- Published as **browzat** on GitHub; README maps the project name to the local `browser-mcp` names and folders.
- Added LICENSE (MIT), SECURITY.md, CHANGELOG.md, `.gitattributes`, `.editorconfig`.
- Added `npm run check` (syntax and manifest check plus a build) and a GitHub Actions CI workflow that runs it.

## [0.2.0] - 2026-11-20

First published version.

- Extension for Chrome and Edge (Manifest V3) and Firefox (Manifest V2) from one codebase.
- Local relay on `127.0.0.1` with mutual HMAC check of a 256-bit pairing token.
- MCP server with the tools `status`, `tabs`, `navigate`, `snapshot`, `click`, `type`, `press_key`, `evaluate`,
  `wait_for` and `screenshot`; Firefox Multi-Account Containers through `tabs`.
- Windows installer (`install.ps1`) and Linux installer (`install.sh`, not yet tested on Linux).
- End-to-end tests on real and throwaway profiles.

[Unreleased]: https://github.com/AnistoMejin/browzat/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/AnistoMejin/browzat/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/AnistoMejin/browzat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AnistoMejin/browzat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AnistoMejin/browzat/releases/tag/v0.2.0
