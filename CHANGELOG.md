# Changelog

All notable changes to browzat are listed here. Versions follow [Semantic Versioning](https://semver.org/);
the version in `package.json` is also the extension version.

## [Unreleased]

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

[Unreleased]: https://github.com/AnistoMejin/browzat/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AnistoMejin/browzat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AnistoMejin/browzat/releases/tag/v0.2.0
