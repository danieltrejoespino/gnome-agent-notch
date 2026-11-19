#!/usr/bin/env bash
# Lanza un GNOME de prueba en una ventana con la extensión activada.
# Tu escritorio real no se toca. Requiere: sudo apt install mutter-dev-bin
#
# El GNOME de prueba tiene su propio D-Bus, aislado del escritorio real:
# las apps que ya tienes abiertas (Chrome…) y los snaps (Spotify) no se ven
# dentro. Para probar la música usa scripts/fake-player.py.
#
# Su monitor es virtual: AGENT_NOTCH_DDC_ANY=1 hace que la barra de brillo
# de Ajustes rápidos salga para cualquier monitor DDC/CI que encuentre
# ddcutil (el real), aunque Mutter no lo vea (docs/17-brillo-monitor.md).
set -euo pipefail

UUID="agent-notch@daniel.local"
BUS_FILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch-dev-bus"
# Bus de archivos propio (sesiones de agentes): lo que escribe
# scripts/simulate.py no sale en la isla del escritorio real.
DEV_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch-dev"

"$(dirname "$0")/dev-link.sh"

# Activa la extensión dentro del GNOME de prueba en cuanto arranque y deja
# la dirección de su D-Bus en BUS_FILE para scripts/fake-player.py.
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
