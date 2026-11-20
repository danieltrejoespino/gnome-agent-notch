#!/usr/bin/env bash
# Instala o actualiza agent-notch para el usuario actual (sin sudo).
#
#   curl -fsSL https://raw.githubusercontent.com/danieltrejoespino/gnome-agent-notch/main/scripts/install.sh | bash
#
# Desde un repo clonado, scripts/install.sh instala esa copia en vez de
# descargarla. Volver a ejecutarlo actualiza.
#
# Variables opcionales:
#   AGENT_NOTCH_REF=v1      versión a instalar (etiqueta o rama). Por defecto,
#                           la última release; si no hay ninguna, main.
#   AGENT_NOTCH_NO_ENABLE=1 no activar la extensión.
#   AGENT_NOTCH_NO_UPDATE_CHECK=1  no instalar el aviso diario de versión nueva.
#
# Qué instala:
#   ~/.local/share/gnome-shell/extensions/agent-notch@daniel.local/   la extensión
#   ~/.local/share/agent-notch/services/                              servicios D-Bus
#   ~/.local/share/agent-notch/adapters/                              hooks de los agentes
#   ~/.local/share/dbus-1/services/dev.agentnotch.*.service            su activación
#   ~/.config/systemd/user/agent-notch-update.{service,timer}          aviso de versión nueva
#
# Todo va dentro de main(): si la descarga por curl se corta a medias, bash
# no ejecuta nada.

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

    # --- 1. Comprobar el equipo ------------------------------------------
    command -v gnome-shell >/dev/null || die "No encuentro GNOME Shell. agent-notch es una extensión de GNOME."
    local version major
    version="$(gnome-shell --version | grep -oE '[0-9]+(\.[0-9]+)*' | head -1)"
    major="${version%%.*}"
    [ "$major" = "$SHELL_VERSION" ] ||
        die "Necesita GNOME Shell $SHELL_VERSION y aquí hay la $version."

    command -v python3 >/dev/null || die "Falta python3 (sudo apt install python3)."
    python3 -c 'import gi; gi.require_version("Gio", "2.0")' 2>/dev/null ||
        die "Falta PyGObject (sudo apt install python3-gi)."

    if [ -L "$EXT_DIR" ]; then
        die "$EXT_DIR es un enlace de desarrollo (scripts/dev-link.sh). Bórralo con: rm '$EXT_DIR'"
    fi

    # --- 2. Conseguir el código ------------------------------------------
    local tmp src ref
    tmp="$(mktemp -d)"
    # shellcheck disable=SC2064  # $tmp se expande ahora: es local de main()
    trap "rm -rf '$tmp'" EXIT

    local here=""
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    fi

    if [ -n "$here" ] && [ -d "$here/extension/$UUID" ] && [ -z "${AGENT_NOTCH_REF:-}" ]; then
        src="$here"
        ref="local ($(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo 'sin git'))"
        say "Instalando desde $src"
    else
        command -v curl >/dev/null || die "Falta curl (sudo apt install curl)."
        command -v tar  >/dev/null || die "Falta tar."
        ref="${AGENT_NOTCH_REF:-}"
        if [ -z "$ref" ]; then
            # La última release, sin usar la API (que tiene límite de peticiones):
            # /releases/latest redirige a /releases/tag/<etiqueta>.
            local latest
            latest="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
                "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
            case "$latest" in
                */releases/tag/*) ref="${latest##*/}" ;;
                *) ref="main" ;;
            esac
        fi
        say "Descargando $REPO ($ref)…"
        curl -fsSL "https://github.com/$REPO/archive/$ref.tar.gz" | tar -xz -C "$tmp" ||
            die "No se pudo descargar la versión '$ref'."
        src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
        [ -d "$src/extension/$UUID" ] || die "La descarga no contiene la extensión."
    fi

    # --- 3. Copiar la extensión ------------------------------------------
    # Se copia a una carpeta nueva y se cambia de golpe, para no dejar nunca
    # una extensión a medias.
    mkdir -p "$(dirname "$EXT_DIR")"
    local new_ext="$EXT_DIR.new.$$"
    cp -r "$src/extension/$UUID" "$new_ext"
    # La versión del código que GNOME carga (la lee una vez por sesión): el
    # botón «Actualizar» la compara con la disponible (docs/18).
    python3 -I -c 'import json, sys
p, ref = sys.argv[1], sys.argv[2]
with open(p, encoding="utf-8") as f:
    d = json.load(f)
d["version-name"] = ref
with open(p, "w", encoding="utf-8") as f:
    json.dump(d, f, ensure_ascii=False, indent=2)
    f.write("\n")' "$new_ext/metadata.json" "$ref"
    rm -rf "$EXT_DIR"
    mv "$new_ext" "$EXT_DIR"
    say "Extensión en $EXT_DIR"

    # --- 4. Servicios D-Bus ----------------------------------------------
    # Solo arrancan cuando la extensión los llama y se cierran solos.
    mkdir -p "$APP_DIR" "$DBUS_DIR"
    rm -rf "$APP_DIR/services.new"
    cp -r "$src/services" "$APP_DIR/services.new"
    find "$APP_DIR/services.new" -name __pycache__ -type d -prune -exec rm -rf {} +
    rm -rf "$APP_DIR/services"
    mv "$APP_DIR/services.new" "$APP_DIR/services"
    # Adaptadores de agentes (hook de Claude Code…), sin sus pruebas. El hook
    # apunta aquí: una ruta fija que no depende de dónde esté el repo.
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
    # Botón «Actualizar» de la isla (docs/18): instala sin que la extensión
    # lance procesos. Sin release instalada, el servicio no hace nada.
    install_service dev.agentnotch.Updater "updater/update_check.py --servicio"
    say "Servicios D-Bus en $APP_DIR/services"

    # --- 4b. Aviso de versión nueva ------------------------------------------
    # Una vez al día, fuera de GNOME Shell: una consulta a GitHub y, si hay
    # una release nueva, una notificación con «Actualizar». Solo tiene
    # sentido instalando releases (no desde un repo clonado ni desde main).
    local UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if [ "${AGENT_NOTCH_NO_UPDATE_CHECK:-}" = "1" ] || ! command -v systemctl >/dev/null; then
        :
    elif [[ "$ref" =~ ^v[0-9] ]]; then
        mkdir -p "$UNIT_DIR"
        printf '%s\n' \
            '[Unit]' \
            'Description=agent-notch: comprobar si hay una versión nueva' \
            '' \
            '[Service]' \
            'Type=exec' \
            "ExecStart=/usr/bin/python3 -I $APP_DIR/services/updater/update_check.py" \
            > "$UNIT_DIR/agent-notch-update.service"
        printf '%s\n' \
            '[Unit]' \
            'Description=agent-notch: aviso diario de versión nueva' \
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
            say "Aviso diario de versión nueva activado (desactivar: systemctl --user disable --now agent-notch-update.timer)"
        else
            warn "No se pudo activar el aviso de versión nueva (systemd del usuario no disponible)."
        fi
    fi

    # --- 5. Activar ------------------------------------------------------
    local restart_hint="Cierra sesión y vuelve a entrar para cargarla."
    if [ "${AGENT_NOTCH_NO_ENABLE:-}" != "1" ]; then
        # gnome-extensions enable solo funciona si GNOME ya conoce la
        # extensión; si es nueva (Wayland no la ve hasta reiniciar la sesión),
        # se añade directamente a la lista de extensiones activas.
        if gnome-extensions enable "$UUID" 2>/dev/null; then
            say "Extensión activada."
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
            say "Extensión marcada para activarse al entrar en la sesión."
        else
            warn "No pude activarla: hazlo con 'gnome-extensions enable $UUID' tras volver a entrar."
        fi
        if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
            warn "Las extensiones de usuario están desactivadas en GNOME: actívalas en la app Extensiones."
        fi
    fi

    # --- 6. Resumen ------------------------------------------------------
    echo
    say "Instalada la versión $ref."
    say "$restart_hint"
    local configure="$APP_DIR/adapters/claude-code/configure.py"
    if [ -f "$configure" ] && ! python3 -I "$configure" status >/dev/null 2>&1; then
        say "Para ver Claude Code en la isla: python3 $configure install"
    fi
    configure="$APP_DIR/adapters/opencode/configure.py"
    if [ -f "$configure" ] && { command -v opencode >/dev/null || [ -x "$HOME/.opencode/bin/opencode" ]; } &&
       ! python3 -I "$configure" status >/dev/null 2>&1; then
        say "Para ver OpenCode en la isla: python3 $configure install"
    fi
    if ! command -v ddcutil >/dev/null; then
        say "Opcional, para el brillo del monitor externo: sudo apt install ddcutil (y volver a entrar)."
    fi
    say "Para desinstalar: $APP_DIR/uninstall.sh"
}

main "$@"
