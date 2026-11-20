# Security

browzat lets a program act in your logged-in browsers, so a flaw in it can expose every site you are signed in to.
Please report problems privately.

## Reporting a vulnerability

Report it privately to the repository owner on GitHub. If the repository is public and private vulnerability
reporting is switched on, use **Security → Report a vulnerability**. Do not open a public issue for a security
problem. Include the version (`package.json`), browser and operating system, and the steps
to reproduce. You will get a reply within 7 days.

## Supported versions

Only the latest version on `main` receives fixes.

## Security model

| Protection | How |
|---|---|
| Local only | The relay listens on `127.0.0.1`; nothing is reachable from the network. |
| Pairing token | 256-bit random token in `~/.browser-mcp/token`, file mode 0600 on Linux. The extension and the relay each prove knowledge of it (HMAC challenge in both directions) before any command is accepted. |
| Web pages cannot use the relay | Requests with a web `Origin` or an unexpected `Host` are refused. |
| Agent scope | The agent sees and closes only tabs it opened unless told otherwise; password field values are never returned by `snapshot`. |

## What it does not protect against

- Other software running under your user account can read the token file and drive your browsers.
- An agent you connect can do anything you can do on the sites you are logged in to. Only connect agents you trust,
  and watch what they do.
- Firefox loads the add-on as a temporary, unsigned add-on.

## Secrets in this repository

None are committed. Local secrets (for example a GitHub token) go in `.env`, which git ignores.
