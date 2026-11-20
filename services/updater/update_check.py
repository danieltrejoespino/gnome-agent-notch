#!/usr/bin/env python3
"""agent-notch new-version notice.

Run by a user systemd timer once a day (agent-notch-update.timer, installed
by scripts/install.sh). Outside GNOME Shell: the extension does not launch
processes (Rule 2 of CLAUDE.md).

1. Reads the installed version (~/.local/share/agent-notch/VERSION). If it is
   not a release (vN), for example "main" or "local (...)", it does nothing.
2. Asks GitHub which one is the latest release: ONE request, without the API
   (which rate-limits): /releases/latest redirects to /releases/tag/vN.
3. If there is a newer one and it was not postponed, it shows a notification:
       agent-notch v2 available · You have v1      [Later] [Update]
   Click on the notification (or on the island's banner) = Update.
4. Update: downloads that version's scripts/install.sh and runs it; when
   done it says you need to log back in.

It waits for an answer at most WAIT_S; then it closes the notification and
exits (tomorrow's run will notify again). "Later" or dismissing it: it does
not notify about that version again for SNOOZE_DAYS days.

Also (docs/18, the island's "Update" button): it writes the available
version to update.json ({"disponible", "instalada", "estado", "registro"}),
which the extension watches to show its button, and it serves the Instalar()
method of the D-Bus name dev.agentnotch.Updater:
  - while it waits for an answer to its notification, this process owns it;
  - otherwise, D-Bus starts "update_check.py --servicio", which installs and
    exits (or exits after SERVICE_IDLE_S seconds if nobody calls).
That way there are never two installs at once.

Disable: systemctl --user disable --now agent-notch-update.timer

For tests (the timer does not use them):
    AGENT_NOTCH_UPDATE_LATEST=v9         fake the latest release
    AGENT_NOTCH_UPDATE_INSTALLER=/path   local installer instead of downloading it
    AGENT_NOTCH_UPDATE_WAIT=30           seconds to wait
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
SERVICE_IDLE_S = 30

BUS_NAME = "dev.agentnotch.Updater"
OBJECT_PATH = "/dev/agentnotch/Updater"
INTERFACE_XML = """
<node>
  <interface name="dev.agentnotch.Updater">
    <method name="Instalar"/>
  </interface>
</node>
"""
OFFER_KEYS = ("disponible", "instalada", "estado", "registro")

DATA = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
STATE_HOME = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
VERSION_FILE = os.path.join(DATA, APP, "VERSION")
STATE_FILE = os.path.join(STATE_HOME, APP, "update.json")
LOG_FILE = os.path.join(STATE_HOME, APP, "update.log")
# aviso-actualizaciones setting of the preferences window (docs/20): the
# schema is compiled inside the extension's folder.
EXT_SCHEMAS = os.path.join(DATA, "gnome-shell", "extensions", "agent-notch@daniel.local", "schemas")
SCHEMA_ID = "org.gnome.shell.extensions.agent-notch"

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


def updates_enabled():
    """Is the update notice on? Without a schema (old versions,
    development copies not compiled), yes."""
    try:
        source = Gio.SettingsSchemaSource.new_from_directory(
            EXT_SCHEMAS, Gio.SettingsSchemaSource.get_default(), False)
        schema = source.lookup(SCHEMA_ID, False)
        if schema is None:
            return True
        return Gio.Settings.new_full(schema, None, None).get_boolean("aviso-actualizaciones")
    except GLib.Error:
        return True


def installed_version():
    try:
        with open(VERSION_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None   # do not follow it: the Location header is enough


def latest_release():
    """Tag of the latest release, without downloading any page: GitHub
    answers /releases/latest with a redirect to /releases/tag/<tag>."""
    fake = os.environ.get("AGENT_NOTCH_UPDATE_LATEST")
    if fake:
        return fake
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request("https://github.com/%s/releases/latest" % REPO,
                                 method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT_S):
            return None   # no redirect: the repo has no releases
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
    st = load_state()
    st.update(version=version, snooze_until=time.time() + SNOOZE_DAYS * 86400)
    save_state(st)


def set_offer(**fields):
    """What the island's button reads (docs/18); keeps the "Later" fields."""
    st = load_state()
    st.update(fields)
    save_state(st)


def clear_offer():
    st = load_state()
    if any(k in st for k in OFFER_KEYS):
        save_state({k: v for k, v in st.items() if k not in OFFER_KEYS})


# --- D-Bus: dev.agentnotch.Updater.Instalar() --------------------------------

def own_updater(conn, on_install):
    """Requests the name and serves Instalar() by calling on_install() from the
    main loop, after replying. Returns False if someone else owns it."""
    def on_call(_conn, _sender, _path, _iface, method, _params, invocation):
        if method != "Instalar":
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        invocation.return_value(None)
        GLib.idle_add(lambda: on_install() and False)

    info = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0]
    conn.register_object_with_closures2(OBJECT_PATH, info, on_call, None, None)
    reply = conn.call_sync(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
        GLib.Variant("(su)", (BUS_NAME, 4)),   # 4 = DO_NOT_QUEUE
        GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None)
    return reply.unpack()[0] in (1, 4)   # 1 = owner, 4 = already was


# --- Notifications (org.freedesktop.Notifications) -------------------------

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
        """Waits until an action is pressed or it is closed; None if time runs out."""
        self.answer = None
        self._timed_out = False
        source = GLib.timeout_add_seconds(seconds, self._timeout)
        self.loop.run()
        if not self._timed_out:
            GLib.source_remove(source)   # so it does not cut the next wait short
        return self.answer

    def answer_with(self, answer):
        """An answer that does not come from the notification (e.g. the island's button)."""
        if self.answer is None:
            self.answer = answer
        self.loop.quit()

    def _timeout(self):
        self._timed_out = True
        self.loop.quit()
        return GLib.SOURCE_REMOVE

    def _on_signal(self, _conn, _sender, _path, _iface, signal, params):
        args = params.unpack()
        if args[0] != self.nid:
            return
        # On click, GNOME sends ActivationToken first: it must be ignored.
        if signal == "ActionInvoked":
            self.answer = args[1]
        elif signal == "NotificationClosed":
            if self.answer is None:
                # 2 = dismissed by the user; 1 (expired) or 3 (we closed it) do not count.
                self.answer = "later" if args[1] == 2 else "closed"
        else:
            return
        self.loop.quit()


# --- Updating ----------------------------------------------------------------

def run_installer(version):
    """Runs that version's install.sh. Returns (ok, message)."""
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
            # neutral cwd: a downloaded install.sh must not see the local repo.
            p = subprocess.run(["bash", script], env=env, cwd=tmp,
                               stdout=logf, stderr=subprocess.STDOUT, timeout=600)
    return p.returncode == 0, LOG_FILE


def logout_dialog():
    """Shows GNOME's log out dialog (it does not log out without confirming)."""
    try:
        Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
            "org.gnome.SessionManager", "/org/gnome/SessionManager",
            "org.gnome.SessionManager", "Logout", GLib.Variant("(u)", (0,)),
            None, Gio.DBusCallFlags.NONE, -1, None)
    except GLib.Error as e:
        log("could not open the log out dialog: %s" % e.message)


def install(version, n=None):
    """Installs that version, leaving the progress in update.json (and in the
    notification, if there is one). Returns True if it went well."""
    set_offer(disponible=version, instalada=installed_version(), estado="instalando", registro=None)
    if n:
        n.notify("Updating agent-notch…", "Downloading %s" % version, replaces=n.nid)
    try:
        ok, logfile = run_installer(version)
    except (OSError, subprocess.SubprocessError) as e:
        ok, logfile = False, str(e)
    set_offer(estado="instalada" if ok else "error", registro=logfile)
    log("install of %s: %s" % (version, "ok" if ok else "failed"))
    return ok


def serve():
    """--servicio mode: D-Bus starts it when the island calls Instalar() and
    the daily checker is not waiting. It installs and exits."""
    loop = GLib.MainLoop()
    state = {"busy": False}

    def on_install():
        if state["busy"]:
            return
        state["busy"] = True
        version = load_state().get("disponible")
        installed = installed_version()
        if not is_newer(version, installed):
            log("nothing to install (%r; installed %r)" % (version, installed))
        else:
            install(version)
        loop.quit()

    def idle_exit():
        if not state["busy"]:
            loop.quit()
        return GLib.SOURCE_REMOVE

    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    if not own_updater(conn, on_install):
        log("another process serves %s" % BUS_NAME)
        return 0
    GLib.timeout_add_seconds(SERVICE_IDLE_S, idle_exit)
    loop.run()
    return 0


def main():
    if "--servicio" in sys.argv[1:]:
        return serve()
    if not updates_enabled():
        log("update notice turned off in the preferences")
        clear_offer()
        return 0

    installed = installed_version()
    if version_key(installed) is None:
        log("installed version %r is not a release: not checking" % installed)
        return 0
    try:
        latest = latest_release()
    except OSError as e:
        log("could not check GitHub: %s" % e)
        return 0
    if not is_newer(latest, installed):
        log("up to date (%s; latest %s)" % (installed, latest))
        clear_offer()
        return 0
    # The island's button shows even if the notification is postponed.
    set_offer(disponible=latest, instalada=installed, estado="disponible", registro=None)
    if snoozed(latest, time.time()):
        log("%s postponed" % latest)
        return 0

    n = Notifier()
    # While it waits, the island's button reaches this process (not another one).
    own_updater(n.bus, lambda: n.answer_with("update"))
    n.notify("agent-notch %s available" % latest,
             "You have %s. Click to update." % installed,
             actions=[("default", "Update"), ("later", "Later"), ("update", "Update")])
    answer = n.wait(WAIT_S)
    log("answer: %s" % answer)

    if answer in ("default", "update"):
        ok = install(latest, n)
        logfile = load_state().get("registro") or LOG_FILE
        if ok:
            n.notify("agent-notch %s installed" % latest,
                     "Log out and back in to apply it.",
                     actions=[("logout", "Log out")], urgency=2, replaces=n.nid)
            if n.wait(min(WAIT_S, 3600)) == "logout":
                logout_dialog()
            else:
                # No answer: the same notice, without a button nobody listens to anymore.
                n.notify("agent-notch %s installed" % latest,
                         "Log out and back in to apply it.", replaces=n.nid)
        else:
            n.notify("Could not update agent-notch",
                     "Details in %s" % logfile, urgency=2, replaces=n.nid)
        return 0 if ok else 1

    if answer == "later":
        snooze(latest)
    else:
        n.close()   # no answer: do not leave a button nobody listens to anymore
    return 0


if __name__ == "__main__":
    sys.exit(main())
