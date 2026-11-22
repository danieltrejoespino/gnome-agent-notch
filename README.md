# agent-notch

A notch-style "island" at the top center of GNOME Shell, written as a GJS extension. It shows the live status of your AI coding agents (Claude Code, OpenCode…), your music, notifications and more. It is built from **modules** and designed to use as little as possible: everything is event-driven and, while the island is idle, it uses no CPU.

## What it does

- **AI agents:** live status of every Claude Code and OpenCode session. A pair of eyes reacts to what the agents do: they look up while thinking, look at the text while working, open wide when an agent needs you, smile `^ ^` when done and show `× ×` on errors. When an agent needs you the island opens with a banner and a short sound; click it to jump to that agent's terminal.
- **Music:** what is playing (any MPRIS player) on the island, with animated bars; on hover, cover art, progress and ⏮ ⏯ ⏭ controls.
- **Notifications:** shown on the island with a glow in the app's color.
- **Panel with tabs** (click the island): Home with the clock and cards, plus Agents, Music, System, Docker, Tailscale, Clipboard and Focus.
- **System:** RAM and swap, CPU and temperature, disk, battery, network, local and public IP (on demand), uptime and an on-demand speed test.
- **Docker:** containers grouped by Compose project; start or stop one, or a whole project. Only shown if Docker is installed and you can use its socket.
- **Tailscale:** turn it on or off, see this device and the others in your tailnet (click one to copy its IP) and pick an exit node. Only shown if Tailscale is installed; turning it on or off needs a one-time permission (see below).
- **Clipboard:** text history with search and pinned items; **Super+V** opens it and picking an item pastes it.
- **Focus:** a work timer, from Home or from the island.
- **External monitor brightness:** a slider in Quick Settings, below the laptop's, over DDC/CI.
- **Settings:** the gear at the end of the panel's tab bar opens the preferences: which tabs to show, agent alerts (sound, banner and how long it stays), agents on one or two lines, eye animations, the Super+V shortcut and the update notice.
- **Updates:** when a new version is out, an **Update to vN** button appears in the panel (and a small blue dot next to the eyes).

## Requirements

| | |
|---|---|
| GNOME Shell | **50** (Wayland). Other versions do not load the extension. |
| System | Tested on Ubuntu 26.04 |
| Python 3 + PyGObject | For the separate services (speed test, brightness, updates). Ubuntu ships them (`python3-gi`). |
| `glib-compile-schemas` | To install the settings. Ubuntu ships it (`libglib2.0-bin`). |
| `ddcutil` | Optional, only for external monitor brightness |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/danieltrejoespino/gnome-agent-notch/main/scripts/install.sh | bash
```

Then **log out and back in**: on Wayland, GNOME only loads new extensions when the session starts.

The installer does not use `sudo` and only writes to your home folder:

| Where | What |
|---|---|
| `~/.local/share/gnome-shell/extensions/agent-notch@daniel.local/` | the extension |
| `~/.local/share/agent-notch/` | the speed, brightness and update services, the agent adapters, the uninstaller and the clipboard's pinned items |
| `~/.local/share/dbus-1/services/dev.agentnotch.*.service` | so D-Bus starts those services only when they are used (they quit on their own) |
| `~/.config/systemd/user/agent-notch-update.*` | the daily new-version notice |

It installs the latest *release*; if there is none, the `main` branch. To pick a version: `curl … | AGENT_NOTCH_REF=v7 bash`.

**Updating:** once a day it checks whether there is a new version and, if so, shows a notification with **Update** and the **Update to vN** button in the island's panel. You can also run the same install command again. Then log out and back in.

The check is a user systemd timer that makes a single request to GitHub per day, outside GNOME Shell. To turn it off: switch off "Notify about new versions" in the settings, or install with `curl … | AGENT_NOTCH_NO_UPDATE_CHECK=1 bash`.

From a cloned repo, `scripts/install.sh` installs that copy instead of downloading one.

### Settings

Click the island and then the **gear** at the end of the tab bar. You can also run:

```bash
gnome-extensions prefs agent-notch@daniel.local
```

Ubuntu does not include the Extensions app; you do not need it.

### Claude Code (optional)

To see your Claude Code sessions on the island:

```bash
python3 ~/.local/share/agent-notch/adapters/claude-code/configure.py install
```

It adds the hook to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) without touching your other settings or hooks, and first saves a copy in `settings.json.agent-notch.bak`. Open sessions pick it up on their own or when restarted. `configure.py status` tells you whether it is set up, `configure.py uninstall` removes it, and the agent-notch uninstaller removes it too.

If `hook.py` goes missing, the hook does nothing instead of failing, so it never blocks Claude Code.

### OpenCode (optional)

To see OpenCode sessions on the island, install the plugin:

```bash
python3 ~/.local/share/agent-notch/adapters/opencode/configure.py install
```

It leaves a small plugin in `~/.config/opencode/plugins/agent-notch.js` without touching your other plugins. OpenCode loads it on its own; if you do not see it, close its background service (`pkill -f 'opencode serve'`) and open OpenCode again. `configure.py status` tells you whether it is set up, `configure.py uninstall` removes it, and the agent-notch uninstaller removes it too.

### Tailscale (optional)

The Tailscale tab shows up on its own if Tailscale is installed, and it can always show the state and your devices. To **turn Tailscale on or off and pick an exit node** from the island, Tailscale has to let your user change its settings. Run this once:

```bash
sudo tailscale set --operator=$USER
```

Without it, the tab shows that same command and its buttons stay disabled. The installer reminds you of it if Tailscale is installed and the permission is missing. The island talks to Tailscale's local socket; it does not run `tailscale` or use `sudo`. To take the permission back: `sudo tailscale set --operator=` (the agent-notch uninstaller does not touch it, since it does not use `sudo`).

### External monitor brightness (optional)

```bash
sudo apt install ddcutil
```

Then log back in so its udev rule gives you access to `/dev/i2c-*`. The monitor has to support DDC/CI and the cable has to let it through: direct HDMI or DisplayPort usually works; many USB-C → HDMI adapters do not. Without a compatible monitor the slider does not show up.

## Uninstall

```bash
~/.local/share/agent-notch/uninstall.sh
```

It leaves everything as it was before installing: it also removes the Claude Code hook, the OpenCode plugin, the settings and the clipboard's pinned items.

## Development

`scripts/dev-link.sh` links the extension to the repo folder (changes show up without copying anything) instead of installing a copy, and compiles the settings schema. It cannot be used together with `install.sh`: uninstall one before using the other.

To make Claude Code use the repo's hook instead of the installed copy: run `python3 adapters/claude-code/configure.py install` from the repo. It replaces the other one, since there can only be one.

To try changes without touching your real desktop:

```bash
sudo apt install mutter-dev-bin
scripts/dev-shell.sh          # a test GNOME in a window, with the extension enabled
scripts/simulate.py demo      # fake agent sessions
scripts/fake-player.py        # fake music player
scripts/notify-test.sh        # test notifications
```

Tests:

```bash
gjs -m scripts/test-agentstate.js
gjs -m scripts/test-dockerstate.js
gjs -m scripts/test-tailscalestate.js
gjs -m scripts/test-updatestate.js
python3 -m unittest discover -s adapters/claude-code
python3 -m unittest discover -s adapters/common
```

Extension logs:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep agent-notch
```

## Layout

```
extension/agent-notch@daniel.local/   the extension (island.js, panel.js, prefs.js, modules/…)
adapters/                             turn agent events into the island's format (Claude Code, OpenCode)
services/speedtest/                   speed test, a separate D-Bus service
services/brightness/                  DDC/CI brightness, a separate D-Bus service
services/updater/                     daily new-version check and the island's "Update" button
scripts/                              install.sh, uninstall.sh and development tools
```

## License

[GPL-3.0-or-later](LICENSE).
