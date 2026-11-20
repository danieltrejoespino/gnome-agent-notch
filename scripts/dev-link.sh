#!/usr/bin/env bash
# Enlaza la extensión del proyecto en la carpeta de extensiones de GNOME,
# para que los cambios se vean sin copiar archivos.
set -euo pipefail

UUID="agent-notch@daniel.local"
SRC="$(cd "$(dirname "$0")/.." && pwd)/extension/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"

if [ -L "$DEST" ]; then
    echo "Ya enlazada: $DEST -> $(readlink "$DEST")"
elif [ -e "$DEST" ]; then
    echo "ERROR: $DEST existe y no es un enlace. Revísalo a mano." >&2
    exit 1
else
    ln -s "$SRC" "$DEST"
    echo "Enlazada: $DEST -> $SRC"
fi

# Esquema de ajustes (docs/20): compilado en el repo (no se sube, .gitignore).
glib-compile-schemas "$SRC/schemas"
echo "Esquema de ajustes compilado en $SRC/schemas"

# Servicios D-Bus aparte: el D-Bus de sesión los arranca al llamarlos y se
# cierran solos; no queda nada en marcha.
#   - Test de velocidad (docs/16-velocidad-internet.md)
#   - Brillo de monitores externos por DDC/CI (docs/17-brillo-monitor.md)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services"
mkdir -p "$SERVICE_DIR"

install_service() {
    local name="$1" script="$2"
    local file="$SERVICE_DIR/$name.service"
    local content="[D-BUS Service]
Name=$name
Exec=/usr/bin/python3 -I $ROOT/$script"
    if [ "$(cat "$file" 2>/dev/null)" != "$content" ]; then
        printf '%s\n' "$content" > "$file"
        echo "Servicio D-Bus instalado: $file"
    fi
}

install_service dev.agentnotch.SpeedTest services/speedtest/speedtest.py
install_service dev.agentnotch.Brightness services/brightness/brightness.py
