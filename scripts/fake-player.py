#!/usr/bin/env python3
"""Fake music player (MPRIS) to try the island.

It announces itself as a player on the test GNOME's D-Bus (the one
scripts/dev-shell.sh opens), without playing any audio. It answers Play/Pause/Next/
Previous/SetPosition/Seek and Shuffle/LoopStatus like a real player.

Usage:
    scripts/fake-player.py           # fixed song, controllable from the island
    scripts/fake-player.py --auto 5  # also changes song every 5 s
    scripts/fake-player.py --name b  # a second player at the same time (another D-Bus name)
    Ctrl+C to close it (the island must go back to minimal).

Commands while it runs (type and Enter):  p = play/pause · n = next · b = previous
"""

import argparse
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

BUS_FILE = os.environ.get(
    "AGENT_NOTCH_BUS_FILE",
    os.path.join(GLib.get_user_runtime_dir(), "agent-notch-dev-bus"))
BUS_NAME = "org.mpris.MediaPlayer2.agentnotchfake"
OBJECT_PATH = "/org/mpris/MediaPlayer2"

# (title, artists, cover color or None = no cover, length in s or 0 = unknown)
TRACKS = [
    ("Test song", ["Artist One"], ("#7c3aed", "#ec4899"), 180),
    ("A rather long title to check that the island cuts it with an ellipsis",
     ["Artist Two", "Guest"], ("#f59e0b", "#ef4444"), 245),
    ("Track 3 (no cover, no length)", ["Another Artist"], None, 0),
]

COVER_DIR = os.path.join(GLib.get_user_runtime_dir(), "agent-notch-fake-covers")

COVER_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/>
  </linearGradient></defs>
  <rect width="256" height="256" fill="url(#g)"/>
  <circle cx="128" cy="128" r="56" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="10"/>
</svg>
"""


def write_covers(name=""):
    """Generates an SVG cover per track (in RAM, in $XDG_RUNTIME_DIR)."""
    os.makedirs(COVER_DIR, exist_ok=True)
    urls = []
    for i, (_t, _a, colors, _len) in enumerate(TRACKS):
        if not colors:
            urls.append("")
            continue
        path = os.path.join(COVER_DIR, f"cover{name}-{i}.svg")
        with open(path, "w") as f:
            f.write(COVER_SVG.format(a=colors[0], b=colors[1]))
        urls.append(GLib.filename_to_uri(path, None))
    return urls


def remove_covers(name=""):
    """Removes this player's covers (and the folder if it ends up empty)."""
    if not os.path.isdir(COVER_DIR):
        return
    for f in os.listdir(COVER_DIR):
        if f.startswith(f"cover{name}-"):
            os.remove(os.path.join(COVER_DIR, f))
    if not os.listdir(COVER_DIR):
        os.rmdir(COVER_DIR)

INTROSPECTION = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Play"/>
    <method name="SetPosition">
      <arg direction="in" name="TrackId" type="o"/>
      <arg direction="in" name="Position" type="x"/>
    </method>
    <method name="Seek">
      <arg direction="in" name="Offset" type="x"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
  </interface>
</node>
"""


class FakePlayer:
    def __init__(self, conn, loop, cover_urls, name=""):
        self.name = name
        self.conn = conn
        self.cover_urls = cover_urls
        self.loop = loop
        self.index = 0
        self.status = "Playing"
        self.shuffle = False
        self.loop_status = "None"
        # Simulated position: accumulated + time since it started playing.
        self.position_us = 0
        self.playing_since = GLib.get_monotonic_time()
        self.node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        register = getattr(conn, "register_object_with_closures2", conn.register_object)
        for iface in self.node.interfaces:
            register(OBJECT_PATH, iface, self._on_call, self._on_get, self._on_set)

    # --- state -----------------------------------------------------------
    def metadata(self):
        title, artists, _colors, length = TRACKS[self.index]
        data = {
            "mpris:trackid": GLib.Variant("o", f"/agentnotch/track/{self.index}"),
            "xesam:title": GLib.Variant("s", f"{title} [{self.name}]" if self.name else title),
            "xesam:artist": GLib.Variant("as", artists),
        }
        if length:
            data["mpris:length"] = GLib.Variant("x", length * 1_000_000)
        if self.cover_urls[self.index]:
            data["mpris:artUrl"] = GLib.Variant("s", self.cover_urls[self.index])
        return GLib.Variant("a{sv}", data)

    def props(self, iface):
        if iface == "org.mpris.MediaPlayer2":
            return {
                "CanQuit": GLib.Variant("b", True),
                "CanRaise": GLib.Variant("b", False),
                "HasTrackList": GLib.Variant("b", False),
                "Identity": GLib.Variant("s", f"Fake player {self.name}".strip()),
                "SupportedUriSchemes": GLib.Variant("as", []),
                "SupportedMimeTypes": GLib.Variant("as", []),
            }
        return {
            "PlaybackStatus": GLib.Variant("s", self.status),
            "Metadata": self.metadata(),
            "CanGoNext": GLib.Variant("b", True),
            "CanGoPrevious": GLib.Variant("b", True),
            "CanPlay": GLib.Variant("b", True),
            "CanPause": GLib.Variant("b", True),
            "CanControl": GLib.Variant("b", True),
            "Position": GLib.Variant("x", self.position()),
            "Shuffle": GLib.Variant("b", self.shuffle),
            "LoopStatus": GLib.Variant("s", self.loop_status),
        }

    def position(self):
        pos = self.position_us
        if self.status == "Playing":
            pos += GLib.get_monotonic_time() - self.playing_since
        length = TRACKS[self.index][3] * 1_000_000
        return min(pos, length) if length else pos

    def notify(self, *names):
        iface = "org.mpris.MediaPlayer2.Player"
        all_props = self.props(iface)
        changed = {n: all_props[n] for n in names}
        self.conn.emit_signal(
            None, OBJECT_PATH, "org.freedesktop.DBus.Properties", "PropertiesChanged",
            GLib.Variant("(sa{sv}as)", (iface, changed, [])))
        title, artists, _colors, _len = TRACKS[self.index]
        print(f"  [{self.status}] {title} — {', '.join(artists)}", flush=True)

    # --- actions ---------------------------------------------------------
    def next(self, step=1):
        self.index = (self.index + step) % len(TRACKS)
        self.position_us = 0
        self.playing_since = GLib.get_monotonic_time()
        self.notify("Metadata")

    def set_status(self, status):
        self.position_us = self.position()       # freeze what it had
        self.playing_since = GLib.get_monotonic_time()
        if status == "Stopped":
            self.position_us = 0
        self.status = status
        self.notify("PlaybackStatus")

    def play_pause(self):
        self.set_status("Paused" if self.status == "Playing" else "Playing")

    def set_position(self, position_us):
        length = TRACKS[self.index][3] * 1_000_000
        if not length or not 0 <= position_us <= length:
            return
        self.position_us = position_us
        self.playing_since = GLib.get_monotonic_time()
        print(f"  [position] {position_us // 1_000_000} s", flush=True)

    # --- D-Bus ------------------------------------------------------------
    def _on_get(self, _conn, _sender, _path, iface, prop):
        return self.props(iface).get(prop)

    def _on_set(self, _conn, _sender, _path, _iface, prop, value):
        if prop == "Shuffle":
            self.shuffle = value.unpack()
        elif prop == "LoopStatus" and value.unpack() in ("None", "Track", "Playlist"):
            self.loop_status = value.unpack()
        else:
            return False
        print(f"  [{prop}] {value.unpack()}", flush=True)
        self.notify(prop)
        return True

    def _on_call(self, _conn, _sender, _path, _iface, method, params, invocation):
        if method == "SetPosition":
            track_id, position = params.unpack()
            if track_id == f"/agentnotch/track/{self.index}":
                self.set_position(position)
            invocation.return_value(None)
            return
        if method == "Seek":
            self.set_position(self.position() + params.unpack()[0])
            invocation.return_value(None)
            return
        actions = {
            "Next": self.next,
            "Previous": lambda: self.next(-1),
            "PlayPause": self.play_pause,
            "Play": lambda: self.set_status("Playing"),
            "Pause": lambda: self.set_status("Paused"),
            "Stop": lambda: self.set_status("Stopped"),
            "Quit": self.loop.quit,
            "Raise": lambda: None,
        }
        actions.get(method, lambda: None)()
        invocation.return_value(None)


def connect():
    """Connects to the test GNOME's D-Bus, never to your real desktop's."""
    try:
        with open(BUS_FILE) as f:
            address = f.read().strip()
    except FileNotFoundError:
        sys.exit("Cannot find the test GNOME. Open it first with scripts/dev-shell.sh")
    flags = (Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
             | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION)
    try:
        return Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
    except GLib.Error as e:
        sys.exit(f"Could not connect to the test GNOME ({e.message}). Is it still open?")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--auto", type=int, metavar="SEC",
                        help="change song every SEC seconds")
    parser.add_argument("--name", default="", metavar="NAME",
                        help="start another player at the same time with this name")
    args = parser.parse_args()

    loop = GLib.MainLoop()
    conn = connect()
    player = FakePlayer(conn, loop, write_covers(args.name), args.name)

    bus_name = f"{BUS_NAME}{args.name}" if args.name else BUS_NAME
    Gio.bus_own_name_on_connection(conn, bus_name, Gio.BusNameOwnerFlags.NONE, None, None)
    print("Fake player running in the test GNOME. p=play/pause, n=next, b=previous, Ctrl+C=quit")
    title, artists, _colors, _len = TRACKS[0]
    print(f"  [Playing] {title} — {', '.join(artists)}", flush=True)

    if args.auto:
        GLib.timeout_add_seconds(args.auto, lambda: (player.next(), True)[1])

    def on_stdin(_fd, _cond):
        line = sys.stdin.readline()
        if not line:
            return False
        {"p": player.play_pause, "n": player.next, "b": lambda: player.next(-1)}.get(
            line.strip().lower(), lambda: None)()
        return True

    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN, on_stdin)

    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        remove_covers(args.name)


if __name__ == "__main__":
    main()
