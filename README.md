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
git clone https://github.com/danieltrejoespino/gnome-agent-notch.git
cd gnome-agent-notch
scripts/dev-link.sh
```

`dev-link.sh` enlaza la extensión en `~/.local/share/gnome-shell/extensions/` (los cambios en el repo se ven sin copiar nada) y registra los servicios D-Bus del test de velocidad y del brillo en `~/.local/share/dbus-1/services/`. Esos servicios solo arrancan cuando se usan y se cierran solos.

Después:

1. Cierra sesión y vuelve a entrar (en Wayland GNOME no detecta extensiones nuevas sin reiniciar la sesión).
2. Actívala:
   ```bash
   gnome-extensions enable agent-notch@daniel.local
   ```

**No muevas la carpeta del repo** después de instalarla: el enlace y los servicios apuntan a ella. Si la mueves, vuelve a ejecutar `scripts/dev-link.sh` (antes borra el enlace viejo de `~/.local/share/gnome-shell/extensions/agent-notch@daniel.local`).

### Brillo del monitor externo (opcional)

```bash
sudo apt install ddcutil
```

Y vuelve a entrar en la sesión para que su regla de udev te dé acceso a `/dev/i2c-*`. El monitor tiene que aceptar DDC/CI y el cable dejarlo pasar: por HDMI o DisplayPort directo suele funcionar; muchos adaptadores USB-C → HDMI no. Sin monitor compatible la barra no sale.

## Desinstalar

```bash
gnome-extensions disable agent-notch@daniel.local
rm ~/.local/share/gnome-shell/extensions/agent-notch@daniel.local
rm ~/.local/share/dbus-1/services/dev.agentnotch.{SpeedTest,Brightness}.service
```

## Desarrollo

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
services/speedtest/                   test de velocidad, servicio D-Bus aparte
services/brightness/                  brillo por DDC/CI, servicio D-Bus aparte
scripts/                              instalación y herramientas de prueba
```

## Licencia

[GPL-3.0-or-later](LICENSE).
