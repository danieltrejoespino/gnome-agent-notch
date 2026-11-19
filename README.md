# agent-notch

Una "isla" estilo notch arriba al centro de GNOME Shell, escrita como extensión en GJS. Funciona por **módulos** y está pensada para gastar lo mínimo: todo va por eventos y, con la isla quieta, no consume CPU.

## Qué hace

- **Música:** lo que suena (cualquier reproductor MPRIS) en la isla, con barritas animadas; al pasar el ratón, carátula, progreso y controles ⏮ ⏯ ⏭.
- **Notificaciones:** salen en la isla con un brillo del color de la app.
- **Panel con pestañas** (clic en la isla): Home con fecha, reloj y tarjetas; Música; Sistema.
- **Sistema:** RAM y swap, CPU y temperatura, disco, batería, red, IP local y pública (al pulsar), tiempo encendido y test de velocidad bajo demanda.
- **Portapapeles:** historial de texto con búsqueda y fijados; **Super+V** lo abre y al elegir se pega solo.
- **Concentración:** temporizador desde Home o desde la isla.
- **Brillo del monitor externo:** una barra en Ajustes rápidos, debajo de la del portátil, por DDC/CI.
- **En camino:** estado en vivo de agentes de IA para programar (Claude Code, OpenCode…) y aprobar permisos desde la isla.

## Requisitos

| | |
|---|---|
| GNOME Shell | **50** (Wayland). Otras versiones no cargan la extensión. |
| Sistema | Probado en Ubuntu 26.04 |
| Python 3 + PyGObject | Para los servicios aparte (test de velocidad y brillo). En Ubuntu vienen de serie (`python3-gi`). |
| `ddcutil` | Opcional, solo para el brillo del monitor externo |

## Instalación

```bash
curl -fsSL https://raw.githubusercontent.com/danieltrejoespino/gnome-agent-notch/main/scripts/install.sh | bash
```

Después, **cierra sesión y vuelve a entrar**: en Wayland GNOME solo carga extensiones nuevas al empezar la sesión.

El instalador no usa `sudo` y solo escribe en tu carpeta personal:

| Dónde | Qué |
|---|---|
| `~/.local/share/gnome-shell/extensions/agent-notch@daniel.local/` | la extensión |
| `~/.local/share/agent-notch/` | los servicios de velocidad y brillo, los adaptadores de agentes, el desinstalador y los fijados del portapapeles |
| `~/.local/share/dbus-1/services/dev.agentnotch.*.service` | para que D-Bus arranque esos servicios solo cuando se usan (se cierran solos) |

Instala la última *release*; si no hay ninguna, la rama `main`. Para elegir versión: `curl … | AGENT_NOTCH_REF=v1 bash`.

**Actualizar:** vuelve a ejecutar el mismo comando y entra de nuevo en la sesión.

Desde un repo clonado, `scripts/install.sh` instala esa copia en vez de descargarla.

### Claude Code (opcional)

Para ver tus sesiones de Claude Code en la isla:

```bash
python3 ~/.local/share/agent-notch/adapters/claude-code/configure.py install
```

Añade el hook a `~/.claude/settings.json` (o `$CLAUDE_CONFIG_DIR/settings.json`) sin tocar tus otros ajustes ni hooks, y guarda antes una copia en `settings.json.agent-notch.bak`. Las sesiones abiertas lo cargan solas o al reiniciarlas. `configure.py status` dice si está puesto, `configure.py uninstall` lo quita, y el desinstalador de agent-notch también lo quita.

Si `hook.py` desaparece, el hook no hace nada en lugar de fallar, así que nunca bloquea a Claude Code.

### Brillo del monitor externo (opcional)

```bash
sudo apt install ddcutil
```

Y vuelve a entrar en la sesión para que su regla de udev te dé acceso a `/dev/i2c-*`. El monitor tiene que aceptar DDC/CI y el cable dejarlo pasar: por HDMI o DisplayPort directo suele funcionar; muchos adaptadores USB-C → HDMI no. Sin monitor compatible la barra no sale.

## Desinstalar

```bash
~/.local/share/agent-notch/uninstall.sh
```

Deja todo como antes de instalar: también quita el hook de Claude Code y borra los fijados del portapapeles.

## Desarrollo

`scripts/dev-link.sh` enlaza la extensión a la carpeta del repo (los cambios se ven sin copiar nada) en vez de instalar una copia. No se puede usar a la vez que `install.sh`: desinstala antes una para usar la otra.

Para que Claude Code use el hook del repo en lugar de la copia instalada: `python3 adapters/claude-code/configure.py install` desde el repo. Sustituye al otro, porque solo puede haber uno.

Para probar cambios sin tocar el escritorio real:

```bash
sudo apt install mutter-dev-bin
scripts/dev-shell.sh          # GNOME de prueba en una ventana, con la extensión activada
scripts/fake-player.py        # reproductor falso para probar la música
scripts/notify-test.sh        # notificaciones de prueba
```

Logs de la extensión:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep agent-notch
```

## Estructura

```
extension/agent-notch@daniel.local/   la extensión (island.js, panel.js, modules/…)
adapters/                             traducen los eventos de los agentes al formato de la isla (en desarrollo)
services/speedtest/                   test de velocidad, servicio D-Bus aparte
services/brightness/                  brillo por DDC/CI, servicio D-Bus aparte
scripts/                              install.sh, uninstall.sh y herramientas de desarrollo (simulate.py: sesiones falsas)
```

## Licencia

[GPL-3.0-or-later](LICENSE).
