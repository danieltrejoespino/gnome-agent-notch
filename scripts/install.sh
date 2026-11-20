#!/usr/bin/env bash
# Installs or updates agent-notch for the current user (no sudo).
#
#   curl -fsSL https://raw.githubusercontent.com/danieltrejoespino/gnome-agent-notch/main/scripts/install.sh | bash
#
# From a cloned repo, scripts/install.sh installs that copy instead of
# downloading it. Running it again updates.
#
# Optional variables:
#   AGENT_NOTCH_REF=v1      version to install (tag or branch). By default,
#                           the latest release; if there is none, main.
#   AGENT_NOTCH_NO_ENABLE=1 do not enable the extension.
#   AGENT_NOTCH_NO_UPDATE_CHECK=1  do not install the daily new-version notice.
#
# What it installs:
#   ~/.local/share/gnome-shell/extensions/agent-notch@daniel.local/   the extension
#   ~/.local/share/agent-notch/services/                              D-Bus services
#   ~/.local/share/agent-notch/adapters/                              the agents' hooks
#   ~/.local/share/dbus-1/services/dev.agentnotch.*.service            their activation
#   ~/.config/systemd/user/agent-notch-update.{service,timer}          new-version notice
#
# Everything goes inside main(): if the curl download is cut half-way, bash
# runs nothing.

main() {
    set -euo pipefail

    local REPO="danieltrejoespino/gnome-agent-notch"
    local UUID="agent-notch@daniel.local"
    local SHELL_VERSION="50"
    local DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
    local EXT_DIR="$DATA/gnome-shell/extensions/$UUID"
    local APP_DIR="$DATA/agent-notch"
    local DBUS_DIR="$DATA/dbus-1/services"

    say()  { printf '\033[1m[agent-notch]\033[0m %s\n' "$*"; }
    warn() { printf '\033[1;33m[agent-notch]\033[0m %s\n' "$*" >&2; }
    die()  { printf '\033[1;31m[agent-notch] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

    # --- 1. Check the machine ------------------------------------------
    command -v gnome-shell >/dev/null || die "GNOME Shell not found. agent-notch is a GNOME extension."
    local version major
    version="$(gnome-shell --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)"
    major="${version%%.*}"
    [ "$major" = "$SHELL_VERSION" ] ||
        die "Needs GNOME Shell $SHELL_VERSION and this is $version."

    command -v python3 >/dev/null || die "python3 is missing (sudo apt install python3)."
    python3 -c 'import gi; gi.require_version("Gio", "2.0")' 2>/dev/null ||
        die "PyGObject is missing (sudo apt install python3-gi)."
    command -v glib-compile-schemas >/dev/null ||
        die "glib-compile-schemas is missing (sudo apt install libglib2.0-bin)."

    if [ -L "$EXT_DIR" ]; then
        die "$EXT_DIR is a development link (scripts/dev-link.sh). Remove it with: rm '$EXT_DIR'"
    fi

    # --- 2. Get the code ------------------------------------------
    local tmp src ref
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064  # $tmp expands now: it is local to main()
    trap "rm -rf '$tmp'" EXIT

    local here=""
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    fi

    if [ -n "$here" ] && [ -d "$here/extension/$UUID" ] && [ -z "${AGENT_NOTCH_REF:-}" ]; then
        src="$here"
        ref="local ($(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo 'no git'))"
        say "Installing from $src"
    else
        command -v curl >/dev/null || die "curl is missing (sudo apt install curl)."
        command -v tar  >/dev/null || die "tar is missing."
        ref="${AGENT_NOTCH_REF:-}"
        if [ -z "$ref" ]; then
            # The latest release, without using the API (which is rate-limited):
            # /releases/latest redirects to /releases/tag/<tag>.
            local latest
            latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
                "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
            case "$latest" in
                */releases/tag/*) ref="${latest##*/}" ;;
                *) ref="main" ;;
            esac
        fi
        say "Downloading $REPO ($ref)…"
        curl -fsSL "https://github.com/$REPO/archive/$ref.tar.gz" | tar -xz -C "$tmp" ||
            die "Could not download version '$ref'."
        src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
        [ -d "$src/extension/$UUID" ] || die "The download does not contain the extension."
    fi

    # --- 3. Copy the extension ------------------------------------------
    # It is copied to a new folder and swapped in one go, so there is never
    # a half-copied extension.
    mkdir -p "$(dirname "$EXT_DIR")"
    local new_ext="$EXT_DIR.new.$$"
    cp -r "$src/extension/$UUID" "$new_ext"
    # The version of the code GNOME loads (it reads it once per session): the
    # "Update" button compares it with the available one (docs/18).
    python3 -I -c 'import json, sys
p, ref = sys.argv[1], sys.argv[2]
with open(p, encoding="utf-8") as f:
    d = json.load(f)
d["version-name"] = ref
with open(p, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write("\n")' "$new_ext/metadata.json" "$ref"
    # Settings of the preferences window (docs/20).
    glib-compile-schemas "$new_ext/schemas" || die "Could not compile the settings schema."
    rm -rf "$EXT_DIR"
    mv "$new_ext" "$EXT_DIR"
    say "Extension in $EXT_DIR"

    # --- 4. D-Bus services ----------------------------------------------
    # They only start when the extension calls them, and quit on their own.
    mkdir -p "$APP_DIR" "$DBUS_DIR"
    rm -rf "$APP_DIR/services.new"
    cp -r "$src/services" "$APP_DIR/services.new"
    find "$APP_DIR/services.new" -name __pycache__ -type d -prune -exec rm -rf {} +
    rm -rf "$APP_DIR/services"
    mv "$APP_DIR/services.new" "$APP_DIR/services"
    # Agent adapters (Claude Code hook…), without their tests. The hook
    # points here: a fixed path that does not depend on where the repo is.
    if [ -d "$src/adapters" ]; then
        rm -rf "$APP_DIR/adapters.new"
        cp -r "$src/adapters" "$APP_DIR/adapters.new"
        find "$APP_DIR/adapters.new" -name __pycache__ -type d -prune -exec rm -rf {} +
        find "$APP_DIR/adapters.new" \( -name 'test_*.py' -o -name '*.test.js' \) -type f -delete
        rm -rf "$APP_DIR/adapters"
        mv "$APP_DIR/adapters.new" "$APP_DIR/adapters"
    fi
    if [ -f "$src/scripts/uninstall.sh" ]; then
        cp "$src/scripts/uninstall.sh" "$APP_DIR/uninstall.sh"
        chmod +x "$APP_DIR/uninstall.sh"
    fi
    printf '%s\n' "$ref" > "$APP_DIR/VERSION"

    install_service() {
        printf '[D-BUS Service]\nName=%s\nExec=/usr/bin/python3 -I %s\n' \
            "$1" "$APP_DIR/services/$2" > "$DBUS_DIR/$1.service"
    }
    install_service dev.agentnotch.SpeedTest speedtest/speedtest.py
    install_service dev.agentnotch.Brightness brightness/brightness.py
    # The island's "Update" button (docs/18): it installs without the extension
    # launching processes. Without an installed release, the service does nothing.
    install_service dev.agentnotch.Updater "updater/update_check.py --servicio"
    say "D-Bus services in $APP_DIR/services"

    # --- 4b. New-version notice ------------------------------------------
    # Once a day, outside GNOME Shell: one request to GitHub and, if there is
    # a new release, a notification with "Update". It only makes
    # sense when installing releases (not from a cloned repo or from main).
    local UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if [ "${AGENT_NOTCH_NO_UPDATE_CHECK:-}" = "1" ] || ! command -v systemctl >/dev/null; then
        :
    elif [[ "$ref" =~ ^v[0-9] ]]; then
        mkdir -p "$UNIT_DIR"
        printf '%s\n' \
            '[Unit]' \
            'Description=agent-notch: check for a new version' \
            '' \
            '[Service]' \
            'Type=exec' \
            "ExecStart=/usr/bin/python3 -I $APP_DIR/services/updater/update_check.py" \
            > "$UNIT_DIR/agent-notch-update.service"
        printf '%s\n' \
            '[Unit]' \
            'Description=agent-notch: daily new-version notice' \
            '' \
            '[Timer]' \
            'OnCalendar=daily' \
            'RandomizedDelaySec=1h' \
            'Persistent=true' \
            '' \
            '[Install]' \
            'WantedBy=timers.target' \
            > "$UNIT_DIR/agent-notch-update.timer"
        if systemctl --user daemon-reload 2>/dev/null &&
           systemctl --user enable --now agent-notch-update.timer >/dev/null 2>&1; then
            say "Daily new-version notice enabled (to disable: systemctl --user disable --now agent-notch-update.timer)"
        else
            warn "Could not enable the new-version notice (user systemd not available)."
        fi
    fi

    # --- 5. Enable --------------------------------------------------------
    local restart_hint="Log out and back in to load it."
    if [ "${AGENT_NOTCH_NO_ENABLE:-}" != "1" ]; then
        # gnome-extensions enable only works if GNOME already knows the
        # extension; if it is new (Wayland does not see it until the session restarts),
        # it is added directly to the list of enabled extensions.
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            say "Extension enabled."
        elif command -v gsettings >/dev/null; then
            local list
            list="$(gsettings get org.gnome.shell enabled-extensions)"
            if [[ "$list" != *"'$UUID'"* ]]; then
                case "$list" in
                    "@as []"|"[]") list="['$UUID']" ;;
                    *) list="${list%]}, '$UUID']" ;;
                esac
                gsettings set org.gnome.shell enabled-extensions "$list"
            fi
            say "Extension set to be enabled when you log in."
        else
            warn "Could not enable it: run 'gnome-extensions enable $UUID' after logging back in."
        fi
        if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
            warn "User extensions are disabled in GNOME: turn them on in an extensions app."
        fi
    fi

    # --- 6. Summary -------------------------------------------------------
    echo
    say "Installed version $ref."
    say "$restart_hint"
    local configure="$APP_DIR/adapters/claude-code/configure.py"
    if [ -f "$configure" ] && ! python3 -I "$configure" status >/dev/null 2>&1; then
        say "To see Claude Code on the island: python3 $configure install"
    fi
    configure="$APP_DIR/adapters/opencode/configure.py"
    if [ -f "$configure" ] && { command -v opencode >/dev/null || [ -x "$HOME/.opencode/bin/opencode" ]; } &&
       ! python3 -I "$configure" status >/dev/null 2>&1; then
        say "To see OpenCode on the island: python3 $configure install"
    fi
    if ! command -v ddcutil >/dev/null; then
        say "Optional, for external monitor brightness: sudo apt install ddcutil (and log back in)."
    fi
    say "To uninstall: $APP_DIR/uninstall.sh"
}

main "$@"
