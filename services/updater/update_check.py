#!/usr/bin/env python3
"""Aviso de versión nueva de agent-notch.

Lo lanza un temporizador de systemd del usuario una vez al día
(agent-notch-update.timer, lo instala scripts/install.sh). Fuera de GNOME
Shell: la extensión no lanza procesos (Regla 2 de CLAUDE.md).

1. Lee la versión instalada (~/.local/share/agent-notch/VERSION). Si no es una
   release (vN), por ejemplo «main» o «local (...)», no hace nada.
2. Pregunta a GitHub cuál es la última release: UNA petición, sin la API
   (que limita peticiones): /releases/latest redirige a /releases/tag/vN.
3. Si hay una más nueva y no se pospuso, muestra una notificación:
       agent-notch v2 disponible · Tienes la v1      [Más tarde] [Actualizar]
   Clic en la notificación (o en el banner de la isla) = Actualizar.
4. Actualizar: descarga scripts/install.sh de esa versión y lo ejecuta; al
   terminar avisa de que hay que volver a entrar en la sesión.

Espera la respuesta como mucho WAIT_S; después cierra la notificación y sale
(la de mañana volverá a avisar). «Más tarde» o descartarla: no vuelve a
avisar de esa versión en SNOOZE_DAYS días.

Desactivar: systemctl --user disable --now agent-notch-update.timer

Para pruebas (no las usa el temporizador):
    AGENT_NOTCH_UPDATE_LATEST=v9         fingir la última release
    AGENT_NOTCH_UPDATE_INSTALLER=/ruta   instalador local en vez de descargarlo
    AGENT_NOTCH_UPDATE_WAIT=30           segundos de espera
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

REPO = "danieltrejoespino/gnome-agent-notch"
APP = "agent-notch"
WAIT_S = int(os.environ.get("AGENT_NOTCH_UPDATE_WAIT", 4 * 3600))
SNOOZE_DAYS = 3
HTTP_TIMEOUT_S = 15
USER_AGENT = "agent-notch-update-check"
ICON = "software-update-available-symbolic"

DATA = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
STATE_HOME = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
VERSION_FILE = os.path.join(DATA, APP, "VERSION")
STATE_FILE = os.path.join(STATE_HOME, APP, "update.json")
LOG_FILE = os.path.join(STATE_HOME, APP, "update.log")

_TAG = re.compile(r"^v(\d+(?:\.\d+)*)$")


def log(msg):
    print("[agent-notch] update: %s" % msg, file=sys.stderr, flush=True)


def version_key(tag):
    """'v2' → (2,), 'v1.10' → (1, 10); None si no es una release."""
    m = _TAG.match(tag or "")
    return tuple(int(x) for x in m.group(1).split(".")) if m else None


def is_newer(latest, installed):
    a, b = version_key(latest), version_key(installed)
    return a is not None and b is not None and a > b


def installed_version():
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None   # no seguirla: basta con la cabecera Location


def latest_release():
    """Etiqueta de la última release, sin descargar ninguna página: GitHub
    responde a /releases/latest con una redirección a /releases/tag/<etiqueta>."""
    fake = os.environ.get("AGENT_NOTCH_UPDATE_LATEST")
    if fake:
        return fake
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request("https://github.com/%s/releases/latest" % REPO,
                                 method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT_S):
            return None   # sin redirección: el repo no tiene releases
    except urllib.error.HTTPError as e:
        location = e.headers.get("Location", "") if e.code in (301, 302, 303, 307, 308) else ""
    m = re.search(r"/releases/tag/([^/?#]+)$", location)
    return m.group(1) if m else None


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(data):
    os.makedirs(os.path.dirname(STATE_FILE), mode=0o700, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, STATE_FILE)


def snoozed(version, now):
    st = load_state()
    return st.get("version") == version and now < st.get("snooze_until", 0)


def snooze(version):
    save_state({"version": version, "snooze_until": time.time() + SNOOZE_DAYS * 86400})


# --- Notificaciones (org.freedesktop.Notifications) -------------------------

class Notifier:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.loop = GLib.MainLoop()
        self.answer = None
        self.nid = 0
        self.bus.signal_subscribe(
            "org.freedesktop.Notifications", "org.freedesktop.Notifications", None,
            "/org/freedesktop/Notifications", None, Gio.DBusSignalFlags.NONE, self._on_signal)

    def notify(self, title, body, actions=(), urgency=1, replaces=0):
        hints = {"urgency": GLib.Variant("y", urgency),
                 "desktop-entry": GLib.Variant("s", "org.gnome.Extensions")}
        flat = [x for pair in actions for x in pair]
        reply = self.bus.call_sync(
            "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications", "Notify",
            GLib.Variant("(susssasa{sv}i)", ("agent-notch", replaces, ICON, title, body, flat, hints, 0)),
            GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None)
        self.nid = reply.unpack()[0]
        return self.nid

    def close(self):
        if not self.nid:
            return
        try:
            self.bus.call_sync(
                "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications", "CloseNotification",
                GLib.Variant("(u)", (self.nid,)), None, Gio.DBusCallFlags.NONE, -1, None)
        except GLib.Error:
            pass

    def wait(self, seconds):
        """Espera a que se pulse una acción o se cierre; None si se agota el tiempo."""
        GLib.timeout_add_seconds(seconds, self._timeout)
        self.loop.run()
        return self.answer

    def _timeout(self):
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    def _on_signal(self, _conn, _sender, _path, _iface, signal, params):
        args = params.unpack()
        if args[0] != self.nid:
            return
        # Al pulsar, GNOME manda antes ActivationToken: hay que ignorarla.
        if signal == "ActionInvoked":
            self.answer = args[1]
        elif signal == "NotificationClosed":
            if self.answer is None:
                # 2 = descartada por el usuario; 1 (caducó) o 3 (la cerramos) no cuentan.
                self.answer = "later" if args[1] == 2 else "closed"
        else:
            return
        self.loop.quit()


# --- Actualizar --------------------------------------------------------------

def run_installer(version):
    """Ejecuta el install.sh de esa versión. Devuelve (ok, mensaje)."""
    local = os.environ.get("AGENT_NOTCH_UPDATE_INSTALLER")
    env = dict(os.environ, AGENT_NOTCH_REF=version)
    os.makedirs(os.path.dirname(LOG_FILE), mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        script = local
        if not script:
            url = "https://raw.githubusercontent.com/%s/%s/scripts/install.sh" % (REPO, version)
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            script = os.path.join(tmp, "install.sh")
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as resp, open(script, "wb") as f:
                f.write(resp.read())
        with open(LOG_FILE, "w", encoding="utf-8") as logf:
            # cwd neutro: un install.sh descargado no debe ver el repo local.
            p = subprocess.run(["bash", script], env=env, cwd=tmp,
                               stdout=logf, stderr=subprocess.STDOUT, timeout=600)
    return p.returncode == 0, LOG_FILE


def logout_dialog():
    """Muestra el diálogo de cerrar sesión de GNOME (no cierra sin confirmar)."""
    try:
        Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
            "org.gnome.SessionManager", "/org/gnome/SessionManager",
            "org.gnome.SessionManager", "Logout", GLib.Variant("(u)", (0,)),
            None, Gio.DBusCallFlags.NONE, -1, None)
    except GLib.Error as e:
        log("no se pudo abrir el diálogo de cerrar sesión: %s" % e.message)


def main():
    installed = installed_version()
    if version_key(installed) is None:
        log("versión instalada %r no es una release: no se comprueba" % installed)
        return 0
    try:
        latest = latest_release()
    except OSError as e:
        log("no se pudo consultar GitHub: %s" % e)
        return 0
    if not is_newer(latest, installed):
        log("al día (%s; última %s)" % (installed, latest))
        return 0
    if snoozed(latest, time.time()):
        log("%s pospuesta" % latest)
        return 0

    n = Notifier()
    n.notify("agent-notch %s disponible" % latest,
             "Tienes la %s. Haz clic para actualizar." % installed,
             actions=[("default", "Actualizar"), ("later", "Más tarde"), ("update", "Actualizar")])
    answer = n.wait(WAIT_S)
    log("respuesta: %s" % answer)

    if answer in ("default", "update"):
        n.notify("Actualizando agent-notch…", "Descargando la %s" % latest, replaces=n.nid)
        try:
            ok, logfile = run_installer(latest)
        except (OSError, subprocess.SubprocessError) as e:
            ok, logfile = False, str(e)
        if ok:
            n.notify("agent-notch %s instalada" % latest,
                     "Cierra sesión y vuelve a entrar para aplicarla.",
                     actions=[("logout", "Cerrar sesión")], urgency=2, replaces=n.nid)
            if n.wait(min(WAIT_S, 3600)) == "logout":
                logout_dialog()
            else:
                # Sin respuesta: el mismo aviso, sin un botón que ya nadie escucha.
                n.notify("agent-notch %s instalada" % latest,
                         "Cierra sesión y vuelve a entrar para aplicarla.", replaces=n.nid)
        else:
            n.notify("No se pudo actualizar agent-notch",
                     "Detalles en %s" % logfile, urgency=2, replaces=n.nid)
        return 0 if ok else 1

    if answer == "later":
        snooze(latest)
    else:
        n.close()   # sin respuesta: que no quede un botón que ya no escucha nadie
    return 0


if __name__ == "__main__":
    sys.exit(main())
