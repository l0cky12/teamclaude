# TeamRouter

*Formerly TeamClaude. Both names work: see [The rename](#the-rename).*

[![CI](https://github.com/l0cky12/teamclaude/actions/workflows/ci.yml/badge.svg)](https://github.com/l0cky12/teamclaude/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@karpeleslab/teamclaude.svg)](https://www.npmjs.com/package/@karpeleslab/teamclaude)
[![node](https://img.shields.io/node/v/@karpeleslab/teamclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamRouter is a local proxy that pools your own AI coding accounts and moves between them before any one of them hits its limit.

You point [Claude Code](https://claude.com/product/claude-code) or the [Codex CLI](https://github.com/openai/codex) at it, and it handles the rest. It holds your Claude Max, ChatGPT/Codex, API-key and third-party backend (DeepSeek, z.ai/GLM, NanoGPT) accounts. When the account in use gets close to its 5-hour or weekly limit, the next request goes to another one. Your sessions keep running instead of stopping on a rate-limit error.

You control it from a terminal UI, the command line, or a web dashboard that works from any machine on your network.

![TeamRouter terminal UI](screenshots/teamclaude.png)

## Who it is for

**One person, with their own accounts.** The "team" is your agents: if you run ten or fifty coding sessions at once, one subscription isn't enough, and switching accounts by hand every time one fills up gets old fast. TeamRouter does that switching for you.

It is not for sharing accounts between people, it is not a hosted service, and it only drives each provider's own client (Claude Code on Claude accounts, the Codex CLI on Codex accounts). See [Scope](#scope).

## Install

You need Node.js 20 or later. TeamRouter has no runtime dependencies.

**From npm** (the published release):

```bash
npm install -g @karpeleslab/teamclaude
```

**From this repository**, to run changes that haven't been released to npm yet:

```bash
git clone https://github.com/l0cky12/teamclaude.git
cd teamclaude
npm link
```

A git checkout never updates itself. Use `git pull` to update it.

**Other ways to run it:**

- **Docker:** `ghcr.io/karpeleslab/teamclaude`. See [Running in a container](docs/usage.md#running-in-a-container).
- **Nix:** a flake with NixOS and Home Manager modules. See [nix/README.md](nix/README.md).
- **As a background service:** `teamclaude service install` starts the proxy at login and restarts it if it stops (systemd on Linux, a LaunchAgent on macOS).

## Quick start

```bash
teamclaude login           # sign in to a Claude account in your browser; repeat for each account
teamclaude login --codex   # sign in to a ChatGPT/Codex account
teamclaude server          # start the proxy (shows the terminal UI)
```

Then, in another terminal:

```bash
teamclaude run             # Claude Code, through the proxy
teamclaude dashboard       # or open the web dashboard
```

Some shortcuts:

- Already signed in to Claude Code? `teamclaude import` copies that sign-in instead.
- Want plain `claude` to always use the proxy? Run `teamclaude alias --install`.
- Signing in on a server over SSH? `teamclaude login --token` gives you a link to open on any device and a box to paste the code into.

More on accounts, including API keys and one email in several organisations: [docs/accounts.md](docs/accounts.md).

## What it does

### Keeps your sessions running

- **Switches accounts before a limit.** When an account reaches 98% of its 5-hour or weekly limit (you can change the number), new requests go to the next account. If a request does hit a limit, it is retried once on another account, so Claude Code never sees the error while any account still has room.
- **Tracks each model's limit on its own.** An account that is out of Fable quota still serves Opus and Sonnet.
- **Knows a spent limit from a short burst limit.** On a per-minute rate limit it slows down on the same account instead of switching, so the prompt cache stays warm.
- **Can wait instead of failing.** With `holdSeconds` set, a request that arrives when every account is spent is held open until an account resets (up to that many seconds) instead of failing. An unattended run then finishes on its own. Off by default.
- **Can fall back to paid extra usage.** With `allowExtraUsage` on, Anthropic's paid extra usage is used only after every account's free quota is gone, and stops as soon as a window resets. Off by default, because it costs money.
- **Refreshes sign-ins by itself**, before they expire, and saves the new tokens.

### Chooses accounts the way you want

Set `distributeSessions` (or run `teamclaude distribute <mode>`) to pick how conversations are spread across accounts:

| Mode | What it does |
| --- | --- |
| `off` (default) | Everything uses the current account until it nears its limit. |
| `on` | Each new conversation goes to the least busy account and stays there, so its prompt cache is reused. |
| `adaptive` | Fills the account with the least weekly quota left first, so less quota is wasted when windows reset. Takes plan size (Pro, Max 5x, Max 20x) into account. |
| `affinity` | Uses an account whose 5-hour window is about to reset first, and never moves a conversation while its account can still serve it. |
| `drain` | Uses the account whose weekly limit resets soonest until it runs out, then the next one. |

You can also set a priority order, send certain models to certain accounts (`teamclaude route`), or pin one session to one account with `TC_ACCT`. Details: [docs/routing.md](docs/routing.md).

### A web dashboard you can use from anywhere

Open `http://localhost:3456/teamclaude/dashboard`, or run `teamclaude dashboard`. To use it from another machine, set `proxy.host` to `0.0.0.0` (or a Tailscale or LAN address), open the same page at that address, and enter the proxy key.

- **Quota:** how much is left on every account, as 5-hour, weekly and Fable bars with reset times. Tabs for Claude, Codex and each backend, plus pooled summary cards. Accounts that are out of quota are hidden until you ask to see them. Each account has a **Refresh quota** button that reads its quota without spending any.
- **Accounts:** **Sign in to Claude** and **Sign in to Codex** buttons add accounts from the browser, including from a phone or another computer. You can also sign an account in again, remove it, switch to it, disable it, or move it up or down the priority order.
- **Logs:** every request, sign-in, sign-out, account switch and settings change, with filters by kind, provider and account. Each request shows which client sent it. Turn on `proxy.logPrompts` to also see the prompt that started it.
- **Clients:** create a separate key for each machine or agent. The dashboard shows the exact settings to paste into Claude Code or `~/.codex/config.toml`, and how much each key has used over the last 5 hours, 24 hours, or all time.
- **Sessions, Routing and Settings:** what each conversation spent, which account each model goes to, the switch threshold, and the background quota check (off, or every 5 to 120 seconds).
- **Linked instances:** run TeamRouter on more than one machine (a desktop and a server, say) and link them from **Settings**. One dashboard can then show and control all of them. Off until you link something.

Light and dark themes follow your system. Full tour: [docs/usage.md](docs/usage.md#status-dashboard-browser).

### Works with more than Claude

- **Codex (ChatGPT) accounts** are pooled next to Claude accounts on the same port, with their own quota and rotation.
- **Third-party backends** (DeepSeek, z.ai/GLM, NanoGPT, or any Anthropic-compatible API) can act as a low-priority fallback for when your Claude accounts run out.
- **Free resets get used.** Codex rate-limit reset credits and banked Claude usage-limit resets can be spent automatically when no account has room left (`autoRedeemResets`, off by default).

### Moves with you between machines

- **Export and import accounts.** `teamclaude accounts export <file>` writes every sign-in to a passphrase-encrypted file. `teamclaude accounts import <file>` sets up a new machine without signing in again.
- **Keep the same accounts live on several machines** with callback.net sync, which stops two machines from signing each other out.

### Fits into your network

- **Catches hard-coded addresses.** By default `teamclaude run` routes Claude Code through a local HTTPS proxy, so tools that call `api.anthropic.com` directly (the Claude Design MCP, for one) still go through the pool.
- **Per-account proxies.** Send one account's traffic through its own HTTP or SOCKS proxy (`teamclaude routing <name> socks5h://…`). If that proxy goes down, requests move to another account.
- **An upstream proxy** for everything, and residential egress through sx.org.

### Lets your agents see it too

Turn on the MCP endpoint (`"proxy": { "mcp": "read" }`) and Claude Code can check quota, or with `"full"` switch accounts and change settings, from inside a session. Off by default.

### Spends nothing behind your back

Anything that makes background calls or uses quota is off until you turn it on: quota probing, keep-warm requests, extra usage, spending resets, holding requests, MCP and session titles.

## Everyday commands

```bash
teamclaude accounts              # list accounts, their plan and sign-in status
teamclaude status                # live status of a running proxy
teamclaude switch <name>         # prefer one account now
teamclaude disable <name>        # take an account out of rotation (enable to undo)
teamclaude priority <name> 1     # set rotation order, lower is used first
teamclaude threshold 90          # switch accounts at 90% instead of 98%
teamclaude distribute adaptive   # pick how conversations are spread
teamclaude attach                # open the terminal UI of a running proxy
teamclaude help                  # everything else
```

Every command: [docs/usage.md](docs/usage.md#command-reference).

## Configuration

Settings live in `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME`). The file is meant to be edited by hand, and most settings can also be changed from the dashboard, the terminal UI or the CLI while the proxy runs. A proxy key is created the first time you start it.

Quota readings are kept in `teamclaude.state.json` next to it. You can delete that file safely: quota is learned again from traffic.

Every setting and environment variable: [docs/configuration.md](docs/configuration.md).

## How it works

1. Claude Code or Codex sends its request to the local proxy instead of the provider.
2. The proxy picks an account that has room, adds that account's sign-in, and forwards the request.
3. The provider's reply says how much quota the account has left. The proxy records it, so it knows when to move on, even after a restart.
4. If the reply is a limit error, the request is sent once more on another account. If every account is spent, the proxy either waits (`holdSeconds`) or returns the error.

Step by step: [docs/routing.md](docs/routing.md#request-lifecycle).

## Documentation

| Page | What's in it |
| --- | --- |
| [Accounts](docs/accounts.md) | Signing in from the CLI or dashboard, API keys, several organisations, Codex accounts, third-party backends, export/import, callback.net sync, per-account proxies, signing in over SSH |
| [Usage](docs/usage.md) | The server and terminal UI, running Claude Code, the web dashboard, linked instances, the MCP endpoint, every command, logging, Docker |
| [Routing](docs/routing.md) | How accounts are chosen, the distribution modes, model routes, pinning, the prompt cache |
| [Quota](docs/quota.md) | How quota is read, probing, keep-warm, thresholds, spending caps, extra usage, holding |
| [Configuration](docs/configuration.md) | The config file, every setting, environment variables |
| [Proxy modes](docs/proxy-modes.md) | The local HTTPS proxy, upstream proxies, per-account proxies, sx.org |
| [Compliance](docs/compliance.md) | Who the project is for, and notes on each provider's terms |
| [Contributing](CONTRIBUTING.md) | What's in scope, and what a pull request needs |

## The rename

TeamClaude is becoming **TeamRouter**, because it now pools Codex and other backends as well as Claude. The rename is happening over several releases so that nothing you have installed, scripted or configured breaks ([issue #72](https://github.com/KarpelesLab/teamclaude/issues/72)).

For now both names work everywhere:

- `teamrouter` runs the same CLI as `teamclaude`.
- Every `TEAMCLAUDE_*` environment variable can also be written `TEAMROUTER_*`.
- Every `/teamclaude/…` address also answers at `/teamrouter/…`.
- `~/.config/teamrouter.json` is used if it exists.

The dashboard already uses the TeamRouter name. You don't need to change anything on an existing install.

## Security

The only official sources are [github.com/KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude) and the [`@karpeleslab/teamclaude`](https://www.npmjs.com/package/@karpeleslab/teamclaude) npm package. It is **never** distributed as a downloadable binary or `.zip`, so don't run one that claims to be it. To report a problem, see [SECURITY.md](SECURITY.md).

## Scope

TeamRouter is a local proxy that holds your own sign-ins and drives each provider's own CLI, for one person's work. That holds for every provider it supports:

- **One person, their own accounts.** Not account sharing, not a hosted service, not resale.
- **The provider's own client.** Claude Code on Claude accounts, the Codex CLI on Codex accounts. Other tools can't use subscription sign-ins through it.
- **A third-party backend is just another account:** a key you were given, used under that company's terms.

How this fits each provider's terms, including the common question about holding several subscriptions, is in [docs/compliance.md](docs/compliance.md). It isn't legal advice. Changes outside this scope aren't merged; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
