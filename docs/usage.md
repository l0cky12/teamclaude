# Usage

Running the server, running Claude Code through it, and the full command reference.

## Start the proxy server

```bash
teamclaude server
```

From a TTY this shows the interactive TUI: an account table with session/weekly quota bars and reset countdowns, a real-time activity log, and keyboard controls.

With accounts from two providers (Claude and Codex) and a terminal at least 127 columns wide, the account table is drawn as two panes side by side, one per provider, each titled with its provider. Each pane carries its own `►` current-account marker, because each provider pool keeps its own cursor. The panes are used only when both can draw every quota bar their rows have, so a fleet with per-model bars, route columns or blocked-family tags needs a little more than 127 columns; a narrower terminal keeps the single list, with the provider named in the type column (and still one `►` per provider). A Codex row whose subscription has reported a weekly window and no 5-hour one draws the weekly bar alone, at the width of both cells, while the Claude rows beside it keep `Ses` and `Wk`; a list made only of such rows drops the `Ses` column outright. An account that has not reported yet keeps both cells, and a row keeps them when its 5-hour window merely runs out.

It falls back to plain log output when stdout is not a TTY (e.g. running as a service). Pass `--headless` (or `--no-tui`) to force plain-log mode from a terminal — useful for backgrounding the proxy.

### Running in a container

A container image is published to GHCR on every version bump (`ghcr.io/karpeleslab/teamclaude`, tagged `latest`, `1`, `1.1` and the full version). It runs `server --headless` bound to `0.0.0.0` inside the container, so publish the port and bind-mount the config file:

```bash
docker run -d --name teamclaude -p 3456:3456 \
  -v ~/.config/teamclaude.json:/data/teamclaude.json \
  ghcr.io/karpeleslab/teamclaude:latest

docker exec -it teamclaude teamclaude login --token   # add accounts from inside
docker exec -it teamclaude teamclaude status
```

The entrypoint starts as root only long enough to match the runtime user to the owner of the mounted config (or of `/data` when the file does not exist yet), then drops privileges — so a file owned by your user stays writable without a `chown`. `TEAMCLAUDE_UID` (and optional `TEAMCLAUDE_GID`) override the detected owner. stderr is folded into stdout so `docker logs` shows one stream; set `TEAMCLAUDE_SPLIT_STDERR=1` to keep them apart. Auto-update is disabled in the image; pull a new tag to upgrade. The image ships without npm or yarn: the proxy has no runtime dependencies, and leaving the base image's package managers out keeps the image small and free of their known vulnerabilities.

The config is created on first start with a random `proxy.apiKey`. Anything reaching the proxy from outside the container is a non-loopback client and must present that key (see [proxy.host](configuration.md#fields)); only `teamclaude` commands run via `docker exec` are exempt.

Build it yourself with `docker build -t teamclaude .` from a checkout.

#### Previewing a branch

`docker/docker-compose.preview.yml` builds a second proxy from a checkout and runs it beside the one you use, for trying a branch's dashboard from another machine on your [Tailscale](https://tailscale.com) network. Every `docker compose` command for it needs `TAILSCALE_IP`, so export it once:

```bash
export TAILSCALE_IP=$(tailscale ip -4)
docker compose -f docker/docker-compose.preview.yml build
docker compose -f docker/docker-compose.preview.yml run --rm preview login
docker compose -f docker/docker-compose.preview.yml up -d
```

The proxy refuses to start with no accounts, so `run … login` signs one in first, with the same paste flow as [over SSH](accounts.md#signing-accounts-in-over-ssh) (`login --codex` for a Codex account). Then open `http://<tailscale-ip>:3466/teamclaude/dashboard` and enter the preview's own proxy key:

```bash
docker exec teamclaude-preview node -e "console.log(require('/data/teamclaude.json').proxy.apiKey)"
```

It cannot disturb the proxy already running:

- It keeps its config and state in its own volume (`teamclaude-preview_preview-data`), never `~/.config/teamclaude.json`.
- It listens on host port 3466 instead of 3456.
- It is published on the Tailscale address only, so nothing on the LAN or the internet reaches it.
- Nothing is pointed at it: Claude Code and Codex keep talking to the proxy they were set up with.

A sign-in in the preview is a login of its own, separate from the running proxy's. Stop it with `docker compose -f docker/docker-compose.preview.yml down`; add `-v` to drop its volume and the accounts in it.

### Session titles in the activity log

Claude Code sends `x-claude-code-session-id` with each request, so every activity row belongs to a known
session. With `sessionTitles.enabled` set, the row is labelled with that session's name:

```
 ⠋ 17:42:57  adv-review-rewrite POST /v1/messages (claude-opus-5) → claude@rikbrown.co.uk (1.9s...)
 ⠋ 17:42:57  emmy-merge         POST /v1/messages (claude-opus-5) → claude@rikbrown.co.uk (0.4s...)
 ⠋ 17:42:57                     POST /v1/messages?beta=true (claude-opus-5) → claude@rikbrown.co.uk (1.1s...)
```

The name comes from Claude Code's own files under `~/.claude/projects`, in this order:

1. `<session-id>/custom-title.json`, written by `/rename`.
2. A `custom-title` record in the session transcript, which is the only copy for a session renamed before
   that file existed.
3. An `ai-title` record, the title Claude Code generates. Most sessions have one without a rename.

A session with none of these keeps the first six hex characters of its id. So does a request that carries no
session header: a bare SDK or API client reaches the proxy anonymously, and no file names it.

Each label is read once and re-read at most every 30 seconds, off the render path, so a `/rename` reaches the
log without a restart and no frame waits on the disk. Only a session id shaped like a UUID is looked up, and a
title is printed with its control characters removed, since both arrive from outside the proxy.

This is off by default: it reads the tail of every visible session's transcript, which is further than the
proxy reaches for anything else unless asked. Press **g** → **Session titles** to turn the labels on and off
while the proxy runs. Set `sessionTitles.width` to change the columns the label gets. See
[configuration](configuration.md).

Headless, you can re-sync accounts from the config without a restart by POSTing to the local control endpoint (the equivalent of pressing **R** in the TUI):

```bash
curl -X POST http://localhost:3456/teamclaude/reload
```

The switch threshold has a control endpoint of its own — the same change as `teamclaude threshold 90`, and what the browser dashboard's **Switch at** control sends:

```bash
curl -X POST http://localhost:3456/teamclaude/threshold \
  -H 'content-type: application/json' -d '{"percent": 90}'
```

It is a setting, not a nudge: the number is written to the config file (under its lock, so an edit the CLI or TUI made meanwhile survives) and the server reloads to apply it. The answer carries the stored ratio and, when one number replaced a per-bucket table, `dropped` names the buckets that went. Per-account `accounts[].switchThreshold` overrides are untouched. A request authenticated with a `proxy.clientKeys` entry is refused with 403 — a client key is a tenant of the proxy, not its operator; the shared `proxy.apiKey` and key-exempt loopback callers are allowed.

You usually don't need to call it directly. `login`, `import`, `enable`, `disable`, `priority`, `route`, `threshold`, `distribute`, `probe` and `warmup` notify a running server themselves.

Control-plane **writes** (`reload`, `switch`, `threshold`, `priority`, `disable`, `remove`, `client-keys/create`, `client-keys/revoke`, `client-keys/show` and the `login/*` sign-in steps) are refused when the request carries a browser `Origin` or a cross-site `Sec-Fetch-Site`. The exception is a request that presents a configured proxy key and whose `Origin` names the very host it was sent to: that is the dashboard opened at a plain-`http` address of another machine (a Tailscale or LAN IP), where browsers send `Origin` but no `Sec-Fetch-Site`. A page on another site cannot send the key, which the browser does not attach by itself. Loopback is exempt from the proxy API key so the CLI needs no configuration, but that exemption also covers any web page you happen to visit: a page can POST to `127.0.0.1` cross-origin without a preflight, and while it cannot read the reply, the write would still land. `curl` and the CLI send neither header and are unaffected. Reads (`status`) are not restricted — the same-origin policy already stops a page from seeing the response.

`GET /teamclaude/quota` is the compact read endpoint for status-line integrations. It returns tier-weighted fleet aggregates and the underlying per-account limits; see [Fleet quota endpoint](quota.md#fleet-quota-endpoint).

Switching the account by hand has the same headless path — the equivalent of pressing **s** in the TUI and confirming with the default target selected:

```bash
teamclaude switch                 # list accounts, marking the current one
teamclaude switch me@example.com  # make that account the preferred one
```

Both forms need a running server: the choice is runtime state and is never written to the config, so there is nothing to apply on a later restart. The command wraps `POST /teamclaude/switch` with a `{"account": "<name>"}` body, and the account can be given as its display name, its bare email, its `accountUuid`, its `orgUuid`, or the fully qualified `accountUuid/orgUuid` — the last being the only form that tells apart one email that holds accounts in several orgs. The rotation index is deliberately not accepted — it is array position, so a script pinned to `1` would silently follow a different account after a removal.

As in the TUI, the choice is a weak preference rather than a lock, and it is worth knowing both ways it gets dropped. Rotation abandons it once the account becomes unusable (disabled, spent, throttled), and also whenever any available account carries a strictly lower `priority` value, since a higher-priority account preempts a healthy current one. A switch onto an account that cannot take traffic at all is still recorded, exactly as in the TUI, but the command says so instead of reporting a clean success:

```text
Switched to "me@example.com"
Warning: "me@example.com" is disabled, so requests will not route to it until that changes.
```

Taking an account out of rotation, or moving it in the priority order, has a headless path too — the web equivalent of `teamclaude disable` / `enable` and `teamclaude priority --first` / `--last`, and what the browser dashboard's buttons call:

```bash
curl -X POST http://localhost:3456/teamclaude/disable \
  -H 'content-type: application/json' -d '{"account": "me@example.com", "disabled": true}'
curl -X POST http://localhost:3456/teamclaude/priority \
  -H 'content-type: application/json' -d '{"account": "me@example.com", "place": "first"}'
```

`POST /teamclaude/priority` takes `{"account", "place": "first" | "last"}` or `{"account", "priority": <integer>}`; `POST /teamclaude/disable` takes `{"account", "disabled": true | false}`. Both accept an optional `"org"` (name or uuid) for an email that holds accounts in several orgs — an ambiguous name is refused rather than guessed. Unlike `switch`, these are config **writes**: the change is saved to the config file under the same lock the TUI uses, and the server reloads itself afterwards, so it survives a restart. `place` is relative — `first` lands one below the lowest priority in the fleet, `last` one above the highest — and the reply carries the account as it now stands (`{"ok": true, "name": ..., "priority": ...}` or `{"ok": true, "name": ..., "disabled": ...}`), so a caller learns the number it did not choose. An unknown or ambiguous account, or a priority that is not an integer, is a `400` with the reason; a write that landed but whose reload failed is a `500` that says so, since the file did change. A request authenticated with a `proxy.clientKeys` entry is refused with `403`: a client key is for using the fleet, not for changing which accounts it contains. Use the shared proxy key, or call from the proxy's own machine.

### Account sign-in and removal endpoints

Removing an account and signing one in have endpoints too, which the dashboard's buttons call:

```bash
curl -X POST http://localhost:3456/teamclaude/remove \
  -H 'content-type: application/json' -d '{"account": "me@example.com", "provider": "codex"}'
```

`POST /teamclaude/remove` takes `{"account"}` (any identifier `switch` takes) with an optional `"provider"` (`anthropic`, `codex`, …) and `"org"`, for one email that holds a Claude and a Codex login or seats in several orgs. An ambiguous name is a `400` and an unknown one a `404`. The only account is refused with `409`: a config with no accounts stops the server from starting. The account leaves the running fleet and the config file at once, credentials included, and the reply is `{"ok": true, "name", "provider", "persisted"}`. A removal waits for a reload in progress. A `500` means the account may already be out of the running server but the config file could not be saved.

A sign-in is four calls, all POSTs with a JSON body. `login/start` `{"provider": "claude" | "codex"}` answers `{"id", "provider", "url", "browserUrl", "listening", "note"}`: `url` is the link to open (it works from any device), and `browserUrl`, Claude only, is the link whose redirect reaches this machine's loopback listener. `login/code` `{"id", "code"}` takes what the browser was left with: Claude's code, or the whole `http://localhost:1455/auth/callback?…` address for Codex. A paste that cannot be used is a `400` with the reason, and the sign-in keeps waiting. `login/status` `{"id"}` answers `state`: `waiting`, `finishing` (the code has arrived, by paste or the listener, and is being exchanged), `succeeded` (with `account`, `action`, `added` or `updated`, and `fileBacked`, true when the account reads its tokens from an `importFrom` file and so does not use the ones just stored), `failed` (with a one-line `error`), `cancelled`, or `unknown` for a sign-in that was replaced or that a restart forgot. `login/cancel` `{"id"}` gives up and closes the listener. The server runs one sign-in at a time, and starting one cancels the one before, unless that one is `finishing`: then `login/start` is a `400` until it ends. `login/cancel` answers `cancelled: false` once the code has arrived. A sign-in waits five minutes. All five routes are refused for a `proxy.clientKeys` key with `403`.

### Client key endpoints

The Clients page's **Client keys** card calls three endpoints, which add, revoke and read back `proxy.clientKeys` entries:

```bash
curl -X POST http://localhost:3456/teamclaude/client-keys/create \
  -H 'content-type: application/json' -d '{"name": "laptop"}'
```

`POST /teamclaude/client-keys/create` takes `{"name"}`: up to 64 letters, digits, spaces and `. _ @ -`, starting with a letter or digit. It generates a key, writes `{ "name", "key" }` to `proxy.clientKeys` under the config lock, reloads, and answers `{"ok": true, "name", "key", "firstKey"}`. `/teamclaude/status` lists the configured names under `clientKeys` and never the keys; only this reply and `show` return one. `firstKey` is `true` when the proxy had no key at all before, so callers on other machines, which the open gate admitted until then, now need one. A name already in use is a `400`, since two keys under one name would share one usage counter. `POST /teamclaude/client-keys/revoke` takes `{"name"}`, removes every entry under that name, reloads, and answers `{"ok": true, "name", "removed"}`. A client using the key is refused from then on. The usage already booked under the name stays. An unknown name is a `400`, and so is the proxy's last key when there is no `proxy.apiKey`: with no key left the gate would admit everybody, so set `proxy.apiKey` first. A reload failure on either is a `500` that says the file was saved. `POST /teamclaude/client-keys/show` takes `{"name"}` and answers `{"ok": true, "name", "key"}` with the key stored under that name (the first, if a hand edit gave the name two), uncached, writing nothing. An unknown name is a `400`. All three are refused with `403` for a `proxy.clientKeys` key, so only the shared proxy key or a key-exempt loopback caller can manage or read keys.

### TUI keyboard shortcuts

| Key | Action |
| --- | --- |
| `s` | Switch active account (`←`/`→` picks the default account or a specific [route](routing.md#model-routes)) |
| `d` | Enable/disable an account |
| `l` | Sign an account in again (opens on the first account in `error`; not in attach mode). A panel shows the sign-in link, clickable and copied to the clipboard, and takes the pasted answer back, so it works over SSH — see [Signing in again from the TUI](accounts.md#signing-in-again-from-the-tui) |
| `p` | Refresh quota on all accounts (one-shot probe of the zero-spend usage endpoint) |
| `R` | Reload accounts from config |
| `g` | Settings (threshold, quota probe, quota-bar contents, routing, add/remove/reorder/sort accounts, upstream and account proxies, sx.org) |
| `q` | Quit |

In selection mode, use `j`/`k` or the arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

The settings screen is a list, not a set of letter shortcuts: `↑`/`↓` move between rows, `←`/`→` change the value in place (threshold by 1%, probe by 30s, modes cycle), `Enter` opens a row that needs typing or a sub-screen, `Esc` goes back.

**Reorder accounts** opens the account list with the same two pairs of keys and one extra job for them: `↑`/`↓` pick the account, `←`/`→` move *that account* up and down the list, `Enter` or `Esc` goes back. Every move applies as you make it and is written a moment after the keys stop (or on leaving the screen), so there is nothing to confirm and nothing to cancel. An account moves among the accounts of its own provider: a mixed Claude and Codex fleet is drawn grouped by provider, so a move that would cross into the other group does nothing. This is the order the list is **drawn** in and nothing else — rotation order is [`priority`](routing.md#choosing-an-account), which the screen never touches. `teamclaude attach` draws the same order: each account in `/teamclaude/status` carries its `displayOrder` (`null` until it has been placed).

**Sort accounts** chooses what orders the list inside each provider group: **arranged** (your order, above), or the soonest reset of one window — **session reset** (five-hour), **weekly reset**, **S7 reset** or **F7 reset** — which puts the account whose window ends soonest at the top: the quota you lose first if nothing spends it. S7 and F7 read the all-models weekly on an account that has no Sonnet or Fable bucket of its own, since that is the window its Sonnet or Fable use counts against. Accounts with no reading for the window go last (for the session sort, that includes every account with no five-hour window open), and your arrangement breaks ties. A third-party backend sorts by its probed windows, with the monthly one standing in for a weekly reset the plan does not have. The reorder screen always shows the arranged order, because that is the order it edits. `teamclaude attach` reads the same `accountSort` from its own config file.

## Run Claude Code through the proxy

```bash
teamclaude run
```

`run` probes the proxy first. If it's up, Claude Code is routed through it; if it's **not** running, `run` errors out rather than silently bypassing the proxy — which would spend your own quota with no rotation. Pass `--auto-fallback` to launch `claude` directly instead when the proxy is down:

```bash
teamclaude run --auto-fallback
```

Since **1.1.0**, `run` defaults to [MITM forward-proxy mode](proxy-modes.md#mitm-proxy-mode-default) so even hardcoded `api.anthropic.com` endpoints are intercepted. For the previous base-URL-only behavior, pass `--no-mitm` — or set `defaultClientMode: "base-url"` in the config (the **Client mode** row on the TUI settings screen) to make that the default for `run` and `env` alike, with `--mitm` opting back in per launch:

```bash
teamclaude run --no-mitm
```

Arguments after `--` go to `claude`:

```bash
teamclaude run -- --model opus
```

**Claude Code still needs a login of its own.** In both modes the client checks its local login (`~/.claude/.credentials.json`, or the Keychain on macOS) before it sends anything, and the proxy only sees a request once that check passes. The pool's accounts do not stand in for it: they are what the proxy uses upstream, and the two expire independently. So a `claude` that exits at once with `Failed to authenticate: OAuth session expired and could not be refreshed` is reporting its own login, not the pool — run `claude auth login` and launch again. `run` prints a hint to that effect when `claude` dies within seconds of launch and the local login is missing or past its expiry.

### Setting the environment yourself

`teamclaude env` prints the same export lines `run` uses:

```bash
eval "$(teamclaude env)"           # MITM: HTTPS_PROXY + NODE_EXTRA_CA_CERTS
eval "$(teamclaude env --no-mitm)" # base-URL: ANTHROPIC_BASE_URL only
eval "$(teamclaude env --mitm)"    # MITM regardless of defaultClientMode
claude
```

Only the export lines go to stdout (so `eval` is safe); a short summary and any hints go to stderr. No `ANTHROPIC_API_KEY` is emitted — loopback clients are exempt from the proxy key gate, and setting it would drop Claude Code out of subscription mode. A remote (non-loopback) client must add the proxy key itself.

**The proxy variables are shell-wide.** In MITM mode the eval exports `HTTPS_PROXY` and friends, and every other tool in that shell — `gh`, `git`, a package manager — follows them to a listener that only speaks to the providers' hosts; in a sandboxed shell that can surface as a synthetic 403 from an unrelated command. If that is your shell, set `defaultClientMode: "base-url"` (the **Client mode** row on the TUI settings screen): `env` then emits `ANTHROPIC_BASE_URL` only and, re-evaluated, unsets the proxy variables an earlier MITM eval left pointing at this proxy, leaving a real corporate proxy alone. `teamclaude run` scopes the variables to the `claude` process either way.

**Your own `NO_PROXY` is kept.** `run` and `env` both set `NO_PROXY=localhost,127.0.0.1,::1` and append whatever the launching shell already had. That matters for local development: a dev server on a name like `app.test` resolves to 127.0.0.1 through a local resolver, and a forward to loopback is refused, so a client that proxied it would get a 403 on every retry. `export NO_PROXY=.test` before the eval (or before `run`) and the launched client gets `localhost,127.0.0.1,::1,.test`. The one entry that is dropped is `*` — it would send `api.anthropic.com` around the proxy as well, silently ending rotation; use `--no-mitm` for a direct launch.

**Using an agent multiplexer or a tool that spawns `claude` itself?** Export this environment in the process that launches those `claude` instances — e.g. `eval "$(teamclaude env)"` in the shell you start the multiplexer from. Every spawned `claude` then gets the same routing (and MITM interception of hardcoded endpoints) without going through `teamclaude run`. The trade-off: `run`'s proxy-up/down guard only applies when you launch via `run`, so start the server before the multiplexer.

### Routing plain `claude` automatically

So you don't have to type `teamclaude run` every time, add a shell alias that sends plain `claude` through the proxy:

```bash
teamclaude alias              # print the alias for your shell
teamclaude alias --install    # or write it to your shell rc (--uninstall to remove)
```

This is an interactive-shell alias — it affects `claude` typed at a prompt, not `claude` spawned by editors or scripts. It's a thin passthrough to `teamclaude run`, which holds the proxy-up/down logic (so it errors when the proxy is down; add `--auto-fallback` to launch claude directly instead).

## Command reference

```bash
teamclaude login             # Add an account via OAuth (--api for an API key)
teamclaude import            # Import credentials from Claude Code
teamclaude server            # Start the proxy (--headless for plain logs)
teamclaude run               # Run Claude Code through the proxy
teamclaude env               # Print export lines for routing claude yourself
teamclaude alias             # Print/install a `claude` alias that routes via the proxy
teamclaude accounts          # List accounts with subscription tier and token status
teamclaude status            # Show live proxy status (requires running server)
teamclaude attach            # Open the live dashboard against a running server
teamclaude dashboard         # Open the web dashboard in the browser (needs server)
teamclaude service install   # Run the proxy as a login service (uninstall/status/print)
teamclaude switch [name]     # Prefer an account; no name lists them (needs server)
teamclaude remove <name>     # Remove an account (by name or email)
teamclaude disable <name>    # Temporarily exclude an account from rotation
teamclaude enable <name>     # Re-enable it (also clears a stuck error state)
teamclaude priority <name> 1 # Set rotation priority (lower = preferred)
teamclaude rename <name> <new> # Rename an account (and the routes that list it)
teamclaude route list        # Manage per-model routes (add/rm)
teamclaude threshold 90      # Utilization at which rotation leaves an account
teamclaude distribute on     # Spread new sessions across equal-priority accounts
teamclaude distribute affinity  # Spend a 5-hour window about to reset first; conversations stay put until their account is out of usage
teamclaude probe 300         # Enable background quota refresh (off by default)
teamclaude warmup 600        # Enable keep-warm (off by default, spends quota)
teamclaude warmup reset 15:30 --timezone Europe/Moscow
                             # Schedule warm-up for a daily target reset
teamclaude warmup rolling 15:30 --timezone Europe/Moscow
                             # Anchor resets at 15:30, then continue every 5h
teamclaude api <path>        # Call an API endpoint with account credentials
teamclaude callback login    # Sign in to callback.net: keep OAuth tokens in step across your installs
teamclaude callback status   # (also: sync, logout) — see docs/accounts.md
teamclaude update            # Check npm for a newer teamclaude and install it
teamclaude version           # Print the installed version
teamclaude help              # Show all commands
```

`teamclaude status` prints the same picture as the TUI, once, as text. Handy over SSH or in a script; `--json` for machine-readable output. The JSON's `server.version` is the version of the process answering — read once at startup, so right after `teamclaude update` it still names the old code until the restart, where the installed CLI's `teamclaude version` already names the new one; `server.pid` is that process's id, so a caller can tell which server answered on a port. Each account's shared windows carry the time upstream last stated them, beside the value: `quota.unified5hSeenAt` and `quota.unified7dSeenAt`, in epoch milliseconds, for Claude and Codex accounts alike. Only a response or probe that states that window's utilization moves its stamp; a reset time alone, a failed probe or a model-scoped weekly bucket does not. (A Codex subscription states its only 5-hour window inside a model-named family; that reading is the account's 5-hour value, so it moves the 5-hour stamp.) The stamps survive a restart, and a value restored from a state file written before they existed reads `null` until upstream states it again, so `null` means "age unknown", never "just now".

`teamclaude attach` opens the terminal dashboard itself against a server that is already running, which is how you get interactive control back when the proxy runs as a background service. It polls the same status endpoint every second and can do the two things the remote control exposes: `s` switches account, `R` reloads config. The browser dashboard adds the matching **Reload config** action plus a zero-spend **Probe quotas** action; settings editing and the request activity stream still stay in the server's own TUI because they need state that only that process has. When contact with the server drops, the header marker turns from `▲` to `▼` and what is on screen is the last snapshot, not the current state.

`teamclaude service install` registers the proxy as a user service that starts at login and restarts on its own — a LaunchAgent on macOS, a `systemd --user` unit on Linux (`uninstall`, `status` and `print` round it out; `print` writes the unit to stdout without touching anything). On macOS the LaunchAgent runs with `ProcessType` `Standard`: the `Background` class it used before carried a QoS clamp that starved the proxy under host contention (status timeouts, seconds of event-loop lag). The unit is only written at install time, so an existing install keeps whatever it was installed with until you re-run `teamclaude service install`.

![teamclaude status output](assets/status-redacted.png)

## Control routes under a second name

Every `/teamclaude/…` route the server exposes — `status`, `quota`, `logs`, `reload`, `switch`, `disable`, `priority`, `remove`, `login/start`, `login/code`, `login/status`, `login/cancel`, `threshold`, `probe`, `dashboard` and `mcp` — also answers at the same path under `/teamrouter/…`, with the same gates and the same replies. It is the first step of the [rename to TeamRouter](../README.md#renaming-to-teamrouter); scripts and dashboards written against `/teamclaude/…` keep working unchanged.

## Status dashboard (browser)

`GET /teamclaude/dashboard` serves a self-contained HTML page rendering the same data as `teamclaude status`, refreshed every few seconds. A sidebar groups its pages: **Overview** (Quota, Sessions, Clients), **Accounts**, **Observe** (Logs, Problems) and **Control** (Routing, Settings). The open page is kept in the address's `#fragment`, so a reload or a bookmark comes back to it. The dashboard uses the TeamRouter name and a mark of three red bars on a dark red tile in its sidebar and browser tab. The icon is embedded in the page and needs no asset request. Both `/teamclaude/dashboard` and `/teamrouter/dashboard` work.

`teamclaude dashboard` opens this page in the system browser against a running server (it starts none; use `teamclaude server` or `teamclaude service install` for that). The **Theme** button at the foot of the sidebar cycles system → light → dark; the choice is kept in the browser's localStorage, and "system" follows the browser's `prefers-color-scheme`. Dark is what a browser that states no preference gets.

### Quota

Tabs across the top — **All**, **Claude**, **Codex**, and one per third-party backend (DeepSeek, z.ai, NanoGPT, or the backend's host name) — narrow the page to one group. Each group has a summary card: the quota left in its first column, pooled across its enabled accounts (five accounts at 80% left read `400% of 500% left`), with one bar segment per account and the soonest reset; the other columns' totals sit behind **Show**.

Claude and Codex each have a **5-hour limit** card beside their existing summary. It pools the five-hour quota left across enabled accounts with a reading, with the same per-account segments and soonest reset. It uses the five-hour reset times, independently of the weekly card. Accounts without a five-hour window contribute no capacity; when none report one, the card says **no reading yet**. Provider tabs filter both cards together, and the cards stack on narrow screens.

Under the cards, each account is one row with three quota columns, always in this order:

1. **7-day Fable**, named for the newest Fable model the fleet has served (*7-day Fable 5.1*);
2. **5-hour limit**, the session window;
3. **7-day limit**, the shared weekly bucket.

Each column says how much is **left**, green until 70% is used, amber to 90%, red past it, with the reset countdown and clock time. A Codex account has no Fable bucket, so its first column stays blank. A plan with no five-hour window has no 5-hour column, by the same rule `teamclaude status` and the TUI use. Any other model-scoped weekly bucket upstream reports (Sonnet) is behind a **Show** link under the row. A third-party backend that publishes its own quota fills the columns with its own windows. The row's badges carry the plan (`Max 20x`, `Pro`, …), the account's state when it is not plain `active`, its recent and known conversations, banked resets, and the models it served lately. Why an account is blocked, its outside spend and its forecast go on a line under the columns, only when there is something to say. The plan and the backend come from `plan` and `backend` on each `/teamclaude/status` account entry. `plan` is read from the account's rate-limit tier or Codex plan type (`null` when unknown). `backend` is the host name of an API-key account's `upstream` (`null` for OAuth accounts).

When the shared **7-day limit** or **7-day Fable** has no quota left, the dashboard shows the **5-hour limit** as **0% left**, with “Weekly limit empty” below it. This reflects usable capacity even if the five-hour window has just reset; the provider's readings and routing stay unchanged. Fable exhaustion affects this display even when another model still has quota.

The Quota page hides accounts with an empty main quota window by default (Fable, five-hour, shared weekly, or a displayed token/backend budget). **Show all** reveals them; **Hide exhausted** hides them again. The choice survives automatic refreshes and provider-tab changes until the page reloads. Unknown quota stays visible, and an expired window stops hiding its account. Provider counts and summary cards still include hidden accounts. The **Accounts** page always lists every account for management.

With [drain mode](routing.md#drain-mode) on, the card also names the account being drained and when it resets, and each row's badge says `draining` or its place in the queue (`#2 in queue`), from `drainQueue` and `accounts[].drainRank` in `/teamclaude/status`.

Each row for an account the quota probe can read (a Claude or Codex subscription, or a backend that publishes its own quota) has a **Refresh quota** button: a one-shot, zero-spend probe of that account alone, sent as `POST /teamclaude/probe` with an `{"account": ...}` body (see [Quota probe](quota.md#quota-probe)). The row's bars update on the poll after it, and a failure — the usage endpoint not answering, say — shows under the row. Like **Probe quotas** it spends nothing, so a page holding a `proxy.clientKeys` key keeps it. A disabled account has no refresh button, since the probe leaves accounts out of rotation alone.

Each enabled account that is not the current one has a **Switch to** button that makes it the current one (the same `POST /teamclaude/switch` the CLI uses). It is a nudge, not a pin: normal rotation resumes from there. What happens to traffic already running depends on `distributeSessions` — with it on, a conversation pinned to another account keeps it until it goes idle, so the badge moves before the traffic does; with it off (the default), everything follows the switch on its next request. The page reports whether rotation will actually use the target: an errored, rate-limited, or over-threshold account — or one outranked by a higher-priority account — is still switched to, but the page says so and why rather than reporting a bare "done".

### Accounts

The accounts are listed by provider, each under its own heading: **Claude accounts**, **Codex (ChatGPT) accounts**, and one section per third-party backend. The Claude and Codex sections are always there, empty or not, so the page says where a sign-in will land before there is one. Each provider keeps one colour wherever the dashboard draws it: Claude's sections, tabs, dots and badges are orange, Codex's green, and backends violet, so a Claude login and a ChatGPT login never look alike.

**Sign in to Claude** and **Sign in to Codex**, at the top of the page, add an account from the browser: see [Signing in from the dashboard](accounts.md#signing-in-from-the-dashboard). A Claude or Codex login that upstream has signed out (`error`) has a **Sign in again** button on its row, which opens the same panel. **Remove** takes an account out of TeamClaude after a second click to confirm: see [Removing an account](accounts.md#removing-an-account). None of these is drawn for a page holding a `proxy.clientKeys` key.

Each section is a table: plan, state, priority, conversations, requests, tokens and when the account was last used, with **Switch to**, **Disable** / **Enable** (`POST /teamclaude/disable`) and, for an enabled account, **Prioritize** and **Deprioritize** (`POST /teamclaude/priority` with `place: "first"` / `"last"`). Unlike switch, these write the config file and reload the server — the same as `teamclaude disable`, `enable` and `priority --first` / `--last` — so they persist across restarts. A disabled account shows only the enable button: reordering an account that nothing will select is a control that looks like it does something and does not. The result of any account button appears under that account's name for a minute; a priority move reports the number the account landed on, since a relative move picks a number the operator did not type. These are refused when the page holds a `proxy.clientKeys` key rather than the shared proxy key (see the endpoint notes above), so for such a key the page does not draw them.

Under each name sits the account's organization and, when the account has been renamed away from its email (`work`, `account-1`), the email it signed in with, from `email` on each `/teamclaude/status` account entry. An account named by its email does not repeat it. The email is stored at sign-in. A Claude account added before emails were kept shows none (`null` in the status) until its profile is read again: its **Refresh quota** button on the Quota page, or a [quota probe](quota.md#quota-probe) cycle when that is on, reads it once at no quota cost and keeps it in the state file. Signing the account in again stores it in the config. `teamclaude accounts` also saves it, but that command renames every Claude account to its email, so it is not the way to keep a custom name.

### Logs

The Logs page is what happened to the accounts, newest first:

| Kind | Entries |
|---|---|
| **Usage** | Every request served: account, the client that sent it, model, status, input and output tokens, latency. The **Client** column is the [client key](configuration.md)'s name, when the request used one, and the first word of its User-Agent (`claude-cli/2.1.3`, `codex_cli_rs/0.46.0`). With `proxy.logPrompts` on, the row also quotes the prompt: the last thing a person typed in that conversation, up to 300 characters. A request the proxy refused before choosing an account is listed without one. |
| **Sign-in** | An interactive sign-in from the terminal's login panel: started, succeeded, failed, timed out or cancelled. A failure says why in a fixed phrase (the provider's HTTP status, or its OAuth error code), never the provider's own text. A config reload that brings an account fresh credentials is listed here too. |
| **Auth** | An account losing its credentials: an OAuth account signed out (refresh token rejected, credentials gone), an API key refused with a 401. Once per transition, not once per request. |
| **Rotation** | The router moving off an account: a switch, a rate limit, a session-window reset, every account exhausted, a hold. |
| **Changes** | An account enabled, disabled, reprioritized or switched to by hand, the switch threshold changed, accounts added or removed by a reload. Recorded wherever the change came from: the dashboard, the CLI, the TUI, MCP or a hand edit of the config file. |

Chips narrow it to one kind, and two selectors to one provider or one account. The page asks for the log only while it is open.

The log lives in the proxy's memory: the last 2000 events, and a restart begins a fresh one. The file logs (`--activity-log`, `logDir`, see [Request logging](#request-logging)) stay the durable record.

`GET /teamclaude/logs?after=<id>` is the endpoint behind it. It answers `{ "events": [...], "lastId": <n>, "capacity": 2000, "generation": "<id>" }`: the entries newer than `after`, oldest first, at most 500 per reply (the newest ones when there are more). Each entry has `id`, `at` (ISO time), `kind` (`usage`, `signin`, `auth`, `rotation`, `control`), `type` (`request`, `signin_failed`, `signed_out`, `switch`, …), `provider`, `account` and a one-line `message`, plus `model`, `status`, `inputTokens`, `outputTokens`, `ms`, `reason`, `client` (the client key's name), `agent` (the User-Agent's first word) and `prompt` (only with `proxy.logPrompts` on) where they apply. `generation` names the log. Ids start again at 1 when the server restarts, so a reply with a different `generation` from the one you hold means a new log: drop what you hold and read it from `after=0`, which is what the page does. It has the same gate as `/teamclaude/status`, so a client key may read it. An entry therefore names an account by its configured name only, never an email, a token or an org id. A `/tc-acct/` pin is not kept either: a request whose pin named no account reads `(unknown account pin)`. A failure carries a short reason, never an upstream response body. Prompts are off by default for the same reason: anyone who can read the log reads them, so turn on `proxy.logPrompts` only when every key holder may see what you type.

### Problems

A **warning banner** sits at the top of every page and is empty unless something is wrong; the **Problems** page lists the same things, and its sidebar count turns red while there are any. It reports a conversation that has had several client requests in a row come back with nothing usable — the case that reads as zero tokens exactly like an idle one, and is otherwise invisible — plus an account that needs a person (a broken token or a disabled entry). A spent quota bucket on **one** account, a rate-limit back-off and an upstream refusal are **not** reported: those clear themselves, and a banner that is always on is one nobody reads. When *every* account is over its threshold or in a hold, conversations do start starving — and the banner says which of the two it is, rather than blaming the conversation. Overage spend is not reported either: it is a month-to-date figure, so it would be lit for most of the month; the account's row and `teamclaude status` carry it with the amount. With `proxy.sessionDetail` off the banner still fires, but names neither the session nor the conversation.

### Routing

The Routing page starts with how the fleet is routed: the [session distribution](routing.md#session-aware-routing) mode and what it does, the switch threshold, and in drain mode each provider's queue. Under it, a **Routes** table shows, for Fable, Sonnet, and any configured route, which account rotation would pick for a new request of that family and how many accounts could serve it — the ones that cannot are struck through, which is the reason the family is elsewhere. A pinned route names its pin, and says so when the pin is not eligible right now. The last rows are everything without a route of its own, one per provider in the fleet ("Claude default", "Codex default"): each names the server's default target for that provider, which is that provider's current account unless it is blocked or outranked, in which case the row says why. A Claude and a Codex pool keep independent cursors, so the header line and the `current` badge on each row are per provider too. Targets are the server's own answers (`routes[].target`, `defaultTargets` and `currentAccounts` in `/teamclaude/status`; the older single-valued `defaultTarget` and `currentAccount` are still emitted. `currentIndexes` is `currentAccounts` by position: an object keyed by provider whose value is the current account's zero-based index into the status `accounts` array, or `null` when nothing can serve that provider — a name alone is ambiguous when two accounts share one, and it is what the attached TUI uses to place each `►`), not something the page derives from the quota bars; they describe a fresh request, not one a running conversation has already pinned elsewhere.

### Settings

A **Switch at __ %** control sets the fleet-wide switch threshold, the utilization at which rotation leaves an account — the same setting as `teamclaude threshold <1-100>` and the TUI's settings screen, sent as `POST /teamclaude/threshold` with a `{"percent": 1-100}` body. Unlike the switch button this writes the config file and reloads, so it holds across a restart. One number replaces a per-bucket `switchThreshold` table, and the page says which buckets were dropped; per-account `accounts[].switchThreshold` overrides are untouched. The field follows changes made from the CLI, the TUI or another browser on the next poll, except while you are typing in it. A dashboard opened with a `proxy.clientKeys` key may not call it — the server answers 403, since a client key is a tenant of the proxy rather than its operator — so for such a key the page shows the number read-only, without the **Set** button.

**Reload config** and **Probe quotas** mirror the corresponding TUI actions without spending message quota. One line says which client key the page is using, that account and settings changes need the proxy key, and has a **Change key** button back to the key box.

### Sessions and Clients

With `proxy.sessionDetail` on, the Sessions page shows each conversation's session, client, project, serving accounts, and what it actually spent per weekly bucket — cache reads and cache creation included — filterable by project or client. A client session that fans out to subagents is one row per agent: the rows carry the same **Session** and are told apart by **Conv**, a short digest of the conversation each one is (see [Session-aware routing](routing.md#session-aware-routing)). The table is on by default, including for existing configs that omit the setting. An explicit `proxy.sessionDetail: false` keeps it hidden; remove that override or set it to `true`, then click **Reload config** on the dashboard's Settings page to show it. The list covers conversations observed by this proxy since startup and retains them for one hour after their last activity; it is not a history of sessions that bypassed the proxy. See [Configuration](configuration.md#usage-dimensions).

The Clients page starts with a **Client keys** card. Type a name for the machine or agent the key is for (`laptop`, `ci-agent`) and press **Generate key**. The panel that opens shows the key, with **Copy** buttons. It also gives the two lines that point Claude Code at this proxy with the key (`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`) and the `~/.codex/config.toml` block that does the same for the Codex CLI. The address in both is the one the page is open at. When that is `localhost`, the panel says that a client on another machine needs an address of this one it can reach. **Test key** reads `/teamclaude/status` with the new key and passes only when the server names the key's client. **Done** closes the panel. On a proxy that had no key at all, the first key closes the gate for callers off this machine, the page included. The panel stays up until **Done** and says so, and the page then asks for a key. Under the form, every configured key has its name, when it was last used, a **Show details** button and a **Revoke** button that asks for a second click. **Show details** reads the key back from the proxy and opens the same panel, so you can set up another client long after the key was made; **Hide details** closes it. The card is hidden for a page holding a `proxy.clientKeys` key. See [Client key endpoints](#client-key-endpoints).

The Clients page has a table per client key and, with `proxy.usageDimensions` configured, one sortable table per dimension. A **Usage window** control above them governs all of them. **Total** is the lifetime counter those tables have always shown; **Last 5h** and **Last 24h** show only what was spent inside that window. The tables re-sort on whatever window is selected, so the busiest client of the last five hours is the top row rather than the busiest of all time. **Last used** stays the lifetime figure under every window, since it answers when a client was last seen at all, which a window cannot. The figures come from `windows` on each client and dimension entry in `/teamclaude/status` — a rolled-up `{ requests, connections, inputTokens, outputTokens }` per window. The proxy produces them by tallying traffic into 15-minute slots and keeping only the slots the longest window needs, so a window covers its own length plus at most one slot, and the cost is set by the window rather than by uptime. The slots ride in the state file, so a restart resumes the windows instead of restarting them. A client or value with no traffic in any window carries no `windows` key at all rather than rows of zeros — the windows nest, so an empty longest window means every window is empty — which keeps the status payload close to its previous size on a dimension whose values are mostly stale. A consumer of `/teamclaude/status` should read an absent `windows` as zero in every window, and note that a proxy older than this feature omits it for the different reason that it has no windows to report. The control governs the Clients tables only: the Sessions page reports per weekly quota bucket, which is a different question and is unaffected by it. `5h` is the shared quota window. There is deliberately no 7-day window: the weekly quota is a bucket with a reset instant rather than a rolling window, so an honest weekly figure is "since the reset", not "in the last 168 hours".

### Keys and access

The page knows which controls to hide from `caller` in `/teamclaude/status`: `{ "kind": "operator" | "client", "client": <client-key name or null>, "refused": [<paths>] }`. `refused` lists the control endpoints this key would get a 403 from, read from the same table the server's check uses, so the page and the server cannot disagree; it is empty for the shared proxy key and for a key-less loopback caller.


```
http://localhost:3456/teamclaude/dashboard
```

The page is a static asset and loads without a key; the data does not — its script fetches `/teamclaude/status` first, and asks for the proxy key only if the server refuses the request without one. Loopback browsers are key-exempt as everywhere else, so on the proxy's own machine there is no prompt. A key that is entered is kept in the browser's localStorage, and a 401 after a key rotation brings the prompt back. On deployments that put the proxy behind TLS this works remotely too: `https://your-proxy.example.com/teamclaude/dashboard`.

### Linked instances

If you run TeamClaude on more than one machine, say your desktop and a server, link them so the dashboard on either one shows both. Each machine keeps its own accounts and config; linking only lets one dashboard reach the others.

Each machine needs to listen beyond itself, on a Tailscale or LAN address (set `proxy.host`, or `TEAMCLAUDE_HOST`, to `0.0.0.0` or that address), and needs a `proxy.apiKey`.

**From the dashboard.** You can do the whole thing in the browser:

1. On the machine you want to link, open the dashboard's **Settings** page. Under **Linked instances**, press **Show key**. It shows that machine's proxy key and a best guess at its address. Copy both.
2. On the other machine, open **Settings**, **Linked instances**, **Link another machine**. Paste the address and the key, then press **Test**. The test says whether something answered at that address and whether it accepted the key. If it did, it also fills in the name the other machine gives itself.
3. Leave **Link back too** ticked to link both ways in one step. This machine then asks the other one to list it as well, under the address and name in the two fields below the box (prefilled with this machine's best guess). To do that it sends the other machine this machine's own proxy key, the same way you just gave this machine the other one's. The box is unticked and locked when this machine can't be linked back to: it listens on itself only, or it has no proxy key.
4. Press **Link**. The link is saved to the config file and takes effect at once, without a restart.

To unlink a machine, press **Remove** next to it. That removes it from this machine only. If the other machine lists this one too, remove that link from the other machine's dashboard (pick it in the Instance picker, then go to **Settings**).

**By hand.** On each machine, list the other ones under [`peers`](configuration.md) with an address this machine can reach and that proxy's own `proxy.apiKey`:

```json
"peers": [
  { "name": "server", "url": "http://100.64.0.2:3456", "apiKey": "<the server's proxy.apiKey>" }
]
```

Then reload with **Reload config** on the Settings page, or `curl -X POST http://localhost:3456/teamclaude/reload` on that machine.

An **Instance** picker appears at the top of the sidebar, with **This machine** and each linked instance. Pick one and every page shows that machine: quota, accounts, logs, routing and settings. Every button acts on it too, sign-in included. A line above the page says which instance you are looking at, with **Back to this machine**. The picker marks an instance it cannot reach as `offline`, and one that refuses its key as `refused`. It checks each one at most every 15 seconds, and only while something reads the status.

The browser still talks only to the machine it opened the page on. That proxy forwards each request to the linked one as `/teamclaude/peers/<name>/<route>`, using the key from `peers`, so the browser never holds the other machine's key. Only the control routes are forwarded, never model traffic. Only the operator can use the forwarding: the shared `proxy.apiKey`, or a key-exempt loopback browser. A `proxy.clientKeys` key gets a 403. If a linked machine is down, its pages show why and the rest keep working. If the machine you opened the page on is down, open the dashboard on another one instead.

## MCP endpoint

The running server can expose its control plane to Claude Code (or any other MCP client) as tools, so an agent can check the fleet's quota, switch accounts, or change a rotation setting from inside a session. It is off until the config says otherwise:

```json
{ "proxy": { "mcp": "read" } }
```

`"read"` serves `get_status` (the fleet at a glance: server version, current account, and for each account its priority, whether it is disabled, whether rotation can use it and why not, sessions and known quota windows), `get_quota` and `get_settings`. `"full"` adds everything the CLI's management commands can do: `switch_account`, `reload_config`, `probe_quota`, `set_account_enabled`, `set_account_priority`, `set_account_routing`, `remove_account`, `set_threshold`, `set_distribution`, `set_probe_interval`, `set_warmup`, `set_route`, `remove_route`, `set_blocked_models` and `set_client_mode`. There is no tool for adding accounts or handling account credentials, and none for changing `proxy.mcp` itself. `set_account_routing` does take a proxy URL with its password, and the write log prints that URL masked. `reload_config` re-reads the file and reports how many accounts it added and how many it removed: an account whose entry is gone from the file is dropped from the running fleet (see [accounts](accounts.md)). A reload picks the `proxy.mcp` setting up, so the endpoint can be opened, narrowed or closed while the server runs.

Point Claude Code at it once; `teamclaude run` and `teamclaude env` already keep loopback out of the proxy variables, so the connection goes straight to the server and is key-exempt like every other loopback caller:

```bash
claude mcp add --transport http teamclaude http://localhost:3456/teamclaude/mcp
```

A client elsewhere on the network presents the proxy key the same way the CLI does: `--header "x-api-key: tc-…"`.

The endpoint is one more `/teamclaude/` route and is gated like the others: the proxy key or loopback, no cross-origin requests, and, for a caller admitted without a key, a Host header naming this machine. Three things follow from that. Every holder of any proxy key can read through it, but a named `proxy.clientKeys` key is served the `"read"` tools even when the setting is `"full"`: the write tools — removing an account among them — answer only to the shared `proxy.apiKey` and to key-exempt loopback callers, so handing a client its own key never hands it the fleet. With no proxy key configured at all, the endpoint serves only callers on the proxy's own machine (a loopback peer, no `X-Forwarded-For`/`X-Real-IP`/`Forwarded` header, and `proxy.trustLoopback` not set to `false`) and answers 403 to everyone else; set `proxy.apiKey` to reach it over the network. And a browser-based MCP client cannot reach it, because it sends an `Origin` header and is refused as cross-origin; the endpoint is for clients that run as programs. Each write is logged by the server as one line naming the tool and the arguments.

It speaks both the stateless 2026-07-28 revision of the protocol and the handshake revisions before it, so a client on either works. Replies are plain JSON, never a stream.

## Auto-update

When TeamClaude is installed globally via npm, it self-updates in the background: it checks the npm registry at most once a day, and when a newer version is published it runs `npm install -g @karpeleslab/teamclaude@latest` and applies it on the next launch. The check runs after a `teamclaude run` session ends and when a headless server starts. In a headless server the install runs as a background child process, so the proxy keeps serving requests while npm works (a synchronous install used to stall it for the duration). A git checkout is never touched — update that with `git pull`. Run `teamclaude update` to update on demand.

Disable it with `TEAMCLAUDE_DISABLE_AUTOUPDATE=1` or `"autoUpdate": false` in the config.

## Request logging

Log request/response details to a directory, one file per logged request:

```bash
teamclaude server --log-to /tmp/requests
```

Bodies are truncated past a size cap, and files older than the retention window are deleted — see [`logLevel`, `logMaxBodyBytes` and `logRetentionHours`](configuration.md#fields) to widen or disable them. The first start after upgrading sweeps whatever in that directory is already older than the window.

`--activity-log FILE` appends the TUI activity lines to a file instead, and works in headless mode too.

Claude Code's telemetry (`/api/event_logging/*`) is high-volume activity-log noise and is hidden from the log by default; see [`eventLogging`](configuration.md#fields) to block or show it instead.
