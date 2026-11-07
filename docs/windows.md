# Windows installer

On Windows you can install TeamClaude with one installer. You do not need Node.js, npm, Docker or a terminal. You set everything up in the web dashboard.

## Install

1. Open the [releases page](https://github.com/KarpelesLab/teamclaude/releases) and download `TeamClaude-Setup-<version>.exe` from the newest release.
2. Run it. The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Follow the pages of the installer. On the components page, **Start TeamClaude when I sign in** is ticked by default. Keep it ticked if you want the proxy to be running whenever you are signed in to Windows.
4. On the last page, leave **Open TeamClaude** ticked and click **Finish**.

The installer does not need administrator rights. It installs for your Windows account only:

- The program goes to `%LOCALAPPDATA%\Programs\TeamClaude`, unless you choose another folder. It contains `TeamClaude.exe`, a private copy of Node.js named `teamclaude-node.exe`, and the TeamClaude app.
- The Start Menu gets a **TeamClaude** folder with **TeamClaude**, **Stop TeamClaude** and **Uninstall TeamClaude**.
- If you ticked the option, a value named `TeamClaude` under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` starts the proxy in the background when you sign in. It does not open the dashboard.
- **Apps and features** in Windows Settings lists TeamClaude, so you can uninstall it from there.

The installer does not change your `PATH`.

## First run

**Open TeamClaude** starts the proxy in the background and opens the dashboard in your browser at `http://127.0.0.1:3456/teamclaude/dashboard`. The proxy has no window of its own.

1. On the **Accounts** page, click **Sign in to Claude**, **Sign in to Codex** or **Sign in to Grok**, and sign in. Repeat for each of your accounts. See [Signing in from the dashboard](accounts.md#signing-in-from-the-dashboard).
2. On the **Clients** page, use the **Connect your tools** card to point Claude Code, Codex or Grok Build at the proxy. **Connect all** connects every tool it finds. You can do the same from a terminal with `teamclaude connect`.
3. Start your tools as usual. Their requests now go through TeamClaude.

To open the dashboard again later, start **TeamClaude** from the Start Menu. If the proxy is already running, this only opens the dashboard. If it is not running, it starts the proxy first.

If the proxy cannot start, a message box says why and names the log file.

## Stop TeamClaude

Start **Stop TeamClaude** from the Start Menu. It ends the proxy. Your tools cannot reach it until you start **TeamClaude** again.

## Files

| What | Where |
|---|---|
| Settings and signed-in accounts | `%USERPROFILE%\.config\teamclaude.json` |
| Proxy log | `%LOCALAPPDATA%\TeamClaude\teamclaude.log` |
| Program | `%LOCALAPPDATA%\Programs\TeamClaude` |

The settings file holds your sign-in tokens. Do not share it. Every setting is described in [Configuration](configuration.md).

## Update

TeamClaude checks for a new version at most once a day. When one is out, the log says so and points to the releases page. It does not download or install anything by itself. To update, download the new installer and run it. It stops the running proxy, replaces the program, and keeps your settings and accounts.

## Uninstall

Use **Uninstall TeamClaude** in the Start Menu, or uninstall TeamClaude from **Apps and features**. The uninstaller stops the proxy and removes the program, the Start Menu folder, the sign-in entry and the log.

It keeps `%USERPROFILE%\.config\teamclaude.json`, so a later install still has your settings and accounts. Delete that file yourself to remove them.

## Limitations

- Tools reach the proxy by base-URL routing. Each tool is told the proxy's address. The installer does not set up the HTTPS interception that `teamclaude run` uses on macOS and Linux (see [MITM proxy mode](proxy-modes.md#mitm-proxy-mode-default)), and it installs no certificate.
- The proxy listens on `127.0.0.1` only, so only programs on this computer can use it. To reach it from other machines, see [Configuration](configuration.md).
- The bundled Node.js is the 64-bit x64 build.
