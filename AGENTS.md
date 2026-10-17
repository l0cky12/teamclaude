# AGENTS.md

Instructions for AI coding agents working in this repository. Claude Code
loads this through `CLAUDE.md`; Codex reads it directly. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and [test/README.md](test/README.md) too:
everything there applies to agents as well.

## What this project is

TeamClaude (npm `@karpeleslab/teamclaude`, MIT) is a local multi-account proxy
for Claude Code and the Codex CLI. It pools one person's own Claude Max,
ChatGPT/Codex, API-key and third-party backend accounts (DeepSeek, z.ai/GLM,
NanoGPT) and rotates between them before the 5-hour and 7-day limits run out.
It exists for a single person's accounts. Do not build features for sharing
accounts between people (see [docs/compliance.md](docs/compliance.md)).

The project is being renamed to TeamRouter (issue #72, `src/brand.js`). Both
the `teamclaude` and `teamrouter` binaries point at `src/index.js`, and both
names must keep working.

Distribution: npm, a Docker image on GHCR (node 22-alpine), a Nix flake with
NixOS and Home Manager modules (`flake.nix`, `nix/`), and
`teamclaude service install` for a user service.

## Stack

- Plain JavaScript ES modules. No build step: `src/` is what ships.
- Types are JSDoc, checked by `tsc` (`tsconfig.json`), plus a strict-mode
  ratchet (`tsconfig.strict.json`, `scripts/typecheck-strict.mjs`).
- Node >= 20. CI runs Node 20, 22 and 24.
- **No runtime dependencies.** Only `node:*` built-ins. Dev dependencies are
  eslint, typescript and `@types/node`.
- Tests use `node:test` with `node:assert/strict`.

## Layout

- `src/`: a flat directory of about 70 modules. The main entry points:
  - `index.js`: CLI dispatcher (`start`, `accounts`, `login`, `status`, `service`, …).
  - `server.js`: `createProxyServer`, request listener, `forwardRequest`,
    `streamResponse`, and the `/teamclaude/*` control routes.
  - `account-manager.js`: `AccountManager`, `getActiveAccount`,
    `pickAlternate`, `ensureTokenFresh`, `updateQuota`.
  - `tui.js`, `tui-remote.js`: the terminal UI and `attach`.
- Module groups in `src/`:
  - Accounts and credentials: `account-id`, `account-pairing`, `identity`,
    `resolve-accounts`, `sync-accounts`, `oauth`, `codex-auth`, `login-flow`,
    `osc`, `callback-auth`, `credential-sync`.
  - Routing and selection: `account-routing`, `adaptive-distribution`,
    `band-decision`, `admission-gate`, `conversation`, `session-tracker`,
    `classification-path`, `forward-target`, `model`, `provider` (the
    `PROVIDERS` map).
  - Quota: `prober`, `warmer`, `warmup-schedule`, `forecast`, `outside-spend`,
    `rollover`, `quota-summary`, `backend-quota`, `codex-quota`,
    `codex-usage`, `codex-reset-credits`, `claude-resets`.
  - Request/response body handling: `account-uuid-rewrite`,
    `tool-pair-sanitize`, `cache-control-sanitize`, `content-block-sanitize`,
    `responses-usage`, `json-format-stream`, `request-log`.
  - Egress: `upstream-proxy`, `upstream-fetch`, `sx`, `egress-guard`, `mitm`,
    `x509`.
  - UI and control: `status-renderer`, `dashboard`, `mcp`, `mcp-tools`,
    `config-ops`, `client-usage`, `session-titles`, `terminal-title`,
    `early-log`.
  - Infrastructure: `config` (`withConfigLock`, `atomicConfigUpdate`),
    `crash-log`, `event-loop-monitor`, `safe-text`, `updater`, `service`,
    `alias`, `claude-env`, `brand`.
- `test/`: about 250 `*.test.js` files (kebab-case) and `test/README.md`.
- `test-helpers/spawn-server.js`: starts a real proxy for tests. It must stay
  outside `test/` so `node --test` doesn't run it as a test.
- `docs/`: user documentation: accounts, configuration, proxy modes, quota,
  routing, usage, compliance.

## How a request flows

1. A request arrives: either the client points at the proxy (run mode) or
   it comes through a MITM `CONNECT` tunnel.
2. Auth: `apiKey` / `clientKeys`, the loopback exemption, CSRF and
   DNS-rebinding checks.
3. Classification: event logging, OAuth token passthrough, `TC_ACCT`
   pinning, client-credential relays, provider by path and host, and
   `placeConversation` for session-aware routing.
4. `getActiveAccount` picks the account.
5. `ensureTokenFresh`, body rewrites, `applyAuthHeaders`.
6. `upstreamFetch` sends it, through any configured upstream proxy or egress
   pinning.
7. The response is handled:
   - quota headers update account state
   - 429: rotate, or pause, with at most one failover hop
   - 5xx or a broken stream: one hop
   - 401: force a token refresh
   - 403: quarantine the account
   - every account exhausted: hold (`holdSeconds`) or return 429
8. `streamResponse` does accounting and hooks while streaming.
9. State is persisted to `teamclaude.state.json`.

The user-facing version is in [docs/routing.md](docs/routing.md#request-lifecycle).

## Features

The README and `docs/` have the full details. In brief:

- Rotation near `switchThreshold` (default 0.98), per-model caps, the two
  kinds of 429, storm control, and model routes.
- Session-aware routing (even and adaptive distribution), expiry-pressure
  routing, `TC_ACCT` pinning, and `holdSeconds`.
- Extra-usage fallback and spending caps.
- Opt-in quota probing and warmup.
- TUI, web dashboard, `status`, `attach`, and an opt-in MCP server.
- MITM mode, upstream proxies, per-account routing, sx.org, egress pinning.
- The Codex pool and Codex reset credits.
- Banked Claude usage-limit resets (`autoRedeemResets`).
- Third-party backends, callback.net token sync, and client keys.
- Request logging, self-update, `alias`, and `service`.

## Commands

```sh
npm install --ignore-scripts      # dev deps only; there is no lockfile on purpose
npm start                         # run the proxy from source
npm test                          # all tests (node --test, 120s timeout)
node --test test/<name>.test.js   # one test file
npm run lint                      # eslint .
npm run typecheck                 # tsc -p tsconfig.json
npm run typecheck:strict          # strict ratchet against the origin/master merge-base
npm run typecheck:strict -- --base <ref>
```

All four checks (test, lint, typecheck, typecheck:strict) must pass.
For the strict ratchet, a file's strict-diagnostic count may not grow, and a
new file must have zero.

## Conventions

- **Code:** each file opens with a `//` header comment saying why the module
  exists, functions get JSDoc, and exports are named. Comments explain *why*.
  ESLint allows unused args prefixed with `_`, uses `eqeqeq: smart`, and
  keeps its globals list in `eslint.config.js`.
- **Tests:** follow `test/README.md`. Assert the mechanism, not the clock.
  No sleeps, no hard-coded dates. Use `test-helpers/spawn-server.js`, clean up
  in `finally`, opt out of the upstream proxy, and clear proxy environment
  variables.
- **Docs:** a user-visible change updates `docs/` or the README. A new
  config key needs a row in `docs/configuration.md` and an entry in
  `config.example.json`.
- **Defaults are conservative:** anything that makes background calls or
  spends quota is off by default.
- **Secrets:** never put tokens, account ids, emails or real config in code,
  tests, commits, PR bodies or logs.
- **Commits and PR titles:** `type(scope): summary`, with the scope
  optional. The types in use are `feat`, `fix`, `docs`, `test` and
  `chore(ci)`. PRs are squash-merged, so the PR title becomes the commit.
- **Branches:** `<type>/<short-slug>`, e.g. `feat/backend-quota-tui`.
- **Releases:** a separate `Bump to X.Y.Z` PR that changes only `package.json`.
  `publish.yml` publishes when the version changes.

## Gotchas

- At runtime the proxy writes `~/.config/teamclaude.json`, its state and
  lock files, and MITM PEMs. Tests must never touch the real ones. The config
  must stay writable because token refreshes are persisted to it. Use
  `withConfigLock` / `atomicConfigUpdate` to change it.
- Don't set `strict: true` in `tsconfig.json`; the ratchet is how strictness
  increases.
- GitHub Actions are pinned by SHA. Keep them pinned when you update them.
- `npm install --ignore-scripts` in CI, and no install step in publish, are
  supply-chain defences. Don't remove them.
- Security issues go through [SECURITY.md](SECURITY.md), not public PRs. The
  only canonical sources are github.com/KarpelesLab/teamclaude and npm
  `@karpeleslab/teamclaude`.

## Where PRs go

This checkout's `origin` is the fork `l0cky12/teamclaude`, and its parent is
`KarpelesLab/teamclaude`. By default, open PRs against `origin` with base
`master`. Only open an upstream PR when the human explicitly asks. For an
upstream PR, cut the branch from `KarpelesLab/teamclaude` `master` (add an
`upstream` remote if it's missing) so `AGENTS.md` and `CLAUDE.md` are not
included.

## Review workflow

Every agent-authored PR goes through this workflow. If the human gives
explicit instructions in the session, those override it.

### Roles

- **Implementer:** writes the change. By default this is Claude.
- **Reviewer:** Codex, model `gpt-6.1-sol`, reasoning effort `high`.
- If you were invoked as the reviewer: review only. Don't edit files, push,
  open PRs, or start another review.

### Small or large

A change is **large** if any of these apply:

- More than about 200 changed non-test lines, or more than about 5 source
  files.
- It touches the core request path: `server.js`, `account-manager.js`,
  `mitm.js`, `upstream-fetch.js`, `provider.js`, the auth and credential
  modules (`oauth`, `codex-auth`, `credential-sync`, `callback-auth`), or the
  body rewriters (`account-uuid-rewrite`, `*-sanitize`).
- It adds or upgrades a dependency, changes the config schema, or changes
  CLI or other public behaviour.
- It touches `.github/workflows/`, `package.json` or `nix/`.
- It is a refactor across several modules.

Everything else is **small**. Nothing is exempt: version bumps are small.
The implementer decides the classification and states it, with the reason,
in the PR body. If unsure, treat the change as large.

### Before each review round

1. Commit the change to a feature branch.
2. Run `npm test`, `npm run lint`, `npm run typecheck` and
   `npm run typecheck:strict`, and fix any failures. Failed local checks do
   not count as a review round.

### Requesting a review

Reviews go only through T3 Code's `delegate_task`. There is no Codex CLI
fallback. Use:

- target: provider `codex`, model `gpt-6.1-sol`, options
  `reasoningEffort: high`
- `role: review`, `mode: async`, shared checkout (no worktree isolation)
- a new `clientRequestId` for every round

The prompt includes:

- the original task
- the classification and its reason
- the diff range (`git diff master...HEAD`)
- the check results
- from round 2 on: every earlier finding and the implementer's response to
  each

Wait for the completion notification instead of polling.

The reviewer returns a list of findings. Each finding has:

- **blocking** or **non-blocking**
- `file:line`
- the problem
- a suggested fix

**Blocking findings:**

- bugs and regressions
- security problems
- behaviour that doesn't match the task
- missing or inadequate tests
- violations of this file, `CONTRIBUTING.md` or `test/README.md`, such as:
  - failing checks
  - a runtime dependency
  - a background call or spending that isn't off by default
  - missing docs or `config.example.json` updates
  - secrets or account ids
  - a change outside the scope of one person's own accounts

**Non-blocking findings:** style and suggestions. Fix them or not; they never
cause another review round.

The implementer may dispute a finding by giving written reasoning instead
of fixing it. The reasoning goes into the next round's prompt.

### Small change: one review

1. Implement, run the checks, and request one review.
2. Fix the blocking findings, and re-run the checks.
3. Open the PR. If there were no findings, open it right away.
4. List any disputed findings in the PR body.

If the fixes go beyond the flagged issues, or would make the change large,
switch to the large flow.

### Large change: up to three reviews

The large flow allows three reviews at most:

review 1 → fix → review 2 → fix → review 3.

- If a review has no blocking findings, open the PR.
- If review 3 still has blocking findings, or a dispute is unresolved, stop
  fixing. Open a **draft** PR labelled `needs-human-review` (create the label
  if it doesn't exist). The body lists:
  - the unresolved findings
  - the implementer's response to each
  - the history of every round

### Outside T3

If `delegate_task` isn't available, for example in a plain CLI session,
review can't run. Don't skip it silently. Open a **draft** PR labelled
`needs-human-review`, and state in the body "Codex review unavailable".

### PR body: Review section

Every agent PR body ends with a `## Review` section containing:

- the classification and its reason
- the number of review rounds
- the reviewer model and effort (`gpt-6.1-sol`, `high`)
- the findings that were fixed
- the findings that were disputed, with their reasoning
- unresolved findings, if any
