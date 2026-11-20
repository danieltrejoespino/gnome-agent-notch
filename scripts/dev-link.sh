#!/usr/bin/env bash
# Links the project's extension into GNOME's extensions folder,
# so changes show up without copying files.
set -euo pipefail

UUID="agent-notch@daniel.local"
SRC="$(cd "$(dirname "$0")/.." && pwd)/extension/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"

if [ -L "$DEST" ]; then
    echo "Already linked: $DEST -> $(readlink "$DEST")"
elif [ -e "$DEST" ]; then
    echo "ERROR: $DEST exists and is not a link. Check it by hand." >&2
    exit 1
else
    ln -s "$SRC" "$DEST"
    echo "Linked: $DEST -> $SRC"
fi

# Settings schema (docs/20): compiled in the repo (not uploaded, .gitignore).
glib-compile-schemas "$SRC/schemas"
echo "Settings schema compiled in $SRC/schemas"

# Separate D-Bus services: the session D-Bus starts them when they are called and they
# quit on their own; nothing is left running.
#   - Speed test (docs/16-velocidad-internet.md)
#   - External monitor brightness over DDC/CI (docs/17-brillo-monitor.md)
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
        echo "D-Bus service installed: $file"
    fi
}

install_service dev.agentnotch.SpeedTest services/speedtest/speedtest.py
install_service dev.agentnotch.Brightness services/brightness/brightness.py
