#!/usr/bin/env bash
# Envía notificaciones de prueba al GNOME de prueba (scripts/dev-shell.sh),
# nunca a tu escritorio real.
#
# Uso:
#   scripts/notify-test.sh            # una tanda: 3 notificaciones de apps distintas
#   scripts/notify-test.sh critica    # una notificación crítica (se queda hasta el clic)
set -euo pipefail

BUS_FILE="${AGENT_NOTCH_BUS_FILE:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-notch-dev-bus}"
if [ ! -f "$BUS_FILE" ]; then
    echo "Cannot find the test GNOME. Open it first with scripts/dev-shell.sh" >&2
    exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"

send() {  # app icono título cuerpo [urgencia]
    notify-send --app-name="$1" --icon="$2" --urgency="${5:-normal}" "$3" "$4"
}

case "${1:-tanda}" in
    critica)
        send "System" "dialog-warning" "Battery low" "5 % left. Plug in the charger." critical
        ;;
    *)
        send "Spotify" "spotify-client" "Mom" "Dinner is ready 🍲"
        sleep 1
        send "Firefox" "firefox" "Team · Project" "Shall we review the notch tonight?"
        sleep 1
        send "Terminal" "utilities-terminal" "Build finished" "A rather long text to check that the message is cut with an ellipsis without breaking the island"
        ;;
esac
echo "Sent. They should show up one after another on the island (≈5 s each)."
