# Changelog

All notable changes to browzat are listed here. Versions follow [Semantic Versioning](https://semver.org/);
the version in `package.json` is also the extension version.

## [Unreleased]

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

[Unreleased]: https://github.com/AnistoMejin/browzat/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/AnistoMejin/browzat/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/AnistoMejin/browzat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AnistoMejin/browzat/releases/tag/v0.2.0
