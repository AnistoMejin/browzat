# Changelog

All notable changes to browzat are listed here. Versions follow [Semantic Versioning](https://semver.org/);
the version in `package.json` is also the extension version.

## [Unreleased]

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

[Unreleased]: https://github.com/AnistoMejin/browzat/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AnistoMejin/browzat/releases/tag/v0.2.0
