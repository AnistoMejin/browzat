# Distribution checklist

## npm

The package exposes the `browzat` executable and limits the tarball with `files` in `package.json`.

```bash
npm pack --dry-run
npm publish
npx browzat install
```

Publishing needs the owner's npm account and is deliberately not part of CI. Confirm ownership of the package name
before publishing. npm creates platform launchers for executables declared in `bin`.

## Release archives

`npm run release` creates an unsigned Chrome Web Store ZIP, an unsigned Firefox XPI and SHA-256 checksums in
`release/`. A `v*` tag runs checks, builds these files and attaches them with the npm tarball to a GitHub release.

## Firefox signing

The manifest already has a stable Gecko ID. Create AMO API credentials, keep both values outside the repository, and
sign the built Firefox directory for self-distribution.

```bash
npx web-ext sign --source-dir dist/firefox --channel=unlisted \
  --api-key="$WEB_EXT_API_KEY" --api-secret="$WEB_EXT_API_SECRET"
```

Mozilla validates every upload and may select it for manual review. The signed XPI returned by AMO can be installed
permanently. See the official [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and [`web-ext sign` reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/).

## Chrome Web Store submission

Upload `release/browzat-<version>-chromium.zip` and use the following listing material.

- Name. browzat
- Summary. Let a local AI agent work in your existing browser profile under your control.
- Single purpose. Connect the local browzat MCP server to tabs in this browser so the user's chosen AI agent can read,
  navigate and interact with websites, capture diagnostics and save requested output locally.
- Category. Developer Tools
- Required screenshots. Toolbar popup and pairing, an agent-created tab, user handoff, snapshot and screenshot output.
- Privacy policy. Publish `docs/privacy-policy.md` at a stable public URL and enter that URL in the dashboard.

Permission justifications follow.

- `tabs` identifies, opens, focuses and closes the tabs the local agent works in.
- `scripting` runs the page snapshot and interaction helpers in those tabs.
- `storage` keeps the local pairing and agent-tab state across service-worker restarts.
- `alarms` maintains the local relay connection.
- `debugger` provides trusted input, uploads, PDF, full-page capture, emulation, traces and logpoints on the selected tab.
- `cookies` implements the explicitly invoked cookie and storage-state tools for one site.
- `webRequest` and `webNavigation` provide request diagnostics, routing and early page hooks.
- `declarativeNetRequest` applies per-tab request-header overrides requested through emulation.
- `tabGroups` keeps agent-created tabs visibly grouped.
- `<all_urls>` is required because the user can direct the local agent to any site and page scripts must run there.

Chrome requires a single narrow purpose, justification for every permission, accurate data disclosures and a public
privacy policy. Review the official [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
and [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies) before submission.

Publishing, signing and store submission require the owner's accounts and remain manual steps.
