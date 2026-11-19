#!/usr/bin/env bash
# Desinstala agent-notch: deja el equipo como antes de scripts/install.sh.
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

    # Desactivar: primero en la sesión en marcha y, por si GNOME no la
    # conoce, quitándola de la lista de extensiones activas.
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
    say "Extensión desactivada."

    if [ -L "$EXT_DIR" ]; then
        say "$EXT_DIR es un enlace de desarrollo: lo dejo. Bórralo a mano si quieres."
    elif [ -d "$EXT_DIR" ]; then
        rm -rf "$EXT_DIR"
        say "Borrada $EXT_DIR"
    fi

    # Aviso de versión nueva (systemd del usuario).
    local UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if [ -f "$UNIT_DIR/agent-notch-update.timer" ]; then
        systemctl --user disable --now agent-notch-update.timer >/dev/null 2>&1 || true
        systemctl --user stop agent-notch-update.service >/dev/null 2>&1 || true
        rm -f "$UNIT_DIR/agent-notch-update.timer" "$UNIT_DIR/agent-notch-update.service"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        say "Quitado el aviso de versión nueva."
    fi
    rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/agent-notch"

    rm -f "$DBUS_DIR/dev.agentnotch.SpeedTest.service" \
          "$DBUS_DIR/dev.agentnotch.Brightness.service"
    say "Quitados los servicios D-Bus."

    # $APP_DIR también guarda los fijados del portapapeles; el temporizador
    # de concentración deja su estado en la carpeta temporal de la sesión.
    local runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch"
    rm -rf "$APP_DIR" "$runtime"
    say "Borrada $APP_DIR"

    echo
    say "Listo. Cierra sesión y vuelve a entrar para que GNOME la descargue del todo."
}

main "$@"
