# Project workflow memory

Complete work one phase at a time.

Before starting the next phase, finish the current phase, run its phase-specific tests on every available supported browser, fix any failures, rerun those tests successfully, and run the relevant static checks. Report the verified result before advancing.

Run multi-browser verification in pairs when all-browser concurrency creates local resource pressure. A failed or timed-out concurrent run does not satisfy phase completion.

## Current verified state (2026-11-24, version 1.0.0)

- Fixed Chrome element screenshot hangs by using visible-tab capture plus cropping for non-transparent element screenshots, while retaining CDP for full-page and transparent captures.
- Core checks run before the comfort cleanup section, because `tabs cleanup` intentionally closes every agent-owned tab.
- Handoff checks poll for the card instead of depending on fixed sleeps, and Firefox link clicks allow a short navigation grace period.
- Phase-specific output checks pass on Chrome, Chromium, Edge and Firefox (8/8 each).
- Core checks pass on Chrome, Chromium and Edge (66/66 each) and Firefox (72/72).
- The full headless and headed Google Chrome suites pass (131/131 each), and `npm run check` passes.
- The locally loaded Chrome extension and relay are paired on port 19789. The unpacked extension path is `C:\Entelegen\Projects\browser-mcp\dist\chromium`; reload it after building version 1.0.0.
- Headed Chromium-family input waits for debugger UI layout changes before locating the first click target, resets the pointer after drag interception, retries transient tab-edit busy errors, and records a final visual frame on stop.
- Release archive generation and `npm pack --dry-run` pass. Generated `release/` files are ignored because tag CI rebuilds and attaches them.
- GitHub/npm SEO uses the descriptive Browser MCP title and summary, focused discovery keywords/topics, an early quick-start, public feature/use-case copy and accurate repository metadata.

## Pending verification

- npm publishing needs `npm login` on this machine. Store publishing and Firefox signing remain owner-run release operations.
