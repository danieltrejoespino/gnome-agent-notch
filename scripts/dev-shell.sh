#!/usr/bin/env bash
# Starts a test GNOME in a window with the extension enabled.
# Your real desktop is not touched. Requires: sudo apt install mutter-dev-bin
#
# The test GNOME has its own D-Bus, isolated from the real desktop:
# the apps you already have open (Chrome…) and snaps (Spotify) do not show
# inside. To try the music, use scripts/fake-player.py.
#
# Its monitor is virtual: AGENT_NOTCH_DDC_ANY=1 makes the Quick Settings
# brightness slider show for any DDC/CI monitor that ddcutil finds
# (the real one), even if Mutter does not see it (docs/17-brillo-monitor.md).
set -euo pipefail

UUID="agent-notch@daniel.local"
BUS_FILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch-dev-bus"
# Its own file bus (agent sessions): what scripts/simulate.py writes
# does not show up on the real desktop's island.
DEV_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch-dev"

"$(dirname "$0")/dev-link.sh"

# Enables the extension inside the test GNOME as soon as it starts and leaves
# the address of its D-Bus in BUS_FILE for scripts/fake-player.py.
dbus-run-session bash -c "
    echo \"\$DBUS_SESSION_BUS_ADDRESS\" > '$BUS_FILE'
    trap \"rm -f '$BUS_FILE'\" EXIT
    AGENT_NOTCH_DDC_ANY=1 AGENT_NOTCH_DIR='$DEV_DIR' gnome-shell --devkit --wayland &
    SHELL_PID=\$!
    for _ in \$(seq 1 30); do
        sleep 1
        gnome-extensions enable $UUID 2>/dev/null && break
    done
    wait \$SHELL_PID
"
