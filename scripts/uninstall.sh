#!/usr/bin/env bash
# Uninstalls agent-notch: leaves the machine as it was before scripts/install.sh.
#
#   ~/.local/share/agent-notch/uninstall.sh
#   curl -fsSL https://raw.githubusercontent.com/danieltrejoespino/gnome-agent-notch/main/scripts/uninstall.sh | bash

main() {
    set -euo pipefail

    local UUID="agent-notch@daniel.local"
    local DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
    local EXT_DIR="$DATA/gnome-shell/extensions/$UUID"
    local APP_DIR="$DATA/agent-notch"
    local DBUS_DIR="$DATA/dbus-1/services"

    say() { printf '\033[1m[agent-notch]\033[0m %s\n' "$*"; }

    # Disable: first in the running session and, in case GNOME does not
    # know it, by removing it from the list of enabled extensions.
    gnome-extensions disable "$UUID" 2>/dev/null || true
    if command -v gsettings >/dev/null; then
        local list new
        list="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo '[]')"
        if [[ "$list" == *"'$UUID'"* ]]; then
            new="$(printf '%s' "$list" | sed -e "s/'$UUID', //; s/, '$UUID'//; s/'$UUID'//")"
            [ "$new" = "[]" ] && new="@as []"
            gsettings set org.gnome.shell enabled-extensions "$new"
        fi
    fi
    say "Extension disabled."

    if [ -L "$EXT_DIR" ]; then
        say "$EXT_DIR is a development link: leaving it. Remove it by hand if you want."
    elif [ -d "$EXT_DIR" ]; then
        rm -rf "$EXT_DIR"
        say "Removed $EXT_DIR"
    fi

    # Remove the Claude Code hook BEFORE deleting hook.py (a cloned repo's
    # one, if any, is left alone). If it stayed, its command exits with 0 when it does not
    # find hook.py, but better not to leave leftovers.
    local configure="$APP_DIR/adapters/claude-code/configure.py"
    if [ -f "$configure" ]; then
        python3 -I "$configure" uninstall ||
            say "Could not remove the Claude Code hook: check ~/.claude/settings.json"
    fi
    # OpenCode plugin (only the loader that points to this copy).
    configure="$APP_DIR/adapters/opencode/configure.py"
    if [ -f "$configure" ]; then
        python3 -I "$configure" uninstall ||
            say "Could not remove the OpenCode plugin: check ~/.config/opencode/plugins/agent-notch.js"
    fi

    # New-version notice (user systemd).
    local UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if [ -f "$UNIT_DIR/agent-notch-update.timer" ]; then
        systemctl --user disable --now agent-notch-update.timer >/dev/null 2>&1 || true
        systemctl --user stop agent-notch-update.service >/dev/null 2>&1 || true
        rm -f "$UNIT_DIR/agent-notch-update.timer" "$UNIT_DIR/agent-notch-update.service"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        say "Removed the new-version notice."
    fi
    rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/agent-notch"
    # Settings of the preferences window (docs/20).
    dconf reset -f /org/gnome/shell/extensions/agent-notch/ 2>/dev/null || true

    rm -f "$DBUS_DIR/dev.agentnotch.SpeedTest.service" \
          "$DBUS_DIR/dev.agentnotch.Brightness.service" \
          "$DBUS_DIR/dev.agentnotch.Updater.service"
    say "Removed the D-Bus services."

    # $APP_DIR also keeps the clipboard's pinned items; the focus
    # timer leaves its state in the session's temporary folder.
    local runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch"
    rm -rf "$APP_DIR" "$runtime"
    say "Removed $APP_DIR"

    echo
    say "Done. Log out and back in so GNOME unloads it completely."
}

main "$@"
