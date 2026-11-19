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
    echo "No encuentro el GNOME de prueba. Ábrelo antes con scripts/dev-shell.sh" >&2
    exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_FILE")"

send() {  # app icono título cuerpo [urgencia]
    notify-send --app-name="$1" --icon="$2" --urgency="${5:-normal}" "$3" "$4"
}

case "${1:-tanda}" in
    critica)
        send "Sistema" "dialog-warning" "Batería baja" "Queda un 5 %. Conecta el cargador." critical
        ;;
    *)
        send "Spotify" "spotify-client" "Mamá" "La cena está lista 🍲"
        sleep 1
        send "Firefox" "firefox" "Equipo · Proyecto" "¿Revisamos el notch esta noche?"
        sleep 1
        send "Terminal" "utilities-terminal" "Compilación terminada" "Un texto bastante largo para comprobar que el mensaje se corta con puntos suspensivos sin romper la isla"
        ;;
esac
echo "Enviadas. Deberían verse una tras otra en la isla (≈5 s cada una)."
